import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_STATUSES, TERMINAL_STATUSES, FOLLOWUP_STATUSES, DELETABLE_STATUSES, CLOSABLE_STATUSES,
  followupGate, canFollowup, closeGate, canClose, deleteGate, canDelete,
} from '../src/panel-gates.js'

// 面板按钮的显示与后端动作的接受必须是同一判定（前后端同源）：
// 这里把判定本身钉死，client 只消费快照/detail 下发的 canFollowup / canDelete。
const task = (status, extra = {}) => ({ id: `t-${status}`, status, target: `c-${status}`, ...extra })

test('收集中关闭/删除始终拒绝，包括停止后的终态；空 pending 不误拦', () => {
  for (const status of ['running', 'delivered', 'done', 'cancelled', 'failed', 'orphaned']) {
    assert.equal(closeGate(task(status, { delivery_pending: {} })).reason, 'collecting')
    assert.equal(deleteGate(task(status, { delivery_pending: {} })).reason, 'collecting')
  }
  assert.equal(closeGate(task('delivered', { delivery_pending: null })).ok, true)
  assert.equal(deleteGate(task('cancelled', { delivery_pending: null })).ok, true)
})

test('续派门控：只有进行中/等你确认/要授权/待确认，且已有子会话才可续派', () => {
  for (const status of ['running', 'waiting_user', 'waiting_auth', 'delivered']) {
    assert.equal(canFollowup(task(status)), true, status)
    assert.deepEqual({ ...followupGate(task(status)) }, { ok: true, reason: null })
  }
  for (const status of ['waiting_dep', 'pending', 'done', 'failed', 'cancelled', 'orphaned']) {
    assert.equal(canFollowup(task(status)), false, status)
  }
  // 有状态但还没派发出子会话：没有可投递的目标，不能续派。
  assert.equal(canFollowup(task('running', { target: null })), false)
  assert.equal(canFollowup(undefined), false)
})

test('续派门控原因：终态/等前置/排队/无会话/失败各有可映射的 reason', () => {
  assert.equal(followupGate(task('done')).reason, 'ended')
  assert.equal(followupGate(task('cancelled')).reason, 'ended')
  assert.equal(followupGate(task('orphaned')).reason, 'ended')
  assert.equal(followupGate(task('waiting_dep')).reason, 'waiting_dep')
  assert.equal(followupGate(task('pending', { target: null, queued_at: 1 })).reason, 'queued')
  assert.equal(followupGate(task('pending', { target: null })).reason, 'no_session')
  assert.equal(followupGate(task('pending')).reason, 'pending')
  assert.equal(followupGate(task('running', { target: null })).reason, 'no_session')
  // 失败任务走「重派」，不再给续派（旧面板既能追加又能重派，语义重复）。
  assert.equal(followupGate(task('failed')).reason, 'failed')
  assert.equal(followupGate(task('weird')).reason, 'not_followable')
  assert.equal(followupGate(undefined).reason, 'not_found')
})

test('删除门控：只有终态可删，活跃任务一律不能删', () => {
  for (const status of ['done', 'failed', 'cancelled', 'orphaned']) {
    assert.equal(canDelete(task(status)), true, status)
    assert.deepEqual({ ...deleteGate(task(status)) }, { ok: true, reason: null })
  }
  for (const status of ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered']) {
    assert.equal(canDelete(task(status)), false, status)
    assert.equal(deleteGate(task(status)).reason, 'active')
  }
  assert.equal(canDelete(undefined), false)
  assert.equal(deleteGate(undefined).reason, 'not_found')
  // 未知状态不猜：按「不是终态」拒绝，宁可少一个删除按钮。
  assert.equal(deleteGate(task('weird')).reason, 'not_terminal')
  // 终态但有活跃下游依赖：也不给删（删了前置，下游会变缺前置直接失败）。
  assert.equal(canDelete(task('done'), { activeDependents: 1 }), false)
  assert.equal(deleteGate(task('done'), { activeDependents: 2 }).reason, 'has_dependents')
  assert.equal(canDelete(task('done'), { activeDependents: 0 }), true)
})

test('确认交付门控：只有待确认（delivered）能收成 done，done 重复确认按幂等放行', () => {
  assert.deepEqual({ ...closeGate(task('delivered')) }, { ok: true, reason: null })
  assert.equal(canClose(task('delivered')), true)
  // 已 done 的重复确认交给 closeDelivered 幂等返回（按钮不显示，但状态不报错）。
  assert.equal(canClose(task('done')), true)
  for (const status of ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'failed', 'cancelled', 'orphaned']) {
    assert.equal(canClose(task(status)), false, status)
    assert.equal(closeGate(task(status)).reason, 'not_delivered', status)
  }
  assert.equal(canClose(undefined), false)
  assert.equal(closeGate(undefined).reason, 'not_found')
})

test('门控状态集合与台账口径一致（活跃 6 个 / 终态 3 个 / 可续派 4 个 / 可确认 1 个 / 可删 4 个）', () => {
  assert.deepEqual([...ACTIVE_STATUSES], ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered'])
  assert.deepEqual([...TERMINAL_STATUSES], ['done', 'cancelled', 'orphaned'])
  assert.deepEqual([...FOLLOWUP_STATUSES], ['running', 'waiting_user', 'waiting_auth', 'delivered'])
  assert.deepEqual([...CLOSABLE_STATUSES], ['delivered'])
  assert.deepEqual([...DELETABLE_STATUSES], ['done', 'failed', 'cancelled', 'orphaned'])
})
