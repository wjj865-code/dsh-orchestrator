import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, getTask, listTasks, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeDispatcher({ failSpawn = false, failSend = false } = {}) {
  let counter = 0
  const calls = []
  return {
    calls,
    slug(title) { counter += 1; return `task-${counter}` },
    async spawn({ name, prompt, signal }) {
      calls.push(['spawn', name, prompt, signal])
      if (failSpawn) throw new Error('子会话创建失败')
      counter += 1
      return { id: `s-${counter}`, name: name ?? `w-${counter}` }
    },
    async send(target, message) { calls.push(['send', target, message]) },
    async sendReliable(target, message, signal) {
      calls.push(['sendReliable', target, message, signal])
      if (failSend) throw new Error('投递超时')
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push(['stop', target]) },
  }
}

function fakeNotifier() {
  const pushed = []
  return { pushed, push(item) { pushed.push(item) } }
}

async function setup(options = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher(options)
  const notifier = fakeNotifier()
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher,
    notifier,
    config: { staleMinutes: 30, maxActive: 8, coordinatorSession: 's-1' },
    retryDelaysMs: [0, 0, 0],
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, notifier, tools }
}

const call = (tools, name, args, exec) => tools[name].execute(args, exec)

test('注册 6 个工具，schema 对象根、无 minimum/maximum、有 output.schema/render', async () => {
  const { db, tools } = await setup()
  assert.deepEqual(Object.keys(tools).sort(),
    ['task_create', 'task_list', 'task_message', 'task_report', 'task_status', 'task_stop'])
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(key, 'minimum', `${path}.${key} 不应出现`)
      assert.notEqual(key, 'maximum', `${path}.${key} 不应出现`)
      walk(child, `${path}.${key}`)
    }
  }
  for (const tool of Object.values(tools)) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 根 schema 必须是 object`)
    assert.equal(typeof tool.output?.schema, 'object')
    assert.equal(typeof tool.output?.render, 'function')
    const rendered = tool.output.render({}, '结果')
    assert.deepEqual(rendered, [{ type: 'text', text: '结果' }])
    walk(tool.parameters, tool.name)
  }
  db.close()
})

test('task_create：正常创建、子会话 spawn、台账 running，prompt 是渲染文本', async () => {
  const { db, dispatcher, tools } = await setup()
  const signal = new AbortController().signal
  const text = await call(tools, 'task_create', sampleBrief({ title: 'A', goal: '目标A', user_verbatim: '原话' }), { signal })
  assert.match(text, /已派发/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.status, 'running')
  assert.equal(task.title, 'A')
  assert.ok(task.session_id)
  assert.ok(task.target)
  const spawn = dispatcher.calls.find(call => call[0] === 'spawn')
  assert.equal(spawn[1], 'task-1')
  assert.equal(spawn[3], signal)
  assert.match(spawn[2], /【任务】A/)
  assert.match(spawn[2], /【目标】目标A/)
  assert.match(spawn[2], /【用户原话】/)
  assert.equal(spawn[2].includes('"title"'), false)
  db.close()
})

test('task_create：缺 acceptance 返回可读提示且不建任务、不 spawn', async () => {
  const { db, dispatcher, tools } = await setup()
  const text = await call(tools, 'task_create', { title: 'A', goal: 'g' })
  assert.match(text, /acceptance/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('task_create：活跃上限', async () => {
  const { db, tools } = await setup()
  const db2 = await openLedger(tempDir())
  const tools2 = Object.fromEntries(createTools({
    db: db2,
    dispatcher: fakeDispatcher(),
    notifier: fakeNotifier(),
    config: { staleMinutes: 30, maxActive: 2, coordinatorSession: 's-1' },
  }).map(tool => [tool.name, tool]))
  await call(tools2, 'task_create', sampleBrief({ title: 'A' }))
  await call(tools2, 'task_create', sampleBrief({ title: 'B' }))
  const text = await call(tools2, 'task_create', sampleBrief({ title: 'C' }))
  assert.match(text, /上限 2/)
  assert.equal(listTasks(db2).length, 2)
  db.close(); db2.close()
})

test('task_create：spawn 失败返回可读错误，pending 保留原因', async () => {
  const { db, tools } = await setup({ failSpawn: true })
  const text = await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  assert.match(text, /任务协调失败：子会话创建失败/)
  const [task] = listTasks(db)
  assert.equal(task.status, 'pending')
  assert.match(task.error, /子会话创建失败/)
  db.close()
})

test('task_list：默认只列活跃、空表文案、全量与行格式', async () => {
  const { db, tools } = await setup()
  assert.equal(await call(tools, 'task_list', {}), '没有活跃任务。')
  assert.equal(await call(tools, 'task_list', { active: false }), '台账里还没有任何任务。')
  await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '做甲' }))
  const b = await call(tools, 'task_create', sampleBrief({ title: '乙', goal: '做乙' }))
  const idB = listTasks(db).find(task => task.title === '乙').id
  await call(tools, 'task_stop', { task_id: idB })
  const activeText = await call(tools, 'task_list', {})
  assert.match(activeText, /甲/)
  assert.equal(activeText.includes('乙'), false)
  const allText = await call(tools, 'task_list', { active: false })
  assert.match(allText, /乙/)
  assert.match(allText, /进行中/)
  assert.match(allText, /已取消/)
  assert.match(allText, /子会话/)
  assert.match(b, /已派发/)
  db.close()
})

test('task_list：31 分钟无动静带 stale 标记，29 分钟不带', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '旧' }))
  const task = listTasks(db).find(t => t.title === '旧')
  const now = Date.now()
  db.prepare('UPDATE tasks SET last_event_at = ? WHERE id = ?').run(now - 31 * 60_000, task.id)
  assert.match(await call(tools, 'task_list', {}), /⚠ 已 31 分钟无动静/)
  db.prepare('UPDATE tasks SET last_event_at = ? WHERE id = ?').run(now - 29 * 60_000, task.id)
  assert.equal((await call(tools, 'task_list', {})).includes('⚠'), false)
  db.close()
})

test('task_status：详情、最近 3 条、不存在提示', async () => {
  const { db, tools } = await setup()
  const missing = await call(tools, 'task_status', { task_id: 't-nope' })
  assert.match(missing, /没有任务 t-nope/)
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_status', { task_id: task.id })
  assert.match(text, /任务 t-/)
  assert.match(text, /进行中/)
  assert.match(text, /最近消息/)
  assert.match(text, /\[brief\]/)
  db.close()
})

test('task_message：正常写 followup 并投递，attempts +1', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const signal = new AbortController().signal
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' }, { signal })
  assert.match(text, /已把消息追加/)
  const call2 = dispatcher.calls.find(call => call[0] === 'sendReliable')
  assert.equal(call2[2], '继续')
  assert.equal(call2[3], signal)
  assert.equal(getTask(db, task.id).attempts, 1)
  const kinds = db.prepare('SELECT kind FROM messages WHERE task_id = ? ORDER BY seq').all(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['brief', 'followup'])
  db.close()
})

test('task_message：无子会话与不存在 id 给可读提示', async () => {
  const { db, dispatcher, tools } = await setup()
  const missing = await call(tools, 'task_message', { task_id: 't-nope', message: 'x' })
  assert.match(missing, /没有任务/)
  const created = await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  assert.match(created, /已派发/)
  const task = listTasks(db)[0]
  db.prepare('UPDATE tasks SET target = NULL WHERE id = ?').run(task.id)
  const text = await call(tools, 'task_message', { task_id: task.id, message: 'x' })
  assert.match(text, /还没有子会话/)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'sendReliable').length, 0)
  db.close()
})

test('task_message：终态任务拒绝续派', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  transition(db, task.id, 'done')
  const text = await call(tools, 'task_message', { task_id: task.id, message: 'x' })
  assert.match(text, /已结束/)
  db.close()
})

test('task_message：重试 3 次仍失败 → waiting_user + error + 失败消息行', async () => {
  const { db, tools } = await setup({ failSend: true })
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(text, /续派失败/)
  assert.match(text, /等你确认/)
  const after = getTask(db, task.id)
  assert.equal(after.status, 'waiting_user')
  assert.match(after.error, /投递超时/)
  const kinds = db.prepare('SELECT kind, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
  assert.ok(kinds.some(row => row.kind === 'delivery_failed'))
  db.close()
})

test('task_stop：cancelled + interrupt；已结束不再 interrupt', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_stop', { task_id: task.id })
  assert.match(text, /已停止/)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.ok(dispatcher.calls.some(call => call[0] === 'stop'))
  const again = await call(tools, 'task_stop', { task_id: task.id })
  assert.match(again, /已结束/)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'stop').length, 1)
  db.close()
})

test('task_report：progress 只 touch 不改状态', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const before = getTask(db, task.id)
  await new Promise(resolve => setTimeout(resolve, 2))
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'progress', summary: '在跑' })
  assert.match(text, /已记录/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.ok(getTask(db, task.id).last_event_at > before.last_event_at)
  assert.equal(notifier.pushed.length, 1)
  db.close()
})

test('task_report：done/blocked/needs_auth 迁移并通知，sender 透传', async () => {
  for (const [status, expected] of [['done', 'done'], ['blocked', 'waiting_user'], ['needs_auth', 'waiting_auth']]) {
    const { db, notifier, tools } = await setup()
    await call(tools, 'task_create', sampleBrief({ title: '甲' }))
    const task = listTasks(db)[0]
    const sender = { id: 'teammate-1' }
    const signal = new AbortController().signal
    await call(tools, 'task_report', { task_id: task.id, status, summary: '说明' }, { agent: sender, signal })
    assert.equal(getTask(db, task.id).status, expected)
    assert.equal(notifier.pushed.length, 1)
    assert.equal(notifier.pushed[0].status, status)
    assert.equal(notifier.pushed[0].sender, sender)
    assert.equal(notifier.pushed[0].signal, signal)
    db.close()
  }
})

test('task_report：非法 status 不写消息不改状态', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const before = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'weird', summary: 'x' })
  assert.match(text, /progress \/ done \/ blocked \/ needs_auth/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, before)
  assert.equal(notifier.pushed.length, 0)
  db.close()
})

test('task_report：不存在 id 提示且不写消息', async () => {
  const { db, tools } = await setup()
  const text = await call(tools, 'task_report', { task_id: 't-nope', status: 'progress', summary: 'x' })
  assert.match(text, /没有任务 t-nope/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0)
  db.close()
})

test('task_report：重复 done 返回可读错误，不产生第二条通知', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' })
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '再次完成' })
  assert.match(text, /任务协调失败/)
  assert.match(text, /不允许/)
  assert.equal(notifier.pushed.length, 1)
  db.close()
})

test('task_report：缺 summary 不崩', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'progress' })
  assert.match(text, /已记录/)
  db.close()
})

test('blocked → 续派 → done 闭环', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'blocked', summary: '等用户拍板' })
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  const resumed = await call(tools, 'task_message', { task_id: task.id, message: '用户选 A' })
  assert.match(resumed, /已把消息追加/)
  assert.equal(getTask(db, task.id).status, 'running')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '做完了' })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('needs_auth → 续派 → done 闭环', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'needs_auth', summary: '要授权' })
  assert.equal(getTask(db, task.id).status, 'waiting_auth')
  await call(tools, 'task_message', { task_id: task.id, message: '授权已给' })
  assert.equal(getTask(db, task.id).status, 'running')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('waiting_user 直接收到 done 回报也能闭环', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'blocked', summary: '卡住' })
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '已自行完成' })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('并发 8 个子任务：target/status 各归各，通知不丢', async () => {
  const { db, notifier, tools } = await setup()
  const exec = { agent: { id: 'worker' } }
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call(tools, 'task_create', sampleBrief({ title: `T${i}` }), exec)))
  const tasks = listTasks(db, { active: true })
  assert.equal(tasks.length, 8)
  assert.equal(new Set(tasks.map(task => task.target)).size, 8)
  assert.ok(tasks.every(task => task.status === 'running'))
  await Promise.all(tasks.map(task =>
    call(tools, 'task_report', { task_id: task.id, status: 'done', summary: task.title }, exec)))
  assert.equal(listTasks(db, { active: true }).length, 0)
  assert.equal(notifier.pushed.length, 8)
  assert.deepEqual(new Set(notifier.pushed.map(item => item.taskId)), new Set(tasks.map(task => task.id)))
  db.close()
})
