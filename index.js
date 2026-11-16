// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, DEFAULT_WORKER_PRESET } from './src/config.js'
import { openLedger, addNotification, getMainSessionId, failStalePending, findTaskBySession, setTaskArtifacts, listTasks } from './src/ledger.js'
import { collectWorkspaceArtifacts, appendMissingArtifacts, MAX_AUTO_ARTIFACTS } from './src/artifact-collect.js'
import { createSettlementReporter } from './src/settlement.js'
import { createDeliveredSweeper } from './src/delivered.js'
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
import { cleanupTaskWorktree, createWorktreeService } from './src/worktree.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agents', 'systemPrompt', 'subagents']

const COORDINATOR_INVALID_HINT = '主会话已失效，请从面板「打开主会话」重建。'
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
const WAIT_AGENT_DENIAL = '协调者禁止阻塞等待：不要调用 wait_agent；查看进度用 task_list / task_status，本回合没有别的事就立即结束回合。'
const COORDINATOR_POLICY = `你是 dsh-orchestrator 的协调者。硬性规则（优先于平台默认的 Team Lead 等待要求）：
- 禁止使用 wait_agent 或任何阻塞等待、轮询；不要 sleep，不要反复查询来等子任务。
- 禁止调用 spawn_teammate / send_message / list_agents / interrupt_agent / team_task_create / team_task_get / team_task_list / team_task_update：派活只能走 task_create，查进度只能 task_list / task_status，不要直接派队友或操作团队任务板。
- 工具表里可能仍列出这些团队工具（agent-scope 自注册，预设层删不掉），看到也不要调用；执行层会直接拒绝并返回原因。
- 查看进度只用 task_list / task_status。
- 原生自动化管理用 schedule_create / schedule_list / schedule_view / schedule_edit；不造调度器，不用文件、shell 或 HTTP 绕过缺失能力。schedule_create 必填 title/prompt/rrule/target；schedule_list 用 active/limit/offset 分页；schedule_view 用 id；schedule_edit 用 id 与 action:update|delete，暂停/恢复用 active:false|true，不存在独立 schedule_delete/pause 工具。
- 自动化是 Host-wide，可见并可按 id 管理其他会话创建的任务：创建、修改、暂停、恢复、删除必须有用户明确授权，修改前确认目标，不能主动迁移或清理现有任务；既有自动化的授权只在原范围内有效。宿主授权提示是模型行为约束，不是人工审批硬门禁。时间、日期或时区不明确先问。
- 本次自动编排只支持 target:this_session：到期唤醒唯一主会话，再走 task_create。new/new_once 创建普通 root 会话并继承当前目录/预设，但非唯一主会话，不能直接 task_create；不得篡改 main_session_id、认领第二协调者或加转发桥。自动化投递成功不等于子任务完成；重复触发先用 task_list 核对，不反复重派。
- 编辑时用最新结果的 updatedAt 作为 expectedUpdatedAt（可用时）；schedule_conflict 先 schedule_view 重读，不强行覆盖。Host 必须运行；崩溃可能重复投递，删除不撤回已排队消息，不承诺 exactly-once。
- 默认 worker 不开放自动化；自定义预设即使露出 schema，宿主仍拒绝 delegated subagent（subagent_session）。access:full 只改变单个子会话沙箱，不增加工具、不绕过宿主委派校验或审批。缺服务/工具时明确报告当前能力缺失，不能模拟成功。
- 派任务前可用 history_search 查跨项目记忆与历史任务，用 project_context 读项目背景；长期有效的用户决策/偏好用 memory_note 记下来。
- 有先后关系时用 task_create 的 dependsOn；同一需求用 group 归组；会改同一批文件时用 writeScopes 标写域；紧急任务用 priority（-10..10）。
- 子任务回报产物路径后，默认用 present 展示 1-4 个最关键的产物（最多 4 个；只列真实存在的文件、写绝对路径），不必等用户点名；没有产物就不提 present；不要自行 stat/read 校验存在性（协调者的 read/glob 已被 deny，插件与子任务负责确认），present 只声明交付、不读文件内容。
- 需要先看方案再动手（大改、跨文件、范围不确定）时用 task_create({ planFirst: true })：子会话只读探索后先 plan_save 把计划落盘到主会话工作区的 reports/plans/<taskId>.md，再用 task_report blocked 只上报摘要 + 计划文档绝对路径 + 待拍板问题，你连路径一起转交用户；用户批准后用 task_message 续派（插件自动把沙箱切回可写）。planFirst 与 readOnly 互斥。
- 只有构建/发版这类**确实需要越过文件沙箱**（写仓库外、跑不受沙箱限制的 bash/pwsh）的任务才传 task_create({ access: 'full' })：该子会话单独跑在 danger-full-access，**默认策略与其他任务一律不动**；access 只接受 'full'，且与 readOnly / planFirst 互斥；没有这种需求就不要传，也别因为用户说「不限制 bash」就顺手给所有任务加上。access 属于单个任务，插件不往孙任务传，也不写进任何默认配置。
- 向用户汇报任务时用**任务名**（可附任务编号，如「计划落盘工具（t-4e573e01）」），不要只甩 t-xxxx 编号：编号是给你调工具用的，用户只认任务名。
- 子任务回报 done 后任务状态是「待确认」（delivered，已交付待确认），**不是终态**：默认**保持待确认、不要主动 task_close**——追问窗口留着，用户看完结果常还要改；只有用户明确说「确认 / 没问题 / 不用再改」，或你确实需要终态（要派依赖它的任务、要删任务、要收尾）时才 task_close。用户要改/补充一律 task_message 追问（复用同一个子会话，不要新建任务）；一直不确认会按超时（config.deliveredTimeoutMinutes）自动完成，task_status 会写阈值。
- 需要看“待你决定/失败/长时间没动静”时用 task_inbox。
- 任何关于任务数量、重复、冲突、状态的断言，必须先调用 task_list / task_status 拿到工具返回再说话；没有工具输出佐证就不许下结论，不得凭记忆或推断。
- 子任务完成或需要你决定时会主动通知你；收到通知再行动。
- 本回合没有别的事就立即结束回合；通知会开启新回合。
- 以上规则优先于平台 team policy 的 “The Lead must wait for required teammates” 等默认等待要求。`

/**
 * P9：worktree 隔离的协调者指引（结构化配置渲染，**不解析自然语言**）。
 *
 * 三条职责边界（master-plan §4.0）：
 * - DSH 负责把用户级 + 工作区级 `AGENTS.md` 注入协调者上下文（`dsh-agent-instructions`）；
 * - 协调者据此判断「要不要建 / 基线 / 分支名」，转成 `task_create.worktree*` 结构化字段；
 * - 插件只做校验 + 执行（建检出、设 target、标注、清理），不读文件、不猜基线、不弹问。
 */
export function renderWorktreePolicy(config = {}) {
  const policy = config.worktreePolicy ?? 'auto'
  const prefix = config.worktreeBranchPrefix ?? 'orch/'
  const days = Number.isFinite(config.worktreeRecentDays) ? config.worktreeRecentDays : 7
  return `## worktree 隔离（插件策略，非硬拦截）
当前配置策略：${policy}（required | auto | off）｜分支前缀：${prefix}｜最近活跃窗口：${days} 天
- required：每个需求都用 task_create({ worktree: true }) 派发；只读/计划阶段的任务跳过并说明。
- auto：默认不隔离；目标仓库是 git 仓库、同一需求已有任务在执行、且本次是新需求时，建议隔离。
- off：一律不隔离。
- 用户当场表述或 AGENTS.md 里的要求优先于本默认；判断后传结构化字段，不要问「怎么解析文件」。
判断流程（你做判断，插件只执行）：
1. 读指引：上下文里 DSH 已注入用户级/工作区级 AGENTS.md；再用 project_context(<target>) 看目标仓库的 AGENTS.md（有就按它，回复里写明来源）。用户当场表述优先于文件。
2. 拿事实：project_context 看顶层结构是不是 git 仓库；task_list 看同 group / dependsOn 链上有没有在跑的任务。isRepo/defaultBranch/recentBranches 这类仓库事实由插件在 worktree:true 的返回里给，你不要跑 git。
3. 判要不要建（默认三条件，仅在用户/配置都没说死时用）：A 目标是 git 仓库 ∧ B 同一需求已有任务在执行 ∧ C 本次是新需求 → worktree:true；否则省略或传 false，并在回复里说一句原因（「不是 git 仓库」「续派复用已有检出」…）。
4. 判基线 + 分支名：用户指定就从哪起（worktreeBase）；没说时插件给事实——近 ${days} 天 0 个活跃分支用默认分支、1 个直接用那条；**≥2 个时插件返回 needsBranchChoice 且不创建任务**，你用 ask_user_question 问用户，拿到答案后带 worktreeBase 重调 task_create。分支名默认 ${prefix}<taskId>，用户/项目有命名约定就传 worktreeBranch（非法/重名会报错，插件不改名）。
5. 收尾标注：按返回的 worktree 块在回复里写「产物在分支 X 的检出目录 Y，合并由你决定」；hint 非空时一并解释。
- 隔离任务在检出目录里干活：产物不在用户工作树里，合并/提交由用户决定（插件不合并、不 push、不碰远程）。
- worktree 与 readOnly / planFirst 互斥（创建期拒绝）；计划批准后要隔离就重新派发一个带 worktree:true 的任务。
- 同一需求续写用 worktreeMode:'continue' 复用已有检出；同一检出上不要并发两个任务（用 dependsOn 串行）。
- worktreeCleanup 默认 off（检出+分支都保留）；要清理传 'checkout-only'（只删检出）或 'full'（连分支一起删）。`
}

/** 协调者系统提示 = 固定规则 + 结构化配置渲染（worktree 策略等）。 */
export function renderCoordinatorPolicy(config = {}) {
  return `${COORDINATOR_POLICY}\n\n${renderWorktreePolicy(config)}`
}

// 协调者只做协调：这些是设计 §10 明令禁止或属于别人职责的工具。
// present 不在名单里：协调者要把子会话产物（reports 文件）交付给用户，
// 由协调者预设的 tool-present 行提供，执行层不再拦。
export const COORDINATOR_DENY = [
  'read', 'write', 'edit', 'glob', 'grep',
  'bash', 'pwsh', 'web_search', 'web_fetch', 'read_browser',
  'plugin_manager', 'skill',
  'job_list', 'job_output', 'job_kill',
  'request_secret', 'request_connector',
  'list_bots', 'message_bot', 'post_to_group',
  'create_bot', 'create_group', 'delete_group', 'update_group', 'update_bot',
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // 子会话专属工具：task_report 回报、task_detail 只读自己的创建详情（T1）、plan_save 计划落盘（计划阶段
  // 唯一写入口）；协调者看任务用 task_status，写文件一律不允许。
  'task_report', 'task_detail', 'plan_save',
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
  // P9：宿主侧 git 能力（只在 worktree 任务上被调用；普通任务零 git 调用）。
  const worktreeLog = (event, fields) => logger.log(event, fields)
  const worktreeService = createWorktreeService({
    recentDays: config.worktreeRecentDays,
    log: worktreeLog,
  })
  // 终态清理（默认 off）：只清台账里有记录的那份检出，失败只记日志、不影响任务终态。
  const cleanupWorktree = task => {
    if (task === undefined || task === null) return
    void cleanupTaskWorktree({ db, task, service: worktreeService, log: worktreeLog })
      .catch(error => warnings(`dsh-orchestrator: worktree 清理失败：${error?.message ?? error}`))
  }
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

  // 只检查定义/服务，不执行自动化；回合边界重查，晚加载或恢复后不永久缓存 unavailable。
  const scheduleCapability = new WeakMap()
  const checkScheduleCapability = agent => {
    if (agent === undefined || agent.id !== resolvedCoordinatorId()) return ''
    const missing = []
    try {
      if ((ctx.get?.('schedule') ?? ctx.schedule) === undefined) missing.push('schedule 服务')
      const tools = agent.ctx?.tools ?? ctx.tools
      for (const name of SCHEDULE_TOOLS) {
        if (typeof tools?.get !== 'function' || tools.get(name, agent) === undefined) missing.push(name)
      }
    } catch {
      missing.push('能力检查失败')
    }
    const hint = missing.length === 0 ? '' : `当前缺失自动化能力：${missing.join('、')}。不能模拟成功或绕过；检查宿主支持版本、预设挂载与 Loader broken 诊断，配置修正后彻底重启 DSH。现有任务编排仍可使用。`
    if (hint !== '' && scheduleCapability.get(agent) !== hint) warnings(`dsh-orchestrator: ${hint}`)
    scheduleCapability.set(agent, hint)
    return hint
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
    checkScheduleCapability(agent)
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
    if (agent === undefined || status !== 'idle' || agent.id !== resolvedCoordinatorId()) return
    checkScheduleCapability(agent)
    if (pendingRestrictions.has(agent)) {
      pendingRestrictions.delete(agent)
      restrictCoordinator(agent)
    }
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
      if (id === undefined || context?.agent?.id !== id) return ''
      const capability = checkScheduleCapability(context.agent)
      return `${renderCoordinatorPolicy(config)}${capability === '' ? '' : `\n\n${capability}`}`
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


  queue = createQueue({ db, dispatcher, config, logger, notifier, worktree: worktreeService, cleanupWorktree })

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
    // delivered 也会发通知（且同样带 present 指令），产物补齐对它一样有意义。
    if (status !== 'done' && status !== 'delivered') return task
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
      // P9：终态按 worktreeCleanup 档位清理检出（默认 off = 全保留）；异步、失败只 warn。
      cleanupWorktree(task)
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

  // 两段式终态（D1）的确认兜底：delivered 超过 deliveredTimeoutMinutes 自动收成 done。
  // 与工具 task_close / 面板「确认交付」共用 closeDelivered，副作用顺序完全一致。
  const deliveredSweeper = createDeliveredSweeper({
    db,
    config,
    logger,
    releaseSession: target => dispatcher.releaseWritableRoots?.(target),
    completeGoal: task => { void goalBridge.complete(task.id, task.session_id) },
    cleanupWorktree,
    pump: () => queue?.pump(),
    onWarn: warnings,
  })

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
  // 交付确认超时巡检：启动即扫一次，覆盖进程重启期间已经过期的 delivered。
  deliveredSweeper.start()

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
    // P9：worktree 能力共享同一份服务（recentDays 取配置），终态清理由 index 统一注入。
    worktree: worktreeService,
    cleanupWorktree,
  }).map(tool => ctx.tools.register(tool))

  // task_report done 所在回合的 workspace/changes 事件在 turn stopping 时才追加：
  // 监听提交后的事件（摘要服务在 append 返回后才登记，所以推迟到微任务再读），把当前回合的改动补进已结束任务。
  // 两段式终态：子会话报 done 会先把任务落到 delivered，确认后才 done，所以两个状态都要兜。
  const collectArtifactsAfterTurn = session => {
    queueMicrotask(() => {
      try {
        const task = findTaskBySession(db, session?.id, { status: 'delivered' })
          ?? findTaskBySession(db, session?.id, { status: 'done' })
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
    cleanupWorktree,
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
          const agent = resolveCoordinator()
          if (agent !== undefined && agent.status !== 'running') checkScheduleCapability(agent)
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
    try { deliveredSweeper.stop() } catch { /* 超时巡检清理失败不阻断卸载 */ }
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
