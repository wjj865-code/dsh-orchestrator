// 交接契约 v1（P2-3 / D2）：字段契约、三条确认路径的 acceptedBy、幂等、超时、JSONL 事件。
//
// 为什么单独一个测试文件：契约一旦发布就是对外承诺（字段名/事件名/幂等语义），
// 这些断言同时是文档（docs/ARCHITECTURE.md「交接契约 v1」）的可执行对照。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask, setTaskAcceptance, transition } from '../src/ledger.js'
import { CLOSE_REASONS, autoCloseChainDelivered, closeDelivered, createDeliveredSweeper } from '../src/delivered.js'
import {
  ACCEPTED_BY, HANDOFF_CONTRACT_VERSION, HANDOFF_EVENT, HANDOFF_FIELDS, acceptedByLabel, acceptedByOf,
  createHandoffLog, handoffOf, handoffOfTask, handoffSnapshot, handoffStatusLines, setHandoffSink,
} from '../src/handoff.js'
import { createTools } from '../src/tools.js'
import { loadConfig } from '../src/config.js'
import { tempDir, sampleBrief } from './helpers.js'

const MINUTE = 60_000

/** 建一条 delivered 任务（delivered_at 由 transition 写入）。 */
const deliveredTask = async (db, { title = '交付', attempt = 1 } = {}) => {
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
  for (let index = 0; index < attempt; index += 1) db.prepare('UPDATE tasks SET attempts = attempts + 1 WHERE id = ?').run(task.id)
  transition(db, task.id, 'delivered')
  return getTask(db, task.id)
}

const handoffFiles = stateDir => readdirSync(join(stateDir, 'handoff'))
  .filter(name => /^handoff-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name))
  .sort()

const readLines = (stateDir, name) => readFileSync(join(stateDir, 'handoff', name), 'utf8')
  .split('\n').filter(line => line !== '').map(line => JSON.parse(line))

test('契约字段：contract=1、字段集合与文档清单一致、未交付任务没有交接', async () => {
  const db = await openLedger(tempDir())
  const pending = createTask(db, { brief: sampleBrief({ title: '还没派' }), coordinatorSession: 's-1' })
  // 「没交付过」≠「交付了但没确认」：前者是 null，读方据此区分，不要给空壳对象。
  assert.equal(handoffOf(pending), null)
  assert.equal(handoffOfTask(db, pending), null)

  const task = await deliveredTask(db, { title: '字段', attempt: 2 })
  setTaskAcceptance(db, task.id, { ok: true, total: 1, passed: 1, skipped: 0, failed: 0, ranAt: 123, cwd: 'C:/tmp', results: [] })
  const handoff = handoffOfTask(db, getTask(db, task.id))
  assert.deepEqual(Object.keys(handoff), [...HANDOFF_FIELDS])
  assert.equal(handoff.contract, HANDOFF_CONTRACT_VERSION)
  assert.equal(handoff.contract, 1)
  assert.equal(handoff.taskId, task.id)
  assert.equal(handoff.sessionId, `c-${task.id}`)
  assert.equal(handoff.title, '字段')
  assert.ok(Number.isFinite(handoff.deliveredAt))
  assert.equal(handoff.acceptedAt, null)
  assert.equal(handoff.acceptedBy, null)
  assert.deepEqual(handoff.rounds, { turns: 2, followups: 0 })
  assert.equal(handoff.evidence.acceptance.ok, true)
  assert.deepEqual(handoff.evidence.artifacts, [])
  assert.equal(handoff.status, 'delivered')
  assert.equal(handoff.closeReason, null)
  db.close()
})

test('确认三条路径：工具=coordinator、面板=panel、超时=timeout，都落 accepted_at', async () => {
  assert.equal(acceptedByOf('panel', CLOSE_REASONS.coordinator), ACCEPTED_BY.panel)
  assert.equal(acceptedByOf('timeout', CLOSE_REASONS.timeout), ACCEPTED_BY.timeout)
  // 不传 by / 传未知值时的兜底：按关闭原因推断，绝不写脏值。
  assert.equal(acceptedByOf(undefined, CLOSE_REASONS.coordinator), ACCEPTED_BY.coordinator)
  assert.equal(acceptedByOf(undefined, CLOSE_REASONS.timeout), ACCEPTED_BY.timeout)
  assert.equal(acceptedByOf('whatever', CLOSE_REASONS.coordinator), ACCEPTED_BY.coordinator)

  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  const dispose = setHandoffSink(createHandoffLog({ db, stateDir }))
  try {
    const coordinator = await deliveredTask(db, { title: '协调者确认' })
    const panel = await deliveredTask(db, { title: '面板确认' })
    const outcome = closeDelivered({ db, taskId: coordinator.id, reason: CLOSE_REASONS.coordinator, by: 'coordinator' })
    assert.equal(outcome.ok, true)
    assert.equal(closeDelivered({ db, taskId: panel.id, reason: CLOSE_REASONS.coordinator, by: 'panel' }).ok, true)
    const closedCoordinator = getTask(db, coordinator.id)
    const closedPanel = getTask(db, panel.id)
    assert.equal(closedCoordinator.accepted_by, 'coordinator')
    assert.equal(closedPanel.accepted_by, 'panel')
    assert.ok(Number.isFinite(closedCoordinator.accepted_at))
    assert.ok(Number.isFinite(closedPanel.accepted_at))
    // 关闭原因仍然如实：面板确认也是「协调者确认」这一关闭原因（acceptedBy 才区分谁点的）。
    assert.equal(closedPanel.close_reason, 'coordinator')
    assert.equal(acceptedByLabel(closedCoordinator.accepted_by), '协调者确认')
    assert.equal(acceptedByLabel(closedPanel.accepted_by), '面板确认')

    // 链式自动放行（chain:'auto'）是第四种确认人：必须能落库、能出标签，且不被白名单吃成 null。
    const chainedUp = createTask(db, {
      brief: sampleBrief({ title: '链式上游', chain: 'auto' }), coordinatorSession: 's-1',
    })
    transition(db, chainedUp.id, 'running', { sessionId: 'c-chain' })
    transition(db, chainedUp.id, 'delivered')
    createTask(db, {
      brief: sampleBrief({ title: '链式下游' }), coordinatorSession: 's-1', dependsOn: [chainedUp.id], status: 'waiting_dep',
    })
    assert.equal(autoCloseChainDelivered({ db, taskId: chainedUp.id }).closed, true)
    const closedChained = getTask(db, chainedUp.id)
    assert.equal(closedChained.accepted_by, 'chain')
    assert.equal(closedChained.close_reason, 'chain')
    assert.equal(acceptedByLabel(closedChained.accepted_by), '链式自动放行')
    const chainedContract = handoffOfTask(db, closedChained)
    assert.equal(chainedContract.acceptedBy, 'chain', 'accepted_by 的取值域必须包含 chain，否则契约会读成 null')

    // 超时 sweeper 也必须区分出来（by=timeout），不能记成 coordinator；事件照发。
    const late = await deliveredTask(db, { title: '超时' })
    db.prepare('UPDATE tasks SET delivered_at = ? WHERE id = ?').run(Date.now() - 61 * MINUTE, late.id)
    const sweeper = createDeliveredSweeper({ db, config: { deliveredTimeoutMinutes: 60 }, intervalMs: 1_000 })
    assert.deepEqual(sweeper.sweep().closed, [late.id])
    sweeper.stop()
    const closedLate = getTask(db, late.id)
    assert.equal(closedLate.status, 'done')
    assert.equal(closedLate.accepted_by, 'timeout')
    assert.equal(closedLate.close_reason, 'timeout')
    assert.ok(Number.isFinite(closedLate.accepted_at))
    assert.ok(closedLate.accepted_at >= closedLate.delivered_at)

    const confirmed = readLines(stateDir, handoffFiles(stateDir)[0])
      .filter(line => line.event === HANDOFF_EVENT.confirmed)
    assert.deepEqual(confirmed.map(line => line.detail.handoff.acceptedBy), ['coordinator', 'panel', 'chain', 'timeout'])
  } finally {
    dispose()
  }
  db.close()
})

test('幂等：重复确认不重写 accepted_at、只发一条 confirmed 事件', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()
  const dispose = setHandoffSink(createHandoffLog({ db, stateDir }))
  try {
    const task = await deliveredTask(db, { title: '幂等' })
    closeDelivered({ db, taskId: task.id, by: 'coordinator' })
    const first = getTask(db, task.id)
    const again = closeDelivered({ db, taskId: task.id, by: 'panel' })
    assert.equal(again.ok, true)
    assert.equal(again.already, true)
    const latest = getTask(db, task.id)
    // 已被协调者确认：重复确认按成功返回，但不改 accepted_by/accepted_at（记录的是真实那一次）。
    assert.equal(latest.accepted_by, first.accepted_by)
    assert.equal(latest.accepted_at, first.accepted_at)
    const lines = readLines(stateDir, handoffFiles(stateDir)[0])
    assert.equal(lines.filter(line => line.event === HANDOFF_EVENT.confirmed).length, 1)
    // 只写了 confirmed 一条事件：delivered 事件由迁移观察者负责（本用例没有接观察者）。
    assert.equal(lines.length, 1)
  } finally {
    dispose()
  }
  db.close()
})

test('JSONL：落 stateDir/handoff/ 按天分文件，字段与契约一致，可轮转', async () => {
  const db = await openLedger(tempDir())
  const stateDir = tempDir()

  // 交付事件：任务进入 delivered（index.js 的迁移观察者走的就是这一条）。
  const first = await deliveredTask(db, { title: '交付事件' })
  const log = createHandoffLog({ db, stateDir })
  assert.notEqual(log.delivered(first), null)
  const [name] = handoffFiles(stateDir)
  assert.match(name, /^handoff-\d{4}-\d{2}-\d{2}\.jsonl$/)
  const [deliveredLine] = readLines(stateDir, name)
  assert.equal(deliveredLine.event, HANDOFF_EVENT.delivered)
  assert.equal(deliveredLine.taskId, first.id)
  assert.equal(deliveredLine.sessionId, `c-${first.id}`)
  assert.equal(deliveredLine.detail.contract, 1)
  assert.deepEqual(Object.keys(deliveredLine.detail.handoff), [...HANDOFF_FIELDS])
  assert.equal(deliveredLine.detail.handoff.acceptedBy, null)
  assert.ok(Number.isFinite(Date.parse(deliveredLine.at)))

  // 确认事件：走进程级 sink（closeDelivered 里发），同一份契约字段。
  const dispose = setHandoffSink(log)
  try {
    closeDelivered({ db, taskId: first.id, by: 'panel' })
  } finally {
    dispose()
  }
  const lines = readLines(stateDir, name)
  assert.equal(lines.length, 2)
  const confirmedLine = lines[1]
  assert.equal(confirmedLine.event, HANDOFF_EVENT.confirmed)
  assert.equal(confirmedLine.detail.handoff.status, 'done')
  assert.equal(confirmedLine.detail.handoff.acceptedBy, 'panel')
  assert.ok(Number.isFinite(confirmedLine.detail.handoff.acceptedAt))

  // 轮转：单文件超 maxBytes 换新（同一套 writer 与运行日志共用，不另写一份）。
  const size = statSync(join(stateDir, 'handoff', name)).size
  const rotated = createHandoffLog({ db, stateDir, maxBytes: size + 1 })
  const second = await deliveredTask(db, { title: '轮转' })
  rotated.delivered(second)
  const files = handoffFiles(stateDir)
  assert.equal(files.length, 2)
  const rotatedName = name.replace('.jsonl', '.2.jsonl')
  assert.ok(files.includes(name))
  assert.ok(files.includes(rotatedName))
  assert.equal(readLines(stateDir, rotatedName).length, 1)
  db.close()
})

test('快照与 task_status：精简字段、未确认文案、确认后带确认人/时间', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db, { title: '状态渲染' })
  // 没有交接（没交付过）的任务：快照为 null，渲染里不出现「交接」段。
  const pending = createTask(db, { brief: sampleBrief({ title: '没交付' }), coordinatorSession: 's-1' })
  assert.equal(handoffSnapshot(pending), null)
  assert.deepEqual(handoffStatusLines(null), [])

  const snapshot = handoffSnapshot(getTask(db, task.id))
  assert.deepEqual(snapshot, {
    contract: 1,
    deliveredAt: getTask(db, task.id).delivered_at,
    acceptedAt: null,
    acceptedBy: null,
    acceptedByLabel: null,
    acceptanceOk: null,
  })
  const unconfirmed = handoffStatusLines(handoffOfTask(db, task)).join('\n')
  assert.match(unconfirmed, /交接：契约 v1/)
  assert.match(unconfirmed, /未确认/)

  closeDelivered({ db, taskId: task.id, by: 'panel' })
  const closed = getTask(db, task.id)
  assert.equal(handoffSnapshot(closed).acceptedBy, 'panel')
  assert.equal(handoffSnapshot(closed).acceptedByLabel, '面板确认')
  const confirmed = handoffStatusLines(handoffOfTask(db, closed)).join('\n')
  assert.match(confirmed, /面板确认/)
  assert.match(confirmed, /交接轮次：派发 1 次｜追问 0 次/)

  // task_status 与面板/JSONL 同源：有交接就渲染，存量行（accepted_* NULL）也照样渲染「未确认」。
  const tools = Object.fromEntries(createTools({
    db,
    config: loadConfig({}),
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  const text = await tools.task_status.execute({ task_id: task.id }, { agent: { id: 's-1' } })
  assert.match(text, /交接：契约 v1/)
  assert.match(text, /面板确认/)
  const pendingText = await tools.task_status.execute({ task_id: pending.id }, { agent: { id: 's-1' } })
  assert.doesNotMatch(pendingText, /交接：契约/)
  db.close()
})

test('追问计数：messages 里的 followup 条数进 rounds.followups', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db, { title: '追问' })
  // 追问 = 一条 followup 消息（task_message / 面板 message 投递成功后落库）。
  db.prepare(`INSERT INTO messages (task_id, seq, kind, rendered, meta_json, at)
    VALUES (?, 1, 'followup', ?, ?, ?)`).run(task.id, '再改一下', JSON.stringify({ delivery: 'delivered' }), Date.now())
  db.prepare(`INSERT INTO messages (task_id, seq, kind, rendered, meta_json, at)
    VALUES (?, 2, 'followup', ?, ?, ?)`).run(task.id, '再改一下 2', JSON.stringify({ delivery: 'delivered' }), Date.now())
  const handoff = handoffOfTask(db, getTask(db, task.id))
  assert.equal(handoff.rounds.followups, 2)
  db.close()
})
