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

  const requireProjectRoot = (context) => {
    if (!context.projectRoot) throw new Error('没有可用的项目目录：先在左侧工作区里打开一个项目')
    return context.projectRoot
  }

  const targetRootFor = (scope, context) => {
    if (scope === 'global') return path.join(dshHome(), 'skills')
    return path.join(requireProjectRoot(context), '.dsh', 'skills')
  }

  const guard = (handler) => async (req, res) => {
    try {
      if (!isTrusted(req)) {
        sendJson(res, 403, { ok: false, errors: ['请求来源不受信任'] })
        return
      }
      await handler(req, res)
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
        sendJson(res, 200, {
          ok: true,
          dshHome: dshHome(),
          agentsHome: agentsHome(),
          projectCwd: context.projectCwd,
          projectRoot: context.projectRoot,
          workspaces: context.workspaces,
          roots: context.collection.roots,
          skills: context.collection.skills,
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
        const file = await createSkill(targetRootFor(scope, context), {
          name: String(body.name || ''),
          description: String(body.description || ''),
        })
        sendJson(res, 200, { ok: true, path: file })
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
        const results = await importZip(targetRootFor(scope, context), payload, {
          name: url.searchParams.get('name') || undefined,
        })
        sendJson(res, 200, { ok: true, results })
      }),
    }),
  )

  log('dsh-skill-panel: routes registered under ' + API)
}
