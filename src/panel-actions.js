// 面板动作：/api/orchestrator 的 stop/retry/message/detail/artifacts。
// 与工具层共享同一台账/队列/派发器；鉴权由连接层 owner-only 负责。
import { renderBrief } from './brief.js'
import {
  addMessage, clearTaskQuestion, createTask, getTask, listTasks, recentMessages, setTaskError,
  transition, touchTask, incrementAttempts,
} from './ledger.js'
import { dependencyState, validateDepends } from './deps.js'
import { taskLabel } from './task-label.js'

const TERMINAL = new Set(['done', 'cancelled', 'orphaned'])
const RETRYABLE = new Set(['failed', 'orphaned'])
const WAITING = new Set(['waiting_user', 'waiting_auth'])

const short = (value, max = 100) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function createPanelActions({ db, dispatcher, queue, config, coordinatorStatus, logger }) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志不能影响 UI 动作 */ }
  }
  const current = () => typeof coordinatorStatus === 'function' ? coordinatorStatus() : { id: undefined, live: true }
  const fail = error => ({ ok: false, error: String(error?.message ?? error) })

  const detailOf = taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return { ok: false, error: `没有任务 ${taskId ?? ''}` }
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
    if (task === undefined) return { ok: false, error: `没有任务 ${taskId ?? ''}` }
    if (TERMINAL.has(task.status)) return { ok: false, error: `任务「${taskLabel(task)}」已结束，无需停止` }
    if (task.target !== null && task.target !== undefined) {
      try { await dispatcher.stop(task.target) } catch (error) {
        log('ui.stop.failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
      }
    }
    queue.remove(task.id)
    try { transition(db, task.id, 'cancelled') } catch (error) { return fail(error) }
    try { dispatcher.releaseWritableRoots?.(task.session_id ?? task.target) } catch { /* ignore */ }
    log('ui.stop', { taskId: task.id })
    queue.pump()
    return { ok: true, taskId: task.id, status: 'cancelled' }
  }

  const retry = async taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return { ok: false, error: `没有任务 ${taskId ?? ''}` }
    if (!RETRYABLE.has(task.status)) {
      return { ok: false, error: `任务「${taskLabel(task)}」当前是 ${task.status}，只有 failed/orphaned 能重派` }
    }
    const duplicate = listTasks(db, { active: true })
      .find(item => item.title.trim() === task.title.trim() && item.goal.trim() === task.goal.trim())
    if (duplicate !== undefined) return { ok: false, error: `已有活跃任务「${taskLabel(duplicate)}」，未重复重派` }
    const depends = validateDepends(db, task.depends_on)
    if (depends.ok === false) return { ok: false, error: `不能重派：${depends.error}` }
    const status = current()
    if (status.live === false) return { ok: false, error: '主会话已失效，请从面板「打开主会话」重建' }
    const depState = dependencyState(db, { depends_on: depends.ids })
    const retried = createTask(db, {
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
    log('ui.retry', { taskId: retried.id, detail: { retryOf: task.id, status: retried.status } })
    if (retried.status === 'waiting_dep') return { ok: true, taskId: retried.id, status: retried.status }
    const outcome = await queue.enqueueAndPump(retried.id)
    if (outcome.task?.status === 'failed') return { ok: false, error: outcome.task.error ?? '子会话创建失败' }
    return { ok: true, taskId: retried.id, status: outcome.task?.status ?? 'pending' }
  }

  const message = async (taskId, text) => {
    const task = getTask(db, String(taskId ?? ''))
    const content = typeof text === 'string' ? text.trim() : ''
    if (task === undefined) return { ok: false, error: `没有任务 ${taskId ?? ''}` }
    if (content === '') return { ok: false, error: '消息不能为空' }
    if (TERMINAL.has(task.status)) return { ok: false, error: `任务「${taskLabel(task)}」已结束，不能续派` }
    if (task.status === 'waiting_dep') return { ok: false, error: '任务还在等待前置，依赖完成后才能续派' }
    if (task.status === 'pending' || task.target === null || task.target === undefined) {
      return { ok: false, error: '任务还没有子会话，先停止再重建' }
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
      return { ok: false, error: `续派失败：${reason}` }
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
