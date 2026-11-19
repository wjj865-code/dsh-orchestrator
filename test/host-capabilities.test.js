// P0-2b：宿主能力访问层的单测（首片：版本探测 / settings / 日志路径）。
//
// 为什么单测重点在「缺什么」而不是「有什么」：这一层的价值是**能力缺失时不崩、不静默改行为**。
// 所以每个用例都从空上下文 / 坏服务 / 坏清单出发，再补正例；另外锁住 9 类 coupling id，
// 防止文档（docs/compat.md）与代码悄悄漂移。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOST_BASELINE,
  PANEL_SLOTS,
  compareVersions,
  createHostCapabilities,
  manifestFromArgv,
  parseVersion,
  readHostVersion,
  stateDirFrom,
  versionStatus,
} from '../src/host-capabilities.js'

/** 9 类宿主耦合点的稳定 id（与 docs/compat.md 的表同口径）。 */
const COUPLING_IDS = [
  'team-api', 'session-create', 'settings', 'registry', 'token-meter',
  'session-query', 'panel-slots', 'log-path', 'version',
]

const quiet = () => []

test('空上下文：9 类访问器全部降级、不抛；report 如实报缺失', () => {
  const host = createHostCapabilities({})
  for (const accessor of [
    'agents', 'subagents', 'sessionController', 'sessions', 'agentPresets', 'settings',
    'workspaceRegistry', 'tokenMeter', 'sessionQuery', 'connection', 'sandboxPolicy',
    'planMode', 'goals', 'schedule', 'sessionPersistence', 'workspaceChanges',
  ]) {
    assert.equal(host[accessor](), undefined, `${accessor} 缺失时应返回 undefined，而不是抛`)
  }
  assert.deepEqual(host.slots(), PANEL_SLOTS)
  assert.equal(typeof host.stateDir(), 'string')

  const report = host.report()
  assert.equal(report.total, 9)
  assert.deepEqual(report.couplings.map(row => row.id), COUPLING_IDS)
  assert.equal(report.available, 2, '空上下文只有「面板 slot」「日志路径」天然可用')
  assert.deepEqual(report.missing, ['team-api', 'session-create', 'settings', 'registry', 'token-meter', 'session-query', 'version'])
  assert.equal(report.version.status, 'unknown')
})

test('ctx.get 抛错（加载中/卸载中）按「当前不可用」处理，不上抛', () => {
  const host = createHostCapabilities({
    get() { throw new Error('waiting for service') },
  })
  assert.equal(host.settings(), undefined)
  assert.equal(host.report().available, 2)
})

test('settings 首片接入点：宿主有 settings 服务即计为可用，没有也不 warn', () => {
  const warnings = quiet()
  const sentinel = { describe: () => ({}) }
  const withSettings = createHostCapabilities({ get: name => (name === 'settings' ? sentinel : undefined) }, { onWarn: message => warnings.push(message) })
  assert.equal(withSettings.settings(), sentinel)
  const row = withSettings.report().couplings.find(item => item.id === 'settings')
  assert.equal(row.available, true)

  const without = createHostCapabilities({}, { onWarn: message => warnings.push(message) })
  assert.equal(without.report().couplings.find(item => item.id === 'settings').available, false)
  assert.deepEqual(warnings, [], '可选服务缺失不该打扰用户（只有版本越界才 warn）')
})

test('report 每次现算：晚加载的服务能被看到（不永久缓存 unavailable）', () => {
  const services = new Map()
  const host = createHostCapabilities({ get: name => services.get(name) })
  assert.equal(host.report().couplings.find(item => item.id === 'registry').available, false)
  services.set('workspaceRegistry', { archiveSession() {} })
  assert.equal(host.report().couplings.find(item => item.id === 'registry').available, true)
})

test('warnOnce：同一 key 每进程只告警一次', () => {
  const warnings = quiet()
  const host = createHostCapabilities({}, { onWarn: message => warnings.push(message) })
  assert.equal(host.warnOnce('k', 'first'), true)
  assert.equal(host.warnOnce('k', 'second'), false)
  assert.equal(host.warnOnce('other', 'third'), true)
  assert.deepEqual(warnings, ['first', 'third'])
})

test('状态/日志路径：$DSH_HOME 优先，空白与缺失回落 ~/.dsh（不碰进程环境）', () => {
  assert.equal(stateDirFrom({ env: { DSH_HOME: 'tmp/dsh' }, home: 'home/x' }), join('tmp/dsh', 'state', 'orchestrator'))
  assert.equal(stateDirFrom({ env: { DSH_HOME: '   ' }, home: 'home/x' }), join('home/x', '.dsh', 'state', 'orchestrator'))
  assert.equal(stateDirFrom({ env: {}, home: 'home/x' }), join('home/x', '.dsh', 'state', 'orchestrator'))

  const host = createHostCapabilities({}, { env: { DSH_HOME: 'tmp/dsh' }, home: 'home/x' })
  assert.equal(host.stateDir(), join('tmp/dsh', 'state', 'orchestrator'))
  assert.equal(host.logDir(), join('tmp/dsh', 'state', 'orchestrator', 'logs'))
})

test('版本解析与比较：预发布优先级、数字标识符、非法值', () => {
  assert.deepEqual(parseVersion('0.2.2-rc.3'), { major: 0, minor: 2, patch: 2, prerelease: ['rc', '3'] })
  assert.deepEqual(parseVersion('v0.2.2+build.1')?.prerelease, [])
  assert.equal(parseVersion('0.2'), undefined)
  assert.equal(parseVersion(undefined), undefined)

  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.5'), -1)
  assert.equal(compareVersions('0.2.2-rc.5', '0.2.2'), -1, '预发布小于正式版')
  assert.equal(compareVersions('0.2.2', '0.3.0'), -1)
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.3'), 0)
  assert.equal(compareVersions('0.2.2-alpha.1', '0.2.2-rc.1'), -1, '字母序 alpha < rc')
  assert.equal(compareVersions('0.2.2-1', '0.2.2-alpha'), -1, '数字标识符优先级低于字母')
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1, '按数值而不是字典序')
  assert.equal(compareVersions('bad', '0.2.2'), undefined)
})

test('基线判定：rc.3–rc.5 为基线内，低于/高于/未知各有明确结果', () => {
  assert.equal(HOST_BASELINE.range, '>=0.2.2-rc.3 <0.3.0')
  assert.equal(versionStatus('0.2.2-rc.3'), 'inside')
  assert.equal(versionStatus('0.2.2-rc.4'), 'inside')
  assert.equal(versionStatus('0.2.2-rc.5'), 'inside')
  assert.equal(versionStatus('0.2.2-rc.2'), 'below')
  assert.equal(versionStatus('0.2.1'), 'below')
  assert.equal(versionStatus('0.3.0'), 'above')
  assert.equal(versionStatus('0.3.0-rc.1'), 'inside', '0.3.0-rc.1 低于上限 0.3.0，仍算基线内')
  assert.equal(versionStatus('not-a-version'), 'unknown')
  assert.equal(versionStatus(undefined), 'unknown')
})

test('宿主版本探测：环境变量优先于安装清单，坏清单/无清单都降级为 unknown', () => {
  assert.deepEqual(
    readHostVersion({ env: { DSH_HOST_VERSION: '0.2.2-rc.5', DSH_VERSION: '0.2.2-rc.3' }, argv: [] }),
    { version: '0.2.2-rc.5', source: 'env:DSH_HOST_VERSION' },
  )
  assert.deepEqual(readHostVersion({ env: { DSH_VERSION: '0.2.2-rc.3' }, argv: [] }), { version: '0.2.2-rc.3', source: 'env:DSH_VERSION' })
  // 非法环境变量不算探测结果，继续看清单。
  assert.equal(readHostVersion({ env: { DSH_HOST_VERSION: 'latest' }, argv: [] }).source, 'unknown')

  const argv = ['C:\\node.exe', 'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js']
  assert.equal(manifestFromArgv(argv), join('C:\\Program Files\\DeepSeek Harness\\resources\\app.asar', 'dsh', 'package.json'))
  assert.deepEqual(
    readHostVersion({ env: {}, argv, readText: () => JSON.stringify({ name: 'dsh-desktop-runtime', version: '0.2.2-rc.5' }) }),
    { version: '0.2.2-rc.5', source: 'install-manifest' },
  )
  // 读不到 / 坏 JSON / 没版本字段：一律 unknown，不抛。
  assert.equal(readHostVersion({ env: {}, argv, readText: () => 'not json' }).source, 'unknown')
  assert.equal(readHostVersion({ env: {}, argv, readText: () => JSON.stringify({ name: 'x' }) }).source, 'unknown')
  assert.equal(readHostVersion({ env: {}, argv, readText: () => { throw new Error('ENOENT') } }).source, 'unknown')
  assert.equal(manifestFromArgv(['C:\\node.exe', 'index.js']), undefined)
})

test('版本自检接入点：基线内 ok、越界给 below/above、探测不到不告警', () => {
  const inside = createHostCapabilities({}, { env: { DSH_HOST_VERSION: '0.2.2-rc.3' }, argv: [] })
  assert.equal(inside.version().status, 'inside')
  assert.equal(inside.version().baseline, HOST_BASELINE.range)
  assert.equal(inside.report().couplings.find(item => item.id === 'version').available, true)

  const below = createHostCapabilities({}, { env: { DSH_HOST_VERSION: '0.2.1' }, argv: [] })
  assert.equal(below.version().status, 'below')

  const above = createHostCapabilities({}, { env: { DSH_HOST_VERSION: '0.3.0' }, argv: [] })
  assert.equal(above.version().status, 'above')

  const unknown = createHostCapabilities({}, { env: {}, argv: [] })
  assert.equal(unknown.version().status, 'unknown')
  assert.equal(unknown.version().version, undefined)
  assert.equal(unknown.report().couplings.find(item => item.id === 'version').available, false)
})

test('文档同口径：docs/compat.md 写明 9 类 coupling id 与声明基线', async () => {
  const doc = await readFile(new URL('../docs/compat.md', import.meta.url), 'utf8')
  for (const id of COUPLING_IDS) {
    assert.ok(doc.includes(id), `docs/compat.md 缺少 coupling id：${id}`)
  }
  for (const version of ['0.2.2-rc.3', '0.2.2-rc.5']) {
    assert.ok(doc.includes(version), `docs/compat.md 缺少基线版本：${version}`)
  }
  assert.match(doc, />=0\.2\.2-rc\.3 <0\.3\.0/)
})

test('README 与访问层同口径：首屏声明 rc.3–rc.5 基线（CI 侧锁住声明漂移）', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(HOST_BASELINE.min), `README 未声明最低版本 ${HOST_BASELINE.min}`)
  assert.ok(readme.includes('rc.5'), 'README 未声明上限 rc.5')
})
