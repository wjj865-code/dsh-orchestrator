// S1 判定内核单测：11 个配置键 + evaluateRotation 纯函数（M1–M6 因子、P1–P10 保护、冷却/最小龄）。
// S2 采集层单测：M1–M6 采集/降级、settings 键读写、due 标记、snapshot 只读形状、pending 只读判定。
// 口径：本文件只测「怎么判/怎么采」，不碰轮换动作——轮换动作（S3）与真机接线（S4）另有测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_ROTATION_AT_KEY, MAIN_ROTATION_DUE_KEY, MAIN_ROTATION_LAST_KEY, MAIN_ROTATION_PENDING_KEY,
  MAIN_SESSION_CREATED_AT_KEY, ROTATION_BLOCKS, ROTATION_DEFAULTS, ROTATION_LIMITS, ROTATION_TRIGGERS,
  collectRotationMetrics, evaluateAndMarkRotation, evaluateRotation, inspectRotationPending,
  normalizeRotationConfig, readRotationState, rotationHeadline, rotationStatus, writeRotationDue,
  writeRotationState,
} from '../src/main-rotation.js'
import { createTask, getSetting, openLedger, setSetting } from '../src/ledger.js'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const NOW = 1_760_000_000_000
const MIB = 1024 * 1024
const BASE_METRICS = { tasksSince: 10, sessionsSince: 5, mainLogMiB: 0.5, contextTokens: 10_000, diskMiB: 20 }

/** 健康基线：龄 40h（> 最小龄 12h）、上次轮换 50h 前（> 冷却 48h）、所有因子都没到阈值、无保护命中。 */
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

/** 六因子同时命中的输入（用于 off/保护/优先级用例：有触发但被挡住）。 */
const allTriggersInput = (overrides = {}) => baseInput({
  since: NOW - 240 * HOUR,
  metrics: { tasksSince: 500, sessionsSince: 200, mainLogMiB: 10, contextTokens: 200_000, diskMiB: 600 },
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
    'ageHours', 'contextTokens', 'diskMiB', 'hoursSinceRotation', 'idleMinutes',
    'mainLogMiB', 'sessionsSince', 'tasksSince',
  ])
  assert.equal(decision.metrics.ageHours, 40)
  assert.equal(decision.metrics.hoursSinceRotation, 50)
  assert.equal(decision.metrics.idleMinutes, 30)
})

test('纯函数：同一输入同一结论，不改入参，输出可安全丢弃', () => {
  const input = baseInput({ metrics: { tasksSince: 120 } })
  const snapshot = JSON.stringify(input)
  const first = evaluateRotation(input)
  const second = evaluateRotation(input)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(input), snapshot)
  // 返回值是本次判定的独立快照：改它不影响下一次。
  first.reasons.length = 0
  first.metrics.tasksSince = 0
  const third = evaluateRotation(input)
  assert.equal(third.due, true)
  assert.equal(third.reasons.length, 1)
})

test('每个触发因子单独命中都能 due（M1–M6）', () => {
  const cases = [
    ['tasks', baseInput({ metrics: { tasksSince: 120 } })],
    ['sessions', baseInput({ metrics: { sessionsSince: 80 } })],
    ['main-log', baseInput({ metrics: { mainLogMiB: 6 } })],
    ['context-tokens', baseInput({ metrics: { contextTokens: 150_000 } })],
    ['age', baseInput({ since: NOW - 240 * HOUR })],
    ['disk', baseInput({ metrics: { diskMiB: 512 } })],
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
})

test('阈值边界：略小于不触发，等于/超过触发（>= 口径）', () => {
  const cases = [
    ['tasks', value => baseInput({ metrics: { tasksSince: value } }), 119, 120],
    ['sessions', value => baseInput({ metrics: { sessionsSince: value } }), 79, 80],
    ['main-log', value => baseInput({ metrics: { mainLogMiB: value } }), 5.99, 6],
    ['context-tokens', value => baseInput({ metrics: { contextTokens: value } }), 149_999, 150_000],
    ['age', value => baseInput({ since: NOW - value * HOUR }), 239.5, 240],
    ['disk', value => baseInput({ metrics: { diskMiB: value } }), 511, 512],
  ]
  for (const [code, build, below, at] of cases) {
    assert.equal(evaluateRotation(build(below)).triggers.includes(code), false, `${code}: ${below} 不该触发`)
    assert.equal(evaluateRotation(build(at)).triggers.includes(code), true, `${code}: ${at} 应触发`)
    assert.equal(evaluateRotation(build(at + 1)).triggers.includes(code), true, `${code}: ${at + 1} 应触发`)
  }
})

test('多因子同时命中：每个因子只记一条，顺序稳定（M1→M6）', () => {
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

test('off 模式：因子照算，但永不 due（只检测不动作）', () => {
  const decision = evaluateRotation(allTriggersInput({ config: { mainRotation: 'off', spawnProvider: 'spawn' } }))
  assert.equal(decision.mode, 'off')
  assert.equal(decision.due, false)
  // 仍然把「本来会命中」的因子报出来，方便日志核对关闭期间本会轮换几次。
  assert.deepEqual(decision.triggers, ROTATION_TRIGGERS)
  assert.equal(decision.blockedBy[0].code, 'mode-off')
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

test('P10：所有触发指标都拿不到 → fail-closed，只记 degraded', () => {
  const decision = evaluateRotation({ now: NOW, config: {}, tasks: [] })
  assert.equal(decision.due, false)
  assert.deepEqual(decision.triggers, [])
  assert.deepEqual(codesOf(decision.blockedBy), ['metrics-degraded'])
  assert.deepEqual(decision.degraded, [...ROTATION_TRIGGERS])
  for (const value of Object.values(decision.metrics)) assert.equal(value, null)
  // 调用方已知的采集失败与本次缺席合并去重。
  const merged = evaluateRotation({ now: NOW, config: {}, degraded: ['main-log', 'tokens'] })
  assert.deepEqual(merged.degraded, [...ROTATION_TRIGGERS, 'tokens'])
})

test('指标部分缺失：其余因子照常判定（不是 fail-closed）', () => {
  // since 拿不到 → M1/M2/M5 缺席，但 M3 日志体积仍能命中。
  const decision = evaluateRotation({
    now: NOW,
    config: {},
    since: undefined,
    metrics: { mainLogMiB: 7, diskMiB: 20 },
    logMtimeAt: NOW - 30 * MINUTE,
  })
  assert.equal(decision.due, true)
  assert.deepEqual(decision.triggers, ['main-log'])
  assert.deepEqual(decision.blockedBy, [])
  assert.deepEqual(decision.degraded, ['tasks', 'sessions', 'context-tokens', 'age'])
  // 没有 since 时 metrics 里 tasksSince 即使传了也不能用（口径不可信）。
  const untrusted = evaluateRotation({
    now: NOW,
    config: {},
    metrics: { tasksSince: 999, mainLogMiB: 0.1 },
  })
  assert.equal(untrusted.due, false)
  assert.equal(untrusted.metrics.tasksSince, null)
})

test('非法/坏配置在判定内回落或夹取，不抛错', () => {
  // 0 → 回落默认 120；119 个任务不触发。
  assert.equal(evaluateRotation(baseInput({ config: { rotateAfterTasks: 0 }, metrics: { tasksSince: 119 } })).due, false)
  // 合法小阈值 → 命中。
  assert.equal(evaluateRotation(baseInput({ config: { rotateAfterTasks: 119 }, metrics: { tasksSince: 119 } })).due, true)
  // 字符串不算数字 → 回落默认 6 MiB。
  assert.equal(evaluateRotation(baseInput({ config: { rotateAfterMainLogMiB: '1' }, metrics: { mainLogMiB: 6 } })).due, true)
  // 越界夹到上界 4096 → 6 MiB 不再命中。
  assert.equal(evaluateRotation(baseInput({ config: { rotateAfterMainLogMiB: 1e9 }, metrics: { mainLogMiB: 6 } })).due, false)
  // 负数回落默认 10 天 → 240h 命中。
  assert.equal(evaluateRotation(baseInput({ config: { rotateAfterDays: -1 }, since: NOW - 240 * HOUR })).due, true)
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
    metrics: { tasksSince: 500 },
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

test('配置键契约：11 个键、默认值、区间与 loadConfig 接线一致', () => {
  assert.deepEqual(Object.keys(ROTATION_DEFAULTS).sort(), [
    'mainRotation', 'rotateAfterContextTokens', 'rotateAfterDays', 'rotateAfterDiskMiB',
    'rotateAfterMainLogMiB', 'rotateAfterSessions', 'rotateAfterTasks', 'rotateArchiveOld',
    'rotateCooldownHours', 'rotateIdleMinutes', 'rotateMinAgeHours',
  ])
  assert.equal(Object.keys(ROTATION_LIMITS).length, 9, '除总开关与归档开关外都是数值键')
  const config = loadConfig({})
  for (const [key, value] of Object.entries(ROTATION_DEFAULTS)) {
    assert.equal(config[key], value, `loadConfig 应挂上 ${key}`)
  }
  // 归一化幂等：loadConfig 出来的配置再归一化一次不变。
  assert.deepEqual(normalizeRotationConfig(config), { ...ROTATION_DEFAULTS })
})

test('settings 键名固定（S2 写入 / S3 读取的契约）', () => {
  assert.deepEqual(
    {
      created: MAIN_SESSION_CREATED_AT_KEY,
      rotatedAt: MAIN_ROTATION_AT_KEY,
      due: MAIN_ROTATION_DUE_KEY,
      last: MAIN_ROTATION_LAST_KEY,
      pending: MAIN_ROTATION_PENDING_KEY,
    },
    {
      created: 'main_session_created_at',
      rotatedAt: 'main_rotation_at',
      due: 'main_rotation_due',
      last: 'main_rotation_last',
      pending: 'main_rotation_pending',
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
// S2：指标采集层（M1–M6，逐项降级）+ settings 键读写 + snapshot 只读形状
// ---------------------------------------------------------------------------

const openTestLedger = () => openLedger(tempDir())

const headerOf = (id, cwd, createdAt) => ({ id, cwd, createdAt })

const fakePersistence = ({ headers = [], fail = {} } = {}) => {
  const calls = { listSnapshots: 0, locate: 0 }
  return {
    calls,
    async listSnapshots() {
      calls.listSnapshots += 1
      if (fail.listSnapshots) throw new Error(fail.listSnapshots)
      return headers.map(header => ({ header, revision: 'rev-1' }))
    },
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

/** 造任务并钉住 created_at（M1 口径要可构造）。 */
const makeTaskAt = (db, createdAt, title = 't') => {
  const task = createTask(db, { brief: { title, goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(createdAt, task.id)
  return task
}

const rowCounts = db => ({
  tasks: db.prepare('SELECT count(*) AS n FROM tasks').get().n,
  settings: db.prepare('SELECT count(*) AS n FROM settings').get().n,
})

test('S2 采集：M1–M6 全量成功，指标按口径算，采集本身零写入', async () => {
  const db = await openTestLedger()
  const since = NOW - 10 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  makeTaskAt(db, since - HOUR, '旧任务')
  makeTaskAt(db, since + HOUR, '新任务')
  const mainHeader = headerOf('s-1', 'C:/ws', since - 2 * HOUR)
  const persistence = fakePersistence({
    headers: [
      mainHeader,
      headerOf('c-1', 'C:/ws', since + MINUTE),
      headerOf('c-0', 'C:/ws', since - MINUTE),
      headerOf('o-1', 'C:/other', since + MINUTE),
    ],
  })
  const sizes = {
    'C:/sessions/s-1.jsonl': 2 * MIB,
    'C:/sessions/c-1.jsonl': 1 * MIB,
    'C:/sessions/c-0.jsonl': 3 * MIB,
    'C:/sessions/o-1.jsonl': 9 * MIB,
  }
  const before = rowCounts(db)
  const collected = await collectRotationMetrics({
    db,
    persistence,
    tokenMeter: { measure: () => ({ totalTokens: 12_345 }) },
    mainSessionId: 's-1',
    mainSession: { header: mainHeader },
    workspaceCwd: 'C:/ws',
    now: NOW,
    statFile: statFrom(sizes),
  })
  assert.equal(collected.since, since)
  assert.equal(collected.sinceSource, 'settings')
  assert.deepEqual(collected.metrics, {
    tasksSince: 1,
    sessionsSince: 1,
    mainLogMiB: 2,
    // M6 只统计 cwd=指挥舱：2 + 1 + 3 = 6 MiB（别的 cwd 的 9 MiB 不算）。
    contextTokens: 12_345,
    diskMiB: 6,
  })
  assert.deepEqual(collected.degraded, [])
  assert.equal(collected.scanned, 4)
  assert.equal(collected.logMtimeAt, NOW - 30 * MINUTE)
  // 采集只读：台账/settings 行数不变。
  assert.deepEqual(rowCounts(db), before)
  db.close()
})

test('S2 采集：settings 缺 created_at 时退 header.createdAt；都缺则整组降级为未知', async () => {
  const db = await openTestLedger()
  const headerAt = NOW - 20 * HOUR
  makeTaskAt(db, headerAt + HOUR)
  const mainHeader = headerOf('s-1', 'C:/ws', headerAt)
  const collected = await collectRotationMetrics({
    db,
    persistence: fakePersistence({ headers: [mainHeader] }),
    mainSessionId: 's-1',
    mainSession: { header: mainHeader },
    workspaceCwd: 'C:/ws',
    now: NOW,
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': MIB }),
  })
  assert.equal(collected.since, headerAt)
  assert.equal(collected.sinceSource, 'header')
  assert.equal(collected.metrics.tasksSince, 1)

  // 既没有 settings 也没有 header（没有 live 会话、persistence 缺失）→ M1/M2/M5 未知。
  const db2 = await openTestLedger()
  const unknown = await collectRotationMetrics({ db: db2, now: NOW })
  assert.equal(unknown.since, null)
  assert.equal(unknown.sinceSource, null)
  assert.equal(unknown.metrics.tasksSince, null)
  assert.equal(unknown.metrics.sessionsSince, null)
  for (const factor of ['tasks', 'sessions', 'age']) assert.ok(unknown.degraded.includes(factor), factor)
  db.close()
  db2.close()
})

test('S2 采集：服务全缺失时每项降级为 null（未知，不是 0）并 fail-closed', async () => {
  const db = await openTestLedger()
  const collected = await collectRotationMetrics({ db, now: NOW })
  assert.deepEqual(collected.metrics, {
    tasksSince: null, sessionsSince: null, mainLogMiB: null, contextTokens: null, diskMiB: null,
  })
  for (const factor of ['sessions', 'disk', 'tasks', 'age', 'main-log', 'context-tokens']) {
    assert.ok(collected.degraded.includes(factor), `${factor} 应记 degraded`)
  }
  // 六指标全未知 → 判定 fail-closed（不轮换），且面板看得见 degraded。
  const decision = evaluateRotation({
    now: NOW,
    config: {},
    since: collected.since ?? undefined,
    metrics: collected.metrics,
    degraded: collected.degraded,
  })
  assert.equal(decision.due, false)
  assert.deepEqual(decision.blockedBy.map(item => item.code), ['metrics-degraded'])
  assert.deepEqual(decision.metrics, {
    tasksSince: null, sessionsSince: null, mainLogMiB: null, contextTokens: null,
    ageHours: null, diskMiB: null, hoursSinceRotation: null, idleMinutes: null,
  })
  db.close()
})

test('S2 采集：单项失败只降级该项，其余照算（不互相拖累）', async () => {
  const db = await openTestLedger()
  const since = NOW - 30 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since)
  const persistence = fakePersistence({ headers: [mainHeader], fail: { listSnapshots: '清单读取失败' } })
  const collected = await collectRotationMetrics({
    db,
    persistence,
    tokenMeter: { measure: () => { throw new Error('meter boom') } },
    mainSessionId: 's-1',
    mainSession: { header: mainHeader },
    workspaceCwd: 'C:/ws',
    now: NOW,
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': 1024 }),
  })
  // M1 仍可算（没有任务 = 0，这是真实计数）；M3 仍可算；M2/M6 因 listSnapshots 失败降级；M4 因测量抛错降级。
  assert.equal(collected.metrics.tasksSince, 0)
  assert.equal(collected.metrics.mainLogMiB, 1024 / MIB)
  assert.equal(collected.metrics.sessionsSince, null)
  assert.equal(collected.metrics.diskMiB, null)
  assert.equal(collected.metrics.contextTokens, null)
  for (const factor of ['sessions', 'disk', 'context-tokens']) assert.ok(collected.degraded.includes(factor), factor)
  assert.equal(collected.degraded.includes('tasks'), false)
  assert.equal(collected.degraded.includes('main-log'), false)

  // stat 失败只降级 main-log（M6 也已因清单失败而降级）。
  const statBroken = await collectRotationMetrics({
    db,
    persistence: fakePersistence({ headers: [mainHeader] }),
    mainSessionId: 's-1',
    mainSession: { header: mainHeader },
    workspaceCwd: 'C:/ws',
    now: NOW,
    statFile: async () => { throw new Error('stat boom') },
  })
  assert.equal(statBroken.metrics.mainLogMiB, null)
  assert.ok(statBroken.degraded.includes('main-log'))
  // M6 有目标会话但每条 stat 都失败 → 数值未知 + degraded（不是 0）。
  assert.equal(statBroken.metrics.diskMiB, null)
  assert.ok(statBroken.degraded.includes('disk'))
  db.close()
})

test('S2 采集：measure 返回不含 totalTokens 时按未知处理', async () => {
  const db = await openTestLedger()
  const since = NOW - 30 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since)
  const collected = await collectRotationMetrics({
    db,
    persistence: fakePersistence({ headers: [mainHeader] }),
    tokenMeter: { measure: () => ({ surfaceTokens: 10 }) },
    mainSessionId: 's-1',
    mainSession: { header: mainHeader },
    workspaceCwd: 'C:/ws',
    now: NOW,
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': MIB }),
  })
  assert.equal(collected.metrics.contextTokens, null)
  assert.ok(collected.degraded.includes('context-tokens'))
  db.close()
})

test('S2 evaluateAndMarkRotation：采集+判定后写 main_rotation_due，指针/审计/marker 都不动', async () => {
  const db = await openTestLedger()
  const since = NOW - 30 * HOUR
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(since))
  const mainHeader = headerOf('s-1', 'C:/ws', since)
  const events = []
  const result = await evaluateAndMarkRotation({
    db,
    config: { mainRotation: 'auto', spawnProvider: 'spawn' },
    persistence: fakePersistence({ headers: [mainHeader] }),
    mainSessionId: 's-1',
    liveAgent: { status: 'idle', session: { header: mainHeader } },
    workspaceCwd: 'C:/ws',
    source: 'startup',
    now: NOW,
    statFile: statFrom({ 'C:/sessions/s-1.jsonl': 8 * MIB }),
    log: (event, fields) => events.push([event, fields]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.decision.due, true)
  assert.deepEqual(result.decision.triggers, ['main-log'])
  assert.equal(result.record.due, true)
  assert.equal(result.pending.state, 'none')
  const due = JSON.parse(getSetting(db, MAIN_ROTATION_DUE_KEY))
  assert.equal(due.due, true)
  assert.equal(due.source, 'startup')
  assert.equal(due.mainSessionId, 's-1')
  assert.equal(due.since, since)
  assert.deepEqual(due.triggers, ['main-log'])
  assert.equal(due.evaluatedAt, NOW)
  // 只写 due 一个键：S3 的指针/冷却/审计/marker 一律没碰。
  assert.equal(getSetting(db, 'main_session_id'), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_AT_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_LAST_KEY), undefined)
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined)
  // 决策日志（事后复盘入口）带 reasons/blockedBy/metrics。
  const decided = events.find(([event]) => event === 'main.rotation.decided')
  assert.ok(decided, '应写 main.rotation.decided')
  assert.equal(decided[1].detail.due, true)
  assert.deepEqual(decided[1].detail.triggers, ['main-log'])
  assert.equal(decided[1].detail.source, 'startup')
  db.close()
})

test('S2 evaluateAndMarkRotation：配置覆盖/未打开主会话都不检测、不写 due', async () => {
  const db = await openTestLedger()
  const overridden = await evaluateAndMarkRotation({
    db, config: { coordinatorSession: 's-override' }, mainSessionId: 's-override', now: NOW,
  })
  assert.deepEqual(overridden, { ok: true, skipped: 'coordinator-override' })
  const none = await evaluateAndMarkRotation({ db, config: {}, mainSessionId: undefined, now: NOW })
  assert.deepEqual(none, { ok: true, skipped: 'no-main-session' })
  assert.equal(getSetting(db, MAIN_ROTATION_DUE_KEY), undefined)
  db.close()
})

test('S2 evaluateAndMarkRotation：整体异常 fail-closed（不写、不抛，只 warn）', async () => {
  const warnings = []
  const brokenDb = { prepare() { throw new Error('db boom') } }
  const result = await evaluateAndMarkRotation({
    db: brokenDb, config: {}, mainSessionId: 's-1', source: 'startup', now: NOW,
    onWarn: message => warnings.push(message),
  })
  assert.equal(result.ok, false)
  assert.equal(result.decision, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /主会话轮换检测失败/)
})

test('S2 rotationStatus：字段形状固定，未判定/坏值按未知，读取零写入零采集', async () => {
  const db = await openTestLedger()
  const unknownShape = { due: null, reasons: [], metrics: null, evaluatedAt: null, lastRotatedAt: null }
  assert.deepEqual(rotationStatus(db), unknownShape)
  const before = rowCounts(db)
  rotationStatus(db)
  assert.deepEqual(rowCounts(db), before, 'rotationStatus 只读')

  // 坏 JSON 不抛，落回未知。
  setSetting(db, MAIN_ROTATION_DUE_KEY, '{not json')
  assert.deepEqual(rotationStatus(db), unknownShape)

  const decision = evaluateRotation(allTriggersInput())
  writeRotationDue(db, decision, { source: 'startup', mainSessionId: 's-1', since: NOW - 240 * HOUR })
  setSetting(db, MAIN_ROTATION_AT_KEY, String(NOW - 1 * HOUR))
  const status = rotationStatus(db)
  assert.deepEqual(Object.keys(status).sort(), ['due', 'evaluatedAt', 'lastRotatedAt', 'metrics', 'reasons'])
  assert.equal(status.due, true)
  assert.deepEqual(status.reasons.map(reason => reason.code), ROTATION_TRIGGERS)
  assert.deepEqual(status.metrics, decision.metrics)
  assert.equal(status.evaluatedAt, NOW)
  assert.equal(status.lastRotatedAt, NOW - 1 * HOUR)
  db.close()
})

test('S2 settings 键读写与 pending marker 只读判定（S2 只算不执行）', async () => {
  const db = await openTestLedger()
  assert.deepEqual(readRotationState(db), { createdAt: null, rotatedAt: null, due: null, last: null, pending: null })
  setSetting(db, MAIN_SESSION_CREATED_AT_KEY, String(NOW - HOUR))
  setSetting(db, MAIN_ROTATION_AT_KEY, String(NOW - MINUTE))
  setSetting(db, MAIN_ROTATION_LAST_KEY, JSON.stringify({ old: 'a', new: 'b', at: NOW }))
  setSetting(db, MAIN_ROTATION_PENDING_KEY, JSON.stringify({ newId: 'new-1', oldId: 'old-1', at: NOW }))
  const state = readRotationState(db)
  assert.equal(state.createdAt, NOW - HOUR)
  assert.equal(state.rotatedAt, NOW - MINUTE)
  assert.deepEqual(state.last, { old: 'a', new: 'b', at: NOW })
  assert.deepEqual(state.pending, { newId: 'new-1', oldId: 'old-1', at: NOW })
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
    due: { due: false, source: 'manual' },
    last: { old: 'a', new: 'b', at: NOW },
    pending: { newId: 'new-1', oldId: 'a', at: NOW },
  })
  assert.equal(written.createdAt, String(NOW - HOUR))
  assert.equal(written.due, JSON.stringify({ due: false, source: 'manual' }))
  const state = readRotationState(db)
  assert.equal(state.createdAt, NOW - HOUR)
  assert.equal(state.rotatedAt, NOW - MINUTE)
  assert.deepEqual(state.due, { due: false, source: 'manual' })
  assert.deepEqual(state.last, { old: 'a', new: 'b', at: NOW })
  assert.deepEqual(state.pending, { newId: 'new-1', oldId: 'a', at: NOW })
  // null 删键；没提到的键保持原样。
  writeRotationState(db, { pending: null, last: undefined })
  assert.equal(getSetting(db, MAIN_ROTATION_PENDING_KEY), undefined)
  assert.deepEqual(readRotationState(db).last, { old: 'a', new: 'b', at: NOW })
  assert.equal(readRotationState(db).pending, null)
  db.close()
})
