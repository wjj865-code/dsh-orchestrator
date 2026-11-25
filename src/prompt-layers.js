// 提示词分层（prompt-layers）：各层文本的职责边界与**唯一措辞源**。
//
// 背景（审计 §3、§5.1、§5.4）：同一批口径被写在 5 个地方（协调者 policy 3403 字 / brief / task_detail /
// onboarding 708 字 / 通知 hint），其中 **L1 与 L4 重叠 6 条**、**L1 与通知重叠 3 条**，还有 3 处措辞互相打架：
//   1. `LIMITATIONS.md` 说「交付时选项进 question+options」，实现明确不支持（`done` 会清空）；
//   2. brief 的 `CONFIRM_HINT` 说「要点写进 summary」，task_detail 的 `FINISH_HINT` 说「正文写：改了什么…」
//      —— 子会话不知道 summary 该写结论还是写三问；
//   3. 插件页简介（原 `DETAIL.md`，P1-D 已并入 README/ARCHITECTURE）说 brief 是「四件事」，实际有 worktree 时是 6 行（多「访问级别」「worktree 依赖」）。
//
// t-4f7ce108（用户原话：「协调者预设有 policy，但任务执行者却没有……将静态提示词内容都统一移入任务执行者的
// policy，这样每次跑都会注入」）：新增 **W1 任务执行者 policy**（`ctx.systemPrompt.context`，只命中任务子会话）。
// brief 与 worker persona 里的静态提示全部迁进 W1，同一句只在一层出现：
//   - 执行中怎么上报（blocked）/ 交付怎么回报（summary）/ 完成动作 → W1（原 brief 与 task_detail 各一份）；
//   - worktree 装依赖提示 → W1（按台账 `worktree_state` 条件渲染，原 brief 一行）；
//   - 先调 task_detail 的字段清单 → W1（brief 只留一行指针）；
//   - 主动读 context 的引导 → W1（原 worker 预设 persona）。
//
// 本模块把「谁说什么」固定下来，并给出跨层共享的**唯一措辞**：各层从这里取常量，不再各写一份。
// 判据：**一条口径只允许有一个所有者层**；其它层要么不提，要么用本模块的常量（内容逐字一致）。
//
// ┌────┬────────────────────────┬────────────────┬──────────────────────────────────────────┐
// │ 层 │ 载体                    │ 生命周期        │ 唯一职责                                  │
// ├────┼────────────────────────┼────────────────┼──────────────────────────────────────────┤
// │ L1 │ `ctx.systemPrompt`      │ 每回合重渲染    │ 协调者的**行为规则**：能调什么工具、禁止什么、 │
// │    │ `.context().text`       │                │ 交付/确认/追问的决策口径、worktree/写域策略、 │
// │    │ （index.js）            │                │ 用户偏好（第 4 段）、能力诊断                  │
// │ W1 │ `ctx.systemPrompt`      │ 每回合重渲染    │ 任务子会话的**回报与确认**：先读详情、执行中   │
// │    │ `.context().text`       │ （仅任务子会话）│ 上报、交付口径、主动读 context、装依赖授权     │
// │    │ （index.js）            │                │ （renderWorkerPolicy，句子源 copy.js）        │
// │ L2 │ 派发消息（brief.js）     │ 每次派发/续派    │ 只留**一次性参数**：任务引用、访问级别、       │
// │    │ ＋ worker 预设 persona   │ 出生即带（静态）  │ 一行详情指针；persona 只留身份                │
// │ L3 │ 子会话按需调用           │ 按需（可能不调）  │ 任务的**创建详情**：目标/验收/约束/背景/原话/  │
// │    │ （task-detail.js）      │                │ 工作目录与权限/前置/经验/产物                  │
// │ L4 │ 一次性 `agent.steer`     │ 仅新主会话首次    │ 只做**开场**：自我介绍一句 + 派索引任务        │
// │    │ （onboarding.js）       │                │ （能力边界归 L1，这里一条都不重复）            │
// │ 旁 │ 通知（notify.js）        │ 每次通知         │ 只做**动作指令**：这条通知要你（协调者）现在做什么 │
// └────┴────────────────────────┴────────────────┴──────────────────────────────────────────┘
//
// 三条判据（写新文案前先自问）：
//   1. 这句话是给**协调者**看的规则，还是给**子会话**看的指引？——协调者规则进 L1，子会话回报/确认进 W1，
//      只在派发那一刻需要的一次性参数进 L2，只在子会话主动要时进 L3。
//   2. 它需要**每回合都在**吗？——是 → L1（协调者）/ W1（任务子会话）。
//   3. 它是不是「收到通知后马上要做的动作」？——是 → 通知 hint；否则别写进通知。
import { ISOLATED_WORKTREE_STATES } from './write-guard.js'
// P1-C 文案单源：跨层共享的「交付不是结束」与通知/详情/工具回执同源（src/copy.js）。
// C2-3b：L1 的任务链/并行策略两段只渲染判据一句，判据句同样单源在 copy.js（*_CRITERIA）。
import {
  ADVANCE_LOOP_LINES, DECISION_FLOW_LINES, DELIVERY_NOT_FINAL, PARALLEL_CRITERIA, PARALLEL_LINES,
  TASK_CHAIN_CRITERIA, TASK_CHAIN_LINES,
} from './copy.js'
// W1（任务子会话 per-turn policy）的句子只在 copy.js 定义一次，本模块只负责分层归属与渲染顺序。
import {
  BLOCKED_HINT, CONFIRM_HINT, WORKER_CONTEXT_HINT, WORKER_MEMORY_HINT, WORKER_PERMISSION_HINT, WORKER_POLICY_HEADING,
  WORKER_POLICY_LINES,
} from './copy.js'

export {
  DELIVERY_NOT_FINAL, ADVANCE_LOOP_LINES, DECISION_FLOW_LINES, PARALLEL_LINES, TASK_CHAIN_LINES, WORKER_CONTEXT_HINT,
  WORKER_MEMORY_HINT,
}

/**
 * L1「拍板流程」段落（唯一渲染入口）：五条规则 + 计划批准四选一 + 决策汇总的句子全部来自
 * `src/copy.js` 的 `DECISION_FLOW_LINES`，本模块只负责分层归属与渲染顺序，`index.js` 只把它
 * 拼进协调者 policy 的固定位置（交互三闸门之后：先讲什么时候可以打断，再讲怎么问）。
 *
 * 为什么必须单独成段：原地把「批准执行」换成四个选项，模型仍会习惯性一次问完所有项——
 * 一条一段的规则 + blocked 通知里的「待拍板 N 项」两处一起才拧得动这个习惯（版本 A 只改文案，工具层不改造）。
 */
export function renderDecisionPolicy() {
  return `## ${DECISION_FLOW_LINES.heading}

- ${DECISION_FLOW_LINES.oneByOne}。
- ${DECISION_FLOW_LINES.noCodes}。
- ${DECISION_FLOW_LINES.dependenceBatch}。
- ${DECISION_FLOW_LINES.planApproval}。
- ${DECISION_FLOW_LINES.summary}。
- ${DECISION_FLOW_LINES.document}。
- ${DECISION_FLOW_LINES.soft}。`
}

/**
 * L1「推进循环」段落（唯一渲染入口）：句子全部来自 `src/copy.js` 的 `ADVANCE_LOOP_LINES`，
 * 本模块只负责分层归属与渲染顺序，`index.js` 只把它拼进协调者 policy 的固定位置。
 *
 * 为什么单独成段而不是塞进「交互三闸门」：三闸门回答「**什么时候可以打断用户**」，
 * 本段回答「**回报之后必须做什么**」。混在一起时模型容易只记住「少打扰」而把「不推进」当成合规。
 */
export function renderAdvanceLoopPolicy() {
  return `## ${ADVANCE_LOOP_LINES.heading}

- ${ADVANCE_LOOP_LINES.rule}
  1. ${ADVANCE_LOOP_LINES.advance}
  2. ${ADVANCE_LOOP_LINES.ask}
  3. ${ADVANCE_LOOP_LINES.askNewTask}
- ${ADVANCE_LOOP_LINES.approvedPlan}。
- ${ADVANCE_LOOP_LINES.blockers}。
- ${ADVANCE_LOOP_LINES.allDone}。
- ${ADVANCE_LOOP_LINES.distinct}。
- ${ADVANCE_LOOP_LINES.directAnswer}。
- ${ADVANCE_LOOP_LINES.soft}。`
}

/**
 * L1「任务链」段落（唯一渲染入口）：只渲染标题 + 一句判据（`src/copy.js` 的 `TASK_CHAIN_CRITERIA`），
 * 本模块只负责分层归属与渲染顺序，`index.js` 只把它拼进协调者 policy 的固定位置。
 *
 * 为什么压成一句（C2-3b）：机制（waiting_dep + `promoteDependents` 自动晋升）早就在执行层，提示词只需要
 * 「什么时候建链」这一句判断口径——建链时机、失败传播、delivered≠done、同检出串行这些展开细节交给
 * `skill({ name: 'orch-task-chain' })`，每回合都摊开讲反而稀释了判据本身。
 * `TASK_CHAIN_LINES`（完整展开版）仍保留在 copy.js：`task_create.dependsOn` 工具描述、waiting_dep 回执、
 * chain:"auto" 文案还在引用它，工具层手边必须有完整口径。
 *
 * 与相邻段的分工（不互相推翻）：
 * - 「交互三闸门」回答什么时候可以打断用户；「推进循环」回答回报之后必须做什么（建链属于「推进」）；
 * - 「worktree 隔离」回答要不要隔离与怎么建检出；本段只说**有依赖就建链串行**。
 */
export function renderTaskChainPolicy() {
  return `## ${TASK_CHAIN_LINES.heading}

${TASK_CHAIN_CRITERIA}。`
}

/**
 * L1「并行策略」段落（唯一渲染入口）：只渲染标题 + 一句判据（`src/copy.js` 的 `PARALLEL_CRITERIA`）。
 *
 * 为什么压成一句（C2-3b）：worktree / 写域 / 任务链三段各自都对，但缺一句「没依赖就别排队」——
 * 本段只回答「三条同时满足就直接 worktree:true 并行」，优先并行的理由、串行的两种例外、合并代价与
 * 只读/计划例外交给 `skill({ name: 'orch-parallel' })`，**不新增执行层语义**。
 * `PARALLEL_LINES`（完整展开版）仍保留在 copy.js，供文档与其它渲染点引用。
 *
 * 与相邻段的分工（不互相推翻）：
 * - 「任务链」回答「有依赖时怎么建链」；本段回答「没依赖时**不要**建链，直接隔离并行」；
 * - 「worktree 隔离」回答怎么建检出；本段回答什么时候该建、什么时候必须串行。
 */
export function renderParallelPolicy() {
  return `## ${PARALLEL_LINES.heading}

${PARALLEL_CRITERIA}。`
}

/**
 * W1「回报与确认」段落（任务子会话 per-turn policy 的唯一渲染入口）。
 *
 * 为什么从 brief/persona 迁过来：brief 与 persona 只在**出生那一刻**到达子会话，续派或多轮之后
 * 容易被上下文挤掉；per-turn policy 每回合重渲染，口径不会丢。句子本体全部来自 `src/copy.js`
 * （`WORKER_POLICY_LINES`），本模块只决定哪一句在什么条件下出现：
 *   - 固定六句：先读详情 / 执行中上报 / 权限·环境失败必须写进回报 / 交付回报 / 主动读 context / 收尾沉淀项目经验；
 *   - 条件一句：worktree 装依赖，仅当台账 `worktree_state` 属于真隔离（requested/created/reused）。
 *
 * @param {{ worktreeState?: string }} [task]  台账任务的 `worktree_state`（可空）
 */
export function renderWorkerPolicy({ worktreeState } = {}) {
  const lines = [
    `## ${WORKER_POLICY_HEADING}`,
    '',
    `- ${WORKER_POLICY_LINES.detail}`,
    `- ${WORKER_POLICY_LINES.blocked}`,
    `- ${WORKER_POLICY_LINES.permission}`,
    `- ${WORKER_POLICY_LINES.report}`,
    `- ${WORKER_POLICY_LINES.context}`,
    `- ${WORKER_POLICY_LINES.memory}`,
  ]
  if (ISOLATED_WORKTREE_STATES.includes(worktreeState)) lines.push(`- ${WORKER_POLICY_LINES.worktree}`)
  return lines.join('\n')
}

/**
 * 各层清单（机器可读）：文档、测试与排障都按这张表核对「谁该说什么」。
 * `owns` 是**该层的独占职责**（别的层不许重复）；`forbids` 是明确不该出现在该层的内容。
 */
export const PROMPT_LAYERS = Object.freeze([
  Object.freeze({
    id: 'L1',
    name: '协调者 policy',
    carrier: 'ctx.systemPrompt.context().text（index.js，每回合重渲染）',
    audience: 'coordinator',
    owns: Object.freeze([
      '工具可用与禁用（能用 task_* 7 个 + 原生 read 只读 + skill/present/schedule；禁用 wait_agent 与团队工具；不挂 glob/grep——检索类工作派任务）',
      '复杂需求开工前用 grill-me 技能拷问（多轮前沿提问、每问带推荐、决策归用户、grill ≠ 批准）',
      '技能加载用于判断派活（只读不执行：按需 1–2 个、能直接回答的不加载、读到的写进 task_create）',
      '能直接回答就不委派（只有新鲜取证/写文件/跨仓库证据才 task_create）',
      '交付与确认的决策口径（done 不是终态、默认保持待确认、何时 task_message({ action: "close" })、何时追问）',
      '不主动问「任务能否关闭」；只在真歧义/不可逆/远端写授权时提问，且必须用 ask_user_question 结构化提问（不得用纯文字问句代替，多条合并成一条清单）',
      'present 与 read_workspace 的用法与边界',
      'worktree 隔离策略（renderWorktreePolicy）',
      '同写域并发防护（renderWriteGuardPolicy）',
      '交互三闸门（T0–T3 判级、开工前确认、执行期只报堵塞项、追加调整先评估；renderInteractionPolicy）',
      '推进循环（收到回报/用户消息后必须落到推进/提问/问新任务三类动作之一，不许只汇报；renderAdvanceLoopPolicy，措辞源 copy.js 的 ADVANCE_LOOP_LINES）',
      '拍板流程（待拍板项一项一问、不用代号、依赖分批、计划批准四选一后再总批准核对、决策汇总；renderDecisionPolicy，措辞源 copy.js 的 DECISION_FLOW_LINES）',
      '任务链判据（有依赖就建链串行：判据一句 + 技能指针 orch-task-chain；renderTaskChainPolicy，措辞源 copy.js 的 TASK_CHAIN_CRITERIA）',
      '并行策略判据（互不依赖 + 不复用上下文 + 同写域撞车三条满足就直接 worktree:true 并行：判据一句 + 技能指针 orch-parallel；renderParallelPolicy，措辞源 copy.js 的 PARALLEL_CRITERIA）',
      '堵塞项四类与「不算堵塞项」清单（措辞源 copy.js 的 BLOCKER_RULE）',
      '用户偏好（第 4 段，src/preferences.js）',
      '能力诊断（schedule 服务缺失时的降级说明）',
    ]),
    forbids: Object.freeze(['子会话的完成动作细节（属 W1）', '任务目标与验收内容（属 L3）', '一次性开场介绍（属 L4）']),
  }),
  Object.freeze({
    id: 'W1',
    name: '任务执行者 policy',
    carrier: 'ctx.systemPrompt.context().text（index.js 的 renderWorkerPolicy，每回合重渲染；只命中 tasks.session_id 属于任务的子会话）',
    audience: 'worker',
    owns: Object.freeze([
      '开工先调 task_detail 读详情（字段清单与「不要凭 brief 猜任务内容」；WORKER_DETAIL_HINT）',
      '执行中怎么上报（blocked + question/options；堵塞项口径引用 BLOCKER_RULE；BLOCKED_HINT）',
      '权限/环境失败必须写进回报（执行期先按窄一级沙箱重试一次，仍失败就把命令 + code/提示 + 试过什么写进 summary；WORKER_PERMISSION_HINT）',
      '交付时怎么回报与完成动作（task_report 四状态 + summary + done 清空 question/options + 两段式终态；CONFIRM_HINT）',
      '隔离任务的装依赖授权（仅 worktree 真隔离任务；WORKTREE_INSTALL_HINT）',
      '需要历史经验/项目背景时主动调 context（WORKER_CONTEXT_HINT）',
      '任务收尾沉淀项目经验（memory_note 写一条项目级 note/lesson/decision；不写 preference/全局、不写日志；WORKER_MEMORY_HINT）',
    ]),
    forbids: Object.freeze([
      '协调者的决策口径（action:close / 交付确认 / 推进循环 / 任务链 / 三闸门，属 L1）',
      '任务目标/验收/约束/背景/经验正文（属 L3）',
      'present、read_workspace 等协调者工具（属 L1）',
      '一次性派发参数（任务引用 tk-、访问级别，属 L2）',
      '全局偏好与跨项目记忆的写入（只协调者；W1 只讲「写自己任务的项目记忆」）',
    ]),
  }),
  Object.freeze({
    id: 'L2',
    name: 'brief',
    carrier: '派发消息（src/brief.js，每次派发/续派）＋ worker 预设 persona（cordis.patch.yml，出生即带的身份前缀）',
    audience: 'worker',
    owns: Object.freeze([
      '任务引用（tk-xxxxxx，task_detail 的参数；不写台账内部编号）',
      '访问级别（仅 access:full）',
      '「先调 task_detail 读详情」的一行指针（字段清单归 W1）',
      'worker persona：只说身份（你是任务执行者，在目标目录里把活干完并用 task_report 回报）',
    ]),
    forbids: Object.freeze([
      '任务目标/验收/约束/背景/经验正文（属 L3）',
      '静态回报口径（执行中上报 / 交付 summary / 完成动作属 W1）',
      'worktree 装依赖提示（属 W1，按台账 worktree_state 条件渲染）',
      '主动读 context 的引导（属 W1）',
      'action:close / delivered / 终态等协调者口径（属 L1）',
      'present、read_workspace 等协调者工具（属 L1）',
    ]),
  }),
  Object.freeze({
    id: 'L3',
    name: 'task_detail',
    carrier: '子会话按需调用（src/task-detail.js）',
    audience: 'worker',
    owns: Object.freeze([
      '任务创建详情：目标 / 验收标准 / 约束 / 背景资料 / 用户原话',
      '工作目录、权限、访问级别、写边界提示',
      '前置任务、经验文件指针、已有产物、编排字段',
      '计划任务与 worktree 隔离的说明',
    ]),
    forbids: Object.freeze([
      '协调者的决策口径（属 L1）',
      '重复 brief 的「先调 task_detail」指引（L2 已说）',
      '回报与确认口径（属 W1：task_report 四状态 / summary / 交付待确认）',
    ]),
  }),
  Object.freeze({
    id: 'L4',
    name: 'onboarding',
    carrier: '一次性 agent.steer（src/onboarding.js，仅新主会话首次）',
    audience: 'coordinator',
    owns: Object.freeze([
      '说明这是初始化请求、不是用户手写指令',
      '一句话自我介绍（能拆任务、派子会话、看回报、交付）',
      '派一次「工作区与仓库索引」只读任务',
    ]),
    forbids: Object.freeze([
      '能力边界（只协调不写文件 / 原生只读工具与 skill 的用法 / read_workspace 边界 / 默认 worker 无自动化 / full 只改单任务沙箱）——全部属 L1，L1 每回合都在且不会被 compaction 吃掉',
      '交付与确认口径（属 L1）',
    ]),
  }),
  Object.freeze({
    id: 'NOTIFY',
    name: '通知 hint',
    carrier: '通知正文（src/notify.js，每次通知）',
    audience: 'coordinator',
    owns: Object.freeze([
      '这条通知要求协调者**现在**做什么（present 交付 / 保持待确认 / 追问 / 停止）',
      'done/delivered/blocked/needs_auth 通知尾部的动作指令（ADVANCE_NOTICE_HINT，与 L1 推进循环同源）',
      '子会话工具失败告警的动作指令（回喂 sandbox_permissions / 给 access:full / 改派；toolFailureNotice，src/copy.js）',
      '产物清单与「不能交付」的原因计数',
    ]),
    forbids: Object.freeze(['解释能力边界或工具清单（属 L1）', '任务详情（属 L3）']),
  }),
])

/** 各层 id → 名称（测试与排障输出用）。 */
export const LAYER_NAME = Object.freeze(Object.fromEntries(PROMPT_LAYERS.map(layer => [layer.id, layer.name])))

/**
 * 跨层共享口径（**唯一措辞**）：多于一层的同一件事，只在这里写一次，各层引用常量。
 *
 * 目前只保留「必须逐字一致」的几条：
 *   - 子会话不能问用户（W1 说原因、L1 说协调者要做的事）；
 *   - 交付不是结束（L1 决策口径、W1 交付口径、L3 计划阶段说明、通知动作指令都依赖它）；
 *   - present 的 1-4 个上限（L1 规则与通知动作指令）。
 *
 * P1-C：句子本体已收口到 `src/copy.js`（这里只做分层出口，避免「同一句话两处定义」）。
 */

/** 子会话问不了用户（平台约束，W1 的 BLOCKED_HINT / CONFIRM_HINT 已含此事实）。 */
export const WORKER_CANNOT_ASK = '子会话调 ask_user_question 会被平台拒（DELEGATED_CALLER）'

/** present 的产品上限（L1 规则与通知 hint 共用）。 */
export const PRESENT_MAX_FILES = 4
export const PRESENT_LIMIT_TEXT = `1-${PRESENT_MAX_FILES} 个最关键的`

/** W1 的两条回报指引（句子在 copy.js，这里只按层出口，供测试/文档按层引用）。 */
export const LAYER_W1_HINTS = Object.freeze({
  blocked: BLOCKED_HINT,
  confirm: CONFIRM_HINT,
})

/** 旧名兼容（P1-C 起 W1 才拥有这两个句子）：外部按 LAYER_L2_HINTS 读仍然拿到同一份措辞。 */
export const LAYER_L2_HINTS = LAYER_W1_HINTS

/**
 * 层归属自检：某段文案是否只出现在它该在的层。
 *
 * 测试用它锁住「删掉的重叠不会偷偷回来」：例如 brief 里又出现「交付时把 summary 写成…」，
 * 就说明有人把 W1 的静态口径抄回了 L2。
 *
 * @param {'L1'|'W1'|'L2'|'L3'|'L4'|'NOTIFY'} layerId
 * @param {string} text
 * @returns {string[]} 命中的违规描述（空数组 = 干净）
 */
export function layerViolations(layerId, text) {
  const value = typeof text === 'string' ? text : ''
  const layer = PROMPT_LAYERS.find(item => item.id === layerId)
  if (layer === undefined) return [`未知层：${layerId}`]
  // 「别的层独占、本层不许出现」的探针：每条都对应一次真实的重叠或矛盾。
  const probes = {
    // L4 不许复述 L1 的能力边界（审计 §2.7 列的 6 条重复）。
    L4: [
      [/原生\s*read\s*仍被拒/, 'L1 的工具禁用口径'],
      [/只协调、不直接写文件/, 'L1 的职责边界'],
      [/read_workspace/, 'L1 的读产物口径'],
      [/full\s*只(?:改变|改)/, 'L1 的 access:full 口径'],
      [/默认\s*worker\s*不开放自动化/, 'L1 的自动化口径'],
    ],
    // W1 只讲子会话的回报与确认：不许讲协调者的决策口径与工具。
    W1: [
      [/task_close|action:\s*['\"]close['\"]/, 'L1 的确认交付口径'],
      [/present|read_workspace/, 'L1 的交付/读产物工具'],
      [/三闸门|T0\s*\/\s*T1|R0\s*\/\s*R1/, 'L1 的交互闸门分级'],
      [/推进循环|还有新任务吗/, 'L1 的推进循环口径'],
      [/任务链|dependsOn 不是阻塞等待/, 'L1 的任务链口径'],
      [/wait_agent|spawn_teammate|team_task_/, 'L1 的团队工具禁用口径'],
    ],
    // L2 不许讲协调者口径，也不许把 W1 的静态提示抄回来（那正是 t-4f7ce108 删掉的重复）。
    L2: [
      [/task_close|action:\s*['\"]close['\"]/, 'L1 的确认交付口径'],
      [/已交付待确认/, 'W1 的两段式终态口径'],
      [/present/, 'L1 的交付工具'],
      [/read_workspace/, 'L1 的读产物口径'],
      // 分级与评估是协调者的判断，子会话只报送商品（这条最容易顺手抄进 brief）。
      [/三闸门|T0\s*\/\s*T1|R0\s*\/\s*R1/, 'L1 的交互闸门分级'],
      // 推进循环是协调者的行为规则：子会话只负责回报，不判断「下一步该推进还是提问」。
      [/推进循环|还有新任务吗/, 'L1 的推进循环口径'],
      // 任务链的判据/时机是协调者的派单判断；子会话只读自己的前置事实（L3 的【前置任务】），不建链。
      [/任务链|dependsOn 不是阻塞等待/, 'L1 的任务链口径'],
      // W1 的静态口径（t-4f7ce108 起每回合注入，brief 不再内联一份）。
      [/执行中只把\*\*堵塞项\*\*/, 'W1 的执行期上报口径'],
      [/交付（报 done）时|完成后用 task_report 回报/, 'W1 的交付回报口径'],
      [/本任务在独立检出里跑|worktree 检出目录里没有依赖/, 'W1 的装依赖提示'],
      [/主动调\s*context/, 'W1 的上下文引导'],
      // 记忆沉淀的边界（只写自己任务的项目记忆、不写 preference/全局）是 W1 每回合注入的口径。
      [/有值得复用的项目经验时|不写 preference/, 'W1 的项目经验沉淀引导'],
      // 权限/环境失败的自纠与回报（sandbox_permissions 升级只写一次在 W1）是子会话的执行期口径。
      [/sandbox_permissions/, 'W1 的权限/环境失败回报口径'],
    ],
    // L3 不许重复 brief 的指路，也不许讲协调者口径或 W1 的静态回报口径。
    L3: [
      [/先调\s*task_detail/, 'L2 的指路指引'],
      [/task_close|action:\s*['\"]close['\"]/, 'L1 的确认交付口径'],
      [/三闸门|T0\s*\/\s*T1|R0\s*\/\s*R1/, 'L1 的交互闸门分级'],
      [/推进循环|还有新任务吗/, 'L1 的推进循环口径'],
      [/任务链|dependsOn 不是阻塞等待/, 'L1 的任务链口径'],
      [/改了什么、改了哪些文件、怎么验证的/, 'W1 的交付回报口径'],
    ],
    // 通知只讲动作，不讲能力边界。
    NOTIFY: [
      [/原生\s*read/, 'L1 的工具禁用口径'],
      [/只协调、不直接写文件/, 'L1 的职责边界'],
    ],
  }[layerId] ?? []
  const hits = []
  for (const [pattern, owner] of probes) {
    if (pattern.test(value)) hits.push(`出现「${pattern.source}」，该口径属${owner}`)
  }
  return hits
}
