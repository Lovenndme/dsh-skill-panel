/**
 * 路由层测试：鉴权、方法、体积上限、错误码、并发写、/list 响应契约。
 * 这些是「面板能用」与「面板安全」的边界——任何一条坏掉都不会有编译错误，只会离线失效。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { apply } from '../index.js'

const API = '/api/dsh-skill-panel'

/* --------------------------------------------------------------- 测试夹具 */

async function tmp(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `dsp-routes-${label}-`))
}

function makeRes() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk))
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8')
    },
    get json() {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    },
  }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(body)
    },
  }
}

/**
 * @param {object} options
 * @param {Array} options.workspaces   工作区注册表返回
 * @param {object} options.connection  提供 connection 服务（模拟 DSH 真实环境）
 * @param {object} options.skills      DSH 技能注册表
 */
function makeCtx({ workspaces = [], connection, skills, presets } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(factory) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'connection') return connection
      if (name === 'skills') return skills
      if (name === 'agentPresets') return presets
      return undefined
    },
    logger: { info() {} },
  }
  return { ctx, routes }
}

function doc(name, description, extra = {}) {
  const lines = ['---', `name: ${name}`, `description: '${description}'`]
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${value}`)
  lines.push('---', '', '正文', '')
  return lines.join('\n')
}

async function writeSkill(root, name, options = {}) {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), doc(name, options.description || `${name} 说明`, options.extra || {}, options.body))
  return dir
}

/** 建一套「home + 带 .git 的项目」并返回常用引用。 */
async function scaffold(label) {
  const home = await tmp(`${label}-home`)
  const project = await tmp(`${label}-project`)
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(home, 'skills'), 'global-one', { description: '全局技能' })
  await writeSkill(path.join(project, '.dsh', 'skills'), 'project-one', { description: '项目技能' })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    project,
    query: `?project=${encodeURIComponent(project)}`,
    restore() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

async function call(routes, pathname, request) {
  const res = makeRes()
  await routes.get(pathname)(makeReq(request), res)
  return res
}

const LOOPBACK = { host: '127.0.0.1:1234', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:1234' }

/* ============================================================== 鉴权 / 安全 */

test('有 Connection 服务时，未登录请求一律 401，且不执行任何副作用', async () => {
  const env = await scaffold('auth')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project, title: 'demo' }], connection: { requestRejection: () => 401 } })
    apply(ctx)
    const before = await fsp.readdir(path.join(env.home, 'skills'))
    for (const [pathname, request] of [
      [`${API}/list`, { url: `${API}/list${env.query}` }],
      [`${API}/create`, { method: 'POST', url: `${API}/create${env.query}`, body: JSON.stringify({ name: 'sneaky', description: 'x' }) }],
      [`${API}/delete`, { method: 'POST', url: `${API}/delete${env.query}`, body: JSON.stringify({ name: 'global-one', source: 'user-dsh' }) }],
    ]) {
      const res = await call(routes, pathname, { ...request, headers: LOOPBACK })
      assert.equal(res.statusCode, 401, `${pathname} 必须要求登录`)
      assert.equal(res.json.ok, false)
    }
    assert.deepEqual(await fsp.readdir(path.join(env.home, 'skills')), before, '被拒的请求不能改磁盘')
  } finally {
    env.restore()
  }
})

test('Connection 返回 403 时原样透出 403', async () => {
  const env = await scaffold('auth403')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => 403 } })
    apply(ctx)
    const res = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
    assert.equal(res.statusCode, 403)
  } finally {
    env.restore()
  }
})

test('没有 Connection 服务时退回 loopback 判定，跨站与非本机来源被拒', async () => {
  const env = await scaffold('fallback')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }] })
    apply(ctx)
    const cases = [
      { headers: { 'sec-fetch-site': 'cross-site' }, expect: 403 },
      { headers: { origin: 'https://evil.example' }, expect: 403 },
      { headers: { origin: 'http://127.0.0.1:1234', host: '127.0.0.1:9999' }, expect: 403 },
      { headers: { origin: 'not a url' }, expect: 403 },
      { headers: { origin: 'http://localhost:1234', host: 'localhost:1234' }, expect: 200 },
      { headers: {}, expect: 200 },
    ]
    for (const { headers, expect } of cases) {
      const res = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers })
      assert.equal(res.statusCode, expect, `headers=${JSON.stringify(headers)}`)
    }
  } finally {
    env.restore()
  }
})

/* ================================================================== 方法 */

test('每条路由都拒绝错误的方法（405）', async () => {
  const env = await scaffold('methods')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const gets = ['list', 'doc']
    const posts = ['save', 'flags', 'scope', 'create', 'delete', 'import-folder', 'import-zip']
    for (const name of gets) {
      const res = await call(routes, `${API}/${name}`, { method: 'POST', url: `${API}/${name}${env.query}`, headers: LOOPBACK, body: '{}' })
      assert.equal(res.statusCode, 405, `${name} 应只接受 GET`)
    }
    for (const name of posts) {
      const res = await call(routes, `${API}/${name}`, { method: 'GET', url: `${API}/${name}${env.query}`, headers: LOOPBACK })
      assert.equal(res.statusCode, 405, `${name} 应只接受 POST`)
    }
    // HEAD 在只读路由上必须可用（浏览器/代理会发）
    for (const name of gets) {
      const res = await call(routes, `${API}/${name}`, { method: 'HEAD', url: `${API}/${name}${env.query}`, headers: LOOPBACK })
      assert.ok([200, 400].includes(res.statusCode), `${name} HEAD 返回 ${res.statusCode}`)
    }
  } finally {
    env.restore()
  }
})

/* ================================================================== 输入 */

test('坏 JSON、超大请求体、非法技能名都返回 400 且带中文原因', async () => {
  const env = await scaffold('input')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)

    const badJson = await call(routes, `${API}/create`, { method: 'POST', url: `${API}/create${env.query}`, headers: LOOPBACK, body: '{not json' })
    assert.equal(badJson.statusCode, 400)

    const tooBig = await call(routes, `${API}/save`, {
      method: 'POST',
      url: `${API}/save${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'global-one', source: 'user-dsh', content: 'x'.repeat(2 * 1024 * 1024 + 16) }),
    })
    assert.equal(tooBig.statusCode, 400)
    assert.match(tooBig.json.errors.join('；'), /超过大小上限/)

    for (const name of ['Bad Name', '../escape', 'A', '']) {
      const res = await call(routes, `${API}/create`, {
        method: 'POST',
        url: `${API}/create${env.query}`,
        headers: LOOPBACK,
        body: JSON.stringify({ name, description: 'x' }),
      })
      assert.equal(res.statusCode, 400, `非法名字 ${JSON.stringify(name)} 应被拒`)
    }

    const badSource = await call(routes, `${API}/doc`, { url: `${API}/doc${env.query}&name=global-one&source=..%2F..`, headers: LOOPBACK })
    assert.equal(badSource.statusCode, 400)
    assert.match(badSource.json.errors.join('；'), /未知的技能来源/)
  } finally {
    env.restore()
  }
})

test('/doc 拒绝读取技能根之外的内容', async () => {
  const env = await scaffold('doc-guard')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    // 名字合法但不存在
    const missing = await call(routes, `${API}/doc`, { url: `${API}/doc${env.query}&name=nope-skill&source=user-dsh`, headers: LOOPBACK })
    assert.equal(missing.statusCode, 400)
    assert.match(missing.json.errors.join('；'), /找不到技能/)
    // 真实存在
    const ok = await call(routes, `${API}/doc`, { url: `${API}/doc${env.query}&name=global-one&source=user-dsh`, headers: LOOPBACK })
    assert.equal(ok.statusCode, 200)
    assert.match(ok.json.content, /global-one/)
  } finally {
    env.restore()
  }
})

test('/delete 只允许删技能根目录里的东西', async () => {
  const env = await scaffold('delete-guard')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const outside = await tmp('outside')
    await writeSkill(outside, 'far-away')
    const res = await call(routes, `${API}/delete`, {
      method: 'POST',
      url: `${API}/delete${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'far-away', source: 'user-dsh' }),
    })
    assert.equal(res.statusCode, 400)
    assert.ok(existsSync(path.join(outside, 'far-away', 'SKILL.md')), '技能根之外的目录不能被删')
  } finally {
    env.restore()
  }
})

/* ================================================================ 契约 */

test('/list 返回客户端依赖的完整字段', async () => {
  const env = await scaffold('contract')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project, title: 'demo' }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
    assert.equal(res.statusCode, 200)
    const body = res.json
    for (const key of ['ok', 'dshHome', 'agentsHome', 'projectCwd', 'projectRoot', 'workspaces', 'roots', 'dshChecked', 'dshProbe', 'skills', 'diagnostics']) {
      assert.ok(key in body, `/list 缺少字段 ${key}`)
    }
    assert.equal(body.projectRoot, path.resolve(env.project))
    assert.deepEqual(body.skills.map((skill) => skill.name).sort(), ['global-one', 'project-one'])
    for (const skill of body.skills) {
      for (const key of ['name', 'description', 'scope', 'source', 'rank', 'path', 'dir', 'kind', 'modelInvocable', 'userInvocable', 'stub', 'shadowed']) {
        assert.ok(key in skill, `技能项缺少字段 ${key}`)
      }
      assert.ok(['global', 'project'].includes(skill.scope))
      assert.equal(typeof skill.modelInvocable, 'boolean')
      assert.equal(typeof skill.userInvocable, 'boolean')
      assert.equal(Array.isArray(skill.shadowed), true)
    }
    assert.equal(body.dshChecked, false, '拿不到注册表时不做标注')
  } finally {
    env.restore()
  }
})

test('/list 在没有工作区、没有 project 参数时仍然可用', async () => {
  const home = await tmp('nows-home')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeSkill(path.join(home, 'skills'), 'only-global')
    const { ctx, routes } = makeCtx({ workspaces: [], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/list`, { url: `${API}/list`, headers: LOOPBACK })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json.ok, true)
    assert.deepEqual(res.json.workspaces, [])
    assert.deepEqual(res.json.skills.map((skill) => skill.name), ['only-global'])
    assert.ok(!('projectRoot' in res.json) || res.json.projectRoot === undefined || res.json.projectRoot === null)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('project 参数指向不存在的目录时安全回落到工作区', async () => {
  const env = await scaffold('badproject')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project, title: 'demo' }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/list`, { url: `${API}/list?project=${encodeURIComponent(path.join(os.tmpdir(), 'definitely-missing-xyz'))}`, headers: LOOPBACK })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json.projectRoot, path.resolve(env.project))
  } finally {
    env.restore()
  }
})

/* ================================================================ 写并发 */

test('并发 /flags 同一技能不会让文件损坏', async () => {
  const env = await scaffold('concurrent')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const jobs = []
    for (let index = 0; index < 10; index += 1) {
      jobs.push(
        call(routes, `${API}/flags`, {
          method: 'POST',
          url: `${API}/flags${env.query}`,
          headers: LOOPBACK,
          body: JSON.stringify({ name: 'global-one', source: 'user-dsh', model: index % 2 === 0, user: index % 3 !== 0 }),
        }),
      )
    }
    const results = await Promise.all(jobs)
    assert.ok(results.every((res) => res.statusCode === 200), results.map((res) => res.text).join('\n'))
    const text = await fsp.readFile(path.join(env.home, 'skills', 'global-one', 'SKILL.md'), 'utf8')
    assert.match(text, /^---\n/)
    assert.match(text, /name: global-one/)
    assert.match(text, /正文/)
    const listed = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
    const skill = listed.json.skills.find((item) => item.name === 'global-one')
    assert.equal(typeof skill.modelInvocable, 'boolean')
  } finally {
    env.restore()
  }
})

test('并发 /list 与写操作交错不会 500', async () => {
  const env = await scaffold('interleave')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const listJob = (async () => {
      for (let index = 0; index < 5; index += 1) {
        const res = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
        assert.equal(res.statusCode, 200)
      }
    })()
    const writeJob = (async () => {
      for (let index = 0; index < 5; index += 1) {
        const res = await call(routes, `${API}/flags`, {
          method: 'POST',
          url: `${API}/flags${env.query}`,
          headers: LOOPBACK,
          body: JSON.stringify({ name: 'global-one', source: 'user-dsh', model: index % 2 === 0 }),
        })
        assert.equal(res.statusCode, 200)
      }
    })()
    await Promise.all([listJob, writeJob])
  } finally {
    env.restore()
  }
})

/* ============================================================ zip 导入链路 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const payload = zlib.deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    locals.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

test('POST /import-zip 真的把技能写进项目目录', async () => {
  const env = await scaffold('zip')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const zip = buildZip([
      { name: 'zip-skill/SKILL.md', data: doc('zip-skill', '压缩包技能') },
      { name: 'zip-skill/references/notes.md', data: 'notes' },
    ])
    const res = await call(routes, `${API}/import-zip`, {
      method: 'POST',
      url: `${API}/import-zip${env.query}&scope=project&name=zip-skill`,
      headers: LOOPBACK,
      body: zip,
    })
    assert.equal(res.statusCode, 200, res.text)
    assert.equal(res.json.results[0].ok, true)
    const target = path.join(env.project, '.dsh', 'skills', 'zip-skill')
    assert.ok(existsSync(path.join(target, 'SKILL.md')))
    assert.ok(existsSync(path.join(target, 'references', 'notes.md')), '资源文件也要一起落盘')

    const listed = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
    const names = listed.json.skills.map((skill) => skill.name)
    assert.ok(names.includes('zip-skill'), JSON.stringify(names))
  } finally {
    env.restore()
  }
})

test('POST /import-zip 对坏包返回 400 且不落盘', async () => {
  const env = await scaffold('zip-bad')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/import-zip`, {
      method: 'POST',
      url: `${API}/import-zip${env.query}&scope=project`,
      headers: LOOPBACK,
      body: Buffer.from('definitely not a zip'),
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json.errors.join('；'), /不是有效的 zip/)
  } finally {
    env.restore()
  }
})

test('/create 在全局作用域写进 $DSH_HOME/skills', async () => {
  const env = await scaffold('create-global')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/create`, {
      method: 'POST',
      url: `${API}/create${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'global-new', description: '新建到全局', scope: 'global' }),
    })
    assert.equal(res.statusCode, 200, res.text)
    const file = path.join(env.home, 'skills', 'global-new', 'SKILL.md')
    assert.ok(existsSync(file), '必须写进全局技能目录')
    assert.match(await fsp.readFile(file, 'utf8'), /global-new/)
  } finally {
    env.restore()
  }
})

/* ============================================== 真实文件的格式保真（回归） */

test('/flags 不会破坏块标量、CRLF 与正文（真实文件回归）', async () => {
  const env = await scaffold('format')
  try {
    const tricky = [
      '---',
      'name: tricky-skill',
      "description: '说明'",
      'whenToUse: |',
      '  第一行',
      '  第二行',
      'version: 1.0.0',
      '---',
      '',
      '## 正文',
      '',
      '- 列表项',
      '',
    ].join('\r\n')
    const skillDir = path.join(env.home, 'skills', 'tricky-skill')
    await fsp.mkdir(skillDir, { recursive: true })
    const file = path.join(skillDir, 'SKILL.md')
    await fsp.writeFile(file, tricky, 'utf8')

    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    const res = await call(routes, `${API}/flags`, {
      method: 'POST',
      url: `${API}/flags${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'tricky-skill', source: 'user-dsh', model: false, user: false }),
    })
    assert.equal(res.statusCode, 200, res.text)

    const after = await fsp.readFile(file, 'utf8')
    assert.ok(after.includes('disable-model-invocation: true'))
    assert.ok(after.includes('user-invocable: false'))
    // 块标量整体保留，标记不能被塞进标量里
    assert.ok(after.includes('whenToUse: |\r\n  第一行\r\n  第二行\r\n'), JSON.stringify(after))
    // 新键插在 frontmatter 末尾（结束分隔符之前），但必须在块标量之后
    assert.ok(after.indexOf('disable-model-invocation') > after.indexOf('whenToUse: |'))
    assert.ok(after.indexOf('disable-model-invocation') < after.lastIndexOf('---'))
    // 正文逐字节保留
    for (const line of ['## 正文', '- 列表项']) assert.ok(after.includes(line), `正文丢了：${line}`)

    // 再列一次：文件仍然可被解析，且开关生效
    const listed = await call(routes, `${API}/list`, { url: `${API}/list${env.query}`, headers: LOOPBACK })
    const entry = listed.json.skills.find((skill) => skill.name === 'tricky-skill')
    assert.ok(entry, '改动后技能不能从列表里消失')
    assert.equal(entry.modelInvocable, false)
    assert.equal(entry.userInvocable, false)
  } finally {
    env.restore()
  }
})

test('/save 写回后再次读取内容一致（含中文与 emoji）', async () => {
  const env = await scaffold('roundtrip')
  try {
    const { ctx, routes } = makeCtx({ workspaces: [{ path: env.project }], connection: { requestRejection: () => undefined } })
    apply(ctx)
    // /save 只能改已存在的技能，先建一个
    const created = await call(routes, `${API}/create`, {
      method: 'POST',
      url: `${API}/create${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'roundtrip-skill', description: '占位', scope: 'global' }),
    })
    assert.equal(created.statusCode, 200, created.text)

    const content = ['---', 'name: roundtrip-skill', "description: '中文描述 🎯'", '---', '', '正文含 emoji 🚀 与符号 «»', ''].join('\n')
    const saved = await call(routes, `${API}/save`, {
      method: 'POST',
      url: `${API}/save${env.query}`,
      headers: LOOPBACK,
      body: JSON.stringify({ name: 'roundtrip-skill', source: 'user-dsh', content }),
    })
    assert.equal(saved.statusCode, 200, saved.text)
    const read = await call(routes, `${API}/doc`, { url: `${API}/doc${env.query}&name=roundtrip-skill&source=user-dsh`, headers: LOOPBACK })
    assert.equal(read.statusCode, 200)
    assert.equal(read.json.content, content, '写进去什么就要读回什么')
  } finally {
    env.restore()
  }
})


