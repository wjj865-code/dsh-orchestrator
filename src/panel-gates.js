// 面板动作门控：续派（追加消息）、确认交付（task_message action:close）与删除任务/子会话。
//
// 为什么要单独一个模块：按钮「显示不显示」和动作「接不接」必须是同一判定，
// 否则会出现「按钮在、点了 409」或「接口能收、按钮不给」的分叉。
// 这里只放纯函数 + 状态集合，不碰台账/队列：
//   - panel-actions.js / tools.js 用 followupGate / closeGate / deleteGate 做服务端门控；
//   - host-route.js 把 canFollowup / canClose / canDelete 随 snapshot、detail 一起下发；
//   - client.js 只读下发字段渲染按钮，不再自己抄一份状态表。
//
// 状态口径一律从 `src/status-facts.js` 派生（唯一事实源）：本模块不再自己写状态集合，
// 否则「面板能不能点」与「工具接不接」会各自漂移（审计 §2.3 的三处真实不一致就出在这里）。
// 导出名保持不变（面板快照/客户端/测试都按这些名字取），只是内容改成派生结果。
import {
  STATUSES, hasCap, sourcesOf, statusesWith,
} from './status-facts.js'

/** 台账里「活跃」任务的状态（不落终态、还在跑/排队/等人/待确认）。 */
export const ACTIVE_STATUSES = Object.freeze(statusesWith('active'))

/**
 * 流程终态：done / cancelled / orphaned。
 *
 * `failed` **刻意不在内**：它还能重派，用户视角不是「流程走完」。但它照样能删、要释放资源——
 * 那是另外两个能力（`deletable` / `releases`），别再拿这份集合当「能不能删」的判据
 * （0.19.x 的面板 stop 就这么错过一次，见下面 `stopIsIdempotent`）。
 */
export const TERMINAL_STATUSES = Object.freeze(statusesWith('terminal'))

/** 支持续派（追加消息）的状态：必须有活着的子会话可投递；delivered 是「追问」窗口。 */
export const FOLLOWUP_STATUSES = Object.freeze(statusesWith('followup'))

/** 支持确认交付（收成 done）的状态：只有「已交付待确认」。 */
// 「能确认交付」= 只有 delivered（`terminal` 能力里唯一还没收尾的那个）。它是单元素集合，
// 但从能力表反查会得到空集（delivered 不 terminal），所以这里显式写——语义上它是「流程约定」而非状态能力。
export const CLOSABLE_STATUSES = Object.freeze(['delivered'])

/** 支持删除的状态：done / failed / cancelled / orphaned（失败任务用重派或删除收尾）。 */
export const DELETABLE_STATUSES = Object.freeze(statusesWith('deletable'))

/** 支持重派的状态：failed / orphaned。 */
export const RETRYABLE_STATUSES = Object.freeze(statusesWith('retryable'))

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
  if (task.delivery_pending) return { ok: false, reason: 'not_followable' }
  if (TERMINAL.has(status)) return { ok: false, reason: 'ended' }
  if (status === 'waiting_dep') return { ok: false, reason: 'waiting_dep' }
  if (status === 'pending') {
    // 排队中（queued_at 非空）与「刚建还没派发」分开提示：工具层有排队文案，面板统一按无会话处理。
    if (hasTarget(task)) return { ok: false, reason: 'pending' }
    return { ok: false, reason: task?.queued_at === null || task?.queued_at === undefined ? 'no_session' : 'queued' }
  }
  // failed / orphaned 等「不可续派」的收尾态：给专门的 reason，别落到泛化的 not_followable
  // （0.19.x 这里有一行 `if (status === 'failed')` 分支，但它是**不可达**的——followup 能力表
  // 本来就不含 failed。现在改成从能力表反查，分支与事实不可能再对不上）。
  if (!FOLLOWUP.has(status)) {
    return { ok: false, reason: status === 'failed' ? 'failed' : 'not_followable' }
  }
  if (!hasTarget(task)) return { ok: false, reason: 'no_session' }
  return { ok: true, reason: null }
}

export const canFollowup = task => followupGate(task).ok

/**
 * 确认交付门控：只有 delivered（已交付待确认）能收成 done。
 * 与工具 task_message action:close 同源；已 done 的重复确认按幂等成功处理（closeDelivered 内部判断）。
 * @returns {{ok: boolean, reason: null|'not_found'|'not_delivered'}}
 */
export function closeGate(task) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  if (task.delivery_pending) return { ok: false, reason: 'collecting' }
  if (statusOf(task) === 'done') return { ok: true, reason: null }
  if (!CLOSABLE.has(statusOf(task))) return { ok: false, reason: 'not_delivered' }
  return { ok: true, reason: null }
}

export const canClose = task => closeGate(task).ok

/**
 * 删除门控：只有终态能删；活跃任务必须先 task_message(action:stop)/面板「停止」；
 * 有活跃下游依赖时也不能删（删了前置，下游会按「前置不存在」直接失败，见 deps.js）。
 * @param {{activeDependents?: number}} context 活跃下游数量（snapshot/detail/动作各自现算后传入）
 * @returns {{ok: boolean, reason: null|'not_found'|'active'|'not_terminal'|'has_dependents'}}
 */
export function deleteGate(task, { activeDependents = 0 } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  if (task.delivery_pending) return { ok: false, reason: 'collecting' }
  const status = statusOf(task)
  if (ACTIVE.has(status)) return { ok: false, reason: 'active' }
  if (!DELETABLE.has(status)) return { ok: false, reason: 'not_terminal' }
  if (Number.isFinite(activeDependents) && activeDependents > 0) return { ok: false, reason: 'has_dependents' }
  return { ok: true, reason: null }
}

export const canDelete = (task, context) => deleteGate(task, context).ok

/**
 * 停止门控的**幂等**判定：这个状态已经「停掉了」，再点「停止」应当直接返回 `already:true`，
 * 而不是再迁一次状态。
 *
 * 0.19.x 的缺陷（审计 §2.3.2 第 3 条，可触发）：面板 stop 用 `TERMINAL_STATUSES`（不含 failed）
 * 做这个判定，于是对**失败任务**再点「停止」会走 `failed → cancelled`（转移表允许），
 * 把「失败」抹成「已取消」——用户再也看不出它是失败。判据必须是「已收尾」（`releases` 能力），
 * 而不是「流程终态」。
 */
export const stopIsIdempotent = task => hasCap(statusOf(task), 'releases')

/**
 * 停止门控：正在跑/排队/等人都能停；已经收尾的状态按幂等成功处理。
 * @returns {{ok: boolean, already: boolean, reason: null|'not_found'}}
 */
export function stopGate(task) {
  if (task === undefined || task === null) return { ok: false, already: false, reason: 'not_found' }
  return { ok: true, already: stopIsIdempotent(task), reason: null }
}

export const canStop = task => stopGate(task).ok

/** 状态的全集与入边来源（面板「详情」与测试核对用，避免各自遍历本地表）。 */
export { STATUSES, sourcesOf }

// ---------------------------------------------------------------------------
// 工作台 v1（P11）：排期 / 组 / 自动化的门控（与动作同源：host-route 下发布尔值，client 只读）
// ---------------------------------------------------------------------------

/**
 * 排期门控（L1 planned_at）：只有非终态任务能排期——终态任务排了也永远不会跑，只会让日历说谎。
 * @returns {{ok: boolean, reason: null|'not_found'|'ended'|'invalid_time'}}
 */
export function planSetGate(task, { plannedAt = null } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  if (TERMINAL.has(statusOf(task))) return { ok: false, reason: 'ended' }
  if (plannedAt !== null && !Number.isFinite(plannedAt)) return { ok: false, reason: 'invalid_time' }
  return { ok: true, reason: null }
}

export const canSetPlan = (task, context) => planSetGate(task, context).ok

/**
 * 组改名门控：组必须存在（元数据行或已有任务在用这个 group_id）、未归档、名字 1–40 字。
 * @returns {{ok: boolean, reason: null|'not_found'|'archived'|'name_invalid'}}
 */
export function groupSaveGate(group, { name, exists = true } = {}) {
  if (exists !== true) return { ok: false, reason: 'not_found' }
  if (group !== undefined && group !== null && group.archived === true) return { ok: false, reason: 'archived' }
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '' || text.length > 40) return { ok: false, reason: 'name_invalid' }
  return { ok: true, reason: null }
}

export const canSaveGroup = (group, context) => groupSaveGate(group, context).ok

/**
 * 归档门控：归档是软删（任务不受影响），必须二次确认。
 * @returns {{ok: boolean, reason: null|'not_found'|'not_confirmed'}}
 */
export function groupArchiveGate(group, { confirm = false } = {}) {
  if (group === undefined || group === null) return { ok: false, reason: 'not_found' }
  if (confirm !== true) return { ok: false, reason: 'not_confirmed' }
  return { ok: true, reason: null }
}

/**
 * 自动化门控：宿主有 schedule 服务 + 用户明确授权（confirm）+ 记录存在。
 * 「目标必须是唯一主会话」与「触发规则合法」不在这里判定（那要读 mainSessionId / 解析 timing），
 * 由 workbench 在动作里判定并映射成专门的错误码。
 * @returns {{ok: boolean, reason: null|'not_found'|'unavailable'|'not_confirmed'}}
 */
export function automationGate({ available = true, confirmed = true, exists = true } = {}) {
  // 先报「宿主没有这个能力」再报「没这条记录」：降级页上两条都成立时，前者才是可操作的那条。
  if (available !== true) return { ok: false, reason: 'unavailable' }
  if (exists !== true) return { ok: false, reason: 'not_found' }
  if (confirmed !== true) return { ok: false, reason: 'not_confirmed' }
  return { ok: true, reason: null }
}

export const canAutomate = context => automationGate(context).ok
