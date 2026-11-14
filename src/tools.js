// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { validateBrief, renderBrief, validateTargetDir } from './brief.js'
import { inferWorkspaceTarget } from './workspace-match.js'
import { taskLabel, taskLabelWithId } from './task-label.js'
import { canTransition } from './state.js'
import { dependencyState, promoteDependents, validateDepends } from './deps.js'
import {
  GLOBAL_PROJECT, addMemory, buildMemoryBlock, memoryTokens, projectKeyOf, remember, searchMemories,
} from './memory.js'
import {
  addMessage, createTask, getTask, listTasks, recentMessages,
  setTaskArtifacts, setTaskError, touchTask, transition, incrementAttempts,
} from './ledger.js'

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
const STATUS_LABEL = {
  waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}
const ACTIVE_STATUS = new Set(['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth'])
const WAITING_STATUS = new Set(['waiting_user', 'waiting_auth'])
const RESUME_STATUS = new Set(['waiting_user', 'waiting_auth', 'failed'])
const TERMINAL_STATUS = new Set(['done', 'cancelled', 'orphaned'])
const RETRYABLE_STATUS = new Set(['failed', 'orphaned'])

const labelOf = status => STATUS_LABEL[status] ?? status
const short = (value, max = 40) => {
  const text = String(value ?? '').split('\n')[0].trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function taskLine(db, task, { staleMinutes = 30 } = {}) {
  const parts = [
    `- ${taskLabelWithId(task)}`, task.read_only ? `${labelOf(task.status)}·只读` : labelOf(task.status), `子会话 ${task.target ?? '-'}`,
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

export function createTools({ db, dispatcher, queue, notifier, config, coordinatorStatus, logger, workspaces, defaultCwd, sessionQuery }) {
  const staleMinutes = config?.staleMinutes ?? 30
  const coordinatorSession = config?.coordinatorSession ?? 'unknown'
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志绝不能打断主流程 */ }
  }
  // 对外显示名：重名短后缀要全量任务，统一用台账现查；通知的 displayName 也在这里算好。
  const labelFor = task => taskLabel(task, { all: listTasks(db) })
  const status = typeof coordinatorStatus === 'function'
    ? coordinatorStatus
    : () => ({ id: config?.coordinatorSession, live: true })
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
  const normalizeArtifacts = (task, input) => {
    if (!Array.isArray(input)) return { artifacts: [], omitted: 0 }
    // 入口先截断，避免为几百条无关键做 resolve/stat。
    const entries = input.slice(0, MAX_ARTIFACTS)
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
  // readOnly 用于只读任务续派时幂等补设沙箱（只读任务不注册可写根）。
  const sendFollowup = async (target, message, signal, targetDir, taskId, readOnly) => {
    if (typeof dispatcher.sendReliable === 'function') return dispatcher.sendReliable(target, message, signal, targetDir, taskId, readOnly)
    return dispatcher.send(target, message, signal, targetDir, taskId, readOnly)
  }
  // 任务进入终态才释放可写根；waiting_user/waiting_auth 保留（续派还要用）。
  const releaseTaskSession = task => {
    const id = task?.session_id ?? task?.target
    if (id === null || id === undefined) return
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
      dependsOn: strList('前置任务编号数组；依赖全部完成后才派发；任一前置失败则本任务失败'),
      group: str('可选分组名，如“登录改造”；面板按组汇总进度'),
      writeScopes: strList('可选写域（目录/文件路径）；与活跃任务重叠时给冲突提示（advisory）'),
      priority: { type: 'number', description: '优先级，-10..10，默认 0；高的先派发' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const callId = exec?.callId
      const agentId = exec?.agent?.id
      // 只认显式 true：字符串/偏真值都不算，避免模型顺手传 'true' 把普通任务变只读。
      const readOnly = args.readOnly === true
      log('task.create.requested', { agentId, detail: { title: args.title, goal: args.goal, readOnly, callId } })
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
      let effectiveTarget = targetText === '' ? undefined : targetText
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
      // JSON.stringify 会丢掉 undefined，无 target 时 brief 与旧版一致；只读才写入标记。
      const brief = { ...args, target: effectiveTarget, ...(readOnly ? { readOnly: true } : {}) }
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
      const conflicts = writeScopeConflicts(writeScopes)
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
      const task = createTask(db, {
        brief,
        coordinatorSession: current.id ?? coordinatorSession,
        targetDir: effectiveTarget,
        readOnly,
        dependsOn: depends.ids,
        groupId,
        writeScopes,
        priority,
        status: initialStatus,
      })
      log('task.create.created', {
        taskId: task.id,
        agentId,
        sessionId: current.id,
        detail: {
          title,
          callId,
          targetDir: effectiveTarget ?? null,
          readOnly,
          dependsOn: depends.ids,
          group: groupId,
          writeScopes,
          priority,
          status: initialStatus,
        },
      })
      let memoryBlock = ''
      if (config?.memoryInject !== false) {
        try {
          memoryBlock = buildMemoryBlock(db, {
            projectKey: projectKeyOf(effectiveTarget),
            query: `${title} ${goal}`,
            limit: config?.memoryLimit ?? 3,
          })
        } catch { /* 记忆检索失败不能阻止派任务 */ }
      }
      const rendered = `【任务编号】${task.id}\n${renderBrief(brief)}${memoryBlock === '' ? '' : `\n${memoryBlock}`}`
      addMessage(db, task.id, { kind: 'brief', rendered })
      const conflictNote = conflictsText(conflicts)
      const depNames = depends.ids.map(id => {
        const dep = getTask(db, id)
        return dep === undefined ? id : `「${dep.title}」（${labelOf(dep.status)}）`
      }).join('、')
      const dependencyNote = depends.ids.length === 0 ? '' : `前置任务：${depNames}`
      // 配置的协调者会话失效时直接失败：挂进队列只会永远派不出去。
      if (current.live === false) {
        const message = invalidHint() === '' ? '协调者会话已失效' : invalidHint()
        log('task.spawn.failed', { taskId: task.id, agentId, detail: { error: message, callId } })
        transition(db, task.id, 'failed', { error: message })
        throw new Error(message)
      }
      if (initialStatus === 'waiting_dep') {
        const notes = [dependencyNote, conflictNote].filter(Boolean).join('\n')
        log('task.dep.waiting', { taskId: task.id, detail: { dependsOn: depends.ids, callId } })
        return `任务「${taskLabelWithId(task)}」已创建，等待前置任务完成。${notes === '' ? '' : `\n${notes}`}`
      }
      const outcome = await queue.enqueueAndPump(task.id)
      const resultTask = outcome.task
      const inferredNote = inferred === undefined ? '' : `（目标目录按工作区推断：${inferred.path}）`
      const notes = [invalidHint(), inferredNote, conflictNote, dependencyNote].filter(Boolean).join('\n')
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? '子会话创建失败')
      if (resultTask?.status === 'running') {
        return `任务「${taskLabelWithId(task)}」已派发，子会话 ${resultTask.target}。${notes === '' ? '' : `\n${notes}`}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务「${taskLabelWithId(task)}」已创建，前面还有 ${ahead} 个任务在排队，轮到时自动派发。${notes === '' ? '' : `\n${notes}`}`
    }),

    wrap('task_list', '列出任务。默认只列活跃任务（waiting_dep/pending/running/waiting），active=false 时连同历史一起列出；可按 group 过滤并看组进度。', objectSchema({
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
      const header = group === ''
        ? ''
        : `组「${group}」：${tasks.filter(task => task.status === 'done').length}/${tasks.length} 完成\n`
      return header + tasks.map(task => taskLine(db, task, { staleMinutes })).join('\n')
    }),

    wrap('task_status', '查看一个任务的详情与最近消息。', objectSchema({ task_id: str('任务编号，如 t-1a2b3c4d') }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。用 task_list 查编号。`
      const messages = recentMessages(db, task.id, 3)
      const recent = messages.map(row => `- [${row.kind}] ${short(row.rendered, 80)}`).join('\n')
      const lines = [
        `任务「${taskLabelWithId(task)}」`,
        `状态：${labelOf(task.status)}`,
        ...(task.read_only ? ['权限：只读（读正常，写文件/写 shell 被拒绝）'] : []),
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
      if (task.depends_on.length > 0 && task.status !== 'waiting_dep') {
        lines.push(`前置任务：${task.depends_on.map(id => {
          const dep = getTask(db, id)
          return dep === undefined ? id : `「${dep.title}」（${labelOf(dep.status)}）`
        }).join('、')}`)
      }
      if (task.write_scopes.length > 0) lines.push(`写域：${task.write_scopes.join('、')}`)
      if (task.retry_of) lines.push(`重派自：${task.retry_of}`)
      if (task.error !== null && task.error !== undefined) lines.push(`原因：${task.error}`)
      if (config?.backend !== 'team' && task.session_id !== null && task.session_id !== undefined) {
        lines.push('打开方式：协调者会话的子代理目录（subagent catalog），按上面的子会话 id 打开；它不在普通会话列表里。')
      }
      lines.push(`最近消息：\n${recent || '- 无'}`)
      return lines.join('\n')
    }),

    wrap('task_message', '给已有子任务追加一条消息（续派），不新建任务。投递失败会重试 3 次，仍失败则任务转「等你确认」。', objectSchema({
      task_id: str('任务编号'),
      message: str('要追加的内容'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (TERMINAL_STATUS.has(task.status)) return `任务「${labelFor(task)}」已结束（${labelOf(task.status)}），不能续派；需要新工作请 task_create。`
      if (task.status === 'waiting_dep') {
        return `任务「${labelFor(task)}」还在等待前置任务（${task.depends_on.join('、')}），依赖完成后会派发，暂不能续派；要取消用 task_stop。`
      }
      if (task.status === 'pending' && (task.target === null || task.target === undefined)) {
        return task.queued_at === null || task.queued_at === undefined
          ? `任务「${labelFor(task)}」还没有子会话，先停止再重建。`
          : `任务「${labelFor(task)}」正在排队（前面还有 ${Math.max(queue.position(task.id) - 1, 0)} 个），轮到时自动派发，暂不能续派。`
      }
      if (task.target === null || task.target === undefined) return `任务「${labelFor(task)}」还没有子会话，先停止再重建。`
      const message = args.message ?? ''
      addMessage(db, task.id, { kind: 'followup', rendered: message })
      try {
        await sendFollowup(task.target, message, exec?.signal, task.target_dir, task.id, task.read_only === true)
      } catch (error) {
        const reason = error?.message ?? String(error)
        addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
        const current = getTask(db, task.id)
        if (isUnreachable(error) && canTransition(current.status, 'orphaned')) {
          log('task.orphaned', { taskId: task.id, sessionId: task.session_id, detail: { reason } })
          transition(db, task.id, 'orphaned', { error: `子会话不可达：${reason}` })
          releaseTaskSession(task)
          return `续派失败：任务「${labelFor(task)}」的子会话已不可达，已标「会话丢失」，可重建。原因：${reason}`
        }
        if (current.status === 'waiting_user') {
          setTaskError(db, task.id, reason)
        } else if (canTransition(current.status, 'waiting_user')) {
          transition(db, task.id, 'waiting_user', { error: reason })
        } else {
          transition(db, task.id, 'failed', { error: reason })
          releaseTaskSession(task)
        }
        return `续派失败：任务「${labelFor(task)}」已转为「等你确认」（已重试 3 次）。原因：${reason}`
      }
      touchTask(db, task.id)
      const current = getTask(db, task.id)
      if (RESUME_STATUS.has(current.status)) transition(db, task.id, 'running', { error: null })
      incrementAttempts(db, task.id)
      return `已把消息追加给任务「${labelFor(task)}」（子会话 ${task.target}）。`
    }),

    wrap('task_stop', '停止一个子任务（会中断它的当前一轮）。', objectSchema({ task_id: str('任务编号') }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (TERMINAL_STATUS.has(task.status)) return `任务「${labelFor(task)}」已结束（${labelOf(task.status)}），无需停止。`
      if (task.status === 'pending' || task.status === 'waiting_dep') {
        queue.remove(task.id)
        transition(db, task.id, 'cancelled')
        releaseTaskSession(task)
        queue.pump()
        return task.status === 'waiting_dep'
          ? `任务「${labelFor(task)}」已取消（还在等待前置任务）。`
          : `任务「${labelFor(task)}」已取消（还在排队，没有派发出去）。`
      }
      if (task.target !== null && task.target !== undefined) {
        // 停止失败也要把任务标掉：用户要的是「停」，不是让 stop 抛错卡住。
        try {
          await dispatcher.stop(task.target)
        } catch (error) {
          log('task.stop.failed', { taskId: task.id, sessionId: task.session_id, detail: { reason: error?.message ?? String(error) } })
        }
      }
      queue.remove(task.id)
      transition(db, task.id, 'cancelled')
      releaseTaskSession(task)
      queue.pump()
      return `任务「${labelFor(task)}」已停止。`
    }),

    wrap('task_retry', '重派一个失败或会话丢失的任务：用原 brief 新建一次尝试（新任务编号），旧任务保留审计；只有 failed/orphaned 能重派。', objectSchema({
      task_id: str('要重派的任务编号'),
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。用 task_list 查编号。`
      if (!RETRYABLE_STATUS.has(task.status)) {
        return `任务「${labelFor(task)}」当前是${labelOf(task.status)}，只有失败或会话丢失的任务能重派；在跑的任务用 task_message，排队中的用 task_stop 取消后重建。`
      }
      const duplicate = listTasks(db, { active: true })
        .find(item => item.title.trim() === task.title.trim() && item.goal.trim() === task.goal.trim())
      if (duplicate !== undefined) {
        return `已存在活跃任务「${taskLabelWithId(duplicate)}」（${labelOf(duplicate.status)}），未重复重派。`
      }
      const current = status()
      const depends = validateDepends(db, task.depends_on)
      if (depends.ok === false) return `不能重派：${depends.error}。`
      const depState = dependencyState(db, { depends_on: depends.ids })
      const retried = createTask(db, {
        brief: task.brief,
        coordinatorSession: current.id ?? coordinatorSession,
        targetDir: task.target_dir,
        readOnly: task.read_only === true,
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
        detail: { retryOf: task.id, dependsOn: depends.ids, status: retried.status, callId: exec?.callId },
      })
      addMessage(db, retried.id, { kind: 'brief', rendered: `【任务编号】${retried.id}\n${renderBrief(task.brief)}` })
      if (current.live === false) {
        const message = invalidHint() === '' ? '协调者会话已失效' : invalidHint()
        log('task.spawn.failed', { taskId: retried.id, agentId: exec?.agent?.id, detail: { error: message, retryOf: task.id } })
        transition(db, retried.id, 'failed', { error: message })
        throw new Error(message)
      }
      if (retried.status === 'waiting_dep') {
        return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，等待前置任务完成后派发。`
      }
      const outcome = await queue.enqueueAndPump(retried.id)
      const resultTask = outcome.task
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? '子会话创建失败')
      const hint = invalidHint()
      const notes = hint === '' ? '' : `\n${hint}`
      if (resultTask?.status === 'running') {
        return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，子会话 ${resultTask.target}。${notes}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务「${labelFor(task)}」已重派为「${taskLabelWithId(retried)}」，前面还有 ${ahead} 个任务在排队。${notes}`
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
      if (memories.length > 0) blocks.push(`【记忆】\n${memories.map(row => `- ${row.text}`).join('\n')}`)
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
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
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

    wrap('memory_note', '记住一条跨任务有效的决策/偏好/约束（写进 memories，供之后 history_search 与 brief 自动注入）。', objectSchema({
      text: str('要记住的内容，一两句话'),
      project: str('可选：项目绝对路径或工作区名；不传记为全局'),
      kind: { type: 'string', enum: ['note', 'decision', 'preference'], description: '类型，默认 note' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const text = String(args.text ?? '').trim()
      if (text === '') return '要记的内容不能为空。'
      const hint = resolveProjectHint(args.project)
      const kind = ['note', 'decision', 'preference'].includes(args.kind) ? args.kind : 'note'
      const saved = remember(db, {
        text,
        projectKey: hint.key,
        kind,
        sourceSessionId: exec?.agent?.id,
      })
      if (saved === undefined) return '这条已经记过，未重复写入。'
      log('memory.note', { agentId: exec?.agent?.id, detail: { projectKey: hint.key, kind, callId: exec?.callId } })
      return `已记住（${hint.title ?? '全局'}）。`
    }),

    wrap('task_report', '子任务每轮结束必须调用：progress（有进展未完成）、done（完成）、blocked（卡住等人决定）、needs_auth（需要授权）。协调者据此决定是否打扰用户。', objectSchema({
      task_id: str('任务编号，创建时给过'),
      status: { type: 'string', enum: REPORT_STATUS, description: 'progress / done / blocked / needs_auth' },
      summary: str('一句话说明这轮做了什么'),
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
      const normalized = normalizeArtifacts(task, args.artifacts)
      const artifacts = normalized.artifacts
      if (artifacts.length > 0) {
        setTaskArtifacts(db, task.id, artifacts)
        log('task.report.artifacts', {
          taskId: task.id,
          detail: {
            count: artifacts.length,
            omitted: normalized.omitted,
            missing: artifacts.filter(item => item.exists === false).length,
          },
        })
      }
      addMessage(db, task.id, { kind: 'report', rendered: `[${args.status}] ${args.summary ?? ''}` })
      let next = task
      if (args.status === 'done') {
        // blocked/needs_auth 之后子任务直接完成：先回到 running，再走合法迁移到 done。
        if (WAITING_STATUS.has(task.status)) next = transition(db, task.id, 'running', { error: null })
        next = transition(db, task.id, 'done')
      } else if (args.status === 'blocked') next = transition(db, task.id, 'waiting_user')
      else if (args.status === 'needs_auth') next = transition(db, task.id, 'waiting_auth')
      else if (WAITING_STATUS.has(task.status)) next = transition(db, task.id, 'running', { error: null })
      else next = touchTask(db, task.id)
      if (args.status === 'done') {
        try {
          const artifactNote = artifacts.length > 0
            ? `；产物：${artifacts.slice(0, 5).map(item => item.path).join('、')}`
            : ''
          addMemory(db, {
            projectKey: projectKeyOf(next.target_dir),
            kind: 'task-done',
            text: `任务「${next.title}」完成：${args.summary ?? ''}${artifactNote}`,
            sourceTaskId: next.id,
            sourceSessionId: next.session_id,
          })
        } catch { /* 记忆沉淀失败不能影响回报 */ }
      }
      const displayName = labelFor(next)
      notifier.push({
        taskId: next.id,
        title: next.title,
        displayName,
        readOnly: next.read_only === true,
        status: args.status,
        summary: args.summary ?? '',
        artifacts,
        artifactsTruncated: normalized.omitted,
        sender: exec?.agent,
        signal: exec?.signal,
      })
      log('task.report', {
        taskId: next.id,
        sessionId: task.session_id,
        agentId: exec?.agent?.id,
        detail: { status: args.status, summary: args.summary ?? '', callId: exec?.callId },
      })
      // 任务到终态意味着并发槽位空出来了，唤醒队列补位；done 同时释放该会话的 target 可写根。
      if (next.status === 'done') releaseTaskSession(task)
      if (next.status === 'done' || next.status === 'failed' || next.status === 'cancelled') queue.pump()
      const hint = invalidHint()
      return `已记录任务「${labelFor(next)}」的 ${args.status} 回报。${hint === '' ? '' : `\n${hint}`}`
    }),
  ]
}
