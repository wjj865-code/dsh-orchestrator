// 派发层：把「建子会话 / 投递 / 停止」收成一个窄接口。
// 后端二选一：subagent（默认，直连 ctx.subagents）或 team（旧的 agentTeams 名册）。
import { randomUUID } from 'node:crypto'

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

export function createSubagentDispatcher({ subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs = [1000, 2000, 4000], onWarn = noop, onEvent = noop }) {
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

  // delivery: 'caller' 时没人 await 会变成未处理拒绝，这里必须挂上；同时把 settle 抛给上层驱动队列。
  // 回调里的异常（日志/事件消费方抛错）也不能变成宿主层面的未处理拒绝。
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
      return { id: activation.childId, name: spec.label, sessionId: activation.childId, target: activation.childId }
    },
    async send(target, message, signal) {
      return subagents.sendMessage(requireAgent(), target, [{ type: 'text', text: message }], {
        signal: signal ?? new AbortController().signal,
      })
    },
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
    /** 有本地 activation 直接 dispose（提前取消）；没有（重启后）走 interrupt。 */
    async stop(target) {
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
    async catalog() { return [] },
    has() { return false },
  }
}

export function createDispatcher({ backend = 'subagent', agentTeams, subagents, agent, getAgent, provider = 'spawn', workerPreset, retryDelaysMs, onWarn = noop, onEvent = noop }) {
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
  return createSubagentDispatcher({ subagents, agent, getAgent, provider, workerPreset, retryDelaysMs, onWarn, onEvent })
}
