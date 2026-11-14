// 任务状态机。只有子会话的回报能推进 running 之后的状态；
// 协调者只能创建、续派、停止、重派。
export const STATUSES = ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned']

// 对外状态文案：工具层、面板动作、卡片共用一套（客户端 client.js 因浏览器环境单独保留同值副本）。
export const STATUS_LABEL = {
  waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}

export const statusLabel = status => STATUS_LABEL[status] ?? status

const TRANSITIONS = {
  waiting_dep: ['pending', 'failed', 'cancelled'],
  pending: ['running', 'failed', 'cancelled'],
  running: ['waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned'],
  waiting_user: ['running', 'cancelled', 'failed', 'orphaned'],
  waiting_auth: ['running', 'cancelled', 'failed', 'orphaned'],
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
