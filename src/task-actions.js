// 通道共享的投递与占用机制；身份/文案适配仍留在工具和面板。
import { acquireWriteHold, releaseWriteHold, touchWriteHold } from './write-hold.js'
import { taskTargetDir } from './write-guard.js'
import { decideRegrant } from './write-gate.js'
import { WRITE_DOMAIN_DENIED } from './action-errors.js'
import { compactMessage } from './message-body.js'
import { dispatchReadOnly, needsPlanWriteSwitch } from './plan-mode.js'
import { objectiveForMessage } from './goal.js'
import { normalizeMessageId } from './dispatch.js'
import { resumeGate, resumePrompt } from './resume.js'
import { ensureArtifactDirectory } from './artifact-store.js'
import {
  addMessage, clearTaskQuestion, countTaskMessages, createTask, incrementAttempts, incrementResumeCount,
  markReportExpected, setMessageDelivery, touchTask, transition,
} from './ledger.js'

export const sendTaskMessage = (dispatcher, ...args) => (
  typeof dispatcher.sendReliable === 'function' ? dispatcher.sendReliable(...args) : dispatcher.send(...args)
)

/** 重派只复制已确认的任务参数；通道门控/去重/错误策略仍在调用方。 */
export function createRetryTask({ db, task, artifactRoot, coordinatorSession, targetDir, worktree, dependsOn, status, goalRounds, teamTask }) {
  return createTask(db, {
    artifactRoot, coordinatorSession, targetDir, worktree, dependsOn, status,
    brief: task.brief, readOnly: task.read_only === true,
    planFirst: task.plan_first === true, planState: task.plan_first ? 'planning' : 'none',
    access: task.access === 'full' ? 'full' : null, goalRounds, teamTask,
    retryOf: task.id, groupId: task.group_id, writeScopes: task.write_scopes, priority: task.priority,
  })
}

/** 停止投递失败仍继续取消；不同通道保留各自后续取消/幂等策略。 */
export async function stopTaskSession({ task, dispatcher, goalBridge, onError }) {
  if (task.target === null || task.target === undefined) return
  try { await dispatcher.stop(task.target, task.id) } catch (error) {
    onError(error)
    void goalBridge?.clear?.(task.id, task.target)
  }
}

export function holdTaskWrite(task, ownerToken, onError = () => {}) {
  acquireWriteHold({
    taskId: task.id, ownerToken, targetDir: taskTargetDir(task),
    writeScopes: task.write_scopes, checkoutPath: task.worktree_path,
  })
  const heartbeat = setInterval(() => {
    try { touchWriteHold(task.id, ownerToken) } catch { /* TTL 保守退化 */ }
  }, 30_000)
  heartbeat.unref?.()
  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    try { releaseWriteHold(task.id, ownerToken) } catch (error) { onError(error) }
  }
}

export async function resumeTask({ db, task, dispatcher, config, defaultDir, message = '', signal, holdToken, log = () => {} }) {
  const history = countTaskMessages(db, task.id)
  const gate = resumeGate(task, { history })
  const fail = (code, params = {}) => ({ ok: false, code, params, task })
  if (!gate.ok) {
    const codes = { closed: 'RESUME_CLOSED', no_session: 'RESUME_NO_SESSION', checkout_cleaned: 'RESUME_CHECKOUT_CLEANED', collecting: 'RESUME_COLLECTING' }
    return fail(codes[gate.reason] ?? 'RESUME_NOT_ALLOWED')
  }
  ensureArtifactDirectory(db, task, defaultDir)
  const body = resumePrompt(task, { history, message })
  const guard = decideRegrant({ db, task, kind: 'resume', mode: config?.sameDirGuard, fallbackTarget: defaultDir })
  if (guard.action === 'reject') {
    log('task.resume.rejected', { taskId: task.id, sessionId: task.session_id, detail: { mode: guard.mode, reason: guard.text } })
    return fail('RESUME_WRITE_CONFLICT', { reason: guard.text })
  }
  if (guard.note) log('task.resume.concurrent-write', { taskId: task.id, sessionId: task.session_id, detail: { mode: guard.mode } })
  const row = compactMessage('resume', body)
  const seq = addMessage(db, task.id, {
    kind: 'resume', rendered: row.rendered,
    meta: { ...row.meta, delivery: 'pending', from: task.status, stopReason: task.last_stop_reason },
  })
  const release = holdTaskWrite(task, holdToken, error => log('task.resume.hold-release-failed', { taskId: task.id, detail: { error: error.message } }))
  let messageId
  try {
    messageId = normalizeMessageId(await sendTaskMessage(
      dispatcher, task.target, body, signal, taskTargetDir(task) || undefined, task.id,
      dispatchReadOnly(task), objectiveForMessage(task.goal, body), task.access === 'full' ? 'full' : undefined,
      { planApproved: needsPlanWriteSwitch(task), attemptKey: `resume:${task.id}:${seq}` },
    ))
  } catch (error) {
    const reason = error?.message ?? String(error)
    setMessageDelivery(db, task.id, seq, 'failed', { error: reason })
    if (error?.code === WRITE_DOMAIN_DENIED) return fail('RESUME_WRITE_CONFLICT', { reason })
    addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[续跑投递失败] ${reason}` })
    log('task.resume.failed', { taskId: task.id, sessionId: task.session_id, detail: { reason, from: task.status, history } })
    const unreachable = ['NOT_FOUND', 'SUBAGENT_NOT_FOUND', 'UNAUTHORIZED', 'CONTINUATION_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY'].includes(error?.code)
      || (!/未找到协调者会话/.test(reason) && /not a direct child|does not exist|doesn't exist|not found|会话不存在|子会话不可达/i.test(reason))
    return fail(unreachable ? 'RESUME_UNREACHABLE' : 'RESUME_DELIVERY_FAILED', { reason })
  } finally { release() }
  setMessageDelivery(db, task.id, seq, 'delivered', { messageId: messageId ?? null })
  transition(db, task.id, 'running', { error: null, lastStopReason: null, closeReason: null })
  clearTaskQuestion(db, task.id)
  markReportExpected(db, task.id)
  incrementAttempts(db, task.id)
  const updated = incrementResumeCount(db, task.id)
  touchTask(db, task.id)
  log('task.resume', { taskId: task.id, sessionId: task.session_id, detail: { from: task.status, history, stopReason: task.last_stop_reason } })
  return { ok: true, task: updated, history, warn: gate.warn }
}
