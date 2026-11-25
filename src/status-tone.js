// 展示色调，不参与状态能力/迁移。
export const STATUS_TONE = Object.freeze({
  waiting_dep: 'muted', pending: 'muted', running: 'info', waiting_user: 'warn',
  waiting_auth: 'warn', delivered: 'warn', done: 'good', failed: 'bad',
  cancelled: 'muted', orphaned: 'bad', missing: 'muted',
})
