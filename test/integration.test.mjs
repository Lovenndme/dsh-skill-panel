/**
 * 端到端：真实 http 服务器 + 真实宿主路由 + 真实磁盘 + 真实客户端组件。
 *
 * 前面的测试各自只验一侧（lib 纯函数、路由层、客户端假数据）。这一层把两端接起来，
 * 能抓到「字段名/参数对不上」这类只在浏览器里才会暴露、而且不会报错的错位。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import { buttons, click, createMiniReact, findAll, inputs, textOf, typeInto } from './helpers/mini-react.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(here, '..', 'client.js')

/* --------------------------------------------------------------- 基础设施 */

function doc(name, description, extra = {}, body = '正文') {
  const lines = ['---', `name: ${name}`, `description: '${description}'`]
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${value}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

/** 用 apply() 注册的处理器起一个真的 http 服务器。 */
async function startHost({ workspaces }) {
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
      return undefined // 没有 connection / skills：走 loopback 兜底 + 不做 DSH 标注
    },
    logger: { info() {} },
  }
  apply(ctx)

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (!handler) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(String(error))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    routes,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 在受控环境里加载 client.js，并让它的 fetch 打向真实服务器。 */
async function loadClient(base) {
  const source = await fsp.readFile(CLIENT_PATH, 'utf8')
  const storage = new Map()
  const captured = { definition: null }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (callback) => setTimeout(() => callback(0), 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) },
  }
  const body = { contains: () => false }
  const document = {
    body,
    activeElement: body,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  }
  class FakeNode {}
  const realFetch = globalThis.fetch
  const proxied = (url, init) => realFetch(`${base}${url}`, init)

  new Function('window', 'document', 'fetch', 'Node', 'navigator', 'console', 'setTimeout', 'clearTimeout', source)(
    window,
    document,
    proxied,
    FakeNode,
    { userAgent: 'e2e' },
    { ...console, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  )
  const mini = createMiniReact()
  const definition = captured.definition
  const mod = definition.factory((name) => {
    if (name === 'react') return mini.React
    throw new Error(`不提供 ${name}`)
  })
  const registrations = []
  mod.apply({
    slots: {
      inject(name, factory) {
        factory()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  })
  return { component: registrations[0].component, mini }
}

/** 等某个文本出现 / 消失。 */
const untilText = (mini, element, needle, present = true) =>
  mini.settleUntil(element, (tree) => textOf(tree).includes(needle) === present, E2E)
const E2E = { renderEveryTick: true, stepMs: 20, timeoutMs: 3000 }

/** 等文件出现（客户端发完请求后才会落盘）。 */
async function untilFile(file, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** 等详情里的启用开关变成可操作状态（真实 UI 在文件读完前是 disabled）。 */
const untilSwitchReady = (mini, element) =>
  mini.settleUntil(element, (tree) => {
    const node = findAll(tree, (item) => item.kind === 'host' && item.props && item.props.role === 'switch')[0]
    return !!node && node.props.disabled !== true && node.props.disabled !== 'true'
  }, E2E)

/* ================================================================ 端到端 */

test('端到端：列表、搜索、关掉启用、删除，全部落在真实磁盘上', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsp-e2e-home-'))
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsp-e2e-project-'))
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await fsp.mkdir(path.join(home, 'skills', 'e2e-global'), { recursive: true })
  await fsp.writeFile(path.join(home, 'skills', 'e2e-global', 'SKILL.md'), doc('e2e-global', '全局技能', {}, 'GLOBAL BODY'))
  await fsp.mkdir(path.join(project, '.dsh', 'skills', 'e2e-project'), { recursive: true })
  await fsp.writeFile(path.join(project, '.dsh', 'skills', 'e2e-project', 'SKILL.md'), doc('e2e-project', '项目技能', {}, 'PROJECT BODY'))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const host = await startHost({ workspaces: [{ path: project, title: 'e2e' }] })
  try {
    const { component, mini } = await loadClient(host.base)
    const element = mini.React.createElement(component, {})

    // 1) 列表（真实 GET /list）
    let tree = await untilText(mini, element, 'e2e-global')
    assert.match(textOf(tree), /e2e-global/)
    assert.match(textOf(tree), /e2e-project/)

    // 2) 打开详情，读真实文件
    click(buttons(tree).find((node) => textOf(node).trim() === 'e2e-global'))
    tree = await untilText(mini, element, 'GLOBAL BODY')
    assert.match(textOf(tree), /GLOBAL BODY/, '详情必须显示真实文件内容')

    // 3) 关掉启用 → 真实 SKILL.md 两个开关都要变（磁盘是唯一事实源）
    tree = await untilSwitchReady(mini, element)
    const toggle = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.role === 'switch')[0]
    assert.ok(toggle, '详情里必须有启用开关')
    click(toggle)
    const globalFile = path.join(home, 'skills', 'e2e-global', 'SKILL.md')
    await mini.settleUntil(element, () => false, { timeoutMs: 400, stepMs: 50, renderEveryTick: true })
    const afterToggle = await fsp.readFile(globalFile, 'utf8')
    assert.match(afterToggle, /disable-model-invocation: true/, '关掉后模型不可调用')
    assert.match(afterToggle, /user-invocable: false/, '关掉后命令也不可调用')
    assert.match(afterToggle, /GLOBAL BODY/, '正文不能丢')
    // 刷新后的界面必须反映真实状态（详情里的开关或列表里的「已停用」标签）
    tree = await mini.settleUntil(
      element,
      (probe) => {
        const text = textOf(probe)
        const current = findAll(probe, (node) => node.kind === 'host' && node.props && node.props.role === 'switch')[0]
        return text.includes('已停用') || (!!current && current.props['aria-checked'] === 'false')
      },
      E2E,
    )
    assert.ok(
      textOf(tree).includes('已停用') ||
        (() => {
          const current = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.role === 'switch')[0]
          return !!current && current.props['aria-checked'] === 'false'
        })(),
      '界面必须反映「已停用」',
    )

    // 4) 回到列表，用搜索过滤（纯客户端）
    const backButton =
      buttons(tree).find((node) => String(node.props['aria-label'] || '') === '返回') ||
      buttons(tree).find((node) => String(node.props['aria-label'] || '') === '关闭') ||
      buttons(tree).find((node) => textOf(node).trim() === '返回')
    if (backButton) click(backButton)
    tree = await untilText(mini, element, 'e2e-project')
    const search = inputs(tree).find((node) => String(node.props.placeholder || '').includes('搜索'))
    assert.ok(search, '必须有搜索输入框')
    typeInto(search, 'e2e-project')
    tree = mini.render(element)
    assert.match(textOf(tree), /e2e-project/)
    assert.doesNotMatch(textOf(tree), /e2e-global/)
    const clear = buttons(tree).find((node) => String(node.props['aria-label'] || '').includes('清空'))
    if (clear) click(clear)
    tree = await untilText(mini, element, 'e2e-global')

    // 5) 删除项目技能（真实移入回收目录）
    const deleteButton = buttons(tree).find((node) => String(node.props['aria-label'] || '') === '删除 e2e-project')
    assert.ok(deleteButton, '项目技能行必须有删除按钮')
    click(deleteButton)
    tree = mini.render(element)
    const confirm = buttons(tree).find((node) => textOf(node).includes('移到回收目录'))
    assert.ok(confirm, '第一次点击只进确认态')
    click(confirm)
    tree = await untilText(mini, element, 'e2e-project', false)

    assert.equal(existsSync(path.join(project, '.dsh', 'skills', 'e2e-project')), false, '技能目录应已移走')
    const trash = await fsp.readdir(path.join(home, 'skill-panel-trash'))
    assert.equal(trash.filter((name) => name.endsWith('e2e-project')).length, 1)
    // 成功后会有提示条写着技能名，所以按「行」判断而不是按全文
    const rows = findAll(tree, (node) => node.kind === 'host' && node.props && node.props['data-skill'] === 'e2e-project')
    assert.equal(rows.length, 0, '删除后列表里不该还留着这一行')
  } finally {
    await host.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('端到端：新建技能写进磁盘并出现在列表里', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsp-e2e2-home-'))
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsp-e2e2-project-'))
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const host = await startHost({ workspaces: [{ path: project, title: 'e2e' }] })
  try {
    const { component, mini } = await loadClient(host.base)
    const element = mini.React.createElement(component, {})
    // 等列表真正加载完（分组标题里会显示技能根路径），否则新建对话框拿不到项目
    let tree = await untilText(mini, element, home)

    click(buttons(tree).find((node) => textOf(node).trim().includes('新建')))
    tree = await untilText(mini, element, '新建技能')

    const nameInput = inputs(tree).find((node) => node.props.id && String(node.props.id).includes('name'))
    const descInput = inputs(tree).find((node) => node.props.id && String(node.props.id).includes('desc'))
    assert.ok(nameInput && descInput, '新建对话框必须有名称与描述输入')
    typeInto(nameInput, 'created-by-e2e')
    typeInto(descInput, '端到端新建的技能')
    tree = mini.render(element)
    const submit = buttons(tree).find((node) => textOf(node).trim() === '创建')
    assert.ok(submit, '必须有创建按钮')
    click(submit, tree)

    const created = path.join(project, '.dsh', 'skills', 'created-by-e2e', 'SKILL.md')
    assert.equal(await untilFile(created), true, `技能应写进项目目录：${created}`)
    assert.match(await fsp.readFile(created, 'utf8'), /created-by-e2e/)
    tree = await untilText(mini, element, 'created-by-e2e')
    assert.match(textOf(tree), /created-by-e2e/, '创建后列表应刷新出这个技能')
    assert.doesNotMatch(textOf(tree), /新建技能/, '创建成功后对话框应关闭')
  } finally {
    await host.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})



