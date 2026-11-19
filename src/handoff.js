// 交接契约 v1（P2-3 / D2）：把「交付 → 确认 / 追问 → 完成」从插件内部状态机提升为
// **可被外部消费的只读契约**：稳定字段 + 版本号 + JSONL 审计事件。
//
// v1 边界（计划 §9 待拍板 4 已批准，别再偷偷长大）：
//   1) 只做「字段 + JSONL 事件」，**不做**进程内订阅 API（回调/事件总线留 v2，取决于宿主事件契约）；
//   2) 字段名与事件名一旦发布就是契约：改语义必须升 `HANDOFF_CONTRACT_VERSION`，不许原地改；
//   3) 三条确认路径（`task_message({action:'close'})` / 面板「确认交付」/ 超时 sweeper）共用
//      `closeDelivered`：`accepted_by` / `accepted_at` 与 `task.handoff.confirmed` 只在那一处写；
//   4) 事件落 `$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`（按天分文件、超 5MB 轮转、
//      保留 30 天），不写仓库；台账 messages 是给面板读的，JSONL 是给 IM/CI/工作流读的。
//
// 为什么单独一个模块：契约字段表、事件名、JSONL 上报三件事必须同源。`docs/ARCHITECTURE.md` 的
// 「契约字段」表由 `scripts/check-docs.mjs` 与这里的 `HANDOFF_FIELDS` 逐字对齐（防漂移）。
import { countFollowups } from './ledger.js'
import { createLogger } from './log.js'

/** 契约版本号：只增不改语义。读方见到不认识的版本应当忽略而不是猜。 */
export const HANDOFF_CONTRACT_VERSION = 1

/** 契约字段（顺序即文档表顺序）。`scripts/check-docs.mjs` 断言文档表与这份清单一致。 */
export const HANDOFF_FIELDS = Object.freeze([
  'contract',
  'taskId',
  'sessionId',
  'title',
  'deliveredAt',
  'acceptedAt',
  'acceptedBy',
  'rounds',
  'evidence',
  'status',
  'closeReason',
])

/** `acceptedBy` 的取值域：协调者确认 / 面板确认 / 超时自动完成。 */
export const ACCEPTED_BY = Object.freeze({
  coordinator: 'coordinator',
  panel: 'panel',
  timeout: 'timeout',
})

const ACCEPTED_BY_LABEL = Object.freeze({
  coordinator: '协调者确认',
  panel: '面板确认',
  timeout: '超时自动完成',
})

/** 事件名（v1 只有这两个；各发一次，幂等关闭不重复发）。 */
export const HANDOFF_EVENT = Object.freeze({
  delivered: 'task.handoff.delivered',
  confirmed: 'task.handoff.confirmed',
})

/** JSONL 落点：`$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`。 */
export const HANDOFF_LOG_SUBDIR = 'handoff'
export const HANDOFF_LOG_PREFIX = 'handoff'
/** 审计事件比运行日志留得久（30 天 vs 7 天）：外部订阅方可能一周才拉一次。 */
export const HANDOFF_LOG_KEEP_DAYS = 30
export const HANDOFF_LOG_MAX_BYTES = 5 * 1024 * 1024

const text = value => typeof value === 'string' ? value : ''
const isoText = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : '未知时间'

/** 确认方式归一：显式 `by` 优先，其次按关闭原因推断（超时 / 其余算协调者）。 */
export function acceptedByOf(by, reason) {
  if (typeof by === 'string' && Object.hasOwn(ACCEPTED_BY, by)) return ACCEPTED_BY[by]
  return reason === 'timeout' ? ACCEPTED_BY.timeout : ACCEPTED_BY.coordinator
}

export const acceptedByLabel = acceptedBy =>
  typeof acceptedBy === 'string' && Object.hasOwn(ACCEPTED_BY_LABEL, acceptedBy) ? ACCEPTED_BY_LABEL[acceptedBy] : null

/**
 * 契约对象（纯函数）。**从没交付过的任务没有交接**——返回 null 而不是空壳，
 * 读方据此区分「没有交接」与「交接了但还没确认」（后者 `acceptedBy/acceptedAt` 为 null）。
 *
 * @param {object} task 台账任务行（`getTask` / `listTasks` 的产物）
 * @param {{followups?: number}} [options] 追问次数（`countFollowups`，避免在这里读库）
 * @returns {null | object}
 */
export function handoffOf(task, { followups = 0 } = {}) {
  if (task === null || typeof task !== 'object') return null
  const deliveredAt = Number.isFinite(task.delivered_at) ? task.delivered_at : null
  const acceptedAt = Number.isFinite(task.accepted_at) ? task.accepted_at : null
  // 手工改库/存量行可能只有 accepted_at 没有 delivered_at：边界情况仍按「有交接」处理，不丢确认记录。
  if (deliveredAt === null && acceptedAt === null) return null
  const count = Number.isFinite(followups) && followups > 0 ? Math.trunc(followups) : 0
  return {
    contract: HANDOFF_CONTRACT_VERSION,
    taskId: text(task.id),
    sessionId: task.session_id ?? null,
    title: text(task.title),
    deliveredAt,
    acceptedAt,
    acceptedBy: typeof task.accepted_by === 'string' && Object.hasOwn(ACCEPTED_BY, task.accepted_by) ? task.accepted_by : null,
    rounds: {
      // 派发/续派次数（台账 attempts）：交付前跑了几轮。
      turns: Number.isFinite(task.attempts) ? task.attempts : 0,
      // 交付后追问次数（台账 kind='followup' 消息数）。
      followups: count,
    },
    evidence: {
      // A1 的验收记录原样进契约（面板/台账里同一份，不另抄一套）；没跑过是 null。
      acceptance: task.acceptance ?? null,
      artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
    },
    status: text(task.status),
    closeReason: typeof task.close_reason === 'string' && task.close_reason !== '' ? task.close_reason : null,
  }
}

/** 台账任务行 → 契约对象（追问次数按台账现读；读库失败按 0 计，不因为统计字段炸掉渲染）。 */
export function handoffOfTask(db, task) {
  let followups = 0
  try { followups = countFollowups(db, task?.id) } catch { followups = 0 }
  return handoffOf(task, { followups })
}

/** 面板 snapshot 的精简版（只下发「谁/何时确认」，证据留在 detail 端点，别让快照变大）。 */
export function handoffSnapshot(task) {
  const handoff = handoffOf(task)
  if (handoff === null) return null
  const acceptance = handoff.evidence.acceptance
  return {
    contract: handoff.contract,
    deliveredAt: handoff.deliveredAt,
    acceptedAt: handoff.acceptedAt,
    acceptedBy: handoff.acceptedBy,
    acceptedByLabel: acceptedByLabel(handoff.acceptedBy),
    acceptanceOk: acceptance === null || acceptance === undefined ? null : acceptance.ok === true,
  }
}

/** `task_status` 的交接段（两行：谁/何时确认 + 轮次）；没有交接返回空数组。 */
export function handoffStatusLines(handoff) {
  if (handoff === null || handoff === undefined || typeof handoff !== 'object') return []
  const confirm = handoff.acceptedBy === null || handoff.acceptedAt === null
    ? '未确认（等你或用户确认，或超时自动完成）'
    : `${acceptedByLabel(handoff.acceptedBy) ?? handoff.acceptedBy} ${isoText(handoff.acceptedAt)}`
  return [
    `交接：契约 v${handoff.contract}｜交付 ${isoText(handoff.deliveredAt)}｜确认 ${confirm}`,
    `交接轮次：派发 ${handoff.rounds?.turns ?? 0} 次｜追问 ${handoff.rounds?.followups ?? 0} 次`,
  ]
}

/**
 * JSONL 上报器。`delivered(task)` 在任务进入 delivered 时调（index.js 的迁移观察者），
 * `confirmed(task)` 在 `closeDelivered` 落库成功后调（三条确认路径共用）。
 * 两个方法都返回写出的契约对象（没交接可写时返回 null），失败只 warn、不抛。
 *
 * 写出的行形状（与运行日志同一套 writer，字段固定）：
 * `{"at":"ISO","event":"task.handoff.delivered","taskId":"t-…","sessionId":"c-…","detail":{"contract":1,"handoff":{…}}}`
 */
export function createHandoffLog({
  db,
  stateDir,
  keepDays = HANDOFF_LOG_KEEP_DAYS,
  maxBytes = HANDOFF_LOG_MAX_BYTES,
  now = Date.now,
  onWarn = () => {},
} = {}) {
  const logger = typeof stateDir === 'string' && stateDir !== ''
    ? createLogger({ stateDir, subdir: HANDOFF_LOG_SUBDIR, filePrefix: HANDOFF_LOG_PREFIX, keepDays, maxBytes, now, onWarn })
    : null
  const emit = (event, task) => {
    if (task === null || task === undefined) return null
    const handoff = handoffOfTask(db, task)
    if (handoff === null) return null
    try {
      logger?.log?.(event, {
        taskId: handoff.taskId,
        sessionId: handoff.sessionId ?? undefined,
        detail: { contract: handoff.contract, handoff },
      })
    } catch (error) {
      try { onWarn(`dsh-orchestrator: 交接事件写入失败：${error?.message ?? error}`) } catch { /* warn 失败不再抛 */ }
    }
    return handoff
  }
  return {
    delivered: task => emit(HANDOFF_EVENT.delivered, task),
    confirmed: task => emit(HANDOFF_EVENT.confirmed, task),
  }
}

// 进程级 sink：与 `ledger.setTransitionObserver` 同一套做法——`closeDelivered` 有三个调用方，
// 与其给每个调用方都加一个参数（还会漏），不如启动时接一次、测试里换成假上报器。
// 没接（测试/未装配）时事件是静默 no-op：JSONL 是旁路，绝不能反过来影响交付。
let sink = null

/** 接上 JSONL 上报器（index.js 启动时调一次）。返回解绑函数（测试/卸载用）。 */
export function setHandoffSink(next) {
  const normalized = next !== null && typeof next === 'object' ? next : null
  const previous = sink
  sink = normalized
  return () => { if (sink === normalized) sink = previous }
}

const emitViaSink = (method, task) => {
  if (sink === null) return null
  try {
    const result = sink[method]?.(task)
    return result ?? null
  } catch {
    return null
  }
}

/** 任务进入 delivered（交付）→ 写 `task.handoff.delivered`。 */
export const emitHandoffDelivered = task => emitViaSink('delivered', task)
/** 任务被确认完成 → 写 `task.handoff.confirmed`（幂等关闭不重复发）。 */
export const emitHandoffConfirmed = task => emitViaSink('confirmed', task)
