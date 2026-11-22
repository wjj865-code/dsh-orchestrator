// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateBrief, renderBriefForTask, validateTargetDir } from './brief.js'
import { inferWorkspaceTarget } from './workspace-match.js'
import { INDEX_TITLE, registeredWorkspaces, loadWorkspaceIndex, saveWorkspaceIndex, workspaceIndexText } from './workspace-index.js'
import { fileURLToPath } from 'node:url'
import { taskLabel, taskLabelWithRef } from './task-label.js'
// 版本 B《ID 出口网关》：统一解析入口（先 t-xxxx 再 tk-）+ 写入前出口清洗。
import { TASK_REF_UNKNOWN, resolveTaskInput, taskRefOf } from './task-ref.js'
import { createUserFacingSanitizer } from './user-facing.js'
import { canTransition, statusLabel } from './state.js'
import { statusesWith } from './status-facts.js'
import { dependencyState, promoteDependents, upstreamBrief, validateDepends } from './deps.js'
import { renderTaskDetail } from './task-detail.js'
import {
  GLOBAL_PROJECT, LESSON_KIND, MAX_FACT_CHARS, MAX_WORKER_MEMORIES_PER_TASK, MEMORY_FACT_KINDS,
  MEMORY_SOURCE_WORKER, TASK_LOG_KIND, addMemory, buildLessonBlock, buildMemoryBlock, countWorkerMemories,
  distillLessons, distillText, memoryKindLabel, memoryTokens, projectKeyOf, remember, searchMemories, taskLogText,
} from './memory.js'
import {
  addMessage, createTask, findTaskBySession, getTask, listTasks, recentMessages, setMessageDelivery,
  setTaskAcceptance, setTaskArtifacts, setTaskError, setTaskWorktree, touchTask, transition, incrementAttempts,
  setTaskQuestion, clearTaskQuestion, recordProgress, mergeArtifacts, MAX_TASK_ARTIFACTS,
  countTaskMessages, incrementResumeCount, markReportExpected, clearReportExpected, setTaskPlanPath,
} from './ledger.js'
import {
  acceptanceFailureText, acceptancePassText, acceptanceStatusLines,
  checksOf, executionDirOf, normalizeChecks, runChecks, specOf,
} from './acceptance.js'
import { collectWorkspaceArtifacts } from './artifact-collect.js'
import { formatBytes, PREVIEW_CHARS, readLastMessage, resolveLastMessage } from './last-message.js'
// P1 去重：正文类消息只存借条（digest + 摘要），正文按需从宿主会话日志冷读。
import { compactMessage } from './message-body.js'
import { HOST_LOG_MISSING, renderReportText } from './session-body.js'
import { DEFAULT_LINES, MAX_LINES, readWorkspaceFile, renderWorkspaceRead } from './read-workspace.js'
import { registeredArtifacts } from './artifact-location.js'
import { preferenceSavedHint, projectPreferenceSavedHint, upsertPreference } from './preferences.js'
import { artifactLines } from './notify.js'
import { CLOSE_REASONS, DELIVERED_TIMEOUT_MINUTES, closeDelivered, closeReasonLabel } from './delivered.js'
// P2-3 交接契约 v1：`task_status` 的「交接」段与面板/JSONL 同源（src/handoff.js 是唯一字段真源）。
import { handoffOfTask, handoffStatusLines } from './handoff.js'
// P2-4（D6）：官方 Team 板只读关联（校验/展示在这里，反写在 closeDelivered 的 sink 里）。
import { TEAM_BOARD_UNAVAILABLE, teamLinkStatusLine } from './team-board.js'
import { toolFailure } from './action-errors.js'
import { objectiveForMessage, normalizeGoalRounds } from './goal.js'
import { followupGate, stopIsIdempotent } from './panel-gates.js'
// v0.24 resume：续跑的判定/阈值/投递文案单一来源（面板第二批与提示词都从这里取）。
import { RESUME_HISTORY_THRESHOLD, resumeGate, resumePrompt } from './resume.js'
import { approvePlan, approvalNote, isPlanTask, planListMarker, planStateOf, planStatusLine } from './plan-mode.js'
import { MAX_PLAN_CHARS, planSavedNote, writePlanDocument } from './plan-doc.js'
// P1-C 文案单源：计划阶段与「交付不是终态」的句子都在 src/copy.js，这里只拼装工具回执。
import {
  ACCESS_FULL, CHANGE_REVIEW_FIELDS, DELIVERY_LINES, PLAN_SAVE_TOOL_DESC, TASK_CHAIN_TOOL_DESC, TASK_CHAIN_WAITING_NOTE,
  deliveredReceiptNote, planCreateReceipt,
} from './copy.js'
import {
  branchChoiceText, branchNameFor, decideWorktreeFacts, decideWorktreeIntent, reusableCheckoutCandidates,
  notifyWorktreeOf, parseWorktreeRequest, worktreeListMarker, worktreeNoteLines, worktreeStatusLine,
} from './worktree-request.js'
import { checkoutPathFor, createWorktreeService, retryWorktreeOf } from './worktree.js'
import { ISOLATED_WORKTREE_STATES, checkoutRejection, decideFollowupGuard, decideWriteGuard, occupiesCheckout, serializedIdsOf } from './write-guard.js'
// 0.32.0 能力包工厂：工具定义在 src/pack/tool.js（参数校验 + 文案），闸门/回滚在 src/pack/service.js。
import { createCapabilityPackTool } from './pack/tool.js'

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
const str = description => ({ type: 'string', description })
const strList = description => ({ type: 'array', items: { type: 'string' }, description })
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value === undefined ? '' : String(value) }],
}

const MESSAGE_ACTIONS = ['message', 'resume', 'stop', 'retry', 'close']
const CONTEXT_MODES = ['history', 'project', 'workspaces']
const REPORT_STATUS = ['progress', 'done', 'blocked', 'needs_auth']
const MAX_ARTIFACTS = 20
const MAX_ARTIFACT_LABEL = 160
// 状态集合一律从 status-facts 派生（唯一事实源）。这里的名字只是「本文件怎么问」，
// 内容不再各写一份——0.19.x 的 `RESUME_STATUS` 就多写了一个永远进不去的 'failed'（死分支）。
const ACTIVE_STATUS = new Set(statusesWith('active'))
const WAITING_STATUS = new Set(statusesWith('waiting'))
// 可续派（追问）的状态：必须有活着的子会话可投递。delivered 是「已交付待确认」的追问窗口。
// 注意 `resumable` ≠ `followup`：running 上续派不改状态（否则会撞 `running → running`）。
const RESUME_STATUS = new Set(statusesWith('resumable'))
const TERMINAL_STATUS = new Set(statusesWith('terminal'))
const RETRYABLE_STATUS = new Set(statusesWith('retryable'))

const labelOf = statusLabel
const short = (value, max = 40) => {
  const text = String(value ?? '').split('\n')[0].trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// 子会话最新返回消息（B1）：台账里只有借条（P1：正文住宿主会话日志）。
// 默认给摘要/预览；include=full 时用读侧解析出的正文（resolved），读不到就显式降级为摘要。
function lastMessageLines(record, { full = false, resolved = null } = {}) {
  const where = record.stored === 'file'
    ? '全文存 reports 文件'
    : (record.stored === 'host' ? '正文在子会话（宿主会话日志）' : '内联存台账')
  const head = `最近返回（结算 ${record.stopReason ?? '未知'}｜${record.chars ?? '?'} 字｜${formatBytes(record.bytes)}｜${where}）：`
  const textOf = () => (resolved === null ? readLastMessage(record) : resolved.text)
  const degraded = resolved !== null && resolved.source === 'summary'
    ? `（正文不可读：${resolved.unavailable ?? HOST_LOG_MISSING}；以下只是摘要）`
    : ''
  if (full === true) {
    const text = textOf()
    return [head, ...(degraded === '' ? [] : [degraded]), text === '' ? '- 空' : text]
  }
  if (record.stored === 'file' && resolved === null) {
    return [head, `全文：${record.path ?? '(路径缺失)'}`, `摘要：${record.summary || '-'}`, '看全文：task_status 带 include=full']
  }
  const text = textOf()
  if (text.length <= PREVIEW_CHARS) return [head, ...(degraded === '' ? [] : [degraded]), text]
  return [
    head,
    ...(degraded === '' ? [] : [degraded]),
    `${text.slice(0, PREVIEW_CHARS)}…`,
    `（已截断，共 ${record.chars ?? text.length} 字；全文用 include=full）`,
  ]
}

function taskLine(db, task, { staleMinutes = 30 } = {}) {
  const planMarker = `${worktreeListMarker(task)}${planListMarker(task)}`
  // 权限标记：只读优先（互斥保证两者不会同时出现），完整访问在状态词后缀「·完整访问」。
  const stateLabel = task.read_only
    ? `${labelOf(task.status)}·只读`
    : `${labelOf(task.status)}${task.access === 'full' ? '·完整访问' : ''}`
  const parts = [
    `- ${taskLabelWithRef(task)}`,
    `${stateLabel}${planMarker}`,
    `子会话 ${task.target ?? '-'}`,
    `目标：${short(task.goal)}`,
  ]
  if (task.status === 'waiting_dep') {
    parts.push(`等前置 ${task.depends_on.length} 个${task.priority ? `｜P${task.priority}` : ''}`)
  }
  if (task.group_id) parts.push(`组 ${task.group_id}`)
  const latest = recentMessages(db, task.id, 1)[0]
  parts.push(`最近：${latest === undefined ? '-' : short(latest.rendered)}`)
  if (task.status === 'pending' && task.session_id === null) {
    parts.push(task.queued_at === null || task.queued_at === undefined ? '待派发' : '排队中（等并发槽位）')
  }
  if (ACTIVE_STATUS.has(task.status)) {
    const idleMs = Date.now() - task.last_event_at
    if (idleMs > staleMinutes * 60_000) parts.push(`⚠ 已 ${Math.floor(idleMs / 60_000)} 分钟无动静`)
  }
  return parts.join('｜')
}

export function createTools({ db, dispatcher, queue, notifier, config, coordinatorStatus, logger, workspaces, defaultCwd, sessionQuery, sessions, bodySource, workspaceChanges, goalBridge, teamBoard, stateDir, worktree, cleanupWorktree, taskOfAgent, capabilityPacks, runAcceptance = runChecks }) {
  const staleMinutes = config?.staleMinutes ?? 30
  const coordinatorSession = config?.coordinatorSession ?? 'unknown'
  // P9：宿主侧 git 能力（测试注入 fake；生产用 execFile）。普通任务一次都不会调用它。
  const worktreeService = worktree ?? createWorktreeService({
    recentDays: config?.worktreeRecentDays ?? 7,
    log: (event, fields) => { try { logger?.log?.(event, fields) } catch { /* 日志不能打断主流程 */ } },
  })
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志绝不能打断主流程 */ }
  }
  // 对外显示名：重名短后缀要全量任务，统一用台账现查；通知的 displayName 也在这里算好。
  const labelFor = task => taskLabel(task, { all: listTasks(db) })
  // 版本 B《ID 出口网关》：**五个 task_* 工具的唯一解析入口**（先 t-xxxx，未命中再 tk-xxxxxx）。
  // 空值/未知值/已失效都给可读文案（不含表名/SQL/内部列名/裸编号），不做 session id 别名、不做空参绑定。
  const findTaskInput = raw => {
    const resolved = resolveTaskInput(db, raw)
    if (resolved.ok !== true) return { ok: false, message: resolved.message }
    const task = getTask(db, resolved.taskId)
    return task === undefined ? { ok: false, message: TASK_REF_UNKNOWN } : { ok: true, task }
  }
  // 出口清洗（第 ② 层，硬）：标题/摘要/问题/选项/计划正文**写入前**把台账已知编号换成 tk-。
  // 只认台账里存在的编号（不做泛化正则），命中记日志便于排查「模型从哪儿抄到的 id」。
  const sanitizeFacing = createUserFacingSanitizer({
    refOf: taskId => taskRefOf(db, taskId),
    onHit: (taskId, ref) => log('task.ref.sanitized', { taskId, detail: { ref } }),
  })
  const status = typeof coordinatorStatus === 'function'
    ? coordinatorStatus
    : () => ({ id: config?.coordinatorSession, live: true })
  // 记忆文件目录：插件唯一写入根（$DSH_HOME/state/orchestrator）；没给就退回内联记忆块。
  const lessonStateDir = stateDir ?? config?.stateDir
  const invalidHint = () => {
    const value = status()
    return value?.id !== undefined && value.live === false
      ? '主会话已失效，请从面板「打开主会话」重建。'
      : ''
  }
  const unbound = () => status().id === undefined
  const UNBOUND_HINT = '尚未打开主会话，请先从面板「打开主会话」。'
  const MAIN_ONLY_HINT = '请从主会话操作任务（面板「打开主会话」）。'
  // task_* 只允许主会话；task_report 属于子会话，不在这里拦。
  const requireMain = exec => {
    const current = status()
    if (current.id === undefined) return UNBOUND_HINT
    if (exec?.agent?.id !== current.id) return MAIN_ONLY_HINT
    return undefined
  }
  // 写记忆的角色口径（2026-11-21，用户方向：子会话执行任务时也读到很多项目背景与已有实践，应该能写项目记忆）：
  //   1. 协调者（主会话）：全局偏好 + 任意项目的 note/lesson/decision——原行为不变；
  //   2. 任务执行者（子会话）：只能写**自己任务 target_dir** 那个项目的 note/lesson/decision，单任务上限
  //      MAX_WORKER_MEMORIES_PER_TASK 条，行上记 `source='worker'` + taskId/sessionId；
  //      全局偏好（`kind:'preference'`）、`global` / 跨项目记忆、日志层一律拒绝，并给可执行替代路径。
  // 能力声明在预设层（worker 预设的 preset-tools 用 `keep` 正向声明 memory_note），这里做归属校验与硬护栏：
  // worker 的 project 只认台账 `tasks.target_dir`，不接受模型随便传（传错就拒，不静默纠正到别的项目）。
  const WORKER_MEMORY_FALLBACK = '替代做法：把结论写进 task_report 的 summary（协调者会看到并决定是否沉淀），'
    + '也可以让协调者用 memory_note 记（协调者可写全局偏好或指定项目）。'
  const rejectWorkerMemory = (exec, reason, text) => {
    log('memory.note.rejected', {
      agentId: exec?.agent?.id,
      detail: { reason, tool: 'memory_note', callId: exec?.callId },
    })
    return text
  }
  // 子会话 → 任务的归属解析：优先用 index.js 注入的映射（首回合台账 session_id 可能还没回写），
  // 再退回台账 tasks.session_id（唯一真相）。
  const taskOfWorker = agentId => {
    if (typeof agentId !== 'string' || agentId === '') return undefined
    let mapped
    try { mapped = typeof taskOfAgent === 'function' ? taskOfAgent(agentId) : undefined } catch { mapped = undefined }
    return mapped ?? findTaskBySession(db, agentId)
  }

  // 分组 / 写域 / 优先级：都只做轻量归一，非法值忽略。
  const normalizeGroup = value => {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text === '' ? null : text.slice(0, 80)
  }
  const normalizeScopes = value => {
    if (!Array.isArray(value)) return []
    const out = []
    for (const item of value) {
      if (typeof item !== 'string') continue
      const text = item.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (text === '' || out.includes(text)) continue
      out.push(text.slice(0, 200))
      if (out.length >= 20) break
    }
    return out
  }
  const normalizePriority = value => {
    if (!Number.isFinite(value)) return 0
    return Math.max(-10, Math.min(10, Math.trunc(value)))
  }
  const sameScope = (left, right) => left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`)
  // 旧的 advisory 口径（sameDirGuard=off 时保持原样）：只报写域重叠，不拦。
  const writeScopeConflicts = (scopes, excludeId) => {
    if (scopes.length === 0) return []
    const conflicts = []
    for (const task of listTasks(db, { active: true })) {
      if (task.id === excludeId) continue
      const other = Array.isArray(task.write_scopes) ? task.write_scopes : []
      const overlap = scopes.find(scope => other.some(candidate => sameScope(scope, candidate)))
      if (overlap !== undefined) conflicts.push({ task, scope: overlap })
      if (conflicts.length >= 5) break
    }
    return conflicts
  }
  const conflictsText = conflicts => conflicts.length === 0 ? ''
    : `写域与活跃任务冲突：${conflicts.map(({ task, scope }) => `${taskLabelWithRef(task)}（${scope}）`).join('、')}；建议拆分或串行。`


  const baseDirOf = task => {
    if (typeof task?.target_dir === 'string' && task.target_dir !== '') return task.target_dir
    let fallback
    try {
      fallback = typeof defaultCwd === 'function' ? defaultCwd(task) : defaultCwd
    } catch { fallback = undefined }
    return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
  }

  // 产物路径：相对路径按任务目录解析；非法条目静默丢弃；只 stat 存在性，不读文件、不让 report 失败。
  const normalizeArtifacts = (task, input, limit = MAX_ARTIFACTS) => {
    if (!Array.isArray(input)) return { artifacts: [], omitted: 0 }
    const max = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : MAX_ARTIFACTS))
    // 入口先截断，避免为几百条无关键做 resolve/stat。
    const entries = input.slice(0, max)
    const omitted = input.length - entries.length
    const base = baseDirOf(task)
    const out = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const raw = typeof entry.path === 'string' ? entry.path.trim() : ''
      if (raw === '') continue
      let absolute
      try {
        absolute = isAbsolute(raw) ? resolve(raw) : (base === undefined ? resolve(raw) : resolve(base, raw))
      } catch {
        continue
      }
      let exists = false
      try {
        const stats = statSync(absolute)
        exists = stats.isFile() || stats.isDirectory()
      } catch { exists = false }
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      out.push({ path: absolute, label: label.length > MAX_ARTIFACT_LABEL ? `${label.slice(0, MAX_ARTIFACT_LABEL)}…` : label, exists })
    }
    return { artifacts: out, omitted }
  }

  // done 自动收集：优先用回报方自己的 Session（事件最全）；测试/惰性场景再按 task.session_id 查 sessions 服务。
  const reportSession = (task, exec) => {
    const direct = exec?.agent?.session
    if (direct !== undefined && direct !== null) return direct
    try {
      const service = typeof sessions === 'function' ? sessions() : sessions
      return service?.get?.(task.session_id ?? '')
    } catch {
      return undefined
    }
  }
  const autoArtifacts = (task, exec) => {
    const session = reportSession(task, exec)
    if (session === undefined || session === null) return { artifacts: [], turns: 0, omitted: 0 }
    let service
    try {
      service = typeof workspaceChanges === 'function' ? workspaceChanges() : workspaceChanges
    } catch {
      service = undefined
    }
    return collectWorkspaceArtifacts({
      session,
      workspaceChanges: service,
      fallbackCwd: baseDirOf(task),
      max: MAX_TASK_ARTIFACTS,
    })
  }

  // 工作区服务用惰性 getter（index 传入），取不到就按「无工作区」降级，不影响派发。
  const workspaceList = () => {
    try {
      const service = typeof workspaces === 'function' ? workspaces() : workspaces
      const list = service?.list?.()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const defaultDir = () => {
    try {
      const value = typeof defaultCwd === 'function' ? defaultCwd() : defaultCwd
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    } catch {
      return undefined
    }
  }
  const workspaceForPath = path => {
    if (typeof path !== 'string' || path === '') return undefined
    const key = projectKeyOf(path)
    return workspaceList().find(item => typeof item?.path === 'string' && projectKeyOf(item.path) === key)
  }
  // project 参数可以是绝对目录，也可以是工作区显示名；工作区名走现有推断，不猜。
  // `known` 供 context history 用：未知名项目要报警告（P0-b），不能静默回落 global。
  const resolveProjectHint = hint => {
    const text = typeof hint === 'string' ? hint.trim() : ''
    if (text === '') return { key: GLOBAL_PROJECT, path: undefined, title: undefined, known: false }
    if (text.toLowerCase() === 'global') return { key: GLOBAL_PROJECT, path: undefined, title: 'global', known: true }
    if (isAbsolute(text)) {
      let exists = false
      try { exists = statSync(text).isDirectory() } catch { exists = false }
      const path = resolve(text)
      return {
        key: projectKeyOf(path),
        path: exists ? path : undefined,
        title: exists ? (workspaceForPath(path)?.title ?? basename(path)) : basename(path),
        exists,
        known: true,
      }
    }
    const match = inferWorkspaceTarget({ title: text, goal: text }, workspaceList())
    if (match.ok !== false && match.workspace !== undefined) {
      return {
        key: projectKeyOf(match.workspace.path),
        path: match.workspace.path,
        title: match.workspace.title,
        exists: true,
        known: true,
      }
    }
    // 匹配到多个工作区：不是「未知名」，要给「请传哪个绝对目录」的可执行提示。
    return {
      key: GLOBAL_PROJECT,
      path: undefined,
      title: text,
      known: false,
      ambiguous: match.ok === false
        ? (Array.isArray(match.candidates) ? match.candidates : []).map(item => `${item.title} → ${item.path}`)
        : undefined,
    }
  }
  const readProjectText = (path, max = 2000) => {
    try {
      const stats = statSync(path)
      if (!stats.isFile()) return ''
      return readFileSync(path, 'utf8').slice(0, max)
    } catch {
      return ''
    }
  }
  // 项目背景输出预算（P0 记忆优化）：总长受控；架构段默认只给开头，显式 include 才给前 4000 字。
  const MAX_PROJECT_CONTEXT_CHARS = 8000
  const PROJECT_DOC_DEFAULT_CHARS = 1200
  const PROJECT_DOC_INCLUDE_CHARS = 4000
  // project 白名单文档（含显式 include 的别名）——只有这些能被 include「加长」，其它路径一律不读。
  const PROJECT_INCLUDE_DOCS = Object.freeze({
    'docs/architecture.md': 'docs/ARCHITECTURE.md',
    architecture: 'docs/ARCHITECTURE.md',
    arch: 'docs/ARCHITECTURE.md',
  })
  /** include 归一：识别出的白名单文档集合 + 未识别的项（给一行提示，不静默）。 */
  const normalizeInclude = value => {
    const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : [])
    const docs = new Set()
    const unknown = []
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim() === '') continue
      const key = item.trim().toLowerCase().replace(/^\.?\//, '')
      const doc = PROJECT_INCLUDE_DOCS[key]
      if (doc === undefined) unknown.push(item.trim())
      else docs.add(doc)
    }
    return { docs, unknown }
  }
  const projectContextFor = (dir, query = '', { include } = {}) => {
    const projectKey = projectKeyOf(dir)
    const title = workspaceForPath(dir)?.title ?? basename(dir)
    const { docs: includeDocs, unknown: unknownIncludes } = normalizeInclude(include)
    const lines = [`【项目】${title}`, `【路径】${dir}`]
    const index = workspaceIndexText(loadWorkspaceIndex(db), dir)
    if (index !== '') lines.push(index)
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.name !== 'node_modules' && entry.name !== '.git' && !/^\.env/.test(entry.name))
        .slice(0, 30)
        .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      if (entries.length > 0) lines.push(`【顶层】${entries.join('  ')}`)
    } catch { /* 目录读不到就只给路径 */ }

    const pkg = readProjectText(join(dir, 'package.json'), 20_000)
    if (pkg !== '') {
      try {
        const parsed = JSON.parse(pkg)
        const deps = Object.keys(parsed?.dependencies ?? {}).slice(0, 15)
        const scripts = Object.keys(parsed?.scripts ?? {}).slice(0, 10)
        lines.push(`【技术栈】Node${parsed?.name === undefined ? '' : ` · ${parsed.name}`}${deps.length > 0 ? `；依赖：${deps.join(', ')}` : ''}`)
        if (scripts.length > 0) lines.push(`【脚本】${scripts.join(', ')}`)
      } catch { /* package.json 不合法就不当技术栈 */ }
    }
    for (const file of ['pyproject.toml', 'go.mod', 'Cargo.toml']) {
      const body = readProjectText(join(dir, file), 600)
      if (body !== '') {
        lines.push(`【${file}】\n${body.trim()}`)
        break
      }
    }
    const readme = readProjectText(join(dir, 'README.md'), 1800)
      || readProjectText(join(dir, 'README.zh-CN.md'), 1800)
    if (readme !== '') lines.push(`【README】\n${readme.trim()}`)
    const agents = readProjectText(join(dir, 'AGENTS.md'), 1800)
    if (agents !== '') lines.push(`【AGENTS】\n${agents.trim()}`)
    // 架构正本（审计 §5.1）：以前不在白名单里，70 KB 的决策文档永远不会被读到。
    // 默认只给开头 1200 字（不把 6000 字预算全吃掉）；显式 include 才给前 4000 字。
    const architectureFull = includeDocs.has('docs/ARCHITECTURE.md')
    const architectureChars = architectureFull ? PROJECT_DOC_INCLUDE_CHARS : PROJECT_DOC_DEFAULT_CHARS
    const architecture = readProjectText(join(dir, 'docs', 'ARCHITECTURE.md'), architectureChars)
    if (architecture !== '') {
      lines.push(`【架构】docs/ARCHITECTURE.md（前 ${architectureChars} 字${architectureFull ? '，include 显式包含' : '，要更多传 include: ["docs/ARCHITECTURE.md"]'}）\n${architecture.trim()}`)
    }

    const recent = listTasks(db, { active: false })
      .filter(task => projectKeyOf(task.target_dir) === projectKey)
      .slice(0, 5)
    if (recent.length > 0) {
      lines.push(`【最近任务】\n${recent.map(task => `- ${taskLabelWithRef(task)}｜${labelOf(task.status)}｜${short(task.goal, 60)}`).join('\n')}`)
    }
    const memoryBlock = buildMemoryBlock(db, { projectKey, query, limit: 3 })
    if (memoryBlock !== '') lines.push(memoryBlock)
    if (unknownIncludes.length > 0) {
      lines.push(`【提示】include 只支持 docs/ARCHITECTURE.md（收到：${unknownIncludes.join('、')}），其它文件不在白名单。`)
    }
    let text = lines.join('\n')
    if (text.length > MAX_PROJECT_CONTEXT_CHARS) text = `${text.slice(0, MAX_PROJECT_CONTEXT_CHARS - 1)}…`
    return text
  }

  // targetDir 用于续派前幂等补注册 target 可写根（resume 后 session 对象会换，旧授权不生效）。
  // readOnly 用于只读任务续派时幂等补设沙箱（只读任务不注册可写根）；access='full' 同理补设 danger-full-access。
  const sendFollowup = async (target, message, signal, targetDir, taskId, readOnly, objective, access) => {
    if (typeof dispatcher.sendReliable === 'function') return dispatcher.sendReliable(target, message, signal, targetDir, taskId, readOnly, objective, access)
    return dispatcher.send(target, message, signal, targetDir, taskId, readOnly, objective, access)
  }
  // 「已交付待确认」交付那一刻就释放可写根（同目录才能新建任务）；追问/续派投递成功后由
  // dispatch.send 幂等重建，真终态再兜一次释放。参数可以是任务行，也可以直接是子会话 id。
  const releaseTaskSession = task => {
    const id = typeof task === 'string' ? task : (task?.session_id ?? task?.target)
    if (id === null || id === undefined || id === '') return
    try {
      dispatcher.releaseWritableRoots?.(id)
    } catch { /* 释放失败不影响任务状态 */ }
  }

  // 子会话彻底不可达（被删/不是直接子级）才标 orphaned；协调者未加载不是孤儿。
  const UNREACHABLE_CODES = new Set([
    'NOT_FOUND', 'SUBAGENT_NOT_FOUND', 'UNAUTHORIZED', 'CONTINUATION_UNAVAILABLE', 'UNSUPPORTED_CAPABILITY',
  ])
  const isUnreachable = error => {
    if (UNREACHABLE_CODES.has(error?.code)) return true
    const message = error?.message ?? ''
    if (/未找到协调者会话/.test(message)) return false
    return /not a direct child|does not exist|doesn't exist|not found|会话不存在|子会话不可达/i.test(message)
  }

  const wrap = (name, description, parameters, execute) => ({
    name,
    description,
    parameters,
    output: textOutput,
    async execute(args = {}, exec = {}) {
      try {
        return await execute(args ?? {}, exec ?? {})
      } catch (error) {
        return `任务协调失败：${error?.message ?? error}`
      }
    },
  })

  // —— P1-B：合并工具的内部实现（工具面 15 → 10）——
  //
  // 收缩只换**入口**，不换语义：stop / retry / close / inbox / history / project 六段实现原样搬到这里，
  // 由 `task_message` 的 `action`、`task_list` 的 `view`、`context` 的 `mode` 分派。搬动时一个字都没改，
  // 所以「同 fixture 同输出」可断言（见 test/tools.test.js 的等价用例）；旧名已删，调用时由
  // index.js 的执行层 guard 返回可读迁移提示（src/tool-migrations.js）。

  // 追加消息（原 task_message 的实现，行为不变）。
  const messageTask = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    if (unbound()) return UNBOUND_HINT
    const found = findTaskInput(args.task_id)
    if (found.ok !== true) return found.message
    const task = found.task
    // 与面板「追加」按钮同源（src/panel-gates.js）：终态/等前置/待派发/失败/无会话各自给可执行提示。
    const gate = followupGate(task)
    if (gate.ok !== true) {
      if (gate.reason === 'waiting_dep') {
        return toolFailure('MESSAGE_WAITING_DEP', { label: labelFor(task), depends: task.depends_on.join('、') })
      }
      if (gate.reason === 'queued') {
        return toolFailure('MESSAGE_QUEUED', { label: labelFor(task), ahead: Math.max(queue.position(task.id) - 1, 0) })
      }
      if (gate.reason === 'failed' || gate.reason === 'not_followable') {
        return toolFailure('MESSAGE_NOT_FOLLOWABLE', { label: labelFor(task), statusLabel: labelOf(task.status) })
      }
      if (gate.reason === 'ended') {
        return toolFailure('MESSAGE_TASK_ENDED', { label: labelFor(task), statusLabel: labelOf(task.status) })
      }
      return toolFailure('MESSAGE_NO_SESSION', { label: labelFor(task) })
    }
    // P0-3：交付时已释放写根，追问会让原会话重新开工——投递前按 target / 写域复判（与面板「追加」同源）。
    // 被占用就不投递、不改状态、不写 followup 行：否则等于静默放行两个子会话写同一份工作树。
    const followupGuard = decideFollowupGuard({
      tasks: listTasks(db, { active: true }),
      task,
      mode: config?.sameDirGuard,
    })
    if (followupGuard.action === 'reject') {
      log('task.followup.rejected', {
        taskId: task.id,
        sessionId: task.session_id,
        detail: {
          mode: followupGuard.mode,
          targetDir: task.target_dir ?? null,
          conflicts: [...followupGuard.targetConflicts, ...followupGuard.scopeConflicts, ...followupGuard.checkoutConflicts].map(({ task: item }) => item.id),
          callId: exec?.callId,
        },
      })
      return toolFailure('MESSAGE_WRITE_CONFLICT', { label: labelFor(task), reason: followupGuard.text })
    }
    if (followupGuard.note !== '') {
      log('task.followup.concurrent-write', {
        taskId: task.id,
        sessionId: task.session_id,
        detail: {
          mode: followupGuard.mode,
          targetDir: task.target_dir ?? null,
          conflicts: [...followupGuard.targetConflicts, ...followupGuard.scopeConflicts, ...followupGuard.checkoutConflicts].map(({ task: item }) => item.id),
          callId: exec?.callId,
        },
      })
    }
    const message = args.message ?? ''
    // 与面板 message 同口径：先 pending，投递成功 delivered，失败 failed（详情抽屉显示三态）。
    // P1：正文不再进台账（真源是子会话在宿主的 user/message），这里只留 digest + 摘要。
    const followupBody = compactMessage('followup', message)
    const seq = addMessage(db, task.id, { kind: 'followup', rendered: followupBody.rendered, meta: { ...(followupBody.meta ?? {}), delivery: 'pending' } })
    try {
      await sendFollowup(task.target, message, exec?.signal, task.target_dir, task.id, task.read_only === true, objectiveForMessage(task.goal, message), task.access === 'full' ? 'full' : undefined)
    } catch (error) {
      const reason = error?.message ?? String(error)
      setMessageDelivery(db, task.id, seq, 'failed', { error: reason })
      addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
      const current = getTask(db, task.id)
      if (isUnreachable(error) && canTransition(current.status, 'orphaned')) {
        log('task.orphaned', { taskId: task.id, sessionId: task.session_id, detail: { reason } })
        transition(db, task.id, 'orphaned', { error: `子会话不可达：${reason}` })
        releaseTaskSession(task)
        return toolFailure('MESSAGE_UNREACHABLE', { label: labelFor(task), reason })
      }
      if (current.status === 'waiting_user') {
        setTaskError(db, task.id, reason)
      } else if (current.status === 'delivered') {
        // 待确认任务追问失败：交付结果还在，保持 delivered 只记原因，别把它降级成等待/失败。
        setTaskError(db, task.id, reason)
      } else if (canTransition(current.status, 'waiting_user')) {
        transition(db, task.id, 'waiting_user', { error: reason })
      } else {
        transition(db, task.id, 'failed', { error: reason })
        releaseTaskSession(task)
      }
      return toolFailure('MESSAGE_DELIVERY_FAILED', { label: labelFor(task), reason })
    }
    setMessageDelivery(db, task.id, seq, 'delivered')
    touchTask(db, task.id)
    // 追问必达（t-99d4a98c）：投递成功 = 协调者在等这条任务的下一份回报。下一份 progress 不看
    // 通知水位、立刻送达（判据在 task_report → notify.push 的 answeredFollowup）。
    markReportExpected(db, task.id)
    const current = getTask(db, task.id)
    // 「等批准」状态收到续派 = 用户批准计划；先记住，投递成功回到 running 之后才切可写。
    const wasWaiting = WAITING_STATUS.has(current.status)
    // 「已交付待确认」上的追问：投递成功即回到 running，复用同一个子会话（可写根没释放，仍能写）。
    const wasDelivered = current.status === 'delivered'
    if (RESUME_STATUS.has(current.status)) transition(db, task.id, 'running', { error: null })
    clearTaskQuestion(db, task.id)
    incrementAttempts(db, task.id)
    // P8：计划阶段出口 —— 批准 = 投递成功且回到 running；失败路径不碰 plan 状态（仍在等你确认）。
    let planNote = ''
    if (wasWaiting && isPlanTask(task) && planStateOf(task) === 'planning') {
      const approved = await approvePlan({ db, dispatcher, task, log })
      planNote = `\n${approvalNote(approved)}`
    }
    // 只读任务的「等你确认」/「待确认」续派：沙箱仍是 read-only（契约如此，见 docs/LIMITATIONS.md）。
    // 真机踩过：协调者拿不准这条，最后新开可写任务/新会话，原会话永远停在「等你确认」。
    // 这里如实说清代价并给出两条出口，别让「投递成功」被误解成「已切可写」。
    const readOnlyNote = (wasWaiting || wasDelivered) && task.read_only === true && isPlanTask(task) !== true
      ? '\n注意：该任务是只读任务（readOnly），续派后子会话仍是 read-only 沙箱、写操作会被拒。'
        + '要落地执行请二选一：①新派一个可写任务（不要依赖本任务续派）；②下次用 planFirst 计划任务，批准后同一会话会自动切回可写。'
      : ''
    const deliveredNote = wasDelivered
      ? `\n该任务此前是「${DELIVERY_LINES.state}」，已回到进行中并在同一子会话继续；`
        + `完成后会再次落「${DELIVERY_LINES.state}」，等你/用户确认或${DELIVERY_LINES.timeout}。`
        + (task.read_only === true ? '' : '\n交付时已释放目标目录的写权限，本次追问投递成功后已幂等重建写根。')
      : ''
    const riskNote = followupGuard.note === '' ? '' : `\n${followupGuard.note}`
    return `已把消息追加给任务「${labelFor(task)}」（子会话 ${task.target}）。${planNote}${deliveredNote}${readOnlyNote}${riskNote}`
  }

  // 停止（原 task_stop 的实现，行为不变）。
  const stopTask = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    if (unbound()) return UNBOUND_HINT
    const found = findTaskInput(args.task_id)
    if (found.ok !== true) return found.message
    const task = found.task
    // 「已收尾」判据与面板 stop 同源（stopIsIdempotent = releases 能力）：done/failed/cancelled/orphaned
    // 都不该再迁一次。0.19.x 这里用的是不含 failed 的「流程终态」，于是对失败任务执行停止会把它
    // 改成「已取消」，抹掉失败信息（审计 §2.3.2 第 3 条）。
    if (stopIsIdempotent(task)) {
      return toolFailure('STOP_TASK_ENDED', { label: labelFor(task), statusLabel: labelOf(task.status) })
    }
    if (task.status === 'pending' || task.status === 'waiting_dep') {
      queue.remove(task.id)
      transition(db, task.id, 'cancelled')
      releaseTaskSession(task)
      queue.pump()
      cleanupWorktree?.(getTask(db, task.id))
      return task.status === 'waiting_dep'
        ? `任务「${labelFor(task)}」已取消（还在等待前置任务）。`
        : `任务「${labelFor(task)}」已取消（还在排队，没有派发出去）。`
    }
    if (task.target !== null && task.target !== undefined) {
      // 停止失败也要把任务标掉：用户要的是「停」，不是让 stop 抛错卡住。
      try {
        await dispatcher.stop(task.target, task.id)
      } catch (error) {
        log('task.stop.failed', { taskId: task.id, sessionId: task.session_id, detail: { reason: error?.message ?? String(error) } })
        // dispatch.stop 的 finally 已尽力清 goal；自定义派发器/极端路径再兜一次（幂等）。
        void goalBridge?.clear?.(task.id, task.target)
      }
    }
    queue.remove(task.id)
    transition(db, task.id, 'cancelled')
    releaseTaskSession(task)
    queue.pump()
    cleanupWorktree?.(getTask(db, task.id))
    return `任务「${labelFor(task)}」已停止。`
  }

  // 重派（原 task_retry 的实现，行为不变）。
  const retryTask = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    if (unbound()) return UNBOUND_HINT
    const found = findTaskInput(args.task_id)
    if (found.ok !== true) return found.message
    const task = found.task
    if (!RETRYABLE_STATUS.has(task.status)) {
      return toolFailure('RETRY_NOT_ALLOWED', { label: labelFor(task), statusLabel: labelOf(task.status) })
    }
    const duplicate = listTasks(db, { active: true })
      .find(item => item.title.trim() === task.title.trim() && item.goal.trim() === task.goal.trim())
    if (duplicate !== undefined) {
      return toolFailure('RETRY_DUPLICATE_ACTIVE', {
        label: taskLabelWithRef(duplicate),
        statusLabel: labelOf(duplicate.status),
      })
    }
    const current = status()
    const depends = validateDepends(db, task.depends_on)
    if (depends.ok === false) return toolFailure('RETRY_DEPENDS_INVALID', { reason: depends.error })
    const depState = dependencyState(db, { depends_on: depends.ids })
    // G1：旧尝试的目标到此为止（failed/orphaned），清掉后再建新任务；新子会话派发时重新 create。
    void goalBridge?.clear?.(task.id, task.session_id)
    // P9：隔离任务重派复用原检出（目录还在就复用，被清理过按原基线重建）；普通任务零变化。
    const retryWorktree = retryWorktreeOf(task)
    const retried = createTask(db, {
      brief: task.brief,
      coordinatorSession: current.id ?? coordinatorSession,
      targetDir: retryWorktree === null ? task.target_dir : (task.brief?.target ?? task.target_dir),
      readOnly: task.read_only === true,
      // P8：计划任务重派后重新走一次计划阶段（新会话要重新探索/批准）。
      planFirst: task.plan_first === true,
      planState: task.plan_first === true ? 'planning' : 'none',
      // per-task 访问级别跟着原任务走（重派是同一次尝试的延续，不该静默降级成默认策略）。
      access: task.access === 'full' ? 'full' : null,
      // P2-2：续跑预算同样跟着原任务走（重派不改续跑语义）。
      goalRounds: task.goal_rounds ?? 0,
      worktree: retryWorktree,
      // P2-4：官方 Team 板关联跟着原任务走（重派是同一次尝试的延续；CAS 基线仍用创建时的 revision，
      // 真冲突时反写会重读一次再试一次，不会因为重派就永远写不进去）。
      teamTask: task.team_task_id === null ? null : { id: task.team_task_id, revision: task.team_task_revision },
      retryOf: task.id,
      dependsOn: depends.ids,
      groupId: task.group_id,
      writeScopes: task.write_scopes,
      priority: task.priority,
      status: depState.ready ? 'pending' : 'waiting_dep',
    })
    log('task.retry', {
      taskId: retried.id,
      sessionId: current.id,
      detail: { retryOf: task.id, dependsOn: depends.ids, status: retried.status, access: retried.access ?? null, callId: exec?.callId },
    })
    // P1：重派也走借条（与 task_create / 面板重派同口径）。
    const retriedBrief = compactMessage('brief', renderBriefForTask(retried))
    addMessage(db, retried.id, { kind: 'brief', rendered: retriedBrief.rendered, meta: retriedBrief.meta })
    if (current.live === false) {
      const message = invalidHint() === '' ? toolFailure('MAIN_SESSION_UNAVAILABLE') : invalidHint()
      log('task.spawn.failed', { taskId: retried.id, agentId: exec?.agent?.id, detail: { error: message, retryOf: task.id } })
      transition(db, retried.id, 'failed', { error: message })
      throw new Error(message)
    }
    if (retried.status === 'waiting_dep') {
      return `任务「${labelFor(task)}」已重派为「${taskLabelWithRef(retried)}」，等待前置任务完成后派发。`
    }
    const outcome = await queue.enqueueAndPump(retried.id)
    const resultTask = outcome.task
    if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? toolFailure('RETRY_FAILED', {}))
    const hint = invalidHint()
    const notes = hint === '' ? '' : `\n${hint}`
    if (resultTask?.status === 'running') {
      return `任务「${labelFor(task)}」已重派为「${taskLabelWithRef(retried)}」，子会话 ${resultTask.target}。${notes}`
    }
    const ahead = Math.max(outcome.position - 1, 0)
    return `任务「${labelFor(task)}」已重派为「${taskLabelWithRef(retried)}」，前面还有 ${ahead} 个任务在排队。${notes}`
  }

  // 续跑（v0.24，原会话冷恢复）：resume = 同 task_id + 同一子会话（失败/额度中断/重启孤儿的默认出口）；
  // retry = 新任务 + 新子会话（上下文污染、换检出/权限、会话不可达时用）。纪律（真机踩过的反面）：
  // 投递失败**绝不静默新建任务**——任务留在原状态，由协调者决定改派。
  const resumeTask = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    if (unbound()) return UNBOUND_HINT
    const found = findTaskInput(args.task_id)
    if (found.ok !== true) return found.message
    const task = found.task
    const history = countTaskMessages(db, task.id)
    const gate = resumeGate(task, { history })
    if (gate.ok !== true) {
      if (gate.reason === 'closed') return toolFailure('RESUME_CLOSED', { label: labelFor(task), closeReason: closeReasonLabel(task.close_reason) ?? '已确认' })
      if (gate.reason === 'no_session') return toolFailure('RESUME_NO_SESSION', { label: labelFor(task) })
      if (gate.reason === 'checkout_cleaned') return toolFailure('RESUME_CHECKOUT_CLEANED', { label: labelFor(task) })
      return toolFailure('RESUME_NOT_ALLOWED', { label: labelFor(task), statusLabel: labelOf(task.status) })
    }
    const text = typeof args.message === 'string' ? args.message.trim() : ''
    const body = resumePrompt(task, { history, message: text })
    const from = task.status
    // P1：续跑指令正文同样只留借条（宿主 user/message 是真源）。
    const resumeBody = compactMessage('resume', body)
    const seq = addMessage(db, task.id, { kind: 'resume', rendered: resumeBody.rendered, meta: { ...(resumeBody.meta ?? {}), delivery: 'pending', from, stopReason: task.last_stop_reason } })
    try {
      // 与追问同一条投递链：dispatch.send 内部就是冷恢复 + 幂等补沙箱 / target 可写根 / goal。
      await sendFollowup(task.target, body, exec?.signal, task.target_dir, task.id, task.read_only === true, objectiveForMessage(task.goal, body), task.access === 'full' ? 'full' : undefined)
    } catch (error) {
      const reason = error?.message ?? String(error)
      setMessageDelivery(db, task.id, seq, 'failed', { error: reason })
      addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[续跑投递失败] ${reason}` })
      log('task.resume.failed', { taskId: task.id, sessionId: task.session_id, detail: { reason, from, history } })
      // 不新建、不改状态：原状态与死因都留着。不可达是终局（只能换新会话）→ 专门错误码并指 retry；
      // 其余投递错误可能是暂时的，回执里留「可再试一次 resume」的口子。
      return toolFailure(isUnreachable(error) ? 'RESUME_UNREACHABLE' : 'RESUME_DELIVERY_FAILED', { label: labelFor(task), reason })
    }
    setMessageDelivery(db, task.id, seq, 'delivered')
    // 投递成功才迁状态（gate 已保证这条边存在）。清死因/关闭原因（done(timeout) 续跑后不再是「已关闭」、
    // 旧问题也不再有效）——都跟下一次结算重新写。
    transition(db, task.id, 'running', { error: null, lastStopReason: null, closeReason: null })
    clearTaskQuestion(db, task.id)
    // 续跑也是「协调者在等回报」：冷恢复后子会话的第一份 progress 同样必达（不然续跑完还是看不见）。
    markReportExpected(db, task.id)
    incrementAttempts(db, task.id)
    const updated = incrementResumeCount(db, task.id)
    touchTask(db, task.id)
    log('task.resume', { taskId: task.id, sessionId: task.session_id, detail: { from, history, stopReason: task.last_stop_reason } })
    // 如实说清代价：只读任务续跑仍是 read-only（见 docs/LIMITATIONS.md）；历史过长建议 retry（软阈值不拦截）。
    const readOnlyNote = task.read_only === true && isPlanTask(task) !== true
      ? '\n注意：该任务是只读任务（readOnly），续跑后子会话仍是 read-only 沙箱、写操作会被拒；要落地执行请重派可写任务。'
      : ''
    const longNote = gate.warn === 'history_too_long'
      ? `\n注意：历史已有 ${history} 条消息（> ${RESUME_HISTORY_THRESHOLD}），冷恢复会重放整段历史，成本可能高于新派；`
        + '建议改用 task_message({ action: \'retry\' }) 新开一条（resume 仍可显式调用）。'
      : ''
    return `已续跑任务「${labelFor(task)}」：在原会话 ${task.target} 上冷恢复继续（「${labelOf(from)}」→「进行中」，第 ${updated?.resume_count ?? 1} 次续跑）。`
      + (task.last_stop_reason === null ? '' : `\n上次结束原因：${task.last_stop_reason}`)
      + readOnlyNote + longNote
  }

  // 确认交付（原 task_close 的实现，行为不变）。
  const closeTask = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    if (unbound()) return UNBOUND_HINT
    const found = findTaskInput(args.task_id)
    if (found.ok !== true) return found.message
    const task = found.task
    const outcome = closeDelivered({
      db,
      taskId: task.id,
      // P2-3：工具确认 = 协调者确认（与面板 `panel` / 超时 `timeout` 区分，落 accepted_by）。
      reason: CLOSE_REASONS.coordinator,
      by: 'coordinator',
      releaseSession: releaseTaskSession,
      // G1：确认完成 = 目标达成，complete 并 disarm（桥内部幂等）。
      completeGoal: closed => { void goalBridge?.complete?.(closed.id, closed.session_id) },
      cleanupWorktree,
      pump: () => queue.pump(),
      logger,
    })
    if (outcome.ok !== true) {
      const latest = outcome.task ?? task
      if (outcome.reason === 'not-found') return TASK_REF_UNKNOWN
      if (TERMINAL_STATUS.has(latest.status)) {
        return toolFailure('CLOSE_TASK_ENDED', { label: labelFor(latest), statusLabel: labelOf(latest.status) })
      }
      return toolFailure('CLOSE_NOT_DELIVERED', { label: labelFor(latest), statusLabel: labelOf(latest.status) })
    }
    log('task.close', { taskId: task.id, detail: { already: outcome.already === true } })
    return outcome.already === true
      ? `任务「${labelFor(outcome.task)}」已完成（无需重复确认）。`
      : `任务「${labelFor(outcome.task)}」已确认完成。`
  }

  // 收件箱（原 task_inbox 的实现，输出逐字不变）。
  const inboxView = async (args, exec) => {
    const denied = requireMain(exec)
    if (denied !== undefined) return denied
    const limit = Number.isFinite(args.limit) ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 10
    const active = listTasks(db, { active: true })
    const waiting = active
      .filter(task => WAITING_STATUS.has(task.status))
      .slice(0, limit)
    // 两段式终态：已交付待确认的任务要协调者/用户拍板（确认或追问），单独一栏。
    const confirm = active
      .filter(task => task.status === 'delivered')
      .slice(0, limit)
    const failed = listTasks(db, { active: false })
      .filter(task => task.status === 'failed' || task.status === 'orphaned')
      .slice(0, limit)
    const stale = active
      .filter(task => task.status === 'running' || task.status === 'pending' || task.status === 'waiting_dep')
      .filter(task => Date.now() - task.last_event_at > staleMinutes * 60_000)
      .slice(0, limit)
    if (waiting.length === 0 && confirm.length === 0 && failed.length === 0 && stale.length === 0) {
      return '收件箱是空的，没有待你决定或需要关注的任务。'
    }
    const blocks = []
    const lineOf = task => {
      const question = task.question ? `｜问题：${short(task.question, 80)}` : ''
      const options = task.options?.length > 0 ? `｜选项：${task.options.join(' / ')}` : ''
      return `- ${taskLabelWithRef(task)}｜${labelOf(task.status)}${question}${options}`
    }
    if (waiting.length > 0) blocks.push(`【待你决定】${waiting.length}\n${waiting.map(lineOf).join('\n')}`)
    if (confirm.length > 0) {
      blocks.push(`【待确认】${confirm.length}（${DELIVERY_LINES.state}：默认保持、等你或用户拍板；`
        + `要改 ${DELIVERY_LINES.followupRule}，用户确认后才 ${DELIVERY_LINES.closeCall}，${DELIVERY_LINES.timeout}）\n${confirm.map(lineOf).join('\n')}`)
    }
    if (failed.length > 0) blocks.push(`【失败/丢失】${failed.length}\n${failed.map(lineOf).join('\n')}`)
    if (stale.length > 0) blocks.push(`【长时间没动静】${stale.length}\n${stale.map(lineOf).join('\n')}`)
    return blocks.join('\n')
  }

  // 历史检索（原 history_search 的实现）。
  //
  // 只读、**子会话也可用**（协调者与子会话走同一条实现，同参数输出逐字一致）：
  // 「需要历史经验/项目背景时主动查」是子会话的行为期望（worker 预设 persona），这里不按角色拦。
  // 可用性声明在预设层（worker 预设 preset-tools 的 `keep`），本层只保证「只读 + 无副作用」。
  //
  // P0-a/P0-b（记忆优化，2026-11-21）：
  // - 首行打印【检索范围】：不传 project 时只查 global（跨项目），必须让人看见「没含项目记忆」——
  //   以前静默回落 global，254 条项目记忆一条都查不到，调用方还以为是「没有历史」；
  // - project 支持 绝对路径 / 工作区名 / 数组（合并 ≤2 个项目键，统一按分数截 limit）/ 'all'（全部项目）；
  // - 未知名项目给一行【警告】，不再静默回落；
  // - task-log 单独成块、最多 2 条、排在事实层之后（把检索槽位还给事实层）。
  const MAX_HISTORY_PROJECT_KEYS = 2
  const MAX_HISTORY_LOG_ROWS = 2
  const LOG_LAYER_KINDS = Object.freeze([TASK_LOG_KIND, 'task-done'])
  /** project 参数 → { keys: string[]|null, label, warnings }；keys=null 表示 'all'（不按项目过滤）。 */
  const resolveHistoryScope = value => {
    const warnings = []
    const raw = (Array.isArray(value) ? value : [value])
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item !== '')
    if (raw.length === 0) {
      return { keys: [GLOBAL_PROJECT], label: 'global（未含项目记忆）', warnings }
    }
    if (raw.some(item => item.toLowerCase() === 'all')) {
      return { keys: null, label: 'all（全部项目记忆）', warnings }
    }
    const keys = []
    for (const item of raw) {
      const hint = resolveProjectHint(item)
      if (hint.known !== true) {
        warnings.push(hint.ambiguous !== undefined && hint.ambiguous.length > 0
          ? `项目名「${item}」匹配多个工作区，这一项按 global 检索；请改传绝对目录：${hint.ambiguous.join('；')}`
          : `未找到项目「${item}」：这一项按 global 检索。要查项目记忆请传绝对目录或已登记工作区名（见 context({ mode: 'workspaces' })）`)
        continue
      }
      if (!keys.includes(hint.key)) keys.push(hint.key)
      if (keys.length >= MAX_HISTORY_PROJECT_KEYS) break
    }
    if (keys.length === 0) return { keys: [GLOBAL_PROJECT], label: 'global（未含项目记忆）', warnings }
    if (!keys.includes(GLOBAL_PROJECT)) keys.push(GLOBAL_PROJECT)
    return {
      keys,
      label: `project: ${keys.filter(key => key !== GLOBAL_PROJECT).join(' + ')}｜+ global（跨项目记忆）`,
      warnings,
    }
  }
  const historyView = async (args, exec) => {
    const query = String(args.query ?? '').trim()
    if (query === '') return '给一个关键词再查历史（任务名、目标、决策或文件名）。'
    const limit = Number.isFinite(args.limit) ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5
    const scope = resolveHistoryScope(args.project)
    const tokens = memoryTokens(query)
    // 事实层与日志层分开查：日志层单独成块、最多 2 条，不占事实层的 limit 槽位。
    const memoryScope = scope.keys === null ? 'all' : scope.keys
    const facts = searchMemories(db, { projectKeys: memoryScope, query, limit, kinds: MEMORY_FACT_KINDS })
    const logs = searchMemories(db, { projectKeys: memoryScope, query, limit: MAX_HISTORY_LOG_ROWS, kinds: LOG_LAYER_KINDS })
    const tasks = listTasks(db, { active: false })
      .map(task => {
        const latest = recentMessages(db, task.id, 1)[0]?.rendered ?? ''
        const haystack = `${task.title} ${task.goal} ${latest}`.toLowerCase()
        const score = tokens.reduce((sum, token) => sum + haystack.split(token).length - 1, 0)
        return { task, score }
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || right.task.updated_at - left.task.updated_at)
      .slice(0, limit)
    const sessions = []
    const service = typeof sessionQuery === 'function' ? sessionQuery() : sessionQuery
    if (service?.searchSessions !== undefined) {
      try {
        const page = await service.searchSessions({ query, limit: 5 })
        for (const hit of Array.isArray(page?.items) ? page.items : []) {
          const id = hit?.header?.id ?? hit?.sessionId
          if (typeof id !== 'string' || id === '') continue
          const cwd = hit?.header?.cwd
          if (scope.keys !== null && typeof cwd === 'string' && !scope.keys.includes(projectKeyOf(cwd))) continue
          sessions.push({ id, snippet: short(hit?.bestMatch?.snippet ?? hit?.snippet ?? '', 160) })
          if (sessions.length >= 3) break
        }
      } catch { /* sessionQuery 不可用就只查插件自己的数据 */ }
    }
    // 首行必须是【检索范围】——调用方据此判断「要不要显式传 project 再查一次」。
    const blocks = [`【检索范围】${scope.label}`]
    for (const warning of scope.warnings) blocks.push(`【警告】${warning}`)
    if (facts.length > 0) {
      // 标出层：lesson/decision/preference/note 是事实层（可注入 brief）。
      blocks.push(`【记忆】\n${facts.map(row => `- [${memoryKindLabel(row.kind)}] ${row.text}`).join('\n')}`)
    }
    if (logs.length > 0) {
      // 日志层单独一块、最多 2 条：task-log 只归档、不注入 brief，别挤掉事实层的槽位。
      blocks.push(`【任务日志】最多 ${MAX_HISTORY_LOG_ROWS} 条（日志层，只归档）\n${logs.map(row => `- [${memoryKindLabel(row.kind)}] ${row.text}`).join('\n')}`)
    }
    if (tasks.length > 0) {
      blocks.push(`【历史任务】\n${tasks.map(({ task }) => `- ${taskLabelWithRef(task)}｜${labelOf(task.status)}｜${short(task.goal, 80)}${task.artifacts?.length > 0 ? `｜产物 ${task.artifacts.length}` : ''}`).join('\n')}`)
    }
    if (sessions.length > 0) {
      blocks.push(`【历史会话】\n${sessions.map(item => `- ${item.id}${item.snippet === '' ? '' : `：${item.snippet}`}`).join('\n')}`)
    }
    return blocks.length > 1 ? blocks.join('\n') : `${blocks[0]}\n没有找到相关历史。`
  }

  // 已登记工作区 + 仓库采样索引（原 project_context({workspaces:true}) 的实现，输出逐字不变）。
  const workspacesView = async (args, exec) => {
    return `【已登记工作区】\n${workspaceList().map(item => JSON.stringify({ id: item.id, title: item.title, path: item.path })).join('\n')}\n${workspaceIndexText(loadWorkspaceIndex(db)) || '尚无仓库索引，派只读工作区与仓库索引任务。'}`
  }

  // 项目背景（原 project_context 的实现；P0：架构正本进白名单，include 可显式加长）。
  const projectView = async (args, exec) => {
    if (args.workspaces === true) return workspacesView(args, exec)
    if (typeof args.query === 'string' && !args.target) {
      const match = inferWorkspaceTarget({ title: args.query, goal: args.query }, workspaceList())
      if (match.ok === false) return `匹配多个工作区，请确认 target：\n${match.candidates.map(item => `${item.title} → ${item.path}`).join('\n')}`
    }
    let dir
    if (typeof args.target === 'string' && args.target.trim() !== '') {
      const error = validateTargetDir(args.target)
      if (error !== undefined) return `${error}。`
      dir = resolve(args.target.trim())
    } else {
      const hint = resolveProjectHint(args.query)
      dir = hint.path ?? defaultDir()
    }
    if (dir === undefined) return '没有可用项目目录：请给 target 绝对路径，或先打开主会话。'
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { isDir = false }
    if (!isDir) return `项目目录不存在或不是目录：${dir}`
    return projectContextFor(dir, String(args.query ?? ''), { include: args.include })
  }

  return [
    wrap('task_create', '创建一个子任务：建台账、检查活跃上限、渲染 brief 派生一个子会话。description 由你写清目标与验收；可用 checks 配机器可判定验收（交付前自动执行）。复杂任务先传 planFirst 走计划闸门。', objectSchema({
      title: str('一句话任务名，卡片上显示'),
      goal: str('要达成的目标，一两句话'),
      constraints: strList('约束，可空'),
      acceptance: strList('验收标准，至少一条'),
      checks: {
        type: 'array',
        description: '可选：机器可判定验收（交付前由插件执行，失败即拒绝交付、任务保持进行中）。1–5 条；'
          + '每条 { name?, command: argv 数组（如 ["node","--test"]）, timeoutMs?（1000–600000，默认 120000）, skipIfMissing? }。'
          + '命令在任务 target / worktree 目录里按 argv 直接执行（不经 shell 拼串；Windows 上无扩展名的 pnpm/npm 按 PATH+PATHEXT 找到 .cmd，'
          + '由 ComSpec 执行且参数逐项转义）；task_report 没有任何参数能覆盖它',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: str('检查名（缺省 check-1..check-5；同一任务内必须唯一）'),
            command: {
              type: 'array',
              items: { type: 'string' },
              description: 'argv 数组：第 1 项是命令、其余是参数（每项 ≤2000 字符，最多 16 项）。不接受 shell 字符串',
            },
            timeoutMs: { type: 'number', description: '超时毫秒（1000–600000，默认 120000）；超时先 SIGTERM、5 秒后 SIGKILL' },
            skipIfMissing: { type: 'boolean', description: '命令不存在（ENOENT）时跳过这条而不是判失败（防「机器上没装 pnpm」卡死交付）' },
          },
        },
      },
      refs: strList('背景资料，如文件路径，可空'),
      user_verbatim: str('用户原话，可空'),
      teamTaskId: str('可选：关联官方 Team 板上的任务 id（如 task-3，只在官方 Agent Teams 开启时可用）。'
        + '只读校验任务存在并记下当前 revision；确认交付时按 CAS（expectedRevision）把该官方任务标 complete，'
        + '冲突只提示、不重试轰炸，也不接管官方派发/生命周期'),
      target: str('目标目录：可空；给了必须是已存在的绝对路径，子会话在该目录运行'),
      readOnly: { type: 'boolean', description: '只读任务：子会话沙箱 read-only（读正常，写文件/写 shell 被拒）；默认 false，只在明确需要时传 true' },
      planFirst: { type: 'boolean', description: '计划模式（复杂任务 T3）：跨仓库/重构迁移/不可逆/范围不确定时先只读探索并上报计划，用户批准后再执行；与 readOnly 互斥；默认 false' },
      access: {
        type: 'string',
        enum: ['full'],
        description: 'per-task 访问级别：只接受 "full"（子会话沙箱 danger-full-access：构建/发版类任务要写仓库外或跑不受沙箱限制的 bash 时用）；不传=沿用当前会话策略、完全不动沙箱（默认）；与 readOnly/planFirst 互斥',
      },
      dependsOn: strList(TASK_CHAIN_TOOL_DESC),
      group: str('可选分组名，如“登录改造”；面板按组汇总进度'),
      goalRounds: {
        type: 'number',
        description: '可选：续跑轮次预算（0–50，默认 0 = 不续跑，与旧行为一致）。>0 时把平台 goal 以 '
          + 'maxGoalRounds=N 保持 armed，由宿主 goal 轮次驱动在回合结束后自动续轮（插件不注入消息、不模拟续跑）；'
          + '轮次与进度看 task_status 的「目标轮次」。计划模式（planFirst）不接受本参数',
      },
      writeScopes: strList('可选写域（目录/文件路径）；与活跃未隔离任务重叠时按配置 sameDirGuard 拒绝或警告（不是文件锁）'),
      priority: { type: 'number', description: '优先级，-10..10，默认 0；高的先派发' },
      allowConcurrent: { type: 'boolean', description: '显式放行同写域并发：默认不传时，目标目录（或写域）与活跃未隔离任务冲突会被拒绝；只在用户明确要求并发写同一目录时传 true，放行后返回里会标注并发风险' },
      worktree: { type: 'boolean', description: '在目标仓库里新建 git worktree 隔离执行：true=建、false=不建；不传时按配置 worktreePolicy 兜底（required 自动建）；字符串 "true" 不生效；与 readOnly/planFirst 互斥' },
      worktreeBase: str('隔离基线：分支名或 commit-ish（缺省 "default"=仓库默认分支）；仓库近 N 天有 ≥2 个活跃分支时先问用户，指定后再派'),
      worktreeBranch: str('新分支名（缺省 orch/<taskId>）；非法或已存在会报错，插件不自动改名'),
      worktreeMode: str('"new"（默认：新建检出）或 "continue"（复用同 group/dependsOn 的已有检出）'),
      worktreeCleanup: str('终态后清理档位："off"（默认，检出+分支都保留）｜"checkout-only"（只删检出）｜"full"（连分支一起删）'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const callId = exec?.callId
      const agentId = exec?.agent?.id
      // 只认显式 true：字符串/偏真值都不算，避免模型顺手传 'true' 把普通任务变只读。
      const readOnly = args.readOnly === true
      // P8：计划模式同样是显式 true；与只读互斥（只读任务永远不切回可写，计划批准后要执行）。
      const planFirst = args.planFirst === true
      if (planFirst && readOnly) {
        log('task.create.rejected', { agentId, detail: { reason: 'plan-readonly-conflict', callId } })
        return '计划模式（planFirst）与只读（readOnly）互斥：只读任务永远不切回可写，而计划批准后要执行。请二选一（要计划就只传 planFirst:true）。'
      }
      // per-task 访问级别：只接受显式 'full'，空值等价于没传（沿用会话策略）。
      // 其余值（'workspace-write' / 'read-only' / 'true' / 数字…）一律拒绝，不静默降级成默认——
      // 用户以为放开了写权限、实际没放开，比报错危险得多。
      const rawAccess = args.access
      const accessText = typeof rawAccess === 'string' ? rawAccess.trim() : String(rawAccess ?? '').trim()
      const accessProvided = rawAccess !== undefined && rawAccess !== null && accessText !== ''
      if (accessProvided && accessText !== 'full') {
        log('task.create.rejected', { agentId, detail: { reason: 'access-invalid', access: accessText, callId } })
        return `access 只接受 "full"（完整访问：该子会话沙箱 danger-full-access，构建/发版类任务用）；`
          + `不传就沿用当前会话策略、不动沙箱。收到的是 ${JSON.stringify(rawAccess)}。`
      }
      const fullAccess = accessText === 'full'
      // 互斥：只读是硬拦写、计划阶段靠只读沙箱兜底，都不可能同时要完整访问。
      if (fullAccess && readOnly) {
        log('task.create.rejected', { agentId, detail: { reason: 'access-readonly-conflict', callId } })
        return '完整访问（access:"full"）与只读（readOnly）互斥：只读任务永远不写文件，完整访问恰是为了放开写。请二选一。'
      }
      if (fullAccess && planFirst) {
        log('task.create.rejected', { agentId, detail: { reason: 'access-plan-conflict', callId } })
        return '完整访问（access:"full"）与计划模式（planFirst）互斥：计划阶段靠只读沙箱硬拦写操作，批准后才切回可写。请先 planFirst 探索，批准后再决定要不要派完整访问任务。'
      }
      // P2-2：续跑轮次预算。只认 0–50 的整数；非法值明确拒绝，不静默降级成 0
      // （「我配了续跑但它没跑」是最难排的一类问题）。
      const goalRounds = normalizeGoalRounds(args.goalRounds)
      if (goalRounds === undefined) {
        log('task.create.rejected', { agentId, detail: { reason: 'goal-rounds', value: args.goalRounds ?? null, callId } })
        return `goalRounds 只接受 0–50 的整数（0 = 不续跑，也是默认值）：收到的是 ${JSON.stringify(args.goalRounds)}。`
      }
      // 计划模式 + 自动续跑互斥：计划任务每轮都要停下来等批准，续轮会绕过「批准」这道闸门。
      if (goalRounds > 0 && planFirst) {
        log('task.create.rejected', { agentId, detail: { reason: 'goal-rounds-plan-conflict', callId } })
        return '计划模式（planFirst）不接受 goalRounds：计划任务每轮结束都要停下来等批准，自动续轮会绕过批准闸门。'
          + '先 planFirst 探索、批准后用 task_message 续派；或直接派执行任务并配 goalRounds。'
      }
      log('task.create.requested', { agentId, detail: { title: args.title, goal: args.goal, readOnly, planFirst, access: fullAccess ? 'full' : null, goalRounds, callId } })
      const errors = validateBrief(args)
      if (errors.length > 0) {
        log('task.create.rejected', { agentId, detail: { reason: 'validation', message: errors.join('；'), callId } })
        return `任务描述不完整：${errors.join('；')}。补齐后再派。`
      }
      // P2-1 A1：机器可判定验收。校验在派发前做完（避免建了任务才发现命令写错），
      // 规范化后的 spec 写进 brief 快照——子会话只能读到它，不能改它。
      const normalizedChecks = normalizeChecks(args.checks)
      if (normalizedChecks.ok !== true) {
        log('task.create.rejected', { agentId, detail: { reason: 'checks', message: normalizedChecks.error, callId } })
        return `checks 不合法：${normalizedChecks.error}。`
      }
      const checks = normalizedChecks.checks
      // 只读任务语义是「这个子会话不写」，而检查是**宿主进程**执行（不是子会话沙箱），
      // 没法保证命令只读——两者放在一起等于给只读任务开一条写后门。要么别只读，要么别配检查。
      if (readOnly && checks.length > 0) {
        log('task.create.rejected', { agentId, detail: { reason: 'checks-readonly-conflict', callId } })
        return '只读任务不接受 checks：验收命令在插件宿主进程里执行（不是子会话沙箱），无法保证「只读」。'
          + '要跑测试/构建就别传 readOnly:true；真要只读核对，把结论写进 acceptance 由人看。'
      }
      // P2-4（D6）：可选关联官方 Team 板任务。**只读**校验（任务存在 + 当前 revision），不 claim、不改官方任务；
      // 关联只写进我们自己的台账（team_task_id / team_task_revision），确认交付时才按 CAS 反写 complete。
      // 官方不可用/未开启时明确拒绝，不静默忽略参数（用户以为关联上了、结果什么都没发生最糟）。
      const teamTaskIdText = typeof args.teamTaskId === 'string' ? args.teamTaskId.trim() : ''
      let teamTask = null
      let teamTaskNote = ''
      if (teamTaskIdText !== '') {
        const linked = typeof teamBoard?.link === 'function'
          ? teamBoard.link(exec?.agent, teamTaskIdText)
          : { ok: false, code: TEAM_BOARD_UNAVAILABLE, reason: '插件没有装配官方 Team 板读取（宿主缺 agentTeams 服务）' }
        if (linked.ok !== true) {
          log('task.create.rejected', { agentId, detail: { reason: 'team-task', code: linked.code, callId } })
          return `官方 Team 任务关联失败：${linked.reason}。`
        }
        teamTask = { id: linked.task.id, revision: linked.task.revision }
        teamTaskNote = `官方板：已关联「${teamTask.id}」（创建时 revision ${teamTask.revision ?? '未知'}）；`
          + `确认交付时按 CAS 反写完成，冲突只提示、不阻塞本地交付。${linked.note === '' ? '' : `\n${linked.note}`}`
      }
      // 显式 target 先归一：空串/全空白等价于没传（模型常用 "" 表示没有），不能把空串当目录写库。
      const targetText = typeof args.target === 'string' ? args.target.trim() : ''
      const targetError = validateTargetDir(targetText)
      if (targetError !== undefined) {
        log('task.create.rejected', { agentId, detail: { reason: 'target', message: targetError, callId } })
        return `${targetError}。`
      }
      // 没传 target 时才推断：唯一命中用它的 path 并落 target_dir；多命中列候选、不建任务；无命中仍回指挥舱。
      let effectiveTarget = targetText === '' ? (args.title === INDEX_TITLE ? defaultDir() : undefined) : targetText
      let inferred
      if (effectiveTarget === undefined) {
        const match = inferWorkspaceTarget({ title: args.title, goal: args.goal }, workspaceList())
        if (match.ok === false) {
          const lines = match.candidates.map(item => `- ${item.title ?? item.path} → ${item.path}`).join('\n')
          log('task.create.rejected', { agentId, detail: { reason: 'target-ambiguous', candidates: match.candidates.length, callId } })
          return `匹配到多个工作区，未创建任务。请让用户确认目标目录，再用 target 指定绝对路径：\n${lines}`
        }
        if (match.workspace !== undefined) {
          effectiveTarget = match.workspace.path
          inferred = match.workspace
          log('task.create.target-inferred', {
            agentId,
            detail: { workspaceId: match.workspace.id, path: match.workspace.path, callId },
          })
        }
      }
      // 验收命令只在任务自己的目录里跑（安全边界）：没有 target 就没有执行目录，不建任务。
      if (checks.length > 0 && effectiveTarget === undefined) {
        log('task.create.rejected', { agentId, detail: { reason: 'checks-without-target', callId } })
        return 'checks 需要 target 目录：验收命令只在任务目标目录（或 worktree 检出）里执行，不继承主会话目录。'
          + '请给 target 绝对路径后再派；没有目标目录就不传 checks。'
      }
      const current = status()
      // 去重、队列容量、创建必须在同一个同步段里，中间不能再 await，否则并发调用会一起通过检查。
      // 版本 B：标题是回执/面板/计划文件名/通知的公共出口——写入前把台账已知编号换成 tk-（硬清洗）。
      const title = sanitizeFacing(String(args.title).trim())
      const goal = String(args.goal).trim()
      const depends = validateDepends(db, args.dependsOn)
      if (depends.ok === false) {
        log('task.create.rejected', { agentId, detail: { reason: 'depends', message: depends.error, callId } })
        return `依赖不合法：${depends.error}。`
      }
      const groupId = normalizeGroup(args.group)
      const writeScopes = normalizeScopes(args.writeScopes)
      const priority = normalizePriority(args.priority)
      const depState = dependencyState(db, { depends_on: depends.ids })
      const initialStatus = depState.ready ? 'pending' : 'waiting_dep'
      const duplicate = listTasks(db, { active: true })
        .find(task => task.title.trim() === title && task.goal.trim() === goal)
      if (duplicate !== undefined) {
        log('task.create.rejected', {
          agentId,
          detail: { reason: 'duplicate', existingTaskId: duplicate.id, existingStatus: duplicate.status, callId },
        })
        return `已存在任务「${taskLabelWithRef(duplicate)}」（${labelOf(duplicate.status)}），未重复创建。`
      }
      const maxQueue = config?.maxQueue ?? 50
      const queuedCount = queue?.pendingCount?.() ?? 0
      if (queuedCount >= maxQueue) {
        log('task.create.rejected', {
          agentId,
          detail: { reason: 'queue-full', maxQueue, pending: queuedCount, callId },
        })
        return `待派发队列已满（${maxQueue} 个），先 task_message({ action: 'stop' }) 或等队列消化后再派。`
      }
      // P9：worktree 结构化请求（零自然语言解析）。步骤里只碰结构化字段 + 插件给的仓库事实：
      // 「要不要建」由协调者已经判断过；这里只做互斥校验、复用查找、降级、多分支询问与落库。
      const parsedWorktree = parseWorktreeRequest(args)
      if (parsedWorktree.ok === false) {
        log('task.create.rejected', { agentId, detail: { reason: 'worktree-args', message: parsedWorktree.error, callId } })
        return `${parsedWorktree.error}。`
      }
      const wtRequest = parsedWorktree.request
      // P0-2：continue 复用同一份检出也会并发写（git 索引互相踩）。复用前按 worktree_path 判活跃占用：
      // 被活跃任务占着的候选剔掉（dependsOn 祖先不算——新任务会等它们 done 才派发）；
      // 候选全被占着就拒绝并给「dependsOn 串行 / worktreeMode:'new' 新建」两条路。
      // 只读 / 计划阶段与 worktree 互斥（错误优先级由 decideWorktreeIntent 给），先跳过占用预判。
      let existingCheckout
      if (wtRequest.mode === 'continue' && readOnly !== true && planFirst !== true) {
        const ledgerTasks = listTasks(db)
        const serialized = serializedIdsOf(ledgerTasks, depends.ids)
        const candidates = reusableCheckoutCandidates({ tasks: ledgerTasks, groupId, dependsOn: depends.ids })
        const blocked = candidates.filter(task => occupiesCheckout(task) && !serialized.has(task.id))
        const free = candidates.filter(task => !blocked.includes(task))
        if (free.length === 0 && blocked.length > 0) {
          log('task.create.rejected', {
            agentId,
            detail: {
              reason: 'checkout-busy',
              path: blocked[0].worktree_path ?? null,
              conflicts: blocked.map(task => task.id),
              callId,
            },
          })
          return checkoutRejection({
            path: blocked[0].worktree_path,
            conflicts: blocked.map(task => ({ task, path: task.worktree_path })),
          })
        }
        if (free.length > 0) {
          existingCheckout = {
            taskId: free[0].id,
            path: free[0].worktree_path,
            branch: free[0].worktree_branch ?? '',
            // 源仓库根：复用任务的 target 偏移要靠它换算（检出目录里同一个子目录）。
            repoRoot: free[0].repo_root ?? null,
          }
        }
      }
      const wtIntent = decideWorktreeIntent({
        request: wtRequest,
        policy: config?.worktreePolicy ?? 'auto',
        readOnly,
        planFirst,
        existingCheckout,
      })
      if (wtIntent.action === 'reject') {
        log('task.create.rejected', { agentId, detail: { reason: wtIntent.code, message: wtIntent.error, callId } })
        return `${wtIntent.error}`
      }
      let worktreeRecord
      let worktreeHint = wtIntent.hint ?? ''
      if (wtIntent.action === 'none') {
        worktreeRecord = { state: 'none', source: wtIntent.source }
      } else if (wtIntent.action === 'reuse') {
        worktreeRecord = {
          path: wtIntent.path,
          branch: wtIntent.branch,
          repoRoot: wtIntent.repoRoot ?? null,
          mode: 'continue',
          source: wtIntent.source,
          state: 'reused',
        }
      } else {
        // resolve：只有「可能真的建树」时才探测 git（普通任务一次 git 都不调）。
        // 没传 target 时探测协调者默认目录（指挥舱通常不是仓库 → 降级，行为可解释）。
        const probeDir = effectiveTarget ?? defaultDir() ?? stateDir
        const facts = await worktreeService.probeRepo(probeDir)
        let baseExists
        if (facts.isRepo === true && typeof wtIntent.base === 'string' && wtIntent.base.trim() !== '') {
          baseExists = await worktreeService.refExists(facts.repoRoot, wtIntent.base)
        }
        // 用户指定分支名时提前校验重名（默认 orch/<taskId> 天然唯一，派发时由 git 再兜一次）。
        if (facts.isRepo === true && typeof wtIntent.branch === 'string' && wtIntent.branch.trim() !== '') {
          if (await worktreeService.branchExists(facts.repoRoot, wtIntent.branch)) {
            log('task.create.rejected', { agentId, detail: { reason: 'BRANCH_EXISTS', branch: wtIntent.branch, callId } })
            return `worktreeBranch 已存在：${wtIntent.branch}（插件不自动改名：换名或改用 worktreeMode:"continue" 复用）。`
          }
        }
        const decision = decideWorktreeFacts({
          intent: wtIntent,
          facts,
          baseExists,
          recentDays: config?.worktreeRecentDays ?? 7,
        })
        // #10 多分支：**不落库**、不占并发位，把候选交回协调者去 ask_user_question。
        if (decision.action === 'ask') {
          log('task.create.worktree.needs-branch', {
            agentId,
            detail: { candidates: decision.candidates.length, n: decision.n, callId },
          })
          return branchChoiceText({ decision, title, days: config?.worktreeRecentDays ?? 7 })
        }
        if (decision.action === 'reject') {
          log('task.create.rejected', { agentId, detail: { reason: decision.code, message: decision.error, callId } })
          return `${decision.error}。`
        }
        worktreeHint = decision.hint ?? worktreeHint
        worktreeRecord = decision.action === 'degrade'
          ? { state: 'degraded', source: decision.source }
          : { state: 'requested', source: decision.source, repoRoot: facts.repoRoot, base: decision.base, mode: 'new' }
      }
      // 只读索引任务由模型经正常 task_create 创建；名单来自注册服务，worker 不增加服务权限。
      let workspaceIndexEntries
      if (title === INDEX_TITLE) {
        if (!readOnly || planFirst || fullAccess) return '工作区与仓库索引必须是普通只读任务，不使用 full 或计划模式。'
        try {
          workspaceIndexEntries = registeredWorkspaces(typeof workspaces === 'function' ? workspaces() : workspaces)
        } catch { return '工作区名单不可用：没有创建扫描任务，请稍后明确重试。' }
      }
      // T1：创建详情是台账里的快照，brief 只负责把子会话引到 task_detail。
      // 经验在创建前算好：完整内容写记忆文件（指针进 brief.experience），写不了文件时存内联块；
      // 两种形态都只进 task_detail，不进 brief 提示词，提示词长度因此与经验条数无关。
      let experience
      if (config?.memoryInject !== false) {
        try {
          const built = buildLessonBlock(db, {
            stateDir: lessonStateDir,
            projectKey: projectKeyOf(effectiveTarget),
            query: `${title} ${goal}`,
            limit: config?.memoryLimit ?? 3,
          })
          if (built.count > 0) {
            experience = built.mode === 'pointer' && typeof built.path === 'string'
              ? { path: built.path, count: built.count }
              : (built.block === '' ? undefined : { inline: built.block, count: built.count })
          }
        } catch { /* 记忆检索失败不能阻止派任务 */ }
      }
      // JSON.stringify 会丢掉 undefined，无 target 时 brief 与旧版一致；只读/计划/完整访问/经验/验收才写入标记。
      const brief = {
        ...args,
        // 清洗后的标题：brief_json 是 task_detail 的原文来源，不能让裸编号从这里回流出用户面。
        title,
        // 存规范化后的 spec（command 仍是 argv 数组 + 毫秒超时），不存原始入参：快照要稳定可重放。
        checks: checks.length > 0 ? specOf(checks) : undefined,
        // dependsOn 归一成台账 id（入参可以是 tk- 引用；brief 里存的是可执行的 id 口径）。
        ...(depends.ids.length === 0 ? {} : { dependsOn: depends.ids }),
        target: effectiveTarget,
        ...(readOnly ? { readOnly: true } : {}),
        ...(planFirst ? { planFirst: true } : {}),
        ...(fullAccess ? { access: 'full' } : {}),
        ...(experience === undefined ? {} : { experience }),
        workspaceIndexEntries,
        workspaceIndexScript: workspaceIndexEntries === undefined ? undefined : fileURLToPath(new URL('../scripts/workspace-index.mjs', import.meta.url)),
      }
      // 同写域并发防护：与活跃未隔离任务的 target 相同/互相包含，或写域重叠 → 按 config.sameDirGuard 处理。
      // 与去重/容量同理，「判定 + createTask」必须是同一个同步段（中间没有 await）：并发调用不会一起通过。
      // 新任务自己要被隔离或只读时不判：前者在独立检出里跑，后者不写文件。
      // 隔离状态列表与 write-guard 共用 ISOLATED_WORKTREE_STATES，不在这里另写一份。
      // 计划任务照常判：计划阶段虽然只读，但批准后会转可写，放过去等于把冲突推迟到批准那一刻。
      // allowConcurrent:true 是唯一的显式放行开关。
      const newTaskIsolated = ISOLATED_WORKTREE_STATES.includes(worktreeRecord?.state)
      const guard = decideWriteGuard({
        tasks: listTasks(db, { active: true }),
        target: effectiveTarget,
        scopes: writeScopes,
        dependsOn: depends.ids,
        mode: config?.sameDirGuard,
        allowConcurrent: args.allowConcurrent === true,
        skipChecks: newTaskIsolated || readOnly,
      })
      if (guard.action === 'reject') {
        log('task.create.rejected', {
          agentId,
          detail: {
            reason: guard.targetConflicts.length > 0 ? 'same-dir' : 'write-scope',
            mode: guard.mode,
            targetDir: effectiveTarget ?? null,
            conflicts: [...guard.targetConflicts, ...guard.scopeConflicts].map(({ task }) => task.id),
            callId,
          },
        })
        return guard.text
      }
      if (guard.note !== '') {
        log('task.create.concurrent-write', {
          agentId,
          detail: {
            mode: guard.mode,
            allowed: args.allowConcurrent === true,
            targetDir: effectiveTarget ?? null,
            conflicts: [...guard.targetConflicts, ...guard.scopeConflicts].map(({ task }) => task.id),
            callId,
          },
        })
      }
      const task = createTask(db, {
        brief,
        coordinatorSession: current.id ?? coordinatorSession,
        targetDir: effectiveTarget,
        readOnly,
        planFirst,
        goalRounds,
        access: fullAccess ? 'full' : null,
        worktree: worktreeRecord,
        // P2-4（D6）：官方 Team 板关联（可选）；没传就是 null，行为与之前完全一致。
        teamTask,
        dependsOn: depends.ids,
        groupId,
        writeScopes,
        priority,
        status: initialStatus,
      })
      // 默认分支名与检出路径要用 taskId 派生（协调者传了 branch 就用它的）。
      if (worktreeRecord?.state === 'requested') {
        const branch = branchNameFor(wtRequest, task.id, config?.worktreeBranchPrefix)
        const checkout = checkoutPathFor(worktreeRecord.repoRoot, task.id)
        setTaskWorktree(db, task.id, { branch, path: checkout })
        worktreeRecord = { ...worktreeRecord, branch, path: checkout }
      }
      log('task.create.created', {
        taskId: task.id,
        agentId,
        sessionId: current.id,
        detail: {
          title,
          callId,
          targetDir: effectiveTarget ?? null,
          readOnly,
          planFirst,
          access: fullAccess ? 'full' : null,
          dependsOn: depends.ids,
          group: groupId,
          writeScopes,
          priority,
          status: initialStatus,
          worktree: worktreeRecord?.state ?? 'none',
          worktreeSource: worktreeRecord?.source ?? null,
          checks: checks.length,
          goalRounds,
          // P2-4：关联了官方板任务才多这个字段（没关联与旧日志逐字一致）。
          ...(teamTask === null ? {} : { teamTaskId: teamTask.id, teamTaskRevision: teamTask.revision }),
        },
      })
      // P1：简报正文不再进台账（真源 = 子会话第一条 user/message，且可由 renderBriefForTask 确定性重渲染）。
      const briefBody = compactMessage('brief', renderBriefForTask(task))
      addMessage(db, task.id, { kind: 'brief', rendered: briefBody.rendered, meta: briefBody.meta })
      // 并发风险提示：require 档被 allowConcurrent 放行、warn 档照常创建时由 guard 给；
      // off 档退回旧的 advisory 一行（保持历史行为，不静默消失）。
      const conflictNote = guard.note !== ''
        ? guard.note
        : (guard.mode === 'off' ? conflictsText(writeScopeConflicts(writeScopes)) : '')
      const depNames = depends.ids.map(id => {
        const dep = getTask(db, id)
        // 用户面零裸编号：找不到的前置不写 id（写「已不存在」），找到的写名称 + 引用。
        return dep === undefined ? '已不存在的任务' : `「${taskLabelWithRef(dep)}」（${labelOf(dep.status)}）`
      }).join('、')
      const dependencyNote = depends.ids.length === 0 ? '' : `前置任务：${depNames}`
      // 完整访问在返回里明说：用户/协调者要能一眼看出这次子会话不在沙箱里跑。
      const accessNote = fullAccess ? ACCESS_FULL.createNote : ''
      const checksNote = checks.length === 0
        ? ''
        : `验收：已配置 ${checks.length} 条可执行检查（交付前在任务目录自动执行；未通过则拒绝交付、任务保持进行中）。`
      // P2-2：续跑是显式开的——回执写清楚「轮次由宿主 driver 驱动」，别让人以为插件在自己续。
      const goalRoundsNote = goalRounds > 0
        ? `续跑：goalRounds=${goalRounds}（平台 goal 保持 armed，由宿主 goal 轮次驱动；进度看 task_status 的「目标轮次」）。`
        : ''
      // 配置的协调者会话失效时直接失败：挂进队列只会永远派不出去。
      if (current.live === false) {
        const message = invalidHint() === '' ? '协调者会话已失效' : invalidHint()
        log('task.spawn.failed', { taskId: task.id, agentId, detail: { error: message, callId } })
        transition(db, task.id, 'failed', { error: message })
        throw new Error(message)
      }
      if (initialStatus === 'waiting_dep') {
        const pendingWorktree = worktreeNoteLines({
          state: worktreeRecord?.state ?? 'none',
          branch: worktreeRecord?.branch,
          path: worktreeRecord?.path,
          base: worktreeRecord?.base,
          hint: worktreeHint,
        })
        // 回执补一句「自动晋升、不占回合」：否则协调者看到「等待前置」就会自己盯着等，机制白搭。
        const notes = [dependencyNote, TASK_CHAIN_WAITING_NOTE, checksNote, goalRoundsNote, teamTaskNote, accessNote, conflictNote, ...pendingWorktree].filter(Boolean).join('\n')
        log('task.dep.waiting', { taskId: task.id, detail: { dependsOn: depends.ids, callId } })
        return `任务「${taskLabelWithRef(task)}」已创建，等待前置任务完成。${notes === '' ? '' : `\n${notes}`}`
      }
      const outcome = await queue.enqueueAndPump(task.id)
      const resultTask = outcome.task
      const inferredNote = inferred === undefined ? '' : `（目标目录按工作区推断：${inferred.path}）`
      const planNote = planFirst ? planCreateReceipt(title) : ''
      // 派发后以台账实际状态为准（created / reused / degraded / failed），不要凭创建期的计划糊弄用户。
      const worktreeLines = worktreeNoteLines({
        state: resultTask?.worktree_state ?? worktreeRecord?.state ?? 'none',
        branch: resultTask?.worktree_branch ?? worktreeRecord?.branch,
        path: resultTask?.worktree_path ?? worktreeRecord?.path,
        base: resultTask?.worktree_base ?? worktreeRecord?.base,
        error: resultTask?.status === 'failed' ? resultTask.error : undefined,
        hint: worktreeHint,
      })
      const notes = [invalidHint(), inferredNote, planNote, checksNote, goalRoundsNote, teamTaskNote, accessNote, ...worktreeLines, conflictNote, dependencyNote]
        .filter(Boolean).join('\n')
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? toolFailure('RETRY_FAILED', {}))
      if (resultTask?.status === 'running') {
        return `任务「${taskLabelWithRef(task)}」已派发，子会话 ${resultTask.target}。${notes === '' ? '' : `\n${notes}`}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务「${taskLabelWithRef(task)}」已创建，前面还有 ${ahead} 个任务在排队，轮到时自动派发。${notes === '' ? '' : `\n${notes}`}`
    }),

    // P1-B：task_inbox 并入 task_list 的 view:'inbox'（输出逐字等价，入口从 2 个减到 1 个）。
    wrap('task_list', '列出任务。view:"list"（默认）列活跃任务（waiting_dep/pending/running/waiting/待确认），active=false 连历史一起列，可按 group 过滤看组进度；view:"inbox" 是收件箱（待你决定/待确认/失败丢失/长时间没动静，只读不写台账，原 task_inbox）。', objectSchema({
      view: { type: 'string', enum: ['list', 'inbox'], description: '视图：list（默认，任务列表）｜inbox（收件箱，吸收原 task_inbox）' },
      active: { type: 'boolean', description: 'list 视图：是否只看活跃任务，默认 true' },
      group: str('list 视图：可选，只看这个分组的任务'),
      limit: { type: 'number', description: 'inbox 视图：每类最多几条，默认 10，最大 20' },
    }), async (args, exec) => {
      const view = typeof args.view === 'string' ? args.view.trim() : ''
      if (view === 'inbox') return inboxView(args, exec)
      if (view !== '' && view !== 'list') {
        return `view 只能是 list / inbox（默认 list）：收到的是 ${JSON.stringify(args.view)}。旧的 task_inbox 已并入本工具，改成 task_list({ view: 'inbox' })。`
      }
      if (view === '' && args.limit !== undefined) {
        return 'limit 只在收件箱视图生效：要看「待你决定/失败/长时间没动静」请传 view: \'inbox\'（原 task_inbox 已并入本工具）。'
      }
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const all = listTasks(db, { active: args.active !== false })
      const group = typeof args.group === 'string' ? args.group.trim() : ''
      const tasks = group === '' ? all : all.filter(task => task.group_id === group)
      if (tasks.length === 0) {
        if (group !== '') return `组「${group}」里没有任务。`
        return args.active === false ? '台账里还没有任何任务。' : '没有活跃任务。'
      }
      const delivered = tasks.filter(task => task.status === 'delivered').length
      const header = group === ''
        ? ''
        : `组「${group}」：${tasks.filter(task => task.status === 'done').length}/${tasks.length} 完成`
          + `${delivered > 0 ? `｜待确认 ${delivered}` : ''}\n`
      return header + tasks.map(task => taskLine(db, task, { staleMinutes })).join('\n')
    }),

    wrap('task_status', '查看一个任务的详情与最近消息。', objectSchema({
      task_id: str('任务编号，如 t-1a2b3c4d'),
      include: str('可选：填 full 时返回子会话最新返回消息的全文（正文从宿主会话日志冷读；读不到降级为摘要）'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const found = findTaskInput(args.task_id)
      if (found.ok !== true) return found.message
      const task = found.task
      const messages = recentMessages(db, task.id, 3)
      const recent = messages.map(row => `- [${row.kind}] ${short(row.rendered, 80)}`).join('\n')
      const planLine = planStatusLine(task)
      const worktreeLine = worktreeStatusLine(task)
      const lines = [
        `任务「${taskLabelWithRef(task)}」`,
        `状态：${labelOf(task.status)}`,
        ...(task.read_only ? ['权限：只读（读正常，写文件/写 shell 被拒绝）'] : []),
        ...(task.access === 'full' ? [`访问级别：${ACCESS_FULL.label}`] : []),
        ...(planLine === undefined ? [] : [planLine]),
        ...(worktreeLine === undefined ? [] : [worktreeLine]),
        ...(task.group_id ? [`分组：${task.group_id}`] : []),
        ...(task.priority !== 0 ? [`优先级：${task.priority}`] : []),
        // 用户拍板（2026-11-22）：这一行**保留会话标识**（原计划 §12 讨论过改成「面板可打开」，
        // 用户选择保留 id——排障时要从回执直接拿到会话）。行结构属输出契约，不要擅自换值形态。
        `子会话：${task.target ?? '-'}`,
        ...(task.status === 'waiting_dep'
          ? [`等待前置：${task.depends_on.map(id => {
            const dep = getTask(db, id)
            // 版本 B：前置列表写「名称（tk-）」，不写裸编号（找不到的写「已不存在」）。
            return dep === undefined ? '已不存在的任务' : taskLabelWithRef(dep)
          }).join('、')}`]
          : []),
        ...(task.status === 'pending'
          ? [`排队：${task.queued_at === null || task.queued_at === undefined ? '待派发（刚创建）' : '排队中（等待并发槽位）'}`]
          : []),
        `目标：${task.goal}`,
      ]
      // 两段式终态：交付时间 + 确认动作 + 超时阈值；关闭原因是审计信息（协调者确认 / 超时）。
      if (task.status === 'delivered') {
        const timeout = Number.isFinite(config?.deliveredTimeoutMinutes)
          ? Math.max(1, Math.min(1440, Math.floor(config.deliveredTimeoutMinutes)))
          : DELIVERED_TIMEOUT_MINUTES
        lines.push(`交付：${DELIVERY_LINES.state}（默认等你或用户确认：要改 ${DELIVERY_LINES.followupRule}；`
          + `确认完成才 ${DELIVERY_LINES.closeCall}；超过 ${timeout} 分钟自动完成）`)
      }
      if (task.close_reason !== null && task.close_reason !== undefined) {
        lines.push(`关闭：${closeReasonLabel(task.close_reason)}`)
      }
      // P2-3 交接契约 v1：谁确认/何时确认/几轮——没交付过的任务没有交接段（返回空数组）。
      lines.push(...handoffStatusLines(handoffOfTask(db, task)))
      // P2-4（D6）：关联了官方 Team 板任务才多这一行（没关联与旧输出逐字一致）。
      const teamLine = teamLinkStatusLine(task)
      if (teamLine !== '') lines.push(teamLine)
      // P2-1 A1：交付前机器验收——有结果就逐条列（退出码/耗时/截断），没跑过但配了检查也要说清。
      if (task.acceptance !== null) {
        lines.push(...acceptanceStatusLines(task.acceptance))
      } else if (checksOf(task).length > 0) {
        lines.push(`验收：已配置 ${checksOf(task).length} 条可执行检查（交付前自动执行，未通过拒绝交付）`)
      }
      // 平台 goal 只读状态（G1 / P2-2）：让协调者不用打开面板也能确认目标生命周期与续跑进度。
      if (task.goal_state !== null && task.goal_state !== undefined) {
        const phase = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成', cleared: '已清除' }[task.goal_state.phase] ?? task.goal_state.phase ?? '未知'
        // armed 在 P2-2 后是「显式要续跑」的正常状态（goalRounds>0），不再是异常。
        const activation = task.goal_state.activation === 'armed'
          ? '自动续轮（宿主 goal 轮次驱动）'
          : '不自动续轮'
        lines.push(`目标状态：${phase}｜${activation}${task.goal_state.revision === undefined ? '' : `｜修订 ${task.goal_state.revision}`}`)
        // 轮次真源是平台 goal（插件不持有预算）：有进度就报 x/y，方便判断「续跑到底跑没跑」。
        const roundsStarted = Number.isFinite(task.goal_state.roundsStarted) ? task.goal_state.roundsStarted : 0
        const maxRounds = Number.isFinite(task.goal_state.maxGoalRounds) ? task.goal_state.maxGoalRounds : null
        if (roundsStarted > 0 || (task.goal_state.activation === 'armed' && maxRounds !== null)) {
          lines.push(`目标轮次：${roundsStarted}/${maxRounds ?? '?'}${task.goal_state.activation === 'armed' ? '（续跑中）' : ''}`)
        }
      } else if ((task.goal_rounds ?? 0) > 0) {
        // 配了续跑但平台还没有 goal（能力缺失/子会话未起）：如实说清「现在没在续」，不假装。
        lines.push(`续跑：已配置 goalRounds=${task.goal_rounds}，但平台 goal 尚未建立（当前不会自动续轮）`)
      }
      if (task.depends_on.length > 0 && task.status !== 'waiting_dep') {
        lines.push(`前置任务：${task.depends_on.map(id => {
          const dep = getTask(db, id)
          return dep === undefined ? '已不存在的任务' : taskLabelWithRef(dep)
        }).join('、')}`)
      }
      if (task.write_scopes.length > 0) lines.push(`写域：${task.write_scopes.join('、')}`)
      if (task.question) {
        lines.push(`问题：${task.question}`)
        if (task.options.length > 0) lines.push(`选项：${task.options.join(' / ')}`)
      }
      // 版本 B：重派来源写**被重派那条任务的引用**（行结构不变，只换值形态）。
      if (task.retry_of) {
        const source = getTask(db, task.retry_of)
        lines.push(`重派自：${source === undefined ? '已不存在的任务' : taskLabelWithRef(source)}`)
      }
      if (task.error !== null && task.error !== undefined) lines.push(`原因：${task.error}`)
      // P6/T6.2：产物区块（错过通知时的兜底回流路径）。与通知同一口径（artifactLines 共用）：
      // 只列 present 能接住的普通文件，目录 / 符号链接 / 已不存在只计数不进清单；带交付指令。
      lines.push(...artifactLines({ artifacts: task.artifacts }, { counts: true }))
      // B1（P1）：结算时落的最完整返回消息 → 主会话不必打开子会话就能读到它最后说了什么。
      // 台账里只有借条；`include=full` 时按需从宿主会话日志冷读正文，读不到显式降级为摘要。
      if (task.last_message !== null && task.last_message !== undefined) {
        const resolved = args.include === 'full'
          ? await resolveLastMessage(task.last_message, { body: bodySource, sessionId: task.session_id })
          : null
        lines.push(...lastMessageLines(task.last_message, { full: args.include === 'full', resolved }))
      }
      if (task.session_id !== null && task.session_id !== undefined) {
        lines.push('打开方式：协调者会话的子代理目录（subagent catalog），按上面的子会话 id 打开；它不在普通会话列表里。')
      }
      lines.push(`最近消息：\n${recent || '- 无'}`)
      return lines.join('\n')
    }),

    // T1：brief 纯指引化后，创建详情由子会话自己读。只读 + owner-only：
    // 台账里 brief 是创建时快照，前置任务/产物按当前台账现读；不写库、不改状态。
    wrap('task_detail', '子会话读任务创建详情（只读）：目标全文、验收标准、约束、背景资料、用户原话、工作目录与权限、前置任务、经验文件、已有产物。只对该任务自己的子会话开放，越权调用会被拒绝。', objectSchema({
      task_id: str('任务编号（brief 的【任务编号】里给过，如 t-1a2b3c4d）'),
    }), async (args, exec) => {
      const found = findTaskInput(args.task_id)
      if (found.ok !== true) return found.message
      const task = found.task
      const agent = exec?.agent
      const caller = agent?.id ?? agent?.session?.id
      const callerId = caller === null || caller === undefined ? undefined : String(caller)
      const ownerId = task.session_id === null || task.session_id === undefined ? undefined : String(task.session_id)
      // 越权拒绝：主会话要详情用 task_status；别的子会话读不到不是自己的任务。
      if (ownerId === undefined || callerId === undefined || callerId !== ownerId) {
        log('task.detail.rejected', { taskId: task.id, agentId: agent?.id, detail: { caller: callerId ?? null, owner: ownerId ?? null } })
        return `读取被拒绝：task_detail 只对任务自己的子会话开放（任务「${taskLabelWithRef(task)}」属于子会话 ${task.target ?? ownerId ?? '（尚未派发）'}，当前调用方 ${callerId ?? '（未知）'}）。主会话查任务用 task_status。`
      }
      return renderTaskDetail(task, {
        // 前置任务/摘要按当前台账现读：依赖可能在创建之后才完成。
        dependencies: upstreamBrief(db, task.depends_on),
        experience: task.brief?.experience,
        artifacts: task.artifacts,
      })
    }),

    // P1-B：task_stop / task_retry / task_close 并入本工具的 action（业务实现一字未改，只换入口）。
    // v0.24：新增 action:"resume"（续跑原会话），与 retry 的分工见 resumeTask 的注释。
    wrap('task_message', '子任务动作统一入口：action:"message"（默认）给已有子任务追加消息（续派），进行中/等你确认/要授权/待确认都能续派，投递失败会重试 3 次；action:"resume" 续跑 failed/orphaned（或超时完成）的任务——同一任务、同一子会话冷恢复，上下文延续；action:"stop" 停止任务（运行中/排队/等前置/待确认）；action:"retry" 重派 failed/orphaned 任务（新任务编号 + 新子会话，旧任务留审计）；action:"close" 把「已交付待确认」确认成 done。task_id 必填，message 仅 action:"message"/"resume" 可选。', objectSchema({
      task_id: str('任务编号'),
      action: {
        type: 'string',
        enum: MESSAGE_ACTIONS,
        description: '动作：message（默认，追加消息/续派）｜resume（续跑原会话：同任务同子会话冷恢复，用于失败/会话丢失后接着干）｜stop（停止任务，吸收原 task_stop）｜retry（重派 failed/orphaned：新任务新会话，吸收原 task_retry）｜close（确认已交付待确认 → done，吸收原 task_close）',
      },
      message: str('要追加的内容（action:"message" 必填；action:"resume" 可选，作为本轮续跑指示）。用户追加调整时先按协调者 policy 评估（'
        + `${CHANGE_REVIEW_FIELDS}）并取得确认，消息里写清新方向、不动的部分、验收是否变`),
    }), async (args, exec) => {
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (action === 'resume') return resumeTask(args, exec)
      if (action === 'stop') return stopTask(args, exec)
      if (action === 'retry') return retryTask(args, exec)
      if (action === 'close') return closeTask(args, exec)
      if (action !== '' && action !== 'message') {
        return `action 只能是 ${MESSAGE_ACTIONS.join(' / ')}（默认 message）：收到的是 ${JSON.stringify(args.action)}。`
          + '旧的 task_stop / task_retry / task_close 已并入本工具，分别对应 action: "stop" / "retry" / "close"（映射见 CHANGELOG「P1-B 工具面 15 → 10」）。'
      }
      // message 动作必须有内容：旧 task_message 允许空串（等于「什么都没说」却改了状态），这里顺手收紧，
      // 顺带把「你是不是想 stop/retry/close」说清楚，别让旧调用只拿到一句「缺参数」。
      const text = typeof args.message === 'string' ? args.message : ''
      if (text.trim() === '') {
        return 'action:"message" 需要 message（要追加的内容）。'
          + '要停止 / 重派 / 确认完成请分别传 action: "stop" / "retry" / "close"——这三个动作吸收自已删除的 task_stop / task_retry / task_close（旧名 → 新调用见 README「工具迁移映射」）。'
      }
      return messageTask(args, exec)
    }),

    // 受控读（协调者读产物）：平台的文件工具没有读路径白名单（沙箱只管写、cwd 不是边界、
    // glob 直接 ripgrep 全树枚举），所以产物侧自建一条边界由插件算的入口；协调者预设的原生工具
    // 只剩 read（t-4f7ce108 起 glob/grep 不挂），也仍是全盘可读、没有产物边界。
    // 边界 = **主会话工作区包含性 OR 已登记产物**（审计 §2.1 方案 C）：子会话按契约把产物写在
    // target 目录内，而 target 通常不在工作区里；把台账 artifacts 当第二判据，读取面仍然只有
    // 「工作区 + 已登记集合」，不必为看一眼产物新派任务，也不把整个 target 仓库暴露出来。
    wrap('read_workspace', '读产物正文：主会话工作区内的文件/目录，或任务回报过 artifacts 的已登记产物（子会话产物通常写在 target 目录内，不在工作区里）。越界、未登记、符号链接逃逸、路径穿越一律拒绝；大文件按行窗口截断并给续读 offset。', objectSchema({
      path: str('主会话工作区内的相对路径（如 reports/plans/计划.md、diag/）、工作区内的绝对路径，或已登记产物的绝对路径'),
      offset: { type: 'number', description: '起始行号（1 起），默认 1' },
      limit: { type: 'number', description: `最多返回多少行，默认 ${DEFAULT_LINES}，上限 ${MAX_LINES}` },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const root = defaultDir()
      if (root === undefined) return '读取失败：没有主会话工作区可用（主会话尚未打开），请先从面板「打开主会话」。'
      // 已登记产物是第二个判据（与 present 同源）：一次性汇总台账里所有任务的 artifacts，
      // 台账量级是几百行、产物上限 50/任务，开销可忽略（不做缓存，避免登记后读不到）。
      const registered = registeredArtifacts(listTasks(db, { active: false }))
      const result = readWorkspaceFile({ root, path: args.path, offset: args.offset, limit: args.limit, registered })
      if (result.ok !== true) {
        // 越界/穿越/符号链接逃逸都要留痕：这是安全边界上的拒绝，出问题要能查。
        log('workspace.read.rejected', {
          agentId: exec?.agent?.id,
          detail: { path: typeof args.path === 'string' ? args.path.slice(0, 400) : null, error: result.error, callId: exec?.callId },
        })
        return `读取失败：${result.error}`
      }
      log('workspace.read', {
        agentId: exec?.agent?.id,
        detail: {
          path: result.path,
          kind: result.kind,
          bytes: result.size ?? null,
          // 凭什么可读：workspace（工作区包含性）/ registered（已登记产物）。排障时不用猜。
          via: result.via ?? 'workspace',
          artifactTaskId: result.artifact?.taskId ?? null,
          callId: exec?.callId,
        },
      })
      return renderWorkspaceRead(result)
    }),

    // P1-B：history_search + project_context 合并成 context（mode 区分）。
    // P0（0.26.0 记忆优化）：history 首行打印【检索范围】、project 支持多键/'all'、日志层单独成块、
    // project 白名单加 docs/ARCHITECTURE.md。行为变更见 CHANGELOG。
    // 「读」对协调者与子会话都开放（同一条实现、同参数逐字同输出）；「写」只在 memory_note：
    // 协调者写任意项目与全局偏好，子会话只写自己任务目录的项目记忆（见下面的护栏）。
    wrap('context', '读上下文（只读，不开放任意文件读取；协调者与子会话都可用）：mode:"history"（默认）查历史——本插件记忆（首行打印【检索范围】；不传 project 只查 global 跨项目记忆，要查本项目请显式传 target_dir 或工作区名）、历史任务、平台历史会话，新任务开始前用它补上下文，结果只作参考不作状态断言；mode:"project" 读项目背景——README/AGENTS/docs/ARCHITECTURE.md/package 等白名单文件、顶层结构、最近任务、相关记忆；mode:"workspaces" 返回已登记工作区与持久化仓库采样索引（不扫描全盘）。', objectSchema({
      mode: { type: 'string', enum: CONTEXT_MODES, description: '读哪一类：history（默认，历史检索，吸收原 history_search）｜project（项目背景，吸收原 project_context）｜workspaces（已登记工作区 + 仓库索引）' },
      query: str('history：检索关键词（任务名/目标/决策/文件名）；project：用于推断项目与匹配记忆的关键词'),
      project: str('history：项目绝对路径、工作区名，或字符串数组（合并 ≤2 个项目键）/ "all"（全部项目）；不传只查 global（跨项目记忆），要查本项目必须显式传 target_dir 或工作区名'),
      target: str('project：项目绝对目录；不传则按 query 推断或使用主会话目录'),
      include: strList('project：可选，显式包含的白名单文档（目前支持 docs/ARCHITECTURE.md；默认给前 1200 字，显式 include 给前 4000 字）'),
      limit: { type: 'number', description: 'history：事实层最多几条，默认 5，最大 10（日志层 task-log 另给 ≤2 条、排在事实层之后）' },
      workspaces: { type: 'boolean', description: '兼容旧调用 project_context({ workspaces: true })：等价 mode:"workspaces"（新调用请直接用 mode）' },
    }), async (args, exec) => {
      const mode = typeof args.mode === 'string' ? args.mode.trim() : ''
      // 旧入参形状继续可用（不静默）：workspaces:true 等价 mode:'workspaces'，只有 target 等价 mode:'project'。
      if (mode === 'workspaces' || (mode === '' && args.workspaces === true)) return workspacesView(args, exec)
      if (mode === 'project' || (mode === '' && typeof args.target === 'string' && args.target.trim() !== '')) return projectView(args, exec)
      if (mode === '' || mode === 'history') return historyView(args, exec)
      return `mode 只能是 ${CONTEXT_MODES.join(' / ')}（默认 history）：收到的是 ${JSON.stringify(args.mode)}。`
        + '旧的 history_search → context({ mode: "history", query })；旧的 project_context → context({ mode: "project", target }) 或 context({ mode: "workspaces" })（映射见 CHANGELOG）。'
    }),

    // 记忆写入的**单一路由**（审计 §5.3 待定项 2 的「不双写」）：
    //   全局偏好 → 只写 settings.orchestrator_preferences（每回合注入 L1 协调者 policy）；
    //   项目偏好 / 其它 kind → 只写 memories（随 task_detail 注入子会话 / 供 context 检索）。
    // 一条事实只落一处，不存在「两份真相」。
    // 写入权（2026-11-21）：协调者可写全局偏好与任意项目；任务子会话可写**自己任务目录**的项目记忆
    // （note/lesson/decision，单任务 ≤3 条、去重、来源留痕），preference 与全局/跨项目记忆仍只属协调者。
    wrap('memory_note', '记住一条跨任务有效的决策/经验，或一条偏好。协调者（主会话）可写任意项目与全局偏好：kind:preference 不传 project 时写进协调者偏好（每回合注入提示词，立即生效）。任务子会话只能写自己任务 target_dir 的项目记忆（note/lesson/decision，project 强制为本任务目录、单任务最多 3 条、重复内容幂等；写 preference 与全局/跨项目记忆会被拒并给替代路径）。其余写进 memories 事实层（供 context({ mode: "history" }) 与 task_detail 注入）。只收原子事实，长日志/verbatim 会被蒸馏丢弃。', objectSchema({
      text: str('要记住的内容，一两句话'),
      project: str('可选：项目绝对路径或工作区名；不传记为全局（子会话只能传自己任务的 target_dir）'),
      kind: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson'], description: '类型，默认 note（子会话不能写 preference）' },
    }), async (args, exec) => {
      const current = status()
      if (current.id === undefined) return UNBOUND_HINT
      const callerId = exec?.agent?.id
      // 协调者：原行为不变（全局偏好走 settings、任意项目走 memories）。
      if (callerId === current.id) {
        // 写入即蒸馏：去代码块/命令日志并按事实层上限截断，避免长日志混进 brief。
        const text = distillText(args.text, MAX_FACT_CHARS)
        if (text === '') return '要记的内容不能为空。'
        const hint = resolveProjectHint(args.project)
        const kind = ['note', 'decision', 'preference', LESSON_KIND].includes(args.kind) ? args.kind : 'note'
        // 全局偏好走 settings（协调者取向），不进 memories；项目偏好仍是项目约定，走 memories。
        if (kind === 'preference' && hint.key === GLOBAL_PROJECT) {
          const saved = upsertPreference(db, {
            id: `p-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`,
            category: 'general',
            rule: text,
            scope: 'global',
            appliesTo: 'coordinator',
            priority: 50,
            source: 'user',
            addedAt: Date.now(),
          })
          log('memory.note', {
            agentId: exec?.agent?.id,
            detail: { projectKey: hint.key, kind, route: 'preferences', count: saved.length, callId: exec?.callId },
          })
          return preferenceSavedHint(hint.title)
        }
        const saved = remember(db, {
          text,
          projectKey: hint.key,
          kind,
          sourceSessionId: exec?.agent?.id,
        })
        if (saved === undefined) return '这条已经记过，未重复写入。'
        log('memory.note', {
          agentId: exec?.agent?.id,
          detail: { projectKey: hint.key, kind, route: 'memories', callId: exec?.callId },
        })
        if (kind === 'preference') return projectPreferenceSavedHint(hint.title)
        return `已记住（${hint.title ?? '全局'}）。`
      }

      // 子会话：归属 → 项目 → kind → 去重/上限，全部是硬护栏（拒绝时不写库）。
      const workerTask = taskOfWorker(callerId)
      if (workerTask === undefined) {
        return rejectWorkerMemory(exec, 'worker-no-task',
          `拒绝：找不到你的任务归属（会话 ${callerId ?? '未知'} 不在台账里），写不了项目记忆——项目键必须来自任务的 target_dir。${WORKER_MEMORY_FALLBACK}`)
      }
      const taskProjectKey = typeof workerTask.target_dir === 'string' && workerTask.target_dir.trim() !== ''
        ? projectKeyOf(workerTask.target_dir)
        : undefined
      if (taskProjectKey === undefined) {
        return rejectWorkerMemory(exec, 'worker-no-target',
          `拒绝：任务「${taskLabelWithRef(workerTask)}」没有 target 目录，写不了项目记忆（项目键必须来自任务的 target_dir）。${WORKER_MEMORY_FALLBACK}`)
      }
      if (args.kind === 'preference') {
        return rejectWorkerMemory(exec, 'worker-preference-denied',
          '拒绝：子会话不能写全局偏好（kind:"preference"）——偏好会每回合注入协调者 policy，只由协调者维护。'
          + `要沉淀的项目约定请用 kind:"note" / "lesson" / "decision"；${WORKER_MEMORY_FALLBACK}`)
      }
      const text = distillText(args.text, MAX_FACT_CHARS)
      if (text === '') return '要记的内容不能为空。'
      const kind = ['note', 'decision', LESSON_KIND].includes(args.kind) ? args.kind : 'note'
      // project 只认本任务 target_dir：不传就强制落本项目；传了别的项目（含 global）直接拒绝，不静默串项目。
      if (typeof args.project === 'string' && args.project.trim() !== '') {
        const asked = resolveProjectHint(args.project)
        if (asked.key !== taskProjectKey) {
          return rejectWorkerMemory(exec, 'worker-project-mismatch',
            `拒绝：子会话只能写自己任务的项目记忆——本任务的项目是 ${taskProjectKey}（task_detail 的「工作目录」），收到的是 ${asked.key}。`
            + '不传 project 即写到本项目；要写别的项目/全局请让协调者 memory_note。')
        }
      }
      const used = countWorkerMemories(db, workerTask.id)
      if (used >= MAX_WORKER_MEMORIES_PER_TASK) {
        return rejectWorkerMemory(exec, 'worker-quota-denied',
          `拒绝：本任务已经写过 ${used} 条项目记忆（单任务上限 ${MAX_WORKER_MEMORIES_PER_TASK} 条）。${WORKER_MEMORY_FALLBACK}`)
      }
      const saved = remember(db, {
        text,
        projectKey: taskProjectKey,
        kind,
        source: MEMORY_SOURCE_WORKER,
        sourceTaskId: workerTask.id,
        sourceSessionId: callerId,
      })
      if (saved === undefined) return '已存在（already）：这条项目记忆已经记过，未重复写入。'
      log('memory.note', {
        agentId: callerId,
        detail: {
          projectKey: taskProjectKey, kind, route: 'memories', source: MEMORY_SOURCE_WORKER,
          taskId: workerTask.id, written: used + 1, cap: MAX_WORKER_MEMORIES_PER_TASK, callId: exec?.callId,
        },
      })
      return `已记住（项目：${taskProjectKey}｜本任务 ${used + 1}/${MAX_WORKER_MEMORIES_PER_TASK} 条）。`
    }),

    wrap('task_report', '子任务每轮结束必须调用：progress（有进展未完成）、done（完成；配置了 checks 的任务会先在任务目录自动执行验收，未通过则拒绝交付、任务保持进行中）、blocked（卡住等人决定）、needs_auth（需要授权）。协调者据此决定是否打扰用户。', objectSchema({
      task_id: str('任务编号，创建时给过'),
      status: { type: 'string', enum: REPORT_STATUS, description: 'progress / done / blocked / needs_auth' },
      summary: str('一句话说明这轮做了什么'),
      workspace_index: str('只读工作区与仓库索引任务专用：完整扫描JSON，entries含id/path/status/sampledAt和repoRoot/branch/head/origin/commonDir；仅done且本人可持久化'),
      question: str('blocked / needs_auth 时可选：要用户拍板的问题'),
      options: strList('blocked / needs_auth 时可选：给用户的选项，如 ["方案A", "方案B"]'),
      artifacts: {
        type: 'array',
        description: '可选：交付产物列表；path 可相对（按任务目录解析），label 是一句说明',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 不能写 required: true：DSH 作者态 schema 会原样进模型 JSON Schema，
            // provider 要求 required 是数组，布尔值直接 400（真机 rc.3 上每个子会话首回合都炸）。
            // path 的必填由 normalizeArtifacts 运行时校验（空 path 丢弃）。
            path: { type: 'string', description: '文件路径，可相对任务目录' },
            label: { type: 'string', description: '一句说明，可空' },
          },
        },
      },
    }), async (args, exec) => {
      const found = findTaskInput(args.task_id)
      if (found.ok !== true) return found.message
      const task = found.task
      if (!REPORT_STATUS.includes(args.status)) return `status 只能是 ${REPORT_STATUS.join(' / ')}。`
      const reporter = exec?.agent
      const reporterId = reporter?.id ?? reporter?.session?.id
      if (reporter !== undefined && task.session_id !== null && task.session_id !== undefined
        && String(reporterId) !== String(task.session_id)) {
        return `回报被拒绝：任务「${labelFor(task)}」属于子会话 ${task.target ?? task.session_id}，当前回报方不是它。`
      }
      if (args.workspace_index !== undefined) {
        if (args.status !== 'done' || String(reporterId) !== String(task.session_id) || !reporterId) return '索引回报被拒：仅任务自己的子会话 done 可持久化。'
        try { saveWorkspaceIndex(db, task, args.workspace_index) } catch {
          return '索引未保存、任务未交付：格式或名单不合法；修正后重新回报。'
        }
      }
      if (args.status === 'done' && Array.isArray(task.brief?.workspaceIndexEntries) && args.workspace_index === undefined) {
        return '索引任务必须用 workspace_index 回报完整JSON；尚未交付，请补充回报。'
      }
      // 两段式终态：重复 done 不重跑验收、不重复迁移（保持既有幂等）。
      const settled = task.status === 'delivered' || task.status === 'done'
      const deliveredNow = args.status === 'done' && !settled
      // P2-1 A1：交付前机器验收。命令只来自 brief 快照（协调者写入 task_create），
      // task_report 没有任何命令参数——子会话无法注入/覆盖要跑的东西。
      // 失败 = 拒绝交付：不迁移状态、不登记产物、不发交付通知；只落验收证据 + kind:'acceptance' 消息。
      let acceptanceNotice = ''
      // 校验失败 = 配置坏了：拒绝交付（fail-closed），不静默当成「没配检查」。
      const normalizedChecks = normalizeChecks(task?.brief?.checks ?? task?.acceptance?.spec)
      if (deliveredNow && normalizedChecks.ok !== true) {
        const failure = `验收配置不可解析：${normalizedChecks.error}。未执行检查，拒绝交付（状态不变）；请协调者修正 checks 后重派。`
        addMessage(db, task.id, { kind: 'acceptance', rendered: failure })
        log('task.acceptance.invalid', {
          taskId: task.id,
          detail: { message: normalizedChecks.error, callId: exec?.callId },
        })
        return failure
      }
      const checks = normalizedChecks.ok === true ? normalizedChecks.checks : []
      if (deliveredNow && checks.length > 0) {
        const result = await runAcceptance({ checks, cwd: executionDirOf(task) })
        setTaskAcceptance(db, task.id, {
          spec: specOf(checks),
          ranAt: result.ranAt,
          cwd: result.cwd,
          ok: result.ok,
          total: result.total,
          passed: result.passed,
          skipped: result.skipped,
          failed: result.failed,
          // P0-1：本轮轮次标记。结算侧据此判断证据是否属于本轮（追问/续跑会让 attempts +1，
          // 上一轮通过的记录因此自动失效，自然结束不被上一轮证据洗成交付）。
          attempts: Number.isFinite(task.attempts) ? task.attempts : 0,
          results: result.results,
        })
        log('task.acceptance', {
          taskId: task.id,
          agentId: exec?.agent?.id,
          detail: {
            ok: result.ok,
            total: result.total,
            passed: result.passed,
            skipped: result.skipped,
            failed: result.failed,
            checks: checks.map(item => item.name),
            cwd: result.cwd,
            callId: exec?.callId,
          },
        })
        if (result.ok !== true) {
          const failureText = acceptanceFailureText(result)
          const reportBody = compactMessage('report', renderReportText('done', args.summary ?? ''))
          addMessage(db, task.id, { kind: 'report', rendered: reportBody.rendered, meta: reportBody.meta })
          addMessage(db, task.id, { kind: 'acceptance', rendered: failureText })
          log('task.acceptance.rejected', {
            taskId: task.id,
            detail: {
              failed: result.results.filter(item => item.ok !== true && item.skipped !== true).map(item => item.name),
              callId: exec?.callId,
            },
          })
          return failureText
        }
        acceptanceNotice = acceptancePassText(result)
      }
      // 显式产物优先；done 时再用 workspaceChanges 摘要补齐整轮改动文件（同路径去重，显式标签覆盖自动标签）。
      const normalized = normalizeArtifacts(task, args.artifacts)
      let artifacts = normalized.artifacts
      let artifactsOmitted = normalized.omitted
      let auto = { artifacts: [], turns: 0, omitted: 0 }
      if (args.status === 'done') {
        auto = autoArtifacts(task, exec)
        if (auto.artifacts.length > 0) {
          const autoPaths = new Set(auto.artifacts.map(item => item.path))
          const unique = autoPaths.size + artifacts.filter(item => !autoPaths.has(item.path)).length
          artifacts = mergeArtifacts(auto.artifacts, artifacts, MAX_TASK_ARTIFACTS)
          artifactsOmitted += auto.omitted + Math.max(0, unique - artifacts.length)
        }
      }
      // 版本 B 出口清洗（第 ② 层）：summary / question / options / 产物 label 是**用户会读到的文本**
      // （通知正文、blocked 的 question、抽屉里的产物清单），写入前把台账已知编号换成 tk-。
      // 产物 **path 不清洗**：那是真实文件路径（历史计划文件本来就叫 t-xxxx.md），改了就读不到。
      artifacts = artifacts.map(item => (typeof item?.label === 'string' && item.label !== ''
        ? { ...item, label: sanitizeFacing(item.label) }
        : item))
      const summaryFacing = sanitizeFacing(String(args.summary ?? ''))
      const question = typeof args.question === 'string' ? sanitizeFacing(args.question.trim()).slice(0, 500) : ''
      const options = Array.isArray(args.options)
        ? args.options.filter(item => typeof item === 'string' && item.trim() !== '')
          .map(item => sanitizeFacing(item.trim()).slice(0, 120)).slice(0, 10)
        : []
      if (artifacts.length > 0) {
        setTaskArtifacts(db, task.id, artifacts)
        log('task.report.artifacts', {
          taskId: task.id,
          detail: {
            count: artifacts.length,
            omitted: artifactsOmitted,
            missing: artifacts.filter(item => item.exists === false).length,
            autoTurns: auto.turns,
            autoCount: auto.artifacts.length,
          },
        })
      }
      const reportRow = compactMessage('report', renderReportText(args.status, summaryFacing))
      addMessage(db, task.id, { kind: 'report', rendered: reportRow.rendered, meta: reportRow.meta })
      if (acceptanceNotice !== '') addMessage(db, task.id, { kind: 'acceptance', rendered: acceptanceNotice })
      // 追问必达（t-99d4a98c）：台账里「在等回报」的标记 = 这份回报就是协调者追问/续跑后等的答案。
      // 读迁移前的行（迁移不碰这一列），读完立刻清标记：必达只对追问后的**第一条**回报生效，
      // 之后同任务再报 progress 回到正常水位节奏（否则一次追问会让整段长任务都变成即时唤醒）。
      const answeredFollowup = task.report_expected_at !== null && task.report_expected_at !== undefined
      if (answeredFollowup) clearReportExpected(db, task.id)
      let next = task
      // 两段式终态：子会话报 done 先落 delivered（已交付待确认），协调者 task_close / 超时才收成 done。
      // 已经在 delivered/done 上的回报是重复/迟到事件：只记消息，不迁移、不重复通知。
      if (args.status === 'done') {
        if (deliveredNow) {
          // blocked/needs_auth 之后子任务直接交付：先回到 running，再走合法迁移到 delivered。
          if (WAITING_STATUS.has(task.status)) next = transition(db, task.id, 'running', { error: null })
          next = transition(db, task.id, 'delivered')
          // P0-3：交付即释放写根（同目录才能新派）；追问投递成功时由 dispatch.send 幂等重建。
          // 验收失败在更早的分支已经 return（状态保持 running），不会走到这里。
          releaseTaskSession(next)
        } else {
          next = touchTask(db, task.id)
        }
      } else if (settled) {
        // 已交付/已完成上的迟到 blocked/progress：不改状态，只留痕（重复回报不该把任务拉回等待态）。
        next = touchTask(db, task.id)
        if (args.status === 'blocked' || args.status === 'needs_auth') {
          log('task.report.inconsistent', {
            taskId: task.id,
            detail: { reported: args.status, status: task.status, callId: exec?.callId },
          })
        }
      } else if (args.status === 'blocked') next = transition(db, task.id, 'waiting_user')
      else if (args.status === 'needs_auth') next = transition(db, task.id, 'waiting_auth')
      else if (WAITING_STATUS.has(task.status)) next = transition(db, task.id, 'running', { error: null })
      else next = touchTask(db, task.id)
      if (args.status === 'blocked' || args.status === 'needs_auth') {
        if (!settled) next = setTaskQuestion(db, task.id, { question, options })
      } else if (args.status === 'progress' || args.status === 'done') {
        next = clearTaskQuestion(db, task.id)
      }
      let progressInfo
      if (args.status === 'progress') {
        progressInfo = recordProgress(db, next.id, {
          // P2-2：stall 口径固定 3 次（配置键 stallRounds 已删），这里只传 stale 窗口。
          staleMinutes: config?.staleMinutes ?? 30,
        })
        if (progressInfo !== undefined) next = progressInfo.task
      }
      if (deliveredNow) {
        try {
          // M1 记忆分层：done 摘要只进日志层 task-log（一行、无产物清单、不进 brief）；
          // 写入即蒸馏——摘要里带经验/教训标记的分句抽成 lesson 原子事实，才允许注入后续 brief。
          // 只在真正交付的这一次沉淀（重复 done 回报不重复写）。
          // worktree 记忆归一（审计 §2.5 缺陷 2）：隔离任务的 target_dir 是检出目录
          // （<repo>/.agents/worktrees/t-xxx），拿它当 project_key 会写出 8 个分裂键、项目键检索不到。
          // 归一顺序：用户给的原始 target（brief.target）→ 源仓库根（repo_root）→ 最后才退回 target_dir。
          const projectKey = projectKeyOf(next.brief?.target ?? next.repo_root ?? next.target_dir)
          const summary = summaryFacing
          addMemory(db, {
            projectKey,
            kind: TASK_LOG_KIND,
            text: taskLogText(next.title, summary),
            sourceTaskId: next.id,
            sourceSessionId: next.session_id,
          })
          for (const fact of distillLessons(summary, { max: 2 })) {
            addMemory(db, {
              projectKey,
              kind: LESSON_KIND,
              text: fact,
              sourceTaskId: next.id,
              sourceSessionId: next.session_id,
            })
          }
        } catch { /* 记忆沉淀失败不能影响回报 */ }
      }
      const displayName = labelFor(next)
      // 交付回报用 delivered 通知（带「确认/追问」动作指令），重复回报不再发第二条。
      const notifyStatus = args.status === 'done' ? 'delivered' : args.status
      if (deliveredNow || args.status !== 'done') {
        notifier.push({
          taskId: next.id,
          title: next.title,
          displayName,
          // 交付通知的 `task_message({action:'close', task_id: …})` 要填引用（不填裸编号）。
          ref: next.ref,
          readOnly: next.read_only === true,
          access: next.access === 'full' ? 'full' : null,
          status: notifyStatus,
          summary: summaryFacing,
          question: args.status === 'blocked' || args.status === 'needs_auth' ? question : null,
          options: args.status === 'blocked' || args.status === 'needs_auth' ? options : [],
          artifacts,
          artifactsTruncated: artifactsOmitted,
          worktree: notifyWorktreeOf(next),
          sender: exec?.agent,
          signal: exec?.signal,
          // 追问后必达：notify 对 progress 用它跳过水位与合并窗口（其余状态照旧走原分级）。
          answeredFollowup,
        })
      }
      if (progressInfo?.shouldNotify === true) {
        notifier.push({
          taskId: next.id,
          title: next.title,
          displayName,
          readOnly: next.read_only === true,
          access: next.access === 'full' ? 'full' : null,
          status: 'stalled',
          summary: `连续 ${progressInfo.count} 次 progress 无状态变化，可能卡住；用 task_status 查看`,
          system: true,
        })
        log('task.stalled', { taskId: next.id, detail: { count: progressInfo.count } })
      }
      log('task.report', {
        taskId: next.id,
        sessionId: task.session_id,
        agentId: exec?.agent?.id,
        // 台账/日志保留原始摘要（审计真源）；用户面用 summaryFacing（已清洗引用）。
        detail: { status: args.status, summary: args.summary ?? '', delivered: deliveredNow, access: next.access ?? null, answeredFollowup, callId: exec?.callId },
      })
      // 交付/终态都让出一个并发位，唤醒队列补位。可写根在交付那一刻就释放（同目录可新派），
      // goal 仍留到 done（确认/超时）再收口；追问投递成功时由 dispatch.send 幂等重建写根。
      if (deliveredNow || next.status === 'failed' || next.status === 'cancelled') queue.pump()
      const hint = invalidHint()
      if (args.status === 'done' && !deliveredNow) {
        return `已记录任务「${labelFor(next)}」的重复 done 回报（当前${labelOf(next.status)}，未重复迁移）。${hint === '' ? '' : `\n${hint}`}`
      }
      const deliveredNote = deliveredNow
        ? `${deliveredReceiptNote}${acceptanceNotice === '' ? '' : `\n${acceptanceNotice}`}`
        : ''
      return `已记录任务「${labelFor(next)}」的 ${args.status} 回报。${deliveredNote}${hint === '' ? '' : `\n${hint}`}`
    }),

    // 计划落盘（P8 计划交付）：计划阶段是只读沙箱，这是子会话**唯一**被允许的写入口。
    // 路径不开放参数：任务引用/编号 → 任务 → 文件名=**任务名**（安全化/去重/长度见 src/plan-doc.js），
    // 目录固定「主会话工作区/reports/plans/」，文件名白名单 + relative() 包含性校验拒绝逃逸。
    // 拍板流程 vA（用户最终拍板）：工具层**不改**——只有 content，原样落盘；待拍板清单由模型自己
    // 生成并经 ask_user_question 逐项提问，插件不解析正文、不校验格式、不存元数据。
    wrap('plan_save', PLAN_SAVE_TOOL_DESC, objectSchema({
      task_id: str('任务编号，创建时给过'),
      content: str('计划正文（Markdown）：目标、步骤、要改的文件、验证方式、风险与待拍板问题'),
    }), async (args, exec) => {
      // 版本 B：与其余 task_* 同一个解析入口（t-xxxx 或 tk-），路径不再由入参拼（防逃逸也从根上去掉了）。
      const found = findTaskInput(args.task_id)
      if (found.ok !== true) return `计划未落盘：${found.message}`
      const task = found.task
      if (!isPlanTask(task)) {
        return `计划未落盘：只有计划模式（planFirst）的任务需要落盘计划；任务「${labelFor(task)}」是普通任务，直接写到自己的工作目录即可。`
      }
      // 越权：只有任务自己的子会话能落盘（与 task_report 同口径）。
      const reporter = exec?.agent
      const reporterId = reporter?.id ?? reporter?.session?.id
      if (reporter !== undefined && task.session_id !== null && task.session_id !== undefined
        && String(reporterId) !== String(task.session_id)) {
        return `计划被拒绝：任务「${labelFor(task)}」属于子会话 ${task.target ?? task.session_id}，当前调用方不是它。`
      }
      const raw = typeof args.content === 'string' ? args.content.trim() : ''
      if (raw === '') return '计划正文不能为空：把目标、步骤、要改的文件、验证方式写进 content。'
      // 出口清洗：正文会原样进 reports/plans/ 下的文档（用户直接打开的文件），写入前把台账已知编号换成 tk-。
      const content = sanitizeFacing(raw)
      if (content.length > MAX_PLAN_CHARS) {
        return `计划正文太长（${content.length} 字，上限 ${MAX_PLAN_CHARS} 字）：请精简（步骤级即可）或拆成更小的计划。`
      }
      const mainDir = defaultDir()
      if (mainDir === undefined) return '计划未落盘：找不到主会话工作区（主会话尚未打开），请让协调者先从面板「打开主会话」。'
      const written = await writePlanDocument({ db, mainDir, task, content, savedAt: Date.now() })
      if (written.ok !== true) return `计划未落盘：${written.error}${written.path === undefined ? '' : `（目标路径 ${written.path}）`}`
      // 登记产物：通知、task_status、面板抽屉都从台账产物里读，不需要另开一套视图。
      setTaskArtifacts(db, task.id, [{ path: written.path, label: `计划文档（${written.chars} 字）`, exists: true }])
      // 记下落盘路径 = 幂等依据（同一任务二次 plan_save 覆写原文件，不再生成 -2）。
      setTaskPlanPath(db, task.id, written.path)
      log('task.plan.saved', {
        taskId: task.id,
        sessionId: task.session_id,
        agentId: reporterId,
        detail: { path: written.path, chars: written.chars, bytes: written.bytes, callId: exec?.callId },
      })
      return planSavedNote(written)
    }),

    // 0.32.0 能力包工厂（协调者专用；worker/包会话由 preset-tools deny 掉）：
    // list/describe/create/update/delete/open/install/uninstall/health/export-static。
    createCapabilityPackTool({ packs: capabilityPacks, wrap, schema: { objectSchema, str } }),

  ]
}
