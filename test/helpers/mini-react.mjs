/**
 * 极简 React 替身：只实现 client.js 用到的 createElement + 5 个 hook，
 * 把组件树渲染成可断言的普通对象，供浏览器半区在没有 DOM/浏览器的情况下做集成测试。
 *
 * 不是通用实现：hook 状态按「组件在树里的路径」保存，所以条件渲染会让状态错位。
 * 面板里的组件形状是稳定的，这个近似足够用；如果哪天出现条件 hook，测试会先炸。
 */

const Fragment = Symbol('Fragment')

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (!Array.isArray(previous) || !Array.isArray(next)) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

export function createMiniReact() {
  const pendingEffects = []
  let current = null
  let rerenderRequested = false
  let rootStore = null

  function createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true) }
  }

  let forwardSeed = 0
  function forwardRef(render) {
    forwardSeed += 1
    return { $$forwardRef: true, $$id: `fwd${forwardSeed}`, render }
  }

  /**
   * 类组件只用来支持错误边界：这里实现最小子集
   * （state / setState / props / render），并把它当普通组件渲染。
   */
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch
      this.state = { ...this.state, ...next }
      rerenderRequested = true
    }
    render() {
      return null
    }
  }

  function newStore() {
    return { hooks: [], children: {} }
  }

  function childStore(parent, key) {
    if (!parent.children[key]) parent.children[key] = newStore()
    return parent.children[key]
  }

  function useSlot(factory) {
    if (!current) throw new Error('hook 在组件外被调用')
    const index = current.index
    current.index += 1
    if (!(index in current.store.hooks)) current.store.hooks[index] = factory()
    return current.store.hooks[index]
  }

  function useState(initial) {
    const box = useSlot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    const setState = (next) => {
      const value = typeof next === 'function' ? next(box.value) : next
      if (Object.is(value, box.value)) return
      box.value = value
      rerenderRequested = true
    }
    return [box.value, setState]
  }

  function useRef(initial) {
    return useSlot(() => ({ current: initial }))
  }

  function useMemo(factory, deps) {
    const box = useSlot(() => ({ deps: undefined, value: undefined }))
    if (!sameDeps(box.deps, deps)) {
      box.deps = deps
      box.value = factory()
    }
    return box.value
  }

  function useCallback(fn, deps) {
    return useMemo(() => fn, deps)
  }

  function useEffect(fn, deps) {
    const box = useSlot(() => ({ deps: undefined, cleanup: undefined, pending: false }))
    if (!sameDeps(box.deps, deps)) {
      box.deps = deps
      box.pending = true
      pendingEffects.push({ box, fn })
    }
  }

  function renderNode(node, store, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
    if (Array.isArray(node)) {
      return { kind: 'fragment', children: node.map((child, index) => renderNode(child, store, `${path}#${index}`)).filter(Boolean) }
    }
    const { type, props: rawProps, children } = node
    const props = { ...rawProps, children: children.length <= 1 ? children[0] : children }
    if (type === Fragment) return renderNode(children, store, path)
    if (type && type.prototype instanceof Component) {
      const key = `${path}/${type.name || 'Class'}`
      const nested = childStore(store, key)
      if (!nested.instance) {
        nested.instance = new type(props)
        nested.instance.props = props
      }
      nested.instance.props = props
      const saved = current
      current = { store: nested, index: 0 }
      let output
      try {
        output = nested.instance.render()
      } finally {
        current = saved
      }
      return renderNode(output, nested, '')
    }
    const isForward = type && typeof type === 'object' && type.$$forwardRef
    if (typeof type === 'function' || isForward) {
      const name = isForward ? type.$$id : type.name || 'Anon'
      const key = `${path}/${name}`
      const nested = childStore(store, key)
      const saved = current
      current = { store: nested, index: 0 }
      let output
      try {
        output = isForward ? type.render(props, null) : type(props)
      } finally {
        current = saved
      }
      return renderNode(output, nested, '')
    }
    return {
      kind: 'host',
      type,
      props,
      children: children.map((child, index) => renderNode(child, store, `${path}/${index}`)).filter(Boolean),
    }
  }

  function runPendingEffects() {
    const batch = pendingEffects.splice(0)
    for (const { box, fn } of batch) {
      if (!box.pending) continue
      box.pending = false
      if (typeof box.cleanup === 'function') {
        try {
          box.cleanup()
        } catch {
          /* 清理失败不该影响测试推进 */
        }
      }
      const cleanup = fn()
      box.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  /** 渲染一次（含 effect 与 effect 触发的同步重渲染）。 */
  function render(element) {
    if (!rootStore) rootStore = newStore()
    let tree = null
    for (let round = 0; round < 30; round += 1) {
      pendingEffects.length = 0
      rerenderRequested = false
      tree = renderNode(element, rootStore, 'root')
      runPendingEffects()
      if (!rerenderRequested) break
    }
    return tree
  }

  /**
   * 渲染并等待异步 effect 引发的状态更新落地。
   * 每一轮让出真实的事件循环（默认 10ms），这样真实的 HTTP/文件 IO 有时间完成。
   */
  async function settle(element, rounds = 20, stepMs = 10) {
    let tree = render(element)
    for (let index = 0; index < rounds; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, stepMs))
      if (!rerenderRequested) {
        const probe = render(element)
        if (!rerenderRequested) return probe
        tree = probe
        continue
      }
      tree = render(element)
    }
    return tree
  }

  /**
   * 一直等到 predicate 成立或超时。
   * 默认只在「真的有状态更新」时重渲染（贴近 React）；`renderEveryTick` 用于端到端场景：
   * 真实网络往返期间组件会被反复渲染，某些派生态（例如「文件已就绪」）只有在重新渲染后才可见。
   */
  async function settleUntil(element, predicate, options = {}) {
    const timeoutMs = options.timeoutMs || 3000
    const stepMs = options.stepMs || 10
    const renderEveryTick = options.renderEveryTick === true
    let tree = render(element)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (typeof predicate === 'function' && predicate(tree)) return tree
      await new Promise((resolve) => setTimeout(resolve, stepMs))
      if (renderEveryTick || rerenderRequested) tree = render(element)
    }
    return tree
  }

  function reset() {
    rootStore = null
    pendingEffects.length = 0
    current = null
    rerenderRequested = false
  }

  return {
    React: { createElement, Fragment, forwardRef, Component, useState, useEffect, useMemo, useCallback, useRef },
    render,
    settle,
    settleUntil,
    reset,
  }
}

/* ------------------------------------------------------------- 树查询工具 */

export function textOf(node) {
  if (!node) return ''
  if (node.kind === 'text') return node.text
  if (node.kind === 'fragment') return node.children.map(textOf).join('')
  // <style>/<script> 的内容不是界面文字，不能混进断言
  if (node.kind === 'host' && (node.type === 'style' || node.type === 'script')) return ''
  const own = Array.isArray(node.children) ? node.children.map(textOf).join('') : ''
  return own
}

export function findAll(node, predicate, out = []) {
  if (!node) return out
  if (node.kind === 'fragment') {
    for (const child of node.children) findAll(child, predicate, out)
    return out
  }
  if (node.kind === 'host' || node.kind === 'text') {
    if (predicate(node)) out.push(node)
  }
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

export const byType = (type) => (node) => node.kind === 'host' && node.type === type

export function buttons(node, label) {
  const found = findAll(node, byType('button'))
  return label === undefined ? found : found.filter((button) => textOf(button).includes(label))
}

export function inputs(node) {
  return findAll(node, (item) => item.kind === 'host' && (item.type === 'input' || item.type === 'textarea'))
}

export function svgHasCheck(node) {
  return findAll(node, (item) => item.kind === 'host' && item.type === 'path').length > 0
}

/* --------------------------------------------------------------- 事件工具 */

/**
 * 点击一个节点。`root` 用于支持表单提交按钮：
 * 浏览器里 `type=submit` 会触发表单的 onSubmit，这里手工做同样的事。
 */
export function click(node, root) {
  if (!node || !node.props) throw new Error('该节点不可点击')
  if (typeof node.props.onClick === 'function') {
    node.props.onClick(syntheticEvent())
    return
  }
  if (node.props.type === 'submit' && node.props.form && root) {
    const form = findAll(root, (item) => item.kind === 'host' && item.type === 'form' && item.props.id === node.props.form)[0]
    if (form && typeof form.props.onSubmit === 'function') {
      form.props.onSubmit(syntheticEvent())
      return
    }
  }
  throw new Error(`该节点不可点击：${node.type} ${textOf(node)}`)
}

function syntheticEvent() {
  return {
    target: { value: '', checked: false },
    currentTarget: { value: '', checked: false },
    preventDefault() {},
    stopPropagation() {},
    nativeEvent: {},
    key: '',
  }
}

export function typeInto(node, value) {
  if (!node || !node.props) throw new Error('该节点不可输入')
  const handler = node.props.onChange || node.props.onInput
  if (typeof handler !== 'function') throw new Error('该节点没有 onChange')
  handler({ target: { value }, currentTarget: { value }, preventDefault() {}, stopPropagation() {} })
}

export function toggle(node) {
  if (!node || !node.props) throw new Error('该节点不可切换')
  if (typeof node.props.onClick === 'function') {
    click(node)
    return
  }
  const handler = node.props.onChange
  if (typeof handler === 'function') {
    handler({ target: { checked: !node.props.checked }, currentTarget: { checked: !node.props.checked } })
    return
  }
  throw new Error('该节点既没有 onClick 也没有 onChange')
}
