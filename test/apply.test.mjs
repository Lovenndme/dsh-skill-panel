import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

async function makeTempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `dsp-apply-${label}-`))
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
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

function makeCtx(workspaces) {
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
      return undefined
    },
    logger: { info() {} },
  }
  return { ctx, routes }
}

function skillText(name, description) {
  return `---\nname: ${name}\ndescription: '${description}'\n---\n\n正文\n`
}

test('apply 注册全部路由且 /list 能列出两层技能', async () => {
  const home = await makeTempDir('home')
  const project = await makeTempDir('project')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'global-one'), { recursive: true })
  await fsp.writeFile(path.join(home, 'skills', 'global-one', 'SKILL.md'), skillText('global-one', '全局技能'))
  await fsp.mkdir(path.join(project, '.dsh', 'skills', 'project-one'), { recursive: true })
  await fsp.writeFile(path.join(project, '.dsh', 'skills', 'project-one', 'SKILL.md'), skillText('project-one', '项目技能'))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    apply(ctx)
    for (const suffix of ['list', 'doc', 'save', 'flags', 'scope', 'create', 'delete', 'import-folder', 'import-zip']) {
      assert.ok(routes.has(`/api/dsh-skill-panel/${suffix}`), `缺少路由 ${suffix}`)
    }
    const response = makeRes()
    await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: '/api/dsh-skill-panel/list' }), response)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.projectRoot, path.resolve(project))
    const names = response.json.skills.map((skill) => skill.name).sort()
    assert.deepEqual(names, ['global-one', 'project-one'])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('apply 的写路径：flags / create / save / delete 真的落盘', async () => {
  const home = await makeTempDir('home2')
  const project = await makeTempDir('project2')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'toggle-me'), { recursive: true })
  await fsp.writeFile(path.join(home, 'skills', 'toggle-me', 'SKILL.md'), skillText('toggle-me', '说明'))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    apply(ctx)
    const origin = { host: '127.0.0.1:1234', 'sec-fetch-site': 'same-origin' }
    const query = `?project=${encodeURIComponent(project)}`

    // create（项目层）
    const created = makeRes()
    await routes.get('/api/dsh-skill-panel/create')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/create${query}`, headers: origin, body: JSON.stringify({ name: 'fresh-skill', description: '新技能', scope: 'project' }) }),
      created,
    )
    assert.equal(created.statusCode, 200, created.text)
    assert.ok(existsSync(path.join(project, '.dsh', 'skills', 'fresh-skill', 'SKILL.md')))

    // flags（全局层关模型调用）
    const flagged = makeRes()
    await routes.get('/api/dsh-skill-panel/flags')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/flags${query}`, headers: origin, body: JSON.stringify({ name: 'toggle-me', source: 'user-dsh', model: false }) }),
      flagged,
    )
    assert.equal(flagged.statusCode, 200, flagged.text)
    const toggled = await fsp.readFile(path.join(home, 'skills', 'toggle-me', 'SKILL.md'), 'utf8')
    assert.match(toggled, /disable-model-invocation: true/)

    // save（改正文）
    const saved = makeRes()
    await routes.get('/api/dsh-skill-panel/save')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/save${query}`, headers: origin, body: JSON.stringify({ name: 'toggle-me', source: 'user-dsh', content: skillText('toggle-me', '改过的说明') }) }),
      saved,
    )
    assert.equal(saved.statusCode, 200, saved.text)
    const rewritten = await fsp.readFile(path.join(home, 'skills', 'toggle-me', 'SKILL.md'), 'utf8')
    assert.match(rewritten, /改过的说明/)

    // doc
    const doc = makeRes()
    await routes.get('/api/dsh-skill-panel/doc')(
      makeReq({ url: `/api/dsh-skill-panel/doc${query}&name=toggle-me&source=user-dsh`, headers: origin }),
      doc,
    )
    assert.equal(doc.statusCode, 200, doc.text)
    assert.match(doc.json.content, /改过的说明/)

    // delete（项目层技能 → 回收目录）
    const deleted = makeRes()
    await routes.get('/api/dsh-skill-panel/delete')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/delete${query}`, headers: origin, body: JSON.stringify({ name: 'fresh-skill', source: 'project-dsh' }) }),
      deleted,
    )
    assert.equal(deleted.statusCode, 200, deleted.text)
    assert.equal(existsSync(path.join(project, '.dsh', 'skills', 'fresh-skill')), false)
    assert.ok(deleted.json.trash.startsWith(home))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('导入来源与目标目录重叠时被拒', async () => {
  const home = await makeTempDir('home4')
  const project = await makeTempDir('project4')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  const target = path.join(project, '.dsh', 'skills')
  await fsp.mkdir(path.join(target, 'seed-skill'), { recursive: true })
  await fsp.writeFile(path.join(target, 'seed-skill', 'SKILL.md'), skillText('seed-skill', '说明'))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    apply(ctx)
    const query = `?project=${encodeURIComponent(project)}`
    for (const sourcePath of [target, path.join(target, 'seed-skill')]) {
      const response = makeRes()
      await routes.get('/api/dsh-skill-panel/import-folder')(
        makeReq({
          method: 'POST',
          url: `/api/dsh-skill-panel/import-folder${query}`,
          headers: { host: '127.0.0.1:1234' },
          body: JSON.stringify({ sourcePath, scope: 'project' }),
        }),
        response,
      )
      assert.equal(response.statusCode, 400, response.text)
      assert.match(response.json.errors[0], /重叠/)
    }
    const outside = await makeTempDir('outside')
    await fsp.mkdir(path.join(outside, 'foreign-skill'), { recursive: true })
    await fsp.writeFile(path.join(outside, 'foreign-skill', 'SKILL.md'), skillText('foreign-skill', '外部技能'))
    const ok = makeRes()
    await routes.get('/api/dsh-skill-panel/import-folder')(
      makeReq({
        method: 'POST',
        url: `/api/dsh-skill-panel/import-folder${query}`,
        headers: { host: '127.0.0.1:1234' },
        body: JSON.stringify({ sourcePath: outside, scope: 'project' }),
      }),
      ok,
    )
    assert.equal(ok.statusCode, 200, ok.text)
    assert.equal(ok.json.results[0].ok, true)
    assert.ok(existsSync(path.join(target, 'foreign-skill', 'SKILL.md')))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('作用域双向切换：全局 ⇄ 本项目（停用全局 + 复制副本 / 删副本 + 恢复全局）', async () => {
  const home = await makeTempDir('home-scope')
  const project = await makeTempDir('project-scope')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  const globalDir = path.join(home, 'skills', 'switch-me')
  await fsp.mkdir(globalDir, { recursive: true })
  const globalFile = path.join(globalDir, 'SKILL.md')
  await fsp.writeFile(globalFile, skillText('switch-me', '可切换的技能'))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    apply(ctx)
    const query = `?project=${encodeURIComponent(project)}`
    const call = async (path, body) => {
      const response = makeRes()
      await routes.get(`/api/dsh-skill-panel/${path}`)(
        makeReq({ method: 'POST', url: `/api/dsh-skill-panel/${path}${query}`, headers: { host: '127.0.0.1:1234' }, body: JSON.stringify(body) }),
        response,
      )
      return response
    }
    const list = async () => {
      const response = makeRes()
      await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: `/api/dsh-skill-panel/list${query}` }), response)
      return response.json
    }

    // 全局 → 本项目：全局那份停用，项目里出现启用副本
    const toProject = await call('scope', { name: 'switch-me', scope: 'project' })
    assert.equal(toProject.statusCode, 200, toProject.text)
    assert.match(await fsp.readFile(globalFile, 'utf8'), /disable-model-invocation: true/)
    const copyFile = path.join(project, '.dsh', 'skills', 'switch-me', 'SKILL.md')
    assert.ok(existsSync(copyFile))
    const copyText = await fsp.readFile(copyFile, 'utf8')
    assert.match(copyText, /disable-model-invocation: false/)
    assert.match(copyText, /user-invocable: true/)
    const afterDemote = await list()
    const winner = afterDemote.skills.find((skill) => skill.name === 'switch-me')
    assert.equal(winner.scope, 'project')
    assert.equal(winner.modelInvocable, true)
    assert.equal(winner.shadowed[0].source, 'user-dsh')

    // 本项目 → 全局：内容未变，走短路（不留回收副本），全局那份恢复启用
    const toGlobal = await call('scope', { name: 'switch-me', scope: 'global' })
    assert.equal(toGlobal.statusCode, 200, toGlobal.text)
    assert.equal(toGlobal.json.reused, true)
    assert.equal(existsSync(path.join(project, '.dsh', 'skills', 'switch-me')), false)
    const trashRoot = path.join(home, 'skill-panel-trash')
    assert.deepEqual(existsSync(trashRoot) ? await fsp.readdir(trashRoot) : [], [])
    const restored = await fsp.readFile(globalFile, 'utf8')
    assert.match(restored, /disable-model-invocation: false/)
    assert.match(restored, /user-invocable: true/)
    const afterPromote = await list()
    const restoredWinner = afterPromote.skills.find((skill) => skill.name === 'switch-me')
    assert.equal(restoredWinner.scope, 'global')
    assert.equal(restoredWinner.modelInvocable, true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('跨站请求被拒，方法错误返回 405', async () => {
  const home = await makeTempDir('home3')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([])
    apply(ctx)
    const blocked = makeRes()
    await routes.get('/api/dsh-skill-panel/list')(
      makeReq({ url: '/api/dsh-skill-panel/list', headers: { 'sec-fetch-site': 'cross-site' } }),
      blocked,
    )
    assert.equal(blocked.statusCode, 403)

    const wrongMethod = makeRes()
    await routes.get('/api/dsh-skill-panel/flags')(
      makeReq({ method: 'GET', url: '/api/dsh-skill-panel/flags', headers: { host: '127.0.0.1:1234' } }),
      wrongMethod,
    )
    assert.equal(wrongMethod.statusCode, 405)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
