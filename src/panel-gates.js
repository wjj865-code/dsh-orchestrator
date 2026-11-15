// 面板动作门控：续派（追加消息）、确认交付（task_close）与删除任务/子会话。
//
// 为什么要单独一个模块：按钮「显示不显示」和动作「接不接」必须是同一判定，
// 否则会出现「按钮在、点了 409」或「接口能收、按钮不给」的分叉。
// 这里只放纯函数 + 状态集合，不碰台账/队列：
//   - panel-actions.js / tools.js 用 followupGate / closeGate / deleteGate 做服务端门控；
//   - host-route.js 把 canFollowup / canClose / canDelete 随 snapshot、detail 一起下发；
//   - client.js 只读下发字段渲染按钮，不再自己抄一份状态表。
//
// 状态口径与台账一致（见 src/state.js 与 ledger.listTasks）：
//   - 活跃 = waiting_dep / pending / running / waiting_user / waiting_auth / delivered
//   - 终态 = done / cancelled / orphaned；failed 单独一类（可重派、可删，不再续派）
import { ACTIVE_STATUSES as _ACTIVE } from './state.js'

/** 台账里「活跃」任务的状态（不落终态、还在跑/排队/等人/待确认）。 */
export const ACTIVE_STATUSES = Object.freeze([..._ACTIVE])

/** 流程终态：done / cancelled / orphaned（failed 不在内，它还能重派）。 */
export const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled', 'orphaned'])

/** 支持续派（追加消息）的状态：必须有活着的子会话可投递；delivered 是「追问」窗口。 */
export const FOLLOWUP_STATUSES = Object.freeze(['running', 'waiting_user', 'waiting_auth', 'delivered'])

/** 支持确认交付（收成 done）的状态：只有「已交付待确认」。 */
export const CLOSABLE_STATUSES = Object.freeze(['delivered'])

/** 支持删除的状态：所有终态（含 failed —— 失败任务用重派或删除收尾）。 */
export const DELETABLE_STATUSES = Object.freeze(['done', 'failed', 'cancelled', 'orphaned'])

const ACTIVE = new Set(ACTIVE_STATUSES)
const TERMINAL = new Set(TERMINAL_STATUSES)
const FOLLOWUP = new Set(FOLLOWUP_STATUSES)
const CLOSABLE = new Set(CLOSABLE_STATUSES)
const DELETABLE = new Set(DELETABLE_STATUSES)

const statusOf = task => String(task?.status ?? '')
const hasTarget = task => task?.target !== null && task?.target !== undefined && task?.target !== ''

/**
 * 续派门控。
 * @returns {{ok: boolean, reason: null|'not_found'|'ended'|'waiting_dep'|'queued'|'pending'|'no_session'|'failed'|'not_followable'}}
 *   reason 供两个通道映射各自的错误码/文案；ok 为 true 时 reason 恒为 null。
 */
export function followupGate(task) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  const status = statusOf(task)
  if (TERMINAL.has(status)) return { ok: false, reason: 'ended' }
  if (status === 'waiting_dep') return { ok: false, reason: 'waiting_dep' }
  if (status === 'pending') {
    // 排队中（queued_at 非空）与「刚建还没派发」分开提示：工具层有排队文案，面板统一按无会话处理。
    if (hasTarget(task)) return { ok: false, reason: 'pending' }
    return { ok: false, reason: task?.queued_at === null || task?.queued_at === undefined ? 'no_session' : 'queued' }
  }
  if (status === 'failed') return { ok: false, reason: 'failed' }
  if (!FOLLOWUP.has(status)) return { ok: false, reason: 'not_followable' }
  if (!hasTarget(task)) return { ok: false, reason: 'no_session' }
  return { ok: true, reason: null }
}

export const canFollowup = task => followupGate(task).ok

/**
 * 确认交付门控：只有 delivered（已交付待确认）能收成 done。
 * 与工具 task_close 同源；已 done 的重复确认按幂等成功处理（closeDelivered 内部判断）。
 * @returns {{ok: boolean, reason: null|'not_found'|'not_delivered'}}
 */
export function closeGate(task) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  if (statusOf(task) === 'done') return { ok: true, reason: null }
  if (!CLOSABLE.has(statusOf(task))) return { ok: false, reason: 'not_delivered' }
  return { ok: true, reason: null }
}

export const canClose = task => closeGate(task).ok

/**
 * 删除门控：只有终态能删；活跃任务必须先 task_stop/面板「停止」；
 * 有活跃下游依赖时也不能删（删了前置，下游会按「前置不存在」直接失败，见 deps.js）。
 * @param {{activeDependents?: number}} context 活跃下游数量（snapshot/detail/动作各自现算后传入）
 * @returns {{ok: boolean, reason: null|'not_found'|'active'|'not_terminal'|'has_dependents'}}
 */
export function deleteGate(task, { activeDependents = 0 } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  const status = statusOf(task)
  if (ACTIVE.has(status)) return { ok: false, reason: 'active' }
  if (!DELETABLE.has(status)) return { ok: false, reason: 'not_terminal' }
  if (Number.isFinite(activeDependents) && activeDependents > 0) return { ok: false, reason: 'has_dependents' }
  return { ok: true, reason: null }
}

export const canDelete = (task, context) => deleteGate(task, context).ok
