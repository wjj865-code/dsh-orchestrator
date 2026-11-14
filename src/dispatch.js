// 派发层：把「建子会话 / 投递 / 停止」收成一个窄接口。
// 后端二选一：subagent（默认，直连 ctx.subagents）或 team（旧的 agentTeams 名册）。
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

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

export function createTeamDispatcher({ agentTeams, agent, getAgent, provider = 'spawn', retryDelaysMs = [1000, 2000, 4000], onWarn = noop }) {
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
    async spawn({ name, description, prompt, signal }) {
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
      return { id: member.id, name: member.name, sessionId: member.id, target: member.name }
    },
    async send(target, message, signal) {
      return agentTeams.sendMessage(requireAgent(), {
        target,
        content: [{ type: 'text', text: message }],
        ...(signal === undefined ? {} : { signal }),
      })
    },
    /** 续派消息：失败按 retryDelaysMs 重试；全部失败时抛出最后一次原因。 */
    async sendReliable(target, message, signal) {
      let lastError
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          return await this.send(target, message, signal)
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
    async stop(target) {
      return agentTeams.interrupt(requireAgent(), target)
    },
    members() {
      return agentTeams.listMembers(requireAgent())
    },
  }
}

export function createSubagentDispatcher({ subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs = [1000, 2000, 4000], onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, sessionWaitMs = 5000 }) {
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
          onEvent('subagent.settled', {
            sessionId: activation.childId,
            detail: { stopReason: result?.stopReason ?? null },
          })
        } catch { /* 结算事件失败不能外溢 */ }
      },
      error => {
        try {
          live.delete(activation.childId)
          onEvent('subagent.failed', { sessionId: activation.childId, detail: { error: errorText(error) } })
        } catch { /* 结算事件失败不能外溢 */ }
      },
    ).catch(() => {})
    return activation
  }

  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, label, prompt, signal, taskId, cwd }) {
      const parent = requireAgent()
      // agent 已创建但 session 还没挂上时，平台 startActivation 会在 parent.session 上取 .id 抛 TypeError；
      // 这里先给可读错误，并由 queue 当成可重试（等会话就绪）。
      if (parent?.session === undefined || parent.session === null) {
        throw new Error('协调者会话尚未就绪（agent.session 为空），稍后重试')
      }
      if (parent.id === undefined) throw new Error('协调者会话缺少 id，稍后重试')
      const childId = randomUUID()
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
        activation = await subagents.startActivation(spec)
      } catch (error) {
        if (!shapeError(error)) throw error
        // 升级前的旧安装：扁平 spec 读不到 request.parent，回退一次旧包装。
        onEvent('subagent.spawn.legacy-spec', { taskId, detail: { childId, error: error?.message ?? String(error) } })
        activation = await subagents.startActivation(legacySpec)
      }
      onEvent('subagent.spawn.accepted', {
        taskId,
        sessionId: activation.childId,
        detail: { childId: activation.childId, messageId: activation.messageId ?? null, provider },
      })
      track(activation)
      // 目标目录才需要补可写根（没给 cwd 时 cwd 就是父会话目录，平台根本来就能写）。
      if (typeof cwd === 'string' && cwd !== '') {
        void ensureWritableRoot(activation.childId, cwd, { wait: true }).catch(error => {
          onWarn(`dsh-orchestrator: 登记 target 可写根失败：${errorText(error)}`)
        })
      }
      return { id: activation.childId, name: spec.label, sessionId: activation.childId, target: activation.childId }
    },
    async send(target, message, signal, targetDir, taskId) {
      const sent = await subagents.sendMessage(requireAgent(), target, [{ type: 'text', text: message }], {
        signal: signal ?? new AbortController().signal,
      })
      // 投递成功先记事件（代码顺序：投递 → 注册），日志时间序可自证「注册在投递之后」。
      try {
        onEvent('task.message.sent', { taskId, sessionId: target, detail: { targetDir: targetDir ?? null } })
      } catch { /* 审计事件失败不能外溢 */ }
      // 冷恢复/续派时子会话在发送前还取不到，sendMessage 之后才 resolve 出**新的 Session 对象**；
      // 投递成功后再幂等补注册（失败路径不注册；失败只 warn，不影响投递结果）。
      try {
        await ensureWritableRoot(target, targetDir)
      } catch (error) {
        onWarn(`dsh-orchestrator: 续派后补注册可写根失败：${errorText(error)}`)
      }
      return sent
    },
    async sendReliable(target, message, signal, targetDir, taskId) {
      let lastError
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        try {
          return await this.send(target, message, signal, targetDir, taskId)
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
    /** 有本地 activation 直接 dispose（提前取消）；没有（重启后）走 interrupt。两种都释放可写根。 */
    async stop(target) {
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
      }
    },
    /** 任务进入终态（done/cancelled/orphaned/failed）时由上层调用，释放该会话的可写根。 */
    releaseWritableRoots(target) {
      releaseWritableRoot(target)
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
    async members() { return [] },
    // catalog 只有 reconcile 一个调用点：必须抛错让对账走「目录不可用 → known=undefined」分支。
    // 返回 [] 会被当成「目录为空」，把所有 running/waiting 任务误标 orphaned。
    async catalog() { fail() },
    has() { return false },
    releaseWritableRoots() {},
  }
}

export function createDispatcher({ backend = 'subagent', agentTeams, subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs, onWarn = noop, onEvent = noop, agents, sessions, sandboxPolicy, onSessionCreated, sessionWaitMs }) {
  if (backend === 'team') {
    try {
      return createTeamDispatcher({ agentTeams, agent, getAgent, provider, retryDelaysMs, onWarn })
    } catch (error) {
      // 平台升级把 team 后端废了：插件照常加载（面板与其他能力可用），
      // 派发时给同一条可读错误，而不是插件加载失败或抛 is not a function。
      const reason = error?.message ?? String(error)
      onWarn(`dsh-orchestrator: ${reason}`)
      return createUnavailableDispatcher(reason)
    }
  }
  return createSubagentDispatcher({ subagents, agent, getAgent, provider, workerPreset, retryDelaysMs, onWarn, onEvent, agents, sessions, sandboxPolicy, onSessionCreated, sessionWaitMs })
}
