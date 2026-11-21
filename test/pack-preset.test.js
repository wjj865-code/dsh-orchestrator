import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PACK_DENY_TOOLS, buildPresetDefinition, exportStaticPreset, renderPackPersona,
} from '../src/pack/preset-template.js'
import { loadBuiltinPacks, createPresetRegistry } from '../src/pack/preset-registry.js'
import { capabilityPacksUsable, isDesktopHost } from '../src/pack/platform.js'
import { validateManifest } from '../src/pack/manifest.js'
import { validManifest } from './pack-fixtures.js'

// P2：预设模板与内置公众号包。守三件真会坏的事：
//   1. 包会话工具面（不能有 task_* / capability_pack；必须有写/执行/skill）；
//   2. customSkillDirs 是**绝对路径**（平台 resolve(root) 后相对路径会解析到宿主 cwd）；
//   3. 内置包三技能真的存在且 frontmatter 合法（发版漏文件 = 会话里技能消失）。

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const packRoot = join(ROOT, 'packs', 'wechat-mp-article')

test('P2 内置公众号包：manifest 合法、三个技能文件都在', () => {
  const packs = loadBuiltinPacks()
  const wechat = packs.find(item => item.id === 'wechat-mp-article')
  assert.ok(wechat, `内置包未加载：${packs.map(item => item.id).join('、')}`)
  assert.deepEqual(wechat.errors, [], wechat.errors.join('；'))
  assert.deepEqual(wechat.manifest.skills.map(item => item.name), ['wechat-mp-writer', 'wechat-mp-format', 'wechat-mp-draft'])
  assert.equal(wechat.manifest.publisher, 'builtin')
  assert.equal(wechat.manifest.cli[0].install.package, '@wenyan-md/cli')
  assert.equal(wechat.manifest.cli[0].install.version, '2.0.12')
  assert.deepEqual(wechat.manifest.env.map(item => item.ref), ['WECHAT_APP_ID', 'WECHAT_APP_SECRET'])
})

test('P2 预设行：包名与 cordis.patch.yml 的 worker 预设同源（不引不存在的插件包）', () => {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const manifest = validateManifest(validManifest()).manifest
  const definition = buildPresetDefinition({
    manifest, packRoot, installStatePath: join(packRoot, '.state', 'install.json'), stateDir: 'C:/state', platform: 'win32',
  })
  for (const plugin of definition.plugins) {
    if (plugin.name === 'cordis:group') continue
    assert.ok(yml.includes(plugin.name), `预设行 ${plugin.id} 引用的包不在 cordis.patch.yml：${plugin.name}`)
  }
  const ids = definition.plugins.map(row => row.id)
  for (const required of ['persona', 'agent-instructions', 'tool-fs', 'tool-fs-search', 'tool-todo', 'tool-web', 'skill-filesystem', 'tool-skill', 'preset-tools', 'present']) {
    assert.ok(ids.includes(required), `缺少预设行：${required}`)
  }
  // Windows 开 pwsh、关 bash（与 worker 预设同口径）。
  const bash = definition.plugins.find(row => row.id === 'tool-bash')
  const pwsh = definition.plugins.find(row => row.id === 'tool-pwsh')
  assert.equal(bash.disabled, true)
  assert.equal(pwsh.disabled, false)
})

test('P2 预设行：customSkillDirs 是绝对路径，工具面禁编排能力', () => {
  const manifest = validateManifest(validManifest()).manifest
  const definition = buildPresetDefinition({
    manifest, packRoot: 'C:\\packs\\demo', installStatePath: 'C:\\state\\install.json', stateDir: 'C:/state', platform: 'linux',
  })
  const skillRow = definition.plugins.find(row => row.id === 'skill-filesystem')
  assert.deepEqual(skillRow.config.customSkillDirs, ['C:\\packs\\demo\\skills'])
  assert.match(skillRow.config.customSkillDirs[0], /^(?:[A-Za-z]:|[\\/])/)
  const presetTools = definition.plugins.find(row => row.id === 'preset-tools').config
  for (const denied of ['task_create', 'task_report', 'plan_save', 'capability_pack']) {
    assert.ok(presetTools.deny.includes(denied), `必须 deny ${denied}`)
  }
  assert.deepEqual(presetTools.keep, ['context'])
  assert.deepEqual(PACK_DENY_TOOLS.length, 8)
  // Linux 侧：bash 开、pwsh 关。
  assert.equal(definition.plugins.find(row => row.id === 'tool-bash').disabled, false)
  assert.equal(definition.plugins.find(row => row.id === 'tool-pwsh').disabled, true)
})

test('P2 persona：只给解析规则，不写死「已安装/已设置」', () => {
  const manifest = validateManifest(validManifest()).manifest
  const persona = renderPackPersona({
    manifest, installStatePath: 'C:/state/packs/demo/.state/install.json', stateDir: 'C:/state', workspaceDir: 'D:/work',
  })
  assert.match(persona, /install\.json/)
  assert.match(persona, /APPDATA/)
  assert.match(persona, /不写台账/)
  assert.match(persona, /capability_pack/)
  assert.doesNotMatch(persona, /已安装/, 'persona 不能声称已安装（必须现场读 install.json）')
  assert.doesNotMatch(persona, /WECHAT_APP_SECRET=/)
})

test('P2 静态兜底：导出的 YAML 含 insert 行、预设 id 与全部插件行', () => {
  const manifest = validateManifest(validManifest()).manifest
  const definition = buildPresetDefinition({
    manifest, packRoot: 'C:\\packs\\demo', installStatePath: 'C:\\state\\i.json', stateDir: 'C:/state',
  })
  const yaml = exportStaticPreset(definition)
  assert.match(yaml, /insert:/)
  assert.match(yaml, /@deepseek-ai\/dsh-agent-preset/)
  assert.match(yaml, new RegExp(`id: ${definition.id}`))
  for (const plugin of definition.plugins) assert.ok(yaml.includes(plugin.name), `YAML 缺少 ${plugin.name}`)
  assert.match(yaml, /彻底退出 DSH/)
})

test('P2 Desktop 判定：三条信号任一成立即 Desktop；配置开关是唯一 Web 覆盖', () => {
  assert.equal(isDesktopHost({ env: {}, argv: [], versions: {} }), false)
  assert.equal(isDesktopHost({ env: { ELECTRON_RUN_AS_NODE: '1' }, argv: [], versions: {} }), true)
  assert.equal(isDesktopHost({ env: {}, argv: [], versions: { electron: '39.0.0' } }), true)
  assert.equal(isDesktopHost({ env: {}, argv: ['C:/x/app.asar/dsh/cli.js'], versions: {} }), true)
  assert.equal(isDesktopHost({ env: {}, argv: [], versions: {}, profileName: 'desktop' }), true)

  const base = { capabilityPacks: true, capabilityPacksAllowOnWeb: false }
  assert.equal(capabilityPacksUsable(base, { desktop: true }).ok, true)
  assert.equal(capabilityPacksUsable(base, { desktop: false }).code, 'PLATFORM_UNSUPPORTED')
  assert.equal(capabilityPacksUsable({ ...base, capabilityPacksAllowOnWeb: true }, { desktop: false }).ok, true)
  assert.equal(capabilityPacksUsable({ ...base, capabilityPacks: false }, { desktop: true }).code, 'CAPABILITY_PACKS_DISABLED')
})

test('P2 注册表：服务缺失 → static 兜底，不抛', async () => {
  const warnings = []
  const registry = createPresetRegistry({ agentPresets: () => undefined, onWarn: message => warnings.push(message) })
  const result = await registry.register({ id: 'x-preset', name: 'x', description: '', order: 1, plugins: [] })
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'static')
  assert.match(result.error, /agentPresets/)
  assert.equal(registry.runtimeAvailable(), false)
  assert.equal(await registry.unregister('x-preset'), false)
})

test('P2 注册表：runtime 注册/替换/撤销；register 失败降级', async () => {
  const calls = []
  let fail = false
  const host = {
    register: definition => {
      calls.push(['register', definition.id])
      if (fail) throw new Error('rc 拒绝')
      return () => calls.push(['unregister', definition.id])
    },
    list: () => [{ id: 'standard' }],
  }
  const registry = createPresetRegistry({ agentPresets: () => host })
  const definition = { id: 'p-pack', name: 'p', description: '', order: 1, plugins: [] }
  const first = await registry.register(definition)
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'runtime')
  assert.equal(registry.isRegistered('p-pack'), true)
  await registry.register(definition)
  assert.deepEqual(calls, [['register', 'p-pack'], ['unregister', 'p-pack'], ['register', 'p-pack']])
  assert.deepEqual(registry.hostIds(), ['standard'])
  assert.equal(await registry.unregister('p-pack'), true)
  assert.equal(registry.isRegistered('p-pack'), false)
  fail = true
  const failed = await registry.register({ ...definition, id: 'q-pack' })
  assert.equal(failed.ok, false)
  assert.equal(failed.mode, 'static')
  assert.match(failed.error, /rc 拒绝/)
})
