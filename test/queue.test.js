import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks, transition, failStalePending } from '../src/ledger.js'
import { createQueue } from '../src/queue.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeDispatcher({ limit = Infinity, fail = false, failTimes = 0 } = {}) {
  let alive = 0
  let failures = 0
  const calls = []
  return {
    calls,
    slug: title => `slug-${title}`,
    spawn({ name, label, prompt, signal, taskId, cwd, readOnly }) {
      calls.push({ name, label, prompt, signal, taskId, cwd, readOnly })
      if (fail || failures < failTimes) {
        failures += 1
        throw new Error('spawn 挂了')
      }
      if (alive >= limit) {
        const error = new Error('subagent limit reached')
        error.code = 'ACTIVATION_LIMIT_REACHED'
        throw error
      }
      alive += 1
      return { id: `child-${alive}`, sessionId: `child-${alive}`, target: `child-${alive}`, name: label }
    },
    release(count = 1) { alive = Math.max(0, alive - count) },
    get alive() { return alive },
  }
}

const setup = async ({ limit = Infinity, retryDelaysMs = [0], dispatcher: custom, notifier } = {}) => {
  const db = await openLedger(tempDir())
  const dispatcher = custom ?? fakeDispatcher({ limit })
  const queue = createQueue({ db, dispatcher, retryDelaysMs, notifier })
  return { db, dispatcher, queue }
}

test('load 后按创建顺序派发 pending', async () => {
  const { db, dispatcher, queue } = await setup()
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  queue.load()
  await queue.pump()
  assert.equal(getTask(db, first.id).status, 'running')
  assert.equal(getTask(db, second.id).status, 'running')
  assert.deepEqual(dispatcher.calls.map(call => call.label), ['甲', '乙'])
  assert.equal(dispatcher.calls[0].name, 'slug-甲')
  assert.equal(dispatcher.calls[0].prompt.includes('【任务】甲'), true)
  db.close()
})

test('派发时把 task.target_dir 作为 cwd 传给 dispatcher', async () => {
  const { db, dispatcher, queue } = await setup()
  createTask(db, { brief: sampleBrief({ title: '带目录' }), coordinatorSession: 's-1', targetDir: 'C:/work/project' })
  createTask(db, { brief: sampleBrief({ title: '无目录' }), coordinatorSession: 's-1' })
  queue.load()
  await queue.pump()
  assert.equal(dispatcher.calls[0].cwd, 'C:/work/project')
  assert.equal(dispatcher.calls[1].cwd, undefined)
  db.close()
})

test('容量满：任务留 pending + queued_at；释放后补位并清标记', async () => {  const { db, dispatcher, queue } = await setup({ limit: 1 })
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  await queue.enqueueAndPump(first.id)
  const outcome = await queue.enqueueAndPump(second.id)
  assert.equal(getTask(db, first.id).status, 'running')
  assert.equal(outcome.task.status, 'pending')
  assert.notEqual(outcome.task.queued_at, null)
  assert.equal(outcome.position, 1)

  dispatcher.release()
  await queue.pump()
  const resumed = getTask(db, second.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.queued_at, null)
  db.close()
})

test('readOnly：spawn 收到 readOnly；派发失败通知也带 readOnly', async () => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const queue = createQueue({ db, dispatcher, retryDelaysMs: [0] })
  const task = createTask(db, { brief: sampleBrief({ title: '只读任务' }), coordinatorSession: 's-1', readOnly: true })
  queue.enqueue(task.id)
  await queue.pump()
  assert.equal(dispatcher.calls[0].readOnly, true)
  db.close()

  const pushed = []
  const db2 = await openLedger(tempDir())
  const failing = createQueue({
    db: db2,
    dispatcher: fakeDispatcher({ fail: true }),
    retryDelaysMs: [0],
    notifier: { push: item => pushed.push(item) },
  })
  const ro = createTask(db2, { brief: sampleBrief({ title: '只读失败' }), coordinatorSession: 's-1', readOnly: true })
  failing.enqueue(ro.id)
  await failing.pump()
  const failed = pushed.find(item => item.status === 'failed')
  assert.equal(failed.readOnly, true)
  db2.close()
})


test('非容量错误：标 failed 并继续下一个', async () => {
  const { db } = await setup()
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  const failedQueue = createQueue({ db, dispatcher: fakeDispatcher({ fail: true }), retryDelaysMs: [0] })
  failedQueue.enqueue(first.id)
  failedQueue.enqueue(second.id)
  await failedQueue.pump()
  assert.equal(getTask(db, first.id).status, 'failed')
  assert.match(getTask(db, first.id).error, /子会话创建失败/)
  assert.equal(getTask(db, second.id).status, 'failed')
  db.close()
})

test('容量满时整条队列都标 queued_at，重启清理不会误杀', async () => {
  const { db, queue } = await setup({ limit: 1 })
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  const third = createTask(db, { brief: sampleBrief({ title: '丙' }), coordinatorSession: 's-1' })
  queue.enqueue(first.id)
  queue.enqueue(second.id)
  queue.enqueue(third.id)
  await queue.pump()

  assert.equal(getTask(db, first.id).status, 'running')
  assert.equal(getTask(db, second.id).status, 'pending')
  assert.equal(getTask(db, third.id).status, 'pending')
  assert.notEqual(getTask(db, second.id).queued_at, null)
  assert.notEqual(getTask(db, third.id).queued_at, null)

  // 把创建时间调到很老，模拟重启时已经超过 staleMinutes；排队中的任务不能被判「派发中断」
  db.prepare("UPDATE tasks SET created_at = 1 WHERE status = 'pending'").run()
  const cleanup = failStalePending(db, { staleMinutes: 1 })
  assert.equal(cleanup.count, 0)
  assert.equal(getTask(db, second.id).status, 'pending')
  db.close()
})

test('spawn 在途时任务被取消：收掉子会话、不误删后续任务、pump 不死', async () => {
  const db = await openLedger(tempDir())
  let releaseSpawn
  const gate = new Promise(resolve => { releaseSpawn = resolve })
  const calls = []
  const disposed = []
  const dispatcher = {
    slug: title => `slug-${title}`,
    async spawn({ taskId }) {
      calls.push(taskId)
      await gate
      return { id: `child-${taskId}`, sessionId: `child-${taskId}`, target: `child-${taskId}`, name: taskId }
    },
    async stop(target) { disposed.push(target) },
  }
  const queue = createQueue({ db, dispatcher, retryDelaysMs: [0] })
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  queue.enqueue(first.id)
  queue.enqueue(second.id)

  const pumping = queue.pump()
  // A 的 spawn 还在等，用户把 A 停掉（task_stop 的 pending 分支）
  transition(db, first.id, 'cancelled')
  queue.remove(first.id)
  releaseSpawn()
  await pumping

  assert.equal(calls[0], first.id)
  assert.deepEqual(disposed, [`child-${first.id}`])
  assert.equal(getTask(db, first.id).status, 'cancelled')
  assert.equal(getTask(db, second.id).status, 'running')
  assert.equal(queue.size(), 0)
  db.close()
})

test('stop 后队列中的任务不再派发', async () => {
  const { db, dispatcher, queue } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  queue.enqueue(task.id)
  queue.stop()
  await queue.pump()
  assert.equal(getTask(db, task.id).status, 'pending')
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('已非 pending 的队首会被丢弃，不重复派发', async () => {
  const { db, dispatcher, queue } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'cancelled')
  queue.enqueue(task.id)
  await queue.pump()
  assert.equal(dispatcher.calls.length, 0)
  assert.equal(queue.size(), 0)
  db.close()
})


test('协调者会话未就绪：按可重试处理，任务留 pending、不发失败通知', async () => {
  const pushes = []
  const dispatcher = { slug: title => title, async spawn() { throw new Error('协调者会话尚未就绪（agent.session 为空），稍后重试') } }
  const { db, queue } = await setup({ dispatcher, notifier: { push: item => pushes.push(item) } })
  const task = createTask(db, { brief: sampleBrief({ title: '未就绪' }), coordinatorSession: 's-1' })
  await queue.enqueueAndPump(task.id)
  assert.equal(getTask(db, task.id).status, 'pending')
  assert.equal(pushes.length, 0)
  db.close()
})

test('派发真失败：任务 failed 并给主会话推一条 system 通知', async () => {
  const pushes = []
  const dispatcher = { slug: title => title, async spawn() { throw new Error('boom') } }
  const { db, queue } = await setup({ dispatcher, notifier: { push: item => pushes.push(item) } })
  const task = createTask(db, { brief: sampleBrief({ title: '真失败' }), coordinatorSession: 's-1' })
  await queue.enqueueAndPump(task.id)
  assert.equal(getTask(db, task.id).status, 'failed')
  assert.match(getTask(db, task.id).error, /boom/)
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].status, 'failed')
  assert.equal(pushes[0].system, true)
  assert.match(pushes[0].summary, /boom/)
  db.close()
})
