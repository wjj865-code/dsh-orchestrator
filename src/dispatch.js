// 派发层：把「建子会话 / 投递 / 停止」收成一个窄接口。
// 后端二选一：subagent（默认，直连 ctx.subagents）或 team（旧的 agentTeams 名册）。
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { messageText } from './last-message.js'
import { EXIT_PLAN_MODE_DENIAL } from './plan-mode.js'

let counter = 0

function slugify(title) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  counter += 1
  return ascii === '' ? `task-${Date.now()}-${counter}` : `${ascii.slice(0, 32)}-${counter}`
}

const sleep = ms => ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms))
const noop = () => {}

const errorText = error => `${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}`

// 结算事件带一段可读输出（与平台 SubagentResult.output 同形），供台账记「死因」用。
const settleOutput = (output, max = 240) => {
  const blocks = Array.isArray(output) ? output : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? '' : (text.length > max ? `${text.slice(0, max)}…` : text)
}

/** 两个目录是否同一个：Windows 大小写不敏感；解析失败就按原串比较。 */
export function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  try {
    const a = resolvePath(left)
    const b = resolvePath(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return left === right
  }
}

// team 后端用到的 agentTeams 成员 API。rc.3 起平台把这组方法整体移除（只剩 state/transact
// 与团队任务板），调用会报 is not a function；这里按服务方法探测，给出可读错误。
const TEAM_METHODS = ['spawnTeammate', 'sendMessage', 'interrupt', 'listMembers']

export function missingTeamMethods(agentTeams) {
  const source = agentTeams ?? {}
  return TEAM_METHODS.filter(name => typeof source[name] !== 'function')
}

export function teamUnavailableMessage(missing) {
  return `team 后端不可用：当前平台缺少 agentTeams.${missing.join('/')}`
    + '（rc.3 起平台移除了 agentTeams 成员 API），请把 backend 改回 subagent'
}

export function createTeamDispatcher({ agentTeams, agent, getAgent, provider = 'spawn', retryDelaysMs = [1000, 2000, 4000], onWarn = noop, goalBridge }) {
  // 能力探测在构造时做一次：缺方法立即给可读错误，不留到每次派发时报 is not a function。
  const missing = missingTeamMethods(agentTeams)
  if (missing.length > 0) throw new Error(teamUnavailableMessage(missing))
  const currentAgent = () => getAgent === undefined ? agent : getAgent()
  const requireAgent = () => {
    const current = currentAgent()
    if (current === undefined) throw new Error('未找到协调者会话：请配置 coordinatorSession（协调者会话 id），并确保该会话已加载')
    return current
  }

  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, description, prompt, signal, readOnly, planFirst, taskId, goal }) {
      // team 后端没有按会话设只读的通道：明确拒绝，避免台账标只读、实际可写。
      if (readOnly === true) throw new Error('team 后端不支持只读任务：只读需要 subagent 后端，请把 backend 改回 subagent')
      // P8：计划模式同样依赖会话级沙箱 + 预设作用域的 planMode 服务，team 后端没有。
      if (planFirst === true) throw new Error('team 后端不支持计划模式：计划模式需要 subagent 后端，请把 backend 改回 subagent')
      // 真实 spawnTeammate 要求 provider（fresh 用 'spawn'）和 AbortSignal，缺一个都会被拒。
      const input = {
        name: name ?? slugify(String(prompt ?? '').slice(0, 20)),
        description: description ?? 'orchestrator task',
        prompt: [{ type: 'text', text: prompt }],
        context: 'fresh',
        provider,
        ...(signal === undefined ? {} : { signal }),
      }
      const result = await agentTeams.spawnTeammate(requireAgent(), input)
      const member = result.member
      if (goalBridge !== undefined && typeof goalBridge.attach === 'function' && typeof goal === 'string' && goal.trim() !== '') {
        void Promise.resolve(goalBridge.attach(taskId, member.id, goal)).catch(() => {})
      }
      return { id: member.id, name: member.name, sessionId: member.id, target: member.name }
    },
    async send(target, message, signal, targetDir, taskId, readOnly, objective) {
      const sent = await agentTeams.sendMessage(requireAgent(), {
        target,
        content: [{ type: 'text', text: message }],
        ...(signal === undefined ? {} : { signal }),
      })
      if (goalBridge !== undefined && typeof goalBridge.update === 'function' && typeof objective === 'string' && objective.trim() !== '') {
        void Promise.resolve(goalBridge.update(taskId, target, objective)).catch(() => {})
      }
      return sent
    },
    /** 续派消息：失败按 retryDelaysMs 重试；全部失败时抛出最后一次原因。 */
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective) {
      let lastError
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          return await this.send(target, message, signal, targetDir, taskId, readOnly, objective)
        } catch (error) {
          lastError = error
          if (attempt < retryDelaysMs.length) {
            onWarn(`续派第 ${attempt + 1} 次投递失败：${error?.message ?? error}`)
            await sleep(retryDelaysMs[attempt])
          }
        }
      }
      throw new Error(`投递失败：${lastError?.message ?? lastError}`)
    },
    async stop(target, taskId) {
      try {
        return agentTeams.interrupt(requireAgent(), target)
      } finally {
        if (goalBridge !== undefined && typeof goalBridge.clear === 'function') {
          void Promise.resolve(goalBridge.clear(taskId, target)).catch(() => {})
        }
      }
    },
    members() {
      return agentTeams.listMembers(requireAgent())
    },
  }
}

export function createSubagentDispatcher({ subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs = [1000, 2000, 4000], onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs = 5000, goalBridge }) {
  const currentAgent = () => getAgent === undefined ? agent : getAgent()
  const requireAgent = () => {
    const current = currentAgent()
    if (current === undefined) throw new Error('未找到协调者会话：请配置 coordinatorSession（协调者会话 id），并确保该会话已加载')
    return current
  }
  // rc.3 改名 listDescendants ; rc.1 是 listChildren。按服务方法探测，不按版本号猜。
  const listChildren = (parentId, signal) => typeof subagents.listDescendants === 'function'
    ? subagents.listDescendants(parentId, signal)
    : subagents.listChildren(parentId, signal)
  const parentSessionId = () => {
    const current = requireAgent()
    return current.session?.id ?? current.id
  }
  const live = new Map()
  // 只读子任务：派发时把 childId 记下来，agent/created 一到就设沙箱（压首回合窗口）。
  const readOnlyChildren = new Set()
  // P8 计划任务：同样在派发前登记，agent/created 一到就设只读 + 置 plan mode + 装 exit_plan_mode guard。
  const planChildren = new Set()
  // 子会话 agent 作用域 guard 的 disposer；按 childId 收口（任务终态/停止时释放，不留悬挂监听）。
  const planGuards = new Map()
  // planMode 服务缺失只 warn 一次/子会话（rc 包/预设没挂时每个任务都 warn 会刷日志）。
  const planModeWarned = new Set()
  // 已经成功置过 plan mode 的子会话：agent/created 与激活返回两条路都会调一次，靠它去重。
  const planApplied = new Set()
  // 服务按调用时惰性取：插件加载顺序不保证 agents/sessions/sandboxPolicy 已就绪。
  const serviceOf = value => typeof value === 'function' ? value() : value
  // 可写根授权按 targetId → (Session 对象 → (目录 → disposer)) 记：同一会话 resume 前后可能有多个会话对象，
  // 注册只追加不替换；终态/stop 按 targetId 全量释放，旧对象不残留、新对象也不会没人管。
  // 幂等 key 仍是 (Session 对象, 目录)：sandboxPolicy 内部按对象身份查 WeakMap，换对象就得重新注册。
  const writableRootGrants = new Map()
  const grantSessions = targetId => {
    let sessions = writableRootGrants.get(targetId)
    if (sessions === undefined) {
      sessions = new Map()
      writableRootGrants.set(targetId, sessions)
    }
    return sessions
  }
  const grantDirs = (targetId, session) => {
    const sessions = grantSessions(targetId)
    let dirs = sessions.get(session)
    if (dirs === undefined) {
      dirs = new Map()
      sessions.set(session, dirs)
    }
    return dirs
  }
  const childSessionOf = childId => {
    const childAgent = serviceOf(agents)?.get?.(childId)
    if (childAgent?.session !== undefined) return childAgent.session
    return serviceOf(sessions)?.get?.(childId)
  }
  // 只读模式：平台唯一写入口就是 session.append('sandbox/mode', { mode:'read-only' })
  // （导出的 setSandboxMode 只是它的薄包装）。只写目标 child session，不动全局默认与父会话。
  // 投影已有 read-only 时跳过：续派/重启 replay 都会保留，不需要重复 append。
  const ensureReadOnly = (childId, sessionHint) => {
    try {
      const session = sessionHint ?? childSessionOf(childId)
      if (session === undefined) return false
      const policy = serviceOf(sandboxPolicy)
      if (policy?.overrideOf?.(session) === 'read-only') return false
      if (typeof session.append !== 'function') return false
      session.append('sandbox/mode', { mode: 'read-only' })
      onEvent('subagent.read-only', { sessionId: childId, detail: { sessionId: session.id ?? childId } })
      return true
    } catch (error) {
      onWarn(`dsh-orchestrator: 设置只读沙箱失败：${errorText(error)}`)
      return false
    }
  }
  // agent/created 早于首个模型请求，能压掉「首回合还没设只读」的窗口。
  // P8：计划任务同一时机把 plan mode 置上并装 exit_plan_mode guard（都在 agent 作用域）。
  if (typeof onAgentCreated === 'function') {
    try {
      onAgentCreated(created => {
        if (created?.id === undefined) return
        const plan = planChildren.has(created.id)
        if (!plan && !readOnlyChildren.has(created.id)) return
        ensureReadOnly(created.id, created.session)
        if (!plan) return
        installExitPlanGuard(created.id, created)
        const applied = applyPlanMode(created.id, true, created)
        try {
          onEvent('subagent.plan-mode.entered', {
            sessionId: created.id,
            detail: { planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
          })
        } catch { /* 审计事件失败不能外溢 */ }
      })
    } catch (error) {
      onWarn(`dsh-orchestrator: 订阅 agent/created 失败：${errorText(error)}`)
    }
  }

  // P8：取子 agent。planMode 装在 worker 预设作用域，只能从 `agent.ctx.get('planMode')` 拿
  // （插件根作用域的 ctx.get 看不到预设作用域的服务）。
  const childAgentOf = (childId, hint) => hint ?? serviceOf(agents)?.get?.(childId)

  const planModeServiceOf = childAgent => {
    const ctx = childAgent?.ctx
    if (ctx === undefined) return undefined
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('planMode') : ctx.planMode
      return service ?? ctx.planMode
    } catch {
      return ctx.planMode
    }
  }

  /** 置/关 plan mode；服务缺失、agent 还没出现、调用失败都只降级（只读沙箱仍在）。 */
  const applyPlanMode = (childId, active, agentHint) => {
    if (active === true && planApplied.has(childId)) return { ok: true, outcome: 'noop', skipped: true }
    const childAgent = childAgentOf(childId, agentHint)
    if (childAgent === undefined) return { ok: false, reason: 'agent-missing' }
    const service = planModeServiceOf(childAgent)
    if (service === undefined || typeof service.set !== 'function') {
      if (!planModeWarned.has(childId)) {
        planModeWarned.add(childId)
        onWarn('dsh-orchestrator: planMode 服务不可用（平台未挂载或子会话预设作用域看不到），已降级为只有只读沙箱')
      }
      return { ok: false, reason: 'service-missing' }
    }
    try {
      const outcome = service.set(childAgent, active === true)
      if (active === true) planApplied.add(childId)
      else planApplied.delete(childId)
      return { ok: true, outcome }
    } catch (error) {
      onWarn(`dsh-orchestrator: 设置 plan mode 失败：${errorText(error)}`)
      return { ok: false, reason: errorText(error) }
    }
  }

  /**
   * P8：子会话的 exit_plan_mode 一律拒绝，并指向 task_report blocked 出口。
   * 必须注册在 agent 作用域（agent.ctx.tools.guard）：插件根的 ctx.tools.guard 是全局的，会误伤协调者。
   */
  const installExitPlanGuard = (childId, agentHint) => {
    if (planGuards.has(childId)) return true
    const childAgent = childAgentOf(childId, agentHint)
    const tools = childAgent?.ctx?.tools
    if (tools === undefined || typeof tools.guard !== 'function') return false
    try {
      const dispose = tools.guard(exec => {
        if (exec?.name !== 'exit_plan_mode') return undefined
        // agent 作用域本身已经限定；这里再挡一道，防止同一 ctx 被复用时的串扰。
        const caller = exec?.agent?.id ?? exec?.agent?.session?.id
        if (caller !== undefined && caller !== childId) return undefined
        return EXIT_PLAN_MODE_DENIAL
      })
      if (typeof dispose === 'function') planGuards.set(childId, dispose)
      return true
    } catch (error) {
      onWarn(`dsh-orchestrator: 安装 exit_plan_mode guard 失败：${errorText(error)}`)
      return false
    }
  }

  /** 计划期的 guard 收口：一段 activation 结束就释放，续派/冷恢复按 agent/created 重新装。 */
  const releasePlanGuard = childId => {
    const dispose = planGuards.get(childId)
    if (dispose === undefined) return
    planGuards.delete(childId)
    try {
      dispose()
    } catch (error) {
      onWarn(`dsh-orchestrator: 释放 exit_plan_mode guard 失败：${errorText(error)}`)
    }
  }

  /** 任务终态/停止：guard + 计划登记一起收口（不再在后续 agent/created 里重新进入计划模式）。 */
  const releasePlan = childId => {
    planChildren.delete(childId)
    planModeWarned.delete(childId)
    planApplied.delete(childId)
    releasePlanGuard(childId)
  }
  // 激活返回时子 Session 可能还没进表：等一次 session/created 再设只读，不阻塞派发。
  const ensureReadOnlyReady = childId => {
    if (childSessionOf(childId) !== undefined || typeof onSessionCreated !== 'function') {
      ensureReadOnly(childId)
      return
    }
    void resolveChildSession(childId).then(session => {
      if (session === undefined) {
        onWarn(`dsh-orchestrator: 未拿到子会话 ${childId}，只读沙箱未设置`)
        return
      }
      ensureReadOnly(childId, session)
    }).catch(error => onWarn(`dsh-orchestrator: 设置只读沙箱失败：${errorText(error)}`))
  }
  // activation 返回时子 Session 可能还没进会话表：挂一次 session/created 等同一个 childId；
  // 超时只 warn、不重试，也不阻塞派发。判同只看 id，不看 header.cwd（那正是坏的字段）。
  const resolveChildSession = childId => {
    const found = childSessionOf(childId)
    if (found !== undefined) return Promise.resolve(found)
    if (typeof onSessionCreated !== 'function') return Promise.resolve(undefined)
    return new Promise(resolveChild => {
      let done = false
      let unsubscribe
      let timer
      const finish = session => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { unsubscribe?.() } catch { /* 取消订阅失败不影响结果 */ }
        resolveChild(session)
      }
      timer = setTimeout(() => finish(undefined), sessionWaitMs)
      try {
        unsubscribe = onSessionCreated(event => {
          if (event?.id !== childId) return
          finish(childSessionOf(childId) ?? event)
        })
      } catch {
        finish(undefined)
      }
    })
  }
  /** 释放某个 targetId 名下**所有** Session 对象的全部可写根（含 resume 前后的多个对象）。 */
  const releaseWritableRoot = targetId => {
    const sessions = writableRootGrants.get(targetId)
    if (sessions === undefined) return
    writableRootGrants.delete(targetId)
    for (const dirs of sessions.values()) {
      for (const disposer of dirs.values()) {
        try {
          disposer()
        } catch (error) {
          onWarn(`dsh-orchestrator: 释放 target 可写根失败：${errorText(error)}`)
        }
      }
    }
  }
  // rc.3 平台缺陷：子会话 header.cwd 取父会话目录（childSessionMeta），spec.cwd 只记一条 working-directory 事件，
  // 而 sandboxPolicy 的 workspaceRoot 只读 session.header.cwd → workspace-write 下子会话写不进 target。
  // 兜法：给子会话登记 target 为可写根（幂等）。注意 Windows 上只对 harness 文件工具生效，pwsh 进程写仍会被拒。
  // wait=true 只用于派发（子 Session 可能晚几毫秒进表）；续派走非等待解析，避免冷恢复时干等超时。
  const ensureWritableRoot = async (childId, target, { wait = false, warnOnMiss = true } = {}) => {
    if (typeof target !== 'string' || target === '') return
    const policy = serviceOf(sandboxPolicy)
    if (policy === undefined || typeof policy.registerWritableRoot !== 'function') return
    const session = wait ? await resolveChildSession(childId) : childSessionOf(childId)
    if (session === undefined) {
      if (warnOnMiss) onWarn(`dsh-orchestrator: 未拿到子会话 ${childId}，未登记 target 可写根`)
      return
    }
    // 平台根已经是 target 时不用授权；同一个 (session 对象, 目录) 只注册一次。
    if (sameDirectory(target, session.header?.cwd)) return
    const dirs = grantDirs(childId, session)
    if (dirs.has(target)) return
    try {
      const disposer = policy.registerWritableRoot(session, target)
      if (typeof disposer === 'function') dirs.set(target, disposer)
      // 审计/对表用：sessionId + directory 都带上，能直接和 task_message 投递时间对齐。
      onEvent('subagent.writable-root', { sessionId: childId, detail: { directory: target } })
    } catch (error) {
      onWarn(`dsh-orchestrator: 登记 target 可写根失败：${errorText(error)}`)
    }
  }

  // delivery: 'caller' 时没人 await 会变成未处理拒绝，这里必须挂上；同时把 settle 抛给上层驱动队列。
  // 回调里的异常（日志/事件消费方抛错）也不能变成宿主层面的未处理拒绝。
  // 注意：settle 只是这一轮结束（continuable 会话还会续派），**不释放**可写根；释放留给 stop/终态清理。
  const track = activation => {
    live.set(activation.childId, activation)
    activation.result.then(
      result => {
        try {
          live.delete(activation.childId)
          readOnlyChildren.delete(activation.childId)
          releasePlanGuard(activation.childId)
          onEvent('subagent.settled', {
            taskId: activation.taskId,
            sessionId: activation.childId,
            detail: { stopReason: result?.stopReason ?? null, output: settleOutput(result?.output) },
            // 非日志字段（logger 只取 detail）：完整返回消息交给结算上报器持久化（B1），
            // 超 64KB 由结算侧写 reports 文件，日志里仍只留 240 字摘要。
            lastMessage: messageText(result?.output),
          })
        } catch { /* 结算事件失败不能外溢 */ }
      },
      error => {
        try {
          live.delete(activation.childId)
          readOnlyChildren.delete(activation.childId)
          releasePlanGuard(activation.childId)
          onEvent('subagent.failed', {
            taskId: activation.taskId,
            sessionId: activation.childId,
            detail: { error: errorText(error) },
          })
        } catch { /* 结算事件失败不能外溢 */ }
      },
    ).catch(() => {})
    return activation
  }

  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, label, prompt, signal, taskId, cwd, readOnly, planFirst, goal }) {
      const parent = requireAgent()
      // agent 已创建但 session 还没挂上时，平台 startActivation 会在 parent.session 上取 .id 抛 TypeError；
      // 这里先给可读错误，并由 queue 当成可重试（等会话就绪）。
      if (parent?.session === undefined || parent.session === null) {
        throw new Error('协调者会话尚未就绪（agent.session 为空），稍后重试')
      }
      if (parent.id === undefined) throw new Error('协调者会话缺少 id，稍后重试')
      const childId = randomUUID()
      // 只读任务：在开始创建前记下 childId，agent/created 时立刻设沙箱；激活返回后再补一次幂等设置。
      if (readOnly === true) readOnlyChildren.add(childId)
      // P8 计划任务：同一机制（只读沙箱是硬拦），另外在 agent 作用域置 plan mode + 装 exit guard。
      if (planFirst === true) planChildren.add(childId)
      // 目标目录优先；没给就沿用父会话 cwd（保持旧行为）。
      const baseCwd = cwd ?? parent.session?.header?.cwd
      const activationPrompt = [{ type: 'text', text: String(prompt ?? '') }]
      // 子会话显式用 worker 预设，绕开 composeFrom 继承协调者的 preset restrict（探针 §1）。
      // 只有 spawn provider 支持 agentPreset；fork 没有该能力，带上去会被平台拒绝（UNSUPPORTED_CAPABILITY）。
      const agentPreset = provider === 'spawn' ? { agentPreset: workerPreset ?? 'dsh-orchestrator-worker' } : {}
      const location = baseCwd === undefined ? {} : { cwd: baseCwd }
      const base = {
        provider,
        label: label ?? name ?? slugify(String(prompt ?? '').slice(0, 20)),
        delivery: 'caller',
        signal: signal ?? new AbortController().signal,
        childId,
      }
      // DSH 0.2.2-rc.3（当前桌面）的 startActivation 是扁平 spec：spec.parent/spec.prompt/…
      const spec = { ...base, parent, prompt: activationPrompt, ...agentPreset, ...location }
      // rc.1 及更早：旧平台读 spec.request.*，扁平字段会被忽略。
      const legacySpec = {
        ...base,
        request: { parent, prompt: activationPrompt, ...agentPreset, ...location },
      }
      const shapeError = error => /reading '(parent|request)'|spec\.(parent|request)|request\.parent/.test(error?.message ?? '')
      let activation
      onEvent('subagent.spawn.requested', { taskId, detail: { childId, label: spec.label, provider } })
      try {
        try {
          activation = await subagents.startActivation(spec)
        } catch (error) {
          if (!shapeError(error)) throw error
          // 升级前的旧安装：扁平 spec 读不到 request.parent，回退一次旧包装。
          onEvent('subagent.spawn.legacy-spec', { taskId, detail: { childId, error: error?.message ?? String(error) } })
          activation = await subagents.startActivation(legacySpec)
        }
      } catch (error) {
        // 两次都失败：清掉只读/计划登记，别攒废弃 UUID。
        readOnlyChildren.delete(childId)
        planChildren.delete(childId)
        throw error
      }
      onEvent('subagent.spawn.accepted', {
        taskId,
        sessionId: activation.childId,
        detail: { childId: activation.childId, messageId: activation.messageId ?? null, provider },
      })
      // 结算事件带上 taskId：台账按任务精确回写，不依赖 session_id 反查。
      activation.taskId = taskId
      track(activation)
      if (readOnly === true) ensureReadOnlyReady(activation.childId)
      // P8：计划任务也走只读沙箱；plan mode 与 guard 尽量在激活返回时就装上，
      // agent 还没进表时由 agent/created 那条路补（不阻塞派发）。
      if (planFirst === true) {
        ensureReadOnlyReady(activation.childId)
        installExitPlanGuard(activation.childId)
        const applied = applyPlanMode(activation.childId, true)
        onEvent('subagent.plan-mode.entered', {
          sessionId: activation.childId,
          detail: { planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
        })
      }
      // 目标目录才需要补可写根；只读任务绝不能注册可写根（否则「只读」有后门）。
      // 计划任务同理：批准前不注册，批准后的续派由 send() 按 readOnly=false 补。
      if (readOnly !== true && planFirst !== true && typeof cwd === 'string' && cwd !== '') {
        void ensureWritableRoot(activation.childId, cwd, { wait: true }).catch(error => {
          onWarn(`dsh-orchestrator: 登记 target 可写根失败：${errorText(error)}`)
        })
      }
      // G1：子会话起来后声明式建 goal（create + disarm，不驱动续轮）。
      // 不 await：goal 服务不可用/子 agent 晚出现都不能拖慢派发；桥内部吞错。
      if (goalBridge !== undefined && typeof goalBridge.attach === 'function' && typeof goal === 'string' && goal.trim() !== '') {
        void Promise.resolve(goalBridge.attach(taskId, activation.childId, goal)).catch(error => {
          onWarn(`dsh-orchestrator: 创建子会话目标失败：${errorText(error)}`)
        })
      }
      return { id: activation.childId, name: spec.label, sessionId: activation.childId, target: activation.childId }
    },
    async send(target, message, signal, targetDir, taskId, readOnly, objective) {
      const sent = await subagents.sendMessage(requireAgent(), target, [{ type: 'text', text: message }], {
        signal: signal ?? new AbortController().signal,
      })
      // 投递成功先记事件（代码顺序：投递 → 注册），日志时间序可自证「注册在投递之后」。
      try {
        onEvent('task.message.sent', { taskId, sessionId: target, detail: { targetDir: targetDir ?? null } })
      } catch { /* 审计事件失败不能外溢 */ }
      // 只读任务续派：resume 后按同一会话日志仍应保留 read-only；这里幂等补一次（已有则跳过）。
      if (readOnly === true) ensureReadOnly(target)
      // 冷恢复/续派时子会话在发送前还取不到，sendMessage 之后才 resolve 出**新的 Session 对象**；
      // 投递成功后再幂等补注册（失败路径不注册；失败只 warn，不影响投递结果）。
      if (readOnly !== true) {
        try {
          await ensureWritableRoot(target, targetDir)
        } catch (error) {
          onWarn(`dsh-orchestrator: 续派后补注册可写根失败：${errorText(error)}`)
        }
      }
      // G1：续派后目标文本可能变化 → edit（桥内部比较文本；agent 冷恢复晚出现时等一会儿）。
      if (goalBridge !== undefined && typeof goalBridge.update === 'function' && typeof objective === 'string' && objective.trim() !== '') {
        void Promise.resolve(goalBridge.update(taskId, target, objective)).catch(error => {
          onWarn(`dsh-orchestrator: 更新子会话目标失败：${errorText(error)}`)
        })
      }
      return sent
    },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly, objective) {
      let lastError
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          return await this.send(target, message, signal, targetDir, taskId, readOnly, objective)
        } catch (error) {
          lastError = error
          if (attempt < retryDelaysMs.length) {
            onWarn(`续派第 ${attempt + 1} 次投递失败：${error?.message ?? error}`)
            await sleep(retryDelaysMs[attempt])
          }
        }
      }
      throw new Error(`投递失败：${lastError?.message ?? lastError}`)
    },
    /**
     * P8：用户批准计划后的恢复执行。沙箱切回 workspace-write（与 ensureReadOnly 同一入口、同一事件形状），
     * 关 plan mode，并释放 exit_plan_mode guard（批准后不再需要）。
     * 只由 tools.js / panel-actions.js 在「投递成功且任务回到 running」之后调用。
     */
    async approvePlan(target, targetDir) {
      const session = childSessionOf(target)
      let sandbox = 'missing'
      if (session !== undefined) {
        try {
          if (typeof session.append === 'function') {
            session.append('sandbox/mode', { mode: 'workspace-write' })
            sandbox = 'workspace-write'
            onEvent('subagent.sandbox.resumed', { sessionId: target, detail: { mode: 'workspace-write' } })
          }
        } catch (error) {
          onWarn(`dsh-orchestrator: 计划批准后切换沙箱失败：${errorText(error)}`)
        }
      }
      // rc.3 子会话 header.cwd 是父会话目录：批准后补 target 可写根（派发时计划任务跳过注册）。
      if (sandbox === 'workspace-write' && typeof targetDir === 'string' && targetDir !== '') {
        try {
          await ensureWritableRoot(target, targetDir)
        } catch (error) {
          onWarn(`dsh-orchestrator: 计划批准后登记可写根失败：${errorText(error)}`)
        }
      }
      const applied = applyPlanMode(target, false)
      releasePlan(target)
      onEvent('subagent.plan-mode.approved', {
        sessionId: target,
        detail: { sandbox, planMode: applied.outcome ?? null, reason: applied.ok === true ? null : (applied.reason ?? null) },
      })
      if (sandbox !== 'workspace-write') {
        return {
          ok: false,
          reason: session === undefined ? `未拿到子会话 ${target}` : '沙箱模式写入失败（会话没有 append）',
          sandbox,
          planMode: applied.outcome ?? null,
        }
      }
      return { ok: true, sandbox, planMode: applied.outcome ?? null }
    },
    /** 有本地 activation 直接 dispose（提前取消）；没有（重启后）走 interrupt。两种都释放可写根。 */
    async stop(target, taskId) {
      try {
        const activation = live.get(target)
        if (activation !== undefined) {
          await activation.dispose()
          live.delete(target)
          return
        }
        // rc.3：interrupt(targetSessionId, authority)，authority 只认 { kind: 'ancestor' | 'user' }。
        // task_stop 是用户动作，按平台 interruptByUser 的写法传 { kind: 'user' }；裸 agent 不在契约里。
        // rc.1：interruptByParent(childId, parentSessionId, mode)。
        if (typeof subagents.interrupt === 'function') return subagents.interrupt(target, { kind: 'user' })
        return subagents.interruptByParent(target, parentSessionId(), 'continuable')
      } finally {
        releaseWritableRoot(target)
        releasePlan(target)
        // G1：停止 = 放弃该目标，清掉平台 goal（不留下「active」误导后续续派/面板）。
        if (goalBridge !== undefined && typeof goalBridge.clear === 'function') {
          void Promise.resolve(goalBridge.clear(taskId, target)).catch(error => {
            onWarn(`dsh-orchestrator: 清除子会话目标失败：${errorText(error)}`)
          })
        }
      }
    },
    /** 任务进入终态（done/cancelled/orphaned/failed）时由上层调用，释放该会话的可写根。 */
    releaseWritableRoots(target) {
      releaseWritableRoot(target)
      releasePlan(target)
    },
    members() {
      return listChildren(parentSessionId()).catch(error => {
        onWarn(`子会话目录读取失败：${errorText(error)}`)
        return []
      })
    },
    catalog() {
      return listChildren(parentSessionId())
    },
    has(target) {
      return live.has(target)
    },
  }
}

// 后端不可用时的占位派发器：派发类调用返回可读错误，目录类查询降级为空（不打断面板/孤儿巡检）。
function createUnavailableDispatcher(reason) {
  const fail = () => { throw new Error(reason) }
  return {
    slug(title) {
      return slugify(title)
    },
    async spawn() { fail() },
    async send() { fail() },
    async sendReliable() { fail() },
    async stop() { fail() },
    // P8：计划批准在无后端时也只能返回可读失败，不能让工具层抛未处理拒绝。
    async approvePlan() { return { ok: false, reason } },
    async members() { return [] },
    // catalog 只有 reconcile 一个调用点：必须抛错让对账走「目录不可用 → known=undefined」分支。
    // 返回 [] 会被当成「目录为空」，把所有 running/waiting 任务误标 orphaned。
    async catalog() { fail() },
    has() { return false },
    releaseWritableRoots() {},
  }
}

export function createDispatcher({ backend = 'subagent', agentTeams, subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs, onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs, goalBridge }) {
  if (backend === 'team') {
    // agentTeams 用惰性 getter 传进来时在这里解析：缺服务的 profile 只有选 team 后端才会报错。
    const teams = typeof agentTeams === 'function' ? agentTeams() : agentTeams
    try {
      return createTeamDispatcher({ agentTeams: teams, agent, getAgent, provider, retryDelaysMs, onWarn, goalBridge })
    } catch (error) {
      // 平台升级把 team 后端废了：插件照常加载（面板与其他能力可用），
      // 派发时给同一条可读错误，而不是插件加载失败或抛 is not a function。
      const reason = error?.message ?? String(error)
      onWarn(`dsh-orchestrator: ${reason}`)
      return createUnavailableDispatcher(reason)
    }
  }
  return createSubagentDispatcher({ subagents, agent, getAgent, provider, workerPreset, retryDelaysMs, onWarn, onEvent, agents, sessions, sandboxPolicy, onSessionCreated, onAgentCreated, sessionWaitMs, goalBridge })
}
