// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { join } from 'node:path'
import { loadConfig, DEFAULT_WORKER_PRESET } from './src/config.js'
import { createHostCapabilities } from './src/host-capabilities.js'
import { Config, unwrapVolatile } from './src/config-schema.js'
import {
  openLedger, addNotification, getMainSessionId, failStalePending, findTaskBySession, setTaskArtifacts,
  getTask, listTasks, setTransitionObserver,
} from './src/ledger.js'
import { collectWorkspaceArtifacts, appendMissingArtifacts, MAX_AUTO_ARTIFACTS } from './src/artifact-collect.js'
import { createSettlementReporter } from './src/settlement.js'
import { createDeliveredSweeper } from './src/delivered.js'
import { taskLabel } from './src/task-label.js'
import { createMainSession } from './src/main-session.js'
import { createOnboarding } from './src/onboarding.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'
import { legacyToolHint } from './src/tool-migrations.js'
import { createQueue } from './src/queue.js'
import { createStartupReconciler } from './src/reconcile.js'
import { createContextObserver, cleanupLegacyRotation, probeCompaction } from './src/main-context.js'
import { createIdleWatchdog } from './src/watchdog.js'
import { createGoalBridge } from './src/goal.js'
import { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } from './src/host-route.js'
import { injectNotification } from './src/inject.js'
import { createLogger } from './src/log.js'
// P2-3 交接契约 v1：JSONL 事件（交付 / 确认）落 $DSH_HOME/state/orchestrator/handoff/。
import { createHandoffLog, emitHandoffDelivered, setHandoffSink } from './src/handoff.js'
// P2-4（D6）：官方 Team 板只读快照 + 确认交付时的 CAS 反写（服务缺失/未开启一律降级）。
import {
  confirmOnBoard, linkBoardTask, readTeamBoard, setTeamBoardSink, teamLinkView,
} from './src/team-board.js'
import { loadPreferences, migrateLegacyPreferences, renderPreferenceBlock } from './src/preferences.js'
import { PRESENT_LIMIT_TEXT } from './src/prompt-layers.js'
// P1-C 文案单源：协调者 policy 里的计划/交付口径引用 src/copy.js，避免与 L2/L3 说法漂移。
import {
  BLOCKER_RULE, CHANGE_REVIEW_FIELDS, PLAN_PHASE_LINES, PLAN_SAVE_DIR, PROGRESS_NOTICE_HINT,
} from './src/copy.js'
import { startSnapshotLoop } from './src/snapshot.js'
import { ensureDigest } from './src/digest.js'
import { createPanelActions } from './src/panel-actions.js'
import { cleanupTaskWorktree, createWorktreeService } from './src/worktree.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agents', 'systemPrompt', 'subagents']

// 配置 schema：Cordis 从插件模块的 `Config` 导出读取，决定插件页上能看到/能改哪些字段。
// 字段规格的单一事实源在 src/config-fields.js；这里只做投影，不参与运行时归一化。
export { Config }

const COORDINATOR_INVALID_HINT = '主会话已失效，请从面板「打开主会话」重建。'
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
const WAIT_AGENT_DENIAL = '协调者禁止阻塞等待：不要调用 wait_agent；查看进度用 task_list / task_status，本回合没有别的事就立即结束回合。'
const COORDINATOR_POLICY = `你是 dsh-orchestrator 的协调者。硬性规则（优先于平台默认的 Team Lead 等待要求）：
- 禁止使用 wait_agent 或任何阻塞等待、轮询；不要 sleep，不要反复查询来等子任务。
- 禁止调用 spawn_teammate / send_message / list_agents / interrupt_agent / team_task_create / team_task_get / team_task_list / team_task_update：派活只能走 task_create，查进度只能 task_list / task_status，不要直接派队友或操作团队任务板。
- 官方 Team 板是**只读**的：snapshot.teamBoard 里能看到官方任务（id/revision/状态/负责人），但你不操作官方板。只有要把我们的任务对齐到某个官方任务时，才在 task_create 里传 teamTaskId（如 'task-3'）：插件只读校验并记下 revision，确认交付时按 CAS 反写该官方任务 complete。反写失败/冲突只提示，不重试轰炸、不影响本地交付。
- 工具表里可能仍列出这些团队工具（agent-scope 自注册，预设层删不掉），看到也不要调用；执行层会直接拒绝并返回原因。
- 查看进度只用 task_list / task_status。
- 原生自动化管理用 schedule_create / schedule_list / schedule_view / schedule_edit；不造调度器，不用文件、shell 或 HTTP 绕过缺失能力。schedule_create 必填 title/prompt/rrule/target；schedule_list 用 active/limit/offset 分页；schedule_view 用 id；schedule_edit 用 id 与 action:update|delete，暂停/恢复用 active:false|true，不存在独立 schedule_delete/pause 工具。
- 自动化是 Host-wide，可见并可按 id 管理其他会话创建的任务：创建、修改、暂停、恢复、删除必须有用户明确授权，修改前确认目标，不能主动迁移或清理现有任务；既有自动化的授权只在原范围内有效。宿主授权提示是模型行为约束，不是人工审批硬门禁。时间、日期或时区不明确先问。
- 本次自动编排只支持 target:this_session：到期唤醒唯一主会话，再走 task_create。new/new_once 创建普通 root 会话并继承当前目录/预设，但非唯一主会话，不能直接 task_create；不得篡改 main_session_id、认领第二协调者或加转发桥。自动化投递成功不等于子任务完成；重复触发先用 task_list 核对，不反复重派。
- 编辑时用最新结果的 updatedAt 作为 expectedUpdatedAt（可用时）；schedule_conflict 先 schedule_view 重读，不强行覆盖。Host 必须运行；崩溃可能重复投递，删除不撤回已排队消息，不承诺 exactly-once。
- 默认 worker 不开放自动化；自定义预设即使露出 schema，宿主仍拒绝 delegated subagent（subagent_session）。access:full 只改变单个子会话沙箱，不增加工具、不绕过宿主委派校验或审批。缺服务/工具时明确报告当前能力缺失，不能模拟成功。
- 派任务前可用 context({ mode: 'history', query }) 查跨项目记忆与历史任务，用 context({ mode: 'project', target }) 读项目背景；长期有效的用户决策/偏好用 memory_note 记下来。
- **能直接回答就不派任务**：答案能从记忆、上下文、已交付结论或本会话已知事实得出时，直接回复用户，不要为了「再确认一下」新派子会话；只有需要**新鲜取证**（读代码、跑命令、查远端或外部状态）、需要**写文件**、或需要**跨仓库证据**时才 task_create。拿不准就用一条二分：这次要不要动文件、要不要跑命令——都不要就直接答。
- 有先后关系时用 task_create 的 dependsOn；同一需求用 group 归组；会改同一批文件时用 writeScopes 标写域（与活跃未隔离任务重叠会被拒，见下「同写域并发防护」）；紧急任务用 priority（-10..10）。
- 子任务回报产物路径后，默认用 present 展示 ${PRESENT_LIMIT_TEXT}产物（只列**已登记产物**里的真实文件、写绝对路径），不必等用户点名；没有产物就不提 present。要看产物正文（多文件产物挑着看、核对文件里到底写了什么）用 read_workspace({ path })：边界是**主会话工作区 ∪ 已登记产物**——子会话按契约把产物写在 target 目录内（仓库、worktree 检出），那些路径不在工作区里，但只要登记过就能读；未登记的同目录文件、越界、路径穿越、符号链接逃逸会被拒。present 仍只声明交付、不读文件内容。
- 需要「看一眼产物」时先用 read_workspace，不要为此新派一个子任务；但**不要**用 read_workspace 校验产物是否真实存在（存在性由插件与子任务保证，present 只列真实文件）。
- 需要先看方案再动手（大改、跨文件、范围不确定）时用 task_create({ planFirst: true })：子会话只读探索后先 plan_save 把计划落盘到${PLAN_SAVE_DIR}<taskId>.md，再用 task_report blocked 只上报摘要 + ${PLAN_PHASE_LINES.reportQuestion}。planFirst 与 readOnly 互斥。
- **计划批准必须由用户拍板（最硬的人工闸门，协调者不得自行批准、禁止代批）**：收到计划任务的 blocked（摘要 + 计划文档路径）后，严格按这四步（顺序不能换）：
  1. **先交付**：把计划摘要与计划文档的**绝对路径**原样转给用户，并用 present 声明该计划文档（present 只声明交付、不读内容）；
  2. **再提问**：必须用 ask_user_question 结构化提问，options **至少三项**：批准执行 / 先看计划文档 / 调整计划（可再加「放弃」）；
  3. 用户选「先看计划文档」→ 只把文档正文（read_workspace）或路径再给一遍，不续派、不催、不替用户决定，等用户下一次明确表态后回到第 2 步；
  4. 只有明确「批准」才续派实现。
  - 用户答「批准」（明确说批准 / 按这个做 / 可以执行）：才可以 task_message 续派实现（插件此时才把沙箱切回可写）；批准只认用户消息里的话，协调者不得推断。
  - 用户答「调整」：把用户的修改点原样转回同一个子会话，让它先出修订版计划（追加消息里写明「只修订计划、不要开始实现」：按当前机制追加消息即被视为批准、沙箱切回可写，只能靠这句话约束子会话），子会话再次 blocked 后重新回到第 1 步。
  - 用户没回答：任务保持 blocked（台账 waiting_user、计划中），不要续派、不要代批，也不要因为等太久就放行；等用户答复后再按上面的分支处理。
  - 不得自己判断「计划没问题 / 用户应该会同意」就直接续派实现，也不得把用户沉默、含糊回应或你的默认当成批准。
- 只有构建/发版这类**确实需要越过文件沙箱**（写仓库外、跑不受沙箱限制的 bash/pwsh）的任务才传 task_create({ access: 'full' })：该子会话单独跑在 danger-full-access，**默认策略与其他任务一律不动**；access 只接受 'full'，且与 readOnly / planFirst 互斥；没有这种需求就不要传，也别因为用户说「不限制 bash」就顺手给所有任务加上。access 属于单个任务，插件不往孙任务传，也不写进任何默认配置。
- 向用户汇报任务时用**任务名**（可附任务编号，如「计划落盘工具（t-4e573e01）」），不要只甩 t-xxxx 编号：编号是给你调工具用的，用户只认任务名。
- 子任务回报 done 后任务状态是「待确认」（delivered，已交付待确认），**不是终态**：默认**保持待确认、不要主动 task_message({ action: 'close' })**——追问窗口留着，用户看完结果常还要改。用户要改/补充一律 task_message 追问（复用同一个子会话，不要新建任务）；一直不确认会按超时（config.deliveredTimeoutMinutes）自动完成，task_status 会写阈值。用户主动说「确认 / 没问题 / 不用再改」，或你确实需要终态（要派依赖它的任务、要删任务、要收尾整个需求）时，直接 task_message({ action: 'close' })，**不用先问用户**。
- **不要问「任务能不能关闭」**：交付后正常汇报结果、产物与注意事项就收尾，**不要**用 ask_user_question 追问「确认 / 要改？」这类催关闭的问题——任务保持待确认、等超时自动完成，比逼用户当场表态更省事；用户看完还要改是常态，主动催反而添打扰。
- **少打扰只针对「不用拍板的进展汇报」**：progress 进展、done 结果这类汇报直接说结论、不提问；这条与上一条「不催关闭」以及「能直接回答就不派任务」不矛盾——三者都是「不替用户做决定、也不逼用户表态」，不是「不问用户」。
- **只在真正需要拍板时提问，且必须用 ask_user_question 结构化提问**：出现方案歧义/业务取舍、范围变更、权限变更、不可逆操作（删数据、覆盖历史、强推）、或需要远端写授权（推送、建 MR、发布、改权限）时，**必须用 ask_user_question 结构化提问**（question + 2–4 个 options），**不得用纯文字问句代替**——纯文字问句容易被用户忽略，也没有选项可点，等于让决策悬空。不可逆操作必须先拿到用户拍板，不能先做后报。一次把待拍板的点合成一条清单问完（每行一项，带任务名与要点），不逐任务连问。「任务能否关闭」不属于需要提问的范畴。
- 需要看“待你决定/失败/长时间没动静”时用 task_list({ view: 'inbox' })。
- 工具表就这 10 个：task_create / task_list / task_status / task_detail / task_message / read_workspace / context / memory_note / task_report / plan_save。旧的 task_stop / task_retry / task_close 已并入 task_message 的 action（stop / retry / close），task_inbox 并入 task_list({ view: 'inbox' })，history_search / project_context 并入 context 的 mode（history / project / workspaces）；旧名已删除，硬调会拿到迁移提示（映射表见 README「工具迁移映射」）。
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
1. 读指引：上下文里 DSH 已注入用户级/工作区级 AGENTS.md；再用 context({ mode: 'project', target }) 看目标仓库的 AGENTS.md（有就按它，回复里写明来源）。用户当场表述优先于文件。
2. 拿事实：context({ mode: 'project', target }) 看顶层结构是不是 git 仓库；task_list 看同 group / dependsOn 链上有没有在跑的任务。isRepo/defaultBranch/recentBranches 这类仓库事实由插件在 worktree:true 的返回里给，你不要跑 git。
3. 判要不要建（默认三条件，仅在用户/配置都没说死时用）：A 目标是 git 仓库 ∧ B 同一需求已有任务在执行 ∧ C 本次是新需求 → worktree:true；否则省略或传 false，并在回复里说一句原因（「不是 git 仓库」「续派复用已有检出」…）。
4. 判基线 + 分支名：用户指定就从哪起（worktreeBase）；没说时插件给事实——近 ${days} 天 0 个活跃分支用默认分支、1 个直接用那条；**≥2 个时插件返回 needsBranchChoice 且不创建任务**，你用 ask_user_question 问用户，拿到答案后带 worktreeBase 重调 task_create。分支名默认 ${prefix}<taskId>，用户/项目有命名约定就传 worktreeBranch（非法/重名会报错，插件不改名）。
5. 收尾标注：按返回的 worktree 块在回复里写「产物在分支 X 的检出目录 Y，合并由你决定」；hint 非空时一并解释。
- 隔离任务在检出目录里干活：产物不在用户工作树里，合并/提交由用户决定（插件不合并、不 push、不碰远程）。
- worktree 与 readOnly / planFirst 互斥（创建期拒绝）；计划批准后要隔离就重新派发一个带 worktree:true 的任务。
- 同一需求续写用 worktreeMode:'continue' 复用已有检出；同一检出上不要并发两个任务（用 dependsOn 串行）。
- worktreeCleanup 默认 off（检出+分支都保留）；要清理传 'checkout-only'（只删检出）或 'full'（连分支一起删）。`
}

/**
 * 同写域并发防护的协调者指引（结构化配置渲染，默认 require）。
 *
 * 默认档是**拒绝**（不再是 advisory），但不是不可绕过：三条出路都在这里讲清楚
 * （task_message({action:'close'|'stop'}) 旧任务、worktree:true 隔离、显式 allowConcurrent:true），
 * 否则协调者被拒后会反复重试同一个调用。
 */
export function renderWriteGuardPolicy(config = {}) {
  const mode = config.sameDirGuard ?? 'require'
  const behavior = mode === 'require'
    ? '默认拒绝：目标目录（相同或互相包含）或写域与活跃未隔离任务重叠时 task_create 直接报错、不建任务。'
    : (mode === 'warn'
      ? '只警告：同样冲突时照常建任务，但返回里带「并发风险」警告（两个子会话可能同时改同一批文件）。'
      : '已关闭：不判目标目录/写域（writeScopes 退回一行 advisory 提示）。')
  return `## 同写域并发防护
当前配置：sameDirGuard=${mode}（require | warn | off）｜${behavior}
- 判定对象：同一 target 目录（含父子目录）或 writeScopes 重叠的**活跃未隔离**任务；只读任务、worktree 隔离任务、dependsOn 链上的前置任务都不算冲突。
- 被拒时按顺序选一条，不要原样重试同一个调用：
  1. 该目录确实只该有一个任务在写 → 先 task_message({ action: 'close' })（待确认）或 task_message({ action: 'stop' })（还在跑），再重派；
  2. 两个任务要并行 → 传 worktree:true 让新任务在独立检出里跑（推荐，产物合并由你/用户决定）；
  3. 用户明确要求并发写同一目录 → 显式传 allowConcurrent:true，并把返回里的「并发风险」原话转告用户。
- 不要为了绕过这条把任务改成 readOnly/planFirst（那会让子会话写不了文件），也不要自己改配置。
- 已交付待确认（delivered）也占目录：要接着改就用 task_message 追问原会话，不要新建同目录任务。`
}

/** 协调者系统提示 = 固定规则 + 结构化配置渲染（worktree 策略等）。 */
export function renderCoordinatorPolicy(config = {}) {
  return `${COORDINATOR_POLICY}\n\n${renderWorktreePolicy(config)}\n\n${renderWriteGuardPolicy(config)}`
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

export async function apply(ctx, rawConfig = {}) {
  const warnings = message => ctx.logger?.warn?.(message)
  // Cordis 会把 `Config` 里标了 volatile 的字段包成带 `.get()` 的对象传进来（见 src/config-schema.js
  // 文件头第 3 条）。不解包的话 loadConfig 的类型判断会全部失效、用户的配置被无声丢弃。
  const flatConfig = unwrapVolatile(rawConfig)
  // 已删除的配置键（P1-A 41 → 35）在加载时各 warn 一次：旧 profile 不用改也能跑，但用户能看见哪个键失效了。
  const config = loadConfig(flatConfig, { onWarn: warnings })
  // P0-2b：宿主耦合统一走访问层（10 类）。首片接线「日志路径 + 版本自检」，P2-4 接线 `agentTeams`
  // （官方 Team 板只读互通）；其余访问器已就绪、消费点分批迁移（剩余清单见 docs/compat.md）。这里不改变任何既有行为。
  const host = createHostCapabilities(ctx, { onWarn: warnings })
  const dir = host.stateDir()
  const db = await openLedger(dir)
  // workerPreset 写错（大写/空格/不合法字符）会被归一化回落：明确告诉用户实际用的是哪个。
  // 注意用解包后的值：原始 rawConfig 里的 workerPreset 可能是 Volatile 包装，JSON.stringify 会得到 `{}`。
  const rawWorkerPreset = flatConfig.workerPreset
  if (rawWorkerPreset !== undefined && config.workerPreset === DEFAULT_WORKER_PRESET && rawWorkerPreset !== DEFAULT_WORKER_PRESET) {
    warnings(`dsh-orchestrator: workerPreset=${JSON.stringify(rawWorkerPreset)} 不是合法预设 id（小写字母/数字/连字符），已回落到 ${DEFAULT_WORKER_PRESET}`)
  }
  const logger = createLogger({ stateDir: dir, onWarn: warnings })
  // 0.25.0：轮换删除后，老 profile 里残留的 main_rotation_* / main_session_created_at 一次性清掉
  // （marker 必须清：留着的话回滚旧版本会按它「补完轮换」去归档一个毫不相干的会话）。
  cleanupLegacyRotation({ db, log: (event, fields) => logger.log(event, fields) })
  // 0.25.1：旧版 `memory_note(kind:'preference', 不传 project)` 写在 memories 的死数据一次性搬进 settings
  // （渲染侧只读 settings，那几条以前永不生效）。幂等标记在 settings；失败不阻断加载、下次启动重试。
  try {
    migrateLegacyPreferences({ db, log: (event, fields) => logger.log(event, fields) })
  } catch (error) {
    warnings(`dsh-orchestrator: 旧偏好迁移失败（不影响加载，下次启动重试）：${error?.message ?? error}`)
  }
  // 宿主自检（只诊断、不拦加载）：版本落在声明基线外时 warn 一次；能力快照等装配完成后再记。
  // 为什么只 warn：插件历史上靠「服务缺失静默不生效」吃过亏（真实宿主不渲染），宁可多一行可读诊断。
  const hostVersion = host.version()
  if (hostVersion.status === 'below' || hostVersion.status === 'above') {
    warnings(`dsh-orchestrator: 宿主版本 ${hostVersion.version} ${hostVersion.status === 'below' ? '低于' : '高于'}声明的兼容基线 ${hostVersion.baseline}：插件照常加载，但接口形状可能已变；升级/降级宿主后先跑 docs/compat.md 的冒烟 3 条`)
  }
  // 状态迁移的审计日志（审计 §4.5）：`transition` 是唯一入口，在这里挂一次观察者就覆盖全部 19 个调用点，
  // 从此「这个任务为什么从 running 变 orphaned」能直接从日志还原，不必靠 settle 消息反推。
  // P2-3 交接契约 v1：进入 delivered 的**唯一**入口也在这里 → `task.handoff.delivered` 只写一次
  // （task_report done 与结算 completed 两条路都过 transition，不会漏也不会重）。
  const handoffLog = createHandoffLog({ db, stateDir: dir, onWarn: warnings })
  setTransitionObserver(({ taskId, from, to, sessionId, reason, closeReason }) => {
    logger.log('task.transition', {
      taskId,
      sessionId: sessionId ?? undefined,
      detail: { from, to, reason: reason ?? null, closeReason: closeReason ?? null },
    })
    if (to === 'delivered') {
      try { emitHandoffDelivered(getTask(db, taskId)) } catch { /* 事件失败是旁路，不影响迁移 */ }
    }
  })
  // 确认侧（三条路径共用 closeDelivered）走同一个进程级 sink：交付事件也从这里出，
  // 少一处「忘接就不发事件」的可能（与上面观察者是同一套做法）。
  const disposeHandoffSink = setHandoffSink(handoffLog)
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
    goals: () => host.goals(),
    agents: () => host.agents(),
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
  const isChildLive = sessionId => host.agents()?.get?.(sessionId) !== undefined
  const resolveCoordinator = () => {
    const id = resolvedCoordinatorId()
    return id === undefined ? undefined : host.agents()?.get?.(id)
  }
  const coordinatorStatus = () => {
    const id = resolvedCoordinatorId()
    return { id, live: id !== undefined && resolveCoordinator() !== undefined }
  }

  // P2-4（D6）：官方 Team 板只读视图 + 可选反写。三件事都只碰 `agentTeams` 的只读方法
  // （`isEnabled/listTasks`）与唯一的 `updateTask({action:'complete'})`——不接管官方派发/生命周期，
  // 也不新增任何 root 会话派发路径（计划 §6：D6 优先，不做 workspace 第二后端）。
  // 读一律用**当前协调者的活 agent**（官方 API 要的是 caller，不是 session id）；未加载时按降级返回。
  const teamBoard = {
    read: agent => readTeamBoard({ agentTeams: host.agentTeams(), agent }),
    link: (agent, teamTaskId) => linkBoardTask({ agentTeams: host.agentTeams(), agent, teamTaskId }),
    linkView: task => teamLinkView({ agentTeams: host.agentTeams(), agent: resolveCoordinator(), task }),
  }
  // 确认反写的进程级 sink：工具 / 面板 / 超时三条路径共用 `closeDelivered`，这里接一次就全覆盖。
  // 失败只 warn + 记日志，绝不回滚本地 done（`closeDelivered` 早已把状态落库）。
  // **超时自动完成不反写**：`acceptedBy='timeout'` 不是人的确认，官方板上不该被「没人看过的超时」改状态；
  // 只记一条 `team.board.skipped`（reason: timeout）留痕，别的什么也不做。
  const disposeTeamBoardSink = setTeamBoardSink((task, context) => {
    if (context?.acceptedBy === 'timeout') {
      if (typeof task.team_task_id === 'string' && task.team_task_id !== '') {
        logger.log('team.board.skipped', {
          taskId: task.id,
          detail: {
            code: 'TEAM_BOARD_TIMEOUT',
            reason: 'timeout',
            message: '超时自动完成不是人的确认，不反写官方 Team 板',
            teamTaskId: task.team_task_id,
          },
        })
      }
      return null
    }
    const attempt = confirmOnBoard({ agentTeams: host.agentTeams(), agent: resolveCoordinator(), task })
    return Promise.resolve(attempt).then(outcome => {
      if (outcome?.ok === true) {
        logger.log('team.board.confirmed', {
          taskId: task.id,
          detail: {
            teamTaskId: outcome.taskId ?? null,
            revision: outcome.revision ?? null,
            fromRevision: outcome.fromRevision ?? null,
            reRead: outcome.reRead === true,
            acceptedBy: context?.acceptedBy ?? null,
          },
        })
        return outcome
      }
      if (outcome?.skipped === true) {
        // 没关联 / 服务缺失 / Team 未开启：正常降级，只记日志（确认完成这一下不该吓用户）。
        logger.log('team.board.skipped', {
          taskId: task.id,
          detail: { code: outcome?.code ?? null, reason: outcome?.reason ?? null },
        })
        return outcome
      }
      // 冲突或官方拒绝：报告即可，不重试轰炸；本地任务照常完成。
      const stale = outcome?.code === 'TEAM_TASK_STALE_REVISION'
      logger.log(stale ? 'team.board.stale' : 'team.board.confirm-failed', {
        taskId: task.id,
        detail: { teamTaskId: task.team_task_id ?? null, code: outcome?.code ?? null, reason: outcome?.reason ?? null },
      })
      warnings(`dsh-orchestrator: 官方 Team 板未反写成功（${outcome?.reason ?? outcome?.code ?? '未知原因'}）；本地任务已照常完成`)
      return outcome
    }).catch(error => {
      logger.log('team.board.confirm-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
      return null
    })
  })

  // 只检查定义/服务，不执行自动化；回合边界重查，晚加载或恢复后不永久缓存 unavailable。
  const scheduleCapability = new WeakMap()
  const checkScheduleCapability = agent => {
    if (agent === undefined || agent.id !== resolvedCoordinatorId()) return ''
    const missing = []
    try {
      // schedule 不在 inject 里：读 `ctx.schedule` 属性必抛 cordis 的 inject 错，
      // 只走 host.schedule()（内部 = 带 try/catch 的 ctx.get，服务不存在/抛错都返回 undefined）。
      if (host.schedule() === undefined) missing.push('schedule 服务')
      // tools 在 index.js 的 inject 里（根 ctx 属性读安全），不是可选服务；agent.ctx 是宿主给的
      // agent 作用域，取不到就由外层 try 兜底为「能力检查失败」，不换成 service()（会拿到全局工具表）。
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
  const service = name => host.service(name)
  // 0.25.0：上下文观测 + 压力提醒（**只读 + 只提问**：不调 compactNow、不自动换会话）。
  // 观测在「打开主会话」后异步跑一次；压力到 `contextPressureThreshold` 时用宿主 userQuestions 弹问题卡。
  // 用户选「新建协调者会话」才代建（requestNewCoordinator → mainSession.createCoordinatorSession）。
  let mainSession
  const contextObserver = createContextObserver({
    db,
    config,
    tokenMeter: () => service('tokenMeter'),
    persistence: () => service('sessionPersistence'),
    sessionQuery: () => service('sessionQuery'),
    agentPresets: () => service('agentPresets'),
    sessions: () => service('sessions'),
    userQuestions: () => service('userQuestions'),
    requestNewCoordinator: async () => {
      const result = await mainSession?.createCoordinatorSession?.({ source: 'pressure-reminder' })
      if (result?.ok === true) {
        contextObserver.clearAlert({ reason: 'created' })
        try { await ensureDigestFor(result.sessionId) } catch (error) {
          warnings(`dsh-orchestrator: 新协调者会话的日报重建失败：${error?.message ?? error}`)
        }
      }
      return result
    },
    log: (event, fields) => logger.log(event, fields),
    onWarn: warnings,
  })
  mainSession = createMainSession({
    db,
    config,
    agents: () => service('agents'),
    sessionController: () => service('sessionController'),
    workspaces: () => service('workspaceRegistry'),
    sessions: () => service('sessions'),
    // C：主会话权限徽标一致性——协调者会话的 permission preset 钉成宿主出厂预设 read-only
    // （沙箱只读 + 审批 ask）。普通任务子会话由 dispatch 显式钉 workspace-write，不受影响。
    permissionPresets: () => service('permissionPresets'),
    defaultCwd: join(dir, 'workspace'),
    presetFor: agent => service('agentPresets')?.presetForSession?.(agent?.session),
    selectPreset: (agent, presetId) => {
      const presets = service('agentPresets')
      if (typeof presets?.select !== 'function') throw new Error('缺少 agentPresets.select 服务')
      return presets.select(agent, presetId)
    },
    workspacePath: join(dir, 'workspace'),
    workspaceName: '指挥舱',
    // 打开成功后旁路观测（异步、不阻塞打开）；压力到阈值时才弹问题卡。
    onOpened: ({ result, agent }) => {
      if (result?.ok !== true) return undefined
      const sessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined
      if (sessionId === undefined) return undefined
      const live = agent ?? (() => { try { return service('agents')?.get?.(sessionId) } catch { return undefined } })()
      return contextObserver.observeAndRemind({ mainSessionId: sessionId, liveAgent: live, source: 'open' })
    },
    log: (event, detail) => logger.log(event, { detail }),
  })

  const onboarding = createOnboarding({
    db, resolveAgent: id => service('agents')?.get?.(id),
    ensurePreset: agent => mainSession.guardPreset(agent), warn: warnings,
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
      // UI 可能 rebind default；待欢迎会话由onboarding先等待预设恢复再启动。
      void onboarding.start(agent.id)
        .then(result => { if (result.ok === false) warnings(`dsh-orchestrator: ${result.error}`) })
        .catch(error => warnings(`dsh-orchestrator: 首次介绍启动失败：${error?.message ?? error}`))
      void mainSession.guardPreset?.(agent).catch(error => warnings(`dsh-orchestrator: 主会话预设守护失败：${error?.message ?? error}`))
      // C：协调者权限预设钉只读（新建/代建时已钉；这里兜住重启恢复、adopt 前晚加载、以及升级前
      // 建的旧主会话——徽标与协调者实际工具面保持一致）。服务缺失/失败只记日志，不影响加载。
      try { mainSession.pinPermission?.(agent.id, agent.session) } catch (error) {
        warnings(`dsh-orchestrator: 主会话权限钉只读失败：${error?.message ?? error}`)
      }
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
  // 协调者能读的只有工作区内产物（read_workspace，自建受控入口），原生 read/glob 与一切写操作仍被拦。
  const DENY_HINT = toolName => `${toolName} 是协调者禁止的工具：协调者只做协调（task_*），不直接写文件、执行命令、派队友或操作团队任务（读工作区产物用 read_workspace）；查看进度用 task_list / task_status。`
  const guardDisposer = ctx.tools?.guard?.(exec => {
    const toolName = exec?.name
    if (typeof toolName !== 'string') return undefined
    // P1-B：旧工具名已从工具表删除，但**不静默**——模型照旧 AGENTS.md / 旧提示词调 task_stop 之类时，
    // 执行层直接把「改成什么调用」返回给它（映射表单源 src/tool-migrations.js，CHANGELOG/README 同一份）。
    // 不限 agent：子会话拿到同样的提示也不坏事（它本来就没有这些工具）。
    const migration = legacyToolHint(toolName)
    if (migration !== undefined) return migration
    if (!COORDINATOR_DENY.includes(toolName)) return undefined
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
      // L1 四段拼接：硬规则 + worktree 策略 + 写域策略（renderCoordinatorPolicy）→ 偏好 → 能力诊断。
      // 偏好放**末尾**：阅读顺序即优先级顺序（低于硬规则），且可单独开关/单测/回滚。
      const preferences = config.preferencesInject === false
        ? ''
        : renderPreferenceBlock(loadPreferences(db), {
          maxChars: config.preferencesMaxChars,
        })
      return [renderCoordinatorPolicy(config), preferences, capability]
        .filter(part => part !== '')
        .join('\n\n')
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
    subagents: host.subagents(),
    getAgent: resolveCoordinator,
    provider: config.spawnProvider,
    // 子会话预设（dispatch 里落到启动 spec 的 agentPreset）：默认 worker，调试时可指 orch-debug。
    workerPreset: config.workerPreset,
    onWarn: warnings,
    // rc.3 子会话沙箱根取父会话 header.cwd：派发后给子会话补注册 target 可写根。
    // 服务惰性取，加载顺序不保证；agents 在 inject 里，sessions/sandboxPolicy 用 ctx.get。
    agents: () => host.agents(),
    sessions: () => host.sessions(),
    sandboxPolicy: () => host.sandboxPolicy(),
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
  // P2-2：合并窗口是 notify.js 里的固定常量（配置键 mergeWindowMs 已删）——5 秒属于 UX 阈值，
  // 不是策略；通知仍按任务合并，只是不再有「现场可调」这一层。
  const notifier = createNotifier({
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
        fallbackCwd: task.target_dir ?? join(dir, 'workspace'),
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

  // 续跑（P2-2）：不再有自建 keep-alive 注入器——goalRounds > 0 的任务由 goalBridge 在 create 时
  // 带 maxGoalRounds 并保持 armed，轮次由宿主 dsh-goal-round-driver 驱动；0（默认）仍 create 后立刻 disarm。

  // 两段式终态（D1）的确认兜底：delivered 超过 deliveredTimeoutMinutes 自动收成 done。
  // 与工具 task_message action:close / 面板「确认交付」共用 closeDelivered，副作用顺序完全一致。
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
    defaultCwd: () => resolveCoordinator()?.session?.header?.cwd ?? join(dir, 'workspace'),
    sessionQuery: () => service('sessionQuery'),
    sessions: () => service('sessions'),
    workspaceChanges: () => service('workspaceChanges'),
    goalBridge,
    // L1：经验文件落在插件唯一写入根下的 lessons/，子会话可 read。
    stateDir: dir,
    // P2-4（D6）：官方 Team 板只读关联（task_create.teamTaskId 的校验与记录）。
    teamBoard,
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
          fallbackCwd: task.target_dir ?? join(dir, 'workspace'),
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
    // P2-4（D6）：抽屉里的「官方 Team 任务」关联视图（只读）。
    teamBoard: task => teamBoard.linkView(task),
  })

  // 客户端面板路由：鉴权由 connection 服务统一负责；snapshot 只查台账；
  // detail/artifacts/preview 只读，stop/retry/message/delete 是面板动作（owner-only）。
  const routeOptions = {
    ...HOST_ROUTE_OPTIONS,
    fetch: createHostRoute({
      db,
      coordinatorStatus,
      panel,
      // P2-4（D6）：官方 Team 板只读快照（服务缺失/未开启/读失败都在 handler 里降级）。
      teamBoard: () => teamBoard.read(resolveCoordinator()),
      // 0.25.0：上下文观测缓存（只读诊断；面板不常驻渲染压力）。
      contextSnapshot: () => contextObserver.snapshot(),
      // 0.25.0：会话头「设为协调者」→ 只切指针（不改名、不归档旧会话）+ 重建日报 + 清提醒。
      adoptSession: async ({ sessionId }) => {
        const result = await mainSession.adoptSession({ sessionId, source: 'panel' })
        if (result?.ok === true && result.unchanged !== true) {
          contextObserver.clearAlert({ reason: 'adopted' })
          try { await ensureDigestFor(result.sessionId) } catch (error) {
            warnings(`dsh-orchestrator: 新协调者会话的日报重建失败：${error?.message ?? error}`)
          }
        }
        return result
      },
      openMain: async () => {
        const result = await mainSession.open()
        if (result?.ok === true && typeof result.sessionId === 'string') {
          const agent = resolveCoordinator()
          if (agent !== undefined && agent.status !== 'running') checkScheduleCapability(agent)
          const welcome = await onboarding.start(result.sessionId)
          if (welcome.ok === false) result.onboardingError = welcome.error
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
    // connection 不在 inject 里（首选用 ctx.inject(['connection']) 拿 scope）：读 `ctx.connection` 属性必抛，
    // 旧写法 `host.connection() ?? ctx.connection` 会把「缺 connection」变成装配期异常，所以只走 host.connection()。
    routeDisposer = installRoute(host.connection())
    if (routeDisposer === undefined) {
      warnings('dsh-orchestrator: 缺少 connection 服务，/api/orchestrator 面板路由不可用')
    }
  }

  // 宿主能力快照：装配完成后记一次，尽量反映真实可用面（服务仍可能晚加载，缺失如实记录、不猜）。
  // 面板诊断行与工具返回后续直接读 host.report()，不另存副本。
  const hostReport = host.report()
  // 0.25.0：压缩能力只读探测（serviceFor/compactNow 存在性 + 能否读到宿主 thresholdRatio）。
  // 只记诊断，不触发任何动作——压缩始终由宿主自己做。
  const compactionProbe = (() => {
    try {
      return probeCompaction({
        agent: resolveCoordinator(),
        agentPresets: service('agentPresets'),
        tokenMeter: service('tokenMeter'),
      })
    } catch { return null }
  })()
  logger.log('host.capabilities', {
    detail: {
      version: hostReport.version.version ?? null,
      versionSource: hostReport.version.source,
      versionStatus: hostReport.version.status,
      available: hostReport.available,
      total: hostReport.total,
      missing: hostReport.missing,
      compaction: compactionProbe,
    },
  })

  ctx.effect?.(() => async () => {
    // 看门狗先停：定时器巡检会在 db.close() 之后继续读台账（卸载期不允许）。
    try { watchdog.stop() } catch { /* 看门狗清理失败不阻断卸载 */ }
    try { deliveredSweeper.stop() } catch { /* 超时巡检清理失败不阻断卸载 */ }
    try { disposeHandoffSink() } catch { /* 交接事件 sink 解绑失败不阻断卸载 */ }
    try { disposeTeamBoardSink() } catch { /* 官方板反写 sink 解绑失败不阻断卸载 */ }
    queue.stop()
    try { stopSnapshots() } catch { /* 快照定时器清理失败不阻断卸载 */ }
    for (const dispose of [...restrictionDisposers, ...toolDisposers, promptDisposer, guardDisposer, artifactDisposer, settleDisposer, routeDisposer].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    // 卸载期间的收尾也不能变成未处理拒绝（宿主会判 fatal load failure）。
    try { await notifier.flushNow() } catch { /* 通知收尾失败不影响卸载 */ }
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
