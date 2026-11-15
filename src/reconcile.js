// 启动/协调者加载对账（S2）。
// 「沉默中断」兜底：进程重启/崩溃后子会话没有结算事件可消费，台账却还挂着 running。
// 两条判据：
//   ① running 且子代理不 live（进程重启后本来就没有在跑的回合）→ orphaned；
//   ② catalog（子会话目录）里查不到 session_id → orphaned（已丢失，可重建）。
// 口径：
//   - 活跃性对账只认 running；waiting_user/waiting_auth 即使子级不 live 也保持
//     （它们是故意停下的，靠 task_message 冷恢复），只有 catalog 明确查不到才标 orphaned；
//   - waiting_dep 还没有子会话，完全不参与对账，避免「等前置」被误标丢失；
//   - 终态任务不在扫描范围，重复启动天然幂等；
//   - catalog 读不到只 warn：running 的 liveness 判定照做，其余保留现状；
//   - 标记完发一条汇总通知（不是每个任务一条），协调者晚加载时保留待发，加载后补发一次。
import { getTask, listTasks, transition } from './ledger.js'

// 活跃性对账只认 running：其余状态不是「正在跑却没人」。
const LIVENESS_STATUSES = new Set(['running'])
// catalog 可达性沿用设计口径：running + 故意停下的 waiting_*；waiting_dep 不参与。
const CATALOG_STATUSES = new Set(['running', 'waiting_user', 'waiting_auth'])

const REASON_DEAD = '进程重启后子会话没有在运行的回合（可重建）'
const REASON_GONE = '子会话在目录里查不到（可能已被删除）'

/** 扫描范围：有子会话、且状态可能需要对账的任务。 */
const needsCheck = task => task.session_id !== null && task.session_id !== undefined
  && (LIVENESS_STATUSES.has(task.status) || CATALOG_STATUSES.has(task.status))

export async function reconcileOrphans({ db, dispatcher, coordinatorSessionId, isLive, logger, onWarn = () => {} }) {
  const active = listTasks(db).filter(needsCheck)
  if (active.length === 0) return { count: 0, ids: [], tasks: [], skipped: 'nothing-active' }
  if (coordinatorSessionId === undefined) {
    onWarn('dsh-orchestrator: 未绑定协调者会话，跳过子会话可达性对账')
    return { count: 0, ids: [], tasks: [], skipped: 'no-coordinator' }
  }

  let known
  try {
    known = new Set((await dispatcher.catalog() ?? []).map(entry => String(entry.id)))
  } catch (error) {
    known = undefined
    onWarn(`dsh-orchestrator: 子会话目录读取失败，跳过 catalog 对账：${error?.message ?? error}`)
  }

  const candidates = []
  for (const task of active) {
    const sessionId = String(task.session_id)
    if (LIVENESS_STATUSES.has(task.status) && typeof isLive === 'function' && !isLive(sessionId)) {
      candidates.push({ task, reason: REASON_DEAD })
      continue
    }
    if (known !== undefined && !known.has(sessionId)) {
      candidates.push({ task, reason: REASON_GONE })
    }
  }

  const marked = []
  for (const { task, reason } of candidates) {
    // 扫描与迁移之间状态可能已被结算/面板动作推进：以最新状态为准，别把刚落地的 done 再标 orphaned。
    const current = getTask(db, task.id)
    if (current === undefined || current.status !== task.status || !needsCheck(current)) continue
    try {
      const next = transition(db, task.id, 'orphaned', { error: reason })
      marked.push(next)
      // orphaned 是终态：释放该会话的 target 可写根。
      try {
        dispatcher.releaseWritableRoots?.(task.session_id ?? task.target)
      } catch { /* 释放失败不影响对账 */ }
    } catch (error) {
      onWarn(`dsh-orchestrator: 任务 ${task.id} 标 orphaned 失败：${error?.message ?? error}`)
    }
  }
  try {
    logger?.log?.('task.reconciled', {
      detail: {
        checked: active.length,
        orphaned: marked.map(task => task.id),
        catalog: known === undefined ? 'unavailable' : 'ok',
      },
    })
  } catch { /* 日志失败不影响对账 */ }
  return { count: marked.length, ids: marked.map(task => task.id), tasks: marked }
}

export const RECONCILE_SUMMARY_MAX = 10

/** 汇总文案：一次把本轮所有孤儿列清楚，避免每个任务一条通知刷屏。 */
export function reconcileSummary(tasks, { max = RECONCILE_SUMMARY_MAX, labelFor } = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(task => task !== null && typeof task === 'object') : []
  if (list.length === 0) return null
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : RECONCILE_SUMMARY_MAX
  const shown = list.slice(0, limit)
  const nameOf = task => typeof labelFor === 'function'
    ? labelFor(task)
    : (String(task.title ?? '').trim() !== '' ? String(task.title).trim() : `任务 ${task.id}`)
  const lines = shown.map(task => `- ${nameOf(task)}（${task.id}）`)
  const hidden = list.length - shown.length
  const tail = hidden > 0 ? [`- 另有 ${hidden} 个任务未列出`] : []
  return [
    `启动对账：${list.length} 个任务在跑，但子会话已不活跃，已标记为会话丢失（orphaned，可 task_retry 重派）：`,
    ...lines,
    ...tail,
    '详情用 task_status，全部任务用 task_list / task_inbox。',
  ].join('\n')
}

/**
 * 启动对账器：标记孤儿 + 汇总上报。
 * - 同一个任务只进一次汇总（重复 reconcile 不会重复通知）；
 * - 汇总投递失败/跳过（协调者还没加载）时保留待发，下一次 reconcile 补发一次；
 * - 没有新孤儿但有待发汇总时也会补发（协调者晚加载的真实场景）。
 */
export function createStartupReconciler({
  db,
  dispatcher,
  isLive,
  logger,
  onWarn = () => {},
  notifier,
  labelFor,
  maxSummary = RECONCILE_SUMMARY_MAX,
} = {}) {
  // 已标 orphaned、但汇总还没送到的任务快照。
  let pending = []
  // 同一轮汇总只投递一次：启动对账与协调者加载对账可能并发，避免重复打扰。
  let flushing = null

  const log = (event, detail) => {
    try { logger?.log?.(event, { detail }) } catch { /* 日志失败不影响对账 */ }
  }

  const itemsOf = tasks => tasks.map(task => ({
    taskId: task.id,
    title: task.title,
    displayName: typeof labelFor === 'function' ? labelFor(task) : task.title,
    readOnly: task.read_only === true,
    status: 'orphaned',
    summary: '启动对账发现子会话已不活跃，已标记会话丢失',
    system: true,
  }))

  /** 把待发汇总送出去；成功才清空，失败保留等下次协调者加载再补。 */
  const flushOnce = async () => {
    if (pending.length === 0) return { delivered: false, reason: 'empty' }
    if (notifier === undefined) {
      // 没有通知通道：不积压内存，但要留一条 warn 方便排查。
      onWarn(`dsh-orchestrator: 启动对账发现 ${pending.length} 个孤儿任务（无通知通道，未汇总上报）`)
      pending = []
      return { delivered: false, reason: 'no-notifier' }
    }
    // 取走当前待发快照：投递期间新加的孤儿留在 pending，下一轮再报，避免漏报/重复。
    const batch = pending
    pending = []
    const text = reconcileSummary(batch, { max: maxSummary, labelFor })
    let outcome
    try {
      outcome = typeof notifier.summary === 'function'
        ? await notifier.summary(itemsOf(batch), text)
        : (() => {
          // 兼容只有 push 的 notifier：逐条推，靠合并窗口聚成一条。
          for (const item of itemsOf(batch)) notifier.push?.(item)
          return { delivered: true }
        })()
    } catch (error) {
      onWarn(`dsh-orchestrator: 启动对账汇总通知失败：${error?.message ?? error}`)
      outcome = { delivered: false, reason: 'send-failed' }
    }
    if (outcome?.delivered === true) {
      log('task.reconcile.summary', { count: batch.length })
      return outcome
    }
    // 失败/跳过：把这批放回待发（按 id 去重，保留投递期间新加的孤儿）。
    const known = new Set(pending.map(task => task.id))
    for (const task of batch) if (!known.has(task.id)) pending.push(task)
    const reason = outcome?.reason ?? (outcome?.skipped === true ? 'skipped' : (outcome?.delivered === false ? null : 'unknown'))
    log('task.reconcile.summary-pending', { count: pending.length, reason })
    return { delivered: false, reason }
  }

  const flushSummary = () => {
    if (flushing === null) {
      flushing = flushOnce().finally(() => { flushing = null })
    }
    return flushing
  }

  const reconcile = async ({ coordinatorSessionId } = {}) => {
    const result = await reconcileOrphans({
      db, dispatcher, coordinatorSessionId, isLive, logger, onWarn,
    })
    if (Array.isArray(result.tasks) && result.tasks.length > 0) {
      const known = new Set(pending.map(task => task.id))
      for (const task of result.tasks) if (!known.has(task.id)) pending.push(task)
    }
    if (result.tasks?.length > 0 || pending.length > 0) {
      result.summary = await flushSummary()
    }
    return result
  }

  return {
    reconcile,
    flushSummary,
    pendingCount: () => pending.length,
  }
}
