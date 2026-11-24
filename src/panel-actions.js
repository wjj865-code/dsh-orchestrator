// 面板动作：/api/orchestrator 的 stop/retry/message/delete/detail/artifacts/preview。
// 与工具层共享同一台账/队列/派发器；鉴权由连接层 owner-only 负责。
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { renderBriefForTask } from './brief.js'
import { compactMessage } from './message-body.js'
import { resolveLastMessage } from './last-message.js'
import {
  addMessage, clearTaskQuestion, createTask, deleteTask, findRecentDeliveredFollowup, getTask, listTasks,
  recentMessages, setMessageDelivery, setTaskError, transition, touchTask, incrementAttempts, markReportExpected,
} from './ledger.js'
import { dependencyState, validateDepends } from './deps.js'
import { taskLabel } from './task-label.js'
import { refsInText, taskRefInfo, taskRefTokenOfAny } from './task-ref.js'
import { ensureArtifactDirectory } from './artifact-store.js'
import { statusLabel } from './state.js'
import { panelFailure } from './action-errors.js'
// P0-2/P0-3：面板「追加」与 task_message 同口径——判定走 write-gate 门面（共用同一份判定 + 内存占位），
// 面板重派（retry）同样必须在建任务前判写域（以前这里完全绕过）。
import { decideCreate, decideFollowup, decideRegrant } from './write-gate.js'
import { acquireWriteHold, releaseWriteHold, touchWriteHold } from './write-hold.js'
import { WRITE_DOMAIN_DENIED } from './action-errors.js'
import { checkoutRejection, taskTargetDir } from './write-guard.js'
import { objectiveForMessage } from './goal.js'
// P0-4：面板**没有**批准入口（plan-approve 仍是 UNKNOWN_ENDPOINT 的反例清单），message 只记讨论/修订。
// 已批准计划任务的写入意图走 `send(..., { planApproved:true })`（授权在 post-send），面板不再有切沙箱前置。
import { dispatchReadOnly, isPlanTask, needsPlanWriteSwitch, planStateOf } from './plan-mode.js'
import { normalizeMessageId } from './dispatch.js'
import { PLAN_MESSAGE_NOTES } from './copy.js'
import { retryWorktreeOf } from './worktree.js'
import {
  ACTIVE_STATUSES, RETRYABLE_STATUSES, TERMINAL_STATUSES, canClose, canDelete, canFollowup,
  closeGate, deleteGate, followupGate, stopIsIdempotent,
} from './panel-gates.js'
import { statusesWith } from './status-facts.js'
import { CLOSE_REASONS, closeDelivered, closeReasonLabel } from './delivered.js'
// P2-3 交接契约 v1：抽屉里的交接对象与 task_status / JSONL 同源（src/handoff.js 是唯一字段真源）。
import { handoffOfTask } from './handoff.js'

// 状态集合一律从 status-facts 派生（唯一事实源）；本文件不再写本地 Set。
const TERMINAL = new Set(TERMINAL_STATUSES)
const ACTIVE = new Set(ACTIVE_STATUSES)
const RETRYABLE = new Set(RETRYABLE_STATUSES)
const WAITING = new Set(statusesWith('waiting'))
// 可续派（追问）的状态：投递成功后从这些状态回到 running（running 上续派不改状态，所以不是它）。
const RESUMABLE = new Set(statusesWith('resumable'))
// message 幂等窗口：同任务、同文本、上一次已成功投递时，窗口内重复提交视为同一次操作。
// 窗口故意取短（面板双击/重试），代价是「3 秒内故意发两条一模一样的消息」会被吞掉（见 docs/LIMITATIONS.md）。
const MESSAGE_DEDUPE_MS = 3000
// 详情一次最多回 50 条消息、50 个下游任务；面板只展示最近 20 条消息（更早的靠台账/日志）。
const DETAIL_MESSAGE_LIMIT = 50
const DETAIL_DEPENDENT_LIMIT = 50
// 详情里「消息正文提到的任务引用」索引上限：抽屉把这些 `tk-xxxxxx` 渲染成「名称」chip，
// 一条回复里可能引用很多任务，超过上限的仍按原样显示引用（不丢、只是不查表）。
const DETAIL_REF_LIMIT = 40
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

/** 续派门控的 reason → 面板错误码（工具层用同一 reason 映射到 toolFailure，判定本身在 panel-gates）。 */
const followupFailure = task => {
  const gate = followupGate(task)
  if (gate.ok === true) return undefined
  const label = taskLabel(task)
  const statusText = statusLabel(task.status)
  switch (gate.reason) {
    case 'waiting_dep':
      return panelFailure('MESSAGE_WAITING_DEP', { label, depends: task.depends_on.join('、') })
    // 排队/待派发/没有子会话：面板统一给「先停止再重建」，不细分排队位置（面板没有 ahead 信息）。
    case 'queued':
    case 'pending':
    case 'no_session':
      return panelFailure('MESSAGE_NO_SESSION', { label })
    case 'failed':
    case 'not_followable':
      return panelFailure('MESSAGE_NOT_FOLLOWABLE', { label, statusLabel: statusText })
    default:
      return panelFailure('MESSAGE_TASK_ENDED', { label, statusLabel: statusText })
  }
}

export function createPanelActions({ db, dispatcher, queue, config, coordinatorStatus, logger, goalBridge, cleanupWorktree, teamBoard, bodySource, defaultCwd }) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志不能影响 UI 动作 */ }
  }
  // F：面板动作的「无 target 归一目录」与工具层 defaultCwd 同源（message/retry 的写域判定用它）。
  const defaultDir = () => {
    try {
      const value = typeof defaultCwd === 'function' ? defaultCwd() : defaultCwd
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }
  const current = () => typeof coordinatorStatus === 'function' ? coordinatorStatus() : { id: undefined, live: true }
  // 正文读取器（P1）：细节接口按需冷读宿主会话日志；没装配时一律按摘要降级（不报错）。
  const readBody = task => resolveLastMessage(task.last_message, { body: bodySource, sessionId: task.session_id })
  // P2-4（D6）：官方 Team 板关联视图。读失败只让这一块消失，不能让抽屉 500。
  const teamOf = task => {
    if (typeof teamBoard !== 'function') return null
    try { return teamBoard(task) } catch { return null }
  }

  const detailOf = taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    // recentMessages 是倒序，翻成时间顺序再按「失败行跟随的 followup」推投递状态。
    const rows = recentMessages(db, task.id, DETAIL_MESSAGE_LIMIT).reverse()
    const deliveries = messageDeliveries(rows)
    // P1：正文类消息在台账里只有借条（`meta.body === 'host'`）；旧行 meta 里没有这个标记 = 自带全文。
    const messages = rows.map((row, index) => ({
      seq: row.seq,
      kind: row.kind,
      text: row.rendered,
      at: row.at,
      delivery: deliveries[index],
      body: row.meta?.body === 'host' ? 'host' : 'inline',
      ...(row.meta?.body === 'host' && Number.isFinite(row.meta?.chars) ? { chars: row.meta.chars } : {}),
    }))
    const dependencies = task.depends_on.map(id => {
      const dep = getTask(db, id)
      // R1：前置任务查不到时**不回落内部编号**（`t-xxxx` 只该留在台账/日志）。带上它的引用
      // （墓碑引用也带上）与一句可读占位，面板就能显示「（任务已删除）tk-xxxxxx」。
      return dep === undefined
        ? { id, ref: taskRefTokenOfAny(db, id), title: '', status: 'missing', deleted: true }
        : { id, ref: dep.ref ?? null, title: dep.title, status: dep.status, error: dep.error ?? null }
    })
    // 下游 = 依赖链上引用本任务的任务；失败会沿依赖链传播，面板要能看到「谁会被我拖住」。
    const dependentTasks = listTasks(db, { active: false }).filter(item => item.depends_on.includes(task.id))
    const dependents = dependentTasks
      .slice(0, DETAIL_DEPENDENT_LIMIT)
      .map(item => ({ id: item.id, ref: item.ref ?? null, title: item.title, status: item.status, error: item.error ?? null }))
    // R3：消息正文里的 `tk-xxxxxx` 要在抽屉里显示成任务名（而不是一串引用）——这里把出现过的引用
    // 按台账现名解析一次，随详情下发。已删除任务（引用置墓碑）如实标 deleted=true，客户端据此
    // 把它原样显示并提示「引用已失效」；查不到的引用不在索引里，客户端同样原样显示。
    const refs = []
    for (const row of rows) {
      for (const token of refsInText(row.rendered, { limit: DETAIL_REF_LIMIT })) {
        if (refs.some(item => item.ref === token)) continue
        const info = taskRefInfo(db, token)
        const target = info === null ? undefined : getTask(db, info.taskId)
        refs.push(target === undefined
          ? { ref: token, title: '', status: 'missing', deleted: info === null ? false : info.retired }
          : { ref: token, title: target.title, status: target.status, deleted: false })
      }
    }
    // 活跃下游会挡住删除：与 snapshot/动作同源（panel-gates.deleteGate）。
    const activeDependents = dependentTasks.filter(item => ACTIVE.has(item.status)).length
    return {
      ok: true,
      task: {
        id: task.id,
        // 版本 B：抽屉「引用」一栏显示 tk-；`id` 仍是动作键（不渲染）。
        ref: task.ref ?? null,
        title: task.title,
        goal: task.goal,
        status: task.status,
        targetDir: task.target_dir ?? null,
        target: task.target ?? null,
        readOnly: task.read_only === true,
        // P8：计划模式（面板小标 / 抽屉概览/状态行）。
        planFirst: task.plan_first === true,
        planState: planStateOf(task),
        // P9：worktree 隔离（抽屉概览显示分支/检出/基线/决定者；普通任务 worktreeState='none'）。
        worktreeState: task.worktree_state ?? 'none',
        worktreeBranch: task.worktree_branch ?? null,
        worktreePath: task.worktree_path ?? null,
        worktreeBase: task.worktree_base ?? null,
        worktreeSource: task.worktree_source ?? 'default',
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
        artifactDir: task.artifact_dir,
        artifactStoreDir: task.artifact_store_dir,
        artifactStage: task.artifact_stage,
        deliveryPending: task.delivery_pending !== null,
        brief: task.brief,
        // 平台 goal 只读镜像：面板只展示，不提供暂停/恢复/清除动作。
        goalState: task.goal_state ?? null,
        // B1 最新返回消息：台账只存借条（P1）；正文由 detailBody 冷读宿主会话日志后补 `text`。
        lastMessage: task.last_message ?? null,
        // delivered 两段式：交付时间与关闭原因（协调者确认 / 超时自动完成）；旧行都是 null。
        deliveredAt: task.delivered_at ?? null,
        closeReason: task.close_reason ?? null,
        closeReasonLabel: task.close_reason === null || task.close_reason === undefined ? null : closeReasonLabel(task.close_reason),
        // P2-3 交接契约 v1：完整交接对象（谁/何时确认、轮次、验收与产物证据）；没交付过是 null。
        handoff: handoffOfTask(db, task),
        // P2-4（D6）：官方 Team 板关联视图（台账 id/revision + 官方当前行，只读）；没关联是 null。
        // 读不到官方板时退化成「只有台账那一半 + degraded」，抽屉照样能打开。
        teamTask: teamOf(task),
        // P2-1 A1：交付前机器验收的完整证据（spec + 每条 check 的退出码/耗时/输出尾部）；没跑过是 null。
        acceptance: task.acceptance ?? null,
        // 面板按钮可见性与动作门控同源（src/panel-gates.js）：前端只读这三个字段，不抄状态表。
        canFollowup: canFollowup(task),
        canClose: canClose(task),
        canDelete: canDelete(task, { activeDependents }),
        count: {
          messages: messages.length,
          artifacts: task.artifacts.length,
          dependencies: dependencies.length,
          dependents: dependents.length,
        },
      },
      dependencies,
      dependents,
      // R3：消息里提到的引用 → 台账现名/墓碑状态（客户端 RefText 查表用，不认识的引用原样显示）。
      refs,
      messages,
    }
  }

  /**
   * 面板详情 + 正文（P1 读侧）：在同步 `detailOf` 之上按需冷读宿主会话日志，把
   * `lastMessage.text` 填成全文，并给出 `body:{source, unavailable?}` 说明来源。
   *
   * 为什么不在 `detailOf` 里直接 await：面板动作层其余入口（stop/retry/message/delete）
   * 与测试都用同步详情；把异步只留在这一条读路径上，失败时仍能拿到「只有摘要」的完整抽屉。
   */
  const detailBody = async taskId => {
    const base = detailOf(taskId)
    if (base?.ok !== true) return base
    const task = getTask(db, base.task.id)
    if (task === undefined) return base
    const resolved = await readBody(task)
    return {
      ...base,
      task: {
        ...base.task,
        lastMessage: task.last_message === null || task.last_message === undefined
          ? null
          : { ...task.last_message, ...(resolved === null ? {} : { text: resolved.text }) },
      },
      // 读侧降级口径：source=host（宿主会话日志冷读）/ inline|file（旧行自带正文）/
      // summary（读不到，只剩摘要 + unavailable）。
      body: resolved === null
        ? { source: 'none' }
        : { source: resolved.source, ...(resolved.unavailable === undefined ? {} : { unavailable: resolved.unavailable }) },
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
    // 幂等：已收尾（done/failed/cancelled/orphaned）都按成功返回（already:true），
    // 面板显示「已是该状态」而不是报错。
    // 判据是 `releases` 能力，不是「流程终态」：0.19.x 用后者（不含 failed），于是对失败任务再点
    // 「停止」会走 failed → cancelled，把「失败」抹成「已取消」（审计 §2.3.2 第 3 条，可触发）。
    if (stopIsIdempotent(task)) {
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
    // S10'：stop 是终态动作，允许**无 token 强清**该任务的全部占位（不在途投递会由 dispatch.stop 收口）。
    try { releaseWriteHold(task.id) } catch { /* 占位释放失败只影响 TTL */ }
    // P9：终态按 worktreeCleanup 档位清理（默认 off = 全保留）。
    try { cleanupWorktree?.(getTask(db, task.id) ?? task) } catch (error) {
      log('ui.stop.cleanup.failed', { taskId: task.id, detail: { error: warn('STOP_CLEANUP_FAILED', error) } })
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
    // 与工具层重派（task_message action:retry）的口径差异：面板在主会话失效时先拒绝，避免建一条必失败的 ghost；
    // 工具层保持历史行为（创建后标 failed 再抛错），两边错误码/文案仍共用 action-errors。
    if (status.live === false) return panelFailure('MAIN_SESSION_UNAVAILABLE')
    const depState = dependencyState(db, { depends_on: depends.ids })
    // P9：隔离任务重派复用原检出（与工具层重派同一口径，见 worktree.js retryWorktreeOf）。
    const retryWorktree = retryWorktreeOf(task)
    const retryTarget = retryWorktree === null ? task.target_dir : (task.brief?.target ?? task.target_dir)
    // P0-2：面板「重派」等于给新任务写权限——以前完全绕过判定（工具层那侧也只有 task_create 判）。
    // 与工具层同一条门面、同一个同步段（判定 + createTask 之间没有 await）。
    const isolatedRetry = retryWorktree !== null
    const retryGuard = decideCreate({
      db,
      // F：无 target 的老任务按协调者 cwd 归一（与工具层重派同口径）。
      target: retryTarget ?? defaultDir(),
      scopes: task.write_scopes,
      dependsOn: depends.ids,
      mode: config?.sameDirGuard,
      skipChecks: isolatedRetry || task.read_only === true,
    })
    if (retryGuard.action === 'reject') {
      log('ui.retry.rejected', {
        taskId: task.id,
        detail: {
          reason: retryGuard.targetConflicts.length > 0 ? 'same-dir' : 'write-scope',
          mode: retryGuard.mode,
          targetDir: retryTarget ?? null,
          conflicts: [...retryGuard.targetConflicts, ...retryGuard.scopeConflicts].map(({ task: item }) => item.id),
        },
      })
      return panelFailure('RETRY_WRITE_CONFLICT', { label: taskLabel(task), reason: retryGuard.text })
    }
    if (retryGuard.note !== '') {
      log('ui.retry.concurrent-write', { taskId: task.id, detail: { mode: retryGuard.mode, targetDir: retryTarget ?? null } })
    }
    // 复用检出被另一条活跃任务占着 → 拒绝（两个子会话会互相踩 git 索引）。
    if (isolatedRetry && retryWorktree.state === 'reused') {
      const regrant = decideRegrant({ db, task, kind: 'retry', mode: config?.sameDirGuard, fallbackTarget: defaultDir() })
      if (regrant.action === 'reject' && regrant.checkoutConflicts.length > 0) {
        return panelFailure('RETRY_WRITE_CONFLICT', {
          label: taskLabel(task),
          reason: checkoutRejection({ path: retryWorktree.path, conflicts: regrant.checkoutConflicts }),
        })
      }
    }
    // G1：旧尝试进入终态，清掉平台 goal；新任务派发时会重新 create+disarm。
    void goalBridge?.clear?.(task.id, task.session_id)
    let retried
    try {
      retried = createTask(db, {
        artifactRoot: defaultDir(),
        brief: task.brief,
        coordinatorSession: status.id ?? task.coordinator_session,
        targetDir: retryTarget,
        readOnly: task.read_only === true,
        // P8：计划任务重派后重新走计划阶段（新会话要重新探索/批准）。
        planFirst: task.plan_first === true,
        planState: task.plan_first === true ? 'planning' : 'none',
        // per-task 访问级别跟着原任务走（与工具层重派同口径）。
        access: task.access === 'full' ? 'full' : null,
        worktree: retryWorktree,
        retryOf: task.id,
        dependsOn: depends.ids,
        groupId: task.group_id,
        writeScopes: task.write_scopes,
        priority: task.priority,
        status: depState.ready ? 'pending' : 'waiting_dep',
      })
      // T1：面板重派与 task_create 同口径——brief 只留任务编号 + task_detail 指引。
      // P1：正文不进台账（借条 = digest + 摘要）。
      const briefBody = compactMessage('brief', renderBriefForTask(retried))
      addMessage(db, retried.id, { kind: 'brief', rendered: briefBody.rendered, meta: briefBody.meta })
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
      // P9：重派也可能在建检出之后失败 → 按档位清理（默认 off = 保留）。
      try { cleanupWorktree?.(outcome.task) } catch { /* 清理失败只影响磁盘 */ }
      // 终态：强清新任务的占位（旧任务在失败态也无法再投递）——S10' 允许终态无 token 释放。
      try { releaseWriteHold(retried.id) } catch { /* ignore */ }
      return panelFailure('RETRY_FAILED', { reason: outcome.task.error ?? '子会话创建失败' }, { taskId: retried.id })
    }
    return { ok: true, taskId: retried.id, status: outcome.task?.status ?? 'pending' }
  }

  const message = async (taskId, text, requestId) => {
    const task = getTask(db, String(taskId ?? ''))
    const content = typeof text === 'string' ? text.trim() : ''
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    if (content === '') return panelFailure('MESSAGE_EMPTY')
    // 与面板按钮同源（panel-gates.followupGate）：终态/等前置/待派发/失败/无会话一律拒绝。
    const denied = followupFailure(task)
    if (denied !== undefined) return denied
    ensureArtifactDirectory(db, task, defaultDir())
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
    // P0-3：与工具层 task_message 同口径——交付过的任务写根已释放，追问前复判写域；
    // 被占用就不投递、不改状态、不写 followup 行（否则面板会绕过并发判定）。
    const guard = decideFollowup({ db, task, mode: config?.sameDirGuard, fallbackTarget: defaultDir() })
    if (guard.action === 'reject') {
      log('ui.message.rejected', {
        taskId: task.id,
        detail: {
          mode: guard.mode,
          targetDir: task.target_dir ?? null,
          conflicts: [...guard.targetConflicts, ...guard.scopeConflicts, ...guard.checkoutConflicts].map(({ task: item }) => item.id),
        },
      })
      return panelFailure('MESSAGE_WRITE_CONFLICT', { label: taskLabel(task), reason: guard.text })
    }
    if (guard.note !== '') {
      log('ui.message.concurrent-write', {
        taskId: task.id,
        detail: {
          mode: guard.mode,
          targetDir: task.target_dir ?? null,
          conflicts: [...guard.targetConflicts, ...guard.scopeConflicts, ...guard.checkoutConflicts].map(({ task: item }) => item.id),
        },
      })
    }
    // followup 先落 pending（待发），投递成功改 delivered，失败改 failed 再补一行 delivery_failed。
    // 详情抽屉据此显示「待发/已投递/投递失败」，不必猜。
    // P1-4（审计 2026-11-23）：借条行先落、hold 后占 —— addMessage 抛错时不再泄漏 hold 与 30s 心跳。
    // 已批准计划任务：写权限在 dispatch.send 的 post-send 授予（投递即记账，投递前不再切沙箱）。
    const planApproved = needsPlanWriteSwitch(task)
    // P1：正文不进台账（真源 = 子会话在宿主的 user/message），只留 digest + 摘要。
    const panelBody = compactMessage('followup', content)
    const seq = addMessage(db, task.id, { kind: 'followup', rendered: panelBody.rendered, meta: { ...(panelBody.meta ?? {}), delivery: 'pending' } })
    // guard 通过 → 先占住写域（内存 hold，owner token = panel:<requestId>），再 await 投递；
    // 失败/成功都只释放自己那一条（工具同时投递时不会互放）。
    const holdToken = `panel:${typeof requestId === 'string' && requestId !== '' ? requestId : randomUUID()}`
    acquireWriteHold({
      taskId: task.id,
      ownerToken: holdToken,
      targetDir: taskTargetDir(task),
      writeScopes: task.write_scopes,
      checkoutPath: task.worktree_path,
    })
    const heartbeat = setInterval(() => {
      try { touchWriteHold(task.id, holdToken) } catch { /* 续期失败只影响 TTL */ }
    }, 30_000)
    heartbeat.unref?.()
    let holdReleased = false
    const releaseHold = () => {
      if (holdReleased) return
      holdReleased = true
      clearInterval(heartbeat)
      try { releaseWriteHold(task.id, holdToken) } catch { /* 释放失败只影响占位时长 */ }
    }
    let messageId
    try {
      // P2（审计）：没有 sendReliable 的回退也必须带全参数——少传 targetDir/readOnly/attemptKey 会绕过
      // 写域口径与幂等键（面板「追加」与工具 task_message 必须是同一条投递链）。
      // P0-2（审计）：计划任务未批准时按只读投递，否则批准前就会注册可写根。
      const sendArgs = [task.target, content, undefined, taskTargetDir(task) || undefined, task.id, dispatchReadOnly(task), objectiveForMessage(task.goal, content), task.access === 'full' ? 'full' : undefined, { planApproved, attemptKey: `followup:${task.id}:${seq}` }]
      const sent = typeof dispatcher.sendReliable === 'function'
        ? await dispatcher.sendReliable(...sendArgs)
        : await dispatcher.send(...sendArgs)
      messageId = normalizeMessageId(sent)
    } catch (error) {
      if (error?.code === WRITE_DOMAIN_DENIED) {
        setMessageDelivery(db, task.id, seq, 'failed', { error: error?.message ?? String(error) })
        addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${error?.message ?? error}` })
        log('ui.message.rejected', { taskId: task.id, detail: { reason: 'write-domain-denied' } })
        return panelFailure('MESSAGE_WRITE_CONFLICT', { label: taskLabel(task), reason: error?.message ?? String(error) })
      }
      const reason = error?.message ?? String(error)
      setMessageDelivery(db, task.id, seq, 'failed', { error: reason })
      addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
      const latest = getTask(db, task.id)
      // 待确认（delivered）上追问失败：交付结果还在，保持 delivered 只记原因（与工具层同口径）。
      if (latest !== undefined && (WAITING.has(latest.status) || latest.status === 'delivered')) setTaskError(db, task.id, reason)
      else if (latest !== undefined && latest.status === 'running') {
        try { transition(db, task.id, 'waiting_user', { error: reason }) } catch { /* ignore */ }
      }
      log('ui.message.failed', { taskId: task.id, detail: { error: reason } })
      return panelFailure('MESSAGE_DELIVERY_FAILED', { reason })
    } finally {
      releaseHold()
    }
    // —— post-send：消息已是事实，记账失败只 log（不能变成「投递失败」让用户重发）——
    let plan
    try {
      setMessageDelivery(db, task.id, seq, 'delivered', { messageId: messageId ?? null })
      touchTask(db, task.id)
      // 追问必达（与工具层 task_message 同口径）：面板「追加」投递成功 = 在等这条任务的下一条回报，
      // 下一份 progress 跳过通知水位立刻送达（t-99d4a98c）。
      markReportExpected(db, task.id)
      const latest = getTask(db, task.id)
      // 「待确认」上追问 = 回到 running 复用同一个子会话（可写根没释放）。
      if (latest !== undefined && RESUMABLE.has(latest.status)) {
        try { transition(db, task.id, 'running', { error: null }) } catch { /* ignore */ }
      }
      clearTaskQuestion(db, task.id)
      incrementAttempts(db, task.id)
      // P0-4：面板「追加」**不再批准计划**（用户 2026-11-23 拍板：面板不加批准入口、message 不改 plan_state）。
      // 与工具 message 同口径：只记讨论/修订，沙箱与 plan_state 都不动；批准只在协调者侧 task_message({action:'approve'})。
      if (isPlanTask(task)) {
        const planState = planStateOf(task)
        if (planState === 'planning' || planState === 'waiting_user' || planState === 'revising') {
          plan = {
            approved: false,
            revising: planState === 'waiting_user' || planState === 'revising',
            note: planState === 'planning' ? PLAN_MESSAGE_NOTES.discussion : PLAN_MESSAGE_NOTES.revising,
          }
        }
      }
    } catch (error) {
      log('ui.message.post-send-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
    }
    log('ui.message', { taskId: task.id })
    return {
      ok: true,
      taskId: task.id,
      ...(plan === undefined ? {} : { plan }),
      ...(guard.note === '' ? {} : { warning: guard.note }),
    }
  }

  // 确认交付（delivered → done）：与工具 task_message action:close 共用 closeDelivered，二次确认在 client。
  const close = async taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    const gate = closeGate(task)
    if (gate.ok !== true) {
      const statusText = statusLabel(task.status)
      return TERMINAL.has(task.status)
        ? panelFailure('CLOSE_TASK_ENDED', { label: taskLabel(task), statusLabel: statusText })
        : panelFailure('CLOSE_NOT_DELIVERED', { label: taskLabel(task), statusLabel: statusText })
    }
    const outcome = closeDelivered({
      db,
      taskId: task.id,
      reason: CLOSE_REASONS.coordinator,
      // P2-3：面板确认 = `panel`（与工具 coordinator / 超时 timeout 区分，落 accepted_by）。
      by: 'panel',
      releaseSession: target => { try { dispatcher.releaseWritableRoots?.(target) } catch { /* 释放失败不影响关闭 */ } },
      completeGoal: closed => { void goalBridge?.complete?.(closed.id, closed.session_id) },
      cleanupWorktree,
      pump: () => queue.pump(),
      logger,
    })
    if (outcome.ok !== true) {
      const latest = outcome.task ?? task
      return panelFailure('CLOSE_NOT_DELIVERED', { label: taskLabel(latest), statusLabel: statusLabel(latest.status) })
    }
    log('ui.close', { taskId: task.id, detail: { already: outcome.already === true } })
    return { ok: true, taskId: task.id, status: 'done', ...(outcome.already === true ? { already: true } : {}) }
  }

  // 删除任务（面板「删除子会话/任务」）：门控 = 终态 + 没有活跃下游依赖。
  // 二次确认在 client（confirmDelete）做；这里不信任前端，任何状态都重新判定。
  const remove = async taskId => {
    const task = getTask(db, String(taskId ?? ''))
    if (task === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    // 活跃下游依赖删掉前置后会变「缺前置」直接失败（deps.js 的 missing 分支），所以只挡活跃的。
    const dependents = listTasks(db, { active: true }).filter(item => item.depends_on.includes(task.id))
    const gate = deleteGate(task, { activeDependents: dependents.length })
    if (gate.ok !== true) {
      if (gate.reason === 'has_dependents') {
        const links = dependents.slice(0, 3).map(item => taskLabel(item)).join('、')
        return panelFailure('DELETE_HAS_ACTIVE_DEPENDENTS', {
          label: taskLabel(task),
          links: dependents.length > 3 ? `${links} 等 ${dependents.length} 个` : links,
        })
      }
      // 活跃任务先停止；unknown 状态按「不是终态」拒绝，不猜可删。
      return panelFailure('DELETE_TASK_ACTIVE', { label: taskLabel(task), statusLabel: statusLabel(task.status) })
    }
    const removed = deleteTask(db, task.id)
    if (removed === undefined) return panelFailure('TASK_NOT_FOUND', { taskId })
    log('ui.delete', { taskId: task.id, detail: { status: task.status, ...removed.deleted } })
    return { ok: true, taskId: task.id, deleted: removed.deleted }
  }

  return { detail: detailOf, detailBody, artifacts: artifactsOf, preview, stop, retry, message, close, delete: remove, short }
}

export { short as panelShort }
