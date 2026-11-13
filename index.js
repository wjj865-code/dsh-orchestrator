// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './src/config.js'
import { openLedger, addNotification } from './src/ledger.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agentTeams', 'agents']

// 协调者只做协调：这些是设计 §10 明令禁止或属于别人职责的工具。
const COORDINATOR_DENY = [
  'read', 'write', 'edit', 'glob', 'grep',
  'bash', 'pwsh', 'web_search', 'web_fetch', 'read_browser',
  'present', 'plugin_manager', 'skill',
  'job_list', 'job_output', 'job_kill',
  'schedule_create', 'schedule_edit', 'schedule_list',
  'request_secret', 'request_connector',
  'list_bots', 'message_bot', 'post_to_group',
  'create_bot', 'create_group', 'delete_group', 'update_group', 'update_bot',
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'task_report',
]

const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')

export async function apply(ctx, rawConfig = {}) {
  const config = loadConfig(rawConfig)
  const db = await openLedger(stateDir())
  const warnings = message => ctx.logger?.warn?.(message)
  const restrictionDisposers = []

  const resolveCoordinator = () => {
    if (config.coordinatorSession === undefined) return undefined
    return ctx.get?.('agents')?.get?.(config.coordinatorSession)
  }

  const restrictCoordinator = agent => {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function' || typeof tools.view !== 'function') return false
    let known
    try {
      known = tools.view(agent)?.knownNames
    } catch {
      return false
    }
    if (!(known instanceof Set)) return false
    const deny = COORDINATOR_DENY.filter(toolName => known.has(toolName))
    if (deny.length === 0) return false
    try {
      const dispose = tools.restrict({ deny })
      if (typeof dispose === 'function') restrictionDisposers.push(dispose)
      return true
    } catch (error) {
      warnings(`dsh-orchestrator: 协调者工具白名单安装失败：${error?.message ?? error}`)
      return false
    }
  }

  const current = resolveCoordinator()
  if (current === undefined) {
    warnings('dsh-orchestrator: 未配置或找不到 coordinatorSession，派活会在调用时给出可读错误')
  } else {
    restrictCoordinator(current)
  }
  ctx.on?.('agent/created', ({ agent }) => {
    if (agent !== undefined && agent.id === config.coordinatorSession) restrictCoordinator(agent)
  })

  const dispatcher = createDispatcher({
    agentTeams: ctx.agentTeams,
    getAgent: resolveCoordinator,
    onWarn: warnings,
  })

  const notifier = createNotifier({
    mergeWindowMs: config.mergeWindowMs,
    onWarn: warnings,
    record: entry => addNotification(db, entry),
    send: async (text, items) => {
      if (config.coordinatorSession === undefined) {
        warnings('dsh-orchestrator: 未配置 coordinatorSession，通知不投递')
        return
      }
      // 协调者不能给自己发消息（TEAM_SELF_MESSAGE）；由正在回报的子任务 agent 发给 lead。
      const sender = items.map(item => item.sender).find(value => value !== undefined)
      if (sender === undefined) {
        warnings('dsh-orchestrator: 通知缺少发送方 agent，已跳过投递')
        return
      }
      const membership = ctx.agentTeams.membership?.(sender)
      if (membership !== undefined && membership.root?.id !== config.coordinatorSession) {
        warnings(`dsh-orchestrator: 回报方不属于协调者团队（${String(sender.id)}），已跳过投递`)
        return
      }
      await ctx.agentTeams.sendMessage(sender, { target: 'lead', content: [{ type: 'text', text }] })
    },
  })

  const toolDisposers = createTools({ db, dispatcher, notifier, config })
    .map(tool => ctx.tools.register(tool))

  ctx.effect?.(() => () => {
    for (const dispose of [...restrictionDisposers, ...toolDisposers].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    void notifier.drain()
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
