// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateBrief, renderBriefForTask, validateTargetDir } from './brief.js'
import { inferWorkspaceTarget } from './workspace-match.js'
import { INDEX_TITLE, registeredWorkspaces, loadWorkspaceIndex, saveWorkspaceIndex, workspaceIndexText } from './workspace-index.js'
import { fileURLToPath } from 'node:url'
import { taskLabel, taskLabelWithId } from './task-label.js'
import { canTransition, statusLabel } from './state.js'
import { statusesWith } from './status-facts.js'
import { dependencyState, promoteDependents, upstreamBrief, validateDepends } from './deps.js'
import { renderTaskDetail } from './task-detail.js'
import {
  GLOBAL_PROJECT, LESSON_KIND, MAX_FACT_CHARS, TASK_LOG_KIND, addMemory, buildLessonBlock, buildMemoryBlock,
  distillLessons, distillText, memoryKindLabel, memoryTokens, projectKeyOf, remember, searchMemories, taskLogText,
} from './memory.js'
import {
  addMessage, createTask, getTask, listTasks, recentMessages, setMessageDelivery,
  setTaskArtifacts, setTaskError, setTaskWorktree, touchTask, transition, incrementAttempts,
  setTaskQuestion, clearTaskQuestion, recordProgress, mergeArtifacts, MAX_TASK_ARTIFACTS,
} from './ledger.js'
import { collectWorkspaceArtifacts } from './artifact-collect.js'
import { formatBytes, PREVIEW_CHARS, readLastMessage } from './last-message.js'
import { DEFAULT_LINES, MAX_LINES, readWorkspaceFile, renderWorkspaceRead } from './read-workspace.js'
import { registeredArtifacts } from './artifact-location.js'
import { preferenceSavedHint, projectPreferenceSavedHint, upsertPreference } from './preferences.js'
import { artifactLines } from './notify.js'
import { CLOSE_REASONS, DELIVERED_TIMEOUT_MINUTES, closeDelivered, closeReasonLabel } from './delivered.js'
import { toolFailure } from './action-errors.js'
import { objectiveForMessage } from './goal.js'
import { followupGate, stopIsIdempotent } from './panel-gates.js'
import { approvePlan, approvalNote, isPlanTask, planListMarker, planStateOf, planStatusLine } from './plan-mode.js'
import { MAX_PLAN_CHARS, isSafePlanTaskId, planSavedNote, writePlanDocument } from './plan-doc.js'
import {
  branchChoiceText, branchNameFor, decideWorktreeFacts, decideWorktreeIntent, findReusableCheckout,
  notifyWorktreeOf, parseWorktreeRequest, worktreeListMarker, worktreeNoteLines, worktreeStatusLine,
} from './worktree-request.js'
import { checkoutPathFor, createWorktreeService, retryWorktreeOf } from './worktree.js'
import { ISOLATED_WORKTREE_STATES, decideWriteGuard } from './write-guard.js'

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
const str = description => ({ type: 'string', description })
const strList = description => ({ type: 'array', items: { type: 'string' }, description })
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value === undefined ? '' : String(value) }],
}

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

// 子会话最新返回消息（B1）：默认给摘要/预览，include=full 才读全文（长消息从 reports 文件读）。
function lastMessageLines(record, { full = false } = {}) {
  const where = record.stored === 'file' ? '全文存 reports 文件' : '内联存台账'
  const head = `最近返回（结算 ${record.stopReason ?? '未知'}｜${record.chars ?? '?'} 字｜${formatBytes(record.bytes)}｜${where}）：`
  if (full === true) {
    const text = readLastMessage(record)
    return [head, text === '' ? '- 空' : text]
  }
  if (record.stored === 'file') {
    return [head, `全文：${record.path ?? '(路径缺失)'}`, `摘要：${record.summary || '-'}`, '看全文：task_status 带 include=full']
  }
  const text = readLastMessage(record)
  if (text.length <= PREVIEW_CHARS) return [head, text]
  return [head, `${text.slice(0, PREVIEW_CHARS)}…`, `（已截断，共 ${record.chars ?? text.length} 字；全文用 include=full）`]
}

function taskLine(db, task, { staleMinutes = 30 } = {}) {
  const planMarker = `${worktreeListMarker(task)}${planListMarker(task)}`
  // 权限标记：只读优先（互斥保证两者不会同时出现），完整访问在状态词后缀「·完整访问」。
  const stateLabel = task.read_only
    ? `${labelOf(task.status)}·只读`
    : `${labelOf(task.status)}${task.access === 'full' ? '·完整访问' : ''}`
  const parts = [
    `- ${taskLabelWithId(task)}`,
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

export function createTools({ db, dispatcher, queue, notifier, config, coordinatorStatus, logger, workspaces, defaultCwd, sessionQuery, sessions, workspaceChanges, goalBridge, stateDir, worktree, cleanupWorktree }) {
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
    : `写域与活跃任务冲突：${conflicts.map(({ task, scope }) => `${taskLabelWithId(task)}（${scope}）`).join('、')}；建议拆分或串行。`


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
  const resolveProjectHint = hint => {
    const text = typeof hint === 'string' ? hint.trim() : ''
    if (text === '') return { key: GLOBAL_PROJECT, path: undefined, title: undefined }
    if (isAbsolute(text)) {
      let exists = false
      try { exists = statSync(text).isDirectory() } catch { exists = false }
      const path = resolve(text)
      return { key: projectKeyOf(path), path: exists ? path : undefined, title: exists ? (workspaceForPath(path)?.title ?? basename(path)) : basename(path), exists }
    }
    const match = inferWorkspaceTarget({ title: text, goal: text }, workspaceList())
    if (match.ok !== false && match.workspace !== undefined) {
      return {
        key: projectKeyOf(match.workspace.path),
        path: match.workspace.path,
        title: match.workspace.title,
        exists: true,
      }
    }
    return { key: GLOBAL_PROJECT, path: undefined, title: text }
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
  const projectContextFor = (dir, query = '') => {
    const projectKey = projectKeyOf(dir)
    const title = workspaceForPath(dir)?.title ?? basename(dir)
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

    const recent = listTasks(db, { active: false })
      .filter(task => projectKeyOf(task.target_dir) === projectKey)
      .slice(0, 5)
    if (recent.length > 0) {
      lines.push(`【最近任务】\n${recent.map(task => `- ${taskLabelWithId(task)}｜${labelOf(task.status)}｜${short(task.goal, 60)}`).join('\n')}`)
    }
    const memoryBlock = buildMemoryBlock(db, { projectKey, query, limit: 3 })
    if (memoryBlock !== '') lines.push(memoryBlock)
    let text = lines.join('\n')
    if (text.length > 6000) text = `${text.slice(0, 5999)}…`
    return text
  }

  // targetDir 用于续派前幂等补注册 target 可写根（resume 后 session 对象会换，旧授权不生效）。
  // readOnly 用于只读任务续派时幂等补设沙箱（只读任务不注册可写根）；access='full' 同理补设 danger-full-access。
  const sendFollowup = async (target, message, signal, targetDir, taskId, readOnly, objective, access) => {
    if (typeof dispatcher.sendReliable === 'function') return dispatcher.sendReliable(target, message, signal, targetDir, taskId, readOnly, objective, access)
    return dispatcher.send(target, message, signal, targetDir, taskId, readOnly, objective, access)
  }
  // 任务进入终态才释放可写根；waiting_user/waiting_auth/delivered 保留（续派/追问还要用）。
  // 参数可以是任务行，也可以直接是子会话 id（closeDelivered 回调给的是 id）。
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

  return [
    wrap('task_create', '创建一个子任务：建台账、检查活跃上限、渲染 brief 派生一个子会话。description 由你写清目标与验收。', objectSchema({
      title: str('一句话任务名，卡片上显示'),
      goal: str('要达成的目标，一两句话'),
      constraints: strList('约束，可空'),
      acceptance: strList('验收标准，至少一条'),
      refs: strList('背景资料，如文件路径，可空'),
      user_verbatim: str('用户原话，可空'),
      target: str('目标目录：可空；给了必须是已存在的绝对路径，子会话在该目录运行'),
      readOnly: { type: 'boolean', description: '只读任务：子会话沙箱 read-only（读正常，写文件/写 shell 被拒）；默认 false，只在明确需要时传 true' },
      planFirst: { type: 'boolean', description: '计划模式：子会话先只读探索并上报计划，批准后再执行；与 readOnly 互斥；默认 false' },
      access: {
        type: 'string',
        enum: ['full'],
        description: 'per-task 访问级别：只接受 "full"（子会话沙箱 danger-full-access：构建/发版类任务要写仓库外或跑不受沙箱限制的 bash 时用）；不传=沿用当前会话策略、完全不动沙箱（默认）；与 readOnly/planFirst 互斥',
      },
      dependsOn: strList('前置任务编号数组；依赖全部完成后才派发；任一前置失败则本任务失败'),
      group: str('可选分组名，如“登录改造”；面板按组汇总进度'),
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
      log('task.create.requested', { agentId, detail: { title: args.title, goal: args.goal, readOnly, planFirst, access: fullAccess ? 'full' : null, callId } })
      const errors = validateBrief(args)
      if (errors.length > 0) {
        log('task.create.rejected', { agentId, detail: { reason: 'validation', message: errors.join('；'), callId } })
        return `任务描述不完整：${errors.join('；')}。补齐后再派。`
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
      const current = status()
      // 去重、队列容量、创建必须在同一个同步段里，中间不能再 await，否则并发调用会一起通过检查。
      const title = String(args.title).trim()
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
        return `已存在任务「${taskLabelWithId(duplicate)}」（${labelOf(duplicate.status)}），未重复创建。`
      }
      const maxQueue = config?.maxQueue ?? 50
      const queuedCount = queue?.pendingCount?.() ?? 0
      if (queuedCount >= maxQueue) {
        log('task.create.rejected', {
          agentId,
          detail: { reason: 'queue-full', maxQueue, pending: queuedCount, callId },
        })
        return `待派发队列已满（${maxQueue} 个），先 task_stop 或等队列消化后再派。`
      }
      // P9：worktree 结构化请求（零自然语言解析）。步骤里只碰结构化字段 + 插件给的仓库事实：
      // 「要不要建」由协调者已经判断过；这里只做互斥校验、复用查找、降级、多分支询问与落库。
      const parsedWorktree = parseWorktreeRequest(args)
      if (parsedWorktree.ok === false) {
        log('task.create.rejected', { agentId, detail: { reason: 'worktree-args', message: parsedWorktree.error, callId } })
        return `${parsedWorktree.error}。`
      }
      const wtRequest = parsedWorktree.request
      const wtIntent = decideWorktreeIntent({
        request: wtRequest,
        policy: config?.worktreePolicy ?? 'auto',
        readOnly,
        planFirst,
        existingCheckout: wtRequest.mode === 'continue'
          ? findReusableCheckout({ tasks: listTasks(db), groupId, dependsOn: depends.ids })
          : undefined,
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
      // JSON.stringify 会丢掉 undefined，无 target 时 brief 与旧版一致；只读/计划/完整访问/经验才写入标记。
      const brief = {
        ...args,
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
        access: fullAccess ? 'full' : null,
        worktree: worktreeRecord,
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
        },
      })
      const rendered = renderBriefForTask(task)
      addMessage(db, task.id, { kind: 'brief', rendered })
      // 并发风险提示：require 档被 allowConcurrent 放行、warn 档照常创建时由 guard 给；
      // off 档退回旧的 advisory 一行（保持历史行为，不静默消失）。
      const conflictNote = guard.note !== ''
        ? guard.note
        : (guard.mode === 'off' ? conflictsText(writeScopeConflicts(writeScopes)) : '')
      const depNames = depends.ids.map(id => {
        const dep = getTask(db, id)
        return dep === undefined ? id : `「${dep.title}」（${labelOf(dep.status)}）`
      }).join('、')
      const dependencyNote = depends.ids.length === 0 ? '' : `前置任务：${depNames}`
      // 完整访问在返回里明说：用户/协调者要能一眼看出这次子会话不在沙箱里跑。
      const accessNote = fullAccess
        ? '访问级别：完整（danger-full-access）——该子会话的文件沙箱不限制写入、bash/pwsh 也不再被沙箱拦；'
          + '只对本任务生效，其他任务与默认策略都没动（构建/发版类任务用完照常走终态/清理）。'
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
        const notes = [dependencyNote, accessNote, conflictNote, ...pendingWorktree].filter(Boolean).join('\n')
        log('task.dep.waiting', { taskId: task.id, detail: { dependsOn: depends.ids, callId } })
        return `任务「${taskLabelWithId(task)}」已创建，等待前置任务完成。${notes === '' ? '' : `\n${notes}`}`
      }
      const outcome = await queue.enqueueAndPump(task.id)
      const resultTask = outcome.task
      const inferredNote = inferred === undefined ? '' : `（目标目录按工作区推断：${inferred.path}）`
      const planNote = planFirst
        ? `计划模式：子会话只读探索，探索完先 plan_save 把计划写入主会话工作区 reports/plans/${task.id}.md（自动登记为产物），`
          + '再用 task_report blocked 只上报 3–8 行摘要 + 计划文档绝对路径 + 待拍板问题清单；你转交用户，批准后用 task_message 续派（插件自动切回可写）。'
        : ''
      // 派发后以台账实际状态为准（created / reused / degraded / failed），不要凭创建期的计划糊弄用户。
      const worktreeLines = worktreeNoteLines({
        state: resultTask?.worktree_state ?? worktreeRecord?.state ?? 'none',
        branch: resultTask?.worktree_branch ?? worktreeRecord?.branch,
        path: resultTask?.worktree_path ?? worktreeRecord?.path,
        base: resultTask?.worktree_base ?? worktreeRecord?.base,
        error: resultTask?.status === 'failed' ? resultTask.error : undefined,
        hint: worktreeHint,
      })
      const notes = [invalidHint(), inferredNote, planNote, accessNote, ...worktreeLines, conflictNote, dependencyNote]
        .filter(Boolean).join('\n')
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? toolFailure('RETRY_FAILED', {}))
      if (resultTask?.status === 'running') {
        return `任务「${taskLabelWithId(task)}」已派发，子会话 ${resultTask.target}。${notes === '' ? '' : `\n${notes}`}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务「${taskLabelWithId(task)}」已创建，前面还有 ${ahead} 个任务在排队，轮到时自动派发。${notes === '' ? '' : `\n${notes}`}`
    }),

    wrap('task_list', '列出任务。默认只列活跃任务（waiting_dep/pending/running/waiting/待确认），active=false 时连同历史一起列出；可按 group 过滤并看组进度。', objectSchema({
      active: { type: 'boolean', description: '是否只看活跃任务，默认 true' },
      group: str('可选：只看这个分组的任务'),
    }), async (args, exec) => {
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
      include: str('可选：填 full 时返回子会话最新返回消息的全文（长消息从 reports 文件读）'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id, hint: '用 task_list 查编号。' })
      const messages = recentMessages(db, task.id, 3)
      const recent = messages.map(row => `- [${row.kind}] ${short(row.rendered, 80)}`).join('\n')
      const planLine = planStatusLine(task)
      const worktreeLine = worktreeStatusLine(task)
      const lines = [
        `任务「${taskLabelWithId(task)}」`,
        `状态：${labelOf(task.status)}`,
        ...(task.read_only ? ['权限：只读（读正常，写文件/写 shell 被拒绝）'] : []),
        ...(task.access === 'full' ? ['访问级别：完整（danger-full-access：文件沙箱不限制写入，bash/pwsh 也不再被沙箱拦）'] : []),
        ...(planLine === undefined ? [] : [planLine]),
        ...(worktreeLine === undefined ? [] : [worktreeLine]),
        ...(task.group_id ? [`分组：${task.group_id}`] : []),
        ...(task.priority !== 0 ? [`优先级：${task.priority}`] : []),
        `子会话：${task.target ?? '-'}`,
        ...(task.status === 'waiting_dep'
          ? [`等待前置：${task.depends_on.map(id => {
            const dep = getTask(db, id)
            return dep === undefined ? id : `${id}（${labelOf(dep.status)}）`
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
        lines.push(`交付：已交付待确认（默认等你或用户确认：要改 task_message 追问原会话；确认完成才 task_close；超过 ${timeout} 分钟自动完成）`)
      }
      if (task.close_reason !== null && task.close_reason !== undefined) {
        lines.push(`关闭：${closeReasonLabel(task.close_reason)}`)
      }
      // 平台 goal 只读状态（G1）：让协调者不用打开面板也能确认目标生命周期。
      if (task.goal_state !== null && task.goal_state !== undefined) {
        const phase = { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成', cleared: '已清除' }[task.goal_state.phase] ?? task.goal_state.phase ?? '未知'
        const activation = task.goal_state.activation === 'armed' ? '自动续轮已启用（异常）' : '不自动续轮'
        lines.push(`目标状态：${phase}｜${activation}${task.goal_state.revision === undefined ? '' : `｜修订 ${task.goal_state.revision}`}`)
      }
      // K2：keep-alive 续跑计数（只在真的续过时显示；预算按每段 activation 归零）。
      if ((task.keep_alive_rounds ?? 0) > 0) {
        const limit = config?.keepAliveMaxRounds
        lines.push(`续跑：keep-alive 已注入 ${task.keep_alive_rounds}${Number.isFinite(limit) ? `/${limit}` : ''} 轮${config?.keepAlive === true && task.status === 'running' ? '（仍在续跑）' : ''}`)
      }
      if (task.depends_on.length > 0 && task.status !== 'waiting_dep') {
        lines.push(`前置任务：${task.depends_on.map(id => {
          const dep = getTask(db, id)
          return dep === undefined ? id : `「${dep.title}」（${labelOf(dep.status)}）`
        }).join('、')}`)
      }
      if (task.write_scopes.length > 0) lines.push(`写域：${task.write_scopes.join('、')}`)
      if (task.question) {
        lines.push(`问题：${task.question}`)
        if (task.options.length > 0) lines.push(`选项：${task.options.join(' / ')}`)
      }
      if (task.retry_of) lines.push(`重派自：${task.retry_of}`)
      if (task.error !== null && task.error !== undefined) lines.push(`原因：${task.error}`)
      // P6/T6.2：产物区块（错过通知时的兜底回流路径）。与通知同一口径（artifactLines 共用）：
      // 只列 present 能接住的普通文件，目录 / 符号链接 / 已不存在只计数不进清单；带交付指令。
      lines.push(...artifactLines({ artifacts: task.artifacts }, { counts: true }))
      // B1：结算时落的最完整返回消息 → 主会话不必打开子会话就能读到它最后说了什么。
      if (task.last_message !== null && task.last_message !== undefined) {
        lines.push(...lastMessageLines(task.last_message, { full: args.include === 'full' }))
      }
      if (config?.backend !== 'team' && task.session_id !== null && task.session_id !== undefined) {
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
      const taskId = String(args.task_id ?? '').trim()
      if (taskId === '') return '缺少 task_id：brief 的【任务编号】就是它（如 t-1a2b3c4d）。'
      const task = getTask(db, taskId)
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId, hint: '确认 brief 的【任务编号】是否抄错。' })
      const agent = exec?.agent
      const caller = agent?.id ?? agent?.session?.id
      const callerId = caller === null || caller === undefined ? undefined : String(caller)
      const ownerId = task.session_id === null || task.session_id === undefined ? undefined : String(task.session_id)
      // 越权拒绝：主会话要详情用 task_status；别的子会话读不到不是自己的任务。
      if (ownerId === undefined || callerId === undefined || callerId !== ownerId) {
        log('task.detail.rejected', { taskId, agentId: agent?.id, detail: { caller: callerId ?? null, owner: ownerId ?? null } })
        return `读取被拒绝：task_detail 只对任务自己的子会话开放（任务「${taskLabelWithId(task)}」属于子会话 ${task.target ?? ownerId ?? '（尚未派发）'}，当前调用方 ${callerId ?? '（未知）'}）。主会话查任务用 task_status。`
      }
      return renderTaskDetail(task, {
        // 前置任务/摘要按当前台账现读：依赖可能在创建之后才完成。
        dependencies: upstreamBrief(db, task.depends_on),
        experience: task.brief?.experience,
        artifacts: task.artifacts,
      })
    }),

    wrap('task_message', '给已有子任务追加一条消息（续派），不新建任务。进行中/等你确认/要授权/待确认都能续派（「待确认」= 已交付待确认，追问复用原会话）。投递失败会重试 3 次，仍失败则任务转「等你确认」或保留「待确认」。', objectSchema({
      task_id: str('任务编号'),
      message: str('要追加的内容'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id })
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
      const message = args.message ?? ''
      // 与面板 message 同口径：先 pending，投递成功 delivered，失败 failed（详情抽屉显示三态）。
      const seq = addMessage(db, task.id, { kind: 'followup', rendered: message, meta: { delivery: 'pending' } })
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
        ? '\n该任务此前是「已交付待确认」，已回到进行中并在同一子会话继续；完成后会再次落「已交付待确认」，等你/用户确认或超时自动完成。'
        : ''
      return `已把消息追加给任务「${labelFor(task)}」（子会话 ${task.target}）。${planNote}${deliveredNote}${readOnlyNote}`
    }),

    wrap('task_stop', '停止一个子任务（会中断它的当前一轮）。', objectSchema({ task_id: str('任务编号') }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id })
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
    }),

    wrap('task_retry', '重派一个失败或会话丢失的任务：用原 brief 新建一次尝试（新任务编号），旧任务保留审计；只有 failed/orphaned 能重派。', objectSchema({
      task_id: str('要重派的任务编号'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id, hint: '用 task_list 查编号。' })
      if (!RETRYABLE_STATUS.has(task.status)) {
        return toolFailure('RETRY_NOT_ALLOWED', { label: labelFor(task), statusLabel: labelOf(task.status) })
      }
      const duplicate = listTasks(db, { active: true })
        .find(item => item.title.trim() === task.title.trim() && item.goal.trim() === task.goal.trim())
      if (duplicate !== undefined) {
        return toolFailure('RETRY_DUPLICATE_ACTIVE', {
          label: taskLabelWithId(duplicate),
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
        worktree: retryWorktree,
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
      addMessage(db, retried.id, { kind: 'brief', rendered: renderBriefForTask(retried) })
      if (current.live === false) {
        const message = invalidHint() === '' ? toolFailure('MAIN_SESSION_UNAVAILABLE') : invalidHint()
        log('task.spawn.failed', { taskId: retried.id, agentId: exec?.agent?.id, detail: { error: message, retryOf: task.id } })
        transition(db, retried.id, 'failed', { error: message })
        throw new Error(message)
      }
      if (retried.status === 'waiting_dep') {
        return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，等待前置任务完成后派发。`
      }
      const outcome = await queue.enqueueAndPump(retried.id)
      const resultTask = outcome.task
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? toolFailure('RETRY_FAILED', {}))
      const hint = invalidHint()
      const notes = hint === '' ? '' : `\n${hint}`
      if (resultTask?.status === 'running') {
        return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，子会话 ${resultTask.target}。${notes}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，前面还有 ${ahead} 个任务在排队。${notes}`
    }),

    // 受控读（协调者读产物）：平台的文件工具没有读路径白名单（沙箱只管写、cwd 不是边界、
    // glob 直接 ripgrep 全树枚举），所以不开放原生 read/glob，而是自建一条边界由插件算的入口。
    // 边界 = **主会话工作区包含性 OR 已登记产物**（审计 §2.1 方案 C）：子会话按契约把产物写在
    // target 目录内，而 target 通常不在工作区里；把台账 artifacts 当第二判据，读取面仍然只有
    // 「工作区 + 已登记集合」，不必为看一眼产物新派任务，也不把整个 target 仓库暴露出来。
    wrap('read_workspace', '读产物正文：主会话工作区内的文件/目录，或任务回报过 artifacts 的已登记产物（子会话产物通常写在 target 目录内，不在工作区里）。越界、未登记、符号链接逃逸、路径穿越一律拒绝；大文件按行窗口截断并给续读 offset。', objectSchema({
      path: str('主会话工作区内的相对路径（如 reports/t-1a2b3c4d.md、diag/）、工作区内的绝对路径，或已登记产物的绝对路径'),
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

    wrap('history_search', '查跨项目历史：本插件记忆、历史任务、平台历史会话。新任务开始前用它补上下文；结果只作参考，不作状态断言。', objectSchema({
      query: str('关键词（任务名/目标/决策/文件名）'),
      project: str('可选：项目绝对路径或工作区名；不传则查全局+当前项目'),
      limit: { type: 'number', description: '最多几条，默认 5，最大 10' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const query = String(args.query ?? '').trim()
      if (query === '') return '给一个关键词再查历史（任务名、目标、决策或文件名）。'
      const limit = Number.isFinite(args.limit) ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5
      const hint = resolveProjectHint(args.project)
      const tokens = memoryTokens(query)
      const memories = searchMemories(db, { projectKey: hint.key, query, limit })
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
            if (hint.path !== undefined && typeof cwd === 'string' && projectKeyOf(cwd) !== hint.key) continue
            sessions.push({ id, snippet: short(hit?.bestMatch?.snippet ?? hit?.snippet ?? '', 160) })
            if (sessions.length >= 3) break
          }
        } catch { /* sessionQuery 不可用就只查插件自己的数据 */ }
      }
      const blocks = []
      if (memories.length > 0) {
        // 标出层：task-log 是日志层（只归档、不注入 brief），lesson/decision/preference 是事实层。
        blocks.push(`【记忆】\n${memories.map(row => `- [${memoryKindLabel(row.kind)}] ${row.text}`).join('\n')}`)
      }
      if (tasks.length > 0) {
        blocks.push(`【历史任务】\n${tasks.map(({ task }) => `- ${taskLabelWithId(task)}｜${labelOf(task.status)}｜${short(task.goal, 80)}${task.artifacts?.length > 0 ? `｜产物 ${task.artifacts.length}` : ''}`).join('\n')}`)
      }
      if (sessions.length > 0) {
        blocks.push(`【历史会话】\n${sessions.map(item => `- ${item.id}${item.snippet === '' ? '' : `：${item.snippet}`}`).join('\n')}`)
      }
      return blocks.length > 0 ? blocks.join('\n') : '没有找到相关历史。'
    }),

    wrap('project_context', '读项目背景（README/AGENTS/package 等白名单文件、顶层结构、最近任务、相关记忆）；只读，不开放任意文件读取。', objectSchema({
      target: str('项目绝对目录；不传则按 query 推断或使用主会话目录'),
      query: str('可选关键词，用于推断项目和匹配记忆'),
      workspaces: { type: 'boolean', description: 'true 返回已登记工作区与持久化仓库采样索引，不扫描全盘' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (args.workspaces === true) {
        return `【已登记工作区】\n${workspaceList().map(item => JSON.stringify({ id: item.id, title: item.title, path: item.path })).join('\n')}\n${workspaceIndexText(loadWorkspaceIndex(db)) || '尚无仓库索引，派只读工作区与仓库索引任务。'}`
      }
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
      return projectContextFor(dir, String(args.query ?? ''))
    }),

    // 记忆写入的**单一路由**（审计 §5.3 待定项 2 的「不双写」）：
    //   全局偏好 → 只写 settings.orchestrator_preferences（每回合注入 L1 协调者 policy）；
    //   项目偏好 / 其它 kind → 只写 memories（随 task_detail 注入子会话 / 供 history_search 检索）。
    // 一条事实只落一处，不存在「两份真相」。
    wrap('memory_note', '记住一条跨任务有效的决策/经验，或一条偏好。偏好（kind:preference）不传 project 时写进协调者偏好（每回合注入提示词，立即生效）；其余写进 memories 事实层（供 history_search 与 task_detail 注入）。只收原子事实，长日志/verbatim 会被蒸馏丢弃。', objectSchema({
      text: str('要记住的内容，一两句话'),
      project: str('可选：项目绝对路径或工作区名；不传记为全局'),
      kind: { type: 'string', enum: ['note', 'decision', 'preference', 'lesson'], description: '类型，默认 note' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
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
    }),

    wrap('task_inbox', '收件箱：集中看待你决定、失败/丢失、长时间没动静的任务；默认只读，不写台账。', objectSchema({
      limit: { type: 'number', description: '每类最多几条，默认 10，最大 20' },
    }), async (args, exec) => {
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
        return `- ${taskLabelWithId(task)}｜${labelOf(task.status)}${question}${options}`
      }
      if (waiting.length > 0) blocks.push(`【待你决定】${waiting.length}\n${waiting.map(lineOf).join('\n')}`)
      if (confirm.length > 0) {
        blocks.push(`【待确认】${confirm.length}（已交付待确认：默认保持、等你或用户拍板；要改 task_message 追问原会话，用户确认后才 task_close，超时自动完成）\n${confirm.map(lineOf).join('\n')}`)
      }
      if (failed.length > 0) blocks.push(`【失败/丢失】${failed.length}\n${failed.map(lineOf).join('\n')}`)
      if (stale.length > 0) blocks.push(`【长时间没动静】${stale.length}\n${stale.map(lineOf).join('\n')}`)
      return blocks.join('\n')
    }),

    wrap('task_report', '子任务每轮结束必须调用：progress（有进展未完成）、done（完成）、blocked（卡住等人决定）、needs_auth（需要授权）。协调者据此决定是否打扰用户。', objectSchema({
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
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}，确认 task_id 是否抄错。`
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
      const question = typeof args.question === 'string' ? args.question.trim().slice(0, 500) : ''
      const options = Array.isArray(args.options)
        ? args.options.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim().slice(0, 120)).slice(0, 10)
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
      addMessage(db, task.id, { kind: 'report', rendered: `[${args.status}] ${args.summary ?? ''}` })
      let next = task
      // 两段式终态：子会话报 done 先落 delivered（已交付待确认），协调者 task_close / 超时才收成 done。
      // 已经在 delivered/done 上的回报是重复/迟到事件：只记消息，不迁移、不重复通知。
      const settled = task.status === 'delivered' || task.status === 'done'
      const deliveredNow = args.status === 'done' && !settled
      if (args.status === 'done') {
        if (deliveredNow) {
          // blocked/needs_auth 之后子任务直接交付：先回到 running，再走合法迁移到 delivered。
          if (WAITING_STATUS.has(task.status)) next = transition(db, task.id, 'running', { error: null })
          next = transition(db, task.id, 'delivered')
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
          stallRounds: config?.stallRounds ?? 3,
          staleMinutes: config?.staleMinutes ?? 30,
        })
        if (progressInfo !== undefined) next = progressInfo.task
      }
      if (deliveredNow) {
        try {
          // M1 记忆分层：done 摘要只进日志层 task-log（一行、无产物清单、不进 brief）；
          // 写入即蒸馏——摘要里带经验/教训标记的分句抽成 lesson 原子事实，才允许注入后续 brief。
          // 只在真正交付的这一次沉淀（重复 done 回报不重复写）。
          const projectKey = projectKeyOf(next.target_dir)
          const summary = String(args.summary ?? '')
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
          readOnly: next.read_only === true,
          access: next.access === 'full' ? 'full' : null,
          status: notifyStatus,
          summary: args.summary ?? '',
          question: args.status === 'blocked' || args.status === 'needs_auth' ? question : null,
          options: args.status === 'blocked' || args.status === 'needs_auth' ? options : [],
          artifacts,
          artifactsTruncated: artifactsOmitted,
          worktree: notifyWorktreeOf(next),
          sender: exec?.agent,
          signal: exec?.signal,
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
        detail: { status: args.status, summary: args.summary ?? '', delivered: deliveredNow, access: next.access ?? null, callId: exec?.callId },
      })
      // 交付/终态都让出一个并发位，唤醒队列补位。可写根与 goal 要留到 done（确认/超时）再收：
      // delivered 还要复用同一个子会话追问。
      if (deliveredNow || next.status === 'failed' || next.status === 'cancelled') queue.pump()
      const hint = invalidHint()
      if (args.status === 'done' && !deliveredNow) {
        return `已记录任务「${labelFor(next)}」的重复 done 回报（当前${labelOf(next.status)}，未重复迁移）。${hint === '' ? '' : `\n${hint}`}`
      }
      const deliveredNote = deliveredNow
        ? `\n已交付待确认：这是交付、不是终态；协调者可能用 task_message 追问（同一会话继续），确认或超时后才收成完成。`
        : ''
      return `已记录任务「${labelFor(next)}」的 ${args.status} 回报。${deliveredNote}${hint === '' ? '' : `\n${hint}`}`
    }),

    // 计划落盘（P8 计划交付）：计划阶段是只读沙箱，这是子会话**唯一**被允许的写入口。
    // 路径不开放参数：只认任务编号，由插件拼成「主会话工作区/reports/plans/<taskId>.md」，
    // 编号形状白名单 + relative() 包含性校验两道闸拒绝逃逸（见 src/plan-doc.js）。
    wrap('plan_save', '计划模式专用：把计划正文写入主会话工作区 reports/plans/<taskId>.md 并登记为任务产物（计划阶段唯一允许的写入口，路径固定、禁止逃逸）。', objectSchema({
      task_id: str('任务编号，创建时给过'),
      content: str('计划正文（Markdown）：目标、步骤、要改的文件、验证方式、风险与待拍板问题'),
    }), async (args, exec) => {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
      // 先校验编号形状：路径由编号拼出，形状不合法连查台账都不必，直接拒绝。
      if (!isSafePlanTaskId(taskId)) {
        return `计划未落盘：任务编号不合法（只允许 t-<小写字母/数字> 形式）：${taskId === '' ? '(空)' : taskId}。`
      }
      const task = getTask(db, taskId)
      if (task === undefined) return `没有任务 ${taskId}，确认 task_id 是否抄错。`
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
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content === '') return '计划正文不能为空：把目标、步骤、要改的文件、验证方式写进 content。'
      if (content.length > MAX_PLAN_CHARS) {
        return `计划正文太长（${content.length} 字，上限 ${MAX_PLAN_CHARS} 字）：请精简（步骤级即可）或拆成更小的计划。`
      }
      const mainDir = defaultDir()
      if (mainDir === undefined) return '计划未落盘：找不到主会话工作区（主会话尚未打开），请让协调者先从面板「打开主会话」。'
      const written = await writePlanDocument({ mainDir, task, content, savedAt: Date.now() })
      if (written.ok !== true) return `计划未落盘：${written.error}${written.path === undefined ? '' : `（目标路径 ${written.path}）`}`
      // 登记产物：通知、task_status、面板抽屉都从台账产物里读，不需要另开一套视图。
      setTaskArtifacts(db, task.id, [{ path: written.path, label: `计划文档（${written.chars} 字）`, exists: true }])
      log('task.plan.saved', {
        taskId: task.id,
        sessionId: task.session_id,
        agentId: reporterId,
        detail: { path: written.path, chars: written.chars, bytes: written.bytes, callId: exec?.callId },
      })
      return planSavedNote(written)
    }),

    // 两段式终态的确认入口：只有 delivered（已交付待确认）能收成 done。
    wrap('task_close', '确认一条「已交付待确认」（delivered）任务为已完成（done，终态）。要改就用 task_message 追问原会话；要取消用 task_stop。', objectSchema({
      task_id: str('任务编号'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id })
      const outcome = closeDelivered({
        db,
        taskId: task.id,
        reason: CLOSE_REASONS.coordinator,
        releaseSession: releaseTaskSession,
        // G1：确认完成 = 目标达成，complete 并 disarm（桥内部幂等）。
        completeGoal: closed => { void goalBridge?.complete?.(closed.id, closed.session_id) },
        cleanupWorktree,
        pump: () => queue.pump(),
        logger,
      })
      if (outcome.ok !== true) {
        const latest = outcome.task ?? task
        if (outcome.reason === 'not-found') return toolFailure('TASK_NOT_FOUND', { taskId: args.task_id })
        if (TERMINAL_STATUS.has(latest.status)) {
          return toolFailure('CLOSE_TASK_ENDED', { label: labelFor(latest), statusLabel: labelOf(latest.status) })
        }
        return toolFailure('CLOSE_NOT_DELIVERED', { label: labelFor(latest), statusLabel: labelOf(latest.status) })
      }
      log('task.close', { taskId: task.id, detail: { already: outcome.already === true } })
      return outcome.already === true
        ? `任务「${labelFor(outcome.task)}」已完成（无需重复确认）。`
        : `任务「${labelFor(outcome.task)}」已确认完成。`
    }),
  ]
}
