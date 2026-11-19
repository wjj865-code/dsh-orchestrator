// delivered 两段式终态（D1）：子会话交付后停在「已交付待确认」（delivered），
// 由协调者 `task_message({ action: 'close' })`（或面板「确认交付」）确认，或超过 `deliveredTimeoutMinutes` 自动收成 done。
// done 仍是不可逆终态；delivered 是唯一允许「追问复用原会话」的收尾态。
//
// 为什么单独一个模块：确认有两条触发路径（工具层 / 面板）和一条兜底（超时 sweeper），
// 三条必须做**同一件事**（迁移 + 交接确认 + 审计消息 + 释放可写根 + goal 收口 + 检出清理 + 队列补位），
// 否则会出现「工具确认了但检出没清理 / 下游不推进」的分叉。
// P2-3 交接契约 v1：三条路径各自传 `by`（coordinator / panel / timeout），
// 落 `tasks.accepted_by` / `accepted_at` 并发一条 `task.handoff.confirmed` JSONL（见 src/handoff.js）。
import { addMessage, getTask, listTasks, setTaskAccepted, transition } from './ledger.js'
import { statusLabel } from './state.js'
// P2-3 交接契约 v1：确认人/确认时间在这里落库，`task.handoff.confirmed` 也只在这里上报一次
// （幂等关闭走已 done 的 early return，不会再写第二条事件）。
import { acceptedByOf, emitHandoffConfirmed } from './handoff.js'

/** 交付后等确认的默认超时（分钟）；`config.deliveredTimeoutMinutes` 可覆盖（1–1440）。 */
export const DELIVERED_TIMEOUT_MINUTES = 60
/** 超时巡检间隔：一分钟一次足够（判据是分钟级），timer 不阻止进程退出。 */
export const DELIVERED_SWEEP_INTERVAL_MS = 60_000
/** 关闭原因取值：协调者确认 / 超时自动完成（写 tasks.close_reason，供审计与面板展示）。 */
export const CLOSE_REASONS = Object.freeze({ coordinator: 'coordinator', timeout: 'timeout' })

const REASON_LABEL = { coordinator: '协调者确认', timeout: '超时自动完成' }

export const closeReasonLabel = reason =>
  REASON_LABEL[reason] ?? (typeof reason === 'string' && reason !== '' ? reason : '未知')

/** 等待确认（delivered）里已超时的任务；只读，不写台账、不改状态。 */
export function findExpiredDelivered({ db, now = Date.now(), timeoutMinutes = DELIVERED_TIMEOUT_MINUTES } = {}) {
  const minutes = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
    ? Math.min(1440, Math.floor(timeoutMinutes))
    : DELIVERED_TIMEOUT_MINUTES
  const cutoff = now - minutes * 60_000
  return listTasks(db).filter(task => task.status === 'delivered'
    && Number.isFinite(task.delivered_at)
    && task.delivered_at <= cutoff)
}

/**
 * 把一条 delivered 任务收成 done（协调者确认与超时共用）。
 *
 * 副作用顺序与 settlement 的终态收尾一致：先落库（迁移 + 交接确认 + 审计消息），再释放可写根 / 收口 goal /
 * 按档位清检出 / 唤醒队列。任何一步抛错都不能回滚已经落库的 done。
 *
 * @param {object} options
 * @param {'coordinator'|'panel'|'timeout'} [options.by] 谁确认的（交接契约 `acceptedBy`，默认按 reason 推断）
 * @returns {{ok:true, task:object, already:boolean} | {ok:false, reason:'not-found'|'not-delivered', task?:object}}
 */
export function closeDelivered({
  db,
  taskId,
  reason = CLOSE_REASONS.coordinator,
  by,
  releaseSession = () => {},
  completeGoal = () => {},
  cleanupWorktree = () => {},
  pump = () => {},
  logger,
} = {}) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不能回滚关闭 */ }
  }
  const acceptedBy = acceptedByOf(by, reason)
  const task = getTask(db, String(taskId ?? ''))
  if (task === undefined) return { ok: false, reason: 'not-found' }
  // 幂等：已经 done（并发确认、超时与手工确认撞车）按成功返回，不再迁移/不再写消息。
  if (task.status === 'done') return { ok: true, task, already: true }
  if (task.status !== 'delivered') return { ok: false, reason: 'not-delivered', task }
  let next
  try {
    next = transition(db, task.id, 'done', { closeReason: reason })
  } catch (error) {
    // 读到 delivered 之后状态被另一次确认/停止改掉：以最新状态为准，不重复收口。
    const latest = getTask(db, task.id)
    if (latest?.status === 'done') return { ok: true, task: latest, already: true }
    log('task.delivered.close-failed', { taskId: task.id, detail: { reason, error: error?.message ?? String(error) } })
    return { ok: false, reason: 'not-delivered', task: latest }
  }
  try {
    // 交接契约 v1：先落「谁确认、何时确认」，再写审计消息——两者失败都不能回滚已落库的 done。
    next = setTaskAccepted(db, task.id, { acceptedBy })
  } catch (error) {
    log('task.handoff.accept-failed', { taskId: task.id, detail: { acceptedBy, error: error?.message ?? String(error) } })
  }
  try {
    addMessage(db, task.id, {
      kind: 'close',
      rendered: `[确认] ${closeReasonLabel(reason)}：${statusLabel(next.status)}`,
      meta: { closeReason: reason, status: next.status, acceptedBy },
    })
  } catch (error) {
    log('task.delivered.message-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
  }
  const sessionId = next.session_id ?? next.target
  try { releaseSession(sessionId) } catch { /* 释放失败不影响已落库的 done */ }
  try { completeGoal(next) } catch { /* goal 收口失败不影响关闭 */ }
  try { cleanupWorktree(next) } catch { /* 清理失败只影响磁盘 */ }
  try { pump() } catch { /* 队列补位失败不影响关闭 */ }
  log('task.delivered.closed', { taskId: next.id, sessionId: sessionId ?? null, detail: { reason, acceptedBy } })
  // 交接契约 v1：确认事件只在这里发一次（already 分支已提前返回，重复确认不会重复发）。
  try { emitHandoffConfirmed(next) } catch { /* 事件失败是旁路，不影响已落库的 done */ }
  return { ok: true, task: next, already: false }
}

/**
 * 超时 sweeper：每分钟扫一次 delivered，超过阈值自动 done；启动时先扫一次（覆盖进程重启期间过期的）。
 * @returns {{start:()=>Function, stop:()=>void, sweep:()=>{checked:number, closed:string[]}, timeoutMinutes:()=>number}}
 */
export function createDeliveredSweeper({
  db,
  config = {},
  logger,
  releaseSession,
  completeGoal,
  cleanupWorktree,
  pump,
  now = () => Date.now(),
  intervalMs = DELIVERED_SWEEP_INTERVAL_MS,
  onWarn = () => {},
} = {}) {
  const timeoutMinutes = config?.deliveredTimeoutMinutes ?? DELIVERED_TIMEOUT_MINUTES
  let timer = null
  const sweep = () => {
    let expired
    try {
      expired = findExpiredDelivered({ db, now: now(), timeoutMinutes })
    } catch (error) {
      onWarn(`dsh-orchestrator: 交付确认超时巡检失败：${error?.message ?? error}`)
      return { checked: 0, closed: [], skipped: 'error' }
    }
    const closed = []
    for (const task of expired) {
      const result = closeDelivered({
        db, taskId: task.id, reason: CLOSE_REASONS.timeout, by: 'timeout',
        releaseSession, completeGoal, cleanupWorktree, pump, logger,
      })
      if (result.ok === true && result.already !== true) closed.push(result.task.id)
    }
    return { checked: expired.length, closed }
  }
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  const start = () => {
    if (timer !== null) return stop
    sweep()
    timer = setInterval(sweep, intervalMs)
    timer.unref?.()
    return stop
  }
  return { start, stop, sweep, timeoutMinutes: () => timeoutMinutes }
}
