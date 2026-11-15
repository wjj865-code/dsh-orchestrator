// 任务状态机。只有子会话的回报（或结算）能推进 running 之后的状态；
// 协调者只能创建、续派、确认交付（task_close）、停止、重派。
export const STATUSES = ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered', 'done', 'failed', 'cancelled', 'orphaned']

/** 活跃状态（还没落终态）：台账 listTasks(active)、面板闸门、看门狗共用同一口径。 */
export const ACTIVE_STATUSES = ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered']

// 对外状态文案：工具层、面板动作、卡片共用一套（客户端 client.js 因浏览器环境单独保留同值副本）。
export const STATUS_LABEL = {
  waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  delivered: '待确认', done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}

export const statusLabel = status => STATUS_LABEL[status] ?? status

// delivered = 已交付待确认：子会话报 done / 结算 completed 后进入，等协调者 task_close 确认（或超时自动 done）。
// 它是唯一允许「追问复用原会话」的收尾态；done 仍是不可逆终态。
const TRANSITIONS = {
  waiting_dep: ['pending', 'failed', 'cancelled'],
  pending: ['running', 'failed', 'cancelled'],
  running: ['waiting_user', 'waiting_auth', 'delivered', 'done', 'failed', 'cancelled', 'orphaned'],
  waiting_user: ['running', 'cancelled', 'failed', 'orphaned'],
  waiting_auth: ['running', 'cancelled', 'failed', 'orphaned'],
  // delivered → done：协调者确认或超时；delivered → running：task_message 追问；其余是停止/会话丢失。
  delivered: ['running', 'done', 'cancelled', 'orphaned'],
  failed: ['running', 'cancelled'],
  done: [],
  cancelled: [],
  orphaned: ['pending', 'cancelled'],
}

export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false
  return TRANSITIONS[from].includes(to)
}

export function nextStatus(from, to) {
  if (!canTransition(from, to)) throw new Error(`不允许的状态迁移：${from} → ${to}`)
  return to
}
