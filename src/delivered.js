// delivered 两段式终态（D1）：子会话交付后停在「已交付待确认」（delivered），
// 由协调者 `task_message({ action: 'close' })`（或面板「确认交付」）确认，或超过 `deliveredTimeoutMinutes` 自动收成 done。
// done 仍是不可逆终态；delivered 是唯一允许「追问复用原会话」的收尾态。
//
// 为什么单独一个模块：确认有两条触发路径（工具层 / 面板）和一条兜底（超时 sweeper），
// 加上链式自动放行（`chain:'auto'` 的交付钩子）共四条，必须做**同一件事**（迁移 + 交接确认 + 审计消息 +
// 释放可写根 + goal 收口 + 检出清理 + 队列补位），否则会出现「工具确认了但检出没清理 / 下游不推进」的分叉。
// P2-3 交接契约 v1：四条路径各自传 `by`（coordinator / panel / timeout / chain），
// 落 `tasks.accepted_by` / `accepted_at` 并发一条 `task.handoff.confirmed` JSONL（见 src/handoff.js）。
import { addMessage, getTask, listTasks, setTaskAccepted, transition } from './ledger.js'
import { statusLabel } from './state.js'
// 链式自动放行（chain:'auto'）：交付钩子要知道「有没有 waiting_dep 下游在等」——判据只读台账。
import { listWaitingDependents } from './deps.js'
// P2-3 交接契约 v1：确认人/确认时间在这里落库，`task.handoff.confirmed` 也只在这里上报一次
// （幂等关闭走已 done 的 early return，不会再写第二条事件）。
import { acceptedByOf, emitHandoffConfirmed } from './handoff.js'
// P2-4（D6）：确认成功 → 可选反写官方 Team 板（只有任务显式关联了 `team_task_id` 才动）。
// 上报器是进程级 sink（index.js 接一次），没接 / 没关联 / 官方不可用时都是静默 no-op。
import { emitTeamBoardConfirm } from './team-board.js'

/** 交付后等确认的默认超时（分钟）；`config.deliveredTimeoutMinutes` 可覆盖（1–1440）。 */
export const DELIVERED_TIMEOUT_MINUTES = 60
/** 超时巡检间隔：一分钟一次足够（判据是分钟级），timer 不阻止进程退出。 */
export const DELIVERED_SWEEP_INTERVAL_MS = 60_000
/** 关闭原因取值：协调者确认 / 超时自动完成 / 链式自动放行（写 tasks.close_reason，供审计与面板展示）。 */
export const CLOSE_REASONS = Object.freeze({
  coordinator: 'coordinator',
  timeout: 'timeout',
  // 链式自动放行（`task_create.chain:'auto'`）：交付时仍有 waiting_dep 下游 → 自动确认完成。
  // 与 coordinator 区分是刻意的：台账不能写「协调者确认」而实际没人确认。
  chain: 'chain',
})

const REASON_LABEL = { coordinator: '协调者确认', timeout: '超时自动完成', chain: '链式自动放行' }

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
 * @param {'coordinator'|'panel'|'timeout'|'chain'} [options.by] 谁确认的（交接契约 `acceptedBy`，默认按 reason 推断）
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
    // P0-4：accepted_kind 区分「交付确认」与「计划批准」，这里恒为 delivery。
    next = setTaskAccepted(db, task.id, { acceptedBy, kind: 'delivery' })
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
  // P2-4（D6）：反写官方 Team 板（CAS，只对显式关联的任务；失败只 warn，不回滚本地 done）。
  // 把 `acceptedBy` 一并交出去：**超时自动完成不是人的确认**，sweeper 那条路只记 skip、不反写官方板。
  // 放在最后：本地状态已经落库，反写再怎么样都只是「官方板上多一次提醒」。
  try { emitTeamBoardConfirm(next, { acceptedBy }) } catch { /* 反写是旁路，绝不能影响已落库的 done */ }
  return { ok: true, task: next, already: false }
}

/**
 * 链式自动放行（用户 2026-11-23 拍板，参数名固定 `chain: 'auto'`）。
 *
 * 语义只有一条：**带标记的任务交付（落 delivered）时，若台账里还有 `waiting_dep` 的下游依赖它，
 * 就立刻复用 `closeDelivered` 收成 done**。没有下游 / 不带标记 → 一个字节都不变（仍等确认）。
 *
 * 为什么做成独立函数而不是给 `closeDelivered` 加分支：`closeDelivered` 是「确认」侧的唯一入口
 * （工具 / 面板 / 超时 / 链式自动放行四条路径），加分支等于让确认动作自己判断要不要确认；这里把判据放在**交付侧**，
 * 只在落 delivered 的两处（settlement 的 completed 分支、task_report 的 done 分支）调用。
 */
export const CHAIN_AUTO = 'auto'
/** 标记落在 `brief` 快照的键名（不加 DB 列：`brief_json` 里存 `chain: 'auto'`）。 */
export const CHAIN_AUTO_FIELD = 'chain'

/**
 * 自动放行门控（纯读，不写库）。
 *
 * @param {object} task 台账任务行（`getTask` 的产物）
 * @returns {{ok:boolean, reason?:'no-chain'|'not-delivered'|'no-waiting-dependent', waiting:string[]}}
 */
export function chainAutoGate(db, task) {
  if (task?.brief?.[CHAIN_AUTO_FIELD] !== CHAIN_AUTO) return { ok: false, reason: 'no-chain', waiting: [] }
  if (task.status !== 'delivered') return { ok: false, reason: 'not-delivered', waiting: [] }
  const waiting = listWaitingDependents(db, task.id)
  if (waiting.length === 0) return { ok: false, reason: 'no-waiting-dependent', waiting }
  return { ok: true, waiting }
}

/**
 * 带 `chain:'auto'` 的交付是否要立刻放行；要就复用 `closeDelivered` 收成 done。
 *
 * 调用方（settlement / task_report）在**交付落库之后、发通知之前**调用；幂等由 `closeDelivered` 保证：
 * 已经 done → `already:true`（`closed:false`），并发/重复事件不会二次写 `accepted_*`、不会二次晋升。
 * 下游晋升不在这里另调 `promoteDependents`——`closeDelivered` 的 `pump()` 就是 `queue.pump()`，
 * 它开头就做晋升并入队（同一套唯一路径）。
 *
 * @returns {{closed:boolean, gate:{ok:boolean, reason?:string, waiting:string[]}, outcome?:object, task?:object}}
 */
export function autoCloseChainDelivered({
  db,
  task,
  taskId,
  releaseSession = () => {},
  completeGoal = () => {},
  cleanupWorktree = () => {},
  pump = () => {},
  logger,
} = {}) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不影响已落库的交付 */ }
  }
  const current = task ?? getTask(db, String(taskId ?? ''))
  const gate = chainAutoGate(db, current)
  if (gate.ok !== true) return { closed: false, gate, task: current }
  let outcome
  try {
    outcome = closeDelivered({
      db,
      taskId: current.id,
      reason: CLOSE_REASONS.chain,
      by: 'chain',
      releaseSession,
      completeGoal,
      cleanupWorktree,
      pump,
      logger,
    })
  } catch (error) {
    // 自动放行失败不能回滚已落库的 delivered：任务照旧停在「已交付待确认」，等确认/超时兜底。
    log('task.chain.auto-close-failed', { taskId: current.id, detail: { error: error?.message ?? String(error) } })
    return { closed: false, gate, task: current }
  }
  const closed = outcome.ok === true && outcome.already !== true
  if (closed) {
    log('task.chain.auto-close', {
      taskId: current.id,
      detail: { waiting: gate.waiting.length, acceptedBy: 'chain', closeReason: CLOSE_REASONS.chain },
    })
  }
  return { closed, gate, outcome, task: outcome.task ?? current }
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
