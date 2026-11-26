// 0.36.0 多协调者（用户拍板决策 1）：单任务通知按 item 投给**派它的那个协调者**；
// 汇总/系统类通知固定投主协调者；目标由 index.js 的 send 解析（这里锁 notify 层的分组与透传）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/notify.js'

const taskItem = (id, coordinator, status = 'done', summary = '好了') => ({
  taskId: id,
  title: id,
  displayName: id,
  ref: `tk-${id}`,
  status,
  summary,
  coordinatorSession: coordinator,
})

const fakeSend = () => {
  const calls = []
  return {
    calls,
    send: async (text, items, target) => {
      calls.push({ text, ids: items.map(item => item.taskId), target })
      return { delivered: true }
    },
  }
}

const targetOf = item => item?.coordinatorSession

test('notify 路由：同一批里两个协调者的任务 → 两条消息，各自投给对应会话', async () => {
  const { calls, send } = fakeSend()
  const notifier = createNotifier({ send, targetOf, mergeWindowMs: 0 })
  notifier.push(taskItem('t-a1', 's-a'))
  notifier.push(taskItem('t-b1', 's-b'))
  await notifier.drain()
  assert.equal(calls.length, 2, '两个目标 → 两条独立消息（不再合并成一条发给主协调者）')
  const byTarget = new Map(calls.map(call => [call.target, call]))
  assert.deepEqual(byTarget.get('s-a').ids, ['t-a1'])
  assert.deepEqual(byTarget.get('s-b').ids, ['t-b1'])
  assert.match(byTarget.get('s-a').text, /t-a1/)
  assert.doesNotMatch(byTarget.get('s-a').text, /t-b1/, '不能把别人的任务串进这条消息')
})

test('notify 路由：同一协调者的多任务仍合并成一条（合并窗口语义不变）', async () => {
  const { calls, send } = fakeSend()
  const notifier = createNotifier({ send, targetOf, mergeWindowMs: 0 })
  notifier.push(taskItem('t-a1', 's-a'))
  notifier.push(taskItem('t-a2', 's-a'))
  await notifier.drain()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].ids, ['t-a1', 't-a2'])
  assert.equal(calls[0].target, 's-a')
})

test('notify 路由：没有 coordinatorSession / targetOf 抛错 / 未注入 → target 为 undefined（= 主协调者兜底）', async () => {
  const { calls, send } = fakeSend()
  const notifier = createNotifier({
    send,
    targetOf: item => {
      if (item.taskId === 't-boom') throw new Error('boom')
      return item.coordinatorSession
    },
    mergeWindowMs: 0,
  })
  notifier.push(taskItem('t-nobody', undefined))
  notifier.push(taskItem('t-boom', 's-x'))
  await notifier.drain()
  assert.equal(calls.length, 1, '两个「取不到目标」的任务落进同一个兜底组，合并成一条')
  assert.equal(calls[0].target, undefined, '取不到目标一律回落主协调者，不丢通知')
  assert.deepEqual(calls[0].ids, ['t-nobody', 't-boom'])

  const bare = fakeSend()
  const noTarget = createNotifier({ send: bare.send, mergeWindowMs: 0 })
  noTarget.push(taskItem('t-a1', 's-a'))
  await noTarget.drain()
  assert.equal(bare.calls.length, 1)
  assert.equal(bare.calls[0].target, undefined, '未注入 targetOf 时行为与旧版一致')
})

test('notify 路由：打断级（blocked）也按任务协调者投递', async () => {
  const { calls, send } = fakeSend()
  const notifier = createNotifier({ send, targetOf, mergeWindowMs: 0 })
  notifier.push(taskItem('t-blocked', 's-b', 'blocked', '需要决定'))
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 's-b')
  assert.match(calls[0].text, /需要你/)
})

test('notify 路由：汇总通知（summary）固定投主协调者（target undefined），不按任务拆', async () => {
  const { calls, send } = fakeSend()
  const notifier = createNotifier({ send, targetOf, mergeWindowMs: 0 })
  const outcome = await notifier.summary([taskItem('t-a1', 's-a'), taskItem('t-b1', 's-b')], '启动对账：2 个任务会话丢失')
  assert.equal(outcome?.delivered, true, '异步 send 成功 → { delivered: true }')
  assert.equal(calls.length, 1, '汇总只投一次')
  assert.equal(calls[0].target, undefined)
  assert.deepEqual(calls[0].ids, ['t-a1', 't-b1'])
})

test('notify 路由：某个目标投递失败不影响另一个目标的落库与投递', async () => {
  const records = []
  const calls = []
  const notifier = createNotifier({
    send: async (text, items, target) => {
      calls.push({ target, ids: items.map(item => item.taskId) })
      if (target === 's-b') throw new Error('s-b 掉线')
      return { delivered: true }
    },
    record: entry => records.push(entry),
    targetOf,
    mergeWindowMs: 0,
    onWarn: () => {},
  })
  notifier.push(taskItem('t-a1', 's-a'))
  notifier.push(taskItem('t-b1', 's-b'))
  const outcome = await notifier.drain()
  // flush 的分组投递：a 成功、b 失败 → 聚合 delivered=false，但两条都各有投递尝试与审计行。
  assert.equal(calls.length, 2)
  const b1 = records.find(entry => entry.taskId === 't-b1')
  const a1 = records.find(entry => entry.taskId === 't-a1')
  assert.equal(b1.status, 'failed')
  assert.equal(a1.status, 'delivered')
  // drain() 的返回值由宿主兜底，不承诺形状；这里只锁「a 没被 b 的失败连坐」。
  void outcome
})
