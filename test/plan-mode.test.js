// P8 子任务计划模式：纯映射、台账两列、task_create/task_message 契约、派发进入/退出、
// 面板与 task_status 视图。运行期真相在会话日志（plan/mode），台账只存编排视图
// （plan_first / plan_state），所以这里既断运行期调用，也断台账视图。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, recentMessages, transition, setPlanState, setTaskPlanPath } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createSubagentDispatcher } from '../src/dispatch.js'
import { createHostRoute } from '../src/host-route.js'
import { createPanelActions } from '../src/panel-actions.js'
import { renderTaskDetail } from '../src/task-detail.js'
import {
  PLAN_STATE_LABEL, PLAN_STATES, PLAN_FIRST_DETAIL, EXIT_PLAN_MODE_DENIAL, UNAPPROVED_PLAN_STATES,
  planApproveGate, planListMarker, planStatusLine, dispatchReadOnly,
} from '../src/plan-mode.js'
import { __resetHolds, isWriteHeld, writeHoldCount } from '../src/write-hold.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

const planTaskRow = (db, { status = 'running', planPath = null } = {}) => {
  const task = createTask(db, { brief: sampleBrief({ title: '计划任务', goal: 'g' }), coordinatorSession: 's-1', planFirst: true })
  if (status !== 'pending') transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  if (status === 'waiting_user') transition(db, task.id, 'waiting_user')
  if (status === 'cancelled') transition(db, task.id, 'cancelled')
  if (planPath !== null) setTaskPlanPath(db, task.id, planPath)
  return getTask(db, task.id)
}

// —— 一、纯映射：文案/标记只从这里来，避免工具与面板各写一套 ——

test('P8 计划状态映射：六值 = 四态 + none/rejected；列表只标未批准三态', () => {
  assert.deepEqual(Object.keys(PLAN_STATE_LABEL), ['none', 'planning', 'waiting_user', 'revising', 'approved', 'rejected'])
  assert.deepEqual(PLAN_STATES, ['none', 'planning', 'waiting_user', 'revising', 'approved', 'rejected'])
  assert.deepEqual(UNAPPROVED_PLAN_STATES, ['planning', 'waiting_user', 'revising'])
  const task = { id: 't-1', plan_first: true, plan_state: 'planning' }
  assert.equal(planListMarker(task), '·计划中')
  assert.match(planStatusLine(task), /计划中/)
  assert.match(planStatusLine(task), /action: "approve"/)
  // 未批准三态各自有小标与状态行；approved 不占视觉。
  assert.equal(planListMarker({ id: 't-1', plan_first: true, plan_state: 'waiting_user' }), '·计划待批')
  assert.equal(planListMarker({ id: 't-1', plan_first: true, plan_state: 'revising' }), '·计划修订')
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'waiting_user' }), /待拍板/)
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'revising' }), /修订中/)
  assert.equal(planListMarker({ id: 't-1', plan_first: true, plan_state: 'approved' }), '')
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'approved' }), /已批准/)
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'rejected' }), /未批准/)
  // 非计划任务不加任何字样。
  assert.equal(planListMarker({ id: 't-1', plan_first: false, plan_state: 'none' }), '')
  assert.equal(planStatusLine({ id: 't-1', plan_first: false, plan_state: 'none' }), undefined)
})

test('P0-4 planApproveGate：四条前置（计划任务 / 已交回 blocked / 停在等你确认 / 计划已落盘）', () => {
  const base = { id: 't-1', plan_first: true, status: 'waiting_user', plan_state: 'waiting_user', plan_path: 'C:/ws/reports/plans/x.md' }
  assert.deepEqual(planApproveGate({ ...base, plan_first: false, plan_state: 'none' }), { ok: false, code: 'PLAN_APPROVE_NOT_PLAN' })
  assert.equal(planApproveGate({ ...base, plan_state: 'planning' }).code, 'PLAN_APPROVE_NO_BLOCKED')
  assert.equal(planApproveGate({ ...base, plan_state: 'revising' }).code, 'PLAN_APPROVE_NOT_WAITING')
  assert.equal(planApproveGate({ ...base, status: 'running' }).code, 'PLAN_APPROVE_NOT_WAITING')
  assert.equal(planApproveGate({ ...base, plan_path: null }).code, 'PLAN_APPROVE_NO_PLAN_PATH')
  assert.deepEqual(planApproveGate(base), { ok: true, planState: 'waiting_user' })
  assert.deepEqual(planApproveGate({ ...base, plan_state: 'approved' }), { ok: true, already: true, planState: 'approved' })
})

test('P0-2 dispatchReadOnly：只读任务 + 未批准计划任务一律按只读投递', () => {
  assert.equal(dispatchReadOnly({ read_only: true }), true)
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: true, plan_state: 'planning' }), true)
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: true, plan_state: 'waiting_user' }), true)
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: true, plan_state: 'revising' }), true)
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: true, plan_state: 'none' }), true)
  // 已批准的计划任务要按可写投递（授予在 post-send 的 grantApprovedWrite）。
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: true, plan_state: 'approved' }), false)
  assert.equal(dispatchReadOnly({ read_only: false, plan_first: false, plan_state: 'none' }), false)
})

test('P8 exit_plan_mode 拒绝文案指向 task_report blocked（不是 exit_plan_mode）', () => {
  assert.match(EXIT_PLAN_MODE_DENIAL, /task_report/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /blocked/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /exit_plan_mode 在编排子任务里不可用/)
  // 计划阶段说明必须写明「写被拒是预期」、唯一写入口是 plan_save、不动 exit_plan_mode。
  assert.match(PLAN_FIRST_DETAIL, /这是预期行为/)
  assert.match(PLAN_FIRST_DETAIL, /task_report 报 blocked/)
  assert.match(PLAN_FIRST_DETAIL, /不要调用 exit_plan_mode/)
  // 计划交付流程：先落盘（plan_save → reports/plans/<taskId>.md），再只报 3–8 行摘要 + 绝对路径 + 待拍板清单。
  assert.match(PLAN_FIRST_DETAIL, /plan_save/)
  assert.match(PLAN_FIRST_DETAIL, /docs\/<任务名>-<版本>\.md/)
  assert.match(PLAN_FIRST_DETAIL, /3–8 行摘要/)
  assert.match(PLAN_FIRST_DETAIL, /待拍板问题清单/)
  assert.match(PLAN_FIRST_DETAIL, /计划用 plan_save、阶段报告用 artifact_save/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /plan_save/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /docs\/<任务名>-<版本>\.md/)
})

// —— 二、台账：两列 + 旧库补列 + 终态收口 ——

test('P8 台账：默认 false/none；planFirst 落库 planning', async () => {
  const db = await openLedger(tempDir())
  const normal = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  assert.equal(normal.plan_first, false)
  assert.equal(normal.plan_state, 'none')
  const plan = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1', planFirst: true })
  assert.equal(plan.plan_first, true)
  assert.equal(plan.plan_state, 'planning')
  assert.equal(getTask(db, plan.id).plan_first, true)
  // setPlanState 只改视图，不动 status。
  const approved = setPlanState(db, plan.id, 'approved')
  assert.equal(approved.plan_state, 'approved')
  assert.equal(approved.status, 'pending')
  db.close()
})

test('P8 台账：旧库自动补 plan_first/plan_state，旧行读成 false/none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plan-legacy-'))
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'done', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('plan_first'))
  assert.ok(cols.includes('plan_state'))
  const row = getTask(db, 't-old')
  assert.equal(row.plan_first, false)
  assert.equal(row.plan_state, 'none')
  db.close()
})

test('P0-4 台账：旧库补 accepted_kind，旧行读成 null；planning+waiting_user 的旧行回填 planning→waiting_user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plan-backfill-'))
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER,
    plan_first INTEGER NOT NULL DEFAULT 0, plan_state TEXT, plan_path TEXT)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at, plan_first, plan_state, plan_path)
    VALUES ('t-old-plan', '旧计划', 'g', '{}', 'waiting_user', 's-1', 1, 1, 1, 1, 'planning', 'C:/ws/reports/plans/old.md')`).run()
  legacy.close()
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('accepted_kind'))
  const row = getTask(db, 't-old-plan')
  assert.equal(row.plan_state, 'waiting_user')
  assert.equal(row.accepted_kind, null)
  db.close()
  // 幂等：再开一次还是 waiting_user（回填条件不再命中），旧行可批准。
  const again = await openLedger(dir)
  assert.equal(getTask(again, 't-old-plan').plan_state, 'waiting_user')
  again.close()
})

test('P8 台账：计划任务在「等批准」时进终态按 rejected 收口；已批准保持 approved', async () => {
  const db = await openLedger(tempDir())
  const stopped = planTaskRow(db, { status: 'waiting_user' })
  transition(db, stopped.id, 'cancelled')
  assert.equal(getTask(db, stopped.id).plan_state, 'rejected')

  // P0-4：四态里没批准的两个新态同样收口成 rejected。
  const waiting = planTaskRow(db)
  setPlanState(db, waiting.id, 'waiting_user')
  transition(db, waiting.id, 'delivered')
  assert.equal(getTask(db, waiting.id).plan_state, 'rejected')

  const revising = planTaskRow(db)
  setPlanState(db, revising.id, 'revising')
  transition(db, revising.id, 'cancelled')
  assert.equal(getTask(db, revising.id).plan_state, 'rejected')

  const approved = planTaskRow(db)
  setPlanState(db, approved.id, 'approved')
  markDone(db, approved.id)
  assert.equal(getTask(db, approved.id).plan_state, 'approved')

  // 普通任务不受影响（即使 plan_state 被写成 planning 的脏数据，也不在终态改非计划任务之外的行为）。
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-9', target: 'c-9' })
  transition(db, plain.id, 'cancelled')
  assert.equal(getTask(db, plain.id).plan_state, 'none')
  db.close()
})

// —— 三、工具层：planFirst 契约 + 批准链路 ——

function fakeDispatcher({ failSend = false, retryState = 'switching' } = {}) {
  const calls = []
  let counter = 0
  return {
    calls,
    async spawn(input) {
      calls.push(['spawn', input])
      counter += 1
      return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` }
    },
    // 第 9 参 options（planApproved/attemptKey/messageId）要透传：B 语义下「批准后的写入意图」只靠它。
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective, access, options) {
      calls.push(['sendReliable', target, message, readOnly, options])
      if (failSend) throw new Error('投递超时')
      return { messageId: 'm-1' }
    },
    // 已 approved 的重批 = retry grant（v5 X6/v6 §1.2）：只重试授予，不投递、不重写审计。
    retryPlanGrant(target, options) {
      calls.push(['retryPlanGrant', target, options?.taskId, options?.messageId])
      return { state: retryState }
    },
    planWriteInfo() { return { state: retryState } },
    async stop(target) { calls.push(['stop', target]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
    slug(title) { counter += 1; return `task-${counter}` },
  }
}

async function setupTools(options = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher(options)
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', ...(options.config ?? {}) }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    defaultCwd: tempDir(),
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, queue, notifier, tools }
}

const mainCall = (tools, name, args, exec) => tools[name].execute(args, { agent: { id: 's-1' }, ...(exec ?? {}) })

test('P8 task_create：planFirst 落库 + 派发透传 + 工具结果带批准指引', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const text = await mainCall(tools, 'task_create', sampleBrief({ title: '计划A', goal: '目标A', planFirst: true }), {})
  assert.match(text, /已派发/)
  assert.match(text, /计划模式/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.plan_first, true)
  assert.equal(task.plan_state, 'planning')
  const spawn = dispatcher.calls.find(item => item[0] === 'spawn')
  assert.equal(spawn[1].planFirst, true)
  assert.equal(spawn[1].readOnly, false)
  // prompt 仍是纯指引（计划说明在 task_detail 里，不内联进提示词）。
  assert.equal(spawn[1].prompt.includes('计划阶段'), false)

  const detail = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /计划状态：计划中（仓库只读探索）/)
  assert.match(detail, /【计划阶段】/)
  // 2026-11-25 起计划阶段不是纯只读：仓库不可写 + 临时目录可写（沙箱 workspace-write、target 未登记）。
  assert.match(detail, /权限：仓库只读（临时目录可写）/)
  assert.match(detail, /task_report 报 blocked/)
  db.close()
})

test('P8 task_create：字符串 "true" 不生效（只认显式布尔）', async () => {
  const { db, tools } = await setupTools()
  await mainCall(tools, 'task_create', sampleBrief({ title: '字符串', planFirst: 'true' }), {})
  const [task] = listTasks(db, { active: true })
  assert.equal(task.plan_first, false)
  assert.equal(task.plan_state, 'none')
  db.close()
})

test('P8 task_create：planFirst 与 readOnly 互斥，创建期拒绝且不建任务', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const text = await mainCall(tools, 'task_create', sampleBrief({ title: '冲突', planFirst: true, readOnly: true }), {})
  assert.match(text, /互斥/)
  assert.match(text, /二选一/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('P8 task_list/task_status：计划中标记只给等待批准的任务', async () => {
  const { db, tools } = await setupTools()
  planTaskRow(db, { status: 'waiting_user' })
  const approved = planTaskRow(db)
  setPlanState(db, approved.id, 'approved')
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-8', target: 'c-8' })

  const list = await mainCall(tools, 'task_list', {})
  assert.match(list, /计划中/)
  const status = await mainCall(tools, 'task_status', { task_id: planTaskRow(db, { status: 'waiting_user' }).id })
  assert.match(status, /计划：计划中/)
  assert.match(status, /task_message/)
  const approvedStatus = await mainCall(tools, 'task_status', { task_id: approved.id })
  assert.match(approvedStatus, /计划：已批准/)
  const plainStatus = await mainCall(tools, 'task_status', { task_id: plain.id })
  assert.equal(plainStatus.includes('计划：'), false)
  assert.equal(plainStatus.includes('计划中'), false)
  db.close()
})

// —— P0-4：普通 message 只记讨论/修订，批准只走显式 action:'approve' ——

test('P0-4 task_message：planning 上的普通 message 只记讨论（不改 plan_state、不切沙箱）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'running' })
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '补充一点方向' })
  assert.match(text, /只记讨论、不会批准计划/)
  assert.match(text, /action: "approve"/)
  const after = getTask(db, task.id)
  assert.equal(after.plan_state, 'planning')
  assert.equal(after.status, 'running')
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  db.close()
})

test('P0-4 task_message：waiting_user 上的普通 message 转 revising（仍只读、不批准）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'waiting_user', planPath: 'C:/ws/reports/plans/x.md' })
  setPlanState(db, task.id, 'waiting_user')
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '把测试再细化一点' })
  assert.match(text, /按「修订」转回子会话/)
  assert.match(text, /action: "approve"/)
  const after = getTask(db, task.id)
  assert.equal(after.plan_state, 'revising')
  assert.equal(after.status, 'running')
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  db.close()
})

test('P0-4 task_report blocked：计划任务交回计划 → plan_state=waiting_user（blocked 证据）', async () => {
  const { db, tools } = await setupTools()
  const task = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？' },
    { agent: { id: task.session_id } },
  )
  const blocked = getTask(db, task.id)
  assert.equal(blocked.status, 'waiting_user')
  assert.equal(blocked.plan_state, 'waiting_user')
  // 修订版再交回：revising → waiting_user（证据刷新，仍无新列）。
  setPlanState(db, task.id, 'revising')
  transition(db, task.id, 'running', { error: null })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '修订版已就绪', question: '批准？' },
    { agent: { id: task.session_id } },
  )
  assert.equal(getTask(db, task.id).plan_state, 'waiting_user')
  db.close()
})

test('P0-4 approve：首批准 = 纯记账（plan_state=approved + accepted_kind=plan，不投递、不调 dispatcher）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？' },
    { agent: { id: task.session_id } },
  )
  const text = await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  assert.match(text, /计划已批准/)
  assert.match(text, /续派实现/)
  const approved = getTask(db, task.id)
  assert.equal(approved.plan_state, 'approved')
  // 批准 ≠ 投递：状态仍停在等你确认，等协调者下一步 task_message。
  assert.equal(approved.status, 'waiting_user')
  assert.equal(approved.accepted_kind, 'plan')
  assert.equal(approved.accepted_by, 'coordinator')
  assert.equal(approved.question, null)
  assert.ok(Number.isFinite(approved.accepted_at))
  // v6：首批准不调任何 dispatcher 运行期方法（授予在续派投递的 post-send）。
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  assert.equal(dispatcher.calls.some(item => item[0] === 'sendReliable'), false)
  db.close()
})

test('P0-4 approve：前置不满足给可读拒绝（不切沙箱、不写审计）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-9', target: 'c-9' })
  const notPlan = await mainCall(tools, 'task_message', { action: 'approve', task_id: plain.id })
  assert.match(notPlan, /不是计划任务/)

  const noBlocked = planTaskRow(db, { status: 'running' })
  const planning = await mainCall(tools, 'task_message', { action: 'approve', task_id: noBlocked.id })
  assert.match(planning, /还没交回计划/)

  const noPlanPath = planTaskRow(db, { status: 'waiting_user' })
  setPlanState(db, noPlanPath.id, 'waiting_user')
  const noPath = await mainCall(tools, 'task_message', { action: 'approve', task_id: noPlanPath.id })
  assert.match(noPath, /还没有落盘的计划文档/)

  // plan_state=waiting_user 但子会话还在跑：不能批（避开跑着的时候被批）。
  const running = planTaskRow(db, { status: 'running', planPath: 'C:/ws/reports/plans/x.md' })
  setPlanState(db, running.id, 'waiting_user')
  const busy = await mainCall(tools, 'task_message', { action: 'approve', task_id: running.id })
  assert.match(busy, /子会话还在跑/)

  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  for (const id of [noBlocked.id, noPlanPath.id, running.id]) {
    assert.equal(getTask(db, id).plan_state === 'approved', false)
    assert.equal(getTask(db, id).accepted_kind, null)
  }
  db.close()
})

test('P0-4 approve：已批准走幂等（首批准 0 次 retry grant；重批 retryPlanGrant 1 次、审计只写首次）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准？' },
    { agent: { id: task.session_id } },
  )
  await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  const first = getTask(db, task.id)
  // 首批准 = 纯记账：一次 retry grant 都不该发生（授予在续派 post-send）。
  assert.equal(dispatcher.calls.filter(item => item[0] === 'retryPlanGrant').length, 0)
  const again = await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  assert.match(again, /无需重复批准/)
  const second = getTask(db, task.id)
  assert.equal(second.accepted_at, first.accepted_at)
  // v6/v7：already 不短路——重批只走一次 retry grant（不投递、不重写审计）。
  assert.equal(dispatcher.calls.filter(item => item[0] === 'retryPlanGrant').length, 1)
  assert.equal(dispatcher.calls.some(item => item[0] === 'sendReliable'), false)
  db.close()
})

test('P0-4 生命周期：blocked → approve → 续派仍复用原会话（不新建）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？' },
    { agent: { id: task.session_id } },
  )
  await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '就按这个计划执行' })
  assert.equal(text.includes('计划已批准'), false)
  const resumed = getTask(db, task.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.plan_state, 'approved')
  assert.equal(resumed.question, null)
  const send = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(send[1], task.target)
  // v6：第 9 参必须透传 planApproved（授权在 post-send）+ attemptKey（同一条 followup 的幂等键）。
  assert.equal(send[4].planApproved, true)
  assert.match(send[4].attemptKey, new RegExp(`^followup:${task.id}:\\d+$`))
  // 投递结果落 followup 行 meta.messageId（跨重启 retry grant / 重放的唯一凭据）。
  const delivered = recentMessages(db, task.id, 5).find(row => row.kind === 'followup')
  assert.equal(delivered.meta.messageId, 'm-1')
  assert.equal(delivered.meta.delivery, 'delivered')
  assert.equal(dispatcher.calls.some(item => item[0] === 'spawn'), false)
  db.close()
})

test('P0-4 approve（已批准）= retry grant：带上 followup 的 messageId，不投递', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？' },
    { agent: { id: task.session_id } },
  )
  await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  await mainCall(tools, 'task_message', { task_id: task.id, message: '开始执行' })
  const sends = dispatcher.calls.filter(item => item[0] === 'sendReliable').length
  const again = await mainCall(tools, 'task_message', { action: 'approve', task_id: task.id })
  assert.match(again, /无需重复批准/)
  const regrant = dispatcher.calls.filter(item => item[0] === 'retryPlanGrant')
  assert.equal(regrant.length, 1)
  assert.equal(regrant[0][3], 'm-1', 'retry grant 要带 followup 行的 messageId（幂等重放凭据）')
  assert.equal(dispatcher.calls.filter(item => item[0] === 'sendReliable').length, sends, '重批绝不二次投递')
  db.close()
})

test('P8 task_message：投递失败不改计划状态（仍在等你确认）', async () => {
  const { db, dispatcher, tools } = await setupTools({ failSend: true })
  const task = planTaskRow(db, { status: 'waiting_user' })
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '批准执行' })
  assert.match(text, /投递/)
  assert.equal(getTask(db, task.id).plan_state, 'planning')
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  db.close()
})

test('P8 task_message：running 中的计划任务收到普通消息不算批准', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'running' })
  await mainCall(tools, 'task_message', { task_id: task.id, message: '再补充一点' })
  assert.equal(getTask(db, task.id).plan_state, 'planning')
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  db.close()
})

test('P8 task_stop：停止计划任务 → rejected，并释放子会话', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'waiting_user' })
  const text = await mainCall(tools, 'task_message', { action: 'stop', task_id: task.id })
  assert.match(text, /已停止/)
  const stopped = getTask(db, task.id)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.plan_state, 'rejected')
  assert.ok(dispatcher.calls.some(item => item[0] === 'stop'))
  db.close()
})

test('P8 task_retry：计划任务重派后重新进入计划阶段', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'running' })
  transition(db, task.id, 'failed', { error: '炸了' })
  const text = await mainCall(tools, 'task_message', { action: 'retry', task_id: task.id })
  assert.match(text, /已重派/)
  const retried = listTasks(db, { active: true }).find(item => item.retry_of === task.id)
  assert.equal(retried.plan_first, true)
  assert.equal(retried.plan_state, 'planning')
  const spawn = dispatcher.calls.filter(item => item[0] === 'spawn').at(-1)
  assert.equal(spawn[1].planFirst, true)
  db.close()
})

test('P8 task_detail 纯渲染：批准前仓库只读（可写临时目录）、批准后可写', () => {
  const base = {
    id: 't-1', title: '计划', goal: 'g', status: 'running', plan_first: true, plan_state: 'planning',
    brief: { title: '计划', goal: 'g', acceptance: ['a'], target: 'C:/work' },
  }
  const planning = renderTaskDetail(base)
  assert.match(planning, /权限：仓库只读（临时目录可写）/)
  assert.match(planning, /计划状态：计划中（仓库只读探索）/)
  assert.match(planning, /【计划阶段】/)
  // 等拍板 / 修订中同样是「仓库只读 + 临时目录可写」（运行期事实优先于 access:'full'）。
  for (const [state, label] of [['waiting_user', '计划待拍板（已提交计划）'], ['revising', '修订中（子会话只读改计划）']]) {
    const detail = renderTaskDetail({ ...base, plan_state: state, access: 'full', brief: { ...base.brief, access: 'full' } })
    assert.match(detail, /权限：仓库只读（临时目录可写）/, `${state} 应是仓库只读 + 临时可写`)
    assert.match(detail, new RegExp(`计划状态：${label}`), `${state} 状态行`)
  }
  const approved = renderTaskDetail({ ...base, plan_state: 'approved' })
  assert.match(approved, /权限：可写/)
  assert.match(approved, /计划状态：已批准执行/)
  // 非计划任务的详情不出现计划字样。
  const plain = renderTaskDetail({ ...base, plan_first: false, plan_state: 'none' })
  assert.equal(plain.includes('计划阶段'), false)
  assert.equal(plain.includes('计划状态'), false)
})

// —— 四、派发层：进入（只读 + plan mode + guard）、退出（切可写 + plan off + 释放 guard）——

const coordinator = { id: 's-1', session: { id: 's-1', header: { cwd: 'C:/parent' } } }

function planEnv({ service = true, hookOnStart = false, ctxStyle = 'plain', presetService = false } = {}) {
  const sandboxEvents = []
  const modes = new Map()
  const planEvents = []
  const warnings = []
  const guards = []
  const guardRecords = []
  const registrations = []
  const agentsById = new Map()
  const sessionsById = new Map()
  const hooks = []
  const planMode = service
    ? {
      set(agent, active) { planEvents.push([agent.id, active]); return 'committed' },
      get() { return { active: false } },
    }
    : undefined
  // 宿主 cordis 的 ctx 是 Proxy：读「fiber 链上拿不到、又没声明 inject」的服务属性会直接抛
  // `cannot get property "x" without inject`（cordis src/reflect.ts 的 get trap）。
  // 真机 planFirst 创建失败就是踩到这条；测试替身必须能复现同样的语义，否则会漏掉回归。
  const cordisLikeCtx = services => new Proxy({ get: name => services[name], ...services }, {
    get(target, prop) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      const error = new Error(`cannot get property "${String(prop)}" without inject`)
      throw error
    },
  })
  const registerAgent = id => {
    const toolService = {
      guard(fn) {
        guards.push(fn)
        const record = { fn, disposed: false }
        guardRecords.push(record)
        return () => { record.disposed = true }
      },
    }
    const services = { tools: toolService }
    if (planMode !== undefined) services.planMode = planMode
    if (presetService) {
      // 宿主公开 API：读 agent 预设 isolate 组里的服务（plan-mode 实际装在 preset 的隔离域）。
      services.agentPresets = {
        serviceFor(agent, name) { return name === 'planMode' ? planMode : undefined },
      }
    }
    const ctx = ctxStyle === 'cordis'
      ? cordisLikeCtx(services)
      : { get: name => (name === 'planMode' ? services.planMode : undefined), planMode: services.planMode, tools: toolService }
    const agent = {
      id,
      session: sessionsById.get(id),
      ctx,
    }
    agentsById.set(id, agent)
    return agent
  }
  const subagents = {
    async startActivation(spec) {
      const session = {
        id: spec.childId,
        header: { cwd: 'C:\\work' },
        append(event, payload) {
          sandboxEvents.push({ id: spec.childId, event, payload })
          if (event === 'sandbox/mode') modes.set(spec.childId, payload.mode)
        },
      }
      sessionsById.set(spec.childId, session)
      const agent = registerAgent(spec.childId)
      if (hookOnStart) {
        await tick()
        for (const hook of hooks) hook(agent)
      }
      return { childId: spec.childId, messageId: 'm1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() { return 'm' },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const sandboxPolicy = {
    overrideOf: session => modes.get(session.id),
    registerWritableRoot(session, dir) {
      registrations.push([session.id, dir])
      return () => {}
    },
  }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent: coordinator,
    agents: () => ({ get: id => agentsById.get(id) }),
    sessions: () => ({ get: id => sessionsById.get(id) }),
    sandboxPolicy: () => sandboxPolicy,
    onAgentCreated: handler => { hooks.push(handler) },
    onWarn: message => { warnings.push(message) },
    onEvent: () => {},
    sessionWaitMs: 0,
  })
  return {
    dispatcher, sandboxEvents, modes, planEvents, warnings, guards, guardRecords, registrations,
    agentsById, sessionsById, hooks,
  }
}

const sandboxModeEvents = env => env.sandboxEvents.filter(item => item.event === 'sandbox/mode')

test('P8 派发：计划任务设 workspace-write 沙箱（不注册可写根）+ planMode.set(true) + agent 作用域 exit guard', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  assert.equal(sandboxModeEvents(env).length, 1)
  // 2026-11-25：模式是 workspace-write（让 $TMPDIR/scratch 可写），仓库不可写由「不注册可写根」承担。
  assert.deepEqual(sandboxModeEvents(env)[0].payload, { mode: 'workspace-write', source: 'delegation' })
  assert.deepEqual(env.planEvents, [[member.id, true]])
  assert.equal(env.guards.length, 1)
  const childAgent = env.agentsById.get(member.id)
  assert.equal(env.guards[0]({ name: 'exit_plan_mode', agent: childAgent }), EXIT_PLAN_MODE_DENIAL)
  // 别的会话（协调者）与别的工具都不受影响。
  assert.equal(env.guards[0]({ name: 'exit_plan_mode', agent: { id: 's-1' } }), undefined)
  assert.equal(env.guards[0]({ name: 'task_list', agent: childAgent }), undefined)
  // 计划阶段不注册 target 可写根（批准只记账；首次授予在续派 send 的 post-send）。
  assert.deepEqual(env.registrations, [])
})

test('P8 派发：agent/created 先生效（首回合窗口），激活后不重复设置', async () => {
  const env = planEnv({ hookOnStart: true })
  await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  await tick()
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.equal(env.planEvents.length, 1)
  assert.equal(env.planEvents[0][1], true)
  assert.equal(env.guards.length, 1)
})

test('P8 派发：普通任务不碰 plan mode / guard，沙箱钉 workspace-write（可写根照旧）', async () => {
  const env = planEnv({ hookOnStart: true })
  await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.deepEqual(env.planEvents, [])
  assert.deepEqual(env.guards, [])
  // C：父会话被钉只读后宿主会把覆盖种进子会话，普通任务必须显式钉回可写。
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload), [{ mode: 'workspace-write', source: 'delegation' }])
  assert.equal(env.registrations.length, 1)
})

test('P8 派发：planMode 服务缺失只 warn 降级，只读沙箱仍生效', async () => {
  const env = planEnv({ service: false })
  const member = await env.dispatcher.spawn({ prompt: 'p', planFirst: true })
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.match(env.warnings.join('\n'), /planMode 服务不可用/)
  assert.equal(env.planEvents.length, 0)
  // agent 作用域 guard 仍装上（不依赖 planMode 服务）。
  assert.equal(env.guards.length, 1)
  assert.ok(member.id)
})

// 回归（真机 t-e36f85f3）：planFirst 创建时报 `cannot get property "planMode" without inject`。
// 原因是宿主 cordis 代理在服务不可见时读属性会抛，插件把「读不到 = 降级」写成了裸属性访问。
test('P8 派发：cordis 代理读 ctx.planMode 会抛 —— 服务不可见时必须降级而不是让创建失败', async () => {
  const env = planEnv({ service: false, ctxStyle: 'cordis' })
  const member = await env.dispatcher.spawn({ prompt: 'p', planFirst: true })
  assert.ok(member.id)
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.deepEqual(sandboxModeEvents(env)[0].payload, { mode: 'workspace-write', source: 'delegation' })
  assert.equal(env.planEvents.length, 0)
  assert.match(env.warnings.join('\n'), /planMode 服务不可用/)
  // exit guard 仍装上（读 ctx.tools 是已有服务，不触发代理抛错）。
  assert.equal(env.guards.length, 1)
})

test('P8 派发：planMode 装在预设隔离域时走 agentPresets.serviceFor，不碰会抛的属性读', async () => {
  const env = planEnv({ ctxStyle: 'cordis', presetService: true })
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  assert.deepEqual(env.planEvents, [[member.id, true]])
  assert.equal(env.warnings.length, 0)
})

test('P8 生命周期：只读任务 blocked 续派 → 回 running 但明说仍是只读（不伪装可写）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = createTask(db, { brief: sampleBrief({ title: '只读核查' }), coordinatorSession: 's-1', readOnly: true })
  transition(db, task.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  transition(db, task.id, 'waiting_user')
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '按这个计划做' })
  // 真机 t-2aa984e5：协调者以为「续派 = 可以继续落地」，实际仍是只读，最后新开任务/新会话。
  assert.match(text, /只读任务/)
  assert.match(text, /仍是 read-only 沙箱/)
  assert.match(text, /新派一个可写任务/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  const send = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(send[1], 'c-2')
  assert.equal(send[3], true)
  db.close()
})

test('P0-2 审计：计划未批准的续派按只读投递（planning/revising 都不许提前拿可写）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const planning = planTaskRow(db, { status: 'running' })
  await mainCall(tools, 'task_message', { task_id: planning.id, message: '继续探索' })
  const planningSend = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(planningSend[3], true, 'planning 态续派必须按只读投递（否则 dispatch 会注册可写根）')

  const revising = planTaskRow(db, { status: 'waiting_user' })
  setPlanState(db, revising.id, 'revising')
  await mainCall(tools, 'task_message', { task_id: revising.id, message: '按意见改一版' })
  const revisingSend = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(revisingSend[3], true, 'revising 态续派同样按只读投递')

  // 批准之后才是可写投递（授予在 post-send 的 grantApprovedWrite）。
  const approved = planTaskRow(db, { planPath: 'C:/ws/reports/plans/x.md' })
  await tools.task_report.execute(
    { task_id: approved.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？' },
    { agent: { id: approved.session_id } },
  )
  await mainCall(tools, 'task_message', { action: 'approve', task_id: approved.id })
  await mainCall(tools, 'task_message', { task_id: approved.id, message: '按这个计划执行' })
  const approvedSend = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(approvedSend[3], false, '已批准 → 可写投递')
  assert.equal(approvedSend[4].planApproved, true)
  db.close()
})

test('P1-4 审计：借条行写失败时不泄漏 hold（acquire 必须在 addMessage 之后）', async () => {
  const db = await openLedger(tempDir())
  const task = planTaskRow(db, { status: 'running' })
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  // 台账写消息抛错（真实故障面）：hold 若在 addMessage 之前 acquire，就会带着 30s 心跳泄漏下去。
  const failingDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return sql => {
          if (/INSERT INTO messages/i.test(sql)) throw new Error('insert boom')
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const tools = Object.fromEntries(createTools({
    defaultCwd: tempDir(),
    db: failingDb, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  __resetHolds()
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(text, /任务协调失败/)
  assert.equal(isWriteHeld(task.id), false, 'addMessage 抛错后不许还占着写域')
  assert.equal(writeHoldCount(), 0)
  __resetHolds()
  db.close()
})

test('P8 批准：planMode 服务缺失时 post-send 仍把沙箱切回可写（阻塞→批准→续派→原会话继续）', async () => {
  const env = planEnv({ service: false, ctxStyle: 'cordis' })
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  // v7 §2：批准后的沙箱切换由 send({planApproved}) 负责（先关 plan mode，再 post-send 授予）。
  await env.dispatcher.send(member.id, '执行', undefined, 'C:/target', 't-1', false, undefined, undefined, { planApproved: true })
  // 计划阶段派发时已是 workspace-write，批准只需**注册可写根**（不再 append 第二条模式事件）。
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload.mode), ['workspace-write'])
  assert.deepEqual(env.registrations, [[member.id, 'C:/target']])
  // 服务缺失不产生 plan off 调用，但投递/授予本身不能失败。
  assert.deepEqual(env.planEvents, [])
  assert.equal(env.guardRecords[0].disposed, true)
  assert.equal(env.dispatcher.planWriteInfo(member.id).state, 'granted')
})

test('P8 批准后恢复执行：send({planApproved}) → 注册 target 可写根、plan off、释放 guard', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  const sent = await env.dispatcher.send(member.id, '执行', undefined, 'C:/target', 't-1', false, undefined, undefined, { planApproved: true })
  assert.equal(sent, 'm')
  const modes = sandboxModeEvents(env).map(item => item.payload.mode)
  // 模式在计划阶段就已是 workspace-write；批准带来的变化是**注册可写根**（下一行断言）。
  assert.deepEqual(modes, ['workspace-write'])
  // planEvents=[true,false] 由 send 的 `applyPlanMode(target,false)` 产生（v7 §2 写死）。
  assert.deepEqual(env.planEvents, [[member.id, true], [member.id, false]])
  assert.equal(env.guardRecords[0].disposed, true)
  assert.deepEqual(env.registrations, [[member.id, 'C:/target']])
  assert.equal(env.dispatcher.planWriteInfo(member.id).state, 'granted')
})

test('P0-2 派发：未批准计划任务按「不注册」续派 → 不 append 可写、registrations 仍为空', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  assert.deepEqual(env.registrations, [], '派发阶段就不注册（批准前）')
  await env.dispatcher.send(member.id, '继续探索', undefined, 'C:/target', 't-1', true, undefined, undefined, { planPhase: 'workspace-write' })
  assert.deepEqual(env.registrations, [], '批准前续派同样不得注册可写根')
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload.mode), ['workspace-write'], '沙箱是 workspace-write（scratch 可写），但没注册任何可写根')
  assert.equal(env.dispatcher.planWriteInfo(member.id).state, 'unknown', '未批准任务不该有写入意图行')
})

// —— 六、模式与授权解耦（2026-11-25）：模式（能不能写 $TMPDIR）与授权（能不能写 target）是两件事 ——

test('P8 解耦：planFirst 与 readOnly 的沙箱模式已分叉（计划阶段 workspace-write、只读任务 read-only），两者都不注册', async () => {
  const env = planEnv()
  const planMember = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  const readOnlyMember = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', readOnly: true })
  const events = sandboxModeEvents(env)
  assert.equal(events.length, 2, '两个子会话各一条模式事件')
  const byId = new Map(events.map(item => [item.id, item.payload]))
  assert.deepEqual(byId.get(planMember.id), { mode: 'workspace-write', source: 'delegation' }, '计划阶段要 workspace-write 才能写 $TMPDIR')
  assert.deepEqual(byId.get(readOnlyMember.id), { mode: 'read-only' }, '只读任务连临时文件都写不了')
  assert.deepEqual(env.registrations, [], '两条路径都不注册 target 可写根')
})

test('P8 解耦：未批准续派带 planPhase 只补模式、不注册，且重复续派不重复 append（幂等）', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  const before = sandboxModeEvents(env).length
  for (let index = 0; index < 2; index += 1) {
    await env.dispatcher.send(member.id, '继续探索', undefined, 'C:/target', 't-1', true, undefined, undefined, { planPhase: 'workspace-write' })
  }
  assert.equal(sandboxModeEvents(env).length, before, '已是 workspace-write 就不再 append')
  assert.deepEqual(env.registrations, [], '未批准 → 一次都不许注册可写根')
})

test('P8 解耦：批准前后对比 —— 批准前 registrations 为空，批准后才注册 target', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  await env.dispatcher.send(member.id, '继续探索', undefined, 'C:/target', 't-1', true, undefined, undefined, { planPhase: 'workspace-write' })
  assert.deepEqual(env.registrations, [], '批准前：仓库物理不可写')
  await env.dispatcher.send(member.id, '执行', undefined, 'C:/target', 't-1', false, undefined, undefined, { planApproved: true })
  assert.deepEqual(env.registrations, [[member.id, 'C:/target']], '批准后才把 target 登记成可写根')
})

test('P8 解耦：漏传 planPhase 的降级方向 —— 回落到 read-only，绝不变成仓库可写', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  // 调用方忘了带 planPhase（新字段）：模式退回只读，但注册条件同样不成立 → 仓库仍不可写。
  await env.dispatcher.send(member.id, '继续探索', undefined, 'C:/target', 't-1', true)
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload.mode), ['workspace-write', 'read-only'], '漏传字段 ⇒ 退回只读（安全方向）')
  assert.deepEqual(env.registrations, [], '任何情况下批准前都不注册')
})

test('P8 批准失败：拿不到子会话时 retry grant 停在 switching（不静默假装切好了、不抛错）', async () => {
  const env = planEnv()
  const info = env.dispatcher.retryPlanGrant('missing-session', { taskId: 't-1', targetDir: 'C:/target' })
  assert.equal(info.state, 'switching')
  assert.equal(info.reason, 'retry-no-session')
})

// 宿主事实（H1）：agent/created 是 cordis serial，逐条 await、不吞错——任一监听器 throw 都会 reject announce，
// 投递根本不发生。我们的监听器因此必须：整段 try/catch、返回恒 undefined、不 append read-only、不删 planWrite。
test('hook 约束：approved 提前授予时 append 抛错也不外抛、返回 undefined、不 append read-only', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  // 先登记 approved 写入意图（retry grant 用真实 session 成功一次），再让 hook 拿到会抛的 session。
  env.dispatcher.retryPlanGrant(member.id, { taskId: 't-1', targetDir: 'C:/target' })
  assert.equal(env.dispatcher.planWriteInfo(member.id).state, 'granted')
  const before = sandboxModeEvents(env).map(item => item.payload.mode)
  // 让 hook 走「append workspace-write」分支并失败：清掉该会话的投影模式，append 抛错。
  env.modes.delete(member.id)
  const throwing = {
    id: member.id,
    header: { cwd: 'C:\\work' },
    append() { throw new Error('append boom') },
  }
  for (const hook of env.hooks) {
    assert.equal(hook({ id: member.id, session: throwing }), undefined, '监听器绝不能返回非 undefined（返回即 bail）')
  }
  // 授予失败只把状态降级为 switching，不删 planWrite、不追加 read-only。
  assert.equal(env.dispatcher.planWriteInfo(member.id).state, 'switching')
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload.mode), before, 'hook 内绝不 append read-only')
})

// —— 五、面板与快照：字段下发 + 面板追加消息同样批准 ——

test('P8 snapshot/detail：下发 planFirst/planState，非计划任务固定 false/none', async () => {
  const db = await openLedger(tempDir())
  const plan = planTaskRow(db, { status: 'waiting_user' })
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-8', target: 'c-8' })
  const panel = createPanelActions({ db, dispatcher: fakeDispatcher(), queue: createQueue({ db, dispatcher: fakeDispatcher(), config: {} }), config: {}, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }), panel })
  const response = await handler(new Request('http://localhost/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'snapshot' }),
  }))
  const body = await response.json()
  const planRow = body.tasks.find(item => item.id === plan.id)
  const plainRow = body.tasks.find(item => item.id === plain.id)
  assert.equal(planRow.planFirst, true)
  assert.equal(planRow.planState, 'planning')
  assert.equal(plainRow.planFirst, false)
  assert.equal(plainRow.planState, 'none')
  const detail = panel.detail(plan.id)
  assert.equal(detail.task.planFirst, true)
  assert.equal(detail.task.planState, 'planning')
  db.close()
})

test('P0-4 面板「追加」：不批准计划、不改 plan_state（面板无批准入口）', async () => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const queue = createQueue({ db, dispatcher, config: {} })
  const panel = createPanelActions({ db, dispatcher, queue, config: {}, defaultCwd: tempDir(), coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const task = planTaskRow(db, { status: 'waiting_user', planPath: 'C:/ws/reports/plans/x.md' })
  setPlanState(db, task.id, 'waiting_user')
  const result = await panel.message(task.id, '把验收再细化一点')
  assert.equal(result.ok, true)
  assert.equal(result.plan.approved, false)
  assert.equal(result.plan.revising, true)
  assert.match(result.plan.note, /action: "approve"/)
  // 用户决策 1：面板 message 不改 plan_state、不切沙箱。
  assert.equal(getTask(db, task.id).plan_state, 'waiting_user')
  assert.equal(getTask(db, task.id).accepted_kind, null)
  assert.equal(dispatcher.calls.some(item => item[0] === 'retryPlanGrant'), false)
  db.close()
})

// —— 六、客户端：计划小标/计划状态确实进了源码（dist 由后续 build 任务重建） ——

test('P0-4 客户端源码：六值文案与未批准三态小标（dist 待 build 任务复核）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client/src/views.js', import.meta.url), 'utf8')
  const constants = readFileSync(new URL('../client/src/constants.js', import.meta.url), 'utf8')
  const workbench = readFileSync(new URL('../client/src/workbench.js', import.meta.url), 'utf8')
  // 六值文案在 constants.js（与服务端同值）；面板小标覆盖未批准三态。
  for (const label of ['计划中', '计划待拍板（已提交计划）', '修订中（子会话只读改计划）', '已批准执行']) {
    assert.equal(constants.includes(label), true, `constants 缺文案：${label}`)
  }
  for (const label of ['计划中', '计划待批', '修订中']) {
    assert.equal(source.includes(label), true, `views 缺小标：${label}`)
  }
  // 未批准三态都占视觉（不再只认 planning）；面板没有任何批准入口。
  assert.match(source, /PLAN_OPEN_STATES = \['planning', 'waiting_user', 'revising'\]/)
  assert.match(workbench, /\['planning', 'waiting_user', 'revising'\]\.includes\(task\.planState\)/)
  assert.equal(source.includes("endpoint === 'plan-approve'"), false)
})
