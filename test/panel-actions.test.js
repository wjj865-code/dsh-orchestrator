import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks, transition, addMessage, setTaskArtifacts } from '../src/ledger.js'
import { createPanelActions } from '../src/panel-actions.js'
import { tempDir, sampleBrief } from './helpers.js'

function setup(options = {}) {
  const calls = { stop: [], send: [], release: [] }
  const defaultQueue = {
    removed: [],
    pumped: 0,
    remove(id) { this.removed.push(id) },
    pump() { this.pumped += 1 },
    async enqueueAndPump(id) {
      this.pumped += 1
      return { task: getTask(db, id), position: 1 }
    },
  }
  const defaultDispatcher = {
    async stop(target) { calls.stop.push(target) },
    releaseWritableRoots(target) { calls.release.push(target) },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly) {
      calls.send.push({ target, message, targetDir, taskId, readOnly })
      return { messageId: 'm-1' }
    },
  }
  let db
  const queue = options.makeQueue ? options.makeQueue(() => db) : defaultQueue
  const dispatcher = options.makeDispatcher ? options.makeDispatcher(() => db) : defaultDispatcher
  const actions = () => createPanelActions({
    db,
    dispatcher,
    queue,
    config: options.config ?? {},
    coordinatorStatus: options.coordinatorStatus ?? (() => ({ id: 's-1', live: true })),
    logger: { log() {} },
  })
  return {
    async init() {
      db = await openLedger(tempDir())
      return { db, actions: actions(), queue, calls, dispatcher }
    },
  }
}

function runningTask(db, title, extra = {}) {
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1', ...extra })
  transition(db, task.id, 'running', { sessionId: `c-${task.id}`, target: `c-${task.id}` })
  return task
}

test('detail 返回 brief/消息/产物/依赖', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const dep = createTask(db, { brief: sampleBrief({ title: '前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, dep.id, 'done')
  const task = createTask(db, {
    brief: sampleBrief({ title: '详情任务', goal: '看详情' }), coordinatorSession: 's-1',
    dependsOn: [dep.id], groupId: 'G',
  })
  transition(db, task.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  addMessage(db, task.id, { kind: 'followup', rendered: '继续' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/out.md', label: '结果', exists: true }])
  const detail = actions.detail(task.id)
  assert.equal(detail.ok, true)
  assert.equal(detail.task.title, '详情任务')
  assert.equal(detail.task.group, 'G')
  assert.equal(detail.task.artifacts.length, 1)
  assert.equal(detail.dependencies[0].status, 'done')
  assert.equal(detail.messages.some(row => row.text === '继续'), true)
  db.close()
})

test('stop 中断子会话并标 cancelled', async () => {
  const env = setup()
  const { db, actions, queue, calls } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '停止任务' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const result = await actions.stop(task.id)
  assert.equal(result.ok, true)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.deepEqual(calls.stop, ['c-1'])
  assert.deepEqual(calls.release, ['c-1'])
  assert.equal(queue.removed.includes(task.id), true)
  db.close()
})

test('retry 用原 brief 新建任务并保留编排字段', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const dep = createTask(db, { brief: sampleBrief({ title: '完成前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-dep', target: 'c-dep' })
  transition(db, dep.id, 'done')
  const old = createTask(db, {
    brief: sampleBrief({ title: '失败任务' }), coordinatorSession: 's-1',
    dependsOn: [dep.id], groupId: 'G', writeScopes: ['src'], priority: 4,
  })
  transition(db, old.id, 'failed', { error: 'boom' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, true)
  const next = getTask(db, result.taskId)
  assert.equal(next.retry_of, old.id)
  assert.deepEqual(next.depends_on, [dep.id])
  assert.equal(next.group_id, 'G')
  assert.deepEqual(next.write_scopes, ['src'])
  assert.equal(next.priority, 4)
  db.close()
})

test('message 投递续派并记录 attempts/清问题', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '续派任务' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  db.prepare('UPDATE tasks SET question = ?, question_options_json = ? WHERE id = ?').run('继续吗？', '[]', task.id)
  const result = await actions.message(task.id, '继续修')
  assert.equal(result.ok, true)
  assert.equal(calls.send[0].message, '继续修')
  const next = getTask(db, task.id)
  assert.equal(next.attempts, 1)
  assert.equal(next.question, null)
  db.close()
})

test('artifacts 汇总所有任务的产物', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '产物任务' }), coordinatorSession: 's-1' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/a.md', label: 'A', exists: true }])
  const result = actions.artifacts(10)
  assert.equal(result.ok, true)
  assert.equal(result.items[0].path, 'C:/a.md')
  assert.equal(result.items[0].taskId, task.id)
  db.close()
})

test('stop 幂等：重复 stop 返回 already，不再中断子会话', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = runningTask(db, '重复停止')
  const first = await actions.stop(task.id)
  const second = await actions.stop(task.id)
  assert.equal(first.ok, true)
  assert.equal(first.already, undefined)
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(second.status, 'cancelled')
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.deepEqual(calls.stop, [`c-${task.id}`])
  db.close()
})

test('stop 对已完成/已丢失任务返回 already，不报错', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const done = createTask(db, { brief: sampleBrief({ title: '已完成' }), coordinatorSession: 's-1', status: 'done' })
  const orphaned = createTask(db, { brief: sampleBrief({ title: '已丢失' }), coordinatorSession: 's-1', status: 'orphaned' })
  for (const task of [done, orphaned]) {
    const result = await actions.stop(task.id)
    assert.equal(result.ok, true)
    assert.equal(result.already, true)
    assert.equal(result.status, task.status)
  }
  assert.deepEqual(calls.stop, [])
  db.close()
})

test('stop 并发双击只迁移一次，另一次按 already 成功', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = runningTask(db, '并发停止')
  const [a, b] = await Promise.all([actions.stop(task.id), actions.stop(task.id)])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal([a.already === true, b.already === true].filter(Boolean).length, 1)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  db.close()
})

test('stop 迁移失败返回 STOP_FAILED 错误码', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = runningTask(db, '迁移失败')
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('weird', task.id)
  const result = await actions.stop(task.id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STOP_FAILED')
  assert.match(result.error, /停止失败/)
  assert.equal(result.taskId, task.id)
  db.close()
})

test('stop 收子会话失败不阻断取消，返回 STOP_DISPATCH_FAILED 警告', async () => {
  const env = setup({
    makeDispatcher: () => ({
      async stop() { throw new Error('interrupt boom') },
      releaseWritableRoots() {},
      async sendReliable() { return { messageId: 'm-1' } },
    }),
  })
  const { db, actions } = await env.init()
  const task = runningTask(db, '中断失败')
  const result = await actions.stop(task.id)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.warnings[0].code, 'STOP_DISPATCH_FAILED')
  assert.match(result.warnings[0].error, /interrupt boom/)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  db.close()
})

test('retry 门控：只有 failed/orphaned 能重派', async () => {
  const env = setup()
  const { db, actions, queue } = await env.init()
  const blocked = ['pending', 'running', 'waiting_dep', 'waiting_user', 'waiting_auth', 'done', 'cancelled']
  for (const status of blocked) {
    const task = createTask(db, { brief: sampleBrief({ title: `门控-${status}` }), coordinatorSession: 's-1', status })
    const result = await actions.retry(task.id)
    assert.equal(result.ok, false, status)
    assert.equal(result.code, 'RETRY_NOT_ALLOWED', status)
  }
  assert.equal(listTasks(db).length, blocked.length)
  assert.equal(queue.pumped, 0)
  db.close()
})

test('retry 幂等：重复点击返回同一条活跃重派任务', async () => {
  const env = setup()
  const { db, actions, queue } = await env.init()
  const old = runningTask(db, '重复重派')
  transition(db, old.id, 'failed', { error: 'boom' })
  const first = await actions.retry(old.id)
  const second = await actions.retry(old.id)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(second.taskId, first.taskId)
  assert.equal(second.retryOf, old.id)
  assert.equal(listTasks(db).length, 2)
  assert.equal(queue.pumped, 1)
  db.close()
})

test('retry 并发双击只建一条重派任务', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const old = runningTask(db, '并发重派')
  transition(db, old.id, 'failed', { error: 'boom' })
  const [a, b] = await Promise.all([actions.retry(old.id), actions.retry(old.id)])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.taskId, b.taskId)
  assert.equal(listTasks(db, { active: true }).filter(task => task.retry_of === old.id).length, 1)
  assert.equal(listTasks(db).length, 2)
  db.close()
})

test('retry orphaned 任务允许重派', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const old = createTask(db, { brief: sampleBrief({ title: '丢失重派' }), coordinatorSession: 's-1', status: 'orphaned' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, true)
  assert.equal(getTask(db, result.taskId).retry_of, old.id)
  db.close()
})

test('retry 已有活跃同目标任务返回 RETRY_DUPLICATE_ACTIVE', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const old = createTask(db, {
    brief: sampleBrief({ title: '同目标', goal: '做同一件事' }), coordinatorSession: 's-1', status: 'failed',
  })
  createTask(db, { brief: sampleBrief({ title: '同目标', goal: '做同一件事' }), coordinatorSession: 's-1' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RETRY_DUPLICATE_ACTIVE')
  db.close()
})

test('retry 依赖无效返回 RETRY_DEPENDS_INVALID', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const old = createTask(db, {
    brief: sampleBrief({ title: '坏依赖' }), coordinatorSession: 's-1', status: 'failed', dependsOn: ['t-missing'],
  })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RETRY_DEPENDS_INVALID')
  assert.match(result.error, /不能重派/)
  db.close()
})

test('retry 主会话失效返回 MAIN_SESSION_UNAVAILABLE', async () => {
  const env = setup({ coordinatorStatus: () => ({ id: 's-1', live: false }) })
  const { db, actions } = await env.init()
  const old = createTask(db, { brief: sampleBrief({ title: '主会话失效' }), coordinatorSession: 's-1', status: 'failed' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MAIN_SESSION_UNAVAILABLE')
  assert.equal(listTasks(db).length, 1)
  db.close()
})

test('retry 派发失败返回 RETRY_FAILED，并带新任务 id', async () => {
  const env = setup({
    makeQueue: getDb => ({
      remove() {},
      pump() {},
      async enqueueAndPump(id) {
        const db = getDb()
        db.prepare("UPDATE tasks SET status = 'failed', error = ? WHERE id = ?").run('spawn boom', id)
        return { task: getTask(db, id), position: 0 }
      },
    }),
  })
  const { db, actions } = await env.init()
  const old = createTask(db, { brief: sampleBrief({ title: '派发失败' }), coordinatorSession: 's-1', status: 'failed' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RETRY_FAILED')
  assert.equal(result.error, 'spawn boom')
  assert.equal(typeof result.taskId, 'string')
  db.close()
})

test('message 失败路径错误码齐全', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const missing = await actions.message('t-nope', 'x')
  assert.equal(missing.code, 'TASK_NOT_FOUND')
  const running = runningTask(db, '空消息')
  const empty = await actions.message(running.id, '   ')
  assert.equal(empty.code, 'MESSAGE_EMPTY')
  const done = createTask(db, { brief: sampleBrief({ title: '已结束续派' }), coordinatorSession: 's-1', status: 'done' })
  assert.equal((await actions.message(done.id, 'x')).code, 'MESSAGE_TASK_ENDED')
  const waiting = createTask(db, { brief: sampleBrief({ title: '等前置续派' }), coordinatorSession: 's-1', status: 'waiting_dep' })
  assert.equal((await actions.message(waiting.id, 'x')).code, 'MESSAGE_WAITING_DEP')
  const pending = createTask(db, { brief: sampleBrief({ title: '无会话续派' }), coordinatorSession: 's-1' })
  assert.equal((await actions.message(pending.id, 'x')).code, 'MESSAGE_NO_SESSION')
  db.close()
})

test('message 投递失败返回 MESSAGE_DELIVERY_FAILED，失败后允许立刻重发', async () => {
  let attempt = 0
  const sent = []
  const env = setup({
    makeDispatcher: () => ({
      async stop() {},
      releaseWritableRoots() {},
      async sendReliable(target, message) {
        attempt += 1
        sent.push(message)
        if (attempt === 1) throw new Error('offline')
        return { messageId: 'm-1' }
      },
    }),
  })
  const { db, actions } = await env.init()
  const task = runningTask(db, '投递失败')
  const first = await actions.message(task.id, '继续修')
  assert.equal(first.ok, false)
  assert.equal(first.code, 'MESSAGE_DELIVERY_FAILED')
  assert.match(first.error, /offline/)
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  const second = await actions.message(task.id, '继续修')
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, undefined)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(getTask(db, task.id).attempts, 1)
  assert.deepEqual(sent, ['继续修', '继续修'])
  db.close()
})

test('message 同文窗口内幂等：不重复投递、不重复累计 attempts', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = runningTask(db, '同文幂等')
  const first = await actions.message(task.id, '继续修')
  const second = await actions.message(task.id, '继续修')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(second.duplicate, true)
  assert.equal(calls.send.length, 1)
  assert.equal(getTask(db, task.id).attempts, 1)
  db.close()
})

test('message 幂等窗口可配置关闭（messageDedupeMs=0）', async () => {
  const env = setup({ config: { messageDedupeMs: 0 } })
  const { db, actions, calls } = await env.init()
  const task = runningTask(db, '窗口关闭')
  await actions.message(task.id, '继续修')
  await actions.message(task.id, '继续修')
  assert.equal(calls.send.length, 2)
  assert.equal(getTask(db, task.id).attempts, 2)
  db.close()
})

test('detail 不存在时返回 TASK_NOT_FOUND 错误码', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const result = actions.detail('t-nope')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TASK_NOT_FOUND')
  db.close()
})

test('stop 队列/写权限释放失败作为 warning 返回，不阻断取消', async () => {
  const env = setup({
    makeQueue: () => ({
      remove() { throw new Error('queue boom') },
      pump() { throw new Error('pump boom') },
      async enqueueAndPump() { throw new Error('unused') },
    }),
    makeDispatcher: () => ({
      async stop() {},
      releaseWritableRoots() { throw new Error('release boom') },
      async sendReliable() { return { messageId: 'm-1' } },
    }),
  })
  const { db, actions } = await env.init()
  const task = runningTask(db, '收尾警告')
  const result = await actions.stop(task.id)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.warnings.some(item => item.code === 'STOP_QUEUE_FAILED'), true)
  assert.equal(result.warnings.some(item => item.code === 'STOP_RELEASE_FAILED'), true)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  db.close()
})
