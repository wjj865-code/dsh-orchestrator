// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './src/config.js'
import { openLedger, addNotification, getSetting, bindSettingOnce, rebindSetting } from './src/ledger.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'
import { injectNotification } from './src/inject.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agentTeams', 'agents']

const COORDINATOR_KEY = 'coordinator_session_id'
const COORDINATOR_INVALID_HINT = '协调者会话已失效，可用配置覆盖或在新会话里派任务重新绑定。'

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
  const restrictedAgents = new WeakSet()

  const resolvedCoordinatorId = () => config.coordinatorSession ?? getSetting(db, COORDINATOR_KEY)
  const resolveCoordinator = () => {
    const id = resolvedCoordinatorId()
    return id === undefined ? undefined : ctx.get?.('agents')?.get?.(id)
  }
  const coordinatorStatus = () => {
    const id = resolvedCoordinatorId()
    return { id, live: id !== undefined && resolveCoordinator() !== undefined }
  }

  const restrictCoordinator = agent => {
    if (agent === undefined || restrictedAgents.has(agent)) return agent !== undefined
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function' || typeof tools.view !== 'function') return false
    let known
    try {
      const view = tools.view(agent)
      // restrict() 只接受全局工具名；view(agent) 收的是 agent 作用域对象（不是 session id）。
      known = view?.restrictableNames ?? view?.knownNames
    } catch {
      return false
    }
    if (!(known instanceof Set)) return false
    const deny = COORDINATOR_DENY.filter(toolName => known.has(toolName))
    if (deny.length === 0) return false
    try {
      const dispose = tools.restrict({ deny })
      if (typeof dispose === 'function') restrictionDisposers.push(dispose)
      restrictedAgents.add(agent)
      return true
    } catch (error) {
      warnings(`dsh-orchestrator: 协调者工具白名单安装失败：${error?.message ?? error}`)
      return false
    }
  }

  // 只有 root/lead 会话能绑定或重绑；子会话调用 task_create 不能把自己绑成协调者。
  const isRootOrLead = agent => {
    if (agent === undefined) return false
    const header = agent?.session?.header
    if (header !== undefined) return header.parentSession === undefined
    try {
      const role = ctx.agentTeams?.membership?.(agent)?.role
      if (role !== undefined) return role === 'lead'
    } catch {
      return false
    }
    return true
  }

  // 配置覆盖优先且不写台账；否则惰性绑定调用方会话。首绑走原子 upsert，失效重绑走 CAS。
  const bindCoordinator = agent => {
    if (config.coordinatorSession !== undefined) {
      const configured = resolveCoordinator()
      if (configured !== undefined) restrictCoordinator(configured)
      return { id: config.coordinatorSession, live: configured !== undefined }
    }
    if (agent === undefined) throw new Error('无法绑定协调者会话：task_create 需要调用方 agent')
    const boundId = getSetting(db, COORDINATOR_KEY)
    if (boundId !== undefined) {
      const bound = ctx.get?.('agents')?.get?.(boundId)
      if (bound !== undefined) return { id: boundId, live: true }
      if (!isRootOrLead(agent)) {
        throw new Error(`已绑定的协调者会话 ${boundId} 已失效，只有协调者会话（Team Lead）能重新绑定`)
      }
      const won = rebindSetting(db, COORDINATOR_KEY, boundId, agent.id)
      const finalId = won ? agent.id : getSetting(db, COORDINATOR_KEY)
      if (won) {
        ctx.logger?.info?.(`dsh-orchestrator: 协调者会话已变更：${boundId} → ${agent.id}`)
        restrictCoordinator(agent)
        return { id: agent.id, live: true, changed: true, previous: boundId }
      }
      return { id: finalId, live: ctx.get?.('agents')?.get?.(finalId) !== undefined }
    }
    if (!isRootOrLead(agent)) throw new Error('无法绑定协调者会话：只有协调者会话（Team Lead）能首次派任务')
    const assigned = bindSettingOnce(db, COORDINATOR_KEY, agent.id)
    if (assigned === agent.id) {
      ctx.logger?.info?.(`dsh-orchestrator: 协调者会话已绑定：${agent.id}`)
      restrictCoordinator(agent)
    }
    return { id: assigned, live: ctx.get?.('agents')?.get?.(assigned) !== undefined }
  }

  const current = resolveCoordinator()
  if (current === undefined) {
    const boundId = getSetting(db, COORDINATOR_KEY)
    warnings(config.coordinatorSession !== undefined
      ? `dsh-orchestrator: 配置的 coordinatorSession ${config.coordinatorSession} 当前未加载`
      : boundId !== undefined
        ? `dsh-orchestrator: 已绑定的协调者会话 ${boundId} 当前未加载，首次 task_create 会重新绑定`
        : 'dsh-orchestrator: 尚未绑定 coordinatorSession，首次 task_create 会自动绑定协调者会话')
  } else {
    restrictCoordinator(current)
  }
  ctx.on?.('agent/created', ({ agent }) => {
    const id = resolvedCoordinatorId()
    if (agent !== undefined && id !== undefined && agent.id === id) restrictCoordinator(agent)
  })

  const dispatcher = createDispatcher({
    agentTeams: ctx.agentTeams,
    getAgent: resolveCoordinator,
    provider: config.spawnProvider,
    onWarn: warnings,
  })

  const notifier = createNotifier({
    mergeWindowMs: config.mergeWindowMs,
    onWarn: warnings,
    record: entry => addNotification(db, entry),
    send: (text, items) => {
      const id = resolvedCoordinatorId()
      if (id === undefined) {
        warnings('dsh-orchestrator: 尚未绑定协调者会话，通知已跳过')
        return { skipped: true, reason: '尚未绑定协调者会话，无法投递通知。' }
      }
      const sender = items.map(item => item.sender).find(value => value !== undefined)
      if (sender === undefined) {
        warnings('dsh-orchestrator: 通知缺少发送方 agent，已跳过投递')
        return { skipped: true, reason: '通知缺少发送方 agent。' }
      }
      const coordinator = resolveCoordinator()
      if (coordinator === undefined) {
        warnings(`dsh-orchestrator: ${COORDINATOR_INVALID_HINT}`)
        return { skipped: true, reason: COORDINATOR_INVALID_HINT }
      }
      // 直接对协调者会话 steer：与 TeamService 给 lead 投递时内部做的事同构，
      // 但不要求发送方此刻还在 roster，所以 5 秒合并窗口后仍能送达。
      // 注入失败不在这里吞掉：交给 notifier 记 failed + reason，而不是 skipped。
      injectNotification(coordinator, { text, senderId: sender.id })
      return true
    },
  })

  const toolDisposers = createTools({
    db, dispatcher, notifier, config, bindCoordinator, coordinatorStatus,
  }).map(tool => ctx.tools.register(tool))

  ctx.effect?.(() => async () => {
    for (const dispose of [...restrictionDisposers, ...toolDisposers].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    await notifier.flushNow()
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
