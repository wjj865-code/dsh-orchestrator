// 启动/协调者加载对账。
// - running 且子代理不 live（进程重启后本来就没有在跑的回合）→ orphaned，别留「台账在跑、实际没人在跑」的幽灵；
// - waiting_user/waiting_auth 即使子级不 live 也保持（它们是故意停下的，靠 task_message 冷恢复）；
// - catalog 里查不到 session_id → 同样 orphaned（已丢失，可重建）；
// - catalog 读不到只 warn：running 的 liveness 判定照做，其余保留现状。
import { listTasks, transition } from './ledger.js'

const NEEDS_CHECK = new Set(['running', 'waiting_user', 'waiting_auth'])

export async function reconcileOrphans({ db, dispatcher, coordinatorSessionId, isLive, logger, onWarn = () => {} }) {
  const active = listTasks(db).filter(task =>
    task.session_id !== null && task.session_id !== undefined && NEEDS_CHECK.has(task.status))
  if (active.length === 0) return { count: 0, ids: [], skipped: 'nothing-active' }
  if (coordinatorSessionId === undefined) {
    onWarn('dsh-orchestrator: 未绑定协调者会话，跳过子会话可达性对账')
    return { count: 0, ids: [], skipped: 'no-coordinator' }
  }

  let known
  try {
    known = new Set((await dispatcher.catalog() ?? []).map(entry => String(entry.id)))
  } catch (error) {
    known = undefined
    onWarn(`dsh-orchestrator: 子会话目录读取失败，跳过 catalog 对账：${error?.message ?? error}`)
  }

  const orphaned = []
  for (const task of active) {
    const sessionId = String(task.session_id)
    if (task.status === 'running' && typeof isLive === 'function' && !isLive(sessionId)) {
      orphaned.push({ task, reason: '进程重启后子会话没有在运行的回合（可重建）' })
      continue
    }
    if (known !== undefined && !known.has(sessionId)) {
      orphaned.push({ task, reason: '子会话在目录里查不到（可能已被删除）' })
    }
  }

  for (const { task, reason } of orphaned) {
    try {
      transition(db, task.id, 'orphaned', { error: reason })
    } catch (error) {
      onWarn(`dsh-orchestrator: 任务 ${task.id} 标 orphaned 失败：${error?.message ?? error}`)
    }
  }
  try {
    logger?.log?.('task.reconciled', {
      detail: {
        checked: active.length,
        orphaned: orphaned.map(({ task }) => task.id),
        catalog: known === undefined ? 'unavailable' : 'ok',
      },
    })
  } catch { /* 日志失败不影响对账 */ }
  return { count: orphaned.length, ids: orphaned.map(({ task }) => task.id) }
}
