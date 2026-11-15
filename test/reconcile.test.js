import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, transition } from '../src/ledger.js'
import { reconcileOrphans, createStartupReconciler, reconcileSummary } from '../src/reconcile.js'
import { createDispatcher } from '../src/dispatch.js'
import { tempDir, sampleBrief } from './helpers.js'

const setup = async () => {
  const db = await openLedger(tempDir())
  const running = (title, sessionId) => {
    const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
    transition(db, task.id, 'running', { sessionId, target: sessionId })
    return task
  }
  return { db, running }
}

test('catalog 里查不到 → orphaned；live 的 running 保持；waiting 查不到也 orphaned', async () => {
  const { db, running } = await setup()
  const alive = running('活着', 'c-1')
  const gone = running('丢了', 'c-2')
  const waiting = running('等用户', 'c-3')
  transition(db, waiting.id, 'waiting_user')
  const dispatcher = { catalog: async () => [{ id: 'c-1', mode: 'continuable', label: 'x', activity: 'inactive' }] }
  const result = await reconcileOrphans({
    db, dispatcher, coordinatorSessionId: 's-1', isLive: id => id === 'c-1',
  })
  assert.deepEqual(new Set(result.ids), new Set([gone.id, waiting.id]))
  assert.equal(getTask(db, alive.id).status, 'running')
  assert.equal(getTask(db, gone.id).status, 'orphaned')
  assert.equal(getTask(db, waiting.id).status, 'orphaned')
  db.close()
})

test('running 不 live：catalog 有也标 orphaned；waiting 不 live 保持（可冷恢复）', async () => {
  const { db, running } = await setup()
  const ghost = running('幽灵', 'c-1')
  const waiting = running('等授权', 'c-2')
  transition(db, waiting.id, 'waiting_auth')
  const dispatcher = { catalog: async () => [
    { id: 'c-1', mode: 'continuable', label: 'x', activity: 'inactive' },
    { id: 'c-2', mode: 'continuable', label: 'y', activity: 'inactive' },
  ] }
  const result = await reconcileOrphans({
    db, dispatcher, coordinatorSessionId: 's-1', isLive: () => false,
  })
  assert.deepEqual(result.ids, [ghost.id])
  assert.equal(getTask(db, ghost.id).status, 'orphaned')
  assert.match(getTask(db, ghost.id).error, /没有在运行的回合/)
  assert.equal(getTask(db, waiting.id).status, 'waiting_auth')
  db.close()
})

test('catalog 读取失败：只 warn，不把 live 的 running 和 waiting 判死', async () => {
  const { db, running } = await setup()
  const task = running('任务', 'c-1')
  const waiting = running('等用户', 'c-2')
  transition(db, waiting.id, 'waiting_user')
  const warnings = []
  const dispatcher = { catalog: async () => { throw new Error('catalog 挂了') } }
  const result = await reconcileOrphans({
    db, dispatcher, coordinatorSessionId: 's-1', isLive: () => true, onWarn: message => warnings.push(message),
  })
  assert.equal(result.count, 0)
  assert.match(warnings[0], /目录读取失败/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(getTask(db, waiting.id).status, 'waiting_user')
  db.close()
})

test('team 后端不可用（占位派发器）：catalog 抛错走不可用分支，running 不被误标 orphaned', async () => {
  const { db, running } = await setup()
  const task = running('任务', 'c-1')
  const warnings = []
  // 真实占位派发器：rc.3 的 agentTeams 只剩 state/transact。
  const dispatcher = createDispatcher({
    backend: 'team',
    agentTeams: { state() {}, transact() {} },
    getAgent: () => ({ id: 's-1' }),
    onWarn: message => warnings.push(message),
  })
  const result = await reconcileOrphans({
    db, dispatcher, coordinatorSessionId: 's-1', isLive: () => true, onWarn: message => warnings.push(message),
  })
  assert.equal(result.count, 0)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.ok(warnings.some(message => /目录读取失败/.test(message)))
  assert.ok(warnings.some(message => /backend 改回 subagent/.test(message)))
  db.close()
})

test('未绑定协调者：跳过对账', async () => {
  const { db, running } = await setup()
  const task = running('任务', 'c-1')
  const dispatcher = { catalog: async () => [] }
  const result = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: undefined })
  assert.equal(result.skipped, 'no-coordinator')
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('没有活跃任务时不读 catalog', async () => {
  const { db } = await setup()
  let called = false
  const result = await reconcileOrphans({
    db,
    dispatcher: { catalog: async () => { called = true; return [] } },
    coordinatorSessionId: 's-1',
  })
  assert.equal(result.skipped, 'nothing-active')
  assert.equal(called, false)
  db.close()
})

test('S2 仅 running 参与活跃性对账：waiting_dep / waiting_* / 终态都不误标', async () => {
  const { db, running } = await setup()
  const ghost = running('幽灵', 'c-run')
  const waitingUser = running('等用户', 'c-wu')
  transition(db, waitingUser.id, 'waiting_user')
  const waitingAuth = running('等授权', 'c-wa')
  transition(db, waitingAuth.id, 'waiting_auth')
  const finished = running('已完成', 'c-done')
  transition(db, finished.id, 'done')
  // waiting_dep 还没有子会话；这里强行塞一个 session_id 的异常行，确认对账完全绕开它。
  const waitingDep = createTask(db, { brief: sampleBrief({ title: '等前置' }), coordinatorSession: 's-1' })
  db.prepare('UPDATE tasks SET status = ?, session_id = ? WHERE id = ?').run('waiting_dep', 'c-dep', waitingDep.id)
  const dispatcher = { catalog: async () => [
    { id: 'c-wu', mode: 'continuable' },
    { id: 'c-wa', mode: 'continuable' },
    { id: 'c-done', mode: 'continuable' },
  ] }
  const result = await reconcileOrphans({
    db, dispatcher, coordinatorSessionId: 's-1', isLive: () => false, // 全部不 live
  })
  assert.deepEqual(result.ids, [ghost.id])
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].id, ghost.id)
  assert.equal(getTask(db, ghost.id).status, 'orphaned')
  assert.equal(getTask(db, ghost.id).error, '进程重启后子会话没有在运行的回合（可重建）')
  for (const task of [waitingUser, waitingAuth, finished, waitingDep]) {
    assert.notEqual(getTask(db, task.id).status, 'orphaned', `${task.id} 不应被标 orphaned`)
  }
  assert.equal(getTask(db, waitingUser.id).status, 'waiting_user')
  assert.equal(getTask(db, waitingAuth.id).status, 'waiting_auth')
  assert.equal(getTask(db, finished.id).status, 'done')
  assert.equal(getTask(db, waitingDep.id).status, 'waiting_dep')
  db.close()
})

test('S2 重复启动幂等：第二次对账不重复标记、不改死因', async () => {
  const { db, running } = await setup()
  const ghost = running('幽灵', 'c-1')
  const dispatcher = { catalog: async () => [] }
  const first = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: 's-1', isLive: () => false })
  assert.equal(first.count, 1)
  const marked = getTask(db, ghost.id)
  assert.equal(marked.status, 'orphaned')
  const firstError = marked.error
  const second = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: 's-1', isLive: () => false })
  assert.equal(second.count, 0)
  assert.deepEqual(second.ids, [])
  assert.equal(getTask(db, ghost.id).status, 'orphaned')
  assert.equal(getTask(db, ghost.id).error, firstError)
  db.close()
})

test('S2 汇总通知：一次只发一条，列出本轮全部孤儿任务', async () => {
  const { db, running } = await setup()
  const first = running('甲', 'c-1')
  const second = running('乙', 'c-2')
  const calls = []
  const notifier = {
    summary(items, text) {
      calls.push({ items, text })
      return { delivered: true }
    },
  }
  const reconciler = createStartupReconciler({
    db,
    dispatcher: { catalog: async () => [] },
    isLive: () => false,
    notifier,
    labelFor: task => task.title,
  })
  const result = await reconciler.reconcile({ coordinatorSessionId: 's-1' })
  assert.equal(result.count, 2)
  assert.equal(result.summary?.delivered, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].items.length, 2)
  assert.deepEqual(calls[0].items.map(item => item.taskId).sort(), [first.id, second.id].sort())
  assert.ok(calls[0].items.every(item => item.status === 'orphaned' && item.system === true))
  assert.match(calls[0].text, /启动对账：2 个任务/)
  assert.match(calls[0].text, /- 甲（t-/)
  assert.match(calls[0].text, /- 乙（t-/)
  assert.match(calls[0].text, /task_retry/)
  assert.equal(reconciler.pendingCount(), 0)
  db.close()
})

test('S2 汇总被跳过时保留待发，协调者加载后补发一次、不重复', async () => {
  const { db, running } = await setup()
  running('幽灵', 'c-1')
  const calls = []
  let deliverable = false
  const notifier = {
    summary(items, text) {
      calls.push(text)
      return deliverable ? { delivered: true } : { skipped: true, reason: '主会话未加载' }
    },
  }
  const reconciler = createStartupReconciler({
    db,
    dispatcher: { catalog: async () => [] },
    isLive: () => false,
    notifier,
  })
  const first = await reconciler.reconcile({ coordinatorSessionId: 's-1' })
  assert.equal(first.count, 1)
  assert.equal(first.summary?.delivered, false)
  assert.equal(calls.length, 1)
  assert.equal(reconciler.pendingCount(), 1)

  deliverable = true
  // 第二次对账：任务已不是 running，但上一次的汇总要补发。
  const second = await reconciler.reconcile({ coordinatorSessionId: 's-1' })
  assert.equal(second.count, 0)
  assert.equal(second.summary?.delivered, true)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /启动对账：1 个任务/)
  assert.equal(reconciler.pendingCount(), 0)

  // 第三次：没有新孤儿也没有待发，不再发。
  const third = await reconciler.reconcile({ coordinatorSessionId: 's-1' })
  assert.equal(third.count, 0)
  assert.equal(calls.length, 2)
  db.close()
})

test('S2 汇总文案：超过上限折叠为「另有 N 个」，空列表返回 null', () => {
  assert.equal(reconcileSummary([]), null)
  const tasks = Array.from({ length: 12 }, (_, index) => ({ id: `t-${index}`, title: `任务${index}` }))
  const text = reconcileSummary(tasks, { max: 5, labelFor: task => task.title })
  assert.match(text, /启动对账：12 个任务/)
  assert.match(text, /- 任务0（t-0）/)
  assert.match(text, /另有 7 个任务未列出/)
  assert.doesNotMatch(text, /- 任务5（t-5）/)
  assert.equal(reconcileSummary(undefined), null)
})

