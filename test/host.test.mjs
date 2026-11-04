import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  collectSkills,
  createSkill,
  createStub,
  findProjectRoot,
  importFolder,
  importZip,
  isInside,
  moveToTrash,
  parseBoolean,
  parseSkillDoc,
  planZipSkills,
  removeStub,
  saveSkillDoc,
  setFrontmatterFlag,
  setSkillFlags,
  locateSkill,
  writeTextAtomic,
} from '../lib/skills.js'

/* --------------------------------------------------------------- 测试夹具 */

async function makeTempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `dsp-${label}-`))
}

function skillText(name, description, extra = {}, body = '正文') {
  const lines = ['---', `name: ${name}`, `description: '${description}'`]
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${value}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

async function writeSkill(root, name, options = {}) {
  const dir = path.join(root, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), skillText(name, options.description || `${name} 说明`, options.extra || {}, options.body || '正文'))
  return dir
}

/* --------------------------------------------------------------- 解析单测 */

test('parseSkillDoc 读取 frontmatter 与正文', () => {
  const doc = parseSkillDoc(skillText('alpha-skill', 'A skill', { whenToUse: 'when needed' }, 'hello'))
  assert.equal(doc.ok, true)
  assert.equal(doc.fields.name, 'alpha-skill')
  assert.equal(doc.fields.description, 'A skill')
  assert.equal(doc.fields.whenToUse, 'when needed')
  assert.equal(doc.body.trim(), 'hello')
})

test('parseSkillDoc 剥掉 BOM 并支持 CRLF', () => {
  const text = ('\uFEFF---\r\nname: beta\r\ndescription: x\r\n---\r\n\r\nbody\r\n')
  const doc = parseSkillDoc(text)
  assert.equal(doc.ok, true)
  assert.equal(doc.fields.name, 'beta')
})

test('parseSkillDoc 拒绝缺失 frontmatter', () => {
  assert.equal(parseSkillDoc('# just markdown').ok, false)
})

test('parseBoolean 严格布尔语法', () => {
  assert.equal(parseBoolean('true'), true)
  assert.equal(parseBoolean('YES'), true)
  assert.equal(parseBoolean('on'), true)
  assert.equal(parseBoolean('1'), true)
  assert.equal(parseBoolean('false'), false)
  assert.equal(parseBoolean('no'), false)
  assert.equal(parseBoolean('off'), false)
  assert.equal(parseBoolean('0'), false)
  assert.equal(parseBoolean('maybe'), undefined)
  assert.equal(parseBoolean(undefined), undefined)
})

test('setFrontmatterFlag 替换已有键且保留正文与其它键', () => {
  const source = skillText('gamma', '说明', { 'disable-model-invocation': 'false' }, 'keep me')
  const next = setFrontmatterFlag(source, 'disable-model-invocation', true)
  assert.match(next, /disable-model-invocation: true/)
  assert.equal(next.includes('false'), false)
  assert.match(next, /keep me/)
  assert.match(next, /description: '说明'/)
})

test('setFrontmatterFlag 插入缺失键', () => {
  const source = skillText('delta', '说明')
  const next = setFrontmatterFlag(source, 'user-invocable', false)
  assert.match(next, /user-invocable: false/)
  assert.ok(next.indexOf('user-invocable') < next.lastIndexOf('---'))
  const doc = parseSkillDoc(next)
  assert.equal(doc.ok, true)
  assert.equal(doc.fields.name, 'delta')
})

test('setFrontmatterFlag 保留 CRLF 结尾', () => {
  const source = '---\r\nname: eps\r\ndescription: x\r\n---\r\n\r\nbody\r\n'
  const next = setFrontmatterFlag(source, 'user-invocable', false)
  assert.ok(next.includes('\r\n'))
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false)
  assert.match(next, /user-invocable: false\r\n/)
})

/* --------------------------------------------------------------- 收集单测 */

test('collectSkills：项目层压过全局层，并记录 shadowed', async () => {
  const home = await makeTempDir('home')
  const project = await makeTempDir('project')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(home, 'skills'), 'shared-skill', { description: '全局版本' })
  await writeSkill(path.join(project, '.dsh', 'skills'), 'shared-skill', { description: '项目版本' })
  await writeSkill(path.join(home, 'skills'), 'only-global')

  const collection = await collectSkills({ projectRoot: project, dshHome: home, agentsHome: path.join(home, 'agents') })
  const shared = collection.skills.find((skill) => skill.name === 'shared-skill')
  assert.equal(shared.description, '项目版本')
  assert.equal(shared.scope, 'project')
  assert.equal(shared.shadowed.length, 1)
  assert.equal(shared.shadowed[0].source, 'user-dsh')
  const global = collection.skills.find((skill) => skill.name === 'only-global')
  assert.equal(global.scope, 'global')
  assert.equal(collection.diagnostics.length, 0)
})

test('collectSkills：坏条目进 diagnostics 而不是静默消失', async () => {
  const home = await makeTempDir('home2')
  const root = path.join(home, 'skills')
  await fsp.mkdir(path.join(root, 'no-frontmatter'), { recursive: true })
  await fsp.writeFile(path.join(root, 'no-frontmatter', 'SKILL.md'), '# nothing here')
  await fsp.mkdir(path.join(root, 'bad-name'), { recursive: true })
  await fsp.writeFile(path.join(root, 'bad-name', 'SKILL.md'), skillText('Bad_Name', '说明'))
  const collection = await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })
  assert.equal(collection.skills.length, 0)
  assert.equal(collection.diagnostics.length, 2)
})

test('collectSkills：识别本项目禁用占位', async () => {
  const home = await makeTempDir('home3')
  const project = await makeTempDir('project3')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(home, 'skills'), 'guarded-skill')
  await createStub(project, 'guarded-skill')

  const collection = await collectSkills({ projectRoot: project, dshHome: home, agentsHome: path.join(home, 'agents') })
  const entry = collection.skills.find((skill) => skill.name === 'guarded-skill')
  assert.equal(entry.stub, true)
  assert.equal(entry.modelInvocable, false)
  assert.equal(entry.userInvocable, false)
  assert.equal(entry.shadowed[0].source, 'user-dsh')
  assert.equal(entry.shadowed[0].modelInvocable, true)

  await removeStub(project, 'guarded-skill')
  const after = await collectSkills({ projectRoot: project, dshHome: home, agentsHome: path.join(home, 'agents') })
  const restored = after.skills.find((skill) => skill.name === 'guarded-skill')
  assert.equal(restored.scope, 'global')
})

test('setSkillFlags 同时改模型与命令两个开关', async () => {
  const home = await makeTempDir('home4')
  const root = path.join(home, 'skills')
  await writeSkill(root, 'flag-skill')
  const collection = await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })
  const location = await locateSkill(collection, 'flag-skill', 'user-dsh')
  await setSkillFlags(location, { model: false, user: false })
  const after = await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })
  const skill = after.skills.find((item) => item.name === 'flag-skill')
  assert.equal(skill.modelInvocable, false)
  assert.equal(skill.userInvocable, false)
  await setSkillFlags(location, { model: true })
  const again = (await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })).skills.find((item) => item.name === 'flag-skill')
  assert.equal(again.modelInvocable, true)
  assert.equal(again.userInvocable, false)
})

test('saveSkillDoc 拒绝把 name 改掉', async () => {
  const home = await makeTempDir('home5')
  const root = path.join(home, 'skills')
  await writeSkill(root, 'save-skill')
  const collection = await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })
  const location = await locateSkill(collection, 'save-skill', 'user-dsh')
  await assert.rejects(() => saveSkillDoc(location, skillText('other-name', '说明')), /不能改成另一个技能/)
  await saveSkillDoc(location, skillText('save-skill', '新说明'))
  const reloaded = await fsp.readFile(location.record.path, 'utf8')
  assert.match(reloaded, /新说明/)
})

test('createSkill 校验 kebab-case 与 description', async () => {
  const root = await makeTempDir('create')
  const file = await createSkill(root, { name: 'new-skill', description: '说明' })
  assert.ok(existsSync(file))
  await assert.rejects(() => createSkill(root, { name: 'BadName', description: 'x' }), /kebab-case/)
  await assert.rejects(() => createSkill(root, { name: 'another', description: '' }), /description/)
  await assert.rejects(() => createSkill(root, { name: 'new-skill', description: '重复' }), /已存在/)
})

test('moveToTrash 移动而不是删除', async () => {
  const home = await makeTempDir('home6')
  process.env.DSH_HOME = home
  const project = await makeTempDir('project6')
  const dir = await writeSkill(path.join(project, '.dsh', 'skills'), 'trash-skill')
  const destination = await moveToTrash(dir, 'trash-skill')
  assert.equal(existsSync(dir), false)
  assert.ok(existsSync(path.join(destination, 'SKILL.md')))
})

test('removeStub 拒绝删除非占位目录', async () => {
  const project = await makeTempDir('project7')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  await writeSkill(path.join(project, '.dsh', 'skills'), 'real-skill')
  await assert.rejects(() => removeStub(project, 'real-skill'), /不是本插件创建的禁用占位/)
  assert.ok(existsSync(path.join(project, '.dsh', 'skills', 'real-skill', 'SKILL.md')))
})

test('importFolder 支持单技能目录与上层目录', async () => {
  const source = await makeTempDir('src')
  await writeSkill(source, 'one-skill')
  const nested = await makeTempDir('src2')
  await writeSkill(nested, 'two-skill')
  await writeSkill(nested, 'three-skill')
  const target = await makeTempDir('target')

  const single = await importFolder(target, source)
  assert.equal(single.length, 1)
  assert.equal(single[0].ok, true)
  assert.ok(existsSync(path.join(target, 'one-skill', 'SKILL.md')))

  const many = await importFolder(target, nested)
  assert.equal(many.length, 2)
  assert.ok(many.every((item) => item.ok))
  const again = await importFolder(target, nested)
  assert.ok(again.every((item) => item.ok === false))
})

test('findProjectRoot 用最近的 .git 祖先', async () => {
  const project = await makeTempDir('repo')
  await fsp.mkdir(path.join(project, '.git'), { recursive: true })
  const nested = path.join(project, 'a', 'b')
  await fsp.mkdir(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), path.resolve(project))
  const orphan = await makeTempDir('orphan')
  assert.equal(findProjectRoot(orphan), path.resolve(orphan))
})

test('isInside 边界', () => {
  assert.equal(isInside('C:\\a', 'C:\\a\\b'), true)
  assert.equal(isInside('C:\\a', 'C:\\a'), false)
  assert.equal(isInside('C:\\a', 'C:\\b'), false)
})

test('writeTextAtomic 覆盖已有文件', async () => {
  const dir = await makeTempDir('atomic')
  const file = path.join(dir, 'SKILL.md')
  await fsp.writeFile(file, 'one')
  await writeTextAtomic(file, 'two')
  assert.equal(await fsp.readFile(file, 'utf8'), 'two')
})

/* ------------------------------------------------------------------ zip 构造 */

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

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const deflated = zlib.deflateRawSync(data)
    const method = 8
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, deflated)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + deflated.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

test('planZipSkills 解析目录形式的技能包', () => {
  const buffer = buildZip([
    { name: 'zip-skill/SKILL.md', data: skillText('zip-skill', '压缩包技能', {}, 'body') },
    { name: 'zip-skill/references/notes.md', data: 'notes' },
  ])
  const planned = planZipSkills(buffer)
  assert.equal(planned.skills.length, 1)
  assert.equal(planned.skills[0].name, 'zip-skill')
  assert.equal(planned.skills[0].entries.length, 2)
})

test('planZipSkills 解析根级 SKILL.md', () => {
  const buffer = buildZip([{ name: 'SKILL.md', data: skillText('root-skill', '根级技能') }])
  const planned = planZipSkills(buffer)
  assert.equal(planned.skills.length, 1)
  assert.equal(planned.skills[0].name, 'root-skill')
})

test('planZipSkills 拒绝路径穿越', () => {
  const buffer = buildZip([{ name: '../evil/SKILL.md', data: skillText('evil', 'x') }])
  assert.throws(() => planZipSkills(buffer), /不安全的路径/)
})

test('importZip 落盘并拒绝重名', async () => {
  const target = await makeTempDir('ziptarget')
  const buffer = buildZip([{ name: 'zip-skill/SKILL.md', data: skillText('zip-skill', '压缩包技能') }])
  const first = await importZip(target, buffer)
  assert.equal(first[0].ok, true)
  assert.ok(existsSync(path.join(target, 'zip-skill', 'SKILL.md')))
  const second = await importZip(target, buffer)
  assert.equal(second[0].ok, false)
})

test('collectSkills：平铺 .md 技能与点号目录', async () => {
  const home = await makeTempDir('home-flat')
  const root = path.join(home, 'skills')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'flat-skill.md'), skillText('flat-skill', '平铺技能'))
  await fsp.mkdir(path.join(root, '.system', 'hidden'), { recursive: true })
  await fsp.writeFile(path.join(root, '.system', 'hidden', 'SKILL.md'), skillText('hidden', '不该出现'))
  await fsp.mkdir(path.join(root, 'not-a-skill'), { recursive: true })

  const collection = await collectSkills({ projectRoot: undefined, dshHome: home, agentsHome: path.join(home, 'agents') })
  assert.deepEqual(collection.skills.map((skill) => skill.name), ['flat-skill'])
  assert.equal(collection.skills[0].kind, 'file')

  const location = await locateSkill(collection, 'flat-skill', 'user-dsh')
  await setSkillFlags(location, { model: false })
  const text = await fsp.readFile(path.join(root, 'flat-skill.md'), 'utf8')
  assert.match(text, /disable-model-invocation: true/)
})

test('importZip 根级 SKILL.md 用正文里的 name 落盘', async () => {
  const target = await makeTempDir('ziptarget3')
  const buffer = buildZip([{ name: 'SKILL.md', data: skillText('root-named', '根级技能') }])
  const results = await importZip(target, buffer)
  assert.equal(results[0].ok, true)
  assert.equal(results[0].name, 'root-named')
  assert.ok(existsSync(path.join(target, 'root-named', 'SKILL.md')))
})

test('importZip 拒绝非 zip 内容', async () => {
  const target = await makeTempDir('ziptarget2')
  await assert.rejects(() => importZip(target, Buffer.from('not a zip')), /不是有效的 zip/)
})
