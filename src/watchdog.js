// 空闲看门狗（W1）：running 任务长时间没有「心跳 / 消息 / 状态变化」时告警一次。
// 职责边界（刻意做窄）：只告警——不改状态、不 kill、不重派、不碰台账。
//   - 判定数据源三源取最新（见 lastActivityAt）：
//       ① tasks.last_event_at —— 心跳：task_report progress、产物/问题更新等 touch 写入；
//       ② tasks.updated_at    —— 状态变化 / 任务编辑；
//       ③ messages.at         —— 子会话最近一条回报消息（progress/done/blocked 都会落行）。
//   - 去重：每个任务同一段空闲只告警一次；三源里出现更新的活动（水位抬高）后允许再告警一次。
//     去重表只在内存：插件重启后允许对同一任务再报一次（重启本身值得重新提醒）。
//   - 关闭：idleWatchdog:false 时不装定时器、scan 直接返回 skipped:'disabled'。
import { listTasks } from './ledger.js'

// 只看 running：waiting_user / waiting_auth 是故意停下的，终态不在巡检范围。
export const WATCHDOG_STATUSES = new Set(['running'])
// 默认 5 分钟巡检一次、running 空闲 15 分钟才告警（两个值都可由配置覆盖）。
export const DEFAULT_WATCHDOG_INTERVAL_MINUTES = 5
export const DEFAULT_WATCHDOG_IDLE_MINUTES = 15
export const WATCHDOG_SUMMARY_MAX = 10
const MINUTE_MS = 60_000

const positiveMinutes = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const minutesOf = ms => Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / MINUTE_MS))

/** 巡检范围内的任务（running）。 */
export function runningTasks(db) {
  return listTasks(db).filter(task => WATCHDOG_STATUSES.has(task.status))
}

/** 最近一条消息时间；没有消息返回 undefined（空表 MAX() 是 null）。 */
export function lastMessageAt(db, taskId) {
  const row = db.prepare('SELECT MAX(at) AS at FROM messages WHERE task_id = ?').get(taskId)
  return Number.isFinite(row?.at) ? row.at : undefined
}

/** 判定数据源：心跳 / 消息 / 状态变化三源取最新（毫秒时间戳）。 */
export function lastActivityAt(db, task) {
  const messageAt = lastMessageAt(db, task?.id)
  return Math.max(
    Number.isFinite(task?.last_event_at) ? task.last_event_at : 0,
    Number.isFinite(task?.updated_at) ? task.updated_at : 0,
    messageAt ?? 0,
  )
}

/**
 * 扫描空闲任务：running 且最新活动 ≤ now - idleMinutes。
 * 只读，不写台账；返回 [{ task, lastActivity, idleMs }]。
 */
export function findIdleTasks({ db, now = Date.now(), idleMinutes = DEFAULT_WATCHDOG_IDLE_MINUTES } = {}) {
  const minutes = positiveMinutes(idleMinutes, DEFAULT_WATCHDOG_IDLE_MINUTES)
  const cutoff = now - minutes * MINUTE_MS
  const idle = []
  for (const task of runningTasks(db)) {
    const lastActivity = lastActivityAt(db, task)
    if (lastActivity > cutoff) continue
    idle.push({ task, lastActivity, idleMs: Math.max(0, now - lastActivity) })
  }
  return idle
}

/**
 * 汇总文案：一轮巡检的多条空闲合并成一条，避免刷屏。
 * 明确写「只告警不改状态」，避免协调者以为看门狗已经动过任务。
 */
export function idleSummary(entries, { max = WATCHDOG_SUMMARY_MAX, labelFor, idleMinutes = DEFAULT_WATCHDOG_IDLE_MINUTES } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => entry !== null && typeof entry === 'object' && entry.task)
  if (list.length === 0) return null
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : WATCHDOG_SUMMARY_MAX
  const shown = list.slice(0, limit)
  const nameOf = task => {
    if (typeof labelFor === 'function') return labelFor(task)
    return String(task.title ?? '').trim() !== '' ? String(task.title).trim() : `任务 ${task.id}`
  }
  const lines = shown.map(entry => `- ${nameOf(entry.task)}（${entry.task.id}，已 ${minutesOf(entry.idleMs)} 分钟无动静）`)
  const hidden = list.length - shown.length
  const tail = hidden > 0 ? [`- 另有 ${hidden} 个任务未列出`] : []
  const minutes = positiveMinutes(idleMinutes, DEFAULT_WATCHDOG_IDLE_MINUTES)
  return [
    `空闲看门狗：${list.length} 个任务在 running，但已超过 ${minutes} 分钟没有心跳/消息/状态变化（可能卡住）：`,
    ...lines,
    ...tail,
    '看门狗只告警、不改任务状态：用 task_status 查看，task_message 续派，或 task_stop 停掉。',
  ].join('\n')
}

const isThenable = value => value !== null && typeof value?.then === 'function'

/**
 * 空闲看门狗。
 * @param {object} options
 * @param {object} options.db 台账
 * @param {object} [options.notifier] 通知器（用 summary 合并上报；没有 summary 时逐条 push）
 * @param {boolean} [options.enabled] 关闭开关（false = 不装定时器、不告警）
 * @param {number} [options.idleMinutes] 卡住阈值（分钟）
 * @param {number} [options.intervalMinutes] 巡检间隔（分钟）
 * @param {number} [options.intervalMs] 直接指定巡检间隔（毫秒，测试/内部用，优先于 intervalMinutes）
 */
export function createIdleWatchdog({
  db,
  notifier,
  logger,
  onWarn = () => {},
  labelFor,
  idleMinutes = DEFAULT_WATCHDOG_IDLE_MINUTES,
  intervalMinutes = DEFAULT_WATCHDOG_INTERVAL_MINUTES,
  intervalMs,
  enabled = true,
  now = () => Date.now(),
  maxSummary = WATCHDOG_SUMMARY_MAX,
} = {}) {
  const idleThreshold = positiveMinutes(idleMinutes, DEFAULT_WATCHDOG_IDLE_MINUTES)
  const interval = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : positiveMinutes(intervalMinutes, DEFAULT_WATCHDOG_INTERVAL_MINUTES) * MINUTE_MS
  let timer = null
  // taskId → 已告警时的活动水位（lastActivity）。新活动抬高水位 = 允许再告警一次。
  const alerted = new Map()

  const log = (event, detail) => {
    try { logger?.log?.(event, { detail }) } catch { /* 日志失败不影响巡检 */ }
  }

  const itemsOf = entries => entries.map(({ task, idleMs }) => ({
    taskId: task.id,
    title: task.title,
    displayName: typeof labelFor === 'function' ? labelFor(task) : task.title,
    readOnly: task.read_only === true,
    access: task.access === 'full' ? 'full' : null,
    status: 'stalled',
    summary: `running 已 ${minutesOf(idleMs)} 分钟没有心跳/消息/状态变化，可能卡住（看门狗只告警，不改状态）`,
    // system:true 让 index 的 send 接受「没有子会话 sender」的系统通知（与启动对账一致）。
    system: true,
  }))

  const deliver = (entries, text) => {
    if (notifier === undefined) return { delivered: false, reason: 'no-notifier' }
    const items = itemsOf(entries)
    try {
      if (typeof notifier.summary === 'function') return notifier.summary(items, text) ?? { delivered: false, reason: 'unknown' }
      for (const item of items) notifier.push?.(item)
      return { delivered: true }
    } catch (error) {
      return { delivered: false, reason: error?.message ?? String(error) }
    }
  }

  const reportOutcome = (outcome, count) => {
    if (outcome?.delivered === true) {
      log('task.idle.watchdog', { count })
      return
    }
    log('task.idle.watchdog.skipped', { count, reason: outcome?.reason ?? null })
  }

  /**
   * 巡检一轮：只读台账 + 发通知（不发时也会返回结果）。
   * @returns {{checked:number, idle:string[], alerted:string[], skipped?:string}}
   */
  const scan = () => {
    if (enabled !== true) return { checked: 0, idle: [], alerted: [], skipped: 'disabled' }
    const at = now()
    let running
    let idle
    try {
      running = runningTasks(db)
      idle = findIdleTasks({ db, now: at, idleMinutes: idleThreshold })
    } catch (error) {
      onWarn(`dsh-orchestrator: 空闲看门狗巡检失败：${error?.message ?? error}`)
      return { checked: 0, idle: [], alerted: [], skipped: 'error' }
    }
    // 任务离开 running（完成/取消/丢失）就不再占去重表。
    const runningIds = new Set(running.map(task => task.id))
    for (const taskId of [...alerted.keys()]) {
      if (!runningIds.has(taskId)) alerted.delete(taskId)
    }
    // 同一段空闲只报一次；活动水位比上次告警时更新 → 视为「有活动重置过」，允许再报。
    const fresh = idle.filter(entry => {
      const watermark = alerted.get(entry.task.id)
      return watermark === undefined || entry.lastActivity > watermark
    })
    const idleIds = idle.map(entry => entry.task.id)
    if (fresh.length === 0) {
      return { checked: running.length, idle: idleIds, alerted: [], skipped: idle.length === 0 ? 'nothing-idle' : 'already-alerted' }
    }
    // 先落去重标记再投递：严格「每任务一次」，投递被跳过也不会每轮重复刷。
    for (const entry of fresh) alerted.set(entry.task.id, entry.lastActivity)
    const text = idleSummary(fresh, { max: maxSummary, labelFor, idleMinutes: idleThreshold })
    try {
      const outcome = deliver(fresh, text)
      const count = fresh.length
      if (isThenable(outcome)) {
        // 异步通知通道：结果只用于日志，不阻塞巡检。
        void outcome.then(value => reportOutcome(value, count), error => reportOutcome({ delivered: false, reason: error?.message ?? String(error) }, count))
      } else {
        reportOutcome(outcome, count)
      }
    } catch (error) {
      onWarn(`dsh-orchestrator: 空闲看门狗告警失败：${error?.message ?? error}`)
    }
    return { checked: running.length, idle: idleIds, alerted: fresh.map(entry => entry.task.id) }
  }

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    alerted.clear()
  }

  /** 启动即巡检一次，之后每 interval 巡检；返回卸载用清理函数（也可显式 stop()）。 */
  const start = () => {
    if (enabled !== true) return stop
    if (timer !== null) return stop
    scan()
    timer = setInterval(() => { scan() }, interval)
    timer.unref?.()
    return stop
  }

  return {
    start,
    stop,
    scan,
    notifiedCount: () => alerted.size,
    enabled: enabled === true,
    config: { idleMinutes: idleThreshold, intervalMs: interval },
  }
}
