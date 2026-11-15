// 结算上报（S1）：子会话结束/中断时自动把台账从 running 推到终态。
// 事件源有两个，都只做同一件事（重复到达由状态机天然幂等）：
//   1) dispatch.js 的 subagent.settled / subagent.failed（本次派发的那次 activation）；
//   2) 平台 subagent/end 生命周期事件（含续派/冷恢复起的新 activation，见 docs/probes/stop-reason-probe.md）。
// stopReason 取值域来自平台类型：completed / aborted / error / max-tokens / refusal。
// B1：结算同时把子会话最后一条 assistant 消息落进台账（短内联 / 长写 reports 文件），
//     主会话用 task_status 就能读到全文，不必再打开子会话历史。
import { addMessage, findTaskBySession, getTask, setTaskLastMessage, transition } from './ledger.js'
import { captureLastMessage, messageText, summarizeText } from './last-message.js'
import { statusLabel } from './state.js'

/** stopReason → 台账终态与死因。completed 只在「没有只报 progress」时算完成。 */
export const SETTLE_MAP = {
  completed: { status: 'done', reason: null },
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
  if (known.status === 'done' && progressCount > 0) {
    return { status: 'orphaned', reason: PAUSED_REASON, stopReason }
  }
  return { ...known, stopReason }
}

const MAX_SUMMARY = 240

/** 从 ContentBlock[] 取可读摘要（平台 SubagentResult.output / lastAssistantMessage 都是这个形状）。 */
export function outputSummary(output, max = MAX_SUMMARY) {
  return summarizeText(messageText(output), max)
}

/**
 * 结算上报器。所有副作用（台账、消息、通知、可写根释放、队列补位）都在这里，调用方只喂事件。
 * 只认 running：waiting_user/waiting_auth 是故意停下的（子任务自己报了 blocked/needs_auth），
 * 终态任务也可能在 done 回报后再次 settle，这些都不改状态。
 */
export function createSettlementReporter({
  db,
  notifier,
  logger,
  labelFor,
  // B1：长返回消息的落盘目录（<state>/reports）；不给就一律内联进台账。
  reportsDir,
  releaseSession = () => {},
  pump = () => {},
  onTerminal = () => {},
} = {}) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不能打断结算 */ }
  }

  const notify = (task, status, summary) => {
    if (notifier === undefined) return
    try {
      notifier.push({
        taskId: task.id,
        title: task.title,
        displayName: typeof labelFor === 'function' ? labelFor(task) : task.title,
        readOnly: task.read_only === true,
        status,
        summary,
        system: true,
      })
    } catch (error) {
      log('task.settle.notify-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
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
      log('task.settle.ignored', { taskId: task.id, sessionId: task.session_id ?? sessionId, detail: { status: from, stopReason: stopReason ?? null, source } })
      return { action: 'skipped', reason: 'not-running', taskId: task.id, from }
    }
    const mapped = mapSettle(stopReason, { progressCount: task.progress_count ?? 0 })
    // 完整正文（不截断）先算出来：摘要给通知/死因，正文进台账或 reports 文件。
    const fullText = typeof lastMessage === 'string' && lastMessage !== '' ? messageText(lastMessage) : messageText(output)
    const summary = summarizeText(fullText)
    const extra = typeof error === 'string' && error !== '' ? error : ''
    const detail = mapped.reason ?? ''
    const errorText = [detail, summary, extra].filter(part => part !== '').join('：').slice(0, 500) || null
    let next
    try {
      next = transition(db, task.id, mapped.status, { error: mapped.status === 'done' ? null : errorText })
    } catch (failure) {
      log('task.settle.transition-failed', {
        taskId: task.id,
        sessionId: task.session_id ?? sessionId,
        detail: { from, to: mapped.status, error: failure?.message ?? String(failure), source },
      })
      return { action: 'failed', reason: 'transition-failed', taskId: task.id, from }
    }
    // B1：把完整返回消息落进台账（短消息内联，超 64KB 写 reports 文件只留路径 + 摘要）。
    // 失败只记日志：结算落库比「看得见最后一段话」优先，不能因此回滚终态。
    let lastMessageRecord = null
    try {
      lastMessageRecord = captureLastMessage({
        text: fullText,
        taskId: task.id,
        reportsDir,
        stopReason: mapped.stopReason,
        source,
      })
      if (lastMessageRecord !== null) {
        const updated = setTaskLastMessage(db, task.id, lastMessageRecord)
        if (updated !== undefined) next = updated
      }
    } catch (failure) {
      lastMessageRecord = null
      log('task.settle.last-message-failed', { taskId: task.id, detail: { error: failure?.message ?? String(failure) } })
    }
    const note = detail !== '' ? detail : (summary !== '' ? summary : '子会话已结束')
    try {
      addMessage(db, task.id, {
        kind: 'settle',
        rendered: `[结算] ${statusLabel(mapped.status)}：${note}`,
        meta: { stopReason: mapped.stopReason, status: mapped.status, source },
      })
    } catch (failure) {
      log('task.settle.message-failed', { taskId: task.id, detail: { error: failure?.message ?? String(failure) } })
    }
    notify(next, mapped.status, summary !== '' ? `${note}${detail === '' ? '' : `；${summary}`}` : (extra === '' ? note : `${note}；${extra}`))
    try { releaseSession(task.session_id ?? task.target) } catch { /* 释放失败不影响已落库的终态 */ }
    // G1：终态收敛平台 goal（done → complete；cancelled/failed/orphaned → clear）。
    // 回调内部吞错，不能因为 goal 服务缺席/失败回滚已完成的状态迁移。
    try { onTerminal(next, mapped.status) } catch { /* goal 收口失败不影响结算 */ }
    try { pump() } catch { /* 队列补位失败不影响结算 */ }
    log('task.settle', {
      taskId: task.id,
      sessionId: task.session_id ?? sessionId ?? null,
      detail: {
        from, to: mapped.status, stopReason: mapped.stopReason, source,
        lastMessage: lastMessageRecord === null
          ? null
          : { stored: lastMessageRecord.stored, bytes: lastMessageRecord.bytes, chars: lastMessageRecord.chars },
      },
    })
    return {
      action: 'updated',
      taskId: task.id,
      from,
      to: mapped.status,
      reason: mapped.reason,
      stopReason: mapped.stopReason,
      summary,
      lastMessage: lastMessageRecord === null ? null : {
        stored: lastMessageRecord.stored,
        bytes: lastMessageRecord.bytes,
        chars: lastMessageRecord.chars,
        path: lastMessageRecord.path ?? null,
        summary: lastMessageRecord.summary,
        digest: lastMessageRecord.digest,
      },
      task: next,
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
