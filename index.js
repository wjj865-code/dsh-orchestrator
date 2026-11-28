// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { join } from 'node:path'
import { loadConfig, DEFAULT_WORKER_PRESET } from './src/config.js'
import { createHostCapabilities } from './src/host-capabilities.js'
import { Config, unwrapVolatile } from './src/config-schema.js'
import {
  openLedger, addNotification, getMainSessionId, failStalePending, findTaskBySession, setTaskArtifacts,
  getTask, listTasks, setTransitionObserver, getCoordinatorIds, setCoordinatorIds, getSetting,
} from './src/ledger.js'
import { createArtifactDelivery } from './src/artifact-delivery.js'
import { artifactProtection } from './src/artifact-protection.js'
import { createSettlementReporter } from './src/settlement.js'
// P1 去重：正文（简报/回报/最后一条消息）只在宿主会话日志里存一份，台账留借条。
import { createBodySource } from './src/session-body.js'
import { createDeliveredSweeper } from './src/delivered.js'
import { taskLabel } from './src/task-label.js'
import { createMainSession } from './src/main-session.js'
import { parseCoordinatorIds, serializeCoordinatorIds } from './src/coordinator-set.js'
import { createOnboarding } from './src/onboarding.js'
import { createDispatcher } from './src/dispatch.js'
// P0-2 写域 chokepoint：派发层（spawn/send/queue preflight）注入同一个判定闭包（唯一判定在 write-gate）。
import { decideDispatchGrant } from './src/write-gate.js'
// 写域瞬时占位：cleanup/终态要强清占位；合并/并列视图日志走同一个 logger。
import { releaseWriteHold, setWriteHoldLogger } from './src/write-hold.js'
import { normalizePath } from './src/write-guard.js'
// 清理 wrapper 的「有下游在等」判据与链式自动放行同源（只读台账）。
import { listWaitingDependents } from './src/deps.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'
import { legacyToolHint } from './src/tool-migrations.js'
import { createQueue } from './src/queue.js'
import { createStartupReconciler } from './src/reconcile.js'
import { createContextObserver, cleanupLegacyRotation, probeCompaction } from './src/main-context.js'
import { createMainNav, planCoordinatorNav } from './src/main-nav.js'
import { createIdleWatchdog } from './src/watchdog.js'
// 2026-11-23：子会话工具失败监听（只观察 tools/result，不改结果、不拦子会话自我纠错）。
import { createChildToolFailureWatcher } from './src/child-tool-failure.js'
import { createGoalBridge } from './src/goal.js'
import { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } from './src/host-route.js'
import { injectNotification } from './src/inject.js'
import { createLogger } from './src/log.js'
// P2-3 交接契约 v1：JSONL 事件（交付 / 确认）落 $DSH_HOME/state/orchestrator/handoff/。
import { createHandoffLog, emitHandoffDelivered, setHandoffSink } from './src/handoff.js'
// P2-4（D6）：官方 Team 板只读快照 + 确认交付时的 CAS 反写（服务缺失/未开启一律降级）。
import {
  confirmOnBoard, linkBoardTask, readTeamBoard, setTeamBoardSink, shouldReverseConfirm, teamLinkView,
} from './src/team-board.js'
import { loadPreferences, migrateLegacyPreferences, renderPreferenceBlock } from './src/preferences.js'
import {
  POLICY_DROP_ORDER, POLICY_MAX_CHARS_DEFAULT, POLICY_MINIMAL_SEGMENTS, POLICY_PROFILE_DEFAULT, POLICY_SEGMENT_NAMES,
  PRESENT_LIMIT_TEXT, renderAdvanceLoopPolicy, renderDecisionPolicy, renderParallelPolicy, renderTaskChainPolicy, renderWorkerPolicy,
} from './src/prompt-layers.js'
// P1-C 文案单源：协调者 policy 里的计划/交付口径引用 src/copy.js，避免与 L2/L3 说法漂移。
import {
  BLOCKER_RULE, CHANGE_REVIEW_FIELDS, PROGRESS_NOTICE_HINT, WORKTREE_CRITERIA, WRITE_GUARD_CRITERIA,
} from './src/copy.js'
import { startSnapshotLoop } from './src/snapshot.js'
import { ensureDigest } from './src/digest.js'
import { createPanelActions } from './src/panel-actions.js'
import { createWorkbench } from './src/workbench.js'
import { cleanupTaskWorktree, createWorktreeService } from './src/worktree.js'
import { BRANCH_TYPES } from './src/worktree-request.js'
// 0.32.0 能力包：内置公众号包 + 运行时预设注册（P0 GO；失败降级静态兜底）。
import { createPackStore } from './src/pack/store.js'
import { buildPresetDefinition } from './src/pack/preset-template.js'
import { createPresetRegistry, loadBuiltinPacks } from './src/pack/preset-registry.js'
import { isDesktopHost } from './src/pack/platform.js'
import { createInstaller } from './src/pack/install.js'
import { createPackService } from './src/pack/service.js'
import { createPackPanel } from './src/pack/panel.js'
import { persistedEnvPresence } from './src/pack/env.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agents', 'systemPrompt', 'subagents']

// 配置 schema：Cordis 从插件模块的 `Config` 导出读取，决定插件页上能看到/能改哪些字段。
// 字段规格的单一事实源在 src/config-fields.js；这里只做投影，不参与运行时归一化。
export { Config }

const COORDINATOR_INVALID_HINT = '主会话已失效，请从面板「打开主会话」重建。'
const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
const WAIT_AGENT_DENIAL = '协调者禁止阻塞等待：不要调用 wait_agent；查看进度用 task_list / task_status，本回合没有别的事就立即结束回合。'
// 硬规则段（L1 第 1 段）：**永不降级**。导出仅供 test/policy-budget.test.js 逐段计长（只读）。
export const COORDINATOR_POLICY = `你是 dsh-orchestrator 的协调者，只做编排：拆任务、派子会话、看回报、交付产物。硬性规则（优先于平台默认的 Team Lead 等待要求；交互判级见下「## 交互三闸门」）：

### 工具边界
- 派活只走 task_create；查进度只走 task_list / task_status。禁止使用 wait_agent、任何阻塞等待；不要 sleep、不要轮询；禁止 spawn_teammate / send_message / team_task_* 等团队工具（预设层删不掉，执行层会直接拒绝）。
- **看文件用原生 read**（只读，已挂），不枚举目录；不挂 glob/grep——批量检索/枚举派 readOnly:true。凭据（.credentials.yaml、.env、SSH key、token）不读、不转述、不写进产物。
- 官方 Team 板**只读**：关联时传 teamTaskId；交付确认由插件按 CAS 反写 complete，冲突只提示。
- 自动化只用 schedule_create / schedule_list / schedule_view / schedule_edit。Host-wide：增删改与暂停恢复需用户明确授权并确认时间/时区；只支持 target:this_session（创建者不在协调者名单时不可投递），new/new_once 不能直接 task_create；编辑用最新 updatedAt 作 expectedUpdatedAt。默认 worker 不开放自动化（subagent_session）。
- access:'full' 只改沙箱，不增加工具、不绕过委派校验或审批；与 readOnly/planFirst 互斥、仅本任务生效、不传孙任务。缺能力如实报告。

### 派发与交付
- **能直接回答就不派任务**：记忆/已知结论能答就直接回；新鲜取证、写文件或跨仓库证据才派发。判级见下「## 交互三闸门」。
- T2/T3 先 skill({ name: 'grill-me' }) 澄清（一次一问、每问带推荐、事实自查、最多 2 轮 8 问；决策记录写进 goal/constraints/user_verbatim）；grill ≠ 批准。
- **可以按需加载技能，只为判断怎么派活**：skill({ name })（技能目录＝名称＋摘要，由宿主注入上下文），一次 1–2 个，能直接回答的不加载；**只读不执行**：加载技能 ≠ 按技能步骤干活，读到的只写进 task_create 的 goal / constraints。
- 派发前用 context 查经验（省略 project 只查 global）；项目背景用 mode:'project'；长期决策用 memory_note。
- 同一需求用 group 归组，writeScopes 标写域，priority=-10..10；有依赖建 dependsOn、没依赖优先 worktree 并行——判据见下方两段。
- 有产物默认 present ${PRESENT_LIMIT_TEXT}产物（仅**已登记产物**的真实文件，绝对路径）；正文用 read_workspace({ path })，边界**主会话工作区 ∪ 已登记产物**，越界/穿越/符号链接逃逸一律拒；present 只声明交付，不校验存在性。
- 汇报**只用任务名 + 任务引用（tk-xxxxxx）**：首次或用户问「是哪个」时补引用，再次提到只写名称，不要只写 tk-xxxxxx。
- 子任务 done 是交付请求，进入「待确认」（delivered），**不是终态**：默认**保持待确认、不要主动 task_message({ action: 'close' })**；要改用 task_message 追问（复用同一个子会话）；不要问「任务能不能关闭」，也不要用 ask_user_question 追问「确认 / 要改？」催关闭；不确认就等超时自动完成，子任务保持待确认。
- **收到 progress 通知**：${PROGRESS_NOTICE_HINT}；用户问进度照报，要结论才追问。
- 需要看「待你决定/失败/长时间没动静」用 task_list({ view: 'inbox' })；数量/重复/冲突/状态先 task_list / task_status 取证。
- 协调者可以是多个（≤4，首位=主协调者）：名单成员都能派活、查台账；回报投给派它的协调者，创建者不在名单里时回落主协调者。
- 收到子任务通知再行动；本回合无事立即结束，通知会开启新回合。`

/**
 * P9：worktree 隔离的协调者指引（结构化配置渲染，**不解析自然语言**）。
 *
 * 三条职责边界（master-plan §4.0）：
 * - DSH 负责把用户级 + 工作区级 `AGENTS.md` 注入协调者上下文（`dsh-agent-instructions`）；
 * - 协调者据此判断「要不要建 / 基线 / 分支名」，转成 `task_create.worktree*` 结构化字段；
 * - 插件只做校验 + 执行（建检出、设 target、标注、清理），不读文件、不猜基线、不弹问。
 *
 * C2-3c：本段压成「标题 + 当前配置事实 + 一句判据（`src/copy.js` 的 `WORKTREE_CRITERIA`）+ 技能指针」。
 * 为什么（与 C2-3b 同一理由）：判断流程 5 步、required/auto/off 三档细则、needsBranchChoice、
 * 同检出不并发、cleanup 档位这些展开说明整段搬进 `skills/orch-worktree/SKILL.md`（逐字保留），
 * 每回合都在的 L1 只留「当前配置是什么 + 怎么判 + 去哪看细节」。动态配置值（policy / 窗口天数 /
 * 分支类型白名单）**必须仍渲染**——模型要据此判档，不能只留一句判据。
 */
export function renderWorktreePolicy(config = {}) {
  const policy = config.worktreePolicy ?? 'auto'
  const days = Number.isFinite(config.worktreeRecentDays) ? config.worktreeRecentDays : 7
  return `## worktree 隔离（插件策略，非硬拦截）
当前配置策略：${policy}｜分支类型 ${BRANCH_TYPES.join(' | ')}｜最近活跃窗口：${days} 天
${WORKTREE_CRITERIA}。`
}

/**
 * 同写域并发防护的协调者指引（结构化配置渲染，默认 require）。
 *
 * 默认档是**拒绝**（不再是 advisory），但不是不可绕过：三条出路
 * （task_message({action:'close'|'stop'}) 旧任务、worktree:true 隔离、显式 allowConcurrent:true）、
 * 判定对象与「delivered 不占目录」这些展开说明都在 `skills/orch-worktree/SKILL.md`；
 * C2-3c 起 L1 只留「当前档位 + 该档位的行为 + 一句判据（`WRITE_GUARD_CRITERIA`）+ 技能指针」。
 * 档位行为必须按实际配置渲染：判据句写的是「默认拒绝」，warn/off 档要靠这一行如实说明，
 * 否则提示词会与执行层行为互相矛盾。
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
${WRITE_GUARD_CRITERIA}。`
}

/**
 * 交互三闸门（开工前确认 → 执行期少打扰 → 变更先评估）。
 *
 * 为什么是独立一段而不是塞进 COORDINATOR_POLICY 的 bullet 列表：分级表 + 三档处置需要有结构，
 * 且要与 worktree/写域两段一样可单测、可整段回退；碎片化 bullet 读起来像清单，模型会跳过。
 *
 * 措辞分工：四类堵塞项与评估要素的**句子**在 `src/copy.js`（`BLOCKER_RULE` / `CHANGE_REVIEW_FIELDS`，
 * 与 brief / task_message 描述共用语），这里只写分级表与处置流程。
 */
export function renderInteractionPolicy() {
  return `## 交互三闸门（开工前确认 → 执行期少打扰 → 变更先评估）

先判级，再按级别做；同一需求后续轮次沿用已判级别，不重复确认。

| 级别 | 判据（任一命中） | 动作 |
|---|---|---|
| T0 直答 | 不动文件、不跑命令 | 直接回复用户，不派任务 |
| T1 直接做 | 单点改动、可回退、不动用户数据、不碰远端，目标与验收不用解释 | 先用记忆/上下文补事实，不提问；回复里写一句「我的理解：…，按这个做」，再派发 |
| T2 先确认 | 命中 1 条：需求给的是现象不是期望（「报表是空的」）/ 有 2 个以上可行方案且代价不同 / 会改用户看得见的默认行为 / 目标或验收有歧义 | 只读调研 → 回一句初步结论 + ask_user_question（2–4 个选项，每项带我的建议）→ 确认后再派发 |
| T3 先计划 | 任一条：跨仓库或跨工作区 / 要动 5 个以上文件 / 重构·替换·迁移 / 不可逆（删数据、覆盖历史、强推）/ 要推远端或发布 / 要写仓库外；或命中 2 条 T2 | task_create({ planFirst: true }) 只读探索 → plan_save 落盘 → 用户拍板 → 才实现 |

- **T1 不是「不问就干」**：不可逆动作永远不算 T1（最低 T2）；用户说「你看着办」至多把 T2 降一档，不可逆仍必须拍板。
- **确认只做一次**：T2/T3 的消息写全「意图 + 做法 + 要你定的点（带建议）」；用户答完就进执行期，不重问同一件事。
- **T3 可多轮**：探索、头脑风暴、风险评估都用 task_message 追问同一个计划子会话；不要为心里没底新派任务试错。
- **执行期只在四类堵塞项上打断用户**（B1–B4）：${BLOCKER_RULE}。
- **只在真正需要拍板时提问**：不可逆操作、权限与远端写授权先获明确授权；必须用 ask_user_question 结构化提问（question + 2–4 个 options），不得用纯文字问句代替。
- **不算堵塞项**（不打扰）：进度与交付汇报、任务能否关闭、命名/文案/顺序这类计划给得出默认值的细节、自己查得清的事实、能回退的取舍、刚问过且用户没改口的事。
- **一个堵塞项只问一次**：问题 + 2–4 个选项 + 建议。待拍板项按「一项一问」逐项问（见下「## 拍板流程」），其余堵塞项合成一条清单一次问完；B2 与计划批准必须等明确答复，不代批。
- **少打扰只针对「不用拍板的进展汇报」**；**「少打扰」是执行期口径，不是开工前不问**：开工前的意图确认（T2/T3）与变更按本段处理，与直答、不催关闭不矛盾。
- **用户追加调整（计划或方向已确认之后）**：先评估、再确认、最后才通知子任务，顺序不能换。
  1. **评估三行**：${CHANGE_REVIEW_FIELDS}——影响面先 task_list 看 group 与 dependsOn、必要时 task_status 看验收；建议在「按原计划继续 / 增量追加 / 停下重派」里选一个。
  2. **按影响分档**：R0 只补细节、不动验收与已交付结论 → 直接 task_message 转给原会话，下一条汇报里写清改了哪里（不打扰用户）；R1 动到验收/范围/方案 → 先给评估 + ask_user_question 拿确认；R2 不可逆、权限、推翻已交付结论、换 target 或仓库 → 必须拍板，不可逆项先等授权。
  3. **确认后才通知子任务**：追加消息里写「新方向 / 不动的部分 / 验收是否变」，并要求先回影响面再动手；不要用一句「追加」代替评估，更不要借追加把计划批准掉（追加不能替代评估或显式计划批准）。`
}

/** 降级告警去重（进程级，按段 id / 一次性 key）：同一段只 warn 一次，避免每回合刷屏。 */
const policyDropWarned = new Set()

/** 测试用：清空降级告警去重表（去重是进程级的，会跨用例生效）。 */
export function resetPolicyDropWarnings() {
  policyDropWarned.clear()
}

/** 按**字符**（码点）计长：`policyMaxChars` 的口径与用户直觉一致，不用 UTF-16 长度。 */
const policyChars = text => [...text].length

/**
 * 协调者系统提示 = 固定规则 + 结构化配置渲染（worktree 策略等）。
 *
 * C3：两档 profile + 字符预算。
 * - `promptProfile`：`full`（默认，八段全渲染）/ `minimal`（只留硬规则 + 拍板流程两段不可逆闸门）；
 * - `policyMaxChars`：超预算时按 `POLICY_DROP_ORDER` 依次丢段（并行→任务链→worktree→写域→推进循环→三闸门），
 *   **硬规则段与拍板流程段永不丢**（丢它们的代价是不可逆动作被绕过），每丢一段 warn 一次（进程级去重）。
 *
 * 为什么降级而不是「渲染失败/报错」：policy 是每回合注入的上下文，宁可少讲一条判据，
 * 也不能因为预算配置写小了就让协调者拿到空 policy（那等于把工具禁令也一起丢掉）。
 */
export function renderCoordinatorPolicy(config = {}) {
  // 拼接顺序：硬规则 → 交互闸门 → 拍板流程 → 推进循环 → 任务链 → 并行策略 → worktree → 写域。
  // 三闸门回答「什么时候可以打断用户」，拍板流程回答「打断时怎么问」（逐项/不合成总批准/四选一），
  // 推进循环回答「回报之后必须做什么」（两者不能互相顶替：只记住「少打扰」会把「不推进」当成合规），
  // 任务链回答「有先后关系时怎么派」，并行策略回答「没依赖时不要排队、优先隔离并行」——
  // 两者是一对判断（有依赖才建链，无依赖就并行），所以紧挨着，并排在隔离/写域判定之前
  // （同一检出不并发的规则要落在 worktree 段之前才读得到）。
  const segments = [
    { id: 'hard', text: COORDINATOR_POLICY },
    { id: 'gates', text: renderInteractionPolicy() },
    { id: 'decision', text: renderDecisionPolicy() },
    { id: 'advance', text: renderAdvanceLoopPolicy() },
    { id: 'chain', text: renderTaskChainPolicy() },
    { id: 'parallel', text: renderParallelPolicy() },
    { id: 'worktree', text: renderWorktreePolicy(config) },
    { id: 'writeGuard', text: renderWriteGuardPolicy(config) },
  ]
  const profile = config.promptProfile === 'minimal' ? 'minimal' : POLICY_PROFILE_DEFAULT
  const kept = profile === 'minimal'
    ? segments.filter(segment => POLICY_MINIMAL_SEGMENTS.includes(segment.id))
    : segments
  const budget = Number.isFinite(config.policyMaxChars) ? config.policyMaxChars : POLICY_MAX_CHARS_DEFAULT
  const dropped = new Set()
  const render = () => kept.filter(segment => !dropped.has(segment.id)).map(segment => segment.text).join('\n\n')
  for (const id of POLICY_DROP_ORDER) {
    if (policyChars(render()) <= budget) break
    const segment = kept.find(item => item.id === id)
    if (segment === undefined) continue
    dropped.add(id)
    if (policyDropWarned.has(id)) continue
    policyDropWarned.add(id)
    console.warn(`dsh-orchestrator: 协调者 policy 超出 policyMaxChars=${budget}，已丢弃「${POLICY_SEGMENT_NAMES[id]}」段`
      + `（${policyChars(segment.text)} 字符，展开版见 skills/orch-*/SKILL.md）；本次进程只提示一次，需要完整段请提高 policyMaxChars`)
  }
  const text = render()
  // 可降级段丢完仍超预算（minimal 档或预算小于「硬规则 + 拍板流程」）：如实提示，但不丢不可逆闸门。
  if (policyChars(text) > budget && !policyDropWarned.has('over-budget')) {
    policyDropWarned.add('over-budget')
    console.warn(`dsh-orchestrator: 协调者 policy 仍有 ${policyChars(text)} 字符，超出 policyMaxChars=${budget}`
      + '——可降级段已丢完，硬规则段与拍板流程段永不降级')
  }
  return text
}

// 协调者只做协调：这些是**编排正确性**上不该由协调者做的事（派队友/团队板会绕过 task_create 的台账与
// 依赖编排；插件管理与密钥/IM 属于宿主运维面）。
//
// 0.26.0（t-48e8ce06）起这里**不再**是「协调者能调什么」的完整清单；t-4f7ce108 起协调者的只读工具面
// 收窄成**只有 read**（glob/grep 随 tool-fs-search 行一起从预设移除：协调者一有搜索就会自行调研、
// 绕过派发）。写与执行不靠名单——协调者预设没挂 tool-bash/tool-pwsh，tool-fs 只开 read，写路径另有
// 钉死的 read-only 权限预设（沙箱写全拒）兜底。角色专属的三个子会话工具（task_report / task_detail /
// plan_save）从这份名单移出，改由协调者预设的 preset-tools deny 遮掉（工具表里看不到），
// 执行层各自再校验归属。
// present / read_workspace / skill / ask_user_question / schedule_* 都不在名单里（协调者要用）。
export const COORDINATOR_DENY = [
  'wait_agent',
  'spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  // 宿主全局工具 `working_directory`（@deepseek-ai/dsh-tool-working-directory）会改协调者会话的 cwd，
  // 而 cwd 是指挥锚：`task_create` 不给 target 时子会话继承父会话 cwd、工作区/写域判定、
  // 记忆项目键推断都以它为准——会话内切目录会让这些锚点静默漂移。看文件不需要它
  // （read 收绝对路径），所以预设层与执行层都遮掉（0.26.0 发版前真机复验补漏）。
  'working_directory',
  'request_secret', 'request_connector',
  'list_bots', 'message_bot', 'post_to_group',
  'create_bot', 'create_group', 'delete_group', 'update_group', 'update_bot',
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
  // 0.36.0 多协调者：名单与镜像键自愈（幂等、只写 settings、绝不建会话/改会话）。
  //   - 名单里有非法项/重复/超上限 → 清洗后重写（`main.session.ids-sanitized`）；
  //   - 名单存在但 `main_session_id` 不是首位（手改/降级残留）→ 以名单为准修复（`main.session.ids-repaired`）。
  // 名单缺失时什么都不做：读路径会回落老的 `main_session_id`（存量单协调者零迁移）。
  try {
    const rawList = getSetting(db, 'main_session_ids')
    if (rawList !== undefined) {
      const mirrorBefore = getMainSessionId(db)
      const parsed = parseCoordinatorIds(rawList)
      const expected = parsed[0]
      if (serializeCoordinatorIds(parsed) !== rawList) {
        setCoordinatorIds(db, parsed)
        logger.log('main.session.ids-sanitized', { detail: { ids: parsed, raw: String(rawList).slice(0, 200) } })
      }
      const mirrorDirty = expected === undefined
        ? mirrorBefore !== undefined && mirrorBefore !== ''
        : mirrorBefore !== expected
      if (mirrorDirty) {
        setCoordinatorIds(db, parsed)
        logger.log('main.session.ids-repaired', { detail: { mirror: mirrorBefore ?? null, primary: expected ?? null, ids: parsed } })
      }
    }
  } catch (error) {
    warnings(`dsh-orchestrator: 协调者名单自愈失败（不影响加载）：${error?.message ?? error}`)
  }
  // 0.25.1：旧版 `memory_note(kind:'preference', 不传 project)` 写在 memories 的死数据一次性搬进 settings
  // （渲染侧只读 settings，那几条以前永不生效）。幂等标记在 settings；失败不阻断加载、下次启动重试。
  try {
    migrateLegacyPreferences({ db, log: (event, fields) => logger.log(event, fields) })
  } catch (error) {
    warnings(`dsh-orchestrator: 旧偏好迁移失败（不影响加载，下次启动重试）：${error?.message ?? error}`)
  }
  // 宿主自检（只诊断）：版本落在声明基线外时 warn 一次。真正拦人的是宿主：`package.json` 的
  // `engines.dsh` 会让宿主在**装载前**禁用本插件（装的时候拒装、启动的时候行被禁用），所以这条 warn
  // 基本只在「profile 的 compatibility.json 给了精确豁免」「本地 link / 非 profile 加载」时看得见。
  // 保留它的理由：那种场景下要能一眼看到实际版本与区间，而不是静默跑在未知形状上。
  const hostVersion = host.version()
  if (hostVersion.status === 'below' || hostVersion.status === 'above') {
    warnings(`dsh-orchestrator: 宿主版本 ${hostVersion.version} ${hostVersion.status === 'below' ? '低于' : '高于'}声明的兼容基线 ${hostVersion.baseline}：本行说明插件是在豁免 / 非 profile 加载下跑起来的，接口形状可能已变；升级/降级宿主后先跑 docs/compat.md 的冒烟 3 条`)
  }

  // ── 能力包（0.32.0，P2）────────────────────────────────────────
  // 内置包随插件只读发；预设走运行时注册（P0 门禁 GO），失败降级为静态 YAML（export-static）。
  // 能力包会话是普通根会话：这里的注册只加预设，不碰台账/队列/派发语义。
  const packStore = createPackStore({ stateDir: dir, log: (event, fields) => logger.log(event, fields) })
  // 删包时若包会话仍开着，Windows 的 skill watcher 会占住目录（rename EPERM）：
  // 那时只撤预设/registry，目录延后到没人持有时清理；启动就是最稳的清理时机。
  try { packStore.purgeUnregistered() } catch (error) {
    warnings(`dsh-orchestrator: 能力包目录清理失败（下次启动再试）：${error?.message ?? error}`)
  }
  const presetRegistry = createPresetRegistry({
    agentPresets: () => host.service('agentPresets'),
    onWarn: warnings,
    log: (event, fields) => logger.log(event, fields),
  })
  const capabilityPacksDesktop = isDesktopHost()
  const builtinPackState = []
  if (config.capabilityPacks === false) {
    logger.log('pack.disabled', { detail: { by: 'config' } })
  } else if (!capabilityPacksDesktop && config.capabilityPacksAllowOnWeb !== true) {
    logger.log('pack.platform-unsupported', { detail: { by: 'desktop-only' } })
  } else {
    for (const builtin of loadBuiltinPacks()) {
      if (builtin.manifest === undefined) {
        warnings(`dsh-orchestrator: 内置能力包 ${builtin.id} 不可用（跳过注册）：${builtin.errors.join('；')}`)
        continue
      }
      if (builtin.errors.length > 0) {
        warnings(`dsh-orchestrator: 内置能力包 ${builtin.id} 技能文件不完整（包仍可注册，缺失技能不可用）：${builtin.errors.join('；')}`)
      }
      const definition = buildPresetDefinition({
        manifest: builtin.manifest,
        packRoot: builtin.packRoot,
        installStatePath: packStore.installStatePath(builtin.id),
        stateDir: dir,
      })
      const registered = await presetRegistry.register(definition)
      if (registered.ok !== true) {
        warnings(`dsh-orchestrator: 能力包预设 ${builtin.id} 未运行时注册：${registered.error}（可用 capability_pack({action:'export-static'}) 导出兜底）`)
      }
      builtinPackState.push({
        id: builtin.id,
        packRoot: builtin.packRoot,
        manifest: builtin.manifest,
        definition,
        mode: registered.mode,
        error: registered.error,
      })
    }
  }

  // 状态迁移的审计日志（审计 §4.5）：`transition` 是唯一入口，在这里挂一次观察者就覆盖全部 19 个调用点，
  // 从此「这个任务为什么从 running 变 orphaned」能直接从日志还原，不必靠 settle 消息反推。  // P2-3 交接契约 v1：进入 delivered 的**唯一**入口也在这里 → `task.handoff.delivered` 只写一次
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
  // 确认侧（四条路径共用 closeDelivered，含链式自动放行）走同一个进程级 sink：交付事件也从这里出，
  // 少一处「忘接就不发事件」的可能（与上面观察者是同一套做法）。
  const disposeHandoffSink = setHandoffSink(handoffLog)
  // P9：宿主侧 git 能力（只在 worktree 任务上被调用；普通任务零 git 调用）。
  const worktreeLog = (event, fields) => logger.log(event, fields)
  const worktreeService = createWorktreeService({
    recentDays: config.worktreeRecentDays,
    log: worktreeLog,
  })
  // 终态清理（默认 off）：只清台账里有记录的那份检出，失败只记日志、不影响任务终态。
  //
  // **唯一 wrapper + 只登记**（v5 §5.1 / v6 Z4）：所有调用点（settlement onTerminal / closeDelivered /
  // 面板 stop / 派发失败 / chain-auto；tool stop 也走这里）都只调它，判据集中在这一处：
  // - 有 `waiting_dep` 下游在等 → 不删（下游很可能 `worktreeMode:'continue'` 复用这份检出）；
  // - 检出被另一条活跃任务共享 → 不删（删了另一个任务就写丢了）；
  // - 命中只写 `task.worktree.cleanup.registered`（进程内同任务去重），不动磁盘；
  // - 未命中才按 `brief.worktreeCleanup` 档位清（默认 off = 保留）。
  const registeredCleanups = new Set()
  const cleanupDeferReason = task => {
    const path = typeof task.worktree_path === 'string' ? task.worktree_path.trim() : ''
    // 没有检出就没有「延后清理」这回事（清理本体自己会 skip）。
    if (path === '') return null
    try {
      if (listWaitingDependents(db, task.id).length > 0) return 'waiting-dependent'
    } catch { /* 判据读失败按「没下游」处理，清理本体仍按档位 */ }
    try {
      const wanted = normalizePath(path)
      const shared = listTasks(db, { active: true })
        .some(other => other.id !== task.id && normalizePath(other.worktree_path ?? '') === wanted)
      if (shared) return 'shared-checkout'
    } catch { /* 同上 */ }
    return null
  }
  const cleanupWorktree = task => {
    if (task === undefined || task === null) return
    const reason = cleanupDeferReason(task)
    if (reason !== null) {
      if (registeredCleanups.has(task.id)) return
      registeredCleanups.add(task.id)
      try {
        logger.log('task.worktree.cleanup.registered', {
          taskId: task.id,
          detail: { path: task.worktree_path ?? null, reason },
        })
      } catch { /* 日志失败不影响清理判定 */ }
      return
    }
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

  // 0.36.0 多协调者：名单是唯一真源（首位 = 主协调者）。配置 `coordinatorSession` 覆盖成单元素。
  const resolvedCoordinatorIds = () => getCoordinatorIds(db, config.coordinatorSession)
  const resolvedCoordinatorId = () => resolvedCoordinatorIds()[0]
  const isChildLive = sessionId => host.agents()?.get?.(sessionId) !== undefined
  const resolveCoordinator = () => {
    const id = resolvedCoordinatorId()
    return id === undefined ? undefined : host.agents()?.get?.(id)
  }
  /** 按会话 id 取活着的协调者 agent（0.36.0：通知/派发可能指向名单里的任意一个）。 */
  const coordinatorAgentOf = id => (typeof id === 'string' && id !== '' ? host.agents()?.get?.(id) : undefined)
  // status 的两条 live 口径要分清：
  //   - `live`：**主协调者**是否在线（面板「主会话在线/已失效」用它，语义与旧版一致）；
  //   - `anyLive`：名单里**任意**一个在线（task_* 的失效提示用它——副协调者在跑也算可用）。
  const coordinatorStatus = () => {
    const ids = resolvedCoordinatorIds()
    const agents = host.agents()
    const liveIds = ids.filter(id => agents?.get?.(id) !== undefined)
    return {
      id: ids[0],
      ids,
      live: ids.length > 0 && liveIds.includes(ids[0]),
      anyLive: liveIds.length > 0,
      coordinators: ids.map((id, index) => ({ id, primary: index === 0, live: liveIds.includes(id) })),
    }
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
  // 确认反写的进程级 sink：工具 / 面板 / 超时 / 链式自动放行四条路径共用 `closeDelivered`，这里接一次就全覆盖。
  // 失败只 warn + 记日志，绝不回滚本地 done（`closeDelivered` 早已把状态落库）。
  // **不是人的确认就不反写**：`acceptedBy='timeout'`（超时自动完成）与 `acceptedBy='chain'`
  // （`task_create.chain:'auto'` 的链式自动放行）都只记一条 `team.board.skipped` 留痕，不动官方板。
  const disposeTeamBoardSink = setTeamBoardSink((task, context) => {
    if (!shouldReverseConfirm(context?.acceptedBy)) {
      const reason = context?.acceptedBy === 'chain' ? 'chain' : 'timeout'
      if (typeof task.team_task_id === 'string' && task.team_task_id !== '') {
        logger.log('team.board.skipped', {
          taskId: task.id,
          detail: {
            code: reason === 'chain' ? 'TEAM_BOARD_CHAIN' : 'TEAM_BOARD_TIMEOUT',
            reason,
            message: reason === 'chain'
              ? '链式自动放行不是人的确认，不反写官方 Team 板'
              : '超时自动完成不是人的确认，不反写官方 Team 板',
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
    if (agent === undefined || !resolvedCoordinatorIds().includes(agent.id)) return ''
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
  // P1 正文去重（0.30.1）：台账只存借条，正文按需从宿主会话日志冷读。
  // 这里是**唯一**装配点（tools / 面板 detail 共用同一个读取器与缓存），读不到一律降级为摘要。
  const bodySource = createBodySource({
    sessions: () => service('sessions'),
    sessionPersistence: () => service('sessionPersistence'),
    logger: { warn: warnings },
  })
  // 0.25.0：上下文观测 + 压力提醒（**只读 + 只提问**：不调 compactNow、不自动换会话）。
  // 观测在「打开主会话」后异步跑一次；压力到 `contextPressureThreshold` 时用宿主 userQuestions 弹问题卡。
  // 用户选「新建协调者会话」才代建（requestNewCoordinator → mainSession.createCoordinatorSession）。
  // t-a79e12d8：代建/切指针后的「跳到新会话」只能客户端做（宿主 uiWorkspace.openSession 在浏览器里），
  // 所以这里只记一条进程内待办（main-nav 端点轮询），服务端不假装能导航。
  let mainSession
  const mainNav = createMainNav({ log: (event, fields) => logger.log(event, fields) })
  const contextObserver = createContextObserver({
    db,
    config,
    tokenMeter: () => service('tokenMeter'),
    persistence: () => service('sessionPersistence'),
    sessionQuery: () => service('sessionQuery'),
    agentPresets: () => service('agentPresets'),
    sessions: () => service('sessions'),
    userQuestions: () => service('userQuestions'),
    // 有非终态任务时延后提醒（不弹卡、不写 asked、不占 band）：在跑任务的回报还投给旧协调者会话。
    activeTasks: () => listTasks(db, { active: true }),
    requestNewCoordinator: async () => {
      const result = await mainSession?.createCoordinatorSession?.({ source: 'pressure-reminder' })
      // 成功 → 一条「跳到新会话」待办；失败 → 一条可读提示（旧主会话保持不动，指针没切）。
      const pending = planCoordinatorNav(result)
      if (pending !== null) mainNav.publish(pending)
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
    const ids = resolvedCoordinatorIds()
    if (agent !== undefined && ids.includes(agent.id)) {
      scheduleRestriction(agent)
      // UI 可能 rebind default；待欢迎会话由onboarding先等待预设恢复再启动。
      void onboarding.start(agent.id)
        .then(result => { if (result.ok === false) warnings(`dsh-orchestrator: ${result.error}`) })
        .catch(error => warnings(`dsh-orchestrator: 首次介绍启动失败：${error?.message ?? error}`))
      void mainSession.guardPreset?.(agent).catch(error => warnings(`dsh-orchestrator: 主会话预设守护失败：${error?.message ?? error}`))
      // C：协调者权限预设钉只读（新建/代建时已钉；这里兜住重启恢复、adopt 前晚加载、以及升级前
      // 建的旧主会话——徽标与协调者实际工具面保持一致）。0.36.0：名单里**每个**成员都补钉。
      // 服务缺失/失败只记日志，不影响加载。
      try { mainSession.pinPermission?.(agent.id, agent.session) } catch (error) {
        warnings(`dsh-orchestrator: 主会话权限钉只读失败：${error?.message ?? error}`)
      }
      // 日报只跟**主协调者**：副协调者加载时不重建日报（避免每个都挂一条）。
      if (agent.id === ids[0]) {
        void ensureDigestFor(agent.id).catch(error => warnings(`dsh-orchestrator: 日报 schedule 初始化失败：${error?.message ?? error}`))
      }
      // 协调者可能比插件晚加载：队列在等它，加载后立刻补跑，并对一次子会话目录。
      queue?.pump()
      // 协调者晚加载：再对一次账（按整份名单并集），并补发启动时没送出去的孤儿汇总。
      reconciler?.reconcile({ coordinatorIds: ids })
        .then(() => queue?.pump())
        .catch(error => warnings(`dsh-orchestrator: 重启对账失败：${error?.message ?? error}`))
    }
  })
  ctx.on?.('agent/status', ({ agent, status }) => {
    if (agent === undefined || status !== 'idle' || !resolvedCoordinatorIds().includes(agent.id)) return
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
  // 名单只覆盖「编排正确性」（派队友/团队板/插件/密钥/IM）：读写工具不在这里，读由原生 read
  // 与 read_workspace 提供（glob/grep 已随 tool-fs-search 行从预设移除：搜索类工作走 task_create），
  // 写没有工具（预设没挂 tool-bash/tool-pwsh，tool-fs 只开 read）。
  const DENY_HINT = toolName => `${toolName} 是协调者禁止的工具：协调者只做协调（派活走 task_create，查进度 task_list / task_status），不派队友、不操作团队任务板、不管理插件或密钥、不发 IM。看文件用 read（只读），看产物正文用 read_workspace，交付用 present。`
  const guardDisposer = ctx.tools?.guard?.(exec => {
    const toolName = exec?.name
    if (typeof toolName !== 'string') return undefined
    // P1-B：旧工具名已从工具表删除，但**不静默**——模型照旧 AGENTS.md / 旧提示词调 task_stop 之类时，
    // 执行层直接把「改成什么调用」返回给它（映射表单源 src/tool-migrations.js，CHANGELOG/README 同一份）。
    // 不限 agent：子会话拿到同样的提示也不坏事（它本来就没有这些工具）。
    const migration = legacyToolHint(toolName)
    if (migration !== undefined) return migration
    if (!COORDINATOR_DENY.includes(toolName)) return undefined
    if (exec?.agent?.id === undefined || !resolvedCoordinatorIds().includes(exec.agent.id)) return undefined
    return toolName === 'wait_agent' ? WAIT_AGENT_DENIAL : DENY_HINT(toolName)
  })

  // W1（t-4f7ce108）：任务子会话的 per-turn policy。子会话 id → 任务 id 的快照在派发被接受时记下，
  // 台账 `tasks.session_id` 是**唯一真相**，映射只是「首回合台账还没写 session_id」的兜底
  // （`transition(db, id, 'running', { sessionId })` 在 spawn 返回后立刻写）。
  const workerTasks = new Map()
  const workerTaskOf = agentId => {
    if (typeof agentId !== 'string' || agentId === '') return undefined
    const mapped = workerTasks.get(agentId)
    if (mapped !== undefined) {
      const task = getTask(db, mapped)
      if (task !== undefined) return task
      workerTasks.delete(agentId)
    }
    return findTaskBySession(db, agentId)
  }

  // 系统提示只给当前已绑定的协调者；按回合动态渲染，非协调者返回空。
  const promptDisposer = ctx.systemPrompt?.context?.({
    name: 'orchestrator:coordinator-policy',
    order: 130,
    interpolate: false,
    text: context => {
      const agentId = context?.agent?.id
      if (agentId === undefined || !resolvedCoordinatorIds().includes(agentId)) return ''
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

  // W1 单独注册（order 在 L1 之后一位）：两条 context 各自按 agent id 判定，互不覆盖——
  // 协调者只拿 L1，任务子会话只拿 W1，其它会话（不含任务子会话、也不是协调者）两条都空。
  const workerPromptDisposer = ctx.systemPrompt?.context?.({
    name: 'orchestrator:worker-policy',
    order: 131,
    interpolate: false,
    text: context => {
      const agentId = context?.agent?.id
      if (agentId === undefined || resolvedCoordinatorIds().includes(agentId)) return ''
      const task = workerTaskOf(agentId)
      if (task === undefined) return ''
      return renderWorkerPolicy({ worktreeState: task.worktree_state })
    },
  })

  let queue
  // 启动对账器（S2）：标记「台账在跑、实际没人在跑」的孤儿并汇总上报。
  // 在 notifier 之后创建；agent/created 可能先于赋值触发，所以按可选调用。
  let reconciler
  // 结算上报器：子会话结束/中断时把台账从 running 推到终态（S1）。
  // 队列/派发器后面才创建，这里用惰性引用；事件可能早于赋值，所以都走可选调用。
  let settlement
  // P0-2：写域判定闭包（唯一判定在 write-gate；这里只补 db + 配置档位）。
  // 任务不在台账（非编排会话）→ 放行；只读 / 显式 allowConcurrent → 放行。
  // `directory` 透传（v6 Z5）：非 isolated / 无 target 的 fallback 判定要用「本次真正派发的目录」。
  const writableRootJudge = ({ taskId, directory } = {}) => decideDispatchGrant({ db, taskId, directory, mode: config.sameDirGuard })
  // 写域占位的合并/并列视图只留日志（判定本身不依赖日志；失败也不影响占位）。
  setWriteHoldLogger((event, fields) => logger.log(event, fields))
  const dispatcher = createDispatcher({
    subagents: host.subagents(),
    getAgent: resolveCoordinator,
    // 0.36.0：派发/投递的 parent 按**任务的协调者**取（名单成员各自派各自的任务）。
    agentById: coordinatorAgentOf,
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
    writableRootJudge,
    artifactDirectoryOf: taskId => getTask(db, taskId)?.artifact_dir,
    artifactProtectionJudge: ({ taskId, session, target, access }) => {
      let policy
      const full = access === 'full' || getTask(db, taskId)?.access === 'full'
      try { policy = service('sandboxPolicy')?.resolve?.({ session, mode: full ? 'danger-full-access' : 'workspace-write' }) } catch { /* fail closed */ }
      return artifactProtection({ store: join(dir, 'artifact-store'), policy, target })
    },
    onEvent: (event, fields) => {
      logger.log(event, fields)
      // W1：派发被接受时先记下「子会话 id → 任务 id」，首回合就能拿到 agent policy（不等台账回写）。
      if (event === 'subagent.spawn.accepted') {
        const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : ''
        const taskId = typeof fields.taskId === 'string' ? fields.taskId : ''
        if (sessionId !== '' && taskId !== '') workerTasks.set(sessionId, taskId)
      }
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
        void reportSettle({ taskId: fields.taskId, sessionId: fields.sessionId, stopReason: 'error', error: fields.detail?.error, source: 'dispatcher' })
      }
      // 子会话结算 = 并发槽位释放，唤醒队列补位。
      // 收集完成后由结算器唤醒队列。
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
    // 0.36.0（多协调者，用户拍板决策 1）：单任务通知投给**派它的那个协调者**。
    // 这里只按台账给出「任务的协调者」；它是否仍在名单/是否在线由 send 兜（离线回落主协调者 + 审计）。
    targetOf: item => {
      const taskId = item?.taskId
      if (typeof taskId !== 'string' || taskId === '') return undefined
      const owner = getTask(db, taskId)?.coordinator_session
      return typeof owner === 'string' && owner !== '' ? owner : undefined
    },
    send: (text, items, target) => {
      const ids = resolvedCoordinatorIds()
      if (ids.length === 0) {
        warnings('dsh-orchestrator: 尚未打开主会话，通知已跳过')
        return { skipped: true, reason: '尚未打开主会话，无法投递通知。' }
      }
      const sender = items.map(item => item.sender).find(value => value !== undefined)
      const systemOnly = sender === undefined && items.length > 0 && items.every(item => item.system === true)
      if (sender === undefined && !systemOnly) {
        warnings('dsh-orchestrator: 通知缺少发送方 agent，已跳过投递')
        return { skipped: true, reason: '通知缺少发送方 agent。' }
      }
      // 目标解析：任务的创建者（显式 target）→ 仍在名单且在线就用它；
      // 否则回落主协调者并留一条 `notify.route.fallback` 审计（reason: not-coordinator | not-live）。
      const primary = ids[0]
      const wanted = typeof target === 'string' && target.trim() !== '' ? target.trim() : undefined
      let targetId = wanted !== undefined && ids.includes(wanted) ? wanted : primary
      let fallback = wanted === undefined ? null : (targetId === wanted ? null : 'not-coordinator')
      let injected = coordinatorAgentOf(targetId)
      if (injected === undefined && targetId !== primary) {
        fallback ??= 'not-live'
        targetId = primary
        injected = coordinatorAgentOf(primary)
      }
      if (fallback !== null) {
        logger.log('notify.route.fallback', {
          detail: {
            wanted: wanted ?? null,
            fallback: targetId,
            reason: fallback,
            taskIds: items.map(item => item.taskId ?? null),
          },
        })
      }
      if (injected === undefined) {
        warnings(`dsh-orchestrator: ${COORDINATOR_INVALID_HINT}`)
        return { skipped: true, reason: COORDINATOR_INVALID_HINT }
      }
      // 直接对协调者会话 steer：与 TeamService 给 lead 投递时内部做的事同构，
      // 但不要求发送方此刻还在 roster，所以 5 秒合并窗口后仍能送达。
      // 注入失败不在这里吞掉：交给 notifier 记 failed + reason，而不是 skipped。
      // 系统通知（例如任务派发失败）没有子会话 sender，用目标协调者自身的 id 作为来源。
      injectNotification(injected, { text, senderId: sender === undefined ? targetId : sender.id })
      return true
    },
  })

  // 2026-11-23：子会话工具失败监听（`tools/result` 观察者）。子会话的权限/沙箱拒绝原本在编排面上是
  // 不可见的（协调者只拿得到 task_report 的 summary），这里把它变成一条日志 + 一条去重通知。
  // 只观察、不改结果；判定顺序与误报边界见 src/child-tool-failure.js 文件头（**不要求 exitCode !== 0**）。
  const toolFailure = createChildToolFailureWatcher({
    logger,
    notifier,
    // 归属：派发被接受时的「子会话 id → 任务」映射 + 台账 session_id 兜底（index.js 上方的 workerTaskOf）。
    taskOfAgent: workerTaskOf,
    // 协调者自己的工具调用（例如只读 read 被沙箱拒）不进编排面：与 guard、W1 注入同一条判据。
    // 0.36.0：名单里**每个**成员都要排除（副协调者也是协调者）。
    coordinatorIds: resolvedCoordinatorIds,
    labelFor: task => taskLabel(task, { all: listTasks(db) }),
    onWarn: warnings,
  })
  const toolFailureDisposer = typeof ctx.on === 'function'
    ? ctx.on('tools/result', (exec, result) => toolFailure.handle(exec, result))
    : undefined

  queue = createQueue({ db, dispatcher, config, logger, notifier, worktree: worktreeService, cleanupWorktree, writableRootJudge })

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

  settlement = createSettlementReporter({
    db,
    notifier,
    logger,
    senderOf: id => service('agents')?.get?.(id),
    labelFor: task => taskLabel(task, { all: listTasks(db) }),
    // B1：超 64KB 的返回消息写这里（按需创建，启动时不建目录）。
    reportsDir: join(dir, 'reports'),
    releaseSession: target => dispatcher.releaseWritableRoots?.(target),
    pump: () => queue?.pump(),
    // G1：结算自动收场时收敛平台 goal：done → complete；其余终态（cancelled/failed/orphaned）→ clear。
    onTerminal: (task, status) => {
      void (status === 'done' ? goalBridge.complete(task.id, task.session_id) : goalBridge.clear(task.id, task.session_id))
      // S10'：终态允许无 token 强清该任务的写域占位（在途投递已随会话收口）。
      try { releaseWriteHold(task.id) } catch { /* 占位释放失败只影响 TTL */ }
      // P9：终态按 worktreeCleanup 档位清理检出（默认 off = 全保留）；wrapper 判 defer（有下游/共享 → 只登记）。
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

  // 两个生命周期来源共用同一个 promise；只有保存完成后结算器才能释放工作占用。
  const artifactDelivery = createArtifactDelivery({
    db, settlement,
    sessionOf: id => service('agents')?.get?.(id)?.session ?? service('sessions')?.get?.(id),
    workspaceChanges: () => service('workspaceChanges'),
    mainDir: () => resolveCoordinator()?.session?.header?.cwd ?? join(dir, 'workspace'),
    log: (event, fields) => logger.log(event, fields),
  })
  function reportSettle(input) {
    return artifactDelivery.report(input)
  }

  // 平台生命周期事件：续派/冷恢复起的新 activation 不走 dispatch 的 track，只有 subagent/end 能看到。
  // 和派发侧事件重叠到达时，第二次会因为任务已不在 running 被跳过（状态机天然幂等）。
  const settleDisposer = typeof ctx.on === 'function'
    ? ctx.on('subagent/end', info => {
      if (info?.local !== true || info?.id === undefined) return
      return reportSettle({
        sessionId: String(info.id),
        stopReason: info.stopReason,
        output: info.lastAssistantMessage,
        source: 'lifecycle',
      })
    })
    : undefined

  // 启动对账（S2）：running 无活跃子会话 / catalog 查不到 → orphaned，并汇总上报一次；
  // 此时协调者可能还没加载，汇总会保留到 agent/created 再补发。
  await reconciler.reconcile({ coordinatorIds: resolvedCoordinatorIds() })
  for (const task of listTasks(db)) {
    if (task.delivery_pending && !isChildLive(task.session_id)) {
      await reportSettle({ taskId: task.id, sessionId: task.session_id, stopReason: 'error', source: 'startup-recovery' })
    }
  }

  // 看门狗放在启动对账之后：先让 S2 把「进程重启后没人在跑」的 running 标 orphaned，
  // 剩下的 running 才交给看门狗判断是否空闲（避免同一任务既报丢失又报卡住）。
  watchdog.start()
  // 交付确认超时巡检：启动即扫一次，覆盖进程重启期间已经过期的 delivered。
  deliveredSweeper.start()

  // 启动恢复：pending 且没有子会话的任务重新入队；超时的（非排队）已在上面标 failed。
  queue.load()
  if (config.autoResumeQueue) queue.pump()

  // 能力包 service（0.32.0）：工具 / 面板路由共用同一份闸门、安装器与会话入口。
  // 写入仍只落到 capability-packs 根；open 只调 sessionController.create（普通根会话）。
  const packInstaller = createInstaller({
    store: packStore,
    log: (event, fields) => logger.log(event, fields),
  })
  const packService = createPackService({
    store: packStore,
    presets: presetRegistry,
    installer: packInstaller,
    config,
    hostInfo: { desktop: capabilityPacksDesktop },
    builtin: builtinPackState,
    sessionController: () => service('sessionController'),
    // 开包会话：目标目录已是宿主工作区时就挂进去（宿主只在 workspaceId 分支 attachSession；
    // 只给 cwd 的会话会落在「未分组」，UI 打不开正常会话视图）。
    workspaces: () => service('workspaceRegistry'),
    workspaceDir: () => resolveCoordinator()?.session?.header?.cwd ?? join(dir, 'workspace'),
    env: process.env,
    // 用户级变量可能早于本宿主进程写入：面板按「已配置」显示，避免把重启后可见误报成未设置。
    persistedEnv: ref => persistedEnvPresence(ref),
    log: (event, fields) => logger.log(event, fields),
    onWarn: warnings,
  })
  // 面板投影：只读快照 + 窄写口（开包会话/装卸载 CLI/环境变量/删除用户包）。
  const packPanel = createPackPanel({ service: packService })

  const toolDisposers = createTools({
    db, dispatcher, queue, notifier, config, coordinatorStatus, logger,
    workspaces: () => service('workspaceRegistry'),
    // 相对产物/项目上下文默认跟主会话目录；主会话重建后 getter 自动取到新目录。
    defaultCwd: () => resolveCoordinator()?.session?.header?.cwd ?? join(dir, 'workspace'),
    sessionQuery: () => service('sessionQuery'),
    sessions: () => service('sessions'),
    // P1：正文读取器（task_status include=full 冷读宿主会话日志）。
    bodySource,
    workspaceChanges: () => service('workspaceChanges'),
    goalBridge,
    // L1：经验文件落在插件唯一写入根下的 lessons/，子会话可 read。
    stateDir: dir,
    // 子会话写项目记忆（2026-11-21）：memory_note 要按「子会话 → 任务」判归属；复用 W1 的同一份解析
    // （spawn 映射 + 台账 session_id），首回合台账还没回写 session_id 时也能认出来。
    taskOfAgent: workerTaskOf,
    // P2-4（D6）：官方 Team 板只读关联（task_create.teamTaskId 的校验与记录）。
    teamBoard,
    // P9：worktree 能力共享同一份服务（recentDays 取配置），终态清理由 index 统一注入。
    worktree: worktreeService,
    cleanupWorktree,
    // 0.32.0：能力包工厂工具（capability_pack）。
    capabilityPacks: packService,
  }).map(tool => ctx.tools.register(tool))

  // task_report done 所在回合的 workspace/changes 事件在 turn stopping 时才追加：
  // 摘要服务在 append 返回后才登记，推迟到微任务再读取，完成待交付请求。
  const collectArtifactsAfterTurn = (session, event) => {
    queueMicrotask(() => {
      const task = findTaskBySession(db, session?.id)
      if (task?.delivery_pending && event.seq > (task.delivery_pending.eventSeq ?? 0)) void reportSettle({ taskId: task.id, sessionId: session.id, eventSeq: event.seq, stopReason: 'completed', source: 'workspace-changes' })
    })
  }
  const artifactDisposer = ctx.on?.('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') collectArtifactsAfterTurn(session, event)
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
    // P1：抽屉的「最新回复」正文按需从宿主会话日志冷读（读不到降级为摘要 + unavailable）。
    bodySource,
    // F：面板 message/retry 的「无 target 归一目录」与工具层 defaultCwd 同源。
    defaultCwd: () => resolveCoordinator()?.session?.header?.cwd ?? join(dir, 'workspace'),
  })

  // 工作台 v1（P11）：组 / 排期（L1）/ 自动化（L2，宿主 ctx.schedule 的桥）。
  // 0.36.0（用户拍板决策 4）：自动化**绑创建它的协调者**——面板传 sessionId（必须仍是名单成员），
  // 未传时回落主协调者（兼容旧客户端）。日报仍只维护一条、跟主协调者（见 ensureDigestFor）。
  const workbench = createWorkbench({
    db,
    schedule: () => service('schedule'),
    mainSessionId: () => resolvedCoordinatorId(),
    coordinatorIds: () => resolvedCoordinatorIds(),
    log: (event, fields) => logger.log(event, fields),
  })

  // 客户端面板路由：鉴权由 connection 服务统一负责；snapshot 只查台账；
  // detail/artifacts/preview 只读，stop/retry/message/delete 是面板动作（owner-only）。
  const routeOptions = {
    ...HOST_ROUTE_OPTIONS,
    fetch: createHostRoute({
      db,
      coordinatorStatus,
      panel,
      workbench,
      // 0.32.0：能力包面板（只读快照 + 窄写口；confirm/planHash 在 service 层再判）。
      packs: packPanel,
      // P2-4（D6）：官方 Team 板只读快照（服务缺失/未开启/读失败都在 handler 里降级）。
      teamBoard: () => teamBoard.read(resolveCoordinator()),
      // 0.25.0：上下文观测缓存（只读诊断；面板不常驻渲染压力）。
      contextSnapshot: () => contextObserver.snapshot(),
      // t-a79e12d8：客户端轮询「跳到新主会话 / 一条可读提示」的进程内待办（读 + ack，不碰台账）。
      mainNav,
      // 0.36.0：会话头「设为协调者」= **加入名单并提升为主**（旧协调者留在名单里，仍可派活/收回报）
      // + 重建日报（跟新的主协调者）+ 清压力提醒。
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
      // 0.36.0：面板「本会话退出协调者」→ 只改名单；删首位则下一位升主，日报随之重建。
      dropCoordinator: async ({ sessionId }) => {
        const result = await mainSession.dropSession({ sessionId, source: 'panel' })
        if (result?.ok === true && result.primaryChanged === true && typeof result.primary === 'string') {
          try { await ensureDigestFor(result.primary) } catch (error) {
            warnings(`dsh-orchestrator: 新主协调者的日报重建失败：${error?.message ?? error}`)
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
    for (const dispose of [...restrictionDisposers, ...toolDisposers, promptDisposer, workerPromptDisposer, guardDisposer, artifactDisposer, settleDisposer, toolFailureDisposer, routeDisposer].reverse()) {
      try { dispose?.() } catch { /* 卸载期单个失败不应阻断其余清理 */ }
    }
    // 卸载期间的收尾也不能变成未处理拒绝（宿主会判 fatal load failure）。
    try { await notifier.flushNow() } catch { /* 通知收尾失败不影响卸载 */ }
    // 能力包预设：热替换/卸载时撤掉本进程注册的行（已开会话按平台语义保旧 revision）。
    for (const pack of builtinPackState) {
      try { await presetRegistry.unregister(pack.definition.id) } catch { /* 卸载期撤销失败不阻断 */ }
    }
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
