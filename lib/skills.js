/**
 * dsh-skill-panel — 宿主半区的技能库实现。
 *
 * 所有函数都是模块级的，不依赖 Cordis 运行时，可以直接用 node 单测。
 * 契约与 @deepseek-ai/dsh-skill-filesystem 对齐：
 *   - 技能 = `<root>/<name>/SKILL.md` 目录形式，或 `<root>/<name>.md` 平铺文件；
 *   - root 只扫一层，跳过以 `.` 开头的条目；
 *   - frontmatter 必填 name（kebab-case）与 description；
 *   - `disable-model-invocation` / `user-invocable` 是官方唯一的关闭开关。
 */
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const STUB_MARKER = 'dsh-skill-panel: project-disable'
export const STUB_DESCRIPTION = '本项目禁用占位（由技能面板创建）'
export const MAX_DOC_BYTES = 1024 * 1024
export const MAX_ZIP_BYTES = 32 * 1024 * 1024
export const MAX_UNZIP_BYTES = 64 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 2000

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/* ------------------------------------------------------------------ 基础工具 */

export function isKebabName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 相等或包含关系（含自身），用于挡住"导入到自身"的递归复制。 */
export function isSameOrInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

export function agentsHome() {
  return process.env.DSH_AGENTS_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.agents')
}

export function trashDir() {
  return path.join(dshHome(), 'skill-panel-trash')
}

/** 与 dsh-skill-filesystem 同口径：最近的含 `.git` 的祖先目录，没有就用起点本身。 */
export function findProjectRoot(start) {
  const origin = path.resolve(start)
  let current = origin
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return origin
    current = parent
  }
}

/* -------------------------------------------------------------- frontmatter */

function unquote(raw) {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return value
}

/** 只解析顶层 `key: value`（含 `|` / `>` 块标量），嵌套结构与注释不解释。 */
export function parseFrontmatterFields(text) {
  const fields = {}
  const lines = String(text).split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line || /^\s/.test(line) || line.trim().startsWith('#')) {
      index += 1
      continue
    }
    const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (!match) {
      index += 1
      continue
    }
    const key = match[1]
    const rest = match[2].trim()
    if (/^[|>][+-]?$/.test(rest)) {
      const collected = []
      index += 1
      while (index < lines.length) {
        const next = lines[index]
        if (next.trim() === '') {
          collected.push('')
          index += 1
          continue
        }
        if (!/^\s/.test(next)) break
        collected.push(next.replace(/^\s+/, ''))
        index += 1
      }
      fields[key] = collected.join(rest.startsWith('|') ? '\n' : ' ').trim()
      continue
    }
    fields[key] = unquote(rest)
    index += 1
  }
  return fields
}

/** undefined 表示"没写"或"写法不合法"，由调用方区分。 */
export function parseBoolean(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (TRUE_WORDS.has(normalized)) return true
  if (FALSE_WORDS.has(normalized)) return false
  return undefined
}

export function parseSkillDoc(input) {
  const raw = String(input).replace(/^\uFEFF/, '')
  // 允许 `---` 紧跟 `---` 的空 frontmatter（DSH 侧等价于「缺 name」，不该报成「未闭合」）
  const emptyMatch = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (emptyMatch) {
    return { ok: true, raw, frontmatter: '', body: raw.slice(emptyMatch[0].length), fields: {} }
  }
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!match) return { ok: false, reason: '缺少或未闭合的 YAML frontmatter' }
  return {
    ok: true,
    raw,
    frontmatter: match[1],
    body: raw.slice(match[0].length),
    fields: parseFrontmatterFields(match[1]),
  }
}

/**
 * 逐行扫描 frontmatter，标出每一行属于哪一类：
 *   'open'      首行的 `---`
 *   'close'     顶层的结束 `---`
 *   'key'       顶层键
 *   'block'     块标量的续行（`|` / `>` 之后所有缩进行）
 *   'other'     缩进续行、注释、空行等
 * `---` 出现在块标量内部时绝不能当成结束分隔符——否则会把标记写进正文标量里。
 */
function classifyFrontmatterLines(lines) {
  const kinds = new Array(lines.length).fill('other')
  if ((lines[0] ?? '').trim() === '---') kinds[0] = 'open'
  let blockIndent = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    const indented = /^[ \t]/.test(line)
    const trimmed = line.trim()
    if (blockIndent >= 0) {
      if (trimmed === '') continue
      const indent = line.length - line.trimStart().length
      if (indented && indent > blockIndent) {
        kinds[index] = 'block'
        continue
      }
      blockIndent = -1
    }
    if (trimmed === '---') {
      kinds[index] = 'close'
      break
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (indented) continue
    const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (!match) continue
    kinds[index] = 'key'
    const rest = match[2].trim()
    if (/^[|>][+-]?$/.test(rest)) blockIndent = 0
  }
  return kinds
}

/**
 * 只改一条 frontmatter 键，不动正文、不动别的键、不碰块标量内部。
 * 键存在就替换成布尔字面量，不存在就插在结束分隔符之前。
 */
export function setFrontmatterFlag(text, key, enabled) {
  const hasBom = String(text).startsWith('\uFEFF')
  const source = hasBom ? String(text).slice(1) : String(text)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') throw new Error('缺少 YAML frontmatter')
  const kinds = classifyFrontmatterLines(lines)
  const close = kinds.indexOf('close')
  if (close < 0) throw new Error('frontmatter 未闭合')
  const literal = enabled ? 'true' : 'false'
  let target = -1
  for (let index = 1; index < close; index += 1) {
    if (kinds[index] !== 'key') continue
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(lines[index])
    if (match && match[1] === key) {
      target = index
      break
    }
  }
  if (target >= 0) lines[target] = `${key}: ${literal}`
  else lines.splice(close, 0, `${key}: ${literal}`)
  return (hasBom ? '\uFEFF' : '') + lines.join(eol)
}

/* ------------------------------------------------------------------- 扫描 */

export function rootsOf({ projectRoot, dshHome: home = dshHome(), agentsHome: agents = agentsHome() }) {
  const roots = []
  if (projectRoot) {
    roots.push({ source: 'project-dsh', scope: 'project', rank: 100, root: path.join(projectRoot, '.dsh', 'skills') })
    roots.push({ source: 'project-agents', scope: 'project', rank: 200, root: path.join(projectRoot, '.agents', 'skills') })
  }
  roots.push({ source: 'user-dsh', scope: 'global', rank: 400, root: path.join(home, 'skills') })
  roots.push({ source: 'user-agents', scope: 'global', rank: 500, root: path.join(agents, 'skills') })
  return roots
}

/**
 * 判定一个目录项实际是什么（跟随符号链接 / junction）。
 * DSH 的 dsh-skill-filesystem 会跟随链接（README 明确写「symlinked directories and flat
 * files」），所以这里必须用 stat 而不是 dirent 的类型，否则链接形式的技能会静默消失。
 * 返回 { kind: 'dir' | 'file' | 'other', broken?: boolean }
 */
export async function resolveEntryKind(dirent, fullPath) {
  if (dirent.isSymbolicLink()) {
    try {
      const info = await fsp.stat(fullPath)
      if (info.isDirectory()) return { kind: 'dir' }
      if (info.isFile()) return { kind: 'file' }
      return { kind: 'other' }
    } catch {
      return { kind: 'other', broken: true }
    }
  }
  if (dirent.isDirectory()) return { kind: 'dir' }
  if (dirent.isFile()) return { kind: 'file' }
  return { kind: 'other' }
}

/**
 * 扫描一层，返回候选记录（未经 frontmatter 校验）。
 * `problems` 收集「看得见但读不了」的条目（坏链接、同名重复），交给 /list 的 diagnostics。
 */
export async function scanRoot(rootInfo, problems = []) {
  let entries
  try {
    entries = await fsp.readdir(rootInfo.root, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  const byName = new Map()
  for (const entry of entries) {
    const name = entry.name
    if (!name || name.startsWith('.')) continue
    const full = path.join(rootInfo.root, name)
    const resolved = await resolveEntryKind(entry, full)
    if (resolved.broken) {
      problems.push({ source: rootInfo.source, path: full, reason: '符号链接指向的目标不存在' })
      continue
    }
    if (resolved.kind === 'dir') {
      const file = path.join(full, 'SKILL.md')
      if (!existsSync(file)) continue
      records.push({ path: file, dir: full, kind: 'dir' })
    } else if (resolved.kind === 'file' && name.toLowerCase().endsWith('.md')) {
      records.push({ path: full, dir: rootInfo.root, kind: 'file' })
    }
  }
  // 同一层里「目录形式」和「平铺 .md」可能撞名：先到先得，并把重复项报出来（DSH 侧同样是歧义）
  const kept = []
  for (const record of records) {
    const key = displayNameOf(record).toLowerCase()
    const previous = byName.get(key)
    if (previous) {
      problems.push({
        source: rootInfo.source,
        path: record.path,
        reason: `与 ${previous.path} 同名，可能被 DSH 忽略`,
      })
      continue
    }
    byName.set(key, record)
    kept.push(record)
  }
  return kept
}

function displayNameOf(record) {
  return record.kind === 'file' ? path.basename(record.path, path.extname(record.path)) : path.basename(path.dirname(record.path))
}

/* ------------------------------------------------------- 与 DSH 加载器对齐 */

/**
 * DSH（dsh-skill-filesystem 0.2.1-rc.5）遇到这些旧键会直接忽略整个技能，而不是只忽略这一行。
 */
const LEGACY_INVOCATION_KEYS = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

/**
 * YAML 1.2 core schema 下会被解析成非字符串的普通标量（null / 布尔 / 整数 / 浮点）。
 * DSH 要求 name、description 是非空字符串，这些写法在 DSH 里等于「缺字段」。
 * 规则已用 DSH 自带的 yaml 2.9.1 逐条核对。
 */
const YAML_NON_STRING = [
  /^(?:~|null|Null|NULL)$/,
  /^(?:true|True|TRUE|false|False|FALSE)$/,
  /^[-+]?[0-9]+$/,
  /^0o[0-7]+$/,
  /^0x[0-9a-fA-F]+$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$/,
  /^\.(?:nan|NaN|NAN)$/,
]

function topLevelEntries(frontmatter) {
  const entries = []
  for (const line of String(frontmatter).split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (match) entries.push({ key: match[1], rest: match[2].trim() })
  }
  return entries
}

/** 未加引号、非块标量时返回去掉行尾注释的原始值；否则返回 undefined。 */
function plainScalar(rest) {
  if (!rest || /^['"|>]/.test(rest)) return undefined
  return rest.replace(/\s+#.*$/, '').trim()
}

/**
 * 按 DSH 的口径检查一份 SKILL.md：返回 name / description 与全部问题。
 * 面板扫描、导入、保存都走这里，避免「面板显示正常、DSH 却忽略」。
 * YAML 语法错误（例如值里有未加引号的「: 」）这里不做完整判断，由宿主向 DSH 注册表核对兜底。
 */
export function inspectSkillDoc(doc) {
  const fields = doc.fields
  const entries = topLevelEntries(doc.frontmatter)
  const problems = []
  const seen = new Set()
  for (const { key } of entries) {
    if (seen.has(key)) problems.push(`frontmatter 里 ${key} 重复出现`)
    seen.add(key)
  }
  const rawOf = (key) => {
    const entry = entries.find((item) => item.key === key)
    return entry ? plainScalar(entry.rest) : undefined
  }
  const isNonString = (key) => {
    const raw = rawOf(key)
    return raw !== undefined && YAML_NON_STRING.some((pattern) => pattern.test(raw))
  }
  const name = oneLine(fields.name)
  const description = oneLine(fields.description)
  if (!name) problems.push('缺少 name')
  else if (!isKebabName(name)) problems.push(`name 必须是 kebab-case：${name}`)
  else if (isNonString('name')) problems.push(`name 会被 YAML 读成非字符串，请加引号：${name}`)
  if (!description) problems.push('缺少 description')
  else if (isNonString('description')) problems.push('description 会被 YAML 读成非字符串，请加引号')
  for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(fields, legacy)) problems.push(`不支持的字段 ${legacy}，请改用 ${canonical}`)
  }
  const modelRaw = fields['disable-model-invocation']
  const userRaw = fields['user-invocable']
  if (modelRaw !== undefined && parseBoolean(modelRaw) === undefined) problems.push('disable-model-invocation 不是合法布尔值')
  if (userRaw !== undefined && parseBoolean(userRaw) === undefined) problems.push('user-invocable 不是合法布尔值')
  return { name, description, problems }
}

export function summarize(record, root, doc) {
  const fields = doc.fields
  const inspected = inspectSkillDoc(doc)
  const name = inspected.name || displayNameOf(record)
  const description = inspected.description
  const modelFlag = parseBoolean(fields['disable-model-invocation'])
  const userFlag = parseBoolean(fields['user-invocable'])
  if (inspected.problems.length) return { ok: false, reason: inspected.problems.join('；'), name }
  return {
    ok: true,
    skill: {
      name,
      description,
      whenToUse: oneLine(fields.whenToUse) || undefined,
      scope: root.scope,
      source: root.source,
      rank: root.rank,
      path: record.path,
      dir: record.dir,
      kind: record.kind,
      modelInvocable: modelFlag !== true,
      userInvocable: userFlag !== false,
      stub: doc.body.includes(STUB_MARKER),
    },
  }
}

/**
 * 收集两层技能：同层内 rank 小的赢（project 先于 global），被压下的记进 shadowed。
 */
export async function collectSkills({ projectRoot, dshHome: home, agentsHome: agents } = {}) {
  const roots = rootsOf({ projectRoot, dshHome: home, agentsHome: agents })
  const diagnostics = []
  const byName = new Map()
  for (const root of roots) {
    let records = []
    try {
      records = await scanRoot(root, diagnostics)
    } catch (error) {
      diagnostics.push({ source: root.source, path: root.root, reason: `目录读取失败：${error?.message ?? error}` })
      continue
    }
    for (const record of records) {
      let text
      try {
        text = await fsp.readFile(record.path, 'utf8')
      } catch (error) {
        diagnostics.push({ source: root.source, path: record.path, reason: `文件读取失败：${error?.message ?? error}` })
        continue
      }
      const doc = parseSkillDoc(text)
      if (!doc.ok) {
        diagnostics.push({ source: root.source, path: record.path, reason: doc.reason })
        continue
      }
      const result = summarize(record, root, doc)
      if (!result.ok) {
        diagnostics.push({ source: root.source, path: record.path, reason: result.reason })
        continue
      }
      const existing = byName.get(result.skill.name)
      if (!existing) {
        byName.set(result.skill.name, { ...result.skill, shadowed: [] })
      } else if (existing.source === result.skill.source) {
        // 同一来源里两个不同文件写了同一个 name：谁生效取决于扫描顺序，报出来而不是静默吞掉
        diagnostics.push({
          source: root.source,
          path: record.path,
          reason: `与 ${existing.path} 的 name 重复（${result.skill.name}）`,
        })
      } else {
        existing.shadowed.push({
          source: result.skill.source,
          scope: result.skill.scope,
          path: result.skill.path,
          dir: result.skill.dir,
          kind: result.skill.kind,
          description: result.skill.description,
          modelInvocable: result.skill.modelInvocable,
          userInvocable: result.skill.userInvocable,
          stub: result.skill.stub,
        })
      }
    }
  }
  const skills = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
  return { roots, skills, diagnostics }
}

/** 在指定 root 里按 name 精确定位（不参与 rank 去重）。 */
export async function locateSkill(collection, name, source) {
  const root = collection.roots.find((item) => item.source === source)
  if (!root) throw new Error(`未知的技能来源：${source}`)
  if (!isKebabName(name)) throw new Error('技能名必须是 kebab-case')
  for (const record of await scanRoot(root)) {
    let text
    try {
      text = await fsp.readFile(record.path, 'utf8')
    } catch {
      continue
    }
    const doc = parseSkillDoc(text)
    if (!doc.ok) continue
    const result = summarize(record, root, doc)
    if (result.ok && result.skill.name === name) return { record, root, skill: result.skill }
  }
  throw new Error(`在 ${source} 里找不到技能：${name}`)
}

/* ------------------------------------------------------------------- 写入 */

/**
 * Windows 上 rename / cp 会因为目标或父目录正被占用（杀毒、索引、另一个写入者）
 * 瞬时返回 EPERM/EBUSY/EACCES。这类错误重试即可，不该让它冒到界面上。
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

async function withRetry(task, attempts = 6) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!error || !TRANSIENT_FS_CODES.has(error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  throw lastError
}

/** 复制目录时把符号链接/junction 实体化，否则无开发者模式的环境会直接 EPERM。 */
const COPY_OPTIONS = { recursive: true, force: false, errorOnExist: true, dereference: true }

/** 同一文件的「读-改-写」串行化，避免并发 /flags 互相覆盖。 */
const fileQueues = new Map()

function withFileLock(file, task) {
  const key = path.resolve(file)
  const previous = fileQueues.get(key) || Promise.resolve()
  const next = previous.then(task, task)
  // 队列自己吞掉结果/异常，避免一次失败让后续写永久 reject
  fileQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  next
    .finally(() => {
      if (fileQueues.get(key) === undefined) fileQueues.delete(key)
    })
    .catch(() => {})
  return next
}

export async function writeTextAtomic(file, text) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmp = `${file}.dsp-tmp-${unique}`
  await fsp.writeFile(tmp, text, 'utf8')
  try {
    await withRetry(() => fsp.rename(tmp, file))
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }
}

export async function setSkillFlags(location, flags) {
  return withFileLock(location.record.path, async () => {
    const current = await fsp.readFile(location.record.path, 'utf8')
    let next = current
    if (typeof flags.model === 'boolean') next = setFrontmatterFlag(next, 'disable-model-invocation', !flags.model)
    if (typeof flags.user === 'boolean') next = setFrontmatterFlag(next, 'user-invocable', flags.user)
    const doc = parseSkillDoc(next)
    if (!doc.ok) throw new Error(doc.reason)
    if (next !== current) await writeTextAtomic(location.record.path, next)
    return next
  })
}

export async function saveSkillDoc(location, content) {
  return withFileLock(location.record.path, async () => {
    const text = String(content)
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES) throw new Error('文件超过 1MB 上限')
    const doc = parseSkillDoc(text)
    if (!doc.ok) throw new Error(doc.reason)
    const result = summarize(location.record, location.root, doc)
    if (!result.ok) throw new Error(result.reason)
    if (result.skill.name !== location.skill.name) throw new Error('frontmatter 里的 name 不能改成另一个技能')
    await writeTextAtomic(location.record.path, text)
    return text
  })
}

function quotedDescription(description) {
  return `'${oneLine(description).replace(/'/g, "''")}'`
}

export function skillTemplate(name, description) {
  return `---\nname: ${name}\ndescription: ${quotedDescription(description)}\n---\n\n`
}

export async function createSkill(rootDir, { name, description }) {
  if (!isKebabName(name)) throw new Error('技能名必须是 kebab-case（小写字母、数字、连字符）')
  const summary = oneLine(description)
  if (!summary) throw new Error('description 不能为空')
  const dir = path.join(rootDir, name)
  const file = path.join(dir, 'SKILL.md')
  if (existsSync(file)) throw new Error(`技能已存在：${name}`)
  // 同一层里已有一个平铺 `<name>.md` 时，再建目录会在同一个 root 里造出同名歧义
  if (existsSync(path.join(rootDir, `${name}.md`))) throw new Error(`同一目录里已有平铺文件 ${name}.md`)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(file, skillTemplate(name, summary), 'utf8')
  return file
}

function stubTemplate(name) {
  return [
    '---',
    `name: ${name}`,
    `description: ${quotedDescription(STUB_DESCRIPTION)}`,
    'disable-model-invocation: true',
    'user-invocable: false',
    '---',
    '',
    `<!-- ${STUB_MARKER} ${name}（删掉本目录即恢复全局技能） -->`,
    '',
  ].join('\n')
}

export async function createStub(projectRoot, name) {
  if (!isKebabName(name)) throw new Error('技能名必须是 kebab-case')
  const dir = path.join(projectRoot, '.dsh', 'skills', name)
  if (existsSync(dir)) throw new Error(`本项目已存在同名技能目录：${name}`)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), stubTemplate(name), 'utf8')
  return path.join(dir, 'SKILL.md')
}

export async function removeStub(projectRoot, name) {
  const dir = path.join(projectRoot, '.dsh', 'skills', name)
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) throw new Error(`本项目没有禁用占位：${name}`)
  const doc = parseSkillDoc(await fsp.readFile(file, 'utf8'))
  if (!doc.ok || !doc.body.includes(STUB_MARKER)) throw new Error('该目录不是本插件创建的禁用占位，已跳过删除')
  await fsp.rm(dir, { recursive: true, force: true })
}

/**
 * 把一份技能复制成目标根下的目录形式技能：`<targetRoot>/<name>/SKILL.md`。
 * `enable: true` 时把副本 frontmatter 里的两个关闭开关显式打开，让它一落地就可用。
 */
export async function copySkillInto(targetRoot, name, options) {
  const sourcePath = path.resolve(options.sourcePath)
  const target = path.join(targetRoot, name)
  if (isSameOrInside(path.dirname(sourcePath), target) || isSameOrInside(target, path.dirname(sourcePath))) {
    throw new Error('来源与目标重叠，已拒绝复制')
  }
  if (existsSync(target)) throw new Error(`目标里已有同名技能：${name}`)
  await fsp.mkdir(targetRoot, { recursive: true })
  try {
    if (options.sourceKind === 'dir') {
      await withRetry(() => fsp.cp(path.dirname(sourcePath), target, COPY_OPTIONS))
    } else {
      await fsp.mkdir(target, { recursive: true })
      await fsp.writeFile(path.join(target, 'SKILL.md'), await fsp.readFile(sourcePath, 'utf8'), 'utf8')
    }
    if (options.enable) {
      const file = path.join(target, 'SKILL.md')
      let text = await fsp.readFile(file, 'utf8')
      text = setFrontmatterFlag(text, 'disable-model-invocation', false)
      text = setFrontmatterFlag(text, 'user-invocable', true)
      await writeTextAtomic(file, text)
    }
  } catch (error) {
    // 半成品副本会以同名技能出现在列表里，比失败本身更糟：失败就清掉
    await fsp.rm(target, { recursive: true, force: true })
    throw error
  }
  return target
}

function flagsFreeText(text) {
  const doc = parseSkillDoc(text)
  if (!doc.ok) return String(text).replace(/\r\n/g, '\n')
  const frontmatter = doc.frontmatter
    .split(/\r?\n/)
    .filter((line) => !/^\s*(disable-model-invocation|user-invocable)\s*:/.test(line))
    .join('\n')
  return `${frontmatter}\n---\n${doc.body.replace(/\r\n/g, '\n')}`
}

async function listFilesRelative(dir, base = dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFilesRelative(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out.sort()
}

const MAX_COMPARE_BYTES = 4 * 1024 * 1024

/**
 * 判断两份技能是不是"同一份内容"：文件树一致，SKILL.md 忽略两个开关行。
 * 用来避免「本项目 → 全局」往返时凭空产生回收副本。
 */
export async function sameSkillContent(aPath, aKind, bPath, bKind) {
  if (aKind !== bKind) return false
  try {
    if (aKind === 'file') {
      const [textA, textB] = [await fsp.readFile(aPath, 'utf8'), await fsp.readFile(bPath, 'utf8')]
      return flagsFreeText(textA) === flagsFreeText(textB)
    }
    const dirA = path.dirname(aPath)
    const dirB = path.dirname(bPath)
    const filesA = await listFilesRelative(dirA)
    const filesB = await listFilesRelative(dirB)
    if (filesA.join('|') !== filesB.join('|')) return false
    for (const rel of filesA) {
      const [pathA, pathB] = [path.join(dirA, rel), path.join(dirB, rel)]
      const [statA, statB] = [await fsp.stat(pathA), await fsp.stat(pathB)]
      if (statA.size > MAX_COMPARE_BYTES || statB.size > MAX_COMPARE_BYTES) return false
      if (rel.toLowerCase() === 'skill.md') {
        const [textA, textB] = [await fsp.readFile(pathA, 'utf8'), await fsp.readFile(pathB, 'utf8')]
        if (flagsFreeText(textA) !== flagsFreeText(textB)) return false
      } else {
        const [bytesA, bytesB] = [await fsp.readFile(pathA), await fsp.readFile(pathB)]
        if (!bytesA.equals(bytesB)) return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 删除 = 移到 <DSH_HOME>/skill-panel-trash/，不真删。
 * Windows 上「多个目录同时 rename 进同一个父目录」会稳定返回 EPERM（顺序执行则正常），
 * 所以整个回收动作串行化——它本来就很少发生，串行的代价可以忽略。
 */
let trashQueue = Promise.resolve()

export async function moveToTrash(target, name) {
  const task = async () => {
    const root = trashDir()
    await fsp.mkdir(root, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${stamp}-${name}`
    let dest = path.join(root, base)
    // 同一毫秒内同名两次（批量删除 / 重复点击）不能撞到同一个目标
    for (let attempt = 1; existsSync(dest); attempt += 1) {
      dest = path.join(root, `${base}-${attempt}`)
      if (attempt > 1000) throw new Error('回收目录冲突过多，已放弃')
    }
    try {
      await withRetry(() => fsp.rename(target, dest))
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        await fsp.cp(target, dest, { recursive: true, dereference: true })
        await fsp.rm(target, { recursive: true, force: true })
      } else {
        throw error
      }
    }
    return dest
  }
  const run = trashQueue.then(task, task)
  trashQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/* ------------------------------------------------------------------- 导入 */

async function readSkillDirName(dir) {
  const file = path.join(dir, 'SKILL.md')
  const doc = parseSkillDoc(await fsp.readFile(file, 'utf8'))
  if (!doc.ok) throw new Error(doc.reason)
  const inspected = inspectSkillDoc(doc)
  if (inspected.problems.length) throw new Error(inspected.problems.join('；'))
  return inspected.name
}

export async function importFolder(targetRoot, sourcePath) {
  const source = path.resolve(sourcePath)
  const info = await fsp.stat(source)
  if (!info.isDirectory()) throw new Error('来源不是目录')
  const candidates = []
  if (existsSync(path.join(source, 'SKILL.md'))) candidates.push(source)
  else {
    for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const dir = path.join(source, entry.name)
      const resolved = await resolveEntryKind(entry, dir)
      if (resolved.kind !== 'dir') continue
      if (existsSync(path.join(dir, 'SKILL.md'))) candidates.push(dir)
    }
  }
  if (!candidates.length) throw new Error('目录里没有 SKILL.md，也没有含 SKILL.md 的子目录')
  const results = []
  for (const dir of candidates) {
    try {
      const name = await readSkillDirName(dir)
      const target = path.join(targetRoot, name)
      if (existsSync(target)) {
        results.push({ source: dir, name, ok: false, error: '目标里已有同名技能' })
        continue
      }
      await fsp.mkdir(targetRoot, { recursive: true })
      await withRetry(() => fsp.cp(dir, target, COPY_OPTIONS))
      results.push({ source: dir, name, ok: true })
    } catch (error) {
      results.push({ source: dir, ok: false, error: error?.message ?? String(error) })
    }
  }
  return results
}

/* --------------------------------------------------------------- zip 读取 */

function readZipDirectory(buffer) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 66000)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾）')
  const count = buffer.readUInt16LE(eocd + 10)
  const size = buffer.readUInt32LE(eocd + 12)
  const start = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Error('暂不支持 zip64 压缩包')
  const entries = []
  let pointer = start
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length) throw new Error('zip 中央目录被截断')
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('zip 中央目录结构异常')
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 zip64 压缩包')
    }
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function extractEntry(buffer, entry, limit) {
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('zip 本地头损坏')
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  if (start + entry.compressedSize > buffer.length) throw new Error('zip 条目被截断')
  const payload = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) {
    if (payload.length > limit) throw new Error('解压后总大小超过 64MB 上限')
    return Buffer.from(payload)
  }
  if (entry.method === 8) {
    // maxOutputLength 挡住「声明很小、实际解压巨大」的压缩炸弹
    try {
      return zlib.inflateRawSync(payload, { maxOutputLength: limit })
    } catch (error) {
      if (error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('解压后总大小超过 64MB 上限')
      throw new Error(`zip 条目解压失败：${error?.message ?? error}`)
    }
  }
  throw new Error(`不支持的压缩方式：${entry.method}`)
}

function safeZipPath(rawName) {
  const normalized = String(rawName).replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (!segments.length || segments.includes('..')) return undefined
  return segments.join('/')
}

/**
 * 把 zip 拆成技能包：`<dir>/SKILL.md` 目录形式，或仅一个根级 `SKILL.md`。
 * `limits` 只用于测试/调参：默认取模块常量。
 */
export function planZipSkills(buffer, limits = {}) {
  const maxEntries = limits.maxEntries || MAX_ZIP_ENTRIES
  const maxUnzipBytes = limits.maxUnzipBytes || MAX_UNZIP_BYTES
  const directory = readZipDirectory(buffer)
  const files = []
  let total = 0
  for (const entry of directory) {
    if (entry.name.endsWith('/')) continue
    const safe = safeZipPath(entry.name)
    if (!safe) throw new Error(`压缩包里包含不安全的路径：${entry.name}`)
    if (files.length >= maxEntries) throw new Error('压缩包里文件过多')
    const remaining = maxUnzipBytes - total
    total += entry.uncompressedSize
    if (total > maxUnzipBytes) throw new Error('解压后总大小超过 64MB 上限')
    files.push({ path: safe, data: extractEntry(buffer, entry, remaining) })
  }
  const skillDocs = files.filter((file) => file.path === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(file.path))
  if (!skillDocs.length) return { skills: [], loose: files.length }
  const skills = []
  const single = skillDocs.find((file) => file.path === 'SKILL.md')
  if (single) {
    const doc = parseSkillDoc(single.data.toString('utf8'))
    if (!doc.ok) throw new Error(`根级 SKILL.md 无效：${doc.reason}`)
    const inspected = inspectSkillDoc(doc)
    if (inspected.problems.length) throw new Error(`根级 SKILL.md 无效：${inspected.problems.join('；')}`)
    skills.push({ name: inspected.name, entries: files })
    return { skills, loose: 0 }
  }
  const dirs = new Set(skillDocs.map((file) => file.path.split('/')[0]))
  for (const dir of dirs) {
    const prefix = `${dir}/`
    const members = files.filter((file) => file.path.startsWith(prefix))
    const docFile = members.find((file) => file.path === `${prefix}SKILL.md`)
    const doc = parseSkillDoc(docFile.data.toString('utf8'))
    if (!doc.ok) throw new Error(`${dir}/SKILL.md 无效：${doc.reason}`)
    const inspected = inspectSkillDoc(doc)
    if (inspected.problems.length) throw new Error(`${dir}/SKILL.md 无效：${inspected.problems.join('；')}`)
    skills.push({
      name: inspected.name,
      entries: members.map((file) => ({ path: file.path.slice(prefix.length), data: file.data })),
    })
  }
  return { skills, loose: 0 }
}

export async function importZip(targetRoot, buffer, options = {}) {
  if (!buffer || !buffer.length) throw new Error('压缩包为空')
  if (buffer.length > MAX_ZIP_BYTES) throw new Error('压缩包超过 32MB 上限')
  const planned = planZipSkills(buffer, options.limits || {})
  if (!planned.skills.length) throw new Error('压缩包里没有技能（缺少 SKILL.md）')
  const results = []
  const fallback = options.name && isKebabName(options.name) ? options.name : undefined
  for (const skill of planned.skills) {
    const name = isKebabName(skill.name) ? skill.name : fallback
    if (!name) {
      results.push({ ok: false, error: '无法确定技能名' })
      continue
    }
    const target = path.join(targetRoot, name)
    try {
      if (existsSync(target)) {
        results.push({ name, ok: false, error: '目标里已有同名技能' })
        continue
      }
      await fsp.mkdir(target, { recursive: true })
      for (const file of skill.entries) {
        const destination = path.join(target, file.path)
        if (!isInside(target, destination) && path.resolve(destination) !== path.resolve(target)) {
          throw new Error(`压缩包路径越界：${file.path}`)
        }
        await fsp.mkdir(path.dirname(destination), { recursive: true })
        await fsp.writeFile(destination, file.data)
      }
      results.push({ name, ok: true, files: skill.entries.length })
    } catch (error) {
      await fsp.rm(target, { recursive: true, force: true })
      results.push({ name, ok: false, error: error?.message ?? String(error) })
    }
  }
  return results
}
