// 卡片只描述数据，不关心渲染框架；阶段 2 的客户端直接复用它。
import { statusLabel } from './state.js'

const STATUS_TONE = {
  waiting_dep: 'muted', pending: 'muted', running: 'info', waiting_user: 'warn', waiting_auth: 'warn',
  done: 'good', failed: 'bad', cancelled: 'muted', orphaned: 'bad',
}

export function taskCard(task, { summary = '', maxLength = 80 } = {}) {
  // 按 Unicode 码点截断，避免在 80 边界把 emoji 的代理对切成两半。
  const chars = Array.from(summary)
  const text = chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : summary
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    label: statusLabel(task.status),
    tone: STATUS_TONE[task.status] ?? 'muted',
    summary: text,
    // 子会话不在普通会话列表里，客户端要按 parent catalog 打开；pending 表示在排队。
    childSessionId: task.session_id ?? null,
    artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
    queued: task.status === 'pending',
    openVia: 'subagent-catalog',
  }
}
