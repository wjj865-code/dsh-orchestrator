// 把 agentTeams 的能力收成一个窄接口：本插件只做派活、追加消息、停止。
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

export function createDispatcher({ agentTeams, agent, getAgent, provider = 'spawn', retryDelaysMs = [1000, 2000, 4000], onWarn = () => {} }) {
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
        name: name ?? slugify(prompt.slice(0, 20)),
        description: description ?? 'orchestrator task',
        prompt: [{ type: 'text', text: prompt }],
        context: 'fresh',
        provider,
        ...(signal === undefined ? {} : { signal }),
      }
      const result = await agentTeams.spawnTeammate(requireAgent(), input)
      return result.member
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
