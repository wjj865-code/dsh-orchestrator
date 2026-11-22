// 结算上报（S1）：子会话结束/中断时自动把台账从 running 推到终态。
// 两段式终态：自然结束先落 delivered（已交付待确认），由协调者 task_message({ action: 'close' }) 或超时 sweeper 收成 done；
// 中断/异常仍直接落 cancelled/failed/orphaned。
// 事件源有两个，都只做同一件事（重复到达由状态机天然幂等）：
//   1) dispatch.js 的 subagent.settled / subagent.failed（本次派发的那次 activation）；
//   2) 平台 subagent/end 生命周期事件（含续派/冷恢复起的新 activation，见 docs/probes/stop-reason-probe.md）。
// stopReason 取值域来自平台类型：completed / aborted / error / max-tokens / refusal。
// B1：结算同时把子会话最后一条 assistant 消息落进台账（短内联 / 长写 reports 文件），
//     主会话用 task_status 就能读到全文，不必再打开子会话历史；delivered/done 上只补消息、不改状态。
import { addMessage, findTaskBySession, getTask, getSetting, setTaskLastMessage, transition } from './ledger.js'
// P0-1：配了可执行验收的任务，自然结束也要有「本轮通过」的证据才能落 delivered（见 acceptanceGapOf）。
import { acceptanceGapOf } from './acceptance.js'
import { workspaceIndexSavedKey } from './workspace-index.js'
import { captureLastMessage, messageText, summarizeText } from './last-message.js'
import { statusLabel } from './state.js'
import { statusesWith } from './status-facts.js'
import { notifyWorktreeOf } from './worktree-request.js'

/** stopReason → 台账状态与死因。completed 只在「没有只报 progress」时算交付。 */
export const SETTLE_MAP = {
  // 两段式终态：子会话自然结束先落「已交付待确认」，由协调者 task_message({ action: 'close' })（或超时）收成 done。
  completed: { status: 'delivered', reason: null },
  aborted: { status: 'cancelled', reason: '子会话被中断（stopReason=aborted）' },
  error: { status: 'failed', reason: '子会话异常结束（stopReason=error）' },
  'max-tokens': { status: 'failed', reason: '子会话输出达到长度上限被截断（stopReason=max-tokens），可重派' },
  refusal: { status: 'failed', reason: '子会话被策略拒绝（stopReason=refusal），可重派' },
}

/** 回合结束但只上报过 progress：算「没人接着干」，落 orphaned（可续派/重派），不假报完成。 */
export const PAUSED_REASON = '子会话回合已结束，但只上报过 progress 没报终态（可重派）'
export const unknownReason = stopReason => `结算原因未知（stopReason=${stopReason ?? 'null'}），按会话丢失处理`

/** 纯映射：给定 stopReason 与任务已累计的 progress 轮数，返回目标状态与死因。 */
export function mapSettle(stopReason, { progressCount = 0 } = {}) {
  const known = Object.hasOwn(SETTLE_MAP, stopReason) ? SETTLE_MAP[stopReason] : undefined
  if (known === undefined) {
    return { status: 'orphaned', reason: unknownReason(stopReason), stopReason: stopReason ?? null }
  }
  if (known.status === 'delivered' && progressCount > 0) {
    return { status: 'orphaned', reason: PAUSED_REASON, stopReason }
  }
  return { ...known, stopReason }
}

const MAX_SUMMARY = 240

/** 结算里「要释放资源的状态」：`releases` 能力（done/failed/cancelled/orphaned）。
 *  delivered 也释放可写根（交付即放手，同目录才能新派），但它保留会话与 goal、仍可追问——
 *  别用「终态」这个词混过去：释放写根 ≠ 收口 goal，后者仍只认真终态。 */
const RELEASING_STATUSES = new Set(statusesWith('releases'))

/** 从 ContentBlock[] 取可读摘要（平台 SubagentResult.output / lastAssistantMessage 都是这个形状）。 */
export function outputSummary(output, max = MAX_SUMMARY) {
  return summarizeText(messageText(output), max)
}

/**
 * 结算上报器。所有副作用（台账、消息、通知、可写根释放、队列补位）都在这里，调用方只喂事件。
 * 只改 running 的状态：waiting_user/waiting_auth 是故意停下的（子任务自己报了 blocked/needs_auth）。
 * 但 delivered / done 上仍要补写「最后一条消息」——子任务自己 task_report done 会先把状态推到
 * delivered，本回合的 settle 到这里时已经不在 running，不补写就永远拿不到它最后说了什么（B1 时序修复）。
 */
export function createSettlementReporter({
  db,
  notifier,
  logger,
  labelFor,
  // B1 的旧参数（<state>/reports 落盘目录）：P1 起不再写文件（正文真源是宿主会话日志），
  // 保留入参只为不打断 index.js 的装配与老调用方。
  reportsDir,
  releaseSession = () => {},
  pump = () => {},
  onTerminal = () => {},
  // D5：通知发出前的产物补齐钩子（index.js 注入）。返回补齐后的任务行，通知用它渲染产物区块；
  // 返回 undefined/null 表示不改。钩子内部吞错，收集失败不能回滚已经落库的终态。
  beforeNotify = () => undefined,
} = {}) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不能打断结算 */ }
  }

  const notify = (task, status, summary) => {
    if (notifier === undefined) return
    try {
      notifier.push({
        taskId: task.id,
        // 版本 B / 交付确认：delivered 通知的 `task_message({action:'close', task_id: …})` 要填**引用**
        // （tk-xxxxxx），与 src/tools.js 的 task_report 路径同口径。缺了 ref 渲染层会替换成空串，
        // 协调者只能自己回想回执里的引用——子会话自然结束（不自调 task_report）是最常见的收场路径，
        // 这条路径漏了就等于多半交付确认都拿到 `task_id: ''`（发版验证 reports/ledger-upgrade-and-id-leak-verify §6.1）。
        ref: task.ref,
        title: task.title,
        displayName: typeof labelFor === 'function' ? labelFor(task) : task.title,
        readOnly: task.read_only === true,
        access: task.access === 'full' ? 'full' : null,
        status,
        summary,
        // D5：结算是最常见的收场路径（子会话自然结束 → 自动判 done），通知不带产物
        // 就等于主路径永远拿不到 present 交付候选（reports/t6.1-present.md §5）。
        artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
        // P9：隔离任务在通知里说明产物在哪个分支/检出目录（结算是最常见的收场路径）。
        worktree: notifyWorktreeOf(task),
        system: true,
      })
    } catch (error) {
      log('task.settle.notify-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
    }
  }

  /**
   * 落盘「子会话最后一条消息」（B1）：P1 起只存借条 `{at, stopReason, bytes, chars, digest, summary}`，
   * 正文留在宿主会话日志里（读侧见 src/last-message.js 的 resolveLastMessage）。
   * 失败只记日志——结算落库比「看得见最后一段话」优先，不能因此回滚状态。
   * @returns {{record: object, task: object, changed?: boolean} | null}
   */
  const persistLastMessage = (task, { text, stopReason, source }) => {
    try {
      const record = captureLastMessage({ text, taskId: task.id, reportsDir, stopReason, source })
      if (record === null) return null
      const prior = task.last_message
      const updated = setTaskLastMessage(db, task.id, record)
      // 同正文重复落库是幂等的（setTaskLastMessage 按 digest 判重）：changed 只给调用方/测试看。
      return { record, task: updated ?? task, changed: prior?.digest !== record.digest }
    } catch (failure) {
      log('task.settle.last-message-failed', { taskId: task.id, detail: { error: failure?.message ?? String(failure) } })
      return null
    }
  }

  /**
   * 消费一次结算。
   * @param {object} input
   * @param {string} [input.taskId] 已知任务编号（派发侧能带就带）
   * @param {string} [input.sessionId] 子会话 id（平台事件只有这个）
   * @param {string|null} [input.stopReason] 平台 SubagentStopReason
   * @param {Array} [input.output] 子会话最终输出（ContentBlock[]）
   * @param {string} [input.lastMessage] 子会话最终输出全文（派发侧已抽出文本时用它，优先于 output）
   * @param {string} [input.error] 结算失败原因（subagent.failed 路径）
   * @param {string} [input.source] 事件来源，只用于日志
   */
  const report = ({ taskId, sessionId, stopReason, output, lastMessage, error, source = 'unknown' } = {}) => {
    let task
    try {
      task = taskId === undefined || taskId === null ? findTaskBySession(db, sessionId) : getTask(db, String(taskId))
    } catch (failure) {
      log('task.settle.lookup-failed', { taskId, detail: { error: failure?.message ?? String(failure), source } })
      return { action: 'skipped', reason: 'lookup-failed' }
    }
    if (task === undefined || task === null) {
      log('task.settle.no-task', { sessionId, detail: { stopReason: stopReason ?? null, source } })
      return { action: 'skipped', reason: 'no-task' }
    }
    const from = task.status
    if (from !== 'running') {
      // B1 时序修复：结算只改 running 的状态，但「最后一条消息」与状态无关。
      // task_report done 会先把任务落到 done（tools.js），本回合结束时到达的 settle 一直被
      // 这里的闸门挡掉，导致 last_message 永远为空（真实台账 104 条 done 全缺）。
      // delivered / done 上只补写消息：不动状态、不发通知、不写 settle 行、不释放会话。
      if (from === 'delivered' || from === 'done') {
        const lateText = typeof lastMessage === 'string' && lastMessage !== ''
          ? messageText(lastMessage)
          : messageText(output)
        const captured = lateText === '' ? null : persistLastMessage(task, { text: lateText, stopReason: stopReason ?? null, source })
        if (captured !== null) {
          log('task.settle.late-message', {
            taskId: task.id,
            sessionId: task.session_id ?? sessionId,
            detail: {
              status: from,
              stopReason: stopReason ?? null,
              source,
              lastMessage: { stored: captured.record.stored, bytes: captured.record.bytes, chars: captured.record.chars },
            },
          })
          return {
            action: 'captured',
            taskId: task.id,
            from,
            changed: captured.changed,
            lastMessage: {
              stored: captured.record.stored,
              bytes: captured.record.bytes,
              chars: captured.record.chars,
              path: captured.record.path ?? null,
              summary: captured.record.summary,
              digest: captured.record.digest,
            },
          }
        }
      }
      log('task.settle.ignored', { taskId: task.id, sessionId: task.session_id ?? sessionId, detail: { status: from, stopReason: stopReason ?? null, source } })
      return { action: 'skipped', reason: 'not-running', taskId: task.id, from }
    }
    const indexIncomplete = stopReason === 'completed' && Array.isArray(task.brief?.workspaceIndexEntries)
      && getSetting(db, workspaceIndexSavedKey(task.id)) === undefined
    const mapped = indexIncomplete
      ? { status: 'failed', reason: '工作区索引未完整持久化（缺少有效 workspace_index 回报），可用 task_message({ action: "retry" }) 重试', stopReason }
      : mapSettle(stopReason, { progressCount: task.progress_count ?? 0 })
    // P0-1：配了 checks 的任务，自然结束（completed）也必须先有**本轮**通过验收的证据，否则不落 delivered。
    // 只对 completed 生效：aborted/error/max-tokens/refusal 与「只报过 progress 的 orphaned」一概不碰。
    const gap = stopReason === 'completed' && mapped.status === 'delivered' ? acceptanceGapOf(task) : undefined
    const settledMap = gap === undefined ? mapped : { ...mapped, ...gap }
    if (gap !== undefined) {
      log('task.settle.acceptance-gap', {
        taskId: task.id,
        sessionId: task.session_id ?? sessionId,
        detail: { reason: gap.reason, attempts: task.attempts ?? 0, stopReason: stopReason ?? null, source },
      })
    }
    // 完整正文（不截断）先算出来：摘要给通知/死因与台账借条，正文本身留在宿主会话日志。
    const fullText = typeof lastMessage === 'string' && lastMessage !== '' ? messageText(lastMessage) : messageText(output)
    const summary = summarizeText(fullText)
    const extra = typeof error === 'string' && error !== '' ? error : ''
    const detail = settledMap.reason ?? ''
    const errorText = [detail, summary, extra].filter(part => part !== '').join('：').slice(0, 500) || null
    let next
    try {
      // delivered 不是失败：清掉 error；只有真正异常收场才写死因。
      const clearsError = settledMap.status === 'delivered' || settledMap.status === 'done'
      // v0.24：把 stopReason 落进 last_stop_reason —— failed/orphaned 之后 resume 的判定与文案都靠它，
      // 不必再翻 messages 去找 settle 行。
      next = transition(db, task.id, settledMap.status, {
        error: clearsError ? null : errorText,
        lastStopReason: settledMap.stopReason ?? null,
      })
    } catch (failure) {
      log('task.settle.transition-failed', {
        taskId: task.id,
        sessionId: task.session_id ?? sessionId,
        detail: { from, to: settledMap.status, error: failure?.message ?? String(failure), source },
      })
      return { action: 'failed', reason: 'transition-failed', taskId: task.id, from }
    }
    // B1：把返回消息的**借条**落进台账（P1：正文留在宿主会话日志，台账只存 digest + 摘要）。
    const captured = persistLastMessage(task, { text: fullText, stopReason: settledMap.stopReason, source })
    const lastMessageRecord = captured === null ? null : captured.record
    if (captured !== null) next = captured.task
    const note = detail !== '' ? detail : (summary !== '' ? summary : '子会话已结束')
    try {
      addMessage(db, task.id, {
        kind: 'settle',
        rendered: `[结算] ${statusLabel(settledMap.status)}：${note}`,
        meta: { stopReason: settledMap.stopReason, status: settledMap.status, source },
      })
    } catch (failure) {
      log('task.settle.message-failed', { taskId: task.id, detail: { error: failure?.message ?? String(failure) } })
    }
    // D5：先补齐产物、再发通知。之前这条顺序反了（先 notify 后 collect），
    // 导致「结算自动 done」的通知里永远没有产物、也就没有 present 交付指令。
    let final = next
    try {
      const refreshed = beforeNotify(next, settledMap.status)
      if (refreshed !== null && typeof refreshed === 'object') final = refreshed
    } catch (failure) {
      log('task.settle.before-notify-failed', { taskId: task.id, detail: { error: failure?.message ?? String(failure) } })
    }
    notify(final, settledMap.status, summary !== '' ? `${note}${detail === '' ? '' : `；${summary}`}` : (extra === '' ? note : `${note}；${extra}`))
    // 交付（delivered）也要释放可写根：交付即放手，同目录才能新建任务；追问投递成功时由
    // dispatch.send 幂等重建。goal 仍只留到真终态再收口（见 docs/ARCHITECTURE.md「两段式终态」）。
    if (RELEASING_STATUSES.has(settledMap.status) || settledMap.status === 'delivered') {
      try { releaseSession(task.session_id ?? task.target) } catch { /* 释放失败不影响已落库的终态 */ }
      if (RELEASING_STATUSES.has(settledMap.status)) {
        // G1：终态收敛平台 goal（done → complete；cancelled/failed/orphaned → clear）。
        // 回调内部吞错，不能因为 goal 服务缺席/失败回滚已完成的状态迁移。
        try { onTerminal(next, settledMap.status) } catch { /* goal 收口失败不影响结算 */ }
      }
    }
    try { pump() } catch { /* 队列补位失败不影响结算 */ }
    log('task.settle', {
      taskId: task.id,
      sessionId: task.session_id ?? sessionId ?? null,
      detail: {
        from, to: settledMap.status, stopReason: settledMap.stopReason, source,
        lastMessage: lastMessageRecord === null
          ? null
          : { stored: lastMessageRecord.stored, bytes: lastMessageRecord.bytes, chars: lastMessageRecord.chars },
      },
    })
    return {
      action: 'updated',
      taskId: task.id,
      from,
      to: settledMap.status,
      reason: settledMap.reason,
      stopReason: settledMap.stopReason,
      summary,
      lastMessage: lastMessageRecord === null ? null : {
        stored: lastMessageRecord.stored,
        bytes: lastMessageRecord.bytes,
        chars: lastMessageRecord.chars,
        path: lastMessageRecord.path ?? null,
        summary: lastMessageRecord.summary,
        digest: lastMessageRecord.digest,
      },
      task: final,
    }
  }

  /** activation.result 被拒（teardown 失败）：按 failed 记，死因带原始错误。 */
  const fail = ({ taskId, sessionId, error, source = 'dispatcher' } = {}) => report({
    taskId,
    sessionId,
    stopReason: 'error',
    error: `子会话结算失败：${error ?? '未知错误'}`,
    source,
  })

  return { report, fail, mapSettle }
}
