// 面板动作：/api/orchestrator 的 stop/retry/message/detail/artifacts。
// 与工具层共享同一台账/队列/派发器；鉴权由连接层 owner-only 负责。
import { renderBrief } from './brief.js'
import {
  addMessage, clearTaskQuestion, createTask, findRecentDeliveredFollowup, getTask, listTasks,
  recentMessages, setTaskError, transition, touchTask, incrementAttempts,
} from './ledger.js'
import { dependencyState, validateDepends } from './deps.js'
import { taskLabel } from './task-label.js'
import { statusLabel } from './state.js'
import { panelFailure } from './action-errors.js'

const TERMINAL = new Set(['done', 'cancelled', 'orphaned'])
const RETRYABLE = new Set(['failed', 'orphaned'])
const WAITING = new Set(['waiting_user', 'waiting_auth'])
// message 幂等窗口：同任务、同文本、上一次已成功投递时，窗口内重复提交视为同一次操作。
// 窗口故意取短（面板双击/重试），代价是「3 秒内故意发两条一模一样的消息」会被吞掉（见 docs/LIMITATIONS.md）。
const MESSAGE_DEDUPE_MS = 3000

const short = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function createPanelActions({ db, dispatcher, queue, config, coordinatorStatus, logger }) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志不能影响 UI 动作 */ }
  }
  const current = () => typeof coordinatorStatus === 'function' ? coordinatorStatus() : { id: undefined, live: true }

  const detailOf = taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    const messages = recentMessages(db, task.id, 50).reverse()
    const dependencies = task.depends_on.map(id => {
      const dep = getTask(db, id)
      return dep === undefined
        ? { id, title: id, status: 'missing' }
        : { id, title: dep.title, status: dep.status, error: dep.error ?? null }
    })
    return {
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        targetDir: task.target_dir ?? null,
        target: task.target ?? null,
        readOnly: task.read_only === true,
        group: task.group_id ?? null,
        priority: task.priority ?? 0,
        dependsOn: task.depends_on,
        writeScopes: task.write_scopes,
        question: task.question ?? null,
        options: task.options,
        error: task.error ?? null,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        artifacts: task.artifacts,
        brief: task.brief,
        count: {
          messages: messages.length,
          artifacts: task.artifacts.length,
        },
      },
      dependencies,
      messages: messages.map(row => ({ kind: row.kind, text: row.rendered, at: row.at })),
    }
  }

  const artifactsOf = (limit = 200) => {
    const max = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 200
    const items = []
    for (const task of listTasks(db, { active: false })) {
      for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
        items.push({
          taskId: task.id,
          title: task.title,
          status: task.status,
          path: artifact.path,
          label: artifact.label ?? '',
          exists: artifact.exists !== false,
          at: task.updated_at,
          group: task.group_id ?? null,
        })
        if (items.length >= max) return { ok: true, items }
      }
    }
    return { ok: true, items }
  }

  const stop = async taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    // 幂等：已取消/已完成/已丢失都按成功返回（already:true），面板显示「已是该状态」而不是报错。
    if (TERMINAL.has(task.status)) {
      return { ok: true, taskId: task.id, status: task.status, already: true }
    }
    const warnings = []
    const warn = (code, error) => {
      const reason = error?.message ?? String(error)
      warnings.push({ code, error: reason })
      return reason
    }
    if (task.target !== null && task.target !== undefined) {
      try { await dispatcher.stop(task.target) } catch (error) {
        log('ui.stop.failed', { taskId: task.id, detail: { error: warn('STOP_DISPATCH_FAILED', error) } })
      }
    }
    try { queue.remove(task.id) } catch (error) {
      // 内存队列删不掉不阻断取消：任务已是 cancelled，pump 不会再派发它。
      log('ui.stop.queue.failed', { taskId: task.id, detail: { error: warn('STOP_QUEUE_FAILED', error) } })
    }
    try {
      transition(db, task.id, 'cancelled')
    } catch (error) {
      // 并发双 stop：另一个请求已迁到 cancelled，按幂等成功返回，不要把第二次点击报成失败。
      const latest = getTask(db, task.id)
      if (latest?.status === 'cancelled') {
        return { ok: true, taskId: task.id, status: 'cancelled', already: true, ...(warnings.length > 0 ? { warnings } : {}) }
      }
      return panelFailure('STOP_FAILED', { reason: error?.message ?? String(error) }, { taskId: task.id })
    }
    try { dispatcher.releaseWritableRoots?.(task.session_id ?? task.target) } catch (error) {
      log('ui.stop.release.failed', { taskId: task.id, detail: { error: warn('STOP_RELEASE_FAILED', error) } })
    }
    log('ui.stop', { taskId: task.id })
    try { queue.pump() } catch (error) {
      log('ui.stop.pump.failed', { taskId: task.id, detail: { error: warn('STOP_QUEUE_FAILED', error) } })
    }
    return { ok: true, taskId: task.id, status: 'cancelled', ...(warnings.length > 0 ? { warnings } : {}) }
  }

  const retry = async taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    // 门控：只允许 failed/orphaned；running/等待中/终态都不给重派。
    if (!RETRYABLE.has(task.status)) {
      return panelFailure('RETRY_NOT_ALLOWED', { label: taskLabel(task), statusLabel: statusLabel(task.status) })
    }
    // 幂等：同一失败任务已有活跃重派（pending/running/等待依赖/等待用户）→ 直接返回那一条，
    // 双击或两个面板同时点「重派」不会建出第二条。
    const existing = listTasks(db, { active: true }).find(item => item.retry_of === task.id)
    if (existing !== undefined) {
      return { ok: true, taskId: existing.id, status: existing.status, already: true, retryOf: task.id }
    }
    const duplicate = listTasks(db, { active: true })
      .find(item => item.title.trim() === task.title.trim() && item.goal.trim() === task.goal.trim())
    if (duplicate !== undefined) {
      return panelFailure('RETRY_DUPLICATE_ACTIVE', { label: taskLabel(duplicate), statusLabel: statusLabel(duplicate.status) })
    }
    const depends = validateDepends(db, task.depends_on)
    if (depends.ok === false) return panelFailure('RETRY_DEPENDS_INVALID', { reason: depends.error })
    const status = current()
    // 与工具层 task_retry 的口径差异：面板在主会话失效时先拒绝，避免建一条必失败的 ghost；
    // 工具层保持历史行为（创建后标 failed 再抛错），两边错误码/文案仍共用 action-errors。
    if (status.live === false) return panelFailure('MAIN_SESSION_UNAVAILABLE')
    const depState = dependencyState(db, { depends_on: depends.ids })
    let retried
    try {
      retried = createTask(db, {
        brief: task.brief,
        coordinatorSession: status.id ?? task.coordinator_session,
        targetDir: task.target_dir,
        readOnly: task.read_only === true,
        retryOf: task.id,
        dependsOn: depends.ids,
        groupId: task.group_id,
        writeScopes: task.write_scopes,
        priority: task.priority,
        status: depState.ready ? 'pending' : 'waiting_dep',
      })
      addMessage(db, retried.id, { kind: 'brief', rendered: `【任务编号】${retried.id}\n${renderBrief(task.brief)}` })
    } catch (error) {
      return panelFailure('RETRY_FAILED', { reason: error?.message ?? String(error) })
    }
    log('ui.retry', { taskId: retried.id, detail: { retryOf: task.id, status: retried.status } })
    if (retried.status === 'waiting_dep') return { ok: true, taskId: retried.id, status: retried.status }
    let outcome
    try {
      outcome = await queue.enqueueAndPump(retried.id)
    } catch (error) {
      // 排队/派发异常：任务已建，返回新任务 id 方便面板定位；错误码仍是 RETRY_FAILED。
      return panelFailure('RETRY_FAILED', { reason: error?.message ?? String(error) }, { taskId: retried.id })
    }
    if (outcome.task?.status === 'failed') {
      return panelFailure('RETRY_FAILED', { reason: outcome.task.error ?? '子会话创建失败' }, { taskId: retried.id })
    }
    return { ok: true, taskId: retried.id, status: outcome.task?.status ?? 'pending' }
  }

  const message = async (taskId, text) => {
    const task = getTask(db, String(taskId ?? ''))
    const content = typeof text === 'string' ? text.trim() : ''
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    if (content === '') return panelFailure('MESSAGE_EMPTY')
    if (TERMINAL.has(task.status)) {
      return panelFailure('MESSAGE_TASK_ENDED', { label: taskLabel(task), statusLabel: statusLabel(task.status) })
    }
    if (task.status === 'waiting_dep') {
      return panelFailure('MESSAGE_WAITING_DEP', { label: taskLabel(task), depends: task.depends_on.join('、') })
    }
    if (task.status === 'pending' || task.target === null || task.target === undefined) {
      return panelFailure('MESSAGE_NO_SESSION', { label: taskLabel(task) })
    }
    // 幂等：同任务 + 同文本 + 窗口内已成功投递过 → 视为同一次点击，不重复发、不重复累计 attempts。
    // 上一次投递失败（后面有 delivery_failed 行）不算成功，窗口内允许立刻重发。
    const dedupeMs = Number.isFinite(config?.messageDedupeMs)
      ? Math.max(0, Math.trunc(config.messageDedupeMs))
      : MESSAGE_DEDUPE_MS
    if (dedupeMs > 0) {
      const duplicate = findRecentDeliveredFollowup(db, task.id, content, Date.now() - dedupeMs)
      if (duplicate !== undefined) {
        log('ui.message.duplicate', { taskId: task.id, detail: { seq: duplicate.seq } })
        return { ok: true, taskId: task.id, already: true, duplicate: true }
      }
    }
    addMessage(db, task.id, { kind: 'followup', rendered: content })
    try {
      if (typeof dispatcher.sendReliable === 'function') {
        await dispatcher.sendReliable(task.target, content, undefined, task.target_dir, task.id, task.read_only === true)
      } else {
        await dispatcher.send(task.target, content)
      }
    } catch (error) {
      const reason = error?.message ?? String(error)
      addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
      const latest = getTask(db, task.id)
      if (latest !== undefined && WAITING.has(latest.status)) setTaskError(db, task.id, reason)
      else if (latest !== undefined && latest.status === 'running') {
        try { transition(db, task.id, 'waiting_user', { error: reason }) } catch { /* ignore */ }
      }
      log('ui.message.failed', { taskId: task.id, detail: { error: reason } })
      return panelFailure('MESSAGE_DELIVERY_FAILED', { reason })
    }
    touchTask(db, task.id)
    const latest = getTask(db, task.id)
    if (latest !== undefined && WAITING.has(latest.status)) {
      try { transition(db, task.id, 'running', { error: null }) } catch { /* ignore */ }
    }
    clearTaskQuestion(db, task.id)
    incrementAttempts(db, task.id)
    log('ui.message', { taskId: task.id })
    return { ok: true, taskId: task.id }
  }

  return { detail: detailOf, artifacts: artifactsOf, stop, retry, message, short }
}

export { short as panelShort }
