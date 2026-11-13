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

export function createTeamDispatcher({ agentTeams, agent, getAgent, provider = 'spawn', retryDelaysMs = [1000, 2000, 4000], onWarn = noop }) {
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

export function createSubagentDispatcher({ subagents, agent, getAgent, provider = 'spawn', retryDelaysMs = [1000, 2000, 4000], onWarn = noop, onEvent = noop }) {
  const currentAgent = () => getAgent === undefined ? agent : getAgent()
  const requireAgent = () => {
    const current = currentAgent()
    if (current === undefined) throw new Error('未找到协调者会话：请配置 coordinatorSession（协调者会话 id），并确保该会话已加载')
    return current
  }
  const parentSessionId = () => {
    const current = requireAgent()
    return current.session?.id ?? current.id
  }
  const live = new Map()

  // delivery: 'caller' 时没人 await 会变成未处理拒绝，这里必须挂上；同时把 settle 抛给上层驱动队列。
  const track = activation => {
    live.set(activation.childId, activation)
    activation.result.then(
      result => {
        live.delete(activation.childId)
        onEvent('subagent.settled', {
          sessionId: activation.childId,
          detail: { stopReason: result?.stopReason ?? null },
        })
      },
      error => {
        live.delete(activation.childId)
        onEvent('subagent.failed', { sessionId: activation.childId, detail: { error: errorText(error) } })
      },
    )
    return activation
  }

  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, label, prompt, signal, taskId }) {
      const parent = requireAgent()
      const childId = randomUUID()
      const cwd = parent.session?.header?.cwd
      const spec = {
        provider,
        label: label ?? name ?? slugify(String(prompt ?? '').slice(0, 20)),
        delivery: 'caller',
        signal: signal ?? new AbortController().signal,
        childId,
        request: {
          parent,
          prompt: [{ type: 'text', text: String(prompt ?? '') }],
          ...(cwd === undefined ? {} : { cwd }),
        },
      }
      let activation
      try {
        activation = await subagents.startActivation(spec)
      } catch (error) {
        onEvent('subagent.spawn.requested', { taskId, detail: { childId, label: spec.label, provider } })
        throw error
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
    /** 有本地 activation 直接 dispose（提前取消）；没有（重启后）走 interruptByParent，mode 唯一合法值。 */
    async stop(target) {
      const activation = live.get(target)
      if (activation !== undefined) {
        await activation.dispose()
        live.delete(target)
        return
      }
      return subagents.interruptByParent(target, parentSessionId(), 'continuable')
    },
    members() {
      return subagents.listChildren(parentSessionId()).catch(error => {
        onWarn(`子会话目录读取失败：${errorText(error)}`)
        return []
      })
    },
    catalog() {
      return subagents.listChildren(parentSessionId())
    },
    has(target) {
      return live.has(target)
    },
  }
}

export function createDispatcher({ backend = 'subagent', agentTeams, subagents, agent, getAgent, provider = 'spawn', retryDelaysMs, onWarn = noop, onEvent = noop }) {
  if (backend === 'team') {
    return createTeamDispatcher({ agentTeams, agent, getAgent, provider, retryDelaysMs, onWarn })
  }
  return createSubagentDispatcher({ subagents, agent, getAgent, provider, retryDelaysMs, onWarn, onEvent })
}
