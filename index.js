// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, DEFAULT_WORKER_PRESET } from './src/config.js'
import { openLedger, addNotification, getMainSessionId, failStalePending, findTaskBySession, setTaskArtifacts, listTasks } from './src/ledger.js'
import { collectWorkspaceArtifacts, appendMissingArtifacts, MAX_AUTO_ARTIFACTS } from './src/artifact-collect.js'
import { createSettlementReporter } from './src/settlement.js'
import { taskLabel } from './src/task-label.js'
import { createMainSession } from './src/main-session.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'
import { createQueue } from './src/queue.js'
import { createStartupReconciler } from './src/reconcile.js'
import { createIdleWatchdog } from './src/watchdog.js'
import { createGoalBridge } from './src/goal.js'
import { createKeepAlive } from './src/keepalive.js'
import { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } from './src/host-route.js'
import { injectNotification } from './src/inject.js'
import { createLogger } from './src/log.js'
import { startSnapshotLoop } from './src/snapshot.js'
import { ensureDigest } from './src/digest.js'
import { createPanelActions } from './src/panel-actions.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agents', 'systemPrompt', 'subagents']

const COORDINATOR_INVALID_HINT = '主会话已失效，请从面板「打开主会话」重建。'
const WAIT_AGENT_DENIAL = '协调者禁止阻塞等待：不要调用 wait_agent；查看进度用 task_list / task_status，本回合没有别的事就立即结束回合。'
const COORDINATOR_POLICY = `你是 dsh-orchestrator 的协调者。硬性规则（优先于平台默认的 Team Lead 等待要求）：
- 禁止使用 wait_agent 或任何阻塞等待、轮询；不要 sleep，不要反复查询来等子任务。
- 禁止调用 spawn_teammate / send_message / list_agents / interrupt_agent / team_task_create / team_task_get / team_task_list / team_task_update：派活只能走 task_create，查进度只能 task_list / task_status，不要直接派队友或操作团队任务板。
- 工具表里可能仍列出这些团队工具（agent-scope 自注册，预设层删不掉），看到也不要调用；执行层会直接拒绝并返回原因。
- 查看进度只用 task_list / task_status。
- 派任务前可用 history_search 查跨项目记忆与历史任务，用 project_context 读项目背景；长期有效的用户决策/偏好用 memory_note 记下来。
- 有先后关系时用 task_create 的 dependsOn；同一需求用 group 归组；会改同一批文件时用 writeScopes 标写域；紧急任务用 priority（-10..10）。
- 子任务完成、reports 文件确认存在后，用 present 交付给用户（1-2 个最关键的，最多 4 个）；路径写绝对路径（协调者工作目录不是项目目录），present 只声明交付、不读文件内容。
- 需要先看方案再动手（大改、跨文件、范围不确定）时用 task_create({ planFirst: true })：子会话只读探索后用 task_report blocked 上报计划，你转交用户；用户批准后用 task_message 续派（插件自动把沙箱切回可写）。planFirst 与 readOnly 互斥。
- 需要看“待你决定/失败/长时间没动静”时用 task_inbox。
- 任何关于任务数量、重复、冲突、状态的断言，必须先调用 task_list / task_status 拿到工具返回再说话；没有工具输出佐证就不许下结论，不得凭记忆或推断。
- 子任务完成或需要你决定时会主动通知你；收到通知再行动。
- 本回合没有别的事就立即结束回合；通知会开启新回合。
- 以上规则优先于平台 team policy 的 “The Lead must wait for required teammates” 等默认等待要求。`

// 协调者只做协调：这些是设计 §10 明令禁止或属于别人职责的工具。
// present 不在名单里：协调者要把子会话产物（reports 文件）交付给用户，
// 由协调者预设的 tool-present 行提供，执行层不再拦。
export const COORDINATOR_DENY = [
  'read', 'write', 'edit', 'glob', 'grep',
  'bash', 'pwsh', 'web_search', 'web_fetch', 'read_browser',
  'plugin_manager', 'skill',
  'job_list', 'job_output', 'job_kill',
  'schedule_create', 'schedule_edit', 'schedule_list',
  'request_secret', 'request_connector',
  'list_bots', 'message_bot', 'post_to_group',
  'create_bot', 'create_group', 'delete_group', 'update_group', 'update_bot',
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // 子会话专属工具：task_report 回报、task_detail 只读自己的创建详情（T1）；协调者看任务用 task_status。
  'task_report', 'task_detail',
]

const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')

export async function apply(ctx, rawConfig = {}) {
  const config = loadConfig(rawConfig)
  const dir = stateDir()
  const db = await openLedger(dir)
  const warnings = message => ctx.logger?.warn?.(message)
  // workerPreset 写错（大写/空格/不合法字符）会被归一化回落：明确告诉用户实际用的是哪个。
  const rawWorkerPreset = rawConfig?.workerPreset
  if (rawWorkerPreset !== undefined && config.workerPreset === DEFAULT_WORKER_PRESET && rawWorkerPreset !== DEFAULT_WORKER_PRESET) {
    warnings(`dsh-orchestrator: workerPreset=${JSON.stringify(rawWorkerPreset)} 不是合法预设 id（小写字母/数字/连字符），已回落到 ${DEFAULT_WORKER_PRESET}`)
  }
  const logger = createLogger({ stateDir: dir, onWarn: warnings })
  // 平台 goal 接入（G1）：能力缺失时桥不可用，所有钩子静默 no-op；不阻塞派发/续派/结算。
  const goalBridge = createGoalBridge({
    db,
    goals: () => ctx.get?.('goals') ?? ctx.goals,
    agents: () => ctx.agents ?? ctx.get?.('agents'),
    onAgentCreated: handler => ctx.on?.('agent/created', ({ agent } = {}) => handler(agent)),
    onWarn: warnings,
    onEvent: (event, fields) => logger.log(event, fields),
  })
  if (ctx.tools === undefined) warnings('dsh-orchestrator: 缺少 tools 服务，工具注册/白名单/guard 不可用')
  else if (typeof ctx.tools.guard !== 'function') warnings('dsh-orchestrator: tools.guard 缺失，wait_agent 执行期拦截不可用')
  if (ctx.systemPrompt === undefined) warnings('dsh-orchestrator: 缺少 systemPrompt 服务，协调者等待禁令只剩执行期 guard')
  const cleanup = failStalePending(db, { staleMinutes: config.staleMinutes })
  if (cleanup.count > 0) logger.log('cleanup.pending', { detail: { count: cleanup.count, taskIds: cleanup.ids } })
  // 每天一份台账快照（VACUUM INTO），保留 N 天；失败只 warn，不影响插件加载。
  const stopSnapshots = startSnapshotLoop(db, dir, {
    retentionDays: config.snapshotRetentionDays,
    onCreated: result => logger.log('snapshot.created', { detail: { path: result.path } }),
    onError: error => warnings(`dsh-orchestrator: 台账快照失败：${error?.message ?? error}`),
  })
  const restrictionDisposers = []
  const restrictedAgents = new WeakSet()
  const pendingRestrictions = new WeakSet()

  const resolvedCoordinatorId = () => config.coordinatorSession ?? getMainSessionId(db)
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

  // 主会话：固定入口创建/打开唯一协调者会话；不再由 task_create 自动绑定。
  // 服务用 getter 惰性取：cordis 并发加载条目，apply 时服务可能还没就绪（同上 connection）。
  const service = name => ctx.get?.(name)
  const mainSession = createMainSession({
    db,
    config,
    agents: () => service('agents'),
    sessionController: () => service('sessionController'),
    workspaces: () => service('workspaceRegistry'),
    defaultCwd: join(stateDir(), 'workspace'),
    presetFor: agent => service('agentPresets')?.presetForSession?.(agent?.session),
    selectPreset: (agent, presetId) => service('agentPresets')?.select?.(agent, presetId),
    workspacePath: join(stateDir(), 'workspace'),
    workspaceName: '指挥舱',
    log: (event, detail) => logger.log(event, { detail }),
  })

  const current = resolveCoordinator()
  const ensureDigestFor = async sessionId => {
    const schedule = service('schedule')
    const result = await ensureDigest({
      schedule,
      db,
      mainSessionId: sessionId,
      config,
      log: (event, detail) => logger.log(event, { detail }),
    })
    if (result.ok === false && result.reason !== 'disabled' && result.reason !== 'no-schedule-service') {
      warnings(`dsh-orchestrator: 日报 schedule 不可用：${result.reason}`)
    }
    return result
  }
  if (current === undefined) {
    warnings(config.coordinatorSession !== undefined
      ? `dsh-orchestrator: 配置的 coordinatorSession ${config.coordinatorSession} 当前未加载`
      : 'dsh-orchestrator: 尚未打开主会话，首次 task_create 会提示先从面板打开')
  } else {
    scheduleRestriction(current)
    void ensureDigestFor(current.id).catch(error => warnings(`dsh-orchestrator: 日报 schedule 初始化失败：${error?.message ?? error}`))
  }
  ctx.on?.('agent/created', ({ agent }) => {
    const id = resolvedCoordinatorId()
    if (agent !== undefined && id !== undefined && agent.id === id) {
      scheduleRestriction(agent)
      // UI 打开空白主会话可能把预设 rebind 成 default；agent 创建时拉回协调者预设。
      void mainSession.guardPreset?.(agent).catch(error => warnings(`dsh-orchestrator: 主会话预设守护失败：${error?.message ?? error}`))
      // 协调者可能比插件晚加载：队列在等它，加载后立刻补跑，并对一次子会话目录。
      void ensureDigestFor(agent.id).catch(error => warnings(`dsh-orchestrator: 日报 schedule 初始化失败：${error?.message ?? error}`))
      queue?.pump()
      // 协调者晚加载：再对一次账，并补发启动时没送出去的孤儿汇总。
      reconciler?.reconcile({ coordinatorSessionId: id })
        .then(() => queue?.pump())
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
  // 预设层删不掉 agent-scope 自注册的团队工具（ToolsService 无移除 API、restrict 遮不到 own），
  // 所以执行层对主会话硬拦整个 COORDINATOR_DENY 名单；agent-scope 工具只剩这一道硬闸。
  const DENY_HINT = toolName => `${toolName} 是协调者禁止的工具：协调者只做协调（task_*），不直接读写文件、执行命令、派队友或操作团队任务；查看进度用 task_list / task_status。`
  const guardDisposer = ctx.tools?.guard?.(exec => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !COORDINATOR_DENY.includes(toolName)) return undefined
    const id = resolvedCoordinatorId()
    if (id === undefined || exec.agent?.id !== id) return undefined
    return toolName === 'wait_agent' ? WAIT_AGENT_DENIAL : DENY_HINT(toolName)
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
  // 启动对账器（S2）：标记「台账在跑、实际没人在跑」的孤儿并汇总上报。
  // 在 notifier 之后创建；agent/created 可能先于赋值触发，所以按可选调用。
  let reconciler
  // 结算上报器：子会话结束/中断时把台账从 running 推到终态（S1）。
  // 队列/派发器后面才创建，这里用惰性引用；事件可能早于赋值，所以都走可选调用。
  let settlement
  const dispatcher = createDispatcher({
    backend: config.backend,
    // agentTeams 是可选的：不放进 inject，缺这个服务的 profile 也能激活。
    // 只有显式选 backend:'team' 时才需要它，缺了由派发器给可读错误。
    agentTeams: () => ctx.get?.('agentTeams') ?? ctx.agentTeams,
    subagents: ctx.subagents,
    getAgent: resolveCoordinator,
    provider: config.spawnProvider,
    // 子会话预设（dispatch 里落到启动 spec 的 agentPreset）：默认 worker，调试时可指 orch-debug。
    workerPreset: config.workerPreset,
    onWarn: warnings,
    // rc.3 子会话沙箱根取父会话 header.cwd：派发后给子会话补注册 target 可写根。
    // 服务惰性取，加载顺序不保证；agents 在 inject 里，sessions/sandboxPolicy 用 ctx.get。
    agents: () => ctx.agents ?? ctx.get?.('agents'),
    sessions: () => ctx.get?.('sessions'),
    sandboxPolicy: () => ctx.get?.('sandboxPolicy'),
    onSessionCreated: handler => ctx.on('session/created', handler),
    // 只读子任务：agent/created 一到就设沙箱，压掉首回合窗口。
    onAgentCreated: handler => ctx.on('agent/created', ({ agent } = {}) => handler(agent)),
    goalBridge,
    onEvent: (event, fields) => {
      logger.log(event, fields)
      if (event === 'subagent.settled') {
        reportSettle({
          taskId: fields.taskId,
          sessionId: fields.sessionId,
          stopReason: fields.detail?.stopReason,
          output: typeof fields.detail?.output === 'string' && fields.detail.output !== ''
            ? [{ type: 'text', text: fields.detail.output }]
            : [],
          // B1：派发侧已抽出完整文本（detail.output 只有 240 字摘要，只能给日志）。
          lastMessage: typeof fields.lastMessage === 'string' ? fields.lastMessage : undefined,
          source: 'dispatcher',
        })
      } else if (event === 'subagent.failed') {
        settlement?.fail({ taskId: fields.taskId, sessionId: fields.sessionId, error: fields.detail?.error, source: 'dispatcher' })
      }
      // 子会话结算 = 并发槽位释放，唤醒队列补位。
      if (event === 'subagent.settled' || event === 'subagent.failed') queue?.pump()
    },
  })
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
        warnings('dsh-orchestrator: 尚未打开主会话，通知已跳过')
        return { skipped: true, reason: '尚未打开主会话，无法投递通知。' }
      }
      const sender = items.map(item => item.sender).find(value => value !== undefined)
      const systemOnly = sender === undefined && items.length > 0 && items.every(item => item.system === true)
      if (sender === undefined && !systemOnly) {
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
      // 系统通知（例如任务派发失败）没有子会话 sender，用主会话自身的 id 作为来源。
      injectNotification(coordinator, { text, senderId: sender === undefined ? id : sender.id })
      return true
    },
  })


  queue = createQueue({ db, dispatcher, config, logger, notifier })

  reconciler = createStartupReconciler({
    db,
    dispatcher,
    isLive: isChildLive,
    logger,
    onWarn: warnings,
    notifier,
    labelFor: task => taskLabel(task, { all: listTasks(db) }),
    // G1：对账标 orphaned 时同步收口平台 goal（agent 已不 live，桥只写台账镜像）。
    onOrphaned: task => { void goalBridge.clear(task.id, task.session_id) },
  })

  // 自动 done 的产物补齐（D5）：必须在结算通知发出**之前**跑完，否则「子会话自然结束 → 结算自动判 done」
  // 这条最常见收场路径的通知里永远没有产物，也就没有 present 交付指令（reports/t6.1-present.md §5）。
  // 返回补齐后的台账行给通知渲染；收集失败只告警，不影响已落库的终态。
  function collectArtifactsBeforeSettleNotify(task, status) {
    if (status !== 'done') return task
    const sessionId = task?.session_id
    if (sessionId === undefined || sessionId === null) return task
    const session = service('agents')?.get?.(sessionId)?.session ?? service('sessions')?.get?.(sessionId)
    if (session === undefined) return task
    try {
      const result = collectWorkspaceArtifacts({
        session,
        workspaceChanges: service('workspaceChanges'),
        fallbackCwd: task.target_dir ?? join(stateDir(), 'workspace'),
        max: MAX_AUTO_ARTIFACTS,
      })
      const added = appendMissingArtifacts(task.artifacts, result.artifacts)
      if (added.length === 0) return task
      const updated = setTaskArtifacts(db, task.id, added)
      logger.log('task.settle.artifacts.auto', {
        taskId: task.id,
        detail: { added: added.length, turns: result.turns },
      })
      return updated ?? task
    } catch (error) {
      warnings(`dsh-orchestrator: 结算前产物收集失败：${error?.message ?? error}`)
      return task
    }
  }

  settlement = createSettlementReporter({
    db,
    notifier,
    logger,
    labelFor: task => taskLabel(task, { all: listTasks(db) }),
    // B1：超 64KB 的返回消息写这里（按需创建，启动时不建目录）。
    reportsDir: join(dir, 'reports'),
    releaseSession: target => dispatcher.releaseWritableRoots?.(target),
    pump: () => queue?.pump(),
    // D5：通知前补齐产物，让结算通知也带可交付清单（与 task_report 那条路同一份产物）。
    beforeNotify: collectArtifactsBeforeSettleNotify,
    // G1：结算自动收场时收敛平台 goal：done → complete；其余终态（cancelled/failed/orphaned）→ clear。
    onTerminal: (task, status) => {
      void (status === 'done' ? goalBridge.complete(task.id, task.session_id) : goalBridge.clear(task.id, task.session_id))
    },
  })

  // 回合间 keep-alive（K2）：`agent/turn-stopping` 时给「running 且平台 goal 未完成」的子会话
  // 同步投递下一轮（默认 steer 进 next-step），让 loop 在回合尾部接着跑而不进 idle；
  // agent 不 idle，S1 的结算观察器就没有机会在轮次之间 dispose，竞态窗口被消除。
  // 默认关闭（config.keepAlive），轮数预算落台账（tasks.keep_alive_rounds），进入 running 时归零。
  // goal 状态读 live 视图（goalBridge.stateOf），读不到就退回台账镜像；没有 goal 的任务不续跑。
  const keepAlive = createKeepAlive({
    db,
    config,
    logger,
    goalState: task => goalBridge.stateOf(task.id, task.session_id) ?? task.goal_state ?? null,
  })
  // 订阅必须早于任何子会话回合结束；放在 settlement 之后、watchdog 之前（不依赖队列/看门狗）。
  const keepAliveDisposer = keepAlive.start(ctx)

  // 空闲看门狗（W1）：running 却长时间没有心跳/消息/状态变化时告警一次。
  // 只告警：不改状态、不 kill、不重派；去重按任务（同一段空闲只报一次，活动后重置）。
  const watchdog = createIdleWatchdog({
    db,
    notifier,
    logger,
    onWarn: warnings,
    labelFor: task => taskLabel(task, { all: listTasks(db) }),
    idleMinutes: config.watchdogIdleMinutes,
    intervalMinutes: config.watchdogIntervalMinutes,
    enabled: config.idleWatchdog,
  })

  // 产物补齐已挪到通知之前（collectArtifactsBeforeSettleNotify，作为 beforeNotify 钩子），
  // 这条路径只需要把事件喂给结算器：task_report done 那条路另有 workspace/changes 钩子。
  function reportSettle(input) {
    return settlement?.report(input)
  }

  // 平台生命周期事件：续派/冷恢复起的新 activation 不走 dispatch 的 track，只有 subagent/end 能看到。
  // 和派发侧事件重叠到达时，第二次会因为任务已不在 running 被跳过（状态机天然幂等）。
  const settleDisposer = typeof ctx.on === 'function'
    ? ctx.on('subagent/end', info => {
      if (info?.local !== true || info?.id === undefined) return
      reportSettle({
        sessionId: String(info.id),
        stopReason: info.stopReason,
        output: info.lastAssistantMessage,
        source: 'lifecycle',
      })
    })
    : undefined

  // 启动对账（S2）：running 无活跃子会话 / catalog 查不到 → orphaned，并汇总上报一次；
  // 此时协调者可能还没加载，汇总会保留到 agent/created 再补发。
  await reconciler.reconcile({ coordinatorSessionId: resolvedCoordinatorId() })

  // 看门狗放在启动对账之后：先让 S2 把「进程重启后没人在跑」的 running 标 orphaned，
  // 剩下的 running 才交给看门狗判断是否空闲（避免同一任务既报丢失又报卡住）。
  watchdog.start()

  // 启动恢复：pending 且没有子会话的任务重新入队；超时的（非排队）已在上面标 failed。
  queue.load()
  if (config.autoResumeQueue) queue.pump()

  const toolDisposers = createTools({
    db, dispatcher, queue, notifier, config, coordinatorStatus, logger,
    workspaces: () => service('workspaceRegistry'),
    // 相对产物/项目上下文默认跟主会话目录；主会话重建后 getter 自动取到新目录。
    defaultCwd: () => resolveCoordinator()?.session?.header?.cwd ?? join(stateDir(), 'workspace'),
    sessionQuery: () => service('sessionQuery'),
    sessions: () => service('sessions'),
    workspaceChanges: () => service('workspaceChanges'),
    goalBridge,
    // L1：经验文件落在插件唯一写入根下的 lessons/，子会话可 read。
    stateDir: dir,
  }).map(tool => ctx.tools.register(tool))

  // task_report done 所在回合的 workspace/changes 事件在 turn stopping 时才追加：
  // 监听提交后的事件（摘要服务在 append 返回后才登记，所以推迟到微任务再读），把当前回合的改动补进已结束任务。
  const collectArtifactsAfterTurn = session => {
    queueMicrotask(() => {
      try {
        const task = findTaskBySession(db, session?.id, { status: 'done' })
        if (task === undefined) return
        const result = collectWorkspaceArtifacts({
          session,
          workspaceChanges: service('workspaceChanges'),
          fallbackCwd: task.target_dir ?? join(stateDir(), 'workspace'),
          max: MAX_AUTO_ARTIFACTS,
        })
        const added = appendMissingArtifacts(task.artifacts, result.artifacts)
        if (added.length === 0) return
        const next = setTaskArtifacts(db, task.id, added)
        logger.log('task.report.artifacts.auto', {
          taskId: task.id,
          detail: { added: added.length, turns: result.turns, total: next.artifacts.length },
        })
      } catch (error) {
        warnings(`dsh-orchestrator: 产物自动收集失败：${error?.message ?? error}`)
      }
    })
  }
  const artifactDisposer = ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') collectArtifactsAfterTurn(session)
  })

  const panel = createPanelActions({
    db,
    dispatcher,
    queue,
    config,
    coordinatorStatus,
    logger,
    goalBridge,
  })

  // 客户端面板路由：鉴权由 connection 服务统一负责；snapshot 只查台账；
  // detail/artifacts/preview 只读，stop/retry/message/delete 是面板动作（owner-only）。
  const routeOptions = {
    ...HOST_ROUTE_OPTIONS,
    fetch: createHostRoute({
      db,
      coordinatorStatus,
      panel,
      openMain: async () => {
        const result = await mainSession.open()
        if (result?.ok === true && typeof result.sessionId === 'string') {
          try { await ensureDigestFor(result.sessionId) } catch (error) {
            warnings(`dsh-orchestrator: 日报 schedule 初始化失败：${error?.message ?? error}`)
          }
        }
        return result
      },
      staleMinutes: config.staleMinutes,
    }),
  }
  const installRoute = scope => {
    const connection = scope?.connection ?? scope
    if (typeof connection?.fetch?.register !== 'function') return undefined
    try {
      const dispose = connection.fetch.register(routeOptions)
      ctx.logger?.info?.(`dsh-orchestrator: 面板路由已注册 ${HOST_ROUTE}`)
      return dispose
    } catch (error) {
      warnings(`dsh-orchestrator: 面板路由注册失败：${error?.message ?? error}`)
      return undefined
    }
  }
  let routeDisposer
  if (typeof ctx.inject === 'function') {
    routeDisposer = ctx.inject(['connection'], scope => {
      const dispose = installRoute(scope)
      scope.effect?.(() => () => { try { dispose?.() } catch { /* 卸载期失败不阻断 */ } })
    })
  } else {
    routeDisposer = installRoute(ctx.get?.('connection') ?? ctx.connection)
    if (routeDisposer === undefined) {
      warnings('dsh-orchestrator: 缺少 connection 服务，/api/orchestrator 面板路由不可用')
    }
  }

  ctx.effect?.(() => async () => {
    // 看门狗先停：定时器巡检会在 db.close() 之后继续读台账（卸载期不允许）。
    try { watchdog.stop() } catch { /* 看门狗清理失败不阻断卸载 */ }
    queue.stop()
    try { stopSnapshots() } catch { /* 快照定时器清理失败不阻断卸载 */ }
    for (const dispose of [...restrictionDisposers, ...toolDisposers, promptDisposer, guardDisposer, artifactDisposer, settleDisposer, keepAliveDisposer, routeDisposer].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    // 卸载期间的收尾也不能变成未处理拒绝（宿主会判 fatal load failure）。
    try { await notifier.flushNow() } catch { /* 通知收尾失败不影响卸载 */ }
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
