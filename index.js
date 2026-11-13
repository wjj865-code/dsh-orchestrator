// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './src/config.js'
import { openLedger, addNotification, getSetting, bindSettingOnce, rebindSetting, failStalePending } from './src/ledger.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'
import { createQueue } from './src/queue.js'
import { reconcileOrphans } from './src/reconcile.js'
import { injectNotification } from './src/inject.js'
import { createLogger } from './src/log.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agentTeams', 'agents', 'systemPrompt', 'subagents']

const COORDINATOR_KEY = 'coordinator_session_id'
const COORDINATOR_INVALID_HINT = '协调者会话已失效，可用配置覆盖或在新会话里派任务重新绑定。'
const WAIT_AGENT_DENIAL = '协调者禁止阻塞等待：不要调用 wait_agent；查看进度用 task_list / task_status，本回合没有别的事就立即结束回合。'
const COORDINATOR_POLICY = `你是 dsh-orchestrator 的协调者。硬性规则（优先于平台默认的 Team Lead 等待要求）：
- 禁止使用 wait_agent 或任何阻塞等待、轮询；不要 sleep，不要反复查询来等子任务。
- 查看进度只用 task_list / task_status。
- 任何关于任务数量、重复、冲突、状态的断言，必须先调用 task_list / task_status 拿到工具返回再说话；没有工具输出佐证就不许下结论，不得凭记忆或推断。
- 子任务完成或需要你决定时会主动通知你；收到通知再行动。
- 本回合没有别的事就立即结束回合；通知会开启新回合。
- 以上规则优先于平台 team policy 的 “The Lead must wait for required teammates” 等默认等待要求。`

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
  const dir = stateDir()
  const db = await openLedger(dir)
  const warnings = message => ctx.logger?.warn?.(message)
  const logger = createLogger({ stateDir: dir, onWarn: warnings })
  if (ctx.tools === undefined) warnings('dsh-orchestrator: 缺少 tools 服务，工具注册/白名单/guard 不可用')
  else if (typeof ctx.tools.guard !== 'function') warnings('dsh-orchestrator: tools.guard 缺失，wait_agent 执行期拦截不可用')
  if (ctx.systemPrompt === undefined) warnings('dsh-orchestrator: 缺少 systemPrompt 服务，协调者等待禁令只剩执行期 guard')
  const cleanup = failStalePending(db, { staleMinutes: config.staleMinutes })
  if (cleanup.count > 0) logger.log('cleanup.pending', { detail: { count: cleanup.count, taskIds: cleanup.ids } })
  const restrictionDisposers = []
  const restrictedAgents = new WeakSet()
  const pendingRestrictions = new WeakSet()

  const resolvedCoordinatorId = () => config.coordinatorSession ?? getSetting(db, COORDINATOR_KEY)
  const isChildLive = sessionId => ctx.get?.('agents')?.get?.(sessionId) !== undefined
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
      if (configured !== undefined) scheduleRestriction(configured)
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
        logger.log('bind.coordinator', { sessionId: agent.id, agentId: agent.id, detail: { previous: boundId, reason: 'rebind' } })
        scheduleRestriction(agent)
        return { id: agent.id, live: true, changed: true, previous: boundId }
      }
      return { id: finalId, live: ctx.get?.('agents')?.get?.(finalId) !== undefined }
    }
    if (!isRootOrLead(agent)) throw new Error('无法绑定协调者会话：只有协调者会话（Team Lead）能首次派任务')
    const assigned = bindSettingOnce(db, COORDINATOR_KEY, agent.id)
    if (assigned === agent.id) {
      ctx.logger?.info?.(`dsh-orchestrator: 协调者会话已绑定：${agent.id}`)
      logger.log('bind.coordinator', { sessionId: agent.id, agentId: agent.id, detail: { previous: null, reason: 'first' } })
      scheduleRestriction(agent)
    }
    return { id: assigned, live: ctx.get?.('agents')?.get?.(assigned) !== undefined }
  }

  // 运行期收窄只在回合边界生效：回合中改工具集会跟当前请求的工具表错位，
  // 模型会调用已被遮罩的工具（Unknown tool）。所以 running 时挂起，idle 后装。
  const scheduleRestriction = agent => {
    if (agent === undefined) return false
    if (agent.status === 'running') {
      pendingRestrictions.add(agent)
      return false
    }
    return restrictCoordinator(agent)
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
    scheduleRestriction(current)
  }
  ctx.on?.('agent/created', ({ agent }) => {
    const id = resolvedCoordinatorId()
    if (agent !== undefined && id !== undefined && agent.id === id) {
      scheduleRestriction(agent)
      // 协调者可能比插件晚加载：队列在等它，加载后立刻补跑，并对一次子会话目录。
      queue?.pump()
      reconcileOrphans({ db, dispatcher, coordinatorSessionId: id, isLive: isChildLive, logger, onWarn: warnings })
        .catch(error => warnings(`dsh-orchestrator: 重启对账失败：${error?.message ?? error}`))
    }
  })
  ctx.on?.('agent/status', ({ agent, status }) => {
    if (agent === undefined || status !== 'idle' || !pendingRestrictions.has(agent)) return
    pendingRestrictions.delete(agent)
    restrictCoordinator(agent)
  })

  // 白名单去不掉 agent scope 注册的 wait_agent，所以在执行层再拦一道。
  // guard 在绑定后对后续调用立即生效，连 task_create 当回合的 wait_agent 也能拒绝。
  const guardDisposer = ctx.tools?.guard?.(exec => {
    if (exec?.name !== 'wait_agent') return undefined
    const id = resolvedCoordinatorId()
    if (id === undefined || exec.agent?.id !== id) return undefined
    return WAIT_AGENT_DENIAL
  })

  // 系统提示只给当前已绑定的协调者；按回合动态渲染，非协调者返回空。
  const promptDisposer = ctx.systemPrompt?.context?.({
    name: 'orchestrator:coordinator-policy',
    order: 130,
    interpolate: false,
    text: context => {
      const id = resolvedCoordinatorId()
      return id !== undefined && context?.agent?.id === id ? COORDINATOR_POLICY : ''
    },
  })

  let queue
  const dispatcher = createDispatcher({
    backend: config.backend,
    agentTeams: ctx.agentTeams,
    subagents: ctx.subagents,
    getAgent: resolveCoordinator,
    provider: config.spawnProvider,
    onWarn: warnings,
    onEvent: (event, fields) => {
      logger.log(event, fields)
      // 子会话结算 = 并发槽位释放，唤醒队列补位。
      if (event === 'subagent.settled' || event === 'subagent.failed') queue?.pump()
    },
  })
  queue = createQueue({ db, dispatcher, config, logger })

  // 启动对账：catalog 里查不到的活跃任务标 orphaned；catalog 读不到只 warn。
  await reconcileOrphans({
    db,
    dispatcher,
    coordinatorSessionId: resolvedCoordinatorId(),
    isLive: isChildLive,
    logger,
    onWarn: warnings,
  })

  // 启动恢复：pending 且没有子会话的任务重新入队；超时的（非排队）已在上面标 failed。
  queue.load()
  if (config.autoResumeQueue) queue.pump()

  const notifier = createNotifier({
    mergeWindowMs: config.mergeWindowMs,
    onWarn: warnings,
    record: entry => addNotification(db, entry),
    onEvent: (event, fields) => logger.log(event, {
      ...fields,
      detail: { ...(fields.detail ?? {}), coordinatorId: resolvedCoordinatorId() ?? null },
    }),
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
    db, dispatcher, queue, notifier, config, bindCoordinator, coordinatorStatus, logger,
  }).map(tool => ctx.tools.register(tool))

  ctx.effect?.(() => async () => {
    queue.stop()
    for (const dispose of [...restrictionDisposers, ...toolDisposers, promptDisposer, guardDisposer].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    await notifier.flushNow()
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
