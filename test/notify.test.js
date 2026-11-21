import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, addNotification } from '../src/ledger.js'
import { levelOf, createNotifier } from '../src/notify.js'
import { ADVANCE_NOTICE_HINT, PROGRESS_NOTICE_HINT } from '../src/copy.js'
import { canCreateFileSymlink, SYMLINK_SKIP_REASON, tempDir } from './helpers.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('状态到级别映射', () => {
  // progress 默认送达（0.25.x）：coalesce = 合并窗口 + 同任务水位，不再 silent。
  assert.equal(levelOf('progress'), 'coalesce')
  assert.equal(levelOf('done'), 'notify')
  assert.equal(levelOf('delivered'), 'notify')
  assert.equal(levelOf('blocked'), 'interrupt')
  assert.equal(levelOf('needs_auth'), 'interrupt')
  assert.equal(levelOf('failed'), 'notify')
  // 结算自动上报的两种异常收场也要走合并通知（不能静默）。
  assert.equal(levelOf('cancelled'), 'notify')
  assert.equal(levelOf('orphaned'), 'notify')
  assert.equal(levelOf('weird'), 'silent')
})

test('交付通知：写「已交付待确认」并带 action:close / task_message 动作指令', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 5 })
  notifier.push({ taskId: 't-close', title: '交付任务', status: 'delivered', summary: '改完了' })
  await wait(20)
  assert.match(delivered[0], /任务「交付任务」已交付待确认：改完了/)
  assert.match(delivered[0], /task_message\(\{ action: "close", task_id: 't-close' \}\)/)
  assert.match(delivered[0], /task_message 追问原会话/)
  assert.match(delivered[0], /超时自动完成/)
  // 多条合并：动作指令只在整条消息末尾写一次（这里只断言不重复刷）。
  notifier.push({ taskId: 't-a', title: 'A', status: 'delivered', summary: '一' })
  notifier.push({ taskId: 't-b', title: 'B', status: 'delivered', summary: '二' })
  await wait(20)
  assert.match(delivered[1], /2 个任务已交付待确认/)
  assert.equal(delivered[1].match(/action: "close"/g).length, 1)
})

test('推进循环：done / delivered / blocked / needs_auth 通知末尾都带动作指令，progress 不重复贴', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 5 })
  for (const [taskId, status] of [['t-d', 'done'], ['t-v', 'delivered'], ['t-b', 'blocked'], ['t-a', 'needs_auth']]) {
    notifier.push({ taskId, title: status, status, summary: '回报' })
    await wait(20)
  }
  assert.equal(delivered.length, 4)
  for (const text of delivered) {
    // 动作指令与 L1 推进循环同源（copy.js 单一真源），不是各写一套。
    assert.ok(text.includes(ADVANCE_NOTICE_HINT), `通知缺少动作指令：${text}`)
    assert.match(text, /下一步：推进 \/ 提问 \/ 宣布完成前先问新任务/)
  }
  // progress 有自己的追问指令，不重复贴通用动作指令（避免一段通知两个「下一步」）。
  notifier.push({ taskId: 't-p', title: '跑', status: 'progress', summary: '一半' })
  await wait(20)
  assert.ok(delivered[4].includes(PROGRESS_NOTICE_HINT))
  assert.equal(delivered[4].includes(ADVANCE_NOTICE_HINT), false)
  // 结算异常只报事实，不加动作指令（由 L1 推进循环约束）。
  notifier.push({ taskId: 't-x', title: 'X', status: 'cancelled', summary: '被中断' })
  await wait(20)
  assert.equal(delivered[5].includes(ADVANCE_NOTICE_HINT), false)
})

test('结算异常状态的通知文案：已取消 / 会话已结束但没有终态回报', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'cancelled', summary: '子会话被中断' })
  await wait(25)
  notifier.push({ taskId: 't-2', title: 'B', status: 'orphaned', summary: '回合结束但没报终态' })
  await wait(25)
  assert.match(delivered[0], /任务「A」已取消：子会话被中断/)
  assert.match(delivered[1], /任务「B」会话已结束但没有终态回报/)
})

test('progress 默认送达：进合并窗口后投递，文案标明「有新进展」并带追问出口', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: '长任务', status: 'progress', summary: '跑完一半' })
  // 不是 silent：它在 5 秒合并窗口里等（同一批任务并成一条），而不是被丢掉。
  assert.equal(delivered.length, 0)
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /任务「长任务」有新进展：跑完一半/)
  // 动作指令：这是信号不是终态，出口是追问同一子会话（别重派）。句子来自 src/copy.js 单一真源，
  // L1 协调者 policy 用的是同一句（test/copy-consistency.test.js 断言同源）。
  assert.ok(delivered[0].includes(PROGRESS_NOTICE_HINT))
  assert.match(delivered[0], /progress 只是进度信号、不是终态/)
  assert.match(delivered[0], /task_message 追问同一子会话/)
  assert.match(delivered[0], /别为此重派任务/)
  // progress 不写产物/交付候选：中间文件不是交付。
  assert.doesNotMatch(delivered[0], /调用 present/)
})

test('progress 与其他状态同窗口合并：一条消息里既有进展又有完成', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: '甲', status: 'progress', summary: '还在写' })
  notifier.push({ taskId: 't-2', title: '乙', status: 'done', summary: '完成了' })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /2 个任务状态更新/)
  assert.match(delivered[0], /- 甲（有新进展）：还在写/)
  assert.match(delivered[0], /- 乙：完成了/)
})

test('同任务合并窗口内的第二条 progress 覆盖前一条：只送最新，被覆盖的留审计行', async () => {
  const db = await openLedger(tempDir())
  const delivered = []
  const notifier = createNotifier({
    send: async text => delivered.push(text),
    mergeWindowMs: 25,
    record: entry => addNotification(db, entry),
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '第一步' })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '第二步' })
  await wait(50)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /第二步/)
  assert.doesNotMatch(delivered[0], /第一步/)
  const rows = db.prepare("SELECT level, status, reason FROM notifications WHERE task_id = 't-1' ORDER BY rowid").all()
  assert.deepEqual(rows.map(row => row.status), ['skipped', 'delivered'])
  // silent 时代连行都不写；现在每条 progress 都有审计行，压住/覆盖写原因。
  assert.equal(rows[0].level, 'coalesce')
  assert.equal(rows[0].reason, 'progress_merged')
  db.close()
})

test('同任务水位：窗口内第二条压住，到水位线补投最新一条（不刷屏也不丢）', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 5, progressWatermarkMs: 60 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '一' })
  await wait(20)
  assert.equal(delivered.length, 1)
  // 水位内连发两条：都压住，只留最新。
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '二' })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '三' })
  await wait(20)
  assert.equal(delivered.length, 1)
  // 到水位线（首条投递后 60ms）补投「三」——尾沿保留最新状态。
  await wait(70)
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /三/)
  assert.doesNotMatch(delivered[1], /二/)
})

test('追问必达：answeredFollowup 的 progress 立刻投递，不等合并窗口也不看水位', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 1000, progressWatermarkMs: 600_000 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '第一轮心跳' })
  await notifier.drain()
  assert.equal(delivered.length, 1)
  // 协调者刚追问过 → 这一条就是它等的答案：同步送出。
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '部分结论：PR 已开，等 CI', answeredFollowup: true })
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /有新进展（回答你的追问）：部分结论：PR 已开，等 CI/)
  // 必达只对追问后第一条生效；之后的 progress 回到水位节奏（不刷屏）。
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '第二条' })
  assert.equal(delivered.length, 2)
})

test('同任务的 progress 被同窗口的 done 取代：一条消息里不重复列同一任务', async () => {
  const db = await openLedger(tempDir())
  const delivered = []
  const notifier = createNotifier({
    send: async text => delivered.push(text),
    mergeWindowMs: 25,
    record: entry => addNotification(db, entry),
  })
  // 子会话先报进展、紧接着交付：旧 progress 不该和「已交付待确认」挤在同一条消息里（读起来像两个任务）。
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '已定位分支' })
  notifier.push({ taskId: 't-1', title: 'A', status: 'delivered', summary: '改完了' })
  await wait(50)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /^任务「A」已交付待确认：改完了/)
  assert.doesNotMatch(delivered[0], /已定位分支/)
  const rows = db.prepare("SELECT status, reason FROM notifications WHERE task_id = 't-1' ORDER BY rowid").all()
  assert.deepEqual(rows.map(row => row.status), ['skipped', 'delivered'])
  assert.equal(rows[0].reason, 'progress_superseded')
  db.close()
})

test('progress 投递失败不占水位：下一次 progress 仍照常尝试送达', async () => {
  const delivered = []
  let failing = true
  const notifier = createNotifier({
    send: async text => {
      if (failing) return false
      delivered.push(text)
      return true
    },
    mergeWindowMs: 5,
    progressWatermarkMs: 600_000,
    onWarn: () => {},
  })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '一' })
  await wait(20)
  assert.equal(delivered.length, 0)
  failing = false
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '二' })
  await wait(20)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /二/)
})

test('卸载收尾（flushNow / drain）把水位压住的 progress 一并送掉：进程要走时不留悬账', async () => {
  const delivered = []
  const notifier = createNotifier({ send: text => { delivered.push(text); return true }, mergeWindowMs: 5, progressWatermarkMs: 600_000 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '一' })
  await notifier.drain()
  assert.equal(delivered.length, 1)
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '二' })
  notifier.flushNow()
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /二/)
})

test('progress 并入合并窗口，done 批量合并，interrupt 立刻投递', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 20 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '在跑' })
  assert.equal(delivered.length, 0)
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  notifier.push({ taskId: 't-3', title: 'C', status: 'done', summary: '完成' })
  await wait(40)
  // progress 与两条 done 同窗口合并成一条（progress 不再消失，也不单独刷一条）。
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /3 个任务状态更新/)
  assert.match(delivered[0], /- A（有新进展）：在跑/)
  assert.match(delivered[0], /- B：完成/)
  assert.match(delivered[0], /- C：完成/)
  notifier.push({ taskId: 't-4', title: 'D', status: 'blocked', summary: '要授权' })
  await wait(10)
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /需要你/)
})

test('progress 与单条 done 同窗口时合并成一条（不丢 progress，也不拆成两条刷屏）', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '在跑' })
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /2 个任务状态更新/)
  assert.match(delivered[0], /- A（有新进展）：在跑/)
  assert.match(delivered[0], /- B：完成/)
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

test('只读任务通知标「只读」；普通任务不变', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: '分析', status: 'done', summary: '完成', readOnly: true })
  await wait(25)
  // 首行是任务行；推进循环的动作指令追加在末尾（见「通知带动作指令」用例）。
  assert.equal(delivered[0].split('\n')[0], '任务「分析（只读）」完成：完成')
  notifier.push({ taskId: 't-2', title: '修复', status: 'done', summary: '完成' })
  await wait(25)
  assert.equal(delivered[1].split('\n')[0], '任务「修复」完成：完成')
})

test('完整访问任务通知标「完整访问」；只读优先、普通任务不变', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: '构建', status: 'done', summary: '打好了', access: 'full' })
  await wait(25)
  assert.equal(delivered[0].split('\n')[0], '任务「构建（完整访问）」完成：打好了')
  // 只读标记压过 access（互斥兜底：正常运行期不会同时出现）。
  notifier.push({ taskId: 't-2', title: '分析', status: 'done', summary: '完成', readOnly: true, access: 'full' })
  await wait(25)
  assert.equal(delivered[1].split('\n')[0], '任务「分析（只读）」完成：完成')
  notifier.push({ taskId: 't-3', title: '修复', status: 'done', summary: '完成', access: null })
  await wait(25)
  assert.equal(delivered[2].split('\n')[0], '任务「修复」完成：完成')
})

test('显示名优先：用 item.displayName，不裸露 t-xxx', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-aaaa1111', title: '同名', displayName: '同名（aaaa）', status: 'done', summary: '完成' })
  await wait(25)
  assert.equal(delivered[0].split('\n')[0], '任务「同名（aaaa）」完成：完成')
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


// P6 / T6.1：通知里的产物必须「可交付 + 带交付指令」。判据跟平台 present 一致
// （lstat 判 type：目录 / 符号链接 / 不存在都拒），所以用真实临时文件验证，不用假路径。
const fileIn = (dir, name, content = 'x') => {
  const path = join(dir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

test('产物随 done 通知列出可交付的绝对路径，并带 present 交付指令', async () => {
  const dir = tempDir()
  const report = fileIn(dir, 'report.md', '# ok')
  const missing = join(dir, 'missing.txt')
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({
    taskId: 't-1', title: 'A', status: 'done', summary: '完成',
    artifacts: [
      { path: report, label: '报告', exists: true },
      { path: missing, label: '', exists: false },
    ],
  })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /产物：/)
  assert.ok(delivered[0].includes(`- ${report} — 报告`))
  // 交付指令：明确让人在自己回合里调 present，参数是上面这些绝对路径，且已 stat 校验。
  assert.match(delivered[0], /交付：在你自己的回合里调用 present/)
  assert.match(delivered[0], /files 里每项 path 填上面这些绝对路径/)
  assert.match(delivered[0], /最多 4 个/)
  assert.match(delivered[0], /插件已 stat 校验存在且是普通文件，不要另找路径/)
  // 不存在的路径不能进候选，只计数。
  assert.equal(delivered[0].includes(`- ${missing}`), false)
  assert.match(delivered[0], /另有 1 条产物不能交付（不存在 1）/)
})

test('目录不进交付候选：present 只收普通文件', async () => {
  const dir = tempDir()
  const dist = join(dir, 'dist')
  mkdirSync(dist)
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({
    taskId: 't-1', title: 'A', status: 'done', summary: '完成',
    artifacts: [{ path: dist, label: '构建目录', exists: true }],
  })
  await wait(25)
  assert.equal(delivered[0].includes(`- ${dist}`), false)
  assert.match(delivered[0], /产物：没有可直接交付的普通文件/)
  assert.match(delivered[0], /另有 1 条产物不能交付（目录 1）/)
  // 一条可交付候选都没有时，不写交付指令（写了只会诱发一次必然失败的 present）。
  assert.doesNotMatch(delivered[0], /调用 present/)
})

test('链接不进交付候选：present 用 lstat 判 type，符号链接/目录联接同样被拒', async t => {
  const dir = tempDir()
  const realDir = join(dir, 'real')
  mkdirSync(realDir)
  const file = fileIn(dir, 'a.md')
  const link = join(dir, 'link')
  let kind
  if (canCreateFileSymlink()) {
    // 优先造**真文件符号链接**：lstat 必报 symlink，判据无歧义（Linux/CI、开了开发者模式的 Windows 走这条）。
    symlinkSync(file, link)
    kind = 'symlink'
  } else {
    // 没有文件链接权限时退到**目录联接**（junction 不需要特权）。这里必须按**实测类型**断言：
    // 部分 Windows/Node 组合下 lstat 对 junction 报 isSymbolicLink()=true，另一些直接报 isDirectory()=true
    // ——宿主类型表不同，但「链接不能当普通文件交付」这条不变量两种情况都成立，所以不弱化断言，
    // 只是把期望文案钉在实测类型上（既不能两种都放过，也不能把环境差异判成用例失败）。
    try {
      symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return t.skip(SYMLINK_SKIP_REASON)
    }
    const stats = lstatSync(link)
    if (stats.isSymbolicLink()) kind = 'symlink'
    else if (stats.isDirectory()) kind = 'directory'
    else return t.skip(`${SYMLINK_SKIP_REASON}（本机 lstat 把这条链接既不当链接也不当目录，无法确定期望文案）`)
  }
  const skippedLabel = kind === 'symlink' ? '符号链接 1' : '目录 1'
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({
    taskId: 't-1', title: 'A', status: 'done', summary: '完成',
    artifacts: [{ path: link }, { path: file }],
  })
  await wait(25)
  assert.equal(delivered[0].includes(`- ${link}`), false)
  assert.ok(delivered[0].includes(`- ${file}`))
  assert.match(delivered[0], new RegExp(`另有 1 条产物不能交付（${skippedLabel}）`))
})

test('相对路径不进交付候选：协调者的 cwd 不是任务目录', async () => {
  const dir = tempDir()
  fileIn(dir, 'a.md')
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成', artifacts: [{ path: 'a.md' }] })
  await wait(25)
  assert.match(delivered[0], /产物：没有可直接交付的普通文件/)
  assert.match(delivered[0], /另有 1 条产物不能交付（非绝对路径 1）/)
})

test('交付候选最多 4 个，其余折叠成「另有 N 条产物未列出」', async () => {
  const dir = tempDir()
  const files = Array.from({ length: 6 }, (_, index) => fileIn(dir, `out-${index}.md`))
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({
    taskId: 't-1', title: 'A', status: 'done', summary: '完成',
    artifacts: files.map(path => ({ path })), artifactsTruncated: 2,
  })
  await wait(25)
  for (const path of files.slice(0, 4)) assert.ok(delivered[0].includes(`- ${path}`))
  for (const path of files.slice(4)) assert.equal(delivered[0].includes(`- ${path}`), false)
  // 2 条超上限（6 个候选只列 4 个）+ 2 条台账层截断 = 4 条未列出。
  assert.match(delivered[0], /另有 4 条产物未列出/)
})

test('blocked / needs_auth 通知同样带交付指令与绝对路径', async () => {
  const dir = tempDir()
  const report = fileIn(dir, 'plan.md')
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  for (const status of ['blocked', 'needs_auth']) {
    notifier.push({
      taskId: `t-${status}`, title: status, status, summary: '需要你定',
      question: '选一个方案', options: ['A', 'B'],
      artifacts: [{ path: report, label: '计划' }],
    })
  }
  await wait(10)
  assert.equal(delivered.length, 2)
  for (const text of delivered) {
    assert.match(text, /需要你/)
    assert.ok(text.includes(`- ${report} — 计划`))
    assert.match(text, /交付：在你自己的回合里调用 present/)
  }
})

test('多条任务合并的通知只写一次交付指令', async () => {
  const dir = tempDir()
  const a = fileIn(dir, 'a.md')
  const b = fileIn(dir, 'b.md')
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成', artifacts: [{ path: a, label: '甲' }] })
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成', artifacts: [{ path: b, label: '乙' }] })
  await wait(25)
  assert.equal(delivered.length, 1)
  assert.ok(delivered[0].includes(`- ${a} — 甲`))
  assert.ok(delivered[0].includes(`- ${b} — 乙`))
  assert.equal((delivered[0].match(/调用 present/g) ?? []).length, 1)
})

test('产物被截断时通知追加「另有 N 条产物未列出」', async () => {
  const dir = tempDir()
  const report = fileIn(dir, 'a.md')
  const delivered = []
  const notifier = createNotifier({ send: async message => delivered.push(message), mergeWindowMs: 10 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'done', summary: '完成', artifacts: [{ path: report, label: '甲' }], artifactsTruncated: 5 })
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

test('summary：多条任务共用一条文案，notifications 按任务逐条落库', async () => {
  const db = await openLedger(tempDir())
  const delivered = []
  const notifier = createNotifier({
    send: async text => delivered.push(text),
    mergeWindowMs: 1000,
    record: entry => addNotification(db, entry),
  })
  const outcome = await notifier.summary([
    { taskId: 't-1', title: 'A', status: 'orphaned', summary: '启动对账', system: true },
    { taskId: 't-2', title: 'B', status: 'orphaned', summary: '启动对账', system: true },
  ], '启动对账：2 个任务在跑，但子会话已不活跃')
  assert.equal(outcome.delivered, true)
  assert.deepEqual(delivered, ['启动对账：2 个任务在跑，但子会话已不活跃'])
  const rows = db.prepare('SELECT task_id, level, status FROM notifications ORDER BY rowid').all()
  assert.deepEqual(rows.map(row => row.task_id), ['t-1', 't-2'])
  assert.ok(rows.every(row => row.level === 'notify' && row.status === 'delivered'))
  db.close()
})

test('summary：跳过/失败返回 delivered:false，并落 skipped/failed', async () => {
  const db = await openLedger(tempDir())
  const notifier = createNotifier({
    send: () => ({ skipped: true, reason: '主会话未加载' }),
    record: entry => addNotification(db, entry),
  })
  const outcome = notifier.summary([{ taskId: 't-1', status: 'orphaned' }], '启动对账：1 个任务')
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.reason, '主会话未加载')
  const row = db.prepare('SELECT status, reason FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.match(row.reason, /主会话未加载/)

  const throwing = createNotifier({
    send: () => { throw new Error('steer 失败') },
    record: entry => addNotification(db, entry),
    onWarn: () => {},
  })
  assert.equal(throwing.summary([{ taskId: 't-2', status: 'orphaned' }], 'x').delivered, false)
  const failed = db.prepare('SELECT status, reason FROM notifications ORDER BY rowid DESC LIMIT 1').get()
  assert.equal(failed.status, 'failed')
  assert.match(failed.reason, /steer 失败/)
  db.close()
})

test('summary：空列表或空文案不投递', () => {
  const delivered = []
  const notifier = createNotifier({ send: text => delivered.push(text), mergeWindowMs: 10 })
  assert.deepEqual(notifier.summary([], 'x'), { delivered: false, reason: 'empty' })
  assert.deepEqual(notifier.summary([{ taskId: 't-1' }], '  '), { delivered: false, reason: 'empty' })
  assert.deepEqual(delivered, [])
})

