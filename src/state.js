// 任务状态机。只有子会话的回报能推进 running 之后的状态；
// 协调者只能创建、续派、停止、重派。
export const STATUSES = ['pending', 'running', 'waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned']

const TRANSITIONS = {
  pending: ['running', 'cancelled'],
  running: ['waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned'],
  waiting_user: ['running', 'cancelled', 'failed'],
  waiting_auth: ['running', 'cancelled', 'failed'],
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
