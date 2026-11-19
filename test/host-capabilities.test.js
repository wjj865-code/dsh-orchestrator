// P0-2b：宿主能力访问层的单测（首片：版本探测 / settings / 日志路径）。
//
// 为什么单测重点在「缺什么」而不是「有什么」：这一层的价值是**能力缺失时不崩、不静默改行为**。
// 所以每个用例都从空上下文 / 坏服务 / 坏清单出发，再补正例；另外锁住 10 类 coupling id，
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

/** 10 类宿主耦合点的稳定 id（与 docs/compat.md 的表同口径）。 */
const COUPLING_IDS = [
  'team-api', 'session-create', 'settings', 'registry', 'token-meter',
  'session-query', 'panel-slots', 'log-path', 'version', 'team-board',
]

const quiet = () => []

/**
 * cordis 风格上下文：**未写进本插件 inject 的服务属性，读取时由 reflect 的 get trap 直接抛**
 * （真机报错原文 `cannot get property "agentTeams" without inject`）。这里用 Proxy 复刻这个陷阱，
 * 锁住「访问器只准走 ctx.get，绝不再摸 ctx.<服务名> 属性」——普通对象替身拦不住这类回归
 * （属性存在就静默返回、不存在就静默 undefined，两种都不像 cordis）。
 */
const cordisCtx = ({ services = {}, get } = {}) => new Proxy(
  { get: get ?? (name => services[name]) },
  {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  },
)

test('空上下文：10 类访问器全部降级、不抛；report 如实报缺失', () => {
  const host = createHostCapabilities({})
  for (const accessor of [
    'agents', 'subagents', 'sessionController', 'sessions', 'agentPresets', 'settings',
    'workspaceRegistry', 'tokenMeter', 'sessionQuery', 'connection', 'sandboxPolicy',
    'planMode', 'goals', 'schedule', 'sessionPersistence', 'workspaceChanges', 'agentTeams',
  ]) {
    assert.equal(host[accessor](), undefined, `${accessor} 缺失时应返回 undefined，而不是抛`)
  }
  assert.deepEqual(host.slots(), PANEL_SLOTS)
  assert.equal(typeof host.stateDir(), 'string')

  const report = host.report()
  assert.equal(report.total, 10)
  assert.deepEqual(report.couplings.map(row => row.id), COUPLING_IDS)
  assert.equal(report.available, 2, '空上下文只有「面板 slot」「日志路径」天然可用')
  assert.deepEqual(report.missing, ['team-api', 'session-create', 'settings', 'registry', 'token-meter', 'session-query', 'version', 'team-board'])
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

test('第 10 类 team-board：只探测 isEnabled/listTasks，形状不全就如实报缺失', () => {
  // 完整形状：可用。
  const full = { isEnabled: () => true, listTasks: () => [] }
  const host = createHostCapabilities({ get: name => (name === 'agentTeams' ? full : undefined) })
  assert.equal(host.agentTeams(), full)
  assert.equal(host.report().couplings.find(item => item.id === 'team-board').available, true)
  assert.equal(host.report().available, 3, '空上下文 + agentTeams 完整 = 面板 slot / 日志路径 / team-board')

  // 只有成员 API 的旧形状（rc.3 的 spawnTeammate 那套）不算可用：我们只读任务板。
  const legacy = { spawnTeammate() {}, listMembers() { return [] } }
  const old = createHostCapabilities({ get: name => (name === 'agentTeams' ? legacy : undefined) })
  assert.equal(old.report().couplings.find(item => item.id === 'team-board').available, false)
  assert.equal(old.report().couplings.find(item => item.id === 'team-api').available, false)

  // ctx.get 抛错（加载/卸载中）不影响探测：按不可用处理，不上抛。
  const throwing = createHostCapabilities({ get() { throw new Error('waiting for service') } })
  assert.equal(throwing.agentTeams(), undefined)
  assert.equal(throwing.report().couplings.find(item => item.id === 'team-board').available, false)
})

test('agentTeams 取服务：cordis 未 inject 时读属性必抛，访问器只走 ctx.get（不抛、返回 undefined）', () => {
  const full = { isEnabled: () => true, listTasks: () => [], updateTask: async () => ({}) }
  const bare = cordisCtx()
  // 前提：cordis 对未 inject 的服务属性读取必抛（真机同款报错）。这是本用例要防的回归形态。
  assert.throws(() => bare.agentTeams, /cannot get property "agentTeams" without inject/)

  const missing = createHostCapabilities(bare)
  assert.equal(missing.agentTeams(), undefined, '服务不存在：安全返回 undefined，而不是把 cordis 的抛错漏出去')
  assert.equal(missing.report().couplings.find(row => row.id === 'team-board').available, false)
  assert.equal(missing.report().available, 2, '只有面板 slot / 日志路径天然可用')

  // 服务存在（走 ctx.get）→ 返回实例，report 第 10 类为可用。
  const present = createHostCapabilities(cordisCtx({ services: { agentTeams: full } }))
  assert.equal(present.agentTeams(), full)
  assert.equal(present.report().couplings.find(row => row.id === 'team-board').available, true)
  assert.equal(present.report().available, 3)

  // cordis 在加载/卸载中抛错：同样只降级，不上抛。
  const throwing = createHostCapabilities(cordisCtx({ get() { throw new Error('waiting for service') } }))
  assert.equal(throwing.agentTeams(), undefined)
  assert.equal(throwing.report().couplings.find(row => row.id === 'team-board').available, false)
})

test('可选服务统一经 ctx.get（goals / agents / subagents / schedule / connection）：cordis 下不抛、缺失返回 undefined', () => {
  const OPTIONAL = ['goals', 'agents', 'subagents', 'schedule', 'connection', 'sandboxPolicy', 'planMode']
  const bare = cordisCtx()
  // 前提：这些服务属性在真 cordis 里都是「没 inject 就读必抛」（agents/subagents 目前恰好在 inject 里，
  // 但访问器不该依赖这一点——统一走 ctx.get 才不会随 inject 列表漂移而回归）。
  for (const name of OPTIONAL) {
    assert.throws(() => bare[name], /cannot get property .* without inject/)
  }

  const missing = createHostCapabilities(bare)
  for (const accessor of OPTIONAL) {
    assert.equal(missing[accessor](), undefined, `${accessor}() 缺失时应返回 undefined，而不是漏出 cordis 的 inject 抛错`)
  }
  // goals 不属于 10 类 coupling：它缺失不能让 report 虚报，team-api 也如实缺失。
  const report = missing.report()
  assert.equal(report.total, 10)
  assert.equal(report.available, 2)
  assert.equal(report.couplings.find(row => row.id === 'team-api').available, false)

  // 服务经 ctx.get 拿得到：goals 返回实例（goal 桥才可能可用），agents+subagents 让 team-api 计为可用。
  const goals = { get() {}, create() {}, disarm() {}, edit() {}, complete() {}, clear() {} }
  const present = createHostCapabilities(cordisCtx({ services: { goals, agents: { get() { return undefined } }, subagents: {} } }))
  assert.equal(present.goals(), goals)
  assert.equal(present.agents(), present.service('agents'))
  assert.equal(present.report().couplings.find(row => row.id === 'team-api').available, true)
  assert.equal(present.report().available, 3, 'panel-slots / log-path / team-api，goals 不参与计数')
})

test('文档同口径：docs/compat.md 写明 10 类 coupling id 与声明基线', async () => {
  const doc = await readFile(new URL('../docs/compat.md', import.meta.url), 'utf8')
  for (const id of COUPLING_IDS) {
    assert.ok(doc.includes(id), `docs/compat.md 缺少 coupling id：${id}`)
  }
  for (const version of ['0.2.2-rc.3', '0.2.2-rc.5']) {
    assert.ok(doc.includes(version), `docs/compat.md 缺少基线版本：${version}`)
  }
  assert.match(doc, />=0\.2\.2-rc\.3 <0\.3\.0/)
  // 9 → 10 的口径同步：文档里不能再写旧数量，否则排障时会去数「少的那一类」。
  assert.doesNotMatch(doc, /能力探测与降级（9 类）/)
  assert.match(doc, /能力探测与降级（10 类）/)
})

test('README 与访问层同口径：首屏声明 rc.3–rc.5 基线（CI 侧锁住声明漂移）', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes(HOST_BASELINE.min), `README 未声明最低版本 ${HOST_BASELINE.min}`)
  assert.ok(readme.includes('rc.5'), 'README 未声明上限 rc.5')
})
