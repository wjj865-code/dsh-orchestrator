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
  copyAsarTree,
  debugPresetDir,
  extractPluginsBlock,
  listAsarEntries,
  locateSourcePreset,
  materializeDebugPreset,
  prepareDebugPreset,
  readAsarFile,
  renderBundleManifest,
  renderBundlePatch,
  replaceSkillDirs,
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

test('调试子任务文档覆盖安装步骤、宿主重启与能力边界', () => {
  const doc = readFileSync(new URL('../docs/DEBUG-PRESET.md', import.meta.url), 'utf8')
  for (const needle of [
    'workerPreset', 'orch-debug', 'install_bundle', '彻底退出 DSH',
    'cordis_inspect_list', '不是沙箱', 'preset:debug', '.agent-presets', 'createRequire(baseUrl)',
  ]) {
    assert.match(doc, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `文档缺少：${needle}`)
  }
})
