// 面板动作：/api/orchestrator 的 stop/retry/message/detail/artifacts/preview。
// 与工具层共享同一台账/队列/派发器；鉴权由连接层 owner-only 负责。
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { renderBrief } from './brief.js'
import {
  addMessage, clearTaskQuestion, createTask, findRecentDeliveredFollowup, getTask, listTasks,
  recentMessages, setMessageDelivery, setTaskError, transition, touchTask, incrementAttempts,
} from './ledger.js'
import { dependencyState, validateDepends } from './deps.js'
import { taskLabel } from './task-label.js'
import { statusLabel } from './state.js'
import { panelFailure } from './action-errors.js'
import { objectiveForMessage } from './goal.js'

const TERMINAL = new Set(['done', 'cancelled', 'orphaned'])
const RETRYABLE = new Set(['failed', 'orphaned'])
const WAITING = new Set(['waiting_user', 'waiting_auth'])
// message 幂等窗口：同任务、同文本、上一次已成功投递时，窗口内重复提交视为同一次操作。
// 窗口故意取短（面板双击/重试），代价是「3 秒内故意发两条一模一样的消息」会被吞掉（见 docs/LIMITATIONS.md）。
const MESSAGE_DEDUPE_MS = 3000
// 详情一次最多回 50 条消息、50 个下游任务；面板只展示最近 20 条消息（更早的靠台账/日志）。
const DETAIL_MESSAGE_LIMIT = 50
const DETAIL_DEPENDENT_LIMIT = 50
// 预览只读前 64 KiB：足够看文本产物，避免把大文件整个读进内存。
const PREVIEW_BYTES = 64 * 1024

const projectOf = task => {
  const dir = typeof task.target_dir === 'string' ? task.target_dir.trim() : ''
  if (dir === '') return null
  const tail = dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
  return tail === undefined || tail === '' ? dir : tail
}

const short = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 消息投递状态：pending 待发 / delivered 已投递 / failed 投递失败。
 *  新行带 meta.delivery；旧行（A3 之前）没有 meta，按紧随其后的 delivery_failed 行推断，
 *  没有任何失败行就按已投递算（与幂等查询 findRecentDeliveredFollowup 同口径）。 */
const messageDeliveries = rows => {
  const deliveries = rows.map(() => null)
  rows.forEach((row, index) => {
    if (row.kind !== 'delivery_failed') return
    // 失败行只归给最近的、还没定论的那条 followup；已经 delivered/failed 的不再改。
    for (let back = index - 1; back >= 0; back -= 1) {
      if (rows[back].kind !== 'followup') continue
      const stored = rows[back].meta?.delivery
      if (stored === 'delivered' || stored === 'failed') break
      deliveries[back] = 'failed'
      break
    }
  })
  return rows.map((row, index) => {
    if (row.kind !== 'followup') return null
    if (deliveries[index] !== null) return deliveries[index]
    const stored = row.meta?.delivery
    return stored === 'pending' || stored === 'delivered' || stored === 'failed' ? stored : 'delivered'
  })
}

export function createPanelActions({ db, dispatcher, queue, config, coordinatorStatus, logger, goalBridge }) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志不能影响 UI 动作 */ }
  }
  const current = () => typeof coordinatorStatus === 'function' ? coordinatorStatus() : { id: undefined, live: true }

  const detailOf = taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    // recentMessages 是倒序，翻成时间顺序再按「失败行跟随的 followup」推投递状态。
    const rows = recentMessages(db, task.id, DETAIL_MESSAGE_LIMIT).reverse()
    const deliveries = messageDeliveries(rows)
    const messages = rows.map((row, index) => ({
      seq: row.seq, kind: row.kind, text: row.rendered, at: row.at, delivery: deliveries[index],
    }))
    const dependencies = task.depends_on.map(id => {
      const dep = getTask(db, id)
      return dep === undefined
        ? { id, title: id, status: 'missing' }
        : { id, title: dep.title, status: dep.status, error: dep.error ?? null }
    })
    // 下游 = 依赖链上引用本任务的任务；失败会沿依赖链传播，面板要能看到「谁会被我拖住」。
    const dependents = listTasks(db, { active: false })
      .filter(item => item.depends_on.includes(task.id))
      .slice(0, DETAIL_DEPENDENT_LIMIT)
      .map(item => ({ id: item.id, title: item.title, status: item.status, error: item.error ?? null }))
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
        // 平台 goal 只读镜像：面板只展示，不提供暂停/恢复/清除动作。
        goalState: task.goal_state ?? null,
        count: {
          messages: messages.length,
          artifacts: task.artifacts.length,
          dependencies: dependencies.length,
          dependents: dependents.length,
        },
      },
      dependencies,
      dependents,
      messages,
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
          childSessionId: task.session_id ?? null,
          targetDir: task.target_dir ?? null,
          project: projectOf(task),
          path: artifact.path,
          label: artifact.label ?? '',
          exists: artifact.exists !== false,
          at: task.updated_at,
          group: task.group_id ?? null,
        })
      }
    }
    // 产物库按任务最近更新倒序；同时回传项目/分组/会话，前端可切「项目 / 日期」视图。
    items.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || left.path.localeCompare(right.path))
    return { ok: true, items: items.slice(0, max), total: items.length }
  }

  const preview = (taskId, path) => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    const target = typeof path === 'string' ? path : ''
    const artifact = task.artifacts.find(item => item?.path === target)
    if (artifact === undefined) return panelFailure('ARTIFACT_NOT_FOUND', { path: target })
    let stats
    try {
      stats = statSync(artifact.path)
    } catch {
      return panelFailure('ARTIFACT_MISSING', { path: artifact.path })
    }
    if (stats.isDirectory()) return { ok: true, kind: 'directory', path: artifact.path, size: null, text: '' }
    if (!stats.isFile()) return panelFailure('ARTIFACT_NOT_FILE', { path: artifact.path })
    const length = Math.min(stats.size, PREVIEW_BYTES)
    const buffer = Buffer.alloc(length)
    let fd
    let read = 0
    try {
      fd = openSync(artifact.path, 'r')
      read = readSync(fd, buffer, 0, length, 0)
    } catch (error) {
      return panelFailure('ARTIFACT_READ_FAILED', { reason: error?.message ?? error })
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* 关闭失败不覆盖已读内容 */ }
      }
    }
    const body = buffer.subarray(0, read)
    if (body.includes(0)) {
      return { ok: true, kind: 'binary', path: artifact.path, size: stats.size, text: '', truncated: stats.size > read }
    }
    return {
      ok: true,
      kind: 'text',
      path: artifact.path,
      size: stats.size,
      truncated: stats.size > read,
      text: body.toString('utf8'),
    }
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
      try { await dispatcher.stop(task.target, task.id) } catch (error) {
        log('ui.stop.failed', { taskId: task.id, detail: { error: warn('STOP_DISPATCH_FAILED', error) } })
        void goalBridge?.clear?.(task.id, task.target)
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
    // G1：旧尝试进入终态，清掉平台 goal；新任务派发时会重新 create+disarm。
    void goalBridge?.clear?.(task.id, task.session_id)
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
    // followup 先落 pending（待发），投递成功改 delivered，失败改 failed 再补一行 delivery_failed。
    // 详情抽屉据此显示「待发/已投递/投递失败」，不必猜。
    const seq = addMessage(db, task.id, { kind: 'followup', rendered: content, meta: { delivery: 'pending' } })
    try {
      if (typeof dispatcher.sendReliable === 'function') {
        await dispatcher.sendReliable(task.target, content, undefined, task.target_dir, task.id, task.read_only === true, objectiveForMessage(task.goal, content))
      } else {
        await dispatcher.send(task.target, content)
      }
    } catch (error) {
      const reason = error?.message ?? String(error)
      setMessageDelivery(db, task.id, seq, 'failed', { error: reason })
      addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
      const latest = getTask(db, task.id)
      if (latest !== undefined && WAITING.has(latest.status)) setTaskError(db, task.id, reason)
      else if (latest !== undefined && latest.status === 'running') {
        try { transition(db, task.id, 'waiting_user', { error: reason }) } catch { /* ignore */ }
      }
      log('ui.message.failed', { taskId: task.id, detail: { error: reason } })
      return panelFailure('MESSAGE_DELIVERY_FAILED', { reason })
    }
    setMessageDelivery(db, task.id, seq, 'delivered')
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

  return { detail: detailOf, artifacts: artifactsOf, preview, stop, retry, message, short }
}

export { short as panelShort }
