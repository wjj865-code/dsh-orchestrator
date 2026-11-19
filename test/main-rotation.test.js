// S1 判定内核单测：7 个配置键 + evaluateRotation 纯函数（main-log / age 两因子、P1–P10 保护、冷却/最小龄）。
// S2 采集层单测：locate + stat 采集/降级、settings 键读写、pending 只读判定。
// S3 动作台账面单测：marker/时间戳/审计/旧会话处置 + 崩溃恢复（F6/F7）；平台动作一律以函数注入，
// 真正的「open() 里建会话 + 切指针」在 test/main-session.test.js。
// P1-A 收缩：M1/M2/M4/M6 四个因子与 S7 检查节流已删除，对应用例一并删除（阈值语义只在剩下的两因子上验）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_ROTATION_AT_KEY, MAIN_ROTATION_CHECKED_AT_KEY, MAIN_ROTATION_LAST_KEY, MAIN_ROTATION_PENDING_KEY,
  MAIN_SESSION_CREATED_AT_KEY, ROTATION_BLOCKS, ROTATION_DEFAULTS, ROTATION_LIMITS, ROTATION_TRIGGERS,
  beginRotationMarker, collectRotationMetrics, createRotationService, disposeOldMainSession,
  evaluateRotation, inspectRotationPending, markRotationTimes,
  normalizeRotationConfig, readRotationState, recordRotation, recoverPendingRotation, retiredMainSessionTitle,
  rotationHeadline, writeRotationState,
} from '../src/main-rotation.js'
import { getSetting, openLedger, setSetting } from '../src/ledger.js'
import { onboardingKey } from '../src/onboarding.js'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const NOW = 1_760_000_000_000
const MIB = 1024 * 1024
/** 健康基线：日志 0.5 MiB（< 6）、龄 40h（> 最小龄 12h、< 240h）、上次轮换 50h 前（> 冷却 48h）。 */
const BASE_METRICS = { mainLogMiB: 0.5 }

const baseInput = (overrides = {}) => {
  const { metrics, ...rest } = overrides
  return {
    now: NOW,
    config: { mainRotation: 'auto', spawnProvider: 'spawn' },
    since: NOW - 40 * HOUR,
    lastRotatedAt: NOW - 50 * HOUR,
    tasks: [],
    agentStatus: 'idle',
    logMtimeAt: NOW - 30 * MINUTE,
    catalog: [],
    ...rest,
    metrics: { ...BASE_METRICS, ...(metrics ?? {}) },
  }
}

/** 两个因子同时命中的输入（用于 off/保护/优先级用例：有触发但被挡住）。 */
const allTriggersInput = (overrides = {}) => baseInput({
  since: NOW - 240 * HOUR,
  metrics: { mainLogMiB: 10 },
  ...overrides,
})

const codesOf = list => list.map(item => item.code)

test('默认配置：健康输入不轮换，输出契约字段齐全', () => {
  const decision = evaluateRotation(baseInput())
  assert.equal(decision.due, false)
  assert.equal(decision.mode, 'auto')
  assert.deepEqual(decision.triggers, [])
  assert.deepEqual(decision.reasons, [])
  assert.deepEqual(decision.blockedBy, [])
  assert.equal(decision.blockCount, 0)
  assert.equal(decision.evaluatedAt, NOW)
  assert.equal(decision.lastRotatedAt, NOW - 50 * HOUR)
  assert.deepEqual(decision.degraded, [])
  assert.deepEqual(Object.keys(decision.metrics).sort(), [
    'ageHours', 'hoursSinceRotation', 'idleMinutes', 'mainLogMiB',
  ])
  assert.equal(decision.metrics.ageHours, 40)
  assert.equal(decision.metrics.hoursSinceRotation, 50)
  assert.equal(decision.metrics.idleMinutes, 30)
})

test('纯函数：同一输入同一结论，不改入参，输出可安全丢弃', () => {
  const input = baseInput({ metrics: { mainLogMiB: 6 } })
  const snapshot = JSON.stringify(input)
  const first = evaluateRotation(input)
  const second = evaluateRotation(input)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(input), snapshot)
  // 返回值是本次判定的独立快照：改它不影响下一次。
  first.reasons.length = 0
  first.metrics.mainLogMiB = 0
  const third = evaluateRotation(input)
  assert.equal(third.due, true)
  assert.equal(third.reasons.length, 1)
})

test('每个触发因子单独命中都能 due（只剩 main-log / age）', () => {
  const cases = [
    ['main-log', baseInput({ metrics: { mainLogMiB: 6 } })],
    ['age', baseInput({ since: NOW - 240 * HOUR })],
  ]
  for (const [code, input] of cases) {
    const decision = evaluateRotation(input)
    assert.equal(decision.due, true, `${code} 应命中`)
    assert.deepEqual(decision.triggers, [code], `${code} 只报一个因子`)
    assert.equal(decision.reasons.length, 1)
    assert.equal(decision.reasons[0].code, code)
    assert.match(decision.reasons[0].text, /阈值/, `${code} 文案要带阈值`)
    assert.deepEqual(decision.blockedBy, [], `${code} 不应被保护挡住`)
  }
  // 已删除的四个因子即使调用方硬塞进来也不再参与判定。
  const removed = evaluateRotation(baseInput({
    metrics: { mainLogMiB: 0.1, tasksSince: 999, sessionsSince: 999, contextTokens: 9e6, diskMiB: 9e6 },
  }))
  assert.equal(removed.due, false)
  assert.deepEqual(removed.triggers, [])
})

test('阈值边界：略小于不触发，等于/超过触发（>= 口径）', () => {
  const cases = [
    ['main-log', value => baseInput({ metrics: { mainLogMiB: value } }), 5.99, 6],
    ['age', value => baseInput({ since: NOW - value * HOUR }), 239.5, 240],
  ]
  for (const [code, build, below, at] of cases) {
    assert.equal(evaluateRotation(build(below)).triggers.includes(code), false, `${code}: ${below} 不该触发`)
    assert.equal(evaluateRotation(build(at)).triggers.includes(code), true, `${code}: ${at} 应触发`)
    assert.equal(evaluateRotation(build(at + 1)).triggers.includes(code), true, `${code}: ${at + 1} 应触发`)
  }
})

test('多因子同时命中：每个因子只记一条，顺序稳定（main-log → age）', () => {
  assert.deepEqual(ROTATION_TRIGGERS, ['main-log', 'age'])
  const decision = evaluateRotation(allTriggersInput())
  assert.equal(decision.due, true)
  assert.deepEqual(decision.triggers, ROTATION_TRIGGERS)
  assert.deepEqual(codesOf(decision.reasons), ROTATION_TRIGGERS)
  assert.equal(new Set(decision.triggers).size, decision.triggers.length)
  // 每个原因都带实测值与阈值，面板/日志可直接复述。
  for (const reason of decision.reasons) {
    assert.equal(Number.isFinite(reason.value), true)
    assert.equal(Number.isFinite(reason.threshold), true)
  }
})

test('没有触发因子即使有保护也算「不需要轮换」：due=false、blockedBy 记录原因', () => {
  const decision = evaluateRotation(baseInput({
    tasks: [{ id: 't-1', status: 'running', artifacts: [] }],
  }))
  assert.equal(decision.due, false)
  assert.deepEqual(decision.triggers, [])
  assert.deepEqual(codesOf(decision.blockedBy), ['active-tasks'])
  assert.equal(decision.blockCount, 1)
  assert.match(decision.blockedBy[0].text, /1 个活跃任务/)
})

test('off 模式（默认）：因子照算，但永不 due（只检测不动作）', () => {
  const decision = evaluateRotation(allTriggersInput({ config: { mainRotation: 'off', spawnProvider: 'spawn' } }))
  assert.equal(decision.mode, 'off')
  assert.equal(decision.due, false)
  // 仍然把「本来会命中」的因子报出来，方便日志核对关闭期间本会轮换几次。
  assert.deepEqual(decision.triggers, ROTATION_TRIGGERS)
  assert.equal(decision.blockedBy[0].code, 'mode-off')
  // 默认（不传配置）就是 off：升级后不会自动换主会话。
  assert.equal(evaluateRotation(allTriggersInput({ config: {} })).due, false)
})

test('P6/P7：配置覆盖会话与 fork provider 都不轮换', () => {
  const override = evaluateRotation(allTriggersInput({ config: { mainRotation: 'auto', spawnProvider: 'spawn', coordinatorSession: 's-override' } }))
  assert.equal(override.due, false)
  assert.deepEqual(codesOf(override.blockedBy), ['coordinator-override'])
  assert.match(override.blockedBy[0].text, /s-override/)

  const fork = evaluateRotation(allTriggersInput({ config: { mainRotation: 'auto', spawnProvider: 'fork' } }))
  assert.equal(fork.due, false)
  assert.deepEqual(codesOf(fork.blockedBy), ['spawn-provider'])
  assert.match(fork.blockedBy[0].text, /fork/)

  // 默认 spawnProvider（不传）不应误伤。
  const defaulted = evaluateRotation(allTriggersInput({ config: { mainRotation: 'auto' } }))
  assert.equal(defaulted.due, true)
})

test('P1：五种活跃状态各一条都阻塞，终态任务不阻塞', () => {
  for (const status of ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth']) {
    const decision = evaluateRotation(allTriggersInput({ tasks: [{ id: `t-${status}`, status, artifacts: [] }] }))
    assert.equal(decision.due, false, status)
    assert.deepEqual(codesOf(decision.blockedBy), ['active-tasks'], status)
  }
  const terminal = evaluateRotation(allTriggersInput({
    tasks: [
      { id: 't-done', status: 'done', artifacts: [] },
      { id: 't-failed', status: 'failed', artifacts: [] },
      { id: 't-cancelled', status: 'cancelled', artifacts: [] },
      { id: 't-orphaned', status: 'orphaned', artifacts: [] },
    ],
  }))
  assert.equal(terminal.due, true)
  assert.deepEqual(terminal.blockedBy, [])
})

test('P2/P5：待确认阻塞；带产物的待确认额外记一条（P2 子集）', () => {
  const pending = evaluateRotation(allTriggersInput({
    tasks: [{ id: 't-1', status: 'delivered', artifacts: [] }, { id: 't-2', status: 'delivered', artifacts: [] }],
  }))
  assert.equal(pending.due, false)
  assert.deepEqual(codesOf(pending.blockedBy), ['delivered-pending'])
  assert.match(pending.blockedBy[0].text, /2 个任务/)

  const withArtifacts = evaluateRotation(allTriggersInput({
    tasks: [{ id: 't-1', status: 'delivered', artifacts: ['reports/a.md'] }],
  }))
  assert.equal(withArtifacts.due, false)
  // 顺序固定：delivered-pending 在 delivered-artifacts 之前。
  assert.deepEqual(codesOf(withArtifacts.blockedBy), ['delivered-pending', 'delivered-artifacts'])
})

test('P3：主会话正在回合时不轮换', () => {
  const decision = evaluateRotation(allTriggersInput({ agentStatus: 'running' }))
  assert.equal(decision.due, false)
  assert.deepEqual(codesOf(decision.blockedBy), ['agent-running'])
  // 其它状态（idle / undefined）不阻塞。
  assert.equal(evaluateRotation(allTriggersInput({ agentStatus: 'idle' })).due, true)
  assert.equal(evaluateRotation(allTriggersInput({ agentStatus: undefined })).due, true)
})

test('P4：日志闲置边界（< rotateIdleMinutes 阻塞，等于不阻塞）', () => {
  assert.deepEqual(
    codesOf(evaluateRotation(allTriggersInput({ logMtimeAt: NOW - 9 * MINUTE })).blockedBy),
    ['recent-activity'],
  )
  assert.equal(evaluateRotation(allTriggersInput({ logMtimeAt: NOW - 10 * MINUTE })).due, true)
  assert.equal(evaluateRotation(allTriggersInput({ logMtimeAt: NOW - 11 * MINUTE })).due, true)
  // 阈值可配：5 分钟档下 6 分钟前写过日志就不再阻塞。
  const custom = evaluateRotation(allTriggersInput({
    config: { mainRotation: 'auto', spawnProvider: 'spawn', rotateIdleMinutes: 5 },
    logMtimeAt: NOW - 6 * MINUTE,
  }))
  assert.equal(custom.due, true)
  // 日志定位失败（mtime 未知）时这条保护缺席，不当成「刚聊完」。
  assert.equal(evaluateRotation(allTriggersInput({ logMtimeAt: undefined })).due, true)
})

test('P8：子会话目录里有活跃子代理时阻塞；目录缺失不算阻塞', () => {
  const active = evaluateRotation(allTriggersInput({ catalog: [{ id: 'c-1', activity: 'active' }] }))
  assert.equal(active.due, false)
  assert.deepEqual(codesOf(active.blockedBy), ['active-children'])
  assert.match(active.blockedBy[0].text, /1 个活跃子代理/)

  const idle = evaluateRotation(allTriggersInput({ catalog: [{ id: 'c-1', activity: 'idle' }, { id: 'c-2' }] }))
  assert.equal(idle.due, true)
  // catalog 拿不到（服务缺失）时不能把 P8 当命中，也不能当成「有活跃子代理」误伤。
  assert.equal(evaluateRotation(allTriggersInput({ catalog: undefined })).due, true)
})

test('P9 最小龄：< 阻塞，= 通过，阈值可配', () => {
  const blocked = evaluateRotation(allTriggersInput({ since: NOW - 11.9 * HOUR }))
  assert.equal(blocked.due, false)
  assert.ok(codesOf(blocked.blockedBy).includes('min-age'))
  assert.match(blocked.blockedBy.find(item => item.code === 'min-age').text, /最小龄 12 小时/)

  const exactly = evaluateRotation(allTriggersInput({ since: NOW - 12 * HOUR }))
  assert.equal(exactly.due, true)

  const custom = evaluateRotation(allTriggersInput({
    config: { mainRotation: 'auto', spawnProvider: 'spawn', rotateMinAgeHours: 1 },
    since: NOW - 2 * HOUR,
  }))
  assert.equal(custom.due, true)
})

test('P9 冷却期：< 阻塞，= 通过，从未轮换视为满足', () => {
  const blocked = evaluateRotation(allTriggersInput({ lastRotatedAt: NOW - 47.9 * HOUR }))
  assert.equal(blocked.due, false)
  assert.ok(codesOf(blocked.blockedBy).includes('cooldown'))
  assert.match(blocked.blockedBy.find(item => item.code === 'cooldown').text, /冷却 48 小时/)

  const exactly = evaluateRotation(allTriggersInput({ lastRotatedAt: NOW - 48 * HOUR }))
  assert.equal(exactly.due, true)

  const never = evaluateRotation(allTriggersInput({ lastRotatedAt: undefined }))
  assert.equal(never.due, true)
  assert.equal(never.lastRotatedAt, null)
  assert.equal(never.metrics.hoursSinceRotation, null)
})

test('P10：两个触发指标都拿不到 → fail-closed，只记 degraded', () => {
  const decision = evaluateRotation({ now: NOW, config: { mainRotation: 'auto' }, tasks: [] })
  assert.equal(decision.due, false)
  assert.deepEqual(decision.triggers, [])
  assert.deepEqual(codesOf(decision.blockedBy), ['metrics-degraded'])
  assert.deepEqual(decision.degraded, [...ROTATION_TRIGGERS])
  for (const value of Object.values(decision.metrics)) assert.equal(value, null)
  // 调用方已知的采集失败与本次缺席合并去重。
  const merged = evaluateRotation({ now: NOW, config: { mainRotation: 'auto' }, degraded: ['main-log', 'tokens'] })
  assert.deepEqual(merged.degraded, [...ROTATION_TRIGGERS, 'tokens'])
})

test('指标部分缺失：另一个因子照常判定（不是 fail-closed）', () => {
  // since 拿不到 → age 缺席，但 main-log 仍能命中。
  const decision = evaluateRotation({
    now: NOW,
    config: { mainRotation: 'auto' },
    since: undefined,
    metrics: { mainLogMiB: 7 },
    logMtimeAt: NOW - 30 * MINUTE,
  })
  assert.equal(decision.due, true)
  assert.deepEqual(decision.triggers, ['main-log'])
  assert.deepEqual(decision.blockedBy, [])
  assert.deepEqual(decision.degraded, ['age'])
  // 反过来：locate 失败（main-log 未知）但龄还在，就只按龄判定。
  const aged = evaluateRotation({
    now: NOW,
    config: { mainRotation: 'auto' },
    since: NOW - 240 * HOUR,
    metrics: {},
    logMtimeAt: NOW - 30 * MINUTE,
  })
  assert.equal(aged.due, true)
  assert.deepEqual(aged.triggers, ['age'])
  assert.deepEqual(aged.degraded, ['main-log'])
})

test('非法/坏配置在判定内回落或夹取，不抛错', () => {
  // 字符串不算数字 → 回落默认 6 MiB。
  assert.equal(evaluateRotation(baseInput({ config: { mainRotation: 'auto', rotateAfterMainLogMiB: '1' }, metrics: { mainLogMiB: 6 } })).due, true)
  // 越界夹到上界 4096 → 6 MiB 不再命中。
  assert.equal(evaluateRotation(baseInput({ config: { mainRotation: 'auto', rotateAfterMainLogMiB: 1e9 }, metrics: { mainLogMiB: 6 } })).due, false)
  // 负数回落默认 10 天（= 240h）→ 240h 命中。
  assert.equal(evaluateRotation(baseInput({ config: { mainRotation: 'auto', rotateAfterDays: -1 }, since: NOW - 240 * HOUR })).due, true)
  // config 整个是 null 也不崩。
  assert.doesNotThrow(() => evaluateRotation(baseInput({ config: null })))
  // 时间戳是 NaN 当「没有」处理。
  const nan = evaluateRotation(baseInput({ since: Number.NaN, lastRotatedAt: Number.NaN, metrics: { mainLogMiB: 7 } }))
  assert.equal(nan.due, true)
  assert.equal(nan.metrics.ageHours, null)
})

test('时钟回拨（since 在未来）按 0 龄处理，并命中最小龄', () => {
  const decision = evaluateRotation(allTriggersInput({ since: NOW + 2 * HOUR }))
  assert.equal(decision.metrics.ageHours, 0)
  assert.ok(codesOf(decision.blockedBy).includes('min-age'))
  assert.equal(decision.due, false)
})

test('保护规则优先级：配置层 → 状态层 → 时间层，全部命中时顺序稳定且各有文案', () => {
  const decision = evaluateRotation(baseInput({
    config: { mainRotation: 'off', spawnProvider: 'fork', coordinatorSession: 's-override' },
    since: NOW - 1 * HOUR,
    lastRotatedAt: NOW - 1 * HOUR,
    agentStatus: 'running',
    logMtimeAt: NOW - 1 * MINUTE,
    catalog: [{ id: 'c-1', activity: 'active' }],
    tasks: [
      { id: 't-pending', status: 'pending', artifacts: [] },
      { id: 't-delivered', status: 'delivered', artifacts: ['reports/a.md'] },
    ],
    metrics: { mainLogMiB: 10 },
  }))
  assert.equal(decision.due, false)
  assert.deepEqual(codesOf(decision.blockedBy), [
    'mode-off', 'coordinator-override', 'spawn-provider',
    'active-tasks', 'delivered-pending', 'delivered-artifacts',
    'agent-running', 'recent-activity', 'active-children',
    'min-age', 'cooldown',
  ])
  assert.equal(decision.blockCount, decision.blockedBy.length)
  for (const item of decision.blockedBy) assert.equal(typeof item.text, 'string')
  assert.equal(decision.blockedBy.length, new Set(codesOf(decision.blockedBy)).size)
})

test('一句话文案：due 列原因、被挡给首要原因、无事可说不需要', () => {
  assert.match(rotationHeadline(evaluateRotation(allTriggersInput())), /^建议轮换主会话：/)
  assert.match(rotationHeadline(evaluateRotation(baseInput())), /^主会话暂无轮换必要$/)
  assert.match(rotationHeadline(evaluateRotation(allTriggersInput({ config: { mainRotation: 'off' } }))), /^暂不轮换主会话：主会话轮换已关闭/)
  assert.equal(rotationHeadline(undefined), '主会话轮换：尚未判定')
})

test('配置键契约：7 个键、默认值、区间与 loadConfig 接线一致', () => {
  assert.deepEqual(Object.keys(ROTATION_DEFAULTS).sort(), [
    'mainRotation', 'rotateAfterDays', 'rotateAfterMainLogMiB', 'rotateArchiveOld',
    'rotateCooldownHours', 'rotateIdleMinutes', 'rotateMinAgeHours',
  ])
  assert.equal(Object.keys(ROTATION_LIMITS).length, 5, '除总开关与归档开关外都是数值键')
  const config = loadConfig({})
  for (const [key, value] of Object.entries(ROTATION_DEFAULTS)) {
    assert.equal(config[key], value, `loadConfig 应挂上 ${key}`)
  }
  // 归一化幂等：loadConfig 出来的配置再归一化一次不变。
  assert.deepEqual(normalizeRotationConfig(config), { ...ROTATION_DEFAULTS })
  // 总量口径：41 → 35（P1-A 删掉 backend + 5 个 rotate* 键）。
  assert.equal(Object.keys(config).length, 35)
})

test('settings 键名固定（S3 动作/恢复的四把事实 + 只读的 checkedAt）', () => {
  assert.deepEqual(
    {
      created: MAIN_SESSION_CREATED_AT_KEY,
      rotatedAt: MAIN_ROTATION_AT_KEY,
      last: MAIN_ROTATION_LAST_KEY,
      pending: MAIN_ROTATION_PENDING_KEY,
      checkedAt: MAIN_ROTATION_CHECKED_AT_KEY,
    },
    {
      created: 'main_session_created_at',
      rotatedAt: 'main_rotation_at',
      last: 'main_rotation_last',
      pending: 'main_rotation_pending',
      checkedAt: 'main_rotation_checked_at',
    },
  )
  assert.deepEqual(ROTATION_BLOCKS, [
    'mode-off', 'coordinator-override', 'spawn-provider',
    'active-tasks', 'delivered-pending', 'delivered-artifacts',
    'agent-running', 'recent-activity', 'active-children',
    'min-age', 'cooldown', 'metrics-degraded',
  ])
})

// ---------------------------------------------------------------------------
// S2：指标采集层（locate + stat，逐项降级）+ settings 键读写 + snapshot 只读形状
// ---------------------------------------------------------------------------

const openTestLedger = () => openLedger(tempDir())

const headerOf = (id, cwd, createdAt) => ({ id, cwd, createdAt })

const fakePersistence = ({ fail = {} } = {}) => {
  const calls = { locate: 0 }
  return {
    calls,
    locate(meta) {
      calls.locate += 1
      if (fail.locate) throw new Error(fail.locate)
      return { kind: 'jsonl', path: `C:/sessions/${meta.id}.jsonl` }
    },
  }
}

/** 注入 stat：表里没有的路径按 ENOENT 处理（模拟并发删除/未落盘）。 */
const statFrom = (sizes, { mtimeMs = NOW - 30 * MINUTE } = {}) => async path => {
  if (!Object.prototype.hasOwnProperty.call(sizes, path)) {
    const error = new Error(`ENOENT ${path}`)
    error.code = 'ENOENT'
    throw error
  }
  return { size: sizes[path], mtimeMs }
}

const rowCounts = db => ({
  tasks: db.prepare('SELECT count(*) AS n FROM tasks').get().n,
  settings: db.prepare('SELECT count(*) AS n FROM settings').get().n,
})

test('S2 采集：locate + stat 成功，指标按口径算，采集本身零写入', async () => {
  const db = await openTestLedger()
  const since = NOW - 10 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since - 2 * HOUR)
  const before = rowCounts(db)
  const collected = await collectRotationMetrics({
    db,
    persistence: fakePersistence(),
    mainSession: { header: mainHeader },
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': 2 * MIB }),
  })
  assert.equal(collected.since, since)
  assert.equal(collected.sinceSource, 'settings')
  assert.deepEqual(collected.metrics, { mainLogMiB: 2 })
  assert.deepEqual(collected.degraded, [])
  assert.equal(collected.logMtimeAt, NOW - 30 * MINUTE, 'mtime 顺带给 P4')
  // 采集只读：台账/settings 行数不变。
  assert.deepEqual(rowCounts(db), before)
  db.close()
})

test('S2 采集：settings 缺 created_at 时退 header.createdAt；都缺则龄未知', async () => {
  const db = await openTestLedger()
  const headerAt = NOW - 20 * HOUR
  const mainHeader = headerOf('s-1', 'C:/ws', headerAt)
  const collected = await collectRotationMetrics({
    db,
    persistence: fakePersistence(),
    mainSession: { header: mainHeader },
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': MIB }),
  })
  assert.equal(collected.since, headerAt)
  assert.equal(collected.sinceSource, 'header')
  assert.equal(collected.metrics.mainLogMiB, 1)

  // 既没有 settings 也没有 header（没有 live 会话）→ 龄未知（不是「刚建」）。
  const db2 = await openTestLedger()
  const unknown = await collectRotationMetrics({ db: db2 })
  assert.equal(unknown.since, null)
  assert.equal(unknown.sinceSource, null)
  assert.equal(unknown.metrics.mainLogMiB, null)
  assert.ok(unknown.degraded.includes('age'), 'age 应记 degraded')
  assert.ok(unknown.degraded.includes('main-log'), 'main-log 应记 degraded')
  db.close()
  db2.close()
})

test('S2 采集：服务全缺失时两项降级为 null（未知，不是 0）并 fail-closed', async () => {
  const db = await openTestLedger()
  const collected = await collectRotationMetrics({ db })
  assert.deepEqual(collected.metrics, { mainLogMiB: null })
  assert.deepEqual([...collected.degraded].sort(), ['age', 'main-log'])
  // 两指标全未知 → 判定 fail-closed（不轮换），且日志看得见 degraded。
  const decision = evaluateRotation({
    now: NOW,
    config: { mainRotation: 'auto' },
    since: collected.since ?? undefined,
    metrics: collected.metrics,
    degraded: collected.degraded,
  })
  assert.equal(decision.due, false)
  assert.deepEqual(decision.blockedBy.map(item => item.code), ['metrics-degraded'])
  assert.deepEqual(decision.metrics, {
    mainLogMiB: null, ageHours: null, hoursSinceRotation: null, idleMinutes: null,
  })
  db.close()
})

test('S2 采集：单项失败只降级该项，其余照算（不互相拖累）', async () => {
  const db = await openTestLedger()
  const since = NOW - 30 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since)
  // stat 失败 → 只降级 main-log；since 仍从 settings 拿到。
  const statBroken = await collectRotationMetrics({
    db,
    persistence: fakePersistence(),
    mainSession: { header: mainHeader },
    statFile: async () => { throw new Error('stat boom') },
  })
  assert.equal(statBroken.metrics.mainLogMiB, null)
  assert.deepEqual(statBroken.degraded, ['main-log'])
  assert.equal(statBroken.since, since)

  // 缺 persistence → main-log 降级；龄照算。
  const noPersistence = await collectRotationMetrics({ db, mainSession: { header: mainHeader } })
  assert.equal(noPersistence.metrics.mainLogMiB, null)
  assert.deepEqual(noPersistence.degraded, ['main-log'])

  // locate 抛错 → 同样只降级 main-log。
  const locateBroken = await collectRotationMetrics({
    db,
    persistence: fakePersistence({ fail: { locate: 'locate boom' } }),
    mainSession: { header: mainHeader },
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': MIB }),
  })
  assert.equal(locateBroken.metrics.mainLogMiB, null)
  assert.deepEqual(locateBroken.degraded, ['main-log'])
  db.close()
})

test('S2 evaluate：采集 + 纯判定；不写任何 settings 键、不建会话、不留 marker', async () => {
  const db = await openTestLedger()
  const since = NOW - 30 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since)
  const events = []
  const rotation = createRotationService({
    db,
    config: { mainRotation: 'auto', spawnProvider: 'spawn' },
    persistence: fakePersistence(),
    now: () => NOW,
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': 8 * MIB }),
    log: (event, fields) => events.push([event, fields]),
  })
  // 唯一判定入口：打开主会话时调一次（source:'open'）。
  const decision = await rotation.evaluate({
    mainSessionId: 's-1',
    liveAgent: { status: 'idle', session: { header: mainHeader } },
    source: 'open',
  })
  assert.equal(decision.due, true)
  assert.deepEqual(decision.triggers, ['main-log'])
  // 判定本身不写派生状态（没有 due 标记、也不再写检查时间戳）。
  assert.equal(getSetting(db, 'main_session_id'), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_AT_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_LAST_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_CHECKED_AT_KEY), undefined, 'P1-A 起不再写检查时间戳')
  // 决策日志（事后复盘入口）带 triggers/blockedBy/metrics 与 since 口径。
  const decided = events.find(([event]) => event === 'main.rotation.decided')
  assert.ok(decided, '应写 main.rotation.decided')
  assert.equal(decided[1].detail.due, true)
  assert.deepEqual(decided[1].detail.triggers, ['main-log'])
  assert.equal(decided[1].detail.source, 'open')
  assert.equal(decided[1].detail.since, since)
  db.close()
})

test('S2 evaluate：配置覆盖 / 未打开主会话都短路为 null，零采集', async () => {
  const db = await openTestLedger()
  const events = []
  const persistence = fakePersistence()
  const options = { db, persistence, now: () => NOW, log: (event, fields) => events.push([event, fields]) }
  assert.equal(await createRotationService({ ...options, config: { coordinatorSession: 's-override' } }).evaluate({ mainSessionId: 's-override' }), null)
  assert.equal(await createRotationService({ ...options, config: {} }).evaluate({ mainSessionId: undefined }), null)
  assert.equal(persistence.calls.locate, 0, '两条短路都不该走到采集')
  assert.equal(events.length, 0, '没判定就不该有判定日志')
  db.close()
})

test('S2 evaluate：整体异常 fail-closed（返回 null、不抛，只 warn + 审计日志）', async () => {
  const warnings = []
  const events = []
  const brokenDb = { prepare() { throw new Error('db boom') } }
  const decision = await createRotationService({
    db: brokenDb,
    config: {},
    now: () => NOW,
    onWarn: message => warnings.push(message),
    log: (event, fields) => events.push([event, fields]),
  }).evaluate({ mainSessionId: 's-1', source: 'open' })
  assert.equal(decision, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /主会话轮换检测失败/)
  assert.equal(events[0][0], 'main.rotation.failed')
})

test('S2 settings 键读写与 pending marker 只读判定（S2 只算不执行）', async () => {
  const db = await openTestLedger()
  assert.deepEqual(readRotationState(db), { createdAt: null, rotatedAt: null, last: null, pending: null, checkedAt: null })
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(NOW - HOUR))
  setSetting(db, MAIN_ROTATION_AT_KEY, String(NOW - MINUTE))
  setSetting(db, MAIN_ROTATION_LAST_KEY, JSON.stringify({ old: 'a', new: 'b', at: NOW }))
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ newId: 'new-1', oldId: 'old-1', at: NOW }))
  // 旧库里的检查节流键仍能读出来（不清理、也不参与判定）。
  setSetting(db, MAIN_ROTATION_CHECKED_AT_KEY, String(NOW - 2 * HOUR))
  const state = readRotationState(db)
  assert.equal(state.createdAt, NOW - HOUR)
  assert.equal(state.rotatedAt, NOW - MINUTE)
  assert.deepEqual(state.last, { old: 'a', new: 'b', at: NOW })
  assert.deepEqual(state.pending, { newId: 'new-1', oldId: 'old-1', at: NOW })
  assert.equal(state.checkedAt, NOW - 2 * HOUR)
  // complete：上次轮换已切指针，只差旧会话处置；abandoned：死在切指针之前。
  assert.deepEqual(inspectRotationPending(state, 'new-1'), {
    state: 'complete', marker: { newId: 'new-1', oldId: 'old-1', at: NOW },
  })
  assert.equal(inspectRotationPending(state, 'old-1').state, 'abandoned')
  assert.equal(inspectRotationPending(state, undefined).state, 'unknown')
  assert.deepEqual(inspectRotationPending({ pending: null }, 'new-1'), { state: 'none', marker: null })
  assert.equal(inspectRotationPending({ pending: { newId: 42 } }, 'new-1').state, 'invalid')
  // 判定不改 marker（S2 不执行恢复）。
  assert.deepEqual(JSON.parse(getSetting(db, MAIN_ROTATION_PENDING_KEY)), { newId: 'new-1', oldId: 'old-1', at: NOW })
  db.close()
})

test('S2 writeRotationState：五个键统一写入口，null 删键、对象存 JSON、undefined 不动', async () => {
  const db = await openTestLedger()
  const written = writeRotationState(db, {
    createdAt: NOW - HOUR,
    rotatedAt: NOW - MINUTE,
    last: { old: 'a', new: 'b', at: NOW },
    pending: { newId: 'new-1', oldId: 'a', at: NOW },
    checkedAt: NOW - 2 * MINUTE,
  })
  assert.equal(written.createdAt, String(NOW - HOUR))
  assert.equal(written.checkedAt, String(NOW - 2 * MINUTE))
  const state = readRotationState(db)
  assert.equal(state.createdAt, NOW - HOUR)
  assert.equal(state.rotatedAt, NOW - MINUTE)
  assert.deepEqual(state.last, { old: 'a', new: 'b', at: NOW })
  assert.deepEqual(state.pending, { newId: 'new-1', oldId: 'a', at: NOW })
  assert.equal(state.checkedAt, NOW - 2 * MINUTE)
  // null 删键；没提到的键保持原样。
  writeRotationState(db, { pending: null, last: undefined })
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined)
  assert.deepEqual(readRotationState(db).last, { old: 'a', new: 'b', at: NOW })
  assert.equal(readRotationState(db).pending, null)
  db.close()
})

// ---------------------------------------------------------------------------
// S3 轮换动作的台账面：marker / 时间戳 / 审计 / 旧会话处置 / 崩溃恢复（F6、F7）
// 平台动作（rename/archive）一律以函数注入——这里只测「台账该写什么、动作该被怎么调」。
// ---------------------------------------------------------------------------

test('S3 退役标题：本地时间 YYYY-MM-DD HH:mm，形状固定', () => {
  const title = retiredMainSessionTitle(Date.UTC(2026, 10, 17, 7, 5))
  assert.match(title, /^主会话（已退役 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/)
  // 坏时间戳退到「现在」，同样不抛。
  assert.match(retiredMainSessionTitle(Number.NaN), /^主会话（已退役 /)
})

test('S3 marker/时间戳/审计：键形状、降级与一次收口（marker 清掉）', async () => {
  const db = await openTestLedger()
  const marker = beginRotationMarker({ db, oldId: 'old-1', newId: 'new-1', at: NOW, reasons: [{ code: 'age' }, 'main-log', { nope: true }] })
  assert.deepEqual(marker, { newId: 'new-1', oldId: 'old-1', at: NOW, reasons: ['age', 'main-log'] })
  assert.deepEqual(readRotationState(db).pending, marker)
  // marker 写不进去只记日志、不抛（崩溃恢复锚点缺失，但轮换本身不该因此放弃）。
  const events = []
  const brokenDb = { prepare() { throw new Error('disk full') } }
  assert.equal(beginRotationMarker({ db: brokenDb, oldId: 'a', newId: 'b', at: NOW, log: (event, detail) => events.push([event, detail]) }), null)
  assert.equal(events[0][0], 'main.rotation.marker.failed')

  markRotationTimes(db, NOW - MINUTE)
  assert.equal(readRotationState(db).createdAt, NOW - MINUTE)
  assert.equal(readRotationState(db).rotatedAt, NOW - MINUTE)

  const disposal = await disposeOldMainSession({
    oldId: 'old-1', at: NOW, rename: async () => {}, archive: async () => {}, log: () => {}, onWarn: () => {},
  })
  assert.deepEqual(disposal, { renamed: true, archived: true })
  const record = recordRotation(db, { oldId: 'old-1', newId: 'new-1', at: NOW, decision: evaluateRotation(allTriggersInput()), disposal })
  assert.equal(record.old, 'old-1')
  assert.equal(record.new, 'new-1')
  assert.equal(record.at, NOW)
  assert.deepEqual(record.triggers, ROTATION_TRIGGERS)
  assert.equal(record.reasons.length, ROTATION_TRIGGERS.length)
  assert.equal(record.renamed, true)
  assert.equal(record.archived, true)
  assert.equal(record.recovered, false)
  const state = readRotationState(db)
  assert.deepEqual(state.last, record, '审计是事后排查唯一入口')
  assert.equal(state.pending, null, 'marker 清掉')

  // 旧会话处置两步各自失败只降级，永不抛：rename 失败仍尝试归档，archive 失败只留下「仍在列表里」。
  const warns = []
  const failed = await disposeOldMainSession({
    oldId: 'old-1', at: NOW,
    rename: async () => { throw new Error('rename boom') },
    archive: async () => { throw new Error('archive boom') },
    log: () => {}, onWarn: message => warns.push(message),
  })
  assert.deepEqual(failed, { renamed: false, archived: false })
  assert.equal(warns.length, 2)
  // 没有平台动作（服务缺失）也只是 false + 日志，不抛。
  assert.deepEqual(await disposeOldMainSession({ oldId: 'old-1', at: NOW }), { renamed: false, archived: false })
  assert.deepEqual(await disposeOldMainSession({ oldId: undefined, at: NOW }), { renamed: false, archived: false })
  db.close()
})

test('S3 恢复 F6（abandoned）：死在切指针之前 → 归档空白新会话、清 marker、旧指针与旧会话都不动', async () => {
  const db = await openTestLedger()
  setSetting(db, 'main_session_id', 'session-old')
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(NOW - 30 * HOUR))
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ newId: 'session-new', oldId: 'session-old', at: NOW - MINUTE, reasons: ['age'] }))
  const archived = []
  const renamed = []
  const events = []
  const result = await recoverPendingRotation({
    db,
    pointer: 'session-old',
    archive: async id => archived.push(id),
    rename: async (id, title) => renamed.push([id, title]),
    now: NOW,
    log: (event, detail) => events.push([event, detail]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'abandoned')
  assert.equal(result.newId, 'session-new')
  assert.equal(result.archived, true)
  assert.deepEqual(archived, ['session-new'], '只归档那块空白残留')
  assert.deepEqual(renamed, [], '旧指针会话不改名（轮换没发生过）')
  assert.equal(getSetting(db, 'main_session_id'), 'session-old', '指针不回滚也不需要回滚：本来就没切')
  assert.equal(getSetting(db, MAIN_SESSION_CREATED_AT_KEY), String(NOW - 30 * HOUR), '起点时间戳不补（新会话从没当家）')
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_LAST_KEY), undefined, '没发生的轮换不写审计')
  assert.equal(getSetting(db, onboardingKey('session-new')), undefined)
  assert.ok(events.some(([event]) => event === 'main.rotation.recovered-abandoned'))
  db.close()
})

test('S3 恢复 F7（complete）：指针已切 → 补时间戳/跳过 onboarding/补处置旧会话/写审计/清 marker，且可重复执行', async () => {
  const db = await openTestLedger()
  setSetting(db, 'main_session_id', 'session-new')
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ newId: 'session-new', oldId: 'session-old', at: NOW - MINUTE, reasons: ['main-log'] }))
  const archived = []
  const renamed = []
  const events = []
  const result = await recoverPendingRotation({
    db,
    pointer: 'session-new',
    archive: async id => archived.push(id),
    archiveOld: async id => archived.push(id),
    rename: async (id, title) => renamed.push([id, title]),
    now: NOW,
    log: (event, detail) => events.push([event, detail]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'complete')
  assert.equal(result.newId, 'session-new')
  assert.deepEqual(archived, ['session-old'])
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0][0], 'session-old')
  assert.equal(renamed[0][1], retiredMainSessionTitle(NOW - MINUTE))
  assert.equal(getSetting(db, onboardingKey('session-new')), 'sent', '补跳过首次介绍')
  const state = readRotationState(db)
  // 时间戳按 marker.at 补（不补的话冷却期失效，崩溃后可能立刻再轮换一次）。
  assert.equal(state.createdAt, NOW - MINUTE)
  assert.equal(state.rotatedAt, NOW - MINUTE)
  assert.equal(state.pending, null)
  assert.equal(state.last.recovered, true)
  assert.equal(state.last.old, 'session-old')
  assert.equal(state.last.new, 'session-new')
  assert.equal(state.last.renamed, true)
  assert.equal(state.last.archived, true)
  assert.deepEqual(state.last.triggers, ['main-log'], 'marker 只留因子 code，审计照样能复述')
  assert.ok(events.some(([event]) => event === 'main.rotation.recovered-complete'))

  // 幂等：marker 已清，再跑一次什么都不做（不会二次归档/二次改名）。
  const again = await recoverPendingRotation({
    db, pointer: 'session-new', archiveOld: async id => archived.push(id),
    rename: async (id, title) => renamed.push([id, title]), now: NOW + HOUR,
  })
  assert.equal(again.state, 'none')
  assert.deepEqual(archived, ['session-old'])
  assert.equal(renamed.length, 1)
  assert.equal(readRotationState(db).createdAt, NOW - MINUTE, '已有时间戳不被覆盖')
  db.close()
})

test('S3 恢复：marker 坏了只清不清账、无 marker/无指针是 no-op、台账异常只 warn', async () => {
  const db = await openTestLedger()
  assert.deepEqual(await recoverPendingRotation({ db, pointer: 'a', now: NOW }), { ok: true, state: 'none' })
  const warns = []
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ oldId: 'o' }))
  const invalid = await recoverPendingRotation({ db, pointer: 'a', now: NOW, onWarn: message => warns.push(message) })
  assert.equal(invalid.state, 'invalid')
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined, '形状坏了就清掉，绝不猜着归档')
  assert.equal(warns.length, 1)
  // unknown：启动早期还没有指针 → 不动 marker，留给下次。
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ newId: 'n', oldId: 'o', at: NOW }))
  assert.equal((await recoverPendingRotation({ db, pointer: undefined, now: NOW })).state, 'unknown')
  assert.ok(getSetting(db, MAIN_ROTATION_PENDING_KEY), 'marker 保留')
  db.close()

  // 台账读写异常：ok:false + warn，绝不抛（启动恢复不能阻断插件加载）。
  const brokenWarns = []
  const broken = await recoverPendingRotation({
    db: { prepare() { throw new Error('db boom') } }, pointer: 'a', now: NOW, onWarn: message => brokenWarns.push(message),
  })
  assert.equal(broken.ok, false)
  assert.equal(broken.state, 'error')
  assert.match(brokenWarns[0], /主会话轮换恢复失败/)
})
