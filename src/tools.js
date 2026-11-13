// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { validateBrief, renderBrief } from './brief.js'
import { canTransition } from './state.js'
import {
  addMessage, createTask, getTask, listTasks, recentMessages,
  setTaskError, touchTask, transition, incrementAttempts,
} from './ledger.js'

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
const str = description => ({ type: 'string', description })
const strList = description => ({ type: 'array', items: { type: 'string' }, description })
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value === undefined ? '' : String(value) }],
}

const REPORT_STATUS = ['progress', 'done', 'blocked', 'needs_auth']
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

export function createTools({ db, dispatcher, queue, notifier, config, bindCoordinator, coordinatorStatus, logger }) {
  const staleMinutes = config?.staleMinutes ?? 30
  const coordinatorSession = config?.coordinatorSession ?? 'unknown'
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志绝不能打断主流程 */ }
  }
  const bind = typeof bindCoordinator === 'function'
    ? bindCoordinator
    : async () => ({ id: config?.coordinatorSession, live: true })
  const status = typeof coordinatorStatus === 'function'
    ? coordinatorStatus
    : () => ({ id: config?.coordinatorSession, live: true })
  const invalidHint = () => {
    const value = status()
    return value?.id !== undefined && value.live === false
      ? '协调者会话已失效，可用配置覆盖或在新会话里派任务重新绑定。'
      : ''
  }
  const unbound = () => status().id === undefined
  const UNBOUND_HINT = '尚未绑定协调者，请先 task_create。'

  const sendFollowup = async (target, message, signal) => {
    if (typeof dispatcher.sendReliable === 'function') return dispatcher.sendReliable(target, message, signal)
    return dispatcher.send(target, message, signal)
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
    }), async (args, exec) => {
      const callId = exec?.callId
      const agentId = exec?.agent?.id
      log('task.create.requested', { agentId, detail: { title: args.title, goal: args.goal, callId } })
      const errors = validateBrief(args)
      if (errors.length > 0) {
        log('task.create.rejected', { agentId, detail: { reason: 'validation', message: errors.join('；'), callId } })
        return `任务描述不完整：${errors.join('；')}。补齐后再派。`
      }
      const binding = await bind(exec?.agent)
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
      const task = createTask(db, { brief: args, coordinatorSession: binding?.id ?? coordinatorSession })
      log('task.create.created', { taskId: task.id, agentId, sessionId: binding?.id, detail: { title, callId } })
      const rendered = `【任务编号】${task.id}\n${renderBrief(args)}`
      addMessage(db, task.id, { kind: 'brief', rendered })
      // 配置的协调者会话失效时直接失败：挂进队列只会永远派不出去。
      if (binding?.live === false) {
        const message = invalidHint() === '' ? '协调者会话已失效' : invalidHint()
        log('task.spawn.failed', { taskId: task.id, agentId, detail: { error: message, callId } })
        transition(db, task.id, 'failed', { error: message })
        throw new Error(message)
      }
      const outcome = await queue.enqueueAndPump(task.id)
      const current = outcome.task
      const hint = invalidHint()
      const changed = binding?.changed === true
        ? `协调者会话已变更：${binding.previous} → ${binding.id}。`
        : ''
      const notes = [changed, hint].filter(Boolean).join('\n')
      if (current?.status === 'failed') throw new Error(current.error ?? '子会话创建失败')
      if (current?.status === 'running') {
        return `任务 ${task.id}「${task.title}」已派发，子会话 ${current.target}。${notes === '' ? '' : `\n${notes}`}`
      }
      const ahead = Math.max(outcome.position - 1, 0)
      return `任务 ${task.id}「${task.title}」已创建，前面还有 ${ahead} 个任务在排队，轮到时自动派发。${notes === '' ? '' : `\n${notes}`}`
    }),

    wrap('task_list', '列出任务。默认只列活跃任务（pending/running/waiting），active=false 时连同历史一起列出。', objectSchema({
      active: { type: 'boolean', description: '是否只看活跃任务，默认 true' },
    }), async args => {
      const tasks = listTasks(db, { active: args.active !== false })
      if (tasks.length === 0) return args.active === false ? '台账里还没有任何任务。' : '没有活跃任务。'
      return tasks.map(task => taskLine(db, task, { staleMinutes })).join('\n')
    }),

    wrap('task_status', '查看一个任务的详情与最近消息。', objectSchema({ task_id: str('任务编号，如 t-1a2b3c4d') }), async args => {
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
      lines.push(`最近消息：\n${recent || '- 无'}`)
      return lines.join('\n')
    }),

    wrap('task_message', '给已有子任务追加一条消息（续派），不新建任务。投递失败会重试 3 次，仍失败则任务转「等你确认」。', objectSchema({
      task_id: str('任务编号'),
      message: str('要追加的内容'),
    }), async (args, exec) => {
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
      if (unbound()) return UNBOUND_HINT
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (TERMINAL_STATUS.has(task.status)) return `任务 ${task.id} 已结束（${labelOf(task.status)}），无需停止。`
      if (task.status === 'pending') {
        queue.remove(task.id)
        transition(db, task.id, 'cancelled')
        return `任务 ${task.id} 已取消（还在排队，没有派发出去）。`
      }
      if (task.target !== null && task.target !== undefined) await dispatcher.stop(task.target)
      queue.remove(task.id)
      transition(db, task.id, 'cancelled')
      queue.pump()
      return `任务 ${task.id} 已停止。`
    }),

    wrap('task_report', '子任务每轮结束必须调用：progress（有进展未完成）、done（完成）、blocked（卡住等人决定）、needs_auth（需要授权）。协调者据此决定是否打扰用户。', objectSchema({
      task_id: str('任务编号，创建时给过'),
      status: { type: 'string', enum: REPORT_STATUS, description: 'progress / done / blocked / needs_auth' },
      summary: str('一句话说明这轮做了什么'),
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
