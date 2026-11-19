// 平台 goal 接入（G1 / P2-2）：插件是子任务 goal 的唯一写方，续跑交给宿主 goal 轮次驱动。
//
// 插件只做 create / edit / complete / clear（+ 只读 get 做镜像与降级）。`task_create.goalRounds`（默认 0）
// >0 时 create 带 `maxGoalRounds` 并保持 armed，由宿主 dsh-goal-round-driver 续轮；=0 时 create 后立刻 disarm
// （与 P2-2 之前完全一致）。轮次真源是平台 goal，台账只存只读镜像；能力缺失时所有钩子静默 no-op。
import { getTask, setTaskGoalState } from './ledger.js'

// 需要的 GoalService 方法；缺任何一个都按「平台没有 goal 能力」处理（旧版/裁剪 profile）。
export const GOAL_CAPABILITY_METHODS = ['get', 'create', 'disarm', 'edit', 'complete', 'clear']

/** 轮次预算：默认 0（不续跑），上限 50（与 task_create.goalRounds 的 schema 一致）。 */
export const GOAL_ROUNDS_DEFAULT = 0
export const GOAL_ROUNDS_MAX = 50

const noop = () => {}
const MAX_OBJECTIVE_CHARS = 2000

/** 归一化轮次预算：缺省 → 0；只认 0–50 的整数；其余返回 undefined，由调用方明确报错（不静默降级成 0）。 */
export function normalizeGoalRounds(value) {
  if (value === undefined || value === null) return GOAL_ROUNDS_DEFAULT
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return undefined
  return value >= 0 && value <= GOAL_ROUNDS_MAX ? value : undefined
}

/** 列出一个 goals 服务缺哪些方法；服务本身缺失时返回全部。 */
export function missingGoalMethods(goals) {
  const source = goals ?? {}
  return GOAL_CAPABILITY_METHODS.filter(name => typeof source[name] !== 'function')
}

/** 续派消息也是「最新指示」：并进目标文本；同一条消息重复投递时文本不变，不会重复 edit。 */
export function objectiveForMessage(base, message, max = MAX_OBJECTIVE_CHARS) {
  const goal = String(base ?? '').trim()
  const instruction = String(message ?? '').trim()
  if (instruction === '') return goal
  const text = goal === '' ? instruction : `${goal}\n\n最新指示：${instruction}`
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 只保留面板/台账需要的字段，避免把平台对象或大段内部结构写进 SQLite。 */
export function goalStateOf(view, extra = {}) {
  if (view === undefined || view === null) return null
  return {
    id: view.id ?? null,
    revision: view.revision ?? null,
    objective: view.objective ?? '',
    phase: view.phase ?? null,
    activation: view.activation ?? null,
    roundsStarted: view.roundsStarted ?? 0,
    maxGoalRounds: view.maxGoalRounds ?? null,
    updatedAt: view.updatedAt ?? null,
    ...extra,
  }
}

/**
 * 子会话 goal 桥：attach（派发后）/ update（续派后）/ complete / clear / stateOf（只读镜像）。
 * 所有平台调用都吞错并只 warn 一次同类错误；能力缺失时完全静默。
 */
export function createGoalBridge({
  db, goals, agents, onAgentCreated, onWarn = noop, onEvent = noop, waitMs = 3000, now = Date.now,
} = {}) {
  const warned = new Set()
  const waiters = new Map()
  const service = () => {
    try {
      return typeof goals === 'function' ? goals() : goals
    } catch {
      return undefined
    }
  }
  const available = () => missingGoalMethods(service()).length === 0
  const method = name => {
    const current = service()
    return typeof current?.[name] === 'function' ? current[name].bind(current) : undefined
  }
  const agentOf = sessionId => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const registry = typeof agents === 'function' ? agents() : agents
      return registry?.get?.(sessionId)
    } catch {
      return undefined
    }
  }
  const warnOnce = (key, error, extra = '') => {
    if (warned.has(key)) return
    warned.add(key)
    const suffix = error?.code === undefined ? '' : `[${error.code}] `
    try { onWarn(`dsh-orchestrator: goal ${extra}${suffix}${error?.message ?? error}`) } catch { /* 日志失败不打断主流程 */ }
  }
  // goal 服务要求「注册表里的同一个 live agent 实例」；刚 spawn 或冷恢复时 agent 可能晚几毫秒出现。
  const resolveAgent = sessionId => {
    const found = agentOf(sessionId)
    if (found !== undefined) return Promise.resolve(found)
    if (typeof onAgentCreated !== 'function') return Promise.resolve(undefined)
    return new Promise(resolve => {
      let done = false
      const finish = agent => {
        if (done) return
        done = true
        clearTimeout(timer)
        const pending = waiters.get(sessionId)
        pending?.delete(finish)
        if (pending?.size === 0) waiters.delete(sessionId)
        resolve(agent)
      }
      const timer = setTimeout(() => finish(undefined), Math.max(0, waitMs))
      timer.unref?.()
      const pending = waiters.get(sessionId) ?? new Set()
      pending.add(finish)
      waiters.set(sessionId, pending)
    })
  }
  if (typeof onAgentCreated === 'function') {
    try {
      onAgentCreated(agent => {
        const id = agent?.id
        if (typeof id !== 'string') return
        const pending = waiters.get(id)
        if (pending === undefined) return
        waiters.delete(id)
        for (const finish of [...pending]) finish(agent)
      })
    } catch { /* 订阅失败只影响目标同步 */ }
  }

  const refOf = view => ({ id: view.id, revision: view.revision })
  const mirror = (taskId, state) => {
    if (db === undefined || taskId === undefined || taskId === null) return
    try { setTaskGoalState(db, taskId, state) } catch (error) { warnOnce(`mirror:${taskId}`, error, '写台账镜像失败：') }
  }
  const remember = (taskId, view, extra) => {
    const state = goalStateOf(view, extra)
    mirror(taskId, state)
    return state
  }
  const emit = (event, taskId, sessionId, detail = {}) => {
    try { onEvent(event, { taskId, sessionId, detail }) } catch { /* 审计事件失败不能外溢 */ }
  }
  const previousState = taskId => {
    if (db === undefined || taskId === undefined || taskId === null) return null
    try { return getTask(db, taskId)?.goal_state ?? null } catch { return null }
  }
  // 轮次预算的唯一真源是台账（task_create 写入、重派复制）；桥只读它，不持有也不回写。
  const roundsOf = taskId => {
    if (db === undefined || taskId === undefined || taskId === null) return GOAL_ROUNDS_DEFAULT
    try { return normalizeGoalRounds(getTask(db, taskId)?.goal_rounds) ?? GOAL_ROUNDS_DEFAULT } catch { return GOAL_ROUNDS_DEFAULT }
  }
  // 终态时 agent 往往已经不在注册表：只把台账镜像收口，面板不显示「还在进行」。
  const markTerminal = (taskId, phase) => {
    const prior = previousState(taskId)
    if (prior === null || prior.phase === phase) return prior
    const state = { ...prior, phase, activation: 'disarmed', updatedAt: now(), [`${phase}At`]: now() }
    mirror(taskId, state)
    return state
  }
  /**
   * 把平台 goal 收敛到「台账说的样子」：没 goal（或已 complete）就 create，有就只改变化的部分。
   * goalRounds=0 → 一定 disarmed（create 会 arm，所以必须紧接 disarm）；>0 → 保持 armed，轮次交宿主 driver。
   */
  const sync = (agent, text, rounds) => {
    const current = method('get')(agent)
    if (current === undefined || current.phase === 'complete') {
      const created = rounds > 0
        ? method('create')(agent, { objective: text, maxGoalRounds: rounds })
        : method('create')(agent, { objective: text })
      return { view: rounds > 0 ? created : (method('disarm')(agent) ?? created), created: true }
    }
    const patch = {}
    if (text !== '' && current.objective !== text) patch.objective = text
    if (rounds > 0 && current.maxGoalRounds !== rounds) patch.maxGoalRounds = rounds
    let view = Object.keys(patch).length > 0 ? method('edit')(agent, refOf(current), patch) : current
    // 0 = 不续跑：外部（宿主 /goal resume）或上一段 activation 留下的 armed 一律压回 disarmed。
    if (rounds === 0 && view.activation === 'armed') view = method('disarm')(agent) ?? view
    return { view, created: false }
  }
  const converge = async (taskId, sessionId, objective, hook) => {
    const text = String(objective ?? '').trim()
    if (text === '' || !available()) return undefined
    const agent = await resolveAgent(sessionId)
    if (agent === undefined) {
      if (hook === 'attach') emit('goal.skipped', taskId, sessionId, { reason: 'agent-not-live' })
      return undefined
    }
    const rounds = roundsOf(taskId)
    try {
      const { view, created } = sync(agent, text, rounds)
      const state = remember(taskId, view)
      emit(created ? 'goal.created' : 'goal.updated', taskId, sessionId, {
        goalId: view.id,
        revision: view.revision,
        activation: view.activation,
        goalRounds: rounds,
        maxGoalRounds: view.maxGoalRounds ?? null,
        ...(hook === 'update' ? { hook } : {}),
      })
      // goalRounds>0 却没 armed：宿主没把 driver 接上（旧宿主/裁剪 profile）。如实记一条，不抛。
      if (rounds > 0 && view.activation !== 'armed') emit('goal.degraded', taskId, sessionId, { reason: 'not-armed', goalRounds: rounds })
      return state
    } catch (error) {
      warnOnce(`${hook}:${error?.code ?? error?.message}`, error, hook === 'attach' ? '创建失败：' : '更新失败：')
      emit('goal.failed', taskId, sessionId, { hook, error: error?.code ?? String(error?.message ?? error) })
      return undefined
    }
  }

  // 终态收敛：complete（done）/ clear（stop·retry·orphaned·failed）。没有 live agent（冷恢复/孤儿）时只收口台账镜像。
  const finish = async (taskId, sessionId, kind) => {
    const done = kind === 'complete'
    const terminal = done ? 'complete' : 'cleared'
    if (!available()) return undefined
    const agent = agentOf(sessionId)
    if (agent === undefined) return markTerminal(taskId, terminal)
    try {
      const current = method('get')(agent)
      if (current === undefined) return markTerminal(taskId, terminal)
      if (done) {
        const view = current.phase === 'complete' ? current : method('complete')(agent, refOf(current))
        const state = remember(taskId, view)
        emit('goal.completed', taskId, sessionId, { goalId: view.id, revision: view.revision })
        return state
      }
      const ref = method('clear')(agent, refOf(current))
      const state = remember(taskId, goalStateOf(current, { phase: 'cleared', activation: 'disarmed', revision: ref.revision, clearedAt: now() }))
      emit('goal.cleared', taskId, sessionId, { goalId: current.id, revision: ref.revision })
      return state
    } catch (error) {
      // GOAL_NOT_FOUND 只在并发 clear 时出现，按已收口处理；其他错误只 warn。
      if (!done && error?.code === 'GOAL_NOT_FOUND') return markTerminal(taskId, 'cleared')
      warnOnce(`${kind}:${error?.code ?? error?.message}`, error, done ? '完成失败：' : '清除失败：')
      return undefined
    }
  }

  return {
    available,
    missing: () => missingGoalMethods(service()),
    resolveAgent,
    objectiveForMessage,
    /** 派发后：按 goalRounds 建/收敛目标。return 值为写入台账的只读快照。 */
    attach: (taskId, sessionId, objective) => converge(taskId, sessionId, objective, 'attach'),
    /** 续派后：文本/轮次变了才 edit；goalRounds=0 时确保 disarmed。 */
    update: (taskId, sessionId, objective) => converge(taskId, sessionId, objective, 'update'),
    /** done：complete（幂等）。 */
    complete: (taskId, sessionId) => finish(taskId, sessionId, 'complete'),
    /** stop/retry/orphaned/failed：clear（幂等）。 */
    clear: (taskId, sessionId) => finish(taskId, sessionId, 'clear'),

    /** 面板/台账只读展示：live agent 有 goal 就用最新视图，否则读台账镜像。 */
    stateOf(taskId, sessionId) {
      if (!available()) return previousState(taskId)
      const agent = agentOf(sessionId)
      if (agent === undefined) return previousState(taskId)
      try {
        const view = method('get')(agent)
        return view === undefined ? previousState(taskId) : goalStateOf(view)
      } catch {
        return previousState(taskId)
      }
    },
  }
}
