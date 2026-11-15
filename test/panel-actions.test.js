import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openLedger, createTask, getTask, listTasks, transition, addMessage, addNotification,
  setTaskArtifacts, setTaskLastMessage,
} from '../src/ledger.js'
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

test('retry 的 brief 与 task_create 同口径：任务编号 + task_detail 指引（面板重派）', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const old = createTask(db, {
    brief: sampleBrief({ title: '失败任务', goal: '把目标写得很长'.repeat(40) }), coordinatorSession: 's-1',
  })
  transition(db, old.id, 'failed', { error: 'boom' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, true)
  const row = db.prepare("SELECT rendered FROM messages WHERE task_id = ? AND kind = 'brief'").get(result.taskId)
  assert.ok(row !== undefined, '重派也要写 brief 消息')
  const lines = row.rendered.split('\n')
  // T1：面板重派与 task_create 同口径——新任务编号 + 一句 task_detail 指引，不再内联目标。
  assert.equal(lines.length, 2)
  assert.equal(lines[0], `【任务编号】${result.taskId}`)
  assert.match(lines[1], /task_detail/)
  assert.equal(row.rendered.includes('把目标写得很长把目标写得很长'), false)
  assert.equal(row.rendered.includes('【目标】'), false)
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

test('artifacts 带项目/目标目录/子会话与总数，供产物页分组和打开', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = runningTask(db, '产物元数据', { targetDir: 'C:/work/project-a' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/work/project-a/a.md', label: 'A', exists: true }])
  const result = actions.artifacts(10)
  assert.equal(result.ok, true)
  assert.equal(result.total, 1)
  assert.equal(result.items[0].project, 'project-a')
  assert.equal(result.items[0].targetDir, 'C:/work/project-a')
  assert.equal(result.items[0].childSessionId, `c-${task.id}`)
  assert.equal(result.items[0].status, 'running')
  db.close()
})

test('preview 只读台账里登记过的产物：文本 / 二进制 / 目录 / 缺失 / 未登记', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = tempDir()
  const textFile = join(dir, 'note.md')
  writeFileSync(textFile, '# 标题\n正文', 'utf8')
  const binaryFile = join(dir, 'bin.dat')
  writeFileSync(binaryFile, Buffer.from([0x61, 0x00, 0x62]))
  mkdirSync(join(dir, 'dist'))
  const env = setup()
  const { db, actions } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '预览任务' }), coordinatorSession: 's-1' })
  setTaskArtifacts(db, task.id, [
    { path: textFile, label: '文本', exists: true },
    { path: binaryFile, label: '二进制', exists: true },
    { path: join(dir, 'dist'), label: '目录', exists: true },
    { path: join(dir, 'gone.txt'), label: '已删除', exists: false },
  ])
  const text = actions.preview(task.id, textFile)
  assert.equal(text.ok, true)
  assert.equal(text.kind, 'text')
  assert.equal(text.text, '# 标题\n正文')
  assert.equal(text.truncated, false)
  assert.equal(actions.preview(task.id, binaryFile).kind, 'binary')
  assert.equal(actions.preview(task.id, join(dir, 'dist')).kind, 'directory')
  assert.equal(actions.preview(task.id, join(dir, 'gone.txt')).code, 'ARTIFACT_MISSING')
  assert.equal(actions.preview(task.id, 'C:/not-recorded.md').code, 'ARTIFACT_NOT_FOUND')
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


test('detail 四区块：brief 原样返回，依赖带上下游与空态', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const dep = createTask(db, { brief: sampleBrief({ title: '前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-dep', target: 'c-dep' })
  transition(db, dep.id, 'done')
  const task = createTask(db, {
    brief: sampleBrief({
      title: '中间任务', goal: '中间目标', acceptance: ['甲', '乙'], constraints: ['只读跑'],
      refs: ['docs/x.md'], user_verbatim: '原话',
    }),
    coordinatorSession: 's-1', dependsOn: [dep.id],
  })
  transition(db, task.id, 'running', { sessionId: 'c-mid', target: 'c-mid' })
  const downstream = createTask(db, { brief: sampleBrief({ title: '下游' }), coordinatorSession: 's-1', dependsOn: [task.id] })
  const detail = actions.detail(task.id)
  assert.equal(detail.ok, true)
  // 1) brief 区块的数据来源：台账 tasks.brief_json 原样返回，不裁剪。
  assert.deepEqual(detail.task.brief.acceptance, ['甲', '乙'])
  assert.deepEqual(detail.task.brief.constraints, ['只读跑'])
  assert.deepEqual(detail.task.brief.refs, ['docs/x.md'])
  assert.equal(detail.task.brief.user_verbatim, '原话')
  // 2) 消息为空时是空数组，不补假消息。
  assert.deepEqual(detail.messages, [])
  // 3) 依赖：上游 + 下游，都带状态。
  assert.deepEqual(detail.dependencies.map(row => [row.title, row.status]), [['前置', 'done']])
  assert.deepEqual(detail.dependents.map(row => [row.title, row.status]), [['下游', downstream.status]])
  assert.equal(detail.task.count.dependencies, 1)
  assert.equal(detail.task.count.dependents, 1)
  // 4) 产物为空时是空数组。
  assert.deepEqual(detail.task.artifacts, [])
  // 孤立任务：上下游都是空数组（面板显示「没有前置/下游任务」）。
  const lonely = createTask(db, { brief: sampleBrief({ title: '孤立' }), coordinatorSession: 's-1' })
  const empty = actions.detail(lonely.id)
  assert.deepEqual(empty.dependencies, [])
  assert.deepEqual(empty.dependents, [])
  assert.deepEqual(empty.messages, [])
  db.close()
})

test('detail 上游依赖缺失时标 missing，不伪造标题', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = createTask(db, {
    brief: sampleBrief({ title: '缺前置' }), coordinatorSession: 's-1', dependsOn: ['t-404'],
  })
  const detail = actions.detail(task.id)
  assert.deepEqual(detail.dependencies, [{ id: 't-404', title: 't-404', status: 'missing' }])
  db.close()
})

test('detail 消息投递状态：投递中是 pending（待发），成功后 delivered（已投递）', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const env = setup({
    makeDispatcher: () => ({
      async stop() {},
      releaseWritableRoots() {},
      async sendReliable() { await gate; return { messageId: 'm-1' } },
    }),
  })
  const { db, actions } = await env.init()
  const task = runningTask(db, '待发消息')
  const sending = actions.message(task.id, '排队中')
  // 投递尚未完成：followup 已落库但状态是 pending。
  const during = actions.detail(task.id).messages.find(row => row.kind === 'followup')
  assert.equal(during.text, '排队中')
  assert.equal(during.delivery, 'pending')
  release()
  const result = await sending
  assert.equal(result.ok, true)
  const after = actions.detail(task.id).messages.find(row => row.kind === 'followup')
  assert.equal(after.delivery, 'delivered')
  db.close()
})

test('detail 消息投递失败：followup 标 failed，并保留 delivery_failed 行', async () => {
  const env = setup({
    makeDispatcher: () => ({
      async stop() {},
      releaseWritableRoots() {},
      async sendReliable() { throw new Error('offline') },
    }),
  })
  const { db, actions } = await env.init()
  const task = runningTask(db, '投递失败')
  const result = await actions.message(task.id, '继续修')
  assert.equal(result.ok, false)
  const detail = actions.detail(task.id)
  assert.equal(detail.messages.find(row => row.kind === 'followup').delivery, 'failed')
  assert.equal(detail.messages.some(row => row.kind === 'delivery_failed'), true)
  db.close()
})

// U2/B1：详情抽屉新增「最新回复」区块（子会话最后一条 assistant 消息）。
// 内联消息给正文，大文件消息给摘要 + 路径；没有回复时是 null（面板显示空态），不造空字符串。
test('detail 回传最新回复（B1）：内联正文 / 文件摘要 / 没有回复为 null', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = runningTask(db, '有回复')
  const at = Date.now()
  setTaskLastMessage(db, task.id, {
    at, stopReason: 'end_turn', source: 'settlement', bytes: 6, chars: 2, digest: 'd1',
    summary: '搞定', stored: 'inline', text: '搞定',
  })
  const inline = actions.detail(task.id)
  assert.equal(inline.ok, true)
  assert.equal(inline.task.lastMessage.stored, 'inline')
  assert.equal(inline.task.lastMessage.text, '搞定')
  assert.equal(inline.task.lastMessage.at, at)
  // 大消息只留摘要 + 路径，正文不进 detail（避免详情接口被 64 KiB 正文撑大）。
  setTaskLastMessage(db, task.id, {
    at, stopReason: null, source: 'settlement', bytes: 90000, chars: 90000, digest: 'd2',
    summary: '很长…', stored: 'file', path: 'C:/state/reports/t-x.md',
  })
  const file = actions.detail(task.id)
  assert.equal(file.task.lastMessage.stored, 'file')
  assert.equal(file.task.lastMessage.path, 'C:/state/reports/t-x.md')
  assert.equal(file.task.lastMessage.text, undefined)
  assert.equal(file.task.lastMessage.summary, '很长…')
  // 没有回复的任务：null，而不是 {} 或 ''。
  const lonely = createTask(db, { brief: sampleBrief({ title: '没有回复' }), coordinatorSession: 's-1' })
  assert.equal(actions.detail(lonely.id).task.lastMessage, null)
  db.close()
})

// ---------------------------------------------------------------------------
// 面板优化：追加消息状态门控 + 删除任务/子会话。
// 门控与 client.js 的按钮显示同源：detail 下发 canFollowup / canDelete，
// 面板只渲染，不在前端另写一套状态表。
// ---------------------------------------------------------------------------

test('message 门控与按钮同源：失败任务拒绝续派，提示改用重派', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = runningTask(db, '失败任务')
  transition(db, task.id, 'failed', { error: 'boom' })
  const result = await actions.message(task.id, '继续')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MESSAGE_NOT_FOLLOWABLE')
  assert.match(result.error, /重派/)
  assert.equal(calls.send.length, 0)
  // 失败任务仍可重派：门控只挡续派，不挡建新尝试。
  assert.equal(actions.detail(task.id).task.canFollowup, false)
  assert.equal(actions.detail(task.id).task.canDelete, true)
  db.close()
})

test('detail 回传 canFollowup/canDelete：进行中可续派不可删，终态不可续派但可删', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const running = runningTask(db, '在跑')
  const runningDetail = actions.detail(running.id).task
  assert.equal(runningDetail.canFollowup, true)
  assert.equal(runningDetail.canDelete, false)
  const done = createTask(db, { brief: sampleBrief({ title: '已完成' }), coordinatorSession: 's-1', status: 'done' })
  const doneDetail = actions.detail(done.id).task
  assert.equal(doneDetail.canFollowup, false)
  assert.equal(doneDetail.canDelete, true)
  const waitingDep = createTask(db, {
    brief: sampleBrief({ title: '等前置' }), coordinatorSession: 's-1', status: 'waiting_dep',
  })
  const waitingDetail = actions.detail(waitingDep.id).task
  assert.equal(waitingDetail.canFollowup, false)
  assert.equal(waitingDetail.canDelete, false)
  db.close()
})

test('delete：终态任务级联清理消息与通知，其他任务不受影响', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const keep = runningTask(db, '保留')
  const task = createTask(db, { brief: sampleBrief({ title: '待删' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-del', target: 'c-del' })
  transition(db, task.id, 'done')
  addMessage(db, task.id, { kind: 'brief', rendered: '简报' })
  addMessage(db, task.id, { kind: 'report', rendered: '结果' })
  addMessage(db, keep.id, { kind: 'brief', rendered: '别删' })
  addNotification(db, { taskId: task.id, level: 'info' })
  addNotification(db, { taskId: keep.id, level: 'info' })
  const result = await actions.delete(task.id)
  assert.equal(result.ok, true)
  assert.equal(result.taskId, task.id)
  assert.deepEqual(result.deleted, { messages: 2, notifications: 1 })
  assert.equal(getTask(db, task.id), undefined)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications WHERE task_id = ?').get(task.id).n, 0)
  assert.equal(getTask(db, keep.id).status, 'running')
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(keep.id).n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications WHERE task_id = ?').get(keep.id).n, 1)
  // 已删除的任务再查详情：按不存在处理，不留半截记录。
  assert.equal(actions.detail(task.id).code, 'TASK_NOT_FOUND')
  db.close()
})

test('delete 门控：活跃任务返回 DELETE_TASK_ACTIVE，且一行都不删', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  for (const status of ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered']) {
    const task = createTask(db, { brief: sampleBrief({ title: `活跃-${status}` }), coordinatorSession: 's-1', status })
    addMessage(db, task.id, { kind: 'brief', rendered: '简报' })
    const result = await actions.delete(task.id)
    assert.equal(result.ok, false, status)
    assert.equal(result.code, 'DELETE_TASK_ACTIVE', status)
    assert.match(result.error, /先「停止」/, status)
    assert.notEqual(getTask(db, task.id), undefined, status)
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, 1, status)
  }
  db.close()
})

test('delete 门控：还有活跃下游依赖时拒绝（避免依赖链变 missing）', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const upstream = createTask(db, { brief: sampleBrief({ title: '已完成前置' }), coordinatorSession: 's-1' })
  transition(db, upstream.id, 'running', { sessionId: 'c-up', target: 'c-up' })
  transition(db, upstream.id, 'done')
  const downstream = createTask(db, {
    brief: sampleBrief({ title: '等前置的下游' }), coordinatorSession: 's-1', dependsOn: [upstream.id], status: 'waiting_dep',
  })
  // 详情与快照同源：活跃下游在的时候 canDelete=false（按钮隐藏），不是等点了才 409。
  assert.equal(actions.detail(upstream.id).task.canDelete, false)
  const blocked = await actions.delete(upstream.id)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'DELETE_HAS_ACTIVE_DEPENDENTS')
  assert.match(blocked.error, /下游/)
  assert.notEqual(getTask(db, upstream.id), undefined)
  // 下游也结束之后才允许删：只挡活跃依赖，不永久禁止删历史。
  transition(db, downstream.id, 'cancelled')
  assert.equal(actions.detail(upstream.id).task.canDelete, true)
  const result = await actions.delete(upstream.id)
  assert.equal(result.ok, true)
  assert.equal(getTask(db, upstream.id), undefined)
  db.close()
})

test('delete 不存在：TASK_NOT_FOUND，不碰其他数据', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const keep = runningTask(db, '保留')
  const result = await actions.delete('t-nope')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TASK_NOT_FOUND')
  assert.equal(listTasks(db).length, 1)
  assert.equal(getTask(db, keep.id).status, 'running')
  db.close()
})

test('detail 旧 followup 无 meta：按失败行推断，只归给最近一条', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = runningTask(db, '旧消息')
  addMessage(db, task.id, { kind: 'followup', rendered: '旧A' })
  addMessage(db, task.id, { kind: 'followup', rendered: '旧B' })
  addMessage(db, task.id, { kind: 'delivery_failed', rendered: '[投递失败] boom' })
  const rows = actions.detail(task.id).messages
  assert.equal(rows.find(row => row.text === '旧A').delivery, 'delivered')
  assert.equal(rows.find(row => row.text === '旧B').delivery, 'failed')
  db.close()
})

// ---------------------------------------------------------------------------
// 两段式终态（delivered）：待确认 → 确认交付（close）/ 追问（message）。
// 门控与按钮同源：detail 下发 canClose / canFollowup，前端只渲染。
// ---------------------------------------------------------------------------
const deliveredTask = (db, title = '待确认') => {
  const task = runningTask(db, title)
  transition(db, task.id, 'delivered')
  return getTask(db, task.id)
}

test('delivered：detail 下发交付时间与 canClose；追问复用原会话回 running', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = deliveredTask(db, '待确认')
  const detail = actions.detail(task.id).task
  assert.equal(detail.status, 'delivered')
  assert.equal(detail.canClose, true)
  assert.equal(detail.canFollowup, true)
  assert.equal(detail.canDelete, false)
  assert.ok(Number.isFinite(detail.deliveredAt))
  assert.equal(detail.closeReason, null)

  const resumed = await actions.message(task.id, '再补一份说明')
  assert.equal(resumed.ok, true)
  assert.equal(calls.send.length, 1)
  assert.equal(calls.send[0].target, task.target)
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('close：delivered → done（写关闭原因、释放可写根、唤醒队列）；非待确认拒绝', async () => {
  const env = setup()
  const { db, actions, calls, queue } = await env.init()
  const task = deliveredTask(db, '可确认')
  const result = await actions.close(task.id)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'done')
  const closed = getTask(db, task.id)
  assert.equal(closed.status, 'done')
  assert.equal(closed.close_reason, 'coordinator')
  assert.deepEqual(calls.release, [task.session_id])
  assert.equal(queue.pumped, 1)
  assert.equal(actions.detail(task.id).task.closeReasonLabel, '协调者确认')

  // 已 done 再确认：幂等成功，不重复释放/补位。
  const again = await actions.close(task.id)
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  assert.equal(calls.release.length, 1)

  // 进行中的任务不能确认：按钮不显示 + 动作 409，并给出可执行提示。
  const running = runningTask(db, '在跑')
  assert.equal(actions.detail(running.id).task.canClose, false)
  const denied = await actions.close(running.id)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'CLOSE_NOT_DELIVERED')
  assert.match(denied.error, /待确认/)
  // 已取消的任务：CLOSE_TASK_ENDED（不是「还没交付」）。
  const cancelled = runningTask(db, '已取消')
  transition(db, cancelled.id, 'cancelled')
  const ended = await actions.close(cancelled.id)
  assert.equal(ended.code, 'CLOSE_TASK_ENDED')
  assert.equal(await actions.close('t-nope').then(row => row.code), 'TASK_NOT_FOUND')
  db.close()
})

test('delivered 追问失败：保持 delivered 只记原因，不降级', async () => {
  const env = setup({
    makeDispatcher: () => ({
      async sendReliable() { throw new Error('投递超时') },
      releaseWritableRoots() {},
      async stop() {},
    }),
  })
  const { db, actions } = await env.init()
  const task = deliveredTask(db, '投递失败')
  const result = await actions.message(task.id, '再改一下')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MESSAGE_DELIVERY_FAILED')
  const after = getTask(db, task.id)
  assert.equal(after.status, 'delivered')
  assert.match(after.error, /投递超时/)
  db.close()
})
