// per-task 完整访问（task_create({ access: 'full' })）：默认不动、显式生效、非法值/互斥拒绝、可观测。
// 只测插件自己的契约（台账 / brief / 派发参数 / 文案 / 通知 / 审计事件）；真实沙箱注入见 dispatch.test.js。
import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, getTask, listTasks, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { tempDir, sampleBrief, endReportedTurn } from './helpers.js'

// 派发器桩：把 spawn 的 readOnly/access 原样记下来，用来断言「注入了什么」。
function fakeDispatcher() {
  let counter = 0
  const calls = []
  return {
    calls,
    releaseWritableRoots() {},
    slug(title) { counter += 1; return `task-${counter}` },
    async spawn(input) {
      counter += 1
      calls.push({ kind: 'spawn', readOnly: input.readOnly, access: input.access, prompt: input.prompt, cwd: input.cwd })
      return { id: `s-${counter}`, name: input.name ?? `w-${counter}`, sessionId: `s-${counter}`, target: `s-${counter}` }
    },
    async send(target, message) { calls.push({ kind: 'send', target, message }) },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective, access) {
      calls.push({ kind: 'sendReliable', target, message, taskId, readOnly, access })
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push({ kind: 'stop', target }) },
  }
}

function fakeNotifier() {
  const pushed = []
  return { pushed, push(item) { pushed.push(item) } }
}

async function setup() {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = fakeNotifier()
  const events = []
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher,
    queue,
    notifier,
    config,
    defaultCwd: tempDir(),
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    logger: { log: (event, fields) => events.push([event, fields]) },
  }).map(tool => [tool.name, tool]))
  const report = tools.task_report.execute
  tools.task_report.execute = async (args, exec) => {
    const response = await report(args, exec)
    const task = listTasks(db).find(t => t.id === args.task_id || t.ref === args.task_id)
    if (task?.delivery_pending) await endReportedTurn(db, { taskId: task.id, notifier, dispatcher, queue })
    return response
  }
  return { db, dispatcher, notifier, tools, events }
}

const call = (tools, name, args, exec) => tools[name].execute(args, { agent: { id: 's-1' }, ...(exec ?? {}) })

test('默认不受影响：不传 access 时台账/brief/派发/文案都不出现完整访问', async () => {
  const { db, dispatcher, tools, events } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '普通任务' }))
  const task = listTasks(db).find(item => item.title === '普通任务')
  assert.equal(task.access, null)
  assert.equal(task.brief.access, undefined)
  const spawn = dispatcher.calls.find(item => item.kind === 'spawn')
  assert.equal(spawn.access, undefined, '不传 access 就什么都不往派发层传')
  assert.equal(spawn.readOnly, false)
  assert.doesNotMatch(spawn.prompt, /访问级别/, 'brief 里不该有访问级别行')
  assert.equal(events.find(([event]) => event === 'task.create.created')[1].detail.access, null)
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.doesNotMatch(detail, /访问级别/)
  const status = await call(tools, 'task_status', { task_id: task.id })
  assert.doesNotMatch(status, /访问级别|完整访问/)
  const list = await call(tools, 'task_list', { active: false })
  assert.doesNotMatch(list, /完整访问/)
  db.close()
})

test("access:'full'：台账/brief/派发/详情/列表/状态/通知/审计全部标出完整访问", async () => {
  const { db, dispatcher, notifier, tools, events } = await setup()
  const reply = await call(tools, 'task_create', { ...sampleBrief({ title: '构建发版' }), access: 'full' })
  assert.match(reply, /已派发/)
  assert.match(reply, /访问级别：完整/)

  const task = listTasks(db).find(item => item.title === '构建发版')
  assert.equal(task.access, 'full')
  assert.equal(task.brief.access, 'full')
  assert.equal(getTask(db, task.id).access, 'full')

  // 派发层只收到显式 'full'（默认策略照旧由会话决定）。
  const spawn = dispatcher.calls.find(item => item.kind === 'spawn')
  assert.equal(spawn.access, 'full')
  assert.equal(spawn.readOnly, false)
  // brief：任务编号之后就是访问级别，子会话一上来就知道自己不在沙箱里跑。
  assert.match(spawn.prompt, /【访问级别】完整/)
  assert.match(spawn.prompt, /danger-full-access/)

  // 审计：创建事件带 access（台账列 + 事件双留痕）。
  const created = events.filter(([event]) => event === 'task.create.created')
  assert.equal(created.length, 1)
  assert.equal(created[0][1].detail.access, 'full')

  // task_detail（子会话读的创建详情）与 task_status / task_list。
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /访问级别：完整（danger-full-access/)
  assert.match(detail, /状态：进行中｜完整访问/)
  const status = await call(tools, 'task_status', { task_id: task.id })
  assert.match(status, /访问级别：完整/)
  const list = await call(tools, 'task_list', { active: false })
  assert.match(list, /构建发版.*完整访问/)

  // 通知：完成/交付通知标题带「（完整访问）」。
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '打好了' }, { agent: { id: task.session_id } })
  assert.equal(notifier.pushed.at(-1).access, 'full')
  db.close()
})

test('access 非法值：创建期报错并提示，不建任务、不派发', async () => {
  const { db, dispatcher, tools } = await setup()
  for (const bad of ['workspace-write', 'read-only', 'true', 'FULL', 1, true]) {
    const reply = await call(tools, 'task_create', { ...sampleBrief({ title: `非法 ${String(bad)}` }), access: bad })
    assert.match(reply, /access 只接受 "full"/, `access=${String(bad)} 应被拒绝`)
    assert.match(reply, /沿用当前会话策略/, '提示里要说清不传的语义')
  }
  assert.equal(listTasks(db).length, 0, '非法值不建任务')
  assert.equal(dispatcher.calls.filter(item => item.kind === 'spawn').length, 0)

  // 空串/空白等价于没传（模型常用 "" 表示没有），不该报错。
  const blank = await call(tools, 'task_create', { ...sampleBrief({ title: '空 access' }), access: '  ' })
  assert.match(blank, /已派发/)
  assert.equal(listTasks(db).find(item => item.title === '空 access').access, null)
  db.close()
})

test("access:'full' 与 readOnly / planFirst 互斥（创建期拒绝，不建任务）", async () => {
  const { db, dispatcher, tools } = await setup()
  const withReadOnly = await call(tools, 'task_create', {
    ...sampleBrief({ title: '互斥-只读' }), access: 'full', readOnly: true,
  })
  assert.match(withReadOnly, /与只读（readOnly）互斥/)
  const withPlan = await call(tools, 'task_create', {
    ...sampleBrief({ title: '互斥-计划' }), access: 'full', planFirst: true,
  })
  assert.match(withPlan, /与计划模式（planFirst）互斥/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.filter(item => item.kind === 'spawn').length, 0)
  db.close()
})

test("access:'full'：续派与重派都沿用完整访问（不静默降级成默认策略）", async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '续派' }), access: 'full' })
  const task = listTasks(db).find(item => item.title === '续派')
  await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  const sent = dispatcher.calls.filter(item => item.kind === 'sendReliable').at(-1)
  assert.equal(sent.access, 'full', '续派把 access 传给 sendReliable（dispatch 侧补设沙箱）')
  assert.equal(sent.readOnly, false)

  // 重派：新任务沿用原任务的 access，brief 也带上访问级别。
  transition(db, task.id, 'failed', { error: '测试失败' })
  const retry = await call(tools, 'task_message', { action: 'retry', task_id: task.id })
  assert.match(retry, /已重派/)
  const retried = listTasks(db).filter(item => item.retry_of === task.id)
  assert.equal(retried.length, 1)
  assert.equal(retried[0].access, 'full')
  assert.equal(retried[0].brief.access, 'full')
  db.close()
})

test("access:'full' 与 worktree 不互斥（隔离是目录、沙箱是权限，两回事）", async () => {
  const { db, tools } = await setup()
  // 不是 git 仓库 → 降级普通模式，但创建期不该因为 access 被拒。
  const reply = await call(tools, 'task_create', {
    ...sampleBrief({ title: '隔离+完整访问' }), target: tempDir(), access: 'full', worktree: true,
  })
  assert.doesNotMatch(reply, /互斥/)
  const task = listTasks(db).find(item => item.title === '隔离+完整访问')
  assert.equal(task.access, 'full')
  assert.equal(task.worktree_state, 'degraded')
  db.close()
})
