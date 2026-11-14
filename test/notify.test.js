import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, addNotification } from '../src/ledger.js'
import { levelOf, createNotifier } from '../src/notify.js'
import { tempDir } from './helpers.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('状态到级别映射', () => {
  assert.equal(levelOf('progress'), 'silent')
  assert.equal(levelOf('done'), 'notify')
  assert.equal(levelOf('blocked'), 'interrupt')
  assert.equal(levelOf('needs_auth'), 'interrupt')
  assert.equal(levelOf('failed'), 'notify')
  assert.equal(levelOf('weird'), 'silent')
})

test('silent 不投递，notify 合并，interrupt 立刻投递', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 20 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '在跑' })
  assert.equal(delivered.length, 0)
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  notifier.push({ taskId: 't-3', title: 'C', status: 'done', summary: '完成' })
  await wait(40)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /2 个任务完成/)
  notifier.push({ taskId: 't-4', title: 'D', status: 'blocked', summary: '要授权' })
  await wait(10)
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /需要你/)
})

test('单条 done 文案与进度不计入合并', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '在跑' })
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  await wait(25)
  assert.deepEqual(delivered, ['任务「B」完成：完成'])
})

test('合并窗口外再投一条', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '一' })
  await wait(25)
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '二' })
  await wait(25)
  assert.equal(delivered.length, 2)
})

test('显示名优先：用 item.displayName，不裸露 t-xxx', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-aaaa1111', title: '同名', displayName: '同名（aaaa）', status: 'done', summary: '完成' })
  await wait(25)
  assert.deepEqual(delivered, ['任务「同名（aaaa）」完成：完成'])
  assert.doesNotMatch(delivered[0], /t-[0-9a-f]{8}/)
})

test('多任务合并行也用 displayName', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: '甲', displayName: '甲（0001）', status: 'done', summary: '一' })
  notifier.push({ taskId: 't-2', title: '乙', displayName: '乙', status: 'done', summary: '二' })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /- 甲（0001）：一/)
  assert.match(delivered[0], /- 乙：二/)
})

test('blocked 立即投递且不影响已排队的 done 合并', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 30 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  notifier.push({ taskId: 't-2', title: 'B', status: 'blocked', summary: '卡住' })
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /需要你/)
  await wait(50)
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /任务「A」完成/)
})

test('send 抛错走 onWarn，不产生未处理的 rejection', async () => {
  const warnings = []
  const notifier = createNotifier({
    mergeWindowMs: 10,
    send: async () => { throw new Error('网络断了') },
    onWarn: message => warnings.push(message),
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  await wait(25)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /网络断了/)
})

test('drain 立即 flush 且空 buffer 不投递', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 1000 })
  await notifier.drain()
  assert.equal(delivered.length, 0)
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  await notifier.drain()
  assert.equal(delivered.length, 1)
})

test('通知成功与失败都落 notifications，合并填 merged_into', async () => {
  const db = await openLedger(tempDir())
  const rows = []
  const notifier = createNotifier({
    mergeWindowMs: 10,
    send: async () => { /* 成功 */ },
    record: entry => rows.push(addNotification(db, entry)),
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  await wait(25)
  const all = db.prepare('SELECT task_id, level, status, delivered_at, merged_into FROM notifications ORDER BY rowid').all()
  assert.equal(all.length, 2)
  assert.equal(all[0].status, 'delivered')
  assert.ok(all[0].delivered_at > 0)
  assert.equal(all[0].merged_into, null)
  assert.equal(all[1].merged_into, rows[0])
  db.close()
})

test('send 返回 false 时落 skipped 而不是 delivered', async () => {
  const db = await openLedger(tempDir())
  const notifier = createNotifier({
    mergeWindowMs: 5,
    send: async () => false,
    record: entry => addNotification(db, entry),
    onWarn: () => {},
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  await wait(20)
  const row = db.prepare('SELECT status, delivered_at FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.equal(row.delivered_at, null)
  db.close()
})

test('send 返回 skipped 时落 skipped + reason', async () => {
  const db = await openLedger(tempDir())
  const notifier = createNotifier({
    mergeWindowMs: 5,
    send: () => ({ skipped: true, reason: '协调者会话已失效' }),
    record: entry => addNotification(db, entry),
    onWarn: () => {},
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const row = db.prepare('SELECT status, delivered_at, reason FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.equal(row.delivered_at, null)
  assert.match(row.reason, /协调者会话已失效/)
  db.close()
})

test('投递失败落一条 failed 记录，delivered_at 为空', async () => {
  const db = await openLedger(tempDir())
  const notifier = createNotifier({
    mergeWindowMs: 5,
    send: async () => { throw new Error('投递失败') },
    record: entry => addNotification(db, entry),
    onWarn: () => {},
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成' })
  await wait(20)
  const row = db.prepare('SELECT status, delivered_at, reason FROM notifications').get()
  assert.equal(row.status, 'failed')
  assert.equal(row.delivered_at, null)
  assert.match(row.reason, /投递失败/)
  db.close()
})


test('产物随 done 通知列出绝对路径、说明与未找到', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({
    taskId: 't-1', title: 'A', status: 'done', summary: '完成',
    artifacts: [
      { path: 'C:/work/report.md', label: '报告', exists: true },
      { path: 'C:/work/missing.txt', label: '', exists: false },
    ],
  })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /产物：/)
  assert.match(delivered[0], /C:\/work\/report\.md — 报告/)
  assert.match(delivered[0], /C:\/work\/missing\.txt（未找到）/)
})

test('合并窗口内多条 report 的产物各自保留，不互相覆盖', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成', artifacts: [{ path: 'C:/a.txt', label: '甲', exists: true }] })
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成', artifacts: [{ path: 'C:/b.txt', label: '乙', exists: true }] })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /C:\/a\.txt — 甲/)
  assert.match(delivered[0], /C:\/b\.txt — 乙/)
})


test('产物被截断时通知追加「另有 N 条产物未列出」', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成', artifacts: [{ path: 'C:/a.txt', label: '甲', exists: true }], artifactsTruncated: 5 })
  await wait(25)
  assert.match(delivered[0], /另有 5 条产物未列出/)
})


test('失败任务的通知文案是「失败」而不是「完成」', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'failed', summary: '子会话创建失败：boom' })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0], '任务「A」失败：子会话创建失败：boom')
})
