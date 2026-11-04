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
    // 拿不到 DSH 注册表时照常工作，只是不做标注
    assert.equal(response.json.dshChecked, false)
    assert.ok(response.json.skills.every((skill) => skill.dsh === undefined))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('/list 与导入结果向 DSH 注册表核对实际加载状态', async () => {
  const home = await makeTempDir('home-dsh')
  const project = await makeTempDir('project-dsh')
  const source = await makeTempDir('source-dsh')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  const write = async (root, name, description) => {
    await fsp.mkdir(path.join(root, name), { recursive: true })
    await fsp.writeFile(path.join(root, name, 'SKILL.md'), skillText(name, description))
    return path.join(root, name, 'SKILL.md')
  }
  const globalLoaded = await write(path.join(home, 'skills'), 'loaded-one', '全局')
  const globalTwin = await write(path.join(home, 'skills'), 'twin', '全局那份')
  await write(path.join(project, '.dsh', 'skills'), 'twin', '项目那份（假设 DSH 解析失败）')
  await write(source, 'brand-new', '导入的新技能')

  // 假注册表：只认 loaded-one 与全局那份 twin；brand-new 永远不在里面（模拟 DSH 解析失败）
  const seenScopes = []
  const registry = {
    async snapshot(options) {
      seenScopes.push(options && options.scope)
      return {
        complete: true,
        skills: [
          { name: 'loaded-one', source: 'user-dsh', path: globalLoaded },
          { name: 'twin', source: 'user-dsh', path: globalTwin },
        ],
      }
    },
  }
  // 假预设注册表：真实 0.2.x 里本地技能 provider 挂在 preset 作用域，必须 acquireScope 才看得见
  let disposed = 0
  let acquired = []
  const presetsService = {
    async list() {
      return [{ id: 'standard' }, { id: 'broken-one', broken: 'boom' }]
    },
    async acquireScope(id) {
      acquired.push(id)
      return {
        key: { preset: id },
        async [Symbol.asyncDispose]() {
          disposed += 1
        },
      }
    },
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    const baseGet = ctx.get
    ctx.get = (name) => (name === 'skills' ? registry : name === 'agentPresets' ? presetsService : baseGet(name))
    apply(ctx)
    const query = `?project=${encodeURIComponent(project)}`

    const listed = makeRes()
    await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: `/api/dsh-skill-panel/list${query}` }), listed)
    assert.equal(listed.json.dshChecked, true)
    // 必须按 preset 作用域读，并且租约用完要释放
    assert.deepEqual(acquired, ['standard'])
    assert.equal(disposed, 1)
    assert.deepEqual(seenScopes[0], { preset: 'standard' })
    assert.equal(listed.json.dshProbe.method, 'snapshot-scoped')
    assert.deepEqual(listed.json.dshProbe.presets.map((item) => item.id), ['standard', 'broken-one'])
    const byName = Object.fromEntries(listed.json.skills.map((skill) => [skill.name, skill]))
    assert.deepEqual(byName['loaded-one'].dsh, { state: 'loaded' })
    assert.equal(byName.twin.source, 'project-dsh')
    assert.equal(byName.twin.dsh.state, 'other')
    assert.equal(byName.twin.dsh.source, 'user-dsh')

    const imported = makeRes()
    await routes.get('/api/dsh-skill-panel/import-folder')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/import-folder${query}`, body: JSON.stringify({ sourcePath: source, scope: 'project' }) }),
      imported,
    )
    assert.equal(imported.statusCode, 200, imported.text)
    assert.equal(imported.json.results[0].ok, true)
    assert.deepEqual(imported.json.results[0].dsh, { state: 'missing' })
    // 写操作后必须重新取作用域快照（不吃旧缓存）；brand-new 永远等不到，会一直重查到截止时间
    assert.ok(acquired.length >= 2, '写操作之后要重新核对，不能吃旧缓存')
    assert.equal(disposed, acquired.length, '每次取到的作用域租约都要释放')
    assert.equal(imported.json.results[0].dsh.state, 'missing')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('多个 preset 胜出者不同：任一 preset 采用这一份就算已加载', async () => {
  const home = await makeTempDir('home-union')
  const project = await makeTempDir('project-union')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'dup'), { recursive: true })
  const globalDup = path.join(home, 'skills', 'dup', 'SKILL.md')
  await fsp.writeFile(globalDup, skillText('dup', '全局那份'))

  // cordis 预设额外挂了 custom 根（rank 300 压过 user-dsh 400），standard 预设没有
  const views = {
    cordis: [{ name: 'dup', source: 'custom', path: path.join(home, 'preset-skills', 'dup', 'SKILL.md') }],
    standard: [{ name: 'dup', source: 'user-dsh', path: globalDup }],
  }
  const registry = {
    async snapshot(options) {
      return { complete: true, skills: views[options.scope.preset] }
    },
  }
  const presetsService = {
    async list() {
      return [{ id: 'cordis' }, { id: 'standard' }]
    },
    async acquireScope(id) {
      return { key: { preset: id }, async [Symbol.asyncDispose]() {} }
    },
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    const baseGet = ctx.get
    ctx.get = (name) => (name === 'skills' ? registry : name === 'agentPresets' ? presetsService : baseGet(name))
    apply(ctx)
    const listed = makeRes()
    await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: `/api/dsh-skill-panel/list?project=${encodeURIComponent(project)}` }), listed)
    const dup = listed.json.skills.find((skill) => skill.name === 'dup')
    assert.deepEqual(dup.dsh, { state: 'loaded' }, '排在前面的 preset 用的是别的副本，也不能判成未生效')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('写操作后等 DSH 追上磁盘再返回：切到本项目后立刻 /list 不会误报「未生效」', async () => {
  const home = await makeTempDir('home-settle')
  const project = await makeTempDir('project-settle')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'mover'), { recursive: true })
  const globalPath = path.join(home, 'skills', 'mover', 'SKILL.md')
  await fsp.writeFile(globalPath, skillText('mover', '会被搬到本项目'))
  const projectPath = path.join(project, '.dsh', 'skills', 'mover', 'SKILL.md')

  // 假注册表模拟 DSH 目录监听的延迟：写之后的前 lag 次快照仍返回写之前的视图
  let lag = 0
  let calls = 0
  const registry = {
    async snapshot() {
      calls += 1
      if (lag > 0) {
        lag -= 1
        return { complete: true, skills: [{ name: 'mover', source: 'user-dsh', path: globalPath, invocation: { modelInvocable: true, userInvocable: true } }] }
      }
      const skills = []
      if (existsSync(projectPath)) skills.push({ name: 'mover', source: 'project-dsh', path: projectPath, invocation: { modelInvocable: true, userInvocable: true } })
      else skills.push({ name: 'mover', source: 'user-dsh', path: globalPath, invocation: { modelInvocable: true, userInvocable: true } })
      return { complete: true, skills }
    },
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
    const baseGet = ctx.get
    ctx.get = (name) => (name === 'skills' ? registry : baseGet(name))
    apply(ctx)
    const query = `?project=${encodeURIComponent(project)}`

    lag = 2
    const callsBefore = calls
    const moved = makeRes()
    await routes.get('/api/dsh-skill-panel/scope')(
      makeReq({ method: 'POST', url: `/api/dsh-skill-panel/scope${query}`, body: JSON.stringify({ name: 'mover', scope: 'project' }) }),
      moved,
    )
    assert.equal(moved.statusCode, 200, moved.text)
    assert.ok(calls - callsBefore >= 3, '要一直重查到 DSH 的视图反映出项目副本')

    const callsAfterWrite = calls
    const listed = makeRes()
    await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: `/api/dsh-skill-panel/list${query}` }), listed)
    const mover = listed.json.skills.find((skill) => skill.name === 'mover')
    assert.equal(mover.source, 'project-dsh')
    assert.deepEqual(mover.dsh, { state: 'loaded' }, '切到本项目后立刻刷新，不能显示「未生效」')
    assert.equal(calls, callsAfterWrite, '紧跟着的 /list 复用写操作结束时的新视图，不再多读一次')
    assert.equal(listed.json.dshProbe.settle.settled, true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('注册表视图可疑时不逐行标注（防止整页误报「DSH 未加载」）', async () => {
  const home = await makeTempDir('home-guard')
  const project = await makeTempDir('project-guard')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'local-one'), { recursive: true })
  await fsp.writeFile(path.join(home, 'skills', 'local-one', 'SKILL.md'), skillText('local-one', '本地技能'))

  const cases = [
    // 结果里只有非本地来源：面板拿到的视图不对，而不是本地文件都坏了
    { registry: { async snapshot() { return { complete: true, skills: [{ name: 'office', source: 'bundled', provider: 'office' }] } } }, verdict: 'no-local-skills' },
    // 注册表自己报告不完整
    { registry: { async snapshot() { return { complete: false, skills: [{ name: 'local-one', source: 'user-dsh', provider: 'filesystem' }] } } }, verdict: 'incomplete' },
  ]
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    for (const { registry, verdict } of cases) {
      registry.list = async () => []
      const { ctx, routes } = makeCtx([{ path: project, title: 'demo' }])
      const baseGet = ctx.get
      ctx.get = (name) => (name === 'skills' ? registry : baseGet(name))
      apply(ctx)
      const listed = makeRes()
      await routes.get('/api/dsh-skill-panel/list')(makeReq({ url: `/api/dsh-skill-panel/list?project=${encodeURIComponent(project)}` }), listed)
      assert.equal(listed.json.dshChecked, false)
      assert.equal(listed.json.dshProbe.verdict, verdict)
      assert.ok(listed.json.skills.every((skill) => skill.dsh === undefined), `${verdict} 时不应逐行标注`)
    }
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
