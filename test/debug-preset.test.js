import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEBUG_PRESET_ID,
  DEBUG_PRESET_ORDER,
  SKILLS_ENTRY,
  SOURCE_PRESET_ENTRY,
  checkDebugPreset,
  comparePresetPlugins,
  copyAsarTree,
  customSkillDirOf,
  debugPresetDir,
  extractPluginsBlock,
  listAsarEntries,
  locateSourcePreset,
  materializeDebugPreset,
  normalizeSkillDirsBlock,
  prepareDebugPreset,
  readAsarFile,
  renderBundleManifest,
  renderBundlePatch,
  replaceSkillDirs,
  skillNamesOf,
  splitPluginRows,
} from '../src/debug-preset.js'

// 结构照抄随包发货的 presets/cordis.patch.yml（去掉长 prompt，保留分组/块量与 !!js 行）。
const CORDIS_PATCH = `# 随包发货示例
- insert:
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        order: 4
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You are a coding agent.
                You help the user customize DeepSeek Harness itself.
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: planning
            name: cordis:group
            group: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                    Stay in plan mode.

                    Explore first.
          - id: tool-cordis
            name: '@deepseek-ai/dsh-tool-cordis'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
            config:
              customSkillDirs:
                - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'

- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins:
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
`

const tempDir = () => mkdtempSync(join(tmpdir(), 'orch-debug-preset-'))

function writeSource(dir, text = CORDIS_PATCH) {
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * 造一个和 Electron asar 同布局的最小归档：
 * 16 字节 pickle 头（u32(4) 负载大小 / u32(8) 目录长度 / u32(12) 目录长度）+ 目录 JSON + 内容区。
 */
function buildAsar(files) {
  const header = { files: {} }
  const contents = []
  let offset = 0
  for (const file of files) {
    const parts = file.path.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) {
      if (node.files[part] === undefined) node.files[part] = { files: {} }
      node = node.files[part]
    }
    const buffer = Buffer.from(file.content, 'utf8')
    node.files[parts.at(-1)] = { size: buffer.length, offset: String(offset) }
    contents.push(buffer)
    offset += buffer.length
  }
  const directory = Buffer.from(JSON.stringify(header), 'utf8')
  const contentStart = 16 + directory.length
  const box = Buffer.alloc(16)
  box.writeUInt32LE(4, 0)
  box.writeUInt32LE(contentStart - 8, 4) // 读取方按 8 + u32(4) 算内容区起点
  box.writeUInt32LE(directory.length, 8)
  box.writeUInt32LE(directory.length, 12)
  return Buffer.concat([box, directory, ...contents])
}

test('extractPluginsBlock 抠出 cordis 的 plugins 列表并统一左移', () => {
  const plugins = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  assert.ok(plugins !== undefined)
  assert.match(plugins, /^- id: persona$/m)
  assert.match(plugins, /^  name: '@deepseek-ai\/dsh-persona'$/m)
  // 块量内容保持相对缩进（section 从 18 列左移到 8 列，正文 20 → 10）。
  assert.match(plugins, /^ {8}section: \|$/m)
  assert.match(plugins, /^ {10}Stay in plan mode\.$/m)
  assert.match(plugins, /^ {10}Explore first\.$/m)
  // !!js 行必须原样保留（预设组合靠它按平台禁用插件）。
  assert.match(plugins, /disabled: !!js process\.platform !== 'win32'/)
  // 到下一个声明行（preset-standard）就停，不把别的预设的插件带进来。
  assert.doesNotMatch(plugins, /preset-standard/)
  assert.doesNotMatch(plugins, /tool-fs/)
  assert.equal(plugins.endsWith('\n'), false, '尾部空行应被裁掉')
})

test('extractPluginsBlock 找不到声明行返回 undefined', () => {
  assert.equal(extractPluginsBlock(CORDIS_PATCH, 'nope'), undefined)
  assert.equal(extractPluginsBlock('', 'cordis'), undefined)
  assert.equal(extractPluginsBlock('not: yaml'), undefined)
})

test('renderBundlePatch 生成 preset-orch-debug 声明，plugins 原样嵌进 config.plugins', () => {
  const plugins = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const patch = renderBundlePatch({ plugins })
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^    - id: preset-orch-debug$/m)
  assert.match(patch, /^      name: '@deepseek-ai\/dsh-agent-preset'$/m)
  assert.match(patch, /^        id: orch-debug$/m)
  assert.match(patch, new RegExp(`^        order: ${DEBUG_PRESET_ORDER}$`, 'm'))
  // plugins 行统一缩到 10 列，列表项落在 10，块量正文落在 18。
  assert.match(patch, /^        plugins:$/m)
  assert.match(patch, /^          - id: persona$/m)
  assert.match(patch, /^ {18}section: \|$/m)
  assert.match(patch, /^ {20}Stay in plan mode\.$/m)
  assert.match(patch, /disabled: !!js process\.platform !== 'win32'/)
  assert.doesNotMatch(patch, /^\s*id: cordis$/m, '新预设不能再叫 cordis（会覆盖随包预设）')
  assert.equal(patch.endsWith('\n'), true)
  assert.throws(() => renderBundlePatch({ plugins: '   ' }), /需要非空的 plugins/)
})

test('renderBundleManifest 指向同目录补丁', () => {
  const manifest = JSON.parse(renderBundleManifest())
  assert.equal(manifest.name, '@local/dsh-orch-debug-preset')
  assert.equal(manifest.private, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('materializeDebugPreset 落两个文件，重复执行幂等', () => {
  const outDir = join(tempDir(), 'orch-debug')
  const plugins = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const first = materializeDebugPreset({ outDir, plugins })
  assert.equal(first.ok, true)
  assert.deepEqual(first.files, [join(outDir, 'package.json'), join(outDir, 'cordis.patch.yml')])
  assert.equal(readFileSync(join(outDir, 'cordis.patch.yml'), 'utf8'), first.patch)
  assert.equal(JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')).dsh.bundle.patch, './cordis.patch.yml')
  const second = materializeDebugPreset({ outDir, plugins })
  assert.equal(second.ok, true)
  assert.equal(second.patch, first.patch)
})

test('materializeDebugPreset 写不进去时降级成可读原因（不抛）', () => {
  const dir = tempDir()
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x', 'utf8')
  const result = materializeDebugPreset({ outDir: join(blocker, 'orch-debug'), plugins: '- id: persona\n  name: x' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write-failed')
  assert.match(result.hint, /写入/)
})

test('debugPresetDir 落在 state/orchestrator/debug-presets/orch-debug', () => {
  assert.equal(debugPresetDir(join('C:', 'home', 'state', 'orchestrator')),
    join('C:', 'home', 'state', 'orchestrator', 'debug-presets', DEBUG_PRESET_ID))
})

test('replaceSkillDirs 把 baseUrl 解析换成 bundle 绝对路径，传 undefined 时整段删掉', () => {
  const plugins = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const skillDir = join('C:', 'bundle', 'skills')
  const withDir = replaceSkillDirs(plugins, skillDir)
  assert.match(withDir, /^ {4}customSkillDirs:$/m)
  assert.ok(withDir.includes(`'${skillDir}'`), `缺少技能目录：${skillDir}`)
  assert.doesNotMatch(withDir, /createRequire\(baseUrl\)/)
  assert.match(withDir, /^- id: tool-skill$/m, '同一行组里的其他行不能丢')

  const removed = replaceSkillDirs(plugins, undefined)
  assert.doesNotMatch(removed, /customSkillDirs/)
  assert.doesNotMatch(removed, /createRequire\(baseUrl\)/)
  assert.match(removed, /^ {2}name: '@deepseek-ai\/dsh-skill-filesystem'$/m)

  // 没有 skill-filesystem 行时原样返回（不硬塞配置）。
  const noRow = replaceSkillDirs('- id: persona\n  name: x', 'C:/skills')
  assert.equal(noRow, '- id: persona\n  name: x')
})

test('prepareDebugPreset 从本地补丁文件复制 cordis 组合（无技能源时删掉 customSkillDirs）', () => {
  const dir = tempDir()
  const source = writeSource(dir)
  const outDir = join(dir, 'bundle')
  const result = prepareDebugPreset({ outDir, source, env: {}, platform: 'linux' })
  assert.equal(result.ok, true, result.hint)
  assert.equal(result.source.kind, 'file')
  assert.equal(result.source.path, source)
  assert.equal(result.skills, 'skipped:no-asar-source')
  const patch = readFileSync(join(outDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: orch-debug/)
  assert.match(patch, /- id: tool-cordis/)
  // 源码检出的补丁没有技能来源：必须删掉那段 baseUrl 解析，否则声明会在 profile 里解析失败。
  assert.doesNotMatch(patch, /customSkillDirs/)
  assert.doesNotMatch(patch, /createRequire\(baseUrl\)/)
})

test('prepareDebugPreset 能从 app.asar 里读源预设（Desktop 安装形态）', () => {
  const dir = tempDir()
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar([{ path: SOURCE_PRESET_ENTRY, content: CORDIS_PATCH }]))
  const outDir = join(dir, 'bundle')
  const result = prepareDebugPreset({ outDir, env: { DSH_ASAR: asarPath }, platform: 'linux' })
  assert.equal(result.ok, true, result.hint)
  assert.equal(result.source.kind, 'asar')
  assert.equal(result.source.entry, SOURCE_PRESET_ENTRY)
  // 归档里没有 skills 目录：技能跳过，但补丁仍然可用（不写坏表达式）。
  assert.equal(result.skills, 'skipped:entry-missing')
  const patch = readFileSync(join(outDir, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /customSkillDirs/)
})

test('prepareDebugPreset 把 dsh-doc 技能抄进 bundle，customSkillDirs 指向本地目录', () => {
  const dir = tempDir()
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar([
    { path: SOURCE_PRESET_ENTRY, content: CORDIS_PATCH },
    { path: `${SKILLS_ENTRY}/dsh-doc/SKILL.md`, content: '# dsh-doc\n' },
    { path: `${SKILLS_ENTRY}/dsh-doc/references/packages.md`, content: 'packages\n' },
  ]))
  const outDir = join(dir, 'bundle')
  const result = prepareDebugPreset({ outDir, env: { DSH_ASAR: asarPath }, platform: 'linux' })
  assert.equal(result.ok, true, result.hint)
  assert.equal(result.skills, 'copied:2')
  assert.equal(result.skillDir, join(outDir, 'skills'))
  assert.equal(readFileSync(join(outDir, 'skills', 'dsh-doc', 'SKILL.md'), 'utf8'), '# dsh-doc\n')
  const patch = readFileSync(join(outDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^ {14}customSkillDirs:$/m)
  assert.ok(patch.includes(`'${join(outDir, 'skills')}'`), patch)
  assert.doesNotMatch(patch, /createRequire\(baseUrl\)/)
})

test('prepareDebugPreset 支持 --skills-dir 指定技能目录 / --no-skills 关掉', () => {
  const dir = tempDir()
  const source = writeSource(dir)
  const external = join(dir, 'my-skills')
  const withExternal = prepareDebugPreset({ outDir: join(dir, 'a'), source, skillsDir: external, env: {}, platform: 'linux' })
  assert.equal(withExternal.ok, true, withExternal.hint)
  assert.equal(withExternal.skills, 'external')
  assert.match(readFileSync(join(dir, 'a', 'cordis.patch.yml'), 'utf8'), new RegExp(`'${external.replace(/\\/g, '\\\\')}'`))

  const disabled = prepareDebugPreset({ outDir: join(dir, 'b'), source, skills: false, env: {}, platform: 'linux' })
  assert.equal(disabled.ok, true, disabled.hint)
  assert.equal(disabled.skills, 'skipped:disabled')
  assert.doesNotMatch(readFileSync(join(dir, 'b', 'cordis.patch.yml'), 'utf8'), /customSkillDirs/)
})

test('listAsarEntries / copyAsarTree 只列给定目录并原样落盘', () => {
  const dir = tempDir()
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar([
    { path: `${SKILLS_ENTRY}/dsh-doc/SKILL.md`, content: 'a' },
    { path: `${SKILLS_ENTRY}/dsh-doc/templates/x/cordis.patch.yml`, content: 'b' },
    { path: 'elsewhere/other.md', content: 'c' },
  ]))
  assert.deepEqual(listAsarEntries(asarPath, SKILLS_ENTRY).map(item => item.path).sort(),
    ['dsh-doc/SKILL.md', 'dsh-doc/templates/x/cordis.patch.yml'])
  assert.equal(listAsarEntries(asarPath, 'nope'), undefined)
  const copied = copyAsarTree(asarPath, SKILLS_ENTRY, join(dir, 'out'))
  assert.equal(copied.ok, true)
  assert.equal(copied.files.length, 2)
  assert.equal(readFileSync(join(dir, 'out', 'dsh-doc', 'templates', 'x', 'cordis.patch.yml'), 'utf8'), 'b')
  assert.equal(copyAsarTree(asarPath, 'nope', join(dir, 'out2')).reason, 'entry-missing')
})

test('readAsarFile 读不到条目时返回 undefined（不抛）', () => {
  const dir = tempDir()
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar([{ path: 'other/file.txt', content: 'hi' }]))
  assert.equal(readAsarFile(asarPath, SOURCE_PRESET_ENTRY), undefined)
  assert.equal(readAsarFile(asarPath, 'other/file.txt'), 'hi')
  assert.equal(readAsarFile(join(dir, 'missing.asar'), SOURCE_PRESET_ENTRY), undefined)
  writeFileSync(join(dir, 'broken.asar'), 'not an asar', 'utf8')
  assert.equal(readAsarFile(join(dir, 'broken.asar'), SOURCE_PRESET_ENTRY), undefined)
})

test('找不到源组合时降级：no-source + 已尝试路径', () => {
  const dir = tempDir()
  const result = prepareDebugPreset({ outDir: join(dir, 'bundle'), env: {}, platform: 'linux' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-source')
  assert.match(result.hint, /--source/)
})

test('源文件里没有 preset-cordis 时降级：no-preset-row', () => {
  const dir = tempDir()
  const source = writeSource(dir, '- insert:\n    - id: preset-minimal\n      name: x\n')
  const result = prepareDebugPreset({ outDir: join(dir, 'bundle'), source, env: {}, platform: 'linux' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-preset-row')
  assert.match(result.hint, /preset-cordis/)
})

test('locateSourcePreset 记录尝试过的候选路径', () => {
  const located = locateSourcePreset({ env: { DSH_ASAR: join(tempDir(), 'nope.asar') }, platform: 'linux' })
  assert.equal(located.ok, false)
  assert.equal(located.reason, 'no-source')
  assert.ok(located.tried.some(item => item.includes('nope.asar')), located.tried.join(' | '))
})

test('locateSourcePreset 支持 Electron resourcesPath 候选', () => {
  const resourcesPath = tempDir()
  mkdirSync(resourcesPath, { recursive: true })
  writeFileSync(join(resourcesPath, 'app.asar'),
    buildAsar([{ path: SOURCE_PRESET_ENTRY, content: CORDIS_PATCH }]))
  const located = locateSourcePreset({ env: {}, platform: 'linux', resourcesPath })
  assert.equal(located.ok, true)
  assert.equal(located.kind, 'asar')
})

test('splitPluginRows 按顶层插件行切分，组内子行随父行保留', () => {
  const plugins = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const rows = splitPluginRows(plugins)
  assert.deepEqual(rows.map(row => row.id),
    ['persona', 'tool-pwsh', 'planning', 'tool-cordis', 'skill-filesystem', 'tool-skill'])
  const planning = rows.find(row => row.id === 'planning')
  assert.match(planning.text, /^ {4}- id: plan-mode$/m, '组内子行留在 planning 行文本里，不单列')
  assert.equal(planning.disabled, '')
  assert.equal(rows.find(row => row.id === 'tool-pwsh').disabled, "!!js process.platform !== 'win32'")
})

test('comparePresetPlugins 对生成物返回 aligned（技能根落点不算差异）', () => {
  const source = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const generated = extractPluginsBlock(
    renderBundlePatch({ plugins: replaceSkillDirs(source, join('C:', 'bundle', 'skills')) }),
    DEBUG_PRESET_ID,
  )
  const comparison = comparePresetPlugins(source, generated)
  assert.equal(comparison.aligned, true, JSON.stringify(comparison.differences))
  assert.equal(comparison.sourceRows, 6)
  assert.equal(comparison.generatedRows, 6)
  assert.deepEqual(comparison.differences, [])
})

test('comparePresetPlugins 指出缺少/多出/包名/权限条件/配置差异', () => {
  const source = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const rowText = id => splitPluginRows(source).find(row => row.id === id).text

  const missing = comparePresetPlugins(source, source.replace(`${rowText('tool-cordis')}\n`, ''))
  assert.equal(missing.aligned, false)
  assert.ok(missing.differences.some(d => d.kind === 'missing' && d.id === 'tool-cordis'), JSON.stringify(missing.differences))

  const extra = comparePresetPlugins(source, `${source}\n- id: tool-extra\n  name: '@x/y'`)
  assert.ok(extra.differences.some(d => d.kind === 'extra' && d.id === 'tool-extra'), JSON.stringify(extra.differences))

  const renamed = comparePresetPlugins(source,
    source.replace("name: '@deepseek-ai/dsh-tool-cordis'", "name: '@deepseek-ai/dsh-tool-other'"))
  assert.ok(renamed.differences.some(d => d.kind === 'name' && d.id === 'tool-cordis'), JSON.stringify(renamed.differences))

  const ungated = comparePresetPlugins(source,
    source.replace("disabled: !!js process.platform !== 'win32'", 'disabled: !!js false'))
  assert.ok(ungated.differences.some(d => d.kind === 'disabled' && d.id === 'tool-pwsh'), JSON.stringify(ungated.differences))

  const promptChanged = comparePresetPlugins(source,
    source.replace('You are a coding agent.', 'You are a debugging agent.'))
  assert.ok(promptChanged.differences.some(d => d.kind === 'config' && d.id === 'persona'), JSON.stringify(promptChanged.differences))
  assert.match(promptChanged.differences.find(d => d.id === 'persona').detail, /第 \d+ 行/)
})

test('normalizeSkillDirsBlock 抹平技能根；customSkillDirOf 读生成物路径', () => {
  const source = extractPluginsBlock(CORDIS_PATCH, 'cordis')
  const generated = replaceSkillDirs(source, 'C:/bundle/skills')
  assert.match(source, /createRequire\(baseUrl\)/)
  assert.doesNotMatch(normalizeSkillDirsBlock(source), /createRequire/)
  assert.equal(normalizeSkillDirsBlock(source), normalizeSkillDirsBlock(generated))
  assert.equal(customSkillDirOf(source), undefined, '源组合的 !!js 表达式不是可检查的本地路径')
  assert.equal(customSkillDirOf(generated), 'C:/bundle/skills')
  // yamlQuote 把单引号写成两个，读回来要还原。
  assert.equal(customSkillDirOf(replaceSkillDirs(source, "C:/it's/skills")), "C:/it's/skills")
})

test('skillNamesOf 列出技能根下的目录，读不到时返回空数组', () => {
  const dir = join(tempDir(), 'skills')
  mkdirSync(join(dir, 'dsh-doc'), { recursive: true })
  mkdirSync(join(dir, 'other'), { recursive: true })
  writeFileSync(join(dir, 'notes.md'), 'x', 'utf8')
  assert.deepEqual(skillNamesOf(dir), ['dsh-doc', 'other'])
  assert.deepEqual(skillNamesOf(join(dir, 'nope')), [])
  assert.deepEqual(skillNamesOf(undefined), [])
})

test('prepareDebugPreset 自检：plugins 与源组合对齐并报告技能目录', () => {
  const dir = tempDir()
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar([
    { path: SOURCE_PRESET_ENTRY, content: CORDIS_PATCH },
    { path: `${SKILLS_ENTRY}/dsh-doc/SKILL.md`, content: '# dsh-doc\n' },
  ]))
  const result = prepareDebugPreset({ outDir: join(dir, 'bundle'), env: { DSH_ASAR: asarPath }, platform: 'linux' })
  assert.equal(result.ok, true, result.hint)
  assert.equal(result.alignment.aligned, true, JSON.stringify(result.alignment.differences))
  assert.deepEqual(result.alignment.differences, [])
  assert.deepEqual(result.skillNames, ['dsh-doc'])
})

test('checkDebugPreset：刚生成时对齐，组合漂移时给出逐行差异', () => {
  const dir = tempDir()
  const source = writeSource(dir)
  const outDir = join(dir, 'bundle')
  const made = prepareDebugPreset({ outDir, source, env: {}, platform: 'linux' })
  assert.equal(made.ok, true, made.hint)

  const clean = checkDebugPreset({ outDir, source, env: {}, platform: 'linux' })
  assert.equal(clean.ok, true, clean.hint)
  assert.equal(clean.plugins, 6)
  assert.equal(clean.skills.dshDoc, false, '普通文件源没有技能复制：检查只报告，不算漂移')

  const patchPath = join(outDir, 'cordis.patch.yml')
  const drifted = readFileSync(patchPath, 'utf8').replace(
    '          - id: tool-cordis\n',
    "          - id: tool-cordis\n          - id: tool-extra\n            name: '@x/y'\n",
  )
  writeFileSync(patchPath, drifted, 'utf8')
  const broken = checkDebugPreset({ outDir, source, env: {}, platform: 'linux' })
  assert.equal(broken.ok, false)
  assert.equal(broken.reason, 'drift')
  assert.ok(broken.differences.some(d => d.kind === 'extra' && d.id === 'tool-extra'), JSON.stringify(broken.differences))
  assert.match(broken.hint, /重新跑 pnpm run preset:debug/)

  const absent = checkDebugPreset({ outDir: join(dir, 'nope'), source, env: {}, platform: 'linux' })
  assert.equal(absent.ok, false)
  assert.equal(absent.reason, 'missing-bundle')
})

test('调试子任务文档覆盖安装步骤、宿主重启与能力边界', () => {
  const doc = readFileSync(new URL('../docs/DEBUG-PRESET.md', import.meta.url), 'utf8')
  for (const needle of [
    'workerPreset', 'orch-debug', 'install_bundle', '彻底退出 DSH',
    'cordis_inspect_list', '不是沙箱', 'preset:debug', '.agent-presets', 'createRequire(baseUrl)',
    '--check', 'plugin_manager', 'client-hmr', 'restart-required', '动态',
  ]) {
    assert.match(doc, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `文档缺少：${needle}`)
  }
})
