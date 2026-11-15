// 平台 goal 接入（G1）：把子任务的 durable 目标同步到 DSH goal 子系统。
// 只做「声明式状态」：create 后立刻 disarm，goal 不驱动子会话自动续轮；
// 目标变更走 edit，终态走 complete/clear；能力缺失时所有方法静默降级（不抛、不拦派发）。
import { getTask, setTaskGoalState } from './ledger.js'

// 需要的 GoalService 方法；缺任何一个都按「平台没有 goal 能力」处理（旧版/裁剪 profile）。
export const GOAL_CAPABILITY_METHODS = ['get', 'create', 'disarm', 'edit', 'complete', 'clear']

const noop = () => {}
const MAX_OBJECTIVE_CHARS = 2000

/** 列出一个 goals 服务缺哪些方法；服务本身缺失时返回全部。 */
export function missingGoalMethods(goals) {
  const source = goals ?? {}
  return GOAL_CAPABILITY_METHODS.filter(name => typeof source[name] !== 'function')
}

/** 续派消息也是「最新指示」：把它并进目标文本，便于面板看到子会话当前在做什么。
 *  只做确定性拼接（不猜语义）；同一条消息重复投递时文本不变，不会重复 edit。 */
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
 * 子会话 goal 桥。
 * - `attach`：派发成功后 create + disarm（顺序固定：先 create 拿到 view，紧接着 disarm）。
 * - `update`：续派后目标文本变化才 edit，并保持 disarmed。
 * - `complete` / `clear`：终态收敛（done → complete；stop/retry/orphaned/failed → clear）。
 * - `stateOf`：面板/台账只读快照（live 优先，否则读台账镜像）。
 * 所有平台调用都吞错并只 warn 一次同类错误；能力缺失时完全静默。
 */
export function createGoalBridge({
  db,
  goals,
  agents,
  onAgentCreated,
  onWarn = noop,
  onEvent = noop,
  waitMs = 3000,
  now = Date.now,
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
  const missing = () => missingGoalMethods(service())
  const available = () => missing().length === 0
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
    try {
      onWarn(`dsh-orchestrator: goal ${extra}${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}`)
    } catch { /* 日志失败不能打断主流程 */ }
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
    try {
      setTaskGoalState(db, taskId, state)
    } catch (error) {
      warnOnce(`mirror:${taskId}`, error, '写台账镜像失败：')
    }
  }
  const remember = (taskId, view, extra) => {
    const state = goalStateOf(view, extra)
    mirror(taskId, state)
    return state
  }
  const emit = (event, taskId, sessionId, detail = {}) => {
    try {
      onEvent(event, { taskId, sessionId, detail })
    } catch { /* 审计事件失败不能外溢 */ }
  }
  const previousState = taskId => {
    if (db === undefined || taskId === undefined || taskId === null) return null
    try {
      return getTask(db, taskId)?.goal_state ?? null
    } catch {
      return null
    }
  }
  // 终态时 agent 往往已经不在注册表：没有平台调用可做，只把台账镜像收口，面板不显示「还在进行」。
  const markTerminal = (taskId, phase) => {
    const prior = previousState(taskId)
    if (prior === null || prior.phase === phase) return prior
    const state = { ...prior, phase, activation: 'disarmed', updatedAt: now(), [`${phase}At`]: now() }
    mirror(taskId, state)
    return state
  }

  const bridge = {
    available,
    missing,
    resolveAgent,
    objectiveForMessage,

    /** 派发后：create + disarm。return 值为写入台账的只读快照。 */
    async attach(taskId, sessionId, objective) {
      const text = String(objective ?? '').trim()
      if (text === '' || !available()) return undefined
      const agent = await resolveAgent(sessionId)
      if (agent === undefined) {
        emit('goal.skipped', taskId, sessionId, { reason: 'agent-not-live' })
        return undefined
      }
      const create = method('create')
      const disarm = method('disarm')
      const edit = method('edit')
      const get = method('get')
      try {
        let view = get(agent)
        if (view !== undefined && view.phase !== 'complete') {
          // 同一会话重复 attach（如插件重载/重派前）：复用目标，只在文本变了时 edit。
          if (view.objective !== text) view = edit(agent, refOf(view), { objective: text })
          if (view.activation === 'armed') view = disarm(agent)
        } else {
          // 顺序是硬约束：create 会 arm（可能在 idle 时触发自动续轮），必须紧接着 disarm。
          const created = create(agent, { objective: text })
          view = disarm(agent) ?? created
        }
        const state = remember(taskId, view)
        emit('goal.created', taskId, sessionId, { goalId: view.id, revision: view.revision, activation: view.activation })
        return state
      } catch (error) {
        warnOnce(`attach:${error?.code ?? error?.message}`, error, '创建失败：')
        emit('goal.failed', taskId, sessionId, { hook: 'attach', error: error?.code ?? String(error?.message ?? error) })
        return undefined
      }
    },

    /** 续派后：目标文本变化才 edit；无论如何都确保 disarmed。 */
    async update(taskId, sessionId, objective) {
      const text = String(objective ?? '').trim()
      if (text === '' || !available()) return undefined
      const agent = await resolveAgent(sessionId)
      if (agent === undefined) return undefined
      const get = method('get')
      const create = method('create')
      const disarm = method('disarm')
      const edit = method('edit')
      try {
        let view = get(agent)
        if (view === undefined) {
          // 目标缺失（能力晚挂载/旧任务）：补一次 create + disarm，行为与 attach 一致。
          const created = create(agent, { objective: text })
          view = disarm(agent) ?? created
          const state = remember(taskId, view)
          emit('goal.created', taskId, sessionId, { goalId: view.id, revision: view.revision, hook: 'update' })
          return state
        }
        if (view.objective !== text) view = edit(agent, refOf(view), { objective: text })
        if (view.activation === 'armed') view = disarm(agent)
        const state = remember(taskId, view)
        emit('goal.updated', taskId, sessionId, { goalId: view.id, revision: view.revision })
        return state
      } catch (error) {
        warnOnce(`update:${error?.code ?? error?.message}`, error, '更新失败：')
        emit('goal.failed', taskId, sessionId, { hook: 'update', error: error?.code ?? String(error?.message ?? error) })
        return undefined
      }
    },

    /** done：complete（幂等；没有 goal 时只收口台账镜像）。 */
    async complete(taskId, sessionId) {
      if (!available()) return undefined
      const agent = agentOf(sessionId)
      if (agent === undefined) return markTerminal(taskId, 'complete')
      try {
        const current = method('get')(agent)
        if (current === undefined) return markTerminal(taskId, 'complete')
        const view = current.phase === 'complete' ? current : method('complete')(agent, refOf(current))
        const state = remember(taskId, view)
        emit('goal.completed', taskId, sessionId, { goalId: view.id, revision: view.revision })
        return state
      } catch (error) {
        warnOnce(`complete:${error?.code ?? error?.message}`, error, '完成失败：')
        return undefined
      }
    },

    /** stop/retry/orphaned/failed：clear（幂等；没有 live agent 时只收口台账镜像）。 */
    async clear(taskId, sessionId) {
      if (!available()) return undefined
      const agent = agentOf(sessionId)
      if (agent === undefined) return markTerminal(taskId, 'cleared')
      try {
        const current = method('get')(agent)
        if (current === undefined) return markTerminal(taskId, 'cleared')
        const ref = method('clear')(agent, refOf(current))
        const state = remember(taskId, goalStateOf(current, { phase: 'cleared', activation: 'disarmed', revision: ref.revision, clearedAt: now() }))
        emit('goal.cleared', taskId, sessionId, { goalId: current.id, revision: ref.revision })
        return state
      } catch (error) {
        // GOAL_NOT_FOUND 只在并发 clear 时出现，按已收口处理；其他错误只 warn。
        if (error?.code === 'GOAL_NOT_FOUND') return markTerminal(taskId, 'cleared')
        warnOnce(`clear:${error?.code ?? error?.message}`, error, '清除失败：')
        return undefined
      }
    },

    /** 面板/台账只读展示：live agent 有 goal 就用最新视图，否则读台账镜像。 */
    stateOf(taskId, sessionId) {
      if (!available()) return previousState(taskId)
      const agent = agentOf(sessionId)
      if (agent === undefined) return previousState(taskId)
      try {
        const view = method('get')(agent)
        if (view === undefined) return previousState(taskId)
        return goalStateOf(view)
      } catch {
        return previousState(taskId)
      }
    },
  }
  return bridge
}
