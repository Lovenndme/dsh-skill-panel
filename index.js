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
  return JSON.parse(buffer.toString('utf8'))
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

  const addSummaries = (byName, probe, summaries) => {
    for (const summary of summaries || []) {
      if (!summary || typeof summary.name !== 'string') continue
      const source = String(summary.source ?? '?')
      const provider = String(summary.provider ?? '?')
      probe.bySource[source] = (probe.bySource[source] || 0) + 1
      probe.byProvider[provider] = (probe.byProvider[provider] || 0) + 1
      if (!byName.has(summary.name)) byName.set(summary.name, summary)
    }
  }

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
    if (!registry) return { byName: undefined, probe }
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined
    const byName = new Map()
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
            addSummaries(byName, probe, snapshot.skills)
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
        if (![...byName.values()].some((summary) => LOCAL_SOURCES.has(String(summary.source)))) {
          const snapshot = await readScope(registry, cwd, undefined, signal)
          if (!snapshot.complete) probe.complete = false
          addSummaries(byName, probe, snapshot.skills)
        }
      } else {
        const snapshot = await readScope(registry, cwd, undefined, signal)
        probe.complete = snapshot.complete
        addSummaries(byName, probe, snapshot.skills)
      }
      probe.total = byName.size
      probe.sample = [...byName.keys()].slice(0, 12)
      if (probe.complete === false) probe.verdict = 'incomplete'
      else if (![...byName.values()].some((summary) => LOCAL_SOURCES.has(String(summary.source)))) probe.verdict = 'no-local-skills'
      else probe.verdict = 'checked'
      return { byName, probe }
    } catch (error) {
      probe.verdict = 'error'
      probe.error = error instanceof Error ? error.message : String(error)
      log(`dsh-skill-panel: 读取 DSH 技能注册表失败：${probe.error}`)
      return { byName: undefined, probe }
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

  /**
   * loaded：DSH 生效的正是这一份文件；
   * other：DSH 生效的是别处的同名技能（这份没被采用）；
   * missing：DSH 没有加载这个名字（通常是 frontmatter 不被 DSH 接受）。
   */
  const dshStateOf = async (record, name, catalog) => {
    const winner = catalog.get(name)
    if (!winner) return { state: 'missing' }
    if (winner.source === record.source) {
      if (!winner.path || samePath(winner.path, record.path)) return { state: 'loaded' }
      const real = await fsp.realpath(record.path).catch(() => record.path)
      if (samePath(winner.path, real)) return { state: 'loaded' }
    }
    return { state: 'other', source: winner.source, ...(winner.path ? { path: winner.path } : {}) }
  }

  /** 给刚导入 / 新建的技能补上 DSH 加载状态（先丢掉自己的快照缓存）。 */
  const annotateWritten = async (items, source, targetRoot, cwd) => {
    invalidateDshCache()
    const { byName, probe } = await dshCatalog(cwd)
    if (probe.verdict !== 'checked') return items
    for (const item of items) {
      if (!item.ok || !item.name) continue
      item.dsh = await dshStateOf({ source, path: path.join(targetRoot, item.name, 'SKILL.md') }, item.name, byName)
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
      // 写操作成功后丢掉自己的快照缓存，面板随后的 /list 才会重新核对
      if (req.method === 'POST' && res.statusCode === 200) invalidateDshCache()
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
        const { byName, probe } = await dshCatalog(context.projectCwd)
        const checked = probe.verdict === 'checked'
        const skills = checked
          ? await Promise.all(context.collection.skills.map(async (skill) => ({ ...skill, dsh: await dshStateOf(skill, skill.name, byName) })))
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
        sendJson(res, 200, { ok: true, path: location.record.path })
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
        sendJson(res, 200, { ok: true, path: location.record.path })
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
            sendJson(res, 200, { ok: true })
            return
          }
          // 项目里的真实技能：提升为全局。
          // 内容与全局那份一致（忽略两个开关行）就走短路：恢复全局、直接删掉项目副本，不产生回收垃圾。
          const sourceDir = winner.kind === 'dir' ? path.dirname(winner.path) : winner.path
          if (globalLayer && (await sameSkillContent(winner.path, winner.kind, globalLayer.path, globalLayer.kind))) {
            await flagsOnSource(globalLayer.source, { model: true, user: true })
            await fsp.rm(sourceDir, { recursive: true, force: true })
            sendJson(res, 200, { ok: true, reused: true })
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
          sendJson(res, 200, { ok: true })
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
        sendJson(res, 200, { ok: true })
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
        const [checked] = await annotateWritten([{ ok: true, name }], scope === 'global' ? 'user-dsh' : 'project-dsh', targetRoot, context.projectCwd)
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
        sendJson(res, 200, { ok: true, trash: destination })
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
        await annotateWritten(results, scope === 'global' ? 'user-dsh' : 'project-dsh', target, context.projectCwd)
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
        await annotateWritten(results, scope === 'global' ? 'user-dsh' : 'project-dsh', target, context.projectCwd)
        sendJson(res, 200, { ok: true, results })
      }),
    }),
  )

  log('dsh-skill-panel: routes registered under ' + API)
}
