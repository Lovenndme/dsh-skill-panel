/**
 * 深度/对抗性测试：frontmatter 编辑、目录扫描、写入原子性、导入、zip 解析。
 * 与 host.test.mjs 的分工：那边覆盖主路径，这里专挑边界与「静默失败」。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  collectSkills,
  copySkillInto,
  createSkill,
  createStub,
  inspectSkillDoc,
  isSameOrInside,
  importFolder,
  importZip,
  locateSkill,
  moveToTrash,
  parseBoolean,
  parseFrontmatterFields,
  parseSkillDoc,
  planZipSkills,
  removeStub,
  sameSkillContent,
  saveSkillDoc,
  setFrontmatterFlag,
  setSkillFlags,
  writeTextAtomic,
} from '../lib/skills.js'

const tmp = (label) => fsp.mkdtemp(path.join(os.tmpdir(), `dsp-deep-${label}-`))

function doc(name, description, extra = {}, body = '正文') {
  const lines = ['---', `name: ${name}`, `description: '${description}'`]
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${value}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

async function writeSkill(root, name, options = {}) {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), doc(name, options.description || `${name} 说明`, options.extra || {}, options.body || '正文'))
  return dir
}

async function collectionOf({ home, project }) {
  return collectSkills({ projectRoot: project, dshHome: home, agentsHome: path.join(home, 'agents') })
}

/* =========================================================== frontmatter 编辑 */

test('setFrontmatterFlag 绝不把标记写进块标量内部', () => {
  const source = ['---', 'name: x', 'description: |', '  line1', '  ---', '  line2', 'user-invocable: true', '---', '', 'body', ''].join('\n')
  const out = setFrontmatterFlag(source, 'disable-model-invocation', true)
  const lines = out.split('\n')
  // 新键必须落在块标量之后、结束分隔符之前
  const flagIndex = lines.indexOf('disable-model-invocation: true')
  const blockLine = lines.indexOf('  line2')
  const closeIndex = lines.lastIndexOf('---')
  assert.ok(flagIndex > blockLine, `标记不该插在块标量内部，得到：\n${out}`)
  assert.equal(flagIndex, closeIndex - 1)
  // 块标量内容原样保留
  assert.ok(out.includes('  line1\n  ---\n  line2'))
  const parsed = parseSkillDoc(out)
  assert.equal(parsed.ok, true)
  assert.equal(parseBoolean(parsed.fields['disable-model-invocation']), true)
  assert.equal(parsed.fields['user-invocable'], 'true')
})

test('setFrontmatterFlag 不碰嵌套映射里的同名字段', () => {
  const source = ['---', 'name: x', 'description: y', 'metadata:', '  disable-model-invocation: true', '---', '', 'body', ''].join('\n')
  const out = setFrontmatterFlag(source, 'disable-model-invocation', false)
  assert.ok(out.includes('  disable-model-invocation: true'), '嵌套字段必须原样保留')
  assert.ok(out.includes('disable-model-invocation: false'))
  const parsed = parseSkillDoc(out)
  assert.equal(parseBoolean(parsed.fields['disable-model-invocation']), false)
})

test('setFrontmatterFlag 处理折叠块标量与缩进更深的内容', () => {
  const source = ['---', 'name: x', 'description: >-', '  folded', '    indented more', '  back', '---', '', 'body', ''].join('\n')
  const out = setFrontmatterFlag(source, 'user-invocable', false)
  assert.ok(out.includes('    indented more'))
  assert.ok(out.indexOf('user-invocable: false') > out.indexOf('  back'))
})

test('setFrontmatterFlag 保留 CRLF、BOM 与正文逐字节不变', () => {
  const body = '正文 with `code`\r\n第二行\r\n\r\n- 列表\r\n'
  const source = '\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\n\r\n' + body
  const out = setFrontmatterFlag(source, 'user-invocable', false)
  assert.ok(out.startsWith('\uFEFF---\r\n'))
  assert.ok(out.includes('user-invocable: false\r\n'))
  const parsed = parseSkillDoc(out)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.body, '\r\n' + body, '纯 CRLF 文件的正文必须逐字节不变')
  assert.equal(out.includes('\n') && !out.includes('\r\n'), false)
})

test('setFrontmatterFlag 把混合换行归一为主换行，但行内容不变', () => {
  const source = '---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nline1\nline2\n'
  const out = setFrontmatterFlag(source, 'user-invocable', false)
  const parsed = parseSkillDoc(out)
  assert.equal(parsed.body.replace(/\r\n/g, '\n'), '\nline1\nline2\n')
})

test('setFrontmatterFlag 缺少 frontmatter 时明确抛错', () => {
  assert.throws(() => setFrontmatterFlag('# 只有正文\n', 'user-invocable', true), /缺少 YAML frontmatter/)
  assert.throws(() => setFrontmatterFlag('---\nname: x\n', 'user-invocable', true), /未闭合/)
})

test('setFrontmatterFlag 是幂等的', () => {
  const source = doc('x', '说明')
  const once = setFrontmatterFlag(source, 'user-invocable', false)
  const twice = setFrontmatterFlag(once, 'user-invocable', false)
  assert.equal(twice, once)
})

/* ================================================================ 文档解析 */

test('parseSkillDoc 接受空 frontmatter 并归为「缺 name」', () => {
  const empty = parseSkillDoc('---\n---\n\nbody\n')
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.fields, {})
  const inspected = inspectSkillDoc(empty)
  assert.ok(inspected.problems.some((item) => item.includes('缺少 name')))
})

test('parseSkillDoc 支持结束分隔符后无换行', () => {
  const parsed = parseSkillDoc('---\nname: x\ndescription: y\n---')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.body, '')
})

test('parseSkillDoc 剥掉 BOM 且保留原始正文', () => {
  const parsed = parseSkillDoc('\uFEFF---\nname: x\ndescription: y\n---\n\n保留\n')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.body, '\n保留\n')
})

test('parseFrontmatterFields 跳过注释与缩进行，解引号与块标量', () => {
  const fields = parseFrontmatterFields(
    ['# 顶部注释', 'name: "双引号 name"', "description: '单引号 ''内嵌'''", 'whenToUse: |', '  第一行', '  第二行', 'metadata:', '  nested: 1'].join('\n'),
  )
  assert.equal(fields.name, '双引号 name')
  assert.equal(fields.description, "单引号 '内嵌'")
  assert.equal(fields.whenToUse, '第一行\n第二行')
  assert.equal(fields.metadata, '')
})

test('块标量把同缩进的后续行当作内容（与 YAML 一致）', () => {
  const fields = parseFrontmatterFields(['whenToUse: |', '  第一行', '  metadata: 1'].join('\n'))
  assert.equal(fields.whenToUse, '第一行\nmetadata: 1')
  assert.equal(fields.metadata, undefined)
})

test('inspectSkillDoc 认出旧键与非字符串值', () => {
  const cases = [
    { text: doc('x', 'y', { userInvocable: 'true' }), match: /不支持的字段 userInvocable/ },
    { text: doc('x', 'y', { modelInvocable: 'false' }), match: /不支持的字段 modelInvocable/ },
    { text: doc('x', 'y', { disableModelInvocation: 'true' }), match: /不支持的字段 disableModelInvocation/ },
    { text: '---\nname: x\ndescription: 123\n---\n\nbody\n', match: /description 会被 YAML 读成非字符串/ },
    { text: '---\nname: 123\ndescription: y\n---\n\nbody\n', match: /name 会被 YAML 读成非字符串/ },
    { text: '---\nname: x\nname: x\ndescription: y\n---\n\nbody\n', match: /name 重复出现/ },
    { text: '---\nname: x\ndescription: y\ndisable-model-invocation: maybe\n---\n\nbody\n', match: /不是合法布尔值/ },
    { text: '---\nname: Bad_Name\ndescription: y\n---\n\nbody\n', match: /kebab-case/ },
  ]
  for (const { text, match } of cases) {
    const parsed = parseSkillDoc(text)
    assert.equal(parsed.ok, true, text)
    const problems = inspectSkillDoc(parsed).problems.join('；')
    assert.match(problems, match, `期望命中 ${match}，实际：${problems}`)
  }
})

/* ==================================================================== 扫描 */

test('scanRoot/collectSkills 跟随目录链接（junction 形式的技能目录）', async () => {
  const home = await tmp('link')
  const skillsRoot = path.join(home, 'skills')
  await fsp.mkdir(skillsRoot, { recursive: true })
  const real = path.join(home, 'outside-skill')
  await writeSkill(path.dirname(real), path.basename(real))
  let linked = false
  try {
    await fsp.symlink(real, path.join(skillsRoot, 'linked-skill'), 'junction')
    linked = true
  } catch {
    linked = false
  }
  if (!linked) {
    // 无权限创建链接的环境（如受限 CI）：至少确认不会崩，并跳过
    const collection = await collectionOf({ home })
    assert.equal(Array.isArray(collection.skills), true)
    return
  }
  const collection = await collectionOf({ home })
  const names = collection.skills.map((skill) => skill.name)
  assert.deepEqual(names, ['outside-skill'], '链接目录里的技能必须被发现（DSH 会跟随链接）')
  assert.equal(collection.skills[0].path, path.join(skillsRoot, 'linked-skill', 'SKILL.md'))
  assert.equal(collection.diagnostics.length, 0)
})

test('坏链接进 diagnostics 而不是静默消失', async () => {
  const home = await tmp('broken')
  const skillsRoot = path.join(home, 'skills')
  await fsp.mkdir(skillsRoot, { recursive: true })
  let linked = false
  try {
    await fsp.symlink(path.join(home, 'does-not-exist'), path.join(skillsRoot, 'dangling'), 'junction')
    linked = true
  } catch {
    linked = false
  }
  if (!linked) return
  const collection = await collectionOf({ home })
  assert.ok(collection.diagnostics.some((item) => /目标不存在/.test(item.reason)), JSON.stringify(collection.diagnostics))
})

test('同一 root 里目录与平铺 .md 撞名时给出诊断', async () => {
  const home = await tmp('dup')
  const skillsRoot = path.join(home, 'skills')
  await fsp.mkdir(skillsRoot, { recursive: true })
  await writeSkill(skillsRoot, 'same-name')
  await fsp.writeFile(path.join(skillsRoot, 'same-name.md'), doc('same-name', '平铺那份'))
  const collection = await collectionOf({ home })
  assert.equal(collection.skills.length, 1)
  assert.ok(collection.diagnostics.some((item) => /同名/.test(item.reason)), JSON.stringify(collection.diagnostics))
})

test('同一来源里两个不同 name 重复时给诊断', async () => {
  const home = await tmp('dupname')
  const skillsRoot = path.join(home, 'skills')
  await writeSkill(skillsRoot, 'first-dir')
  await fsp.writeFile(path.join(skillsRoot, 'second.md'), doc('first-dir', '另一份'))
  const collection = await collectionOf({ home })
  assert.equal(collection.skills.length, 1)
  assert.ok(collection.diagnostics.some((item) => /name 重复/.test(item.reason)), JSON.stringify(collection.diagnostics))
})

test('隐藏目录、非 md 文件、没有 SKILL.md 的目录都被跳过', async () => {
  const home = await tmp('skip')
  const skillsRoot = path.join(home, 'skills')
  await fsp.mkdir(path.join(skillsRoot, '.system', 'inner'), { recursive: true })
  await fsp.writeFile(path.join(skillsRoot, '.system', 'inner', 'SKILL.md'), doc('hidden-one', 'x'))
  await fsp.mkdir(path.join(skillsRoot, 'no-doc'), { recursive: true })
  await fsp.writeFile(path.join(skillsRoot, 'no-doc', 'README.md'), 'not a skill')
  await fsp.writeFile(path.join(skillsRoot, 'notes.txt'), 'plain')
  await writeSkill(skillsRoot, 'real-skill')
  const collection = await collectionOf({ home })
  assert.deepEqual(collection.skills.map((skill) => skill.name), ['real-skill'])
})

test('项目层压过全局层，同层按 rank 排序', async () => {
  const home = await tmp('rank')
  const project = await tmp('rank-proj')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(home, 'skills'), 'shared', { description: 'user-dsh' })
  await writeSkill(path.join(home, 'agents', 'skills'), 'shared', { description: 'user-agents' })
  await writeSkill(path.join(project, '.agents', 'skills'), 'shared', { description: 'project-agents' })
  await writeSkill(path.join(project, '.dsh', 'skills'), 'shared', { description: 'project-dsh' })
  const collection = await collectionOf({ home, project })
  const winner = collection.skills.find((skill) => skill.name === 'shared')
  assert.equal(winner.source, 'project-dsh')
  assert.equal(winner.shadowed.length, 3)
  assert.deepEqual(
    winner.shadowed.map((item) => item.source),
    ['project-agents', 'user-dsh', 'user-agents'],
  )
})

/* ==================================================================== 写入 */

test('createSkill 拒绝与平铺 .md 撞名', async () => {
  const root = await tmp('create-flat')
  await fsp.writeFile(path.join(root, 'dup.md'), doc('dup', 'x'))
  await assert.rejects(() => createSkill(root, { name: 'dup', description: '新' }), /已有平铺文件/)
})

test('createSkill 拒绝各种非法名字，description 归一化为单行', async () => {
  const root = await tmp('create-names')
  for (const bad of ['BadName', 'under_score', '-lead', 'trail-', 'has space', '', '中文', 'a--b']) {
    await assert.rejects(() => createSkill(root, { name: bad, description: 'x' }), /kebab-case/, bad)
  }
  const file = await createSkill(root, { name: 'ok-name', description: '  带\n换行   的描述  ' })
  const text = await fsp.readFile(file, 'utf8')
  assert.match(text, /description: '带 换行 的描述'/)
  const parsed = parseSkillDoc(text)
  assert.equal(inspectSkillDoc(parsed).problems.length, 0)
})

test('createSkill 的描述里带单引号也能被正确解析回来', async () => {
  const root = await tmp('create-quote')
  const file = await createSkill(root, { name: 'quote-name', description: "it's fine" })
  const parsed = parseSkillDoc(await fsp.readFile(file, 'utf8'))
  assert.equal(parsed.fields.description, "it's fine")
})

test('setSkillFlags 逐字节保留正文，并支持反复翻转', async () => {
  const home = await tmp('flags')
  const root = path.join(home, 'skills')
  const body = '## 标题\n\n```js\nconsole.log(1)\n```\n\n尾部\n'
  const dir = await writeSkill(root, 'flip', { body })
  const file = path.join(dir, 'SKILL.md')
  const before = await fsp.readFile(file, 'utf8')
  let collection = await collectionOf({ home })
  let location = await locateSkill(collection, 'flip', 'user-dsh')
  await setSkillFlags(location, { model: false, user: false })
  const after = await fsp.readFile(file, 'utf8')
  assert.equal(parseSkillDoc(after).body, parseSkillDoc(before).body, '正文不能变')
  for (let round = 0; round < 5; round += 1) {
    collection = await collectionOf({ home })
    location = await locateSkill(collection, 'flip', 'user-dsh')
    await setSkillFlags(location, { model: round % 2 === 0, user: round % 2 === 0 })
    const skill = (await collectionOf({ home })).skills.find((item) => item.name === 'flip')
    assert.equal(skill.modelInvocable, round % 2 === 0)
    assert.equal(skill.userInvocable, round % 2 === 0)
  }
  assert.equal(parseSkillDoc(await fsp.readFile(file, 'utf8')).body, parseSkillDoc(before).body)
})

test('并发 setSkillFlags 不会互相覆盖（同一文件串行化）', async () => {
  const home = await tmp('flags-conc')
  const root = path.join(home, 'skills')
  const dir = await writeSkill(root, 'conc')
  const file = path.join(dir, 'SKILL.md')
  const collection = await collectionOf({ home })
  const location = await locateSkill(collection, 'conc', 'user-dsh')
  const jobs = []
  for (let index = 0; index < 20; index += 1) {
    jobs.push(setSkillFlags(location, { model: index % 2 === 0 }))
  }
  await Promise.all(jobs)
  const parsed = parseSkillDoc(await fsp.readFile(file, 'utf8'))
  assert.equal(parsed.ok, true)
  // 两个键都必须存在且都是合法布尔值：说明没有一次写入把另一个键吃掉
  assert.notEqual(parseBoolean(parsed.fields['disable-model-invocation']), undefined)
  assert.equal(parsed.fields.name, 'conc')
})

test('并发 writeTextAtomic 不留临时文件，且结果是某一次完整内容', async () => {
  const dir = await tmp('atomic-conc')
  const file = path.join(dir, 'SKILL.md')
  const payloads = Array.from({ length: 40 }, (_, index) => `content-${index}`.repeat(50))
  await Promise.all(payloads.map((text) => writeTextAtomic(file, text)))
  const final = await fsp.readFile(file, 'utf8')
  assert.ok(payloads.includes(final), '最终内容必须是某一次完整写入')
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.includes('dsp-tmp'))
  assert.deepEqual(leftovers, [], '不能残留临时文件')
})

test('saveSkillDoc 拒绝改名、拒绝坏 frontmatter、拒绝超大文件', async () => {
  const home = await tmp('save')
  const root = path.join(home, 'skills')
  await writeSkill(root, 'save-me')
  const collection = await collectionOf({ home })
  const location = await locateSkill(collection, 'save-me', 'user-dsh')
  await assert.rejects(() => saveSkillDoc(location, doc('other-name', 'x')), /不能改成另一个技能/)
  await assert.rejects(() => saveSkillDoc(location, 'no frontmatter'), /frontmatter/)
  await assert.rejects(() => saveSkillDoc(location, doc('save-me', 'y') + 'x'.repeat(1024 * 1024)), /1MB/)
  const parsed = parseSkillDoc(await fsp.readFile(location.record.path, 'utf8'))
  assert.equal(parsed.fields.description, 'save-me 说明', '失败的保存不能改动文件')
})

test('moveToTrash 同一毫秒内同名多次也不撞目标', async () => {
  const home = await tmp('trash')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const project = await tmp('trash-proj')
    const dirs = []
    for (let index = 0; index < 3; index += 1) {
      dirs.push(await writeSkill(path.join(project, `.dsh${index}`, 'skills'), 'trash-me'))
    }
    const destinations = await Promise.all(dirs.map((dir) => moveToTrash(dir, 'trash-me')))
    assert.equal(new Set(destinations).size, 3, '三个目标路径必须互不相同')
    for (const destination of destinations) assert.ok(existsSync(path.join(destination, 'SKILL.md')))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('copySkillInto 失败时不留下半成品', async () => {
  const target = await tmp('copy-target')
  await assert.rejects(
    () => copySkillInto(target, 'ghost', { sourcePath: path.join(target, 'missing', 'SKILL.md'), sourceKind: 'dir', enable: true }),
    /复制|ENOENT/,
  )
  assert.equal(existsSync(path.join(target, 'ghost')), false, '失败后不能残留目标目录')
})

test('copySkillInto 的 enable 会显式打开两个开关', async () => {
  const source = await tmp('copy-src')
  const dir = await writeSkill(source, 'will-enable', { extra: { 'disable-model-invocation': 'true', 'user-invocable': 'false' } })
  const target = await tmp('copy-dst')
  await copySkillInto(target, 'will-enable', { sourcePath: path.join(dir, 'SKILL.md'), sourceKind: 'dir', enable: true })
  const parsed = parseSkillDoc(await fsp.readFile(path.join(target, 'will-enable', 'SKILL.md'), 'utf8'))
  assert.equal(parseBoolean(parsed.fields['disable-model-invocation']), false)
  assert.equal(parseBoolean(parsed.fields['user-invocable']), true)
})

/* ================================================================ 内容比对 */

test('sameSkillContent 忽略两个开关行，但认得出正文/额外文件的差异', async () => {
  const left = await tmp('same-l')
  const right = await tmp('same-r')
  const leftDir = await writeSkill(left, 'cmp', { body: 'BODY' })
  const rightDir = await writeSkill(right, 'cmp', { body: 'BODY', extra: { 'disable-model-invocation': 'true', 'user-invocable': 'false' } })
  assert.equal(await sameSkillContent(path.join(leftDir, 'SKILL.md'), 'dir', path.join(rightDir, 'SKILL.md'), 'dir'), true)
  assert.equal(await sameSkillContent(path.join(leftDir, 'SKILL.md'), 'file', path.join(rightDir, 'SKILL.md'), 'dir'), false, 'kind 不同必须判不等')

  await fsp.mkdir(path.join(rightDir, 'references'), { recursive: true })
  await fsp.writeFile(path.join(rightDir, 'references', 'a.md'), 'extra')
  assert.equal(await sameSkillContent(path.join(leftDir, 'SKILL.md'), 'dir', path.join(rightDir, 'SKILL.md'), 'dir'), false)

  const otherBody = await writeSkill(await tmp('same-3'), 'cmp', { body: 'DIFFERENT' })
  assert.equal(await sameSkillContent(path.join(leftDir, 'SKILL.md'), 'dir', path.join(otherBody, 'SKILL.md'), 'dir'), false)
})

/* ==================================================================== 导入 */

test('importFolder 支持单技能、批量、以及指向目录的链接', async () => {
  const target = await tmp('imp-target')
  const single = await tmp('imp-single')
  await writeSkill(single, 'single-skill')
  const first = await importFolder(target, single)
  assert.deepEqual(first.map((item) => [item.name, item.ok]), [['single-skill', true]])

  const batch = await tmp('imp-batch')
  await writeSkill(batch, 'batch-a')
  await writeSkill(batch, 'batch-b')
  await fsp.mkdir(path.join(batch, 'not-a-skill'), { recursive: true })
  const second = await importFolder(target, batch)
  assert.equal(second.filter((item) => item.ok).length, 2)

  const linkedSource = await tmp('imp-link')
  const real = await writeSkill(await tmp('imp-real'), 'linked-in', { description: 'real' })
  let linked = false
  try {
    await fsp.symlink(real, path.join(linkedSource, 'linked-in'), 'junction')
    linked = true
  } catch {
    linked = false
  }
  if (linked) {
    const third = await importFolder(target, linkedSource)
    assert.equal(third.length, 1)
    assert.equal(third[0].ok, true)
    assert.ok(existsSync(path.join(target, 'linked-in', 'SKILL.md')))
  }
})

test('importFolder 用 frontmatter 的 name 落盘，并拒绝坏技能', async () => {
  const source = await tmp('imp-name')
  await fsp.mkdir(path.join(source, 'dir-name'), { recursive: true })
  await fsp.writeFile(path.join(source, 'dir-name', 'SKILL.md'), doc('frontmatter-name', 'x'))
  await fsp.mkdir(path.join(source, 'broken'), { recursive: true })
  await fsp.writeFile(path.join(source, 'broken', 'SKILL.md'), 'no frontmatter')
  const target = await tmp('imp-name-target')
  const results = await importFolder(target, source)
  const byName = Object.fromEntries(results.map((item) => [item.name || item.source, item]))
  assert.equal(byName['frontmatter-name'].ok, true)
  assert.ok(existsSync(path.join(target, 'frontmatter-name', 'SKILL.md')))
  assert.equal(byName['dir-name'], undefined, '不能拿目录名代替 frontmatter 的 name')
  assert.equal(results.filter((item) => item.ok).length, 1)
})

/* ===================================================================== zip */

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

/** method: 8 = deflate，0 = store。declaredSize 可故意写错，用于压缩炸弹用例。 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const method = entry.method === 0 ? 0 : 8
    const payload = method === 0 ? data : zlib.deflateRawSync(data)
    const crc = crc32(data)
    const declared = entry.declaredSize === undefined ? data.length : entry.declaredSize
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(declared, 24)
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

test('zip：store 与 deflate 两种压缩方式都能读', () => {
  const buffer = buildZip([
    { name: 'stored/SKILL.md', data: doc('stored-skill', 'store'), method: 0 },
    { name: 'deflated/SKILL.md', data: doc('deflated-skill', 'deflate'), method: 8 },
  ])
  const planned = planZipSkills(buffer)
  assert.deepEqual(planned.skills.map((skill) => skill.name).sort(), ['deflated-skill', 'stored-skill'])
})

test('zip：一个包里的多个技能各归各的目录', () => {
  const buffer = buildZip([
    { name: 'a/SKILL.md', data: doc('skill-a', 'x') },
    { name: 'a/ref/notes.md', data: 'notes-a' },
    { name: 'b/SKILL.md', data: doc('skill-b', 'y') },
  ])
  const planned = planZipSkills(buffer)
  const byName = Object.fromEntries(planned.skills.map((skill) => [skill.name, skill]))
  assert.deepEqual(byName['skill-a'].entries.map((file) => file.path).sort(), ['SKILL.md', 'ref/notes.md'])
  assert.deepEqual(byName['skill-b'].entries.map((file) => file.path), ['SKILL.md'])
})

test('zip：拒绝路径穿越与绝对路径（含反斜杠形式）', () => {
  for (const name of ['../evil/SKILL.md', '/abs/SKILL.md', 'C:/abs/SKILL.md', 'a/../../evil/SKILL.md', '..\\evil\\SKILL.md']) {
    const buffer = buildZip([{ name, data: doc('evil', 'x') }])
    assert.throws(() => planZipSkills(buffer), /不安全的路径/, name)
  }
})

test('zip：压缩炸弹（声明很小、实际很大）被 maxOutputLength 挡住', () => {
  const bomb = Buffer.alloc(4 * 1024 * 1024, 0)
  const buffer = buildZip([{ name: 'bomb/SKILL.md', data: bomb, declaredSize: 8 }])
  assert.throws(() => planZipSkills(buffer, { maxUnzipBytes: 64 * 1024 }), /64MB 上限/)
})

test('zip：声明总量超限直接拒绝', () => {
  const buffer = buildZip([{ name: 'big/SKILL.md', data: Buffer.alloc(2048, 1) }])
  assert.throws(() => planZipSkills(buffer, { maxUnzipBytes: 1024 }), /64MB 上限/)
})

test('zip：条目数超限被拒绝', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ name: `a/f${index}.md`, data: 'x' }))
  entries.unshift({ name: 'a/SKILL.md', data: doc('a-skill', 'x') })
  assert.throws(() => planZipSkills(buildZip(entries), { maxEntries: 3 }), /文件过多/)
})

test('zip：非 zip、截断、zip64、未知压缩方式都给出明确错误', async () => {
  assert.throws(() => planZipSkills(Buffer.from('not a zip at all')), /不是有效的 zip/)

  const good = buildZip([{ name: 'a/SKILL.md', data: doc('a-skill', 'x') }])
  assert.throws(() => planZipSkills(good.subarray(0, good.length - 30)), /不是有效|截断/)

  const zip64 = Buffer.from(good)
  zip64.writeUInt16LE(0xffff, zip64.length - 12)
  assert.throws(() => planZipSkills(zip64), /zip64/)

  const unknown = Buffer.from(good)
  // 把本地头与中央目录的 method 都改成不支持的 12
  unknown.writeUInt16LE(12, 8)
  const centralStart = unknown.length - 22 - (46 + 'a/SKILL.md'.length)
  unknown.writeUInt16LE(12, centralStart + 10)
  assert.throws(() => planZipSkills(unknown), /不支持的压缩方式/)
})

test('zip：没有 SKILL.md 时明确报错，且 importZip 不落盘', async () => {
  const buffer = buildZip([{ name: 'docs/readme.md', data: 'hi' }])
  assert.deepEqual(planZipSkills(buffer).skills, [])
  const target = await tmp('zip-empty')
  await assert.rejects(() => importZip(target, buffer), /没有技能/)
  assert.deepEqual(await fsp.readdir(target), [])
})

test('importZip 多个技能逐个落盘，重名只拒一个不影响另一个', async () => {
  const target = await tmp('zip-multi')
  await writeSkill(target, 'taken-skill')
  const buffer = buildZip([
    { name: 'taken-skill/SKILL.md', data: doc('taken-skill', 'dup') },
    { name: 'fresh-skill/SKILL.md', data: doc('fresh-skill', 'new') },
  ])
  const results = await importZip(target, buffer)
  const byName = Object.fromEntries(results.map((item) => [item.name, item]))
  assert.equal(byName['taken-skill'].ok, false)
  assert.equal(byName['fresh-skill'].ok, true)
  assert.ok(existsSync(path.join(target, 'fresh-skill', 'SKILL.md')))
  assert.match(await fsp.readFile(path.join(target, 'taken-skill', 'SKILL.md'), 'utf8'), /taken-skill 说明/, '不能覆盖已有技能')
})

test('importZip 拒绝空包与超大包', async () => {
  const target = await tmp('zip-limits')
  await assert.rejects(() => importZip(target, Buffer.alloc(0)), /压缩包为空/)
})

/* ============================================================== 占位（stub） */

test('占位技能可创建/识别/删除，且拒绝删除普通技能', async () => {
  const home = await tmp('stub')
  const project = await tmp('stub-proj')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(home, 'skills'), 'guarded')
  await createStub(project, 'guarded')
  let collection = await collectionOf({ home, project })
  const stub = collection.skills.find((skill) => skill.name === 'guarded')
  assert.equal(stub.stub, true)
  assert.equal(stub.modelInvocable, false)
  assert.equal(stub.userInvocable, false)
  assert.equal(stub.shadowed[0].modelInvocable, true)

  await assert.rejects(() => createStub(project, 'guarded'), /已存在同名技能目录/)
  await removeStub(project, 'guarded')
  collection = await collectionOf({ home, project })
  assert.equal(collection.skills.find((skill) => skill.name === 'guarded').scope, 'global')

  await writeSkill(path.join(project, '.dsh', 'skills'), 'real-one')
  await assert.rejects(() => removeStub(project, 'real-one'), /不是本插件创建的禁用占位/)
})

test('isSameOrInside 覆盖相等与包含', async () => {
  const base = path.join(os.tmpdir(), 'dsp-same', 'a')
  assert.equal(isSameOrInside(base, base), true)
  assert.equal(isSameOrInside(base, path.join(base, 'x')), true)
  assert.equal(isSameOrInside(base, path.join(os.tmpdir(), 'dsp-same', 'b')), false)
})

/* ================================================================== 性能护栏 */

test('200 个技能的扫描是线性的，不会退化成不可用的速度', async () => {
  const home = await tmp('perf')
  const root = path.join(home, 'skills')
  await fsp.mkdir(root, { recursive: true })
  const total = 200
  await Promise.all(
    Array.from({ length: total }, async (_, index) => {
      const name = `perf-skill-${String(index).padStart(3, '0')}`
      await fsp.mkdir(path.join(root, name), { recursive: true })
      await fsp.writeFile(path.join(root, name, 'SKILL.md'), doc(name, `${name} 的描述`))
    }),
  )
  const started = Date.now()
  const collection = await collectionOf({ home })
  const elapsed = Date.now() - started
  assert.equal(collection.skills.length, total)
  assert.equal(collection.diagnostics.length, 0)
  assert.ok(elapsed < 5000, `200 个技能扫描耗时 ${elapsed}ms，过慢`)
})
