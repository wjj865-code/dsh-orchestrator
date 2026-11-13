// 卡片只描述数据，不关心渲染框架；阶段 2 的客户端直接复用它。
const STATUS_LABEL = {
  pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}
const STATUS_TONE = {
  pending: 'muted', running: 'info', waiting_user: 'warn', waiting_auth: 'warn',
  done: 'good', failed: 'bad', cancelled: 'muted', orphaned: 'bad',
}

export function taskCard(task, { summary = '', maxLength = 80 } = {}) {
  const text = summary.length > maxLength ? `${summary.slice(0, maxLength)}…` : summary
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    label: STATUS_LABEL[task.status] ?? task.status,
    tone: STATUS_TONE[task.status] ?? 'muted',
    summary: text,
  }
}
