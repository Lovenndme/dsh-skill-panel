/**
 * dsh-skill-panel — 宿主半区。
 *
 * 只做两件事：把磁盘上的技能（项目层 + 全局层）读成一份可渲染的清单，以及把面板的
 * 写操作落到 SKILL.md 上。所有 UI 数据都走本包自己的 HTTP 路由，
 * 前缀 /api/dsh-skill-panel/，不注册任何模型工具。
 */
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  agentsHome,
  collectSkills,
  copySkillInto,
  createSkill,
  dshHome,
  findProjectRoot,
  importFolder,
  importZip,
  isInside,
  isSameOrInside,
  locateSkill,
  MAX_DOC_BYTES,
  MAX_ZIP_BYTES,
  moveToTrash,
  removeStub,
  sameSkillContent,
  saveSkillDoc,
  setSkillFlags,
} from './lib/skills.js'

export const inject = ['webServer']

const API = '/api/dsh-skill-panel'
const JSON_LIMIT = 2 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1' || /^127\./.test(value)
}

/** 与官方 /api 同口径的 confused-deputy 防线：只接受本机同源请求。 */
function isTrusted(req) {
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (!isLoopbackHostname(parsed.hostname)) return false
    if (req.headers.host && parsed.host !== req.headers.host) return false
    return true
  } catch {
    return false
  }
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体超过大小上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buffer = await readBody(req, JSON_LIMIT)
  if (!buffer.length) return {}
  const text = buffer.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const workspacesOf = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      if (!registry || typeof registry.list !== 'function') return []
      return registry
        .list()
        .map((workspace) => ({ path: workspace.path, title: workspace.title }))
        .filter((workspace) => typeof workspace.path === 'string' && workspace.path.length > 0)
    } catch {
      return []
    }
  }

  const recentProjectCwd = async () => {
    try {
      const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
      if (!query || typeof query.listSessions !== 'function') return undefined
      const records = await query.listSessions()
      for (const record of records) {
        const cwd = record && record.header ? record.header.cwd : undefined
        if (typeof cwd === 'string' && cwd && existsSync(cwd)) return cwd
      }
    } catch {
      /* 拿不到最近会话就退回工作区列表 */
    }
    return undefined
  }

  const resolveContext = async (url) => {
    const workspaces = workspacesOf()
    const requested = url.searchParams.get('project')
    let projectCwd
    if (requested) {
      const absolute = path.resolve(requested)
      if (existsSync(absolute)) projectCwd = absolute
    }
    if (!projectCwd) projectCwd = await recentProjectCwd()
    if (!projectCwd && workspaces.length) projectCwd = workspaces[0].path
    const projectRoot = projectCwd ? findProjectRoot(projectCwd) : undefined
    return { workspaces, projectCwd, projectRoot }
  }

  const collectionOf = async (url) => {
    const context = await resolveContext(url)
    const collection = await collectSkills({
      projectRoot: context.projectRoot,
      dshHome: dshHome(),
      agentsHome: agentsHome(),
    })
    return { ...context, collection }
  }

  /* ---------------------------------------------------- 与 DSH 注册表核对 */

  /** DSH 自己的技能注册表（ctx.skills）；拿不到时面板照常工作，只是不做「DSH 是否加载」的标注。 */
  const dshRegistry = () => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
      const usable = registry && (typeof registry.snapshot === 'function' || typeof registry.list === 'function')
      return usable ? registry : undefined
    } catch {
      return undefined
    }
  }

  /** 预设注册表：拿得到时按每个 preset 的作用域读技能视图（本地技能 provider 挂在 preset 层）。 */
  const dshPresets = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      return service && typeof service.list === 'function' && typeof service.acquireScope === 'function' ? service : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 读一次注册表要按 preset 逐个取作用域快照，比较贵；
   * 面板连续打开 / 写完后紧跟一次 /list 时复用 2 秒内的结果。
   */
  let dshCache = { key: null, at: 0, value: null }
  const DSH_CACHE_MS = 2000
  const invalidateDshCache = () => {
    dshCache = { key: null, at: 0, value: null }
  }

  const LOCAL_SOURCES = new Set(['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])

  /**
   * 按名字收集「各 preset 各自的胜出者」：同名技能在不同 preset 里可能不同
   * （例如创造模式额外挂了 custom 根，rank 300 压过 user-dsh 400），不能只留第一个。
   * winners: name → summary[]，union 语义在 dshStateOf 里判断。
   */
  const addSummaries = (winners, probe, summaries) => {
    for (const summary of summaries || []) {
      if (!summary || typeof summary.name !== 'string') continue
      const source = String(summary.source ?? '?')
      const provider = String(summary.provider ?? '?')
      probe.bySource[source] = (probe.bySource[source] || 0) + 1
      probe.byProvider[provider] = (probe.byProvider[provider] || 0) + 1
      const list = winners.get(summary.name)
      if (!list) winners.set(summary.name, [summary])
      else if (!list.some((item) => item.source === summary.source && item.path === summary.path)) list.push(summary)
    }
  }

  const hasLocalWinner = (winners) => [...winners.values()].some((list) => list.some((summary) => LOCAL_SOURCES.has(String(summary.source))))

  /** 按作用域读一次注册表；snapshot 优先，只有 list 的旧实现也能用。 */
  const readScope = async (registry, cwd, scope, signal) => {
    const options = { signal }
    if (cwd) options.cwd = cwd
    if (scope) options.scope = scope
    if (typeof registry.snapshot === 'function') {
      const snapshot = await registry.snapshot(options)
      return {
        complete: snapshot ? snapshot.complete !== false : true,
        skills: snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : [],
      }
    }
    const summaries = typeof registry.list === 'function' ? await registry.list(options) : []
    return { complete: true, skills: Array.isArray(summaries) ? summaries : [] }
  }

  /**
   * 读 DSH 注册表，并给出「能否据此逐行标注」的结论 probe.verdict：
   *   checked          —— 结果完整且看得到本地技能，可以逐行标注；
   *   incomplete       —— 注册表自己报告结果不完整（某个提供方失败等）；
   *   no-local-skills  —— 结果里一个本地技能都没有：更可能是面板拿到的注册表视图不对，而不是每个文件都坏了；
   *   unavailable / error —— 拿不到注册表或读取出错。
   * 只有 checked 才标注：宁可不标，也不误报。probe 原样随 /list 返回，便于排查。
   *
   * 关键点（0.2.x 兼容）：`@deepseek-ai/dsh-skill-filesystem` 是挂在每个 agent preset 的
   * plugins 里的，provider 注册在 preset 作用域那一层。不带 scope 的 snapshot 只看得到
   * 全局层（bundled 技能），本地技能一个都看不到。所以这里对每个 preset 用
   * `agentPresets.acquireScope(id)` 取作用域，再 `skills.snapshot({ cwd, scope })`，用完
   * 必须在 finally 里 dispose 租约。命中语义取「任一 preset 能看到就算会被加载」。
   */
  const dshCatalogUncached = async (cwd) => {
    const probe = {
      verdict: 'unavailable',
      cwd: cwd || null,
      method: 'snapshot',
      scope: 'global',
      total: 0,
      bySource: {},
      byProvider: {},
      sample: [],
      presets: [],
    }
    const registry = dshRegistry()
    if (!registry) return { winners: undefined, probe }
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined
    const winners = new Map()
    try {
      const presetsService = dshPresets()
      if (presetsService) {
        probe.method = 'snapshot-scoped'
        probe.scope = 'preset-union'
        let presets = []
        try {
          presets = await presetsService.list()
        } catch (error) {
          probe.presetsError = error instanceof Error ? error.message : String(error)
        }
        for (const preset of Array.isArray(presets) ? presets : []) {
          const id = preset && preset.id ? String(preset.id) : ''
          if (!id) continue
          if (preset.broken) {
            probe.presets.push({ id, skipped: 'broken' })
            continue
          }
          let lease
          try {
            lease = await presetsService.acquireScope(id)
            const snapshot = await readScope(registry, cwd, lease.key, signal)
            const localCount = snapshot.skills.filter((item) => LOCAL_SOURCES.has(String(item && item.source))).length
            probe.presets.push({
              id,
              total: snapshot.skills.length,
              local: localCount,
              complete: snapshot.complete,
            })
            if (!snapshot.complete) probe.complete = false
            addSummaries(winners, probe, snapshot.skills)
          } catch (error) {
            probe.presets.push({ id, error: error instanceof Error ? error.message : String(error) })
          } finally {
            if (lease && typeof lease[Symbol.asyncDispose] === 'function') {
              try {
                await lease[Symbol.asyncDispose]()
              } catch {
                /* 租约释放失败不影响这次读取结果 */
              }
            }
          }
        }
        // 预设层一个本地技能都没有时，再退回全局层确认，避免把「作用域没挂上」误判成「技能都没加载」
        if (!hasLocalWinner(winners)) {
          const snapshot = await readScope(registry, cwd, undefined, signal)
          if (!snapshot.complete) probe.complete = false
          addSummaries(winners, probe, snapshot.skills)
        }
      } else {
        const snapshot = await readScope(registry, cwd, undefined, signal)
        probe.complete = snapshot.complete
        addSummaries(winners, probe, snapshot.skills)
      }
      probe.total = winners.size
      probe.sample = [...winners.keys()].slice(0, 12)
      if (probe.complete === false) probe.verdict = 'incomplete'
      else if (!hasLocalWinner(winners)) probe.verdict = 'no-local-skills'
      else probe.verdict = 'checked'
      return { winners, probe }
    } catch (error) {
      probe.verdict = 'error'
      probe.error = error instanceof Error ? error.message : String(error)
      log(`dsh-skill-panel: 读取 DSH 技能注册表失败：${probe.error}`)
      return { winners: undefined, probe }
    }
  }

  const dshCatalog = async (cwd) => {
    const key = cwd || ''
    const now = Date.now()
    if (dshCache.key === key && dshCache.value && now - dshCache.at < DSH_CACHE_MS) return dshCache.value
    const value = await dshCatalogUncached(key)
    dshCache = { key, at: Date.now(), value }
    return value
  }

  const samePath = (left, right) => {
    if (!left || !right) return false
    const a = path.resolve(left)
    const b = path.resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  /** DSH 的某个胜出者是不是正好指向这一份文件（同一来源、同一路径，路径按 realpath 兜底比较）。 */
  const pointsAt = async (winner, record, realOf) => {
    if (winner.source !== record.source) return false
    if (!winner.path || samePath(winner.path, record.path)) return true
    return samePath(winner.path, await realOf())
  }

  /**
   * union 语义——任一 preset 里生效的正是这一份，就算会被加载：
   * loaded：至少一个 preset 的胜出者就是这一份文件；
   * other：DSH 有同名技能，但没有任何 preset 采用这一份；
   * missing：没有任何 preset 加载这个名字（通常是 frontmatter 不被 DSH 接受）。
   */
  const dshStateOf = async (record, name, winners) => {
    const list = winners.get(name) || []
    if (!list.length) return { state: 'missing' }
    let real
    const realOf = async () => {
      if (real === undefined) real = await fsp.realpath(record.path).catch(() => record.path)
      return real
    }
    for (const winner of list) if (await pointsAt(winner, record, realOf)) return { state: 'loaded' }
    const other = list.find((item) => LOCAL_SOURCES.has(String(item.source))) || list[0]
    return { state: 'other', source: other.source, ...(other.path ? { path: other.path } : {}) }
  }

  /* ---------------------------------------------- 写操作后等 DSH 追上磁盘 */

  const DSH_SETTLE_MS = 1500
  const DSH_SETTLE_STEP_MS = 150
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * DSH 这一轮的视图是否已经反映出磁盘上的这一份：
   * - 磁盘上有这份（expected 为面板扫描到的胜出记录）：某个 preset 的胜出者正是它，且两个开关一致；
   * - 磁盘上没有了（删除，或文件已无效）：DSH 也不该再有本地来源的同名胜出者。
   */
  const reflects = async (list, expected) => {
    if (!expected) return !list.some((item) => LOCAL_SOURCES.has(String(item.source)))
    let real
    const realOf = async () => {
      if (real === undefined) real = await fsp.realpath(expected.path).catch(() => expected.path)
      return real
    }
    for (const winner of list) {
      if (!(await pointsAt(winner, expected, realOf))) continue
      const invocation = winner.invocation
      if (!invocation) return true
      if (invocation.modelInvocable === expected.modelInvocable && invocation.userInvocable === expected.userInvocable) return true
    }
    return false
  }

  /**
   * 写操作之后、返回之前，等 DSH 注册表追上磁盘。
   * DSH 靠目录监听让注册表缓存失效（chokidar 约 200ms 稳定期，目录原本不存在时还要轮询祖先目录），
   * 写完马上 /list 会读到写之前的视图——典型症状是「刚切到本项目就显示未生效」，手动刷新才恢复。
   * DSH 没有公开的刷新接口，所以这里以面板自己扫描磁盘的结果为期望值，每 DSH_SETTLE_STEP_MS 读一次，
   * 最多等 DSH_SETTLE_MS；追上就立即返回，并把这次结果放进面板缓存，紧接着的 /list 直接复用。
   * 只有文件本身被 DSH 拒绝时才会等满（随后如实标出「DSH 未加载」）。
   */
  const settleDsh = async (context, names) => {
    invalidateDshCache()
    const cwd = context.projectCwd || ''
    const wanted = [...new Set((names || []).filter((name) => typeof name === 'string' && name))]
    if (!wanted.length || !dshRegistry()) return dshCatalog(cwd)
    const collection = await collectSkills({ projectRoot: context.projectRoot, dshHome: dshHome(), agentsHome: agentsHome() })
    const expected = wanted.map((name) => ({ name, record: collection.skills.find((skill) => skill.name === name) || null }))
    const started = Date.now()
    let rounds = 0
    let settled = false
    let result
    for (;;) {
      result = await dshCatalogUncached(cwd)
      rounds += 1
      if (result.probe.verdict !== 'checked') break
      settled = true
      for (const { name, record } of expected) {
        if (!(await reflects(result.winners.get(name) || [], record))) {
          settled = false
          break
        }
      }
      if (settled || Date.now() - started + DSH_SETTLE_STEP_MS > DSH_SETTLE_MS) break
      await sleep(DSH_SETTLE_STEP_MS)
    }
    result.probe.settle = { names: wanted, rounds, settled, waitedMs: Date.now() - started }
    dshCache = { key: cwd, at: Date.now(), value: result }
    return result
  }

  /** 写操作统一出口：等 DSH 追上再回 200，并标记已刷新（guard 不必再清缓存）。 */
  const finishWrite = async (res, context, names, payload) => {
    await settleDsh(context, names)
    res.dshSettled = true
    sendJson(res, 200, payload)
  }

  /** 给刚导入 / 新建的技能补上 DSH 加载状态（先等 DSH 追上磁盘）。 */
  const annotateWritten = async (items, source, targetRoot, context, res) => {
    const names = items.filter((item) => item.ok && item.name).map((item) => item.name)
    const { winners, probe } = await settleDsh(context, names)
    if (res) res.dshSettled = true
    if (probe.verdict !== 'checked') return items
    for (const item of items) {
      if (!item.ok || !item.name) continue
      item.dsh = await dshStateOf({ source, path: path.join(targetRoot, item.name, 'SKILL.md') }, item.name, winners)
    }
    return items
  }

  const requireProjectRoot = (context) => {
    if (!context.projectRoot) throw new Error('没有可用的项目目录：先在左侧工作区里打开一个项目')
    return context.projectRoot
  }

  const targetRootFor = (scope, context) => {
    if (scope === 'global') return path.join(dshHome(), 'skills')
    return path.join(requireProjectRoot(context), '.dsh', 'skills')
  }

  /**
   * 路由鉴权：优先交给 DSH 自己的 Connection 信任围栏
   * （Host/Origin 检查 + 浏览器登录凭据），没有 connection 服务时退回本机的 loopback 判断。
   */
  const connectionService = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      return service && typeof service.requestRejection === 'function' ? service : undefined
    } catch {
      return undefined
    }
  }

  const guard = (handler) => async (req, res) => {
    try {
      const connection = connectionService()
      if (connection) {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection) {
          sendJson(res, rejection, { ok: false, errors: [rejection === 401 ? '需要登录的 Web UI 会话' : '请求来源不受信任'] })
          return
        }
      } else if (!isTrusted(req)) {
        sendJson(res, 403, { ok: false, errors: ['请求来源不受信任'] })
        return
      }
      await handler(req, res)
      // 写操作成功后，面板随后的 /list 必须是新视图：走过 settleDsh 的已经放好新结果，其余一律清缓存
      if (req.method === 'POST' && res.statusCode === 200 && !res.dshSettled) invalidateDshCache()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, errors: [message] })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/list`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const context = await collectionOf(url)
        const { winners, probe } = await dshCatalog(context.projectCwd)
        const checked = probe.verdict === 'checked'
        const skills = checked
          ? await Promise.all(context.collection.skills.map(async (skill) => ({ ...skill, dsh: await dshStateOf(skill, skill.name, winners) })))
          : context.collection.skills
        sendJson(res, 200, {
          ok: true,
          dshHome: dshHome(),
          agentsHome: agentsHome(),
          projectCwd: context.projectCwd,
          projectRoot: context.projectRoot,
          workspaces: context.workspaces,
          roots: context.collection.roots,
          dshChecked: checked,
          dshProbe: probe,
          skills,
          diagnostics: context.collection.diagnostics,
        })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/doc`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, errors: ['只接受 GET'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const name = url.searchParams.get('name') || ''
        const source = url.searchParams.get('source') || ''
        const context = await collectionOf(url)
        const collection = context.collection
        const location = await locateSkill(collection, name, source)
        const buffer = await fsp.readFile(location.record.path)
        if (buffer.length > MAX_DOC_BYTES) throw new Error('文件超过 1MB 上限')
        sendJson(res, 200, {
          ok: true,
          name,
          source,
          path: location.record.path,
          size: buffer.length,
          content: buffer.toString('utf8'),
        })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/save`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const location = await locateSkill(context.collection, String(body.name || ''), String(body.source || ''))
        await saveSkillDoc(location, body.content ?? '')
        await finishWrite(res, context, [location.skill.name], { ok: true, path: location.record.path })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/flags`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const location = await locateSkill(context.collection, String(body.name || ''), String(body.source || ''))
        await setSkillFlags(location, {
          model: typeof body.model === 'boolean' ? body.model : undefined,
          user: typeof body.user === 'boolean' ? body.user : undefined,
        })
        await finishWrite(res, context, [location.skill.name], { ok: true, path: location.record.path })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/scope`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const projectRoot = requireProjectRoot(context)
        const collection = context.collection
        const name = String(body.name || '')
        const desired = body.scope === 'global' ? 'global' : 'project'
        const winner = collection.skills.find((skill) => skill.name === name)
        if (!winner) throw new Error(`找不到技能：${name}`)
        const globalLayer =
          winner.scope === 'global' && !winner.stub ? winner : (winner.shadowed || []).find((item) => item.scope === 'global') || null

        const flagsOnSource = async (source, flags) => {
          const location = await locateSkill(collection, name, source)
          await setSkillFlags(location, flags)
        }

        if (desired === 'global') {
          // 已经住在全局层：什么都不用做
          if (winner.scope === 'global' && !winner.stub) {
            sendJson(res, 200, { ok: true, noop: true })
            return
          }
          // 旧的「本项目禁用占位」：恢复全局那份即可
          if (winner.stub) {
            if (!globalLayer) throw new Error('找不到同名全局技能')
            await flagsOnSource(globalLayer.source, { model: true, user: true })
            await removeStub(projectRoot, name)
            await finishWrite(res, context, [name], { ok: true })
            return
          }
          // 项目里的真实技能：提升为全局。
          // 内容与全局那份一致（忽略两个开关行）就走短路：恢复全局、直接删掉项目副本，不产生回收垃圾。
          const sourceDir = winner.kind === 'dir' ? path.dirname(winner.path) : winner.path
          if (globalLayer && (await sameSkillContent(winner.path, winner.kind, globalLayer.path, globalLayer.kind))) {
            await flagsOnSource(globalLayer.source, { model: true, user: true })
            await fsp.rm(sourceDir, { recursive: true, force: true })
            await finishWrite(res, context, [name], { ok: true, reused: true })
            return
          }
          const globalRoot = path.join(dshHome(), 'skills')
          const globalTarget = path.join(globalRoot, name)
          // 旧全局那份可能是目录技能（<name>/SKILL.md）或平铺技能（<name>.md），按文件名判断，不依赖 kind 字段。
          const oldGlobalDir = globalLayer
            ? path.basename(globalLayer.path).toLowerCase() === 'skill.md'
              ? path.dirname(globalLayer.path)
              : globalLayer.path
            : undefined
          if (oldGlobalDir) await moveToTrash(oldGlobalDir, `${name}-global-old`)
          if (existsSync(globalTarget)) await moveToTrash(globalTarget, `${name}-global-old`)
          await copySkillInto(globalRoot, name, { sourcePath: winner.path, sourceKind: winner.kind, enable: true })
          await moveToTrash(sourceDir, name)
          await finishWrite(res, context, [name], { ok: true })
          return
        }

        // 目标 = 本项目
        if (winner.scope === 'project' && !winner.stub) {
          sendJson(res, 200, { ok: true, noop: true })
          return
        }
        if (!globalLayer) throw new Error('找不到同名全局技能')
        const projectSkillsRoot = path.join(projectRoot, '.dsh', 'skills')
        const projectTarget = path.join(projectSkillsRoot, name)
        if (winner.stub || existsSync(projectTarget)) {
          if (winner.stub) await removeStub(projectRoot, name)
          else throw new Error('本项目已有同名技能目录')
        }
        await copySkillInto(projectSkillsRoot, name, { sourcePath: globalLayer.path, sourceKind: globalLayer.kind, enable: true })
        await flagsOnSource(globalLayer.source, { model: false, user: false })
        await finishWrite(res, context, [name], { ok: true })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/create`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const scope = body.scope === 'global' ? 'global' : 'project'
        const targetRoot = targetRootFor(scope, context)
        const name = String(body.name || '')
        const file = await createSkill(targetRoot, {
          name,
          description: String(body.description || ''),
        })
        const [checked] = await annotateWritten([{ ok: true, name }], scope === 'global' ? 'user-dsh' : 'project-dsh', targetRoot, context, res)
        sendJson(res, 200, { ok: true, path: file, ...(checked.dsh ? { dsh: checked.dsh } : {}) })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/delete`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const collection = context.collection
        const location = await locateSkill(collection, String(body.name || ''), String(body.source || ''))
        const target = location.record.kind === 'dir' ? path.dirname(location.record.path) : location.record.path
        const allowed = collection.roots.some((root) => isInside(root.root, target))
        if (!allowed) throw new Error('目标不在任何技能根目录里，已拒绝删除')
        const destination = await moveToTrash(target, location.skill.name)
        await finishWrite(res, context, [location.skill.name], { ok: true, trash: destination })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/import-folder`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const body = await readJson(req)
        const context = await collectionOf(url)
        const scope = body.scope === 'global' ? 'global' : 'project'
        const target = targetRootFor(scope, context)
        const source = path.resolve(String(body.sourcePath || ''))
        if (isSameOrInside(source, target) || isSameOrInside(target, source)) {
          throw new Error('导入来源与目标技能目录重叠，已拒绝')
        }
        const results = await importFolder(target, source)
        await annotateWritten(results, scope === 'global' ? 'user-dsh' : 'project-dsh', target, context, res)
        sendJson(res, 200, { ok: true, results })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API}/import-zip`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, errors: ['只接受 POST'] })
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const context = await collectionOf(url)
        const scope = url.searchParams.get('scope') === 'global' ? 'global' : 'project'
        const payload = await readBody(req, MAX_ZIP_BYTES)
        const target = targetRootFor(scope, context)
        const results = await importZip(target, payload, {
          name: url.searchParams.get('name') || undefined,
        })
        await annotateWritten(results, scope === 'global' ? 'user-dsh' : 'project-dsh', target, context, res)
        sendJson(res, 200, { ok: true, results })
      }),
    }),
  )

  log('dsh-skill-panel: routes registered under ' + API)
}
