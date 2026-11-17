import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, transition, addMessage, touchTask } from '../src/ledger.js'
import {
  findIdleTasks, lastActivityAt, idleSummary, createIdleWatchdog,
  DEFAULT_WATCHDOG_INTERVAL_MINUTES, DEFAULT_WATCHDOG_IDLE_MINUTES,
} from '../src/watchdog.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

const MIN = 60_000
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup() {
  const db = await openLedger(tempDir())
  const create = (title, { status = 'running', sessionId } = {}) => {
    const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
    const session = sessionId ?? `c-${task.id}`
    if (status !== 'pending') transition(db, task.id, 'running', { sessionId: session, target: session })
    // 终态夹具走合法路径（running → done 已删，见 status-facts.js）；其余状态直接迁。
    if (status === 'done') markDone(db, task.id)
    else if (status !== 'pending' && status !== 'running') transition(db, task.id, status)
    return getTask(db, task.id)
  }
  // 把三条活动时间都推到 minutes 分钟前（模拟长时间无动静）。
  const age = (id, minutes) => {
    const at = Date.now() - minutes * MIN
    db.prepare('UPDATE tasks SET created_at = ?, updated_at = ?, last_event_at = ? WHERE id = ?').run(at, at, at, String(id))
    return getTask(db, id)
  }
  return { db, create, age }
}

function fakeNotifier({ deliver } = {}) {
  const summaries = []
  const pushes = []
  return {
    summaries,
    pushes,
    summary(items, text) {
      summaries.push({ items, text })
      return typeof deliver === 'function' ? deliver(items, text) : { delivered: true }
    },
    push(item) { pushes.push(item) },
  }
}

test('看门狗默认值：巡检 5 分钟、running 空闲 15 分钟告警', () => {
  assert.equal(DEFAULT_WATCHDOG_INTERVAL_MINUTES, 5)
  assert.equal(DEFAULT_WATCHDOG_IDLE_MINUTES, 15)
})

test('findIdleTasks：只看 running；心跳/消息/状态变化三源里任一更新都算有进展', async () => {
  const { db, create, age } = await setup()
  const idleTask = create('空闲任务')
  age(idleTask.id, 20)
  const fresh = create('刚动过')
  const waiting = create('等你确认', { status: 'waiting_user' })
  age(waiting.id, 60)
  const done = create('已完成', { status: 'done' })
  age(done.id, 60)

  const now = Date.now()
  const idle = findIdleTasks({ db, now, idleMinutes: 15 })
  assert.deepEqual(idle.map(entry => entry.task.id), [idleTask.id])
  assert.equal(idle[0].task.status, 'running')
  assert.ok(idle[0].idleMs >= 19 * MIN, `idleMs=${idle[0].idleMs}`)

  // 消息源：把任务的时间戳推老，但补一条新回报 → 不算空闲。
  age(fresh.id, 60)
  addMessage(db, fresh.id, { kind: 'report', rendered: '[progress] 还在跑' })
  assert.ok(lastActivityAt(db, getTask(db, fresh.id)) > now - MIN)
  assert.equal(findIdleTasks({ db, now, idleMinutes: 15 }).some(entry => entry.task.id === fresh.id), false)

  // 心跳源：touchTask 刷新 last_event_at → 不算空闲。
  age(idleTask.id, 30)
  touchTask(db, idleTask.id)
  assert.equal(findIdleTasks({ db, now, idleMinutes: 15 }).some(entry => entry.task.id === idleTask.id), false)
  db.close()
})

test('阈值口径：达到 idleMinutes 即空闲，差 1 毫秒不算；阈值可配', async () => {
  const { db, create, age } = await setup()
  const task = create('边界任务')
  age(task.id, 15)
  const lastActivity = lastActivityAt(db, getTask(db, task.id))
  assert.equal(findIdleTasks({ db, now: lastActivity + 15 * MIN, idleMinutes: 15 }).length, 1)
  assert.equal(findIdleTasks({ db, now: lastActivity + 15 * MIN - 1, idleMinutes: 15 }).length, 0)
  assert.equal(findIdleTasks({ db, now: lastActivity + 5 * MIN, idleMinutes: 5 }).length, 1)
  assert.equal(findIdleTasks({ db, now: lastActivity + 30 * MIN, idleMinutes: 30 }).length, 1)
  assert.equal(findIdleTasks({ db, now: lastActivity + 30 * MIN, idleMinutes: 31 }).length, 0)
  db.close()
})

test('看门狗：同一段空闲每任务只告警一次，且不改状态', async () => {
  const { db, create, age } = await setup()
  const task = create('卡住的任务')
  age(task.id, 30)
  const notifier = fakeNotifier()
  const events = []
  const watchdog = createIdleWatchdog({
    db, notifier, logger: { log: (event, fields) => events.push([event, fields]) },
    idleMinutes: 15, intervalMinutes: 5,
  })
  const first = watchdog.scan()
  assert.deepEqual(first.alerted, [task.id])
  assert.equal(first.checked, 1)
  assert.equal(notifier.summaries.length, 1)
  assert.match(notifier.summaries[0].text, /空闲看门狗：1 个任务在 running/)
  assert.match(notifier.summaries[0].text, /卡住的任务/)
  assert.match(notifier.summaries[0].text, /只告警、不改任务状态/)
  const item = notifier.summaries[0].items[0]
  assert.equal(item.taskId, task.id)
  assert.equal(item.status, 'stalled')
  assert.equal(item.system, true)
  assert.match(item.summary, /30 分钟没有心跳/)
  assert.equal(watchdog.notifiedCount(), 1)
  assert.equal(events.some(([event]) => event === 'task.idle.watchdog'), true)

  // 再扫一轮：同一段空闲不重复告警。
  const second = watchdog.scan()
  assert.deepEqual(second.alerted, [])
  assert.equal(second.skipped, 'already-alerted')
  assert.equal(notifier.summaries.length, 1)

  // 只告警：状态与 error 都没被改，也没有被 stop/kill。
  const after = getTask(db, task.id)
  assert.equal(after.status, 'running')
  assert.equal(after.error, null)
  assert.equal(after.session_id, `c-${task.id}`)
  db.close()
})

test('看门狗：有活动后去重重置，再次空闲时再告警一次', async () => {
  const { db, create, age } = await setup()
  const task = create('断断续续')
  age(task.id, 40)
  const notifier = fakeNotifier()
  let at = Date.now()
  const watchdog = createIdleWatchdog({ db, notifier, idleMinutes: 15, now: () => at })
  assert.deepEqual(watchdog.scan().alerted, [task.id])
  assert.equal(notifier.summaries.length, 1)

  // 有活动：新增一条回报消息，活动水位抬高 → 本轮不再告警。
  const messageAt = at
  addMessage(db, task.id, { kind: 'report', rendered: '[progress] 继续' })
  at = messageAt + MIN
  assert.deepEqual(watchdog.scan().alerted, [])
  assert.equal(notifier.summaries.length, 1)

  // 又空闲超过阈值：允许再报一次。
  at = messageAt + 20 * MIN
  assert.deepEqual(watchdog.scan().alerted, [task.id])
  assert.equal(notifier.summaries.length, 2)
  db.close()
})

test('看门狗：多个空闲任务合并成一条通知，逐任务计入去重', async () => {
  const { db, create, age } = await setup()
  const a = create('甲')
  age(a.id, 40)
  const b = create('乙')
  age(b.id, 25)
  const notifier = fakeNotifier()
  const watchdog = createIdleWatchdog({ db, notifier, idleMinutes: 15 })
  const result = watchdog.scan()
  assert.equal(result.alerted.length, 2)
  assert.equal(notifier.summaries.length, 1)
  assert.equal(notifier.summaries[0].items.length, 2)
  assert.match(notifier.summaries[0].text, /2 个任务在 running/)
  assert.equal(watchdog.notifiedCount(), 2)
  assert.deepEqual(watchdog.scan().alerted, [])
  db.close()
})

test('看门狗：任务离开 running 后去重表不再保留（不泄漏）', async () => {
  const { db, create, age } = await setup()
  const task = create('会被停止')
  age(task.id, 40)
  const watchdog = createIdleWatchdog({ db, notifier: fakeNotifier(), idleMinutes: 15 })
  watchdog.scan()
  assert.equal(watchdog.notifiedCount(), 1)
  transition(db, task.id, 'cancelled')
  const result = watchdog.scan()
  assert.deepEqual(result.alerted, [])
  assert.equal(result.checked, 0)
  assert.equal(watchdog.notifiedCount(), 0)
  db.close()
})

test('关闭开关：不装定时器、不巡检、不告警', async () => {
  const { db, create, age } = await setup()
  const task = create('关掉也空闲')
  age(task.id, 60)
  const notifier = fakeNotifier()
  const watchdog = createIdleWatchdog({ db, notifier, enabled: false, intervalMs: 5, idleMinutes: 15 })
  assert.equal(watchdog.enabled, false)
  assert.equal(watchdog.scan().skipped, 'disabled')
  const dispose = watchdog.start()
  await wait(40)
  assert.equal(notifier.summaries.length, 0)
  assert.equal(watchdog.notifiedCount(), 0)
  dispose()
  db.close()
})

test('启动立即巡检一次；stop()/卸载清理后定时器不再巡检', async () => {
  const { db, create, age } = await setup()
  const existing = create('启动时就空闲')
  age(existing.id, 40)
  const notifier = fakeNotifier()
  const watchdog = createIdleWatchdog({ db, notifier, idleMinutes: 15, intervalMs: 10 })
  const dispose = watchdog.start()
  // 启动即巡检：已有的空闲任务立刻告警。
  assert.equal(notifier.summaries.length, 1)
  assert.deepEqual(notifier.summaries[0].items.map(item => item.taskId), [existing.id])

  // 定时器在跑：新出现的空闲任务下一轮会被巡检到。
  const later = create('后来才空闲')
  age(later.id, 40)
  await wait(60)
  assert.equal(notifier.summaries.length, 2)
  assert.deepEqual(notifier.summaries[1].items.map(item => item.taskId), [later.id])

  // 卸载清理：stop 后不再巡检、去重表清空。
  dispose()
  assert.equal(watchdog.notifiedCount(), 0)
  const afterStop = create('卸载后新增')
  age(afterStop.id, 40)
  await wait(60)
  assert.equal(notifier.summaries.length, 2)
  // 显式 stop() 同样幂等。
  assert.equal(watchdog.stop(), undefined)
  db.close()
})

test('没有 summary 的通知器：逐条 push，仍按任务去重', async () => {
  const { db, create, age } = await setup()
  const task = create('无汇总')
  age(task.id, 40)
  const pushed = []
  const watchdog = createIdleWatchdog({ db, notifier: { push: item => pushed.push(item) }, idleMinutes: 15 })
  watchdog.scan()
  watchdog.scan()
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].taskId, task.id)
  assert.equal(pushed[0].status, 'stalled')
  db.close()
})

test('通知投递被跳过：仍然每任务只告警一次（不每轮刷）', async () => {
  const { db, create, age } = await setup()
  const task = create('没人收')
  age(task.id, 40)
  const notifier = fakeNotifier({ deliver: () => ({ delivered: false, reason: '尚未打开主会话' }) })
  const events = []
  const watchdog = createIdleWatchdog({
    db, notifier, logger: { log: (event, fields) => events.push([event, fields]) }, idleMinutes: 15,
  })
  assert.deepEqual(watchdog.scan().alerted, [task.id])
  assert.deepEqual(watchdog.scan().alerted, [])
  assert.equal(notifier.summaries.length, 1)
  assert.equal(events.some(([event]) => event === 'task.idle.watchdog.skipped'), true)
  db.close()
})

test('台账读失败只 warn，不抛、不改状态', async () => {
  const { db, create, age } = await setup()
  const task = create('读失败')
  age(task.id, 40)
  const warnings = []
  const watchdog = createIdleWatchdog({
    db, notifier: fakeNotifier(), idleMinutes: 15, onWarn: message => warnings.push(message),
  })
  db.close()
  const result = watchdog.scan()
  assert.equal(result.skipped, 'error')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /空闲看门狗巡检失败/)
})

test('idleSummary：空列表返回 null，超过上限折叠', () => {
  const entries = Array.from({ length: 3 }, (_, index) => ({
    task: { id: `t-${index}`, title: `T${index}` },
    idleMs: 20 * MIN,
  }))
  assert.equal(idleSummary([], {}), null)
  const text = idleSummary(entries, { max: 2, idleMinutes: 15 })
  assert.match(text, /3 个任务在 running/)
  assert.match(text, /另有 1 个任务未列出/)
  assert.match(text, /已 20 分钟无动静/)
})
