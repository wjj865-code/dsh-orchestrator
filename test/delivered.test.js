import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openLedger, addMessage, createTask, getTask, listTasks, recentMessages, transition } from '../src/ledger.js'
import {
  CLOSE_REASONS, DELIVERED_TIMEOUT_MINUTES, closeDelivered, closeReasonLabel, createDeliveredSweeper,
  findExpiredDelivered,
} from '../src/delivered.js'
import { tempDir, sampleBrief } from './helpers.js'

const MINUTE = 60_000

/** 建一条 running 任务再推到 delivered（delivered_at 由 transition 写入）。 */
const deliveredTask = async (db, { at = Date.now(), title = '交付' } = {}) => {
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
  transition(db, task.id, 'delivered')
  // delivered_at 精确到毫秒不好构造，测试里直接改列（模拟「交付已经过了一段时间」）。
  if (at !== undefined) db.prepare('UPDATE tasks SET delivered_at = ? WHERE id = ?').run(at, task.id)
  return getTask(db, task.id)
}

test('findExpiredDelivered：只挑 delivered 且 delivered_at 早于阈值的任务', async () => {
  const db = await openLedger(tempDir())
  const now = 10_000 * MINUTE
  const old = await deliveredTask(db, { at: now - 61 * MINUTE, title: '过期' })
  const older = await deliveredTask(db, { at: now - 121 * MINUTE, title: '更早过期' })
  const fresh = await deliveredTask(db, { at: now - 5 * MINUTE, title: '还没到' })
  const running = createTask(db, { brief: sampleBrief({ title: '在跑' }), coordinatorSession: 's-1' })
  transition(db, running.id, 'running', { sessionId: 'c-r', target: 'c-r' })
  // 没有 delivered_at（手工改库/异常行）不参与超时：宁可等人工确认，也不猜测。
  const manual = await deliveredTask(db, { at: undefined, title: '无时间' })
  db.prepare('UPDATE tasks SET delivered_at = NULL WHERE id = ?').run(manual.id)
  const idsOf = list => list.map(task => task.id).sort()
  assert.deepEqual(idsOf(findExpiredDelivered({ db, now, timeoutMinutes: 60 })), [old.id, older.id].sort())
  assert.deepEqual(idsOf(findExpiredDelivered({ db, now, timeoutMinutes: 120 })), [older.id])
  assert.deepEqual(findExpiredDelivered({ db, now, timeoutMinutes: 180 }), [])
  // 非法阈值回落默认 60 分钟（而不是把全部 delivered 都当成过期）。
  assert.deepEqual(idsOf(findExpiredDelivered({ db, now, timeoutMinutes: 0 })), [old.id, older.id].sort())
  assert.ok(!idsOf(findExpiredDelivered({ db, now })).includes(fresh.id))
  db.close()
})

test('closeDelivered：delivered → done，写审计消息并依次释放/收口/清理/补位', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db)
  const calls = []
  const outcome = closeDelivered({
    db,
    taskId: task.id,
    reason: CLOSE_REASONS.coordinator,
    releaseSession: id => calls.push(['release', id]),
    completeGoal: closed => calls.push(['goal', closed.id]),
    cleanupWorktree: closed => calls.push(['cleanup', closed.id]),
    pump: () => calls.push(['pump']),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.already, false)
  const closed = getTask(db, task.id)
  assert.equal(closed.status, 'done')
  assert.equal(closed.close_reason, 'coordinator')
  assert.equal(closeReasonLabel(closed.close_reason), '协调者确认')
  // 顺序：先落库写消息，再释放可写根 / 收口 goal / 清检出 / 唤醒队列。
  assert.deepEqual(calls, [
    ['release', task.session_id],
    ['goal', task.id],
    ['cleanup', task.id],
    ['pump'],
  ])
  const closeRow = recentMessages(db, task.id, 1)[0]
  assert.equal(closeRow.kind, 'close')
  assert.match(closeRow.rendered, /协调者确认：已完成/)
  // P2-3 交接契约：审计消息带上确认人（by 未传时按原因推断为 coordinator）。
  assert.deepEqual(closeRow.meta, { closeReason: 'coordinator', status: 'done', acceptedBy: 'coordinator' })
  db.close()
})

test('closeDelivered：链式自动放行（by=chain）落 close_reason=chain、accepted_by=chain、accepted_kind=delivery', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db)
  const outcome = closeDelivered({ db, taskId: task.id, reason: CLOSE_REASONS.chain, by: 'chain' })
  assert.equal(outcome.ok, true)
  const closed = getTask(db, task.id)
  assert.equal(closed.status, 'done')
  assert.equal(closed.close_reason, 'chain')
  assert.equal(closed.accepted_by, 'chain')
  assert.equal(closed.accepted_kind, 'delivery')
  assert.equal(closeReasonLabel(closed.close_reason), '链式自动放行')
  const closeRow = recentMessages(db, task.id, 1)[0]
  assert.match(closeRow.rendered, /链式自动放行：已完成/)
  assert.deepEqual(closeRow.meta, { closeReason: 'chain', status: 'done', acceptedBy: 'chain' })
  // 幂等：再确认一次走 already，不重写 accepted_at。
  const again = closeDelivered({ db, taskId: task.id, reason: CLOSE_REASONS.chain, by: 'chain' })
  assert.equal(again.already, true)
  assert.equal(getTask(db, task.id).accepted_at, closed.accepted_at)
  db.close()
})

test('closeDelivered：幂等与门控（done 重复确认、其它状态拒绝）', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db)
  closeDelivered({ db, taskId: task.id })
  const again = closeDelivered({ db, taskId: task.id })
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  // 只写了一条 close 消息，不重复落库。
  assert.equal(recentMessages(db, task.id, 10).filter(row => row.kind === 'close').length, 1)

  const running = createTask(db, { brief: sampleBrief({ title: '在跑' }), coordinatorSession: 's-1' })
  transition(db, running.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  assert.deepEqual(closeDelivered({ db, taskId: running.id }), { ok: false, reason: 'not-delivered', task: getTask(db, running.id) })
  assert.deepEqual(closeDelivered({ db, taskId: 't-nope' }), { ok: false, reason: 'not-found' })
  assert.equal(getTask(db, running.id).status, 'running')
  db.close()
})

test('createDeliveredSweeper：启动即扫、只收超时任务、stop 后不再扫', async () => {
  const db = await openLedger(tempDir())
  const now = 5 * 60 * MINUTE
  const old = await deliveredTask(db, { at: now - 61 * MINUTE, title: '过期' })
  const fresh = await deliveredTask(db, { at: now - 5 * MINUTE, title: '新交付' })
  const calls = []
  const sweeper = createDeliveredSweeper({
    db,
    config: { deliveredTimeoutMinutes: 60 },
    now: () => now,
    intervalMs: 5,
    releaseSession: id => calls.push(['release', id]),
    completeGoal: task => calls.push(['goal', task.id]),
    cleanupWorktree: () => {},
    pump: () => calls.push(['pump']),
  })
  // start 会先扫一次：启动前就过期的 delivered 也要收掉（进程重启场景）。
  sweeper.start()
  assert.equal(getTask(db, old.id).status, 'done')
  assert.equal(getTask(db, old.id).close_reason, 'timeout')
  assert.equal(getTask(db, fresh.id).status, 'delivered')
  assert.ok(calls.some(([kind, id]) => kind === 'goal' && id === old.id))
  const result = sweeper.sweep()
  assert.deepEqual(result, { checked: 0, closed: [] })
  sweeper.stop()
  assert.equal(sweeper.timeoutMinutes(), 60)
  db.close()
})

test('createDeliveredSweeper：timeoutMinutes 跟随 config，巡检异常只告警不抛', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db, { at: Date.now() - 2 * MINUTE, title: '两分钟前' })
  const warnings = []
  const sweeper = createDeliveredSweeper({
    db,
    config: { deliveredTimeoutMinutes: 1 },
    intervalMs: 5,
    onWarn: message => warnings.push(message),
  })
  const result = sweeper.sweep()
  // 1 分钟阈值：2 分钟前交付的任务被收掉。
  assert.deepEqual(result.closed, [task.id])
  assert.equal(getTask(db, task.id).status, 'done')
  assert.deepEqual(warnings, [])
  sweeper.stop()

  // 台账被关掉后巡检：只告警、不抛（定时器不能在异常里把进程带崩）。
  db.close()
  const broken = createDeliveredSweeper({ db, onWarn: message => warnings.push(message), intervalMs: 5 })
  assert.deepEqual(broken.sweep(), { checked: 0, closed: [], skipped: 'error' })
  assert.equal(warnings.length, 1)
  broken.stop()
})

test('默认超时是 60 分钟（配置缺省时按它判过期）', async () => {
  const db = await openLedger(tempDir())
  const now = Date.now()
  const old = await deliveredTask(db, { at: now - (DELIVERED_TIMEOUT_MINUTES + 1) * MINUTE, title: '默认过期' })
  const fresh = await deliveredTask(db, { at: now - 30 * MINUTE, title: '默认未过期' })
  const expired = findExpiredDelivered({ db, now })
  assert.deepEqual(expired.map(task => task.id), [old.id])
  assert.ok(!expired.some(task => task.id === fresh.id))
  db.close()
})

test('审计消息：超时关闭写「超时自动完成」，与协调者确认可区分', async () => {
  const db = await openLedger(tempDir())
  const task = await deliveredTask(db)
  closeDelivered({ db, taskId: task.id, reason: CLOSE_REASONS.timeout })
  const row = recentMessages(db, task.id, 1)[0]
  assert.match(row.rendered, /超时自动完成/)
  assert.equal(getTask(db, task.id).close_reason, 'timeout')
  db.close()
})

// 迁移兼容：0.13.2 的台账没有 delivered_at / close_reason 两列，且存量 done 行必须原样保留。
test('迁移兼容：旧库自动补两列，存量 done 行不动（状态/时间/返回消息都不变）', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'tasks.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, artifacts_json TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER, read_only INTEGER NOT NULL DEFAULT 0,
    retry_of TEXT, depends_json TEXT, group_id TEXT, write_scopes_json TEXT, priority INTEGER NOT NULL DEFAULT 0,
    question TEXT, question_options_json TEXT, progress_count INTEGER NOT NULL DEFAULT 0, stall_notified_at INTEGER,
    goal_state_json TEXT, last_message_json TEXT, keep_alive_rounds INTEGER NOT NULL DEFAULT 0,
    plan_first INTEGER NOT NULL DEFAULT 0, plan_state TEXT,
    worktree_path TEXT, worktree_branch TEXT, repo_root TEXT, worktree_base TEXT,
    worktree_mode TEXT, worktree_source TEXT, worktree_state TEXT
  )`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, attempts, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 100, 200, 200)`).run('t-legacy', '旧任务', '旧目标', '{}', 'done', 's-1')
  legacy.close()

  const db = await openLedger(dir)
  // 两列已补齐，旧行取值为 NULL（不是 0，也不是脏字符串）。
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(columns.includes('delivered_at'))
  assert.ok(columns.includes('close_reason'))
  const legacyRow = getTask(db, 't-legacy')
  assert.equal(legacyRow.status, 'done')
  assert.equal(legacyRow.delivered_at, null)
  assert.equal(legacyRow.close_reason, null)
  assert.equal(legacyRow.last_message, null)
  // 存量 done 不参与活跃集合、也不会被 sweeper 当成待确认。
  assert.deepEqual(listTasks(db, { active: true }).map(task => task.id), [])
  assert.deepEqual(findExpiredDelivered({ db, now: Date.now(), timeoutMinutes: 1 }), [])
  // 旧行照常可以走「done 重复确认」的幂等路径；新列可写。
  assert.equal(closeDelivered({ db, taskId: 't-legacy' }).already, true)
  addMessage(db, 't-legacy', { kind: 'close', rendered: '审计' })
  assert.doesNotThrow(() => db.prepare('UPDATE tasks SET delivered_at = 1, close_reason = ? WHERE id = ?').run('coordinator', 't-legacy'))
  db.close()
})

// 面板口径直接读源码（不依赖 dist 构建产物）：服务端状态值、文案、色调、筛选必须一致。
test('面板口径：待确认文案/色调 + 「待你决定」筛选包含 delivered', async () => {
  const { STATUS_LABEL, STATUS_TONE } = await import('../client/src/constants.js')
  assert.equal(STATUS_LABEL.delivered, '待确认')
  assert.equal(STATUS_TONE.delivered, 'warn')
  const { countTasks, matchesFilter } = await import('../client/src/logic.js')
  assert.equal(matchesFilter({ status: 'delivered' }, 'waiting'), true)
  assert.equal(matchesFilter({ status: 'delivered' }, 'active'), false)
  assert.equal(matchesFilter({ status: 'done' }, 'waiting'), false)
  const counts = countTasks([{ status: 'delivered' }, { status: 'done' }, { status: 'running' }])
  assert.equal(counts.waiting, 1)
  assert.equal(counts.done, 1)
  assert.equal(counts.active, 1)
})
