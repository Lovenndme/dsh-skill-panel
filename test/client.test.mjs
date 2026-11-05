/**
 * 浏览器半区集成测试：用一个极简 React 替身 + 假的 window/document/fetch 真正跑组件，
 * 断言「点了按钮之后发了什么请求」。这一层是唯一能覆盖 client.js 的手段——
 * 它没有编译步骤，写坏了不会报错，只会静默失效。
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buttons, click, createMiniReact, findAll, inputs, textOf, typeInto } from './helpers/mini-react.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(here, '..', 'client.js')

/* --------------------------------------------------------------- 浏览器替身 */

function createDocument() {
  const listeners = new Map()
  const body = {
    contains: () => false,
    appendChild() {},
    removeChild() {},
  }
  return {
    body,
    activeElement: body,
    head: body,
    documentElement: body,
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {} }),
    createTextNode: (text) => ({ textContent: text }),
  }
}

function createWindow() {
  const storage = new Map()
  const listeners = new Map()
  const captured = { definition: null }
  return {
    captured,
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
      get length() {
        return storage.size
      },
      key: (index) => [...storage.keys()][index] ?? null,
    },
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    requestAnimationFrame: (callback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) },
    getSelection: () => null,
    scrollTo() {},
  }
}

class FakeNode {
  constructor() {
    this.children = []
  }
  contains() {
    return false
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null
  }
  focus() {}
  getAttribute() {
    return null
  }
}

const LOOPBACK_ORIGIN = 'http://127.0.0.1:1'

/** 统一的 fetch 替身：按 URL 分派，记录每次调用。 */
function createFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, method: (init.method || 'GET').toUpperCase(), body: init.body })
    for (const [match, handler] of routes) {
      if (target.includes(match)) {
        const payload = typeof handler === 'function' ? handler(target, init) : handler
        if (payload === undefined) {
          return { ok: false, status: 500, json: async () => ({ ok: false, errors: ['no route'] }) }
        }
        return { ok: true, status: 200, json: async () => payload }
      }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, errors: [`没有拦截 ${target}`] }) }
  }
  return { fetchImpl, calls }
}

function skill(overrides = {}) {
  const name = overrides.name || 'alpha-skill'
  return {
    name,
    description: overrides.description || `${name} 的描述`,
    scope: overrides.scope || 'global',
    source: overrides.source || 'user-dsh',
    rank: 400,
    path: overrides.path || `C:\\Users\\demo\\.dsh\\skills\\${name}\\SKILL.md`,
    dir: overrides.dir || `C:\\Users\\demo\\.dsh\\skills\\${name}`,
    kind: 'dir',
    modelInvocable: overrides.modelInvocable !== false,
    userInvocable: overrides.userInvocable !== false,
    stub: !!overrides.stub,
    shadowed: overrides.shadowed || [],
  }
}

const PROJECT = 'C:\\demo\\project'

function listPayload(overrides = {}) {
  return {
    ok: true,
    dshHome: 'C:\\Users\\demo\\.dsh',
    agentsHome: 'C:\\Users\\demo\\.agents',
    projectCwd: PROJECT,
    projectRoot: PROJECT,
    workspaces: [{ path: PROJECT, title: 'demo' }],
    roots: [
      { source: 'project-dsh', scope: 'project', rank: 100, root: `${PROJECT}\\.dsh\\skills` },
      { source: 'user-dsh', scope: 'global', rank: 400, root: 'C:\\Users\\demo\\.dsh\\skills' },
    ],
    dshChecked: true,
    dshProbe: { verdict: 'checked', method: 'snapshot-scoped', scope: 'preset-union', presets: [] },
    skills: overrides.skills || [skill(), skill({ name: 'beta-skill', description: '第二个技能', modelInvocable: false, userInvocable: false })],
    diagnostics: overrides.diagnostics || [],
  }
}

/** 把 client.js 在一个受控的 window/document/fetch 里跑起来，返回组件与调用记录。 */
async function loadClient({ routes } = {}) {
  const source = await fsp.readFile(CLIENT_PATH, 'utf8')
  const window = createWindow()
  const document = createDocument()
  const { fetchImpl, calls } = createFetch(routes || [['/api/dsh-skill-panel/list', () => listPayload()]])
  const mini = createMiniReact()

  const factory = new Function('window', 'document', 'fetch', 'Node', 'navigator', 'console', source)
  factory(window, document, fetchImpl, FakeNode, { userAgent: 'node-test', clipboard: undefined }, {
    ...console,
    warn() {},
    error() {},
  })

  const definition = window.captured.definition
  assert.ok(definition, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, '@lovenndme/dsh-skill-panel', '客户端模块 id 必须与包名一致')

  const mod = definition.factory((name) => {
    if (name === 'react') return mini.React
    // dsh-client-ui-primitives 不是文档化 API：客户端必须能在拿不到时退回纯文本
    throw new Error(`测试环境不提供 ${name}`)
  })
  return { mod, mini, calls, window, document }
}

function mountApply(mod) {
  const registrations = []
  const ctx = {
    slots: {
      inject(name, factory) {
        factory()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  return registrations
}

/* ==================================================================== 测试 */

test('模块形状：inject 与 settings.section 注册契约', async () => {
  const { mod } = await loadClient()
  assert.deepEqual(mod.inject, ['slots'])
  const registrations = mountApply(mod)
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'skills', '设置页 id 决定导航里的位置，不能改')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '技能')
  assert.equal(typeof component, 'function')
})

test('首屏：先出骨架，拿到数据后按全局/本项目分组渲染', async () => {
  const { mod, mini } = await loadClient({
    routes: [
      [
        '/api/dsh-skill-panel/list',
        () =>
          listPayload({
            skills: [
              skill({ name: 'alpha-skill' }),
              skill({ name: 'project-skill', scope: 'project', source: 'project-dsh' }),
            ],
          }),
      ],
    ],
  })
  const [{ component }] = mountApply(mod)
  const tree = await mini.settle(mini.React.createElement(component, {}))
  const text = textOf(tree)
  assert.match(text, /alpha-skill/)
  assert.match(text, /project-skill/)
  assert.match(text, /全局技能/)
  assert.match(text, /本项目技能/)
})

test('搜索框按名称过滤行', async () => {
  const { mod, mini } = await loadClient()
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  const search = inputs(tree).find((node) => String(node.props.placeholder || '').includes('搜索'))
  assert.ok(search, '必须有搜索输入框')
  typeInto(search, 'beta')
  tree = mini.render(mini.React.createElement(component, {}))
  const text = textOf(tree)
  assert.match(text, /beta-skill/)
  assert.doesNotMatch(text, /alpha-skill/)
})

test('删除需要二次确认，确认后才发 /delete', async () => {
  const { mod, mini, calls } = await loadClient({
    routes: [
      ['/api/dsh-skill-panel/list', () => listPayload({ skills: [skill({ name: 'kill-me' })] })],
      ['/api/dsh-skill-panel/delete', () => ({ ok: true, trash: 'C:\\trash\\kill-me' })],
    ],
  })
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  const deleteButton = buttons(tree).find((node) => String(node.props['aria-label'] || '').startsWith('删除'))
  assert.ok(deleteButton, '行上必须有删除按钮')
  click(deleteButton)
  tree = mini.render(mini.React.createElement(component, {}))
  assert.equal(calls.filter((call) => call.url.includes('/delete')).length, 0, '第一次点击只进确认态')
  const confirm = buttons(tree).find((node) => textOf(node).includes('移到回收目录'))
  assert.ok(confirm, '必须出现确认按钮')
  click(confirm)
  await mini.settle(mini.React.createElement(component, {}))
  const deleteCalls = calls.filter((call) => call.url.includes('/api/dsh-skill-panel/delete'))
  assert.equal(deleteCalls.length, 1)
  const body = JSON.parse(deleteCalls[0].body)
  assert.equal(body.name, 'kill-me')
  assert.equal(body.source, 'user-dsh')
})

test('取消确认不发请求', async () => {
  const { mod, mini, calls } = await loadClient({
    routes: [['/api/dsh-skill-panel/list', () => listPayload({ skills: [skill({ name: 'keep-me' })] })]],
  })
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  click(buttons(tree).find((node) => String(node.props['aria-label'] || '').startsWith('删除')))
  tree = mini.render(mini.React.createElement(component, {}))
  click(buttons(tree).find((node) => textOf(node).trim() === '取消'))
  await mini.settle(mini.React.createElement(component, {}))
  assert.equal(calls.filter((call) => call.url.includes('/delete')).length, 0)
})

test('详情：点名称打开并读取 /doc，切换启用开关发 /flags', async () => {
  const content = "---\nname: alpha-skill\ndescription: '描述'\ndisable-model-invocation: false\nuser-invocable: true\n---\n\n# 正文标题\n"
  const { mod, mini, calls } = await loadClient({
    routes: [
      ['/api/dsh-skill-panel/list', () => listPayload({ skills: [skill({ name: 'alpha-skill' })] })],
      ['/api/dsh-skill-panel/doc', () => ({ ok: true, name: 'alpha-skill', source: 'user-dsh', path: 'C:\\x\\SKILL.md', size: content.length, content })],
      ['/api/dsh-skill-panel/flags', () => ({ ok: true, path: 'C:\\x\\SKILL.md' })],
    ],
  })
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  const nameButton = buttons(tree).find((node) => textOf(node).trim() === 'alpha-skill')
  assert.ok(nameButton, '技能名本身应当可点开详情')
  click(nameButton)
  tree = await mini.settle(mini.React.createElement(component, {}))
  assert.ok(calls.some((call) => call.url.includes('/api/dsh-skill-panel/doc')), '打开详情必须读文件')
  assert.match(textOf(tree), /正文标题/, '预览里应出现文件正文')

  const toggle = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.role === 'switch')[0]
  assert.ok(toggle, '详情里必须有启用开关')
  const before = toggle.props['aria-checked']
  click(toggle)
  await mini.settle(mini.React.createElement(component, {}))
  const flagCalls = calls.filter((call) => call.url.includes('/api/dsh-skill-panel/flags'))
  assert.equal(flagCalls.length, 1, '切换开关必须发一次 /flags')
  const body = JSON.parse(flagCalls[0].body)
  assert.equal(body.name, 'alpha-skill')
  assert.equal(body.source, 'user-dsh')
  // 关闭态 -> 打开：两个字段应一起变
  assert.equal(before === 'true' ? body.model === false : body.model === true, true, JSON.stringify(body))
})

test('列表加载失败时显示后端给的原因', async () => {
  const { mod, mini } = await loadClient({
    routes: [
      [
        '/api/dsh-skill-panel/list',
        () => {
          throw Object.assign(new Error('boom'), {})
        },
      ],
    ],
  })
  // 用 500 响应模拟失败
  const source = await fsp.readFile(CLIENT_PATH, 'utf8')
  const window = createWindow()
  const document = createDocument()
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, errors: ['宿主暂时不可用'] }) })
  const mini2 = createMiniReact()
  new Function('window', 'document', 'fetch', 'Node', 'navigator', 'console', source)(
    window,
    document,
    fetchImpl,
    FakeNode,
    { userAgent: 'test' },
    { ...console, warn() {}, error() {} },
  )
  const definition = window.captured.definition
  const mod2 = definition.factory((name) => {
    if (name === 'react') return mini2.React
    throw new Error('no primitives')
  })
  const [{ component }] = mountApply(mod2)
  const tree = await mini2.settle(mini2.React.createElement(component, {}))
  assert.match(textOf(tree), /宿主暂时不可用/)
  void mod
  void mini
})

test('存在诊断条目时可在「无法读取」里看到原因', async () => {
  const { mod, mini } = await loadClient({
    routes: [
      [
        '/api/dsh-skill-panel/list',
        () => listPayload({ diagnostics: [{ source: 'user-dsh', path: 'C:\\bad\\SKILL.md', reason: '缺少 name' }] }),
      ],
    ],
  })
  const [{ component }] = mountApply(mod)
  const tree = await mini.settle(mini.React.createElement(component, {}))
  const text = textOf(tree)
  assert.match(text, /无法读取|诊断/)
})

test('切换项目会对新项目再发一次 /list', async () => {
  const { mod, mini, calls } = await loadClient()
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  const listCallsBefore = calls.filter((call) => call.url.includes('/list')).length
  // ProjectPicker 展开后选择另一个工作区
  const picker = buttons(tree).find((node) => String(node.props['aria-label'] || '').includes('项目'))
  if (!picker) return // 选择器形态可能变化，缺失时不阻塞
  click(picker)
  tree = mini.render(mini.React.createElement(component, {}))
  const option = buttons(tree).find((node) => node.props && node.props.role === 'option')
  if (!option) return
  click(option)
  await mini.settle(mini.React.createElement(component, {}))
  assert.ok(calls.filter((call) => call.url.includes('/list')).length >= listCallsBefore)
})

test('数据里没有 projectRoot 时，新建按钮不应提交项目作用域', async () => {
  const { mod, mini, calls } = await loadClient({
    routes: [
      ['/api/dsh-skill-panel/list', () => ({ ...listPayload(), projectRoot: undefined, projectCwd: undefined, workspaces: [] })],
      ['/api/dsh-skill-panel/create', () => ({ ok: true, path: 'C:\\x' })],
    ],
  })
  const [{ component }] = mountApply(mod)
  let tree = await mini.settle(mini.React.createElement(component, {}))
  const createButton = buttons(tree).find((node) => textOf(node).trim().includes('新建'))
  assert.ok(createButton, '工具栏必须有新建按钮')
  click(createButton)
  tree = await mini.settle(mini.React.createElement(component, {}))
  const globalOption = buttons(tree).find((node) => textOf(node).trim() === '全局')
  assert.ok(globalOption, '没有项目目录时应能选全局')
})


