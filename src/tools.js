// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { validateBrief, renderBrief, validateTargetDir } from './brief.js'
import { inferWorkspaceTarget } from './workspace-match.js'
import { canTransition } from './state.js'
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
  pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}
const ACTIVE_STATUS = new Set(['pending', 'running', 'waiting_user', 'waiting_auth'])
const WAITING_STATUS = new Set(['waiting_user', 'waiting_auth'])
const RESUME_STATUS = new Set(['waiting_user', 'waiting_auth', 'failed'])
const TERMINAL_STATUS = new Set(['done', 'cancelled', 'orphaned'])

const labelOf = status => STATUS_LABEL[status] ?? status
const short = (value, max = 40) => {
  const text = String(value ?? '').split('\n')[0].trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function taskLine(db, task, { staleMinutes = 30 } = {}) {
  const parts = [
    `- ${task.id}`, task.title, labelOf(task.status), `子会话 ${task.target ?? '-'}`,
    `目标：${short(task.goal)}`,
  ]
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

export function createTools({ db, dispatcher, queue, notifier, config, coordinatorStatus, logger, workspaces, defaultCwd }) {
  const staleMinutes = config?.staleMinutes ?? 30
  const coordinatorSession = config?.coordinatorSession ?? 'unknown'
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志绝不能打断主流程 */ }
  }
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

  // 产物路径：相对路径按任务目录解析；非法条目静默丢弃；只 stat 存在性，不读文件、不让 report 失败。
  const normalizeArtifacts = (task, input) => {
    if (!Array.isArray(input)) return { artifacts: [], omitted: 0 }
    // 入口先截断，避免为几百条无关键做 resolve/stat。
    const entries = input.slice(0, MAX_ARTIFACTS)
    const omitted = input.length - entries.length
    const base = task.target_dir ?? defaultCwd
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

  const sendFollowup = async (target, message, signal) => {
    if (typeof dispatcher.sendReliable === 'function') return dispatcher.sendReliable(target, message, signal)
    return dispatcher.send(target, message, signal)
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
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const callId = exec?.callId
      const agentId = exec?.agent?.id
      log('task.create.requested', { agentId, detail: { title: args.title, goal: args.goal, callId } })
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
      // JSON.stringify 会丢掉 undefined，无 target 时 brief 与旧版一致。
      const brief = { ...args, target: effectiveTarget }
      const current = status()
      // 去重、队列容量、创建必须在同一个同步段里，中间不能再 await，否则并发调用会一起通过检查。
      const title = String(args.title).trim()
      const goal = String(args.goal).trim()
      const duplicate = listTasks(db, { active: true })
        .find(task => task.title.trim() === title && task.goal.trim() === goal)
      if (duplicate !== undefined) {
        log('task.create.rejected', {
          agentId,
          detail: { reason: 'duplicate', existingTaskId: duplicate.id, existingStatus: duplicate.status, callId },
        })
        return `已存在任务 ${duplicate.id}「${duplicate.title}」（${labelOf(duplicate.status)}），未重复创建。`
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
      const task = createTask(db, { brief, coordinatorSession: current.id ?? coordinatorSession, targetDir: effectiveTarget })
      log('task.create.created', { taskId: task.id, agentId, sessionId: current.id, detail: { title, callId, targetDir: effectiveTarget ?? null } })
      const rendered = `【任务编号】${task.id}\n${renderBrief(brief)}`
      addMessage(db, task.id, { kind: 'brief', rendered })
      // 配置的协调者会话失效时直接失败：挂进队列只会永远派不出去。
      if (current.live === false) {
        const message = invalidHint() === '' ? '协调者会话已失效' : invalidHint()
        log('task.spawn.failed', { taskId: task.id, agentId, detail: { error: message, callId } })
        transition(db, task.id, 'failed', { error: message })
        throw new Error(message)
      }
      const outcome = await queue.enqueueAndPump(task.id)
      const resultTask = outcome.task
      const inferredNote = inferred === undefined ? '' : `（目标目录按工作区推断：${inferred.path}）`
      const notes = [invalidHint(), inferredNote].filter(Boolean).join('\n')
      if (resultTask?.status === 'failed') throw new Error(resultTask.error ?? '子会话创建失败')
      if (resultTask?.status === 'running') {
        return `任务 ${task.id}「${task.title}」已派发，子会话 ${resultTask.target}。${notes === '' ? '' : `\n${notes}`}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务 ${task.id}「${task.title}」已创建，前面还有 ${ahead} 个任务在排队，轮到时自动派发。${notes === '' ? '' : `\n${notes}`}`
    }),

    wrap('task_list', '列出任务。默认只列活跃任务（pending/running/waiting），active=false 时连同历史一起列出。', objectSchema({
      active: { type: 'boolean', description: '是否只看活跃任务，默认 true' },
    }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const tasks = listTasks(db, { active: args.active !== false })
      if (tasks.length === 0) return args.active === false ? '台账里还没有任何任务。' : '没有活跃任务。'
      return tasks.map(task => taskLine(db, task, { staleMinutes })).join('\n')
    }),

    wrap('task_status', '查看一个任务的详情与最近消息。', objectSchema({ task_id: str('任务编号，如 t-1a2b3c4d') }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。用 task_list 查编号。`
      const messages = recentMessages(db, task.id, 3)
      const recent = messages.map(row => `- [${row.kind}] ${short(row.rendered, 80)}`).join('\n')
      const lines = [
        `任务 ${task.id}「${task.title}」`,
        `状态：${labelOf(task.status)}`,
        `子会话：${task.target ?? '-'}`,
        ...(task.status === 'pending'
          ? [`排队：${task.queued_at === null || task.queued_at === undefined ? '待派发（刚创建）' : '排队中（等待并发槽位）'}`]
          : []),
        `目标：${task.goal}`,
      ]
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
      if (TERMINAL_STATUS.has(task.status)) return `任务 ${task.id} 已结束（${labelOf(task.status)}），不能续派；需要新工作请 task_create。`
      if (task.status === 'pending' && (task.target === null || task.target === undefined)) {
        return task.queued_at === null || task.queued_at === undefined
          ? `任务 ${task.id} 还没有子会话，先停止再重建。`
          : `任务 ${task.id} 正在排队（前面还有 ${Math.max(queue.position(task.id) - 1, 0)} 个），轮到时自动派发，暂不能续派。`
      }
      if (task.target === null || task.target === undefined) return `任务 ${task.id} 还没有子会话，先停止再重建。`
      const message = args.message ?? ''
      addMessage(db, task.id, { kind: 'followup', rendered: message })
      try {
        await sendFollowup(task.target, message, exec?.signal)
      } catch (error) {
        const reason = error?.message ?? String(error)
        addMessage(db, task.id, { kind: 'delivery_failed', rendered: `[投递失败] ${reason}` })
        const current = getTask(db, task.id)
        if (isUnreachable(error) && canTransition(current.status, 'orphaned')) {
          log('task.orphaned', { taskId: task.id, sessionId: task.session_id, detail: { reason } })
          transition(db, task.id, 'orphaned', { error: `子会话不可达：${reason}` })
          return `续派失败：任务 ${task.id} 的子会话已不可达，已标「会话丢失」，可重建。原因：${reason}`
        }
        if (current.status === 'waiting_user') {
          setTaskError(db, task.id, reason)
        } else if (canTransition(current.status, 'waiting_user')) {
          transition(db, task.id, 'waiting_user', { error: reason })
        } else {
          transition(db, task.id, 'failed', { error: reason })
        }
        return `续派失败：任务 ${task.id} 已转为「等你确认」（已重试 3 次）。原因：${reason}`
      }
      touchTask(db, task.id)
      const current = getTask(db, task.id)
      if (RESUME_STATUS.has(current.status)) transition(db, task.id, 'running', { error: null })
      incrementAttempts(db, task.id)
      return `已把消息追加给任务 ${task.id}（子会话 ${task.target}）。`
    }),

    wrap('task_stop', '停止一个子任务（会中断它的当前一轮）。', objectSchema({ task_id: str('任务编号') }), async (args, exec) => {
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (TERMINAL_STATUS.has(task.status)) return `任务 ${task.id} 已结束（${labelOf(task.status)}），无需停止。`
      if (task.status === 'pending') {
        queue.remove(task.id)
        transition(db, task.id, 'cancelled')
        return `任务 ${task.id} 已取消（还在排队，没有派发出去）。`
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
      queue.pump()
      return `任务 ${task.id} 已停止。`
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
        return `回报被拒绝：任务 ${task.id} 属于子会话 ${task.target ?? task.session_id}，当前回报方不是它。`
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
      notifier.push({
        taskId: next.id,
        title: next.title,
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
      // 任务到终态意味着并发槽位空出来了，唤醒队列补位。
      if (next.status === 'done' || next.status === 'failed' || next.status === 'cancelled') queue.pump()
      const hint = invalidHint()
      return `已记录任务 ${next.id} 的 ${args.status} 回报。${hint === '' ? '' : `\n${hint}`}`
    }),
  ]
}
