// 启动对账：catalog 是历史记录，查不到 session_id 才判 orphaned；
// catalog 本身读不到时只 warn 保留现状，不能把 running 全判死。
import { listTasks, transition } from './ledger.js'

const NEEDS_CHECK = new Set(['running', 'waiting_user', 'waiting_auth'])

export async function reconcileOrphans({ db, dispatcher, coordinatorSessionId, logger, onWarn = () => {} }) {
  const active = listTasks(db).filter(task =>
    task.session_id !== null && task.session_id !== undefined && NEEDS_CHECK.has(task.status))
  if (active.length === 0) return { count: 0, ids: [], skipped: 'nothing-active' }
  if (coordinatorSessionId === undefined) {
    onWarn('dsh-orchestrator: 未绑定协调者会话，跳过子会话可达性对账')
    return { count: 0, ids: [], skipped: 'no-coordinator' }
  }
  let catalog
  try {
    catalog = await dispatcher.catalog()
  } catch (error) {
    onWarn(`dsh-orchestrator: 子会话目录读取失败，跳过孤儿对账：${error?.message ?? error}`)
    return { count: 0, ids: [], skipped: 'no-catalog' }
  }
  const known = new Set((catalog ?? []).map(entry => String(entry.id)))
  const orphaned = active.filter(task => !known.has(String(task.session_id)))
  for (const task of orphaned) transition(db, task.id, 'orphaned', { error: '子会话在目录里查不到（可能已被删除）' })
  try {
    logger?.log?.('task.reconciled', { detail: { orphaned: orphaned.map(task => task.id), checked: active.length } })
  } catch { /* 日志失败不影响对账 */ }
  return { count: orphaned.length, ids: orphaned.map(task => task.id) }
}
