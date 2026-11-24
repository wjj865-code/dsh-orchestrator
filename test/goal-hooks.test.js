import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, setTaskGoalState, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createPanelActions } from '../src/panel-actions.js'
import { createHostRoute } from '../src/host-route.js'
import { objectiveForMessage } from '../src/goal.js'
import { tempDir, sampleBrief, endReportedTurn } from './helpers.js'

const request = body => new Request('http://localhost/api/orchestrator', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

function fakeDispatcher() {
  const calls = []
  return {
    calls,
    slug: title => `task-${title}`,
    async spawn(input) {
      calls.push(['spawn', input])
      return { id: 'c-new', name: 'w', sessionId: 'c-new', target: 'c-new' }
    },
    async send(target, message, signal, targetDir, taskId, readOnly, objective) {
      calls.push(['send', target, message, taskId, objective])
    },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective) {
      calls.push(['sendReliable', target, message, taskId, objective])
      return { messageId: 'm-1' }
    },
    async stop(target, taskId) { calls.push(['stop', target, taskId]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
  }
}

function fakeBridge() {
  const calls = []
  return {
    calls,
    available: () => true,
    async attach(...args) { calls.push(['attach', ...args]) },
    async update(...args) { calls.push(['update', ...args]) },
    async complete(...args) { calls.push(['complete', ...args]) },
    async clear(...args) { calls.push(['clear', ...args]) },
  }
}

function fakeQueue(db, dispatcher) {
  return {
    pump() {},
    remove() {},
    position: () => 1,
    pendingCount: () => 0,
    async enqueueAndPump(id) {
      const task = getTask(db, id)
      // 最小派发：把 task.goal 交给 spawn，和服务端 queue 的契约一致。
      const member = await dispatcher.spawn({
        name: task.title, label: task.title, prompt: task.goal, taskId: id,
        cwd: task.target_dir ?? undefined, readOnly: task.read_only === true, goal: task.goal,
      })
      transition(db, id, 'running', { sessionId: member.sessionId, target: member.target })
      return { task: getTask(db, id), position: 1 }
    },
  }
}

async function setup() {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const bridge = fakeBridge()
  const queue = fakeQueue(db, dispatcher)
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier: { push() {} }, config: { staleMinutes: 30, maxQueue: 50 },
    defaultCwd: tempDir(),
    coordinatorStatus: () => ({ id: 's-1', live: true }), goalBridge: bridge,
  }).map(tool => [tool.name, tool]))
  const panel = createPanelActions({
    db, dispatcher, queue, config: {}, coordinatorStatus: () => ({ id: 's-1', live: true }), goalBridge: bridge,
    defaultCwd: tempDir(),
  })
  return { db, dispatcher, bridge, queue, tools, panel }
}

const runningTask = (db, overrides = {}) => {
  const task = createTask(db, { brief: sampleBrief({ title: '目标任务', goal: '完成目标' }), coordinatorSession: 's-1', ...overrides })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  return getTask(db, task.id)
}

test('G1 工具挂钩：task_message 投递时把「原目标 + 最新指示」交给派发器 update', async () => {
  const { db, dispatcher, tools } = await setup()
  const task = runningTask(db)
  const text = await tools.task_message.execute({ task_id: task.id, message: '换方向' }, { agent: { id: 's-1' } })
  assert.match(text, /已把消息追加/)
  const sent = dispatcher.calls.find(call => call[0] === 'sendReliable')
  assert.equal(sent[1], 'c-1')
  assert.equal(sent[3], task.id)
  assert.equal(sent[4], objectiveForMessage('完成目标', '换方向'))
  db.close()
})

test('G1 工具挂钩：task_report done 只落待确认（不收口 goal），task_close 才 complete', async () => {
  const { db, bridge, tools } = await setup()
  const task = runningTask(db)
  await tools.task_report.execute({ task_id: task.id, status: 'done', summary: '完成了' }, { agent: { id: 'c-1' } })
  await endReportedTurn(db, { taskId: task.id })
  // 两段式终态：交付 ≠ 确认，goal 留到 done 再收口（追问还要 update 同一个 goal）。
  assert.deepEqual(bridge.calls, [])
  await tools.task_message.execute({ action: 'close', task_id: task.id }, { agent: { id: 's-1' } })
  assert.deepEqual(bridge.calls, [['complete', task.id, 'c-1']])
  db.close()
})

test('G1 工具挂钩：task_retry 清旧目标，新任务由派发器重新 attach', async () => {
  const { db, dispatcher, bridge, tools } = await setup()
  const task = createTask(db, {
    brief: sampleBrief({ title: '要重试', goal: '修好' }), coordinatorSession: 's-1',
    status: 'failed',
  })
  db.prepare("UPDATE tasks SET session_id = ?, target = ? WHERE id = ?").run('c-old', 'c-old', task.id)
  const text = await tools.task_message.execute({ action: 'retry', task_id: task.id }, { agent: { id: 's-1' } })
  assert.match(text, /已重派为/)
  assert.deepEqual(bridge.calls, [['clear', task.id, 'c-old']])
  const spawned = dispatcher.calls.find(call => call[0] === 'spawn')
  assert.equal(spawned[1].goal, '修好')
  db.close()
})

test('G1 工具挂钩：task_stop 把 taskId 传给派发器（stop 内部负责 clear）', async () => {
  const { db, dispatcher, tools } = await setup()
  const task = runningTask(db)
  await tools.task_message.execute({ action: 'stop', task_id: task.id }, { agent: { id: 's-1' } })
  const stopped = dispatcher.calls.find(call => call[0] === 'stop')
  assert.deepEqual(stopped, ['stop', 'c-1', task.id])
  db.close()
})

test('G1 面板挂钩：detail 只读展示 goalState；message 带目标；stop/retry 传 taskId', async () => {
  const { db, dispatcher, bridge, panel } = await setup()
  const task = runningTask(db)
  setTaskGoalState(db, task.id, {
    id: 'goal-1', revision: 2, objective: '完成目标', phase: 'active', activation: 'disarmed',
    roundsStarted: 0, maxGoalRounds: 256, updatedAt: 1,
  })
  const detail = panel.detail(task.id)
  assert.equal(detail.task.goalState.phase, 'active')
  assert.equal(detail.task.goalState.activation, 'disarmed')
  await panel.message(task.id, '继续做')
  const sent = dispatcher.calls.find(call => call[0] === 'sendReliable')
  assert.equal(sent[4], objectiveForMessage('完成目标', '继续做'))
  await panel.stop(task.id)
  const stopped = dispatcher.calls.find(call => call[0] === 'stop')
  assert.deepEqual(stopped, ['stop', 'c-1', task.id])
  // 面板 retry：failed 任务 → clear 旧目标；新任务 spawn 时带 goal。
  const failed = createTask(db, { brief: sampleBrief({ title: '面板重试', goal: '修好' }), coordinatorSession: 's-1', status: 'failed' })
  db.prepare('UPDATE tasks SET session_id = ?, target = ? WHERE id = ?').run('c-old', 'c-old', failed.id)
  bridge.calls.length = 0
  await panel.retry(failed.id)
  assert.deepEqual(bridge.calls, [['clear', failed.id, 'c-old']])
  const spawned = dispatcher.calls.filter(call => call[0] === 'spawn').at(-1)
  assert.equal(spawned[1].goal, '修好')
  db.close()
})

test('G1 面板快照：goalState 只给生命周期字段，不下发 objective 原文', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '甲', goal: '目标' }), coordinatorSession: 's-1' })
  setTaskGoalState(db, task.id, {
    id: 'goal-1', revision: 2, objective: '不该出现在 snapshot 的目标原文', phase: 'paused', activation: 'disarmed',
    roundsStarted: 3, maxGoalRounds: 256, updatedAt: 9,
  })
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const row = body.tasks.find(item => item.id === task.id)
  assert.deepEqual(row.goalState, { phase: 'paused', activation: 'disarmed', revision: 2, roundsStarted: 3, updatedAt: 9 })
  assert.equal(JSON.stringify(row).includes('不该出现'), false)
  db.close()
})

test('G1 工具只读展示：task_status 带目标生命周期', async () => {
  const { db, tools } = await setup()
  const task = runningTask(db)
  setTaskGoalState(db, task.id, { id: 'goal-1', revision: 2, phase: 'active', activation: 'disarmed', roundsStarted: 0 })
  const text = await tools.task_status.execute({ task_id: task.id }, { agent: { id: 's-1' } })
  assert.match(text, /目标状态：进行中｜不自动续轮｜修订 2/)
  db.close()
})

test('G1 结算挂钩：completed 落待确认不收口 goal；cancelled 收口 clear', async () => {
  const { createSettlementReporter } = await import('../src/settlement.js')
  const db = await openLedger(tempDir())
  const seen = []
  const reporter = createSettlementReporter({
    db,
    notifier: { push() {} },
    onTerminal: (task, status) => seen.push([task.id, status]),
  })
  const deliveredTask = runningTask(db, { brief: sampleBrief({ title: '交付', goal: 'g' }) })
  reporter.report({ taskId: deliveredTask.id, stopReason: 'completed' })
  assert.equal(getTask(db, deliveredTask.id).status, 'delivered')
  assert.deepEqual(seen, [])
  const cancelTask = runningTask(db, { brief: sampleBrief({ title: '取消', goal: 'g' }) })
  reporter.report({ taskId: cancelTask.id, stopReason: 'aborted' })
  assert.deepEqual(seen, [[cancelTask.id, 'cancelled']])
  db.close()
})
