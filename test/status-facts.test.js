// 状态事实源（status-facts）：单一 caps 表、派生集合、三处历史不一致的回归。
//
// 审计 §2.3 的三处真实不一致在这里各有一条正向用例：
//   1. `RESUME_STATUS` 含 failed（工具层）vs `RESUMABLE` 不含（面板层）——现在都从能力表派生，
//      且 `resumable` 与 `followup` 是两个字段（running 能续派但不迁状态）；
//   2. 「流程终态」（无 failed）与「要释放资源的终态」（有 failed）名字几乎一样——现在叫
//      `terminal` 与 `releases`，语义各自可断言；
//   3. 面板 stop 用「不含 failed 的终态」判幂等 → 对失败任务点停止会把它改成「已取消」——
//      `stopIsIdempotent` 用 `releases`，这条用例直接锁住行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CAP_KEYS, STATUS_CAPS, STATUSES, hasCap, sourcesOf, statusesWith,
} from '../src/status-facts.js'
import {
  ACTIVE_STATUSES, DELETABLE_STATUSES, FOLLOWUP_STATUSES, RETRYABLE_STATUSES, TERMINAL_STATUSES,
  canFollowup, canDelete, followupGate, stopGate, stopIsIdempotent,
} from '../src/panel-gates.js'
import { openLedger, createTask, getTask, transition } from '../src/ledger.js'
import { createPanelActions } from '../src/panel-actions.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { tempDir, sampleBrief } from './helpers.js'

test('caps 表：10 个状态 × 全部能力字段都是布尔，无遗漏', () => {
  assert.equal(STATUSES.length, 10)
  for (const status of STATUSES) {
    assert.ok(STATUS_CAPS[status], `${status} 缺能力定义`)
    for (const key of CAP_KEYS) {
      assert.equal(typeof STATUS_CAPS[status][key], 'boolean', `${status}.${key}`)
    }
    // 多余字段（拼错的 key）会被静默忽略——这里反过来禁止，避免「写了但没生效」。
    assert.deepEqual(Object.keys(STATUS_CAPS[status]).sort(), [...CAP_KEYS].sort(), `${status} 字段集不一致`)
  }
})

test('hasCap：未知状态一律 false，不抛错', () => {
  assert.equal(hasCap('running', 'active'), true)
  assert.equal(hasCap('done', 'active'), false)
  assert.equal(hasCap('weird', 'active'), false)
  assert.equal(hasCap(undefined, 'active'), false)
  assert.equal(hasCap('running', 'nope'), false)
})

test('三处历史不一致已收敛：面板与工具的集合同源（审计 §2.3.2）', () => {
  // ① 续派集合：面板与工具都从能力表派生，不再一个含 failed 一个不含。
  assert.deepEqual([...FOLLOWUP_STATUSES], statusesWith('followup'))
  assert.equal(FOLLOWUP_STATUSES.includes('failed'), false)
  // running 能续派但不「恢复」（续派不改状态，改了会撞 running → running）。
  assert.equal(hasCap('running', 'followup'), true)
  assert.equal(hasCap('running', 'resumable'), false)
  assert.deepEqual(statusesWith('resumable'), ['waiting_user', 'waiting_auth', 'delivered'])

  // ② 「流程终态」与「要释放资源的终态」分名：failed 只在后者里。
  assert.deepEqual([...TERMINAL_STATUSES], ['done', 'cancelled', 'orphaned'])
  assert.equal(hasCap('failed', 'terminal'), false, 'failed 不是流程终态（还能重派）')
  assert.equal(hasCap('failed', 'releases'), true, 'failed 要释放可写根与 goal')
  // 但删除判据只看 deletable：失败任务可以删。
  assert.equal(DELETABLE_STATUSES.includes('failed'), true)
  assert.deepEqual([...DELETABLE_STATUSES], statusesWith('deletable'))
  assert.deepEqual([...RETRYABLE_STATUSES], ['failed', 'orphaned'])
  assert.deepEqual([...ACTIVE_STATUSES], statusesWith('active'))
})

test('③ 失败任务点「停止」是幂等成功，不再被改成「已取消」（审计 §2.3.2 第 3 条）', () => {
  // 纯函数层：failed 已收尾 → already。
  assert.equal(stopIsIdempotent({ status: 'failed' }), true)
  assert.equal(stopIsIdempotent({ status: 'orphaned' }), true)
  assert.equal(stopIsIdempotent({ status: 'done' }), true)
  assert.equal(stopIsIdempotent({ status: 'running' }), false)
  assert.equal(stopIsIdempotent({ status: 'delivered' }), false)
  assert.deepEqual(stopGate(undefined), { ok: false, already: false, reason: 'not_found' })
  assert.deepEqual(stopGate({ status: 'failed' }), { ok: true, already: true, reason: null })
})

test('③ 端到端：面板 stop 对 failed 任务返回 already:true，状态仍是 failed', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '失败的' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, task.id, 'failed', { error: '子会话异常结束' })
  const panel = createPanelActions({
    db,
    dispatcher: { async stop() { throw new Error('不该调 dispatcher.stop') } },
    queue: { remove() {}, pump() {}, position: () => 0 },
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    logger: { log() {} },
  })
  const stopped = await panel.stop(task.id)
  assert.equal(stopped.ok, true)
  assert.equal(stopped.already, true)
  assert.equal(stopped.status, 'failed')
  // 关键回归：状态没被改成 cancelled，失败信息还在。
  assert.equal(getTask(db, task.id).status, 'failed')
  db.close()
})

test('③ 端到端：工具 task_stop 对 failed 任务给「已结束」，不改状态', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '失败的' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, task.id, 'failed', { error: '子会话异常结束' })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: { async stop() { throw new Error('不该调 dispatcher.stop') } },
    queue: createQueue({ db, dispatcher: {}, config: {} }),
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    logger: { log() {} },
  }).map(tool => [tool.name, tool]))
  const text = await tools.task_stop.execute({ task_id: task.id }, { agent: { id: 's-1' } })
  assert.match(text, /已结束/)
  assert.match(text, /失败/)
  assert.equal(getTask(db, task.id).status, 'failed')
  db.close()
})

test('followupGate：failed/orphaned 各给专门 reason，不落泛化 not_followable', () => {
  assert.deepEqual(followupGate({ status: 'failed', target: 'c-1' }), { ok: false, reason: 'failed' })
  assert.deepEqual(followupGate({ status: 'orphaned', target: 'c-1' }), { ok: false, reason: 'ended' })
  assert.equal(canFollowup({ status: 'running', target: 'c-1' }), true)
  // 状态在能力表里能续派但没有子会话 → no_session（面板据此显示「无会话」而不是「不能续派」）。
  assert.deepEqual(followupGate({ status: 'running', target: null }), { ok: false, reason: 'no_session' })
})

test('deleteGate 与能力表一致：活跃不可删、失败可删', () => {
  assert.equal(canDelete({ status: 'running' }), false)
  assert.equal(canDelete({ status: 'failed' }), true)
  assert.equal(canDelete({ status: 'done' }), true)
  assert.equal(canDelete({ status: 'done' }, { activeDependents: 2 }), false)
})

test('转移表与能力表自洽：每条边都从「能续派/能推进」的状态出发', () => {
  for (const status of STATUSES) {
    if (STATUS_CAPS[status].terminal) assert.equal(STATUS_CAPS[status].followup, false)
    if (STATUS_CAPS[status].releases) assert.equal(STATUS_CAPS[status].active, false, `${status} 要释放资源，不该还算活跃`)
  }
  // 每个非入口状态都有入边。
  for (const status of STATUSES.filter(item => item !== 'waiting_dep')) {
    assert.ok(sourcesOf(status).length > 0, `${status} 没有入边`)
  }
})

test('静态断言：src/ 里不再有本地状态集合（审计 §2.3.4 的验证项）', () => {
  // 唯一允许出现状态字面量的地方是 status-facts.js（事实表）与 state.js（文案表）。
  const allowed = new Set(['status-facts.js', 'state.js', 'card.js'])
  const offenders = []
  for (const file of readdirSync(new URL('../src/', import.meta.url))) {
    if (!file.endsWith('.js') || allowed.has(file)) continue
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    // 「new Set([... 'waiting_xxx' ...])」这种本地集合一律不允许。
    const pattern = /new Set\(\[[^\]]*'waiting_(?:dep|user|auth)'[^\]]*\]\)/
    if (pattern.test(text)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `这些文件还在自己写状态集合：${offenders.join('、')}`)
})

test('静态断言：状态字面量只出现在事实表/文案表/卡片映射里', () => {
  const allowed = new Set(['status-facts.js', 'state.js', 'card.js'])
  const statuses = ['waiting_dep', 'waiting_user', 'waiting_auth', 'delivered', 'orphaned']
  const offenders = []
  for (const file of readdirSync(new URL('../src/', import.meta.url))) {
    if (!file.endsWith('.js') || allowed.has(file)) continue
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    // 只查「多个状态一起出现在同一行」的硬编码列表（单点判断如 `status === 'delivered'` 是允许的语义判断）。
    for (const line of text.split('\n')) {
      const hits = statuses.filter(status => line.includes(`'${status}'`))
      if (hits.length >= 2) offenders.push(`${file}: ${line.trim().slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], `这些位置把多个状态写在同一行：\n${offenders.join('\n')}`)
})
