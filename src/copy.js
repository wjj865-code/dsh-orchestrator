// 文案单一真源（copy）：同一句话只写一次，brief / task_detail / 工具回执 / 通知 / 计划文档一律引用。
//
// 背景（P1-C，承接审计 §5.1 的文案矛盾）：计划阶段与「两段式终态」的表述原先散在 8 个模块里，
// 同一件事被写了 3–5 遍（`plan-mode` / `plan-doc` / `task-detail` / `tools` / `notify` /
// `prompt-layers` / `write-guard`）；改一处其余就跟不上，已经发生过漂移
// （工具数 15→14、`full` 的三种说法各写一份）。
//
// 分工（与 `src/prompt-layers.js` 的层归属配套）：
// - 这里只放**跨模块共享的原子句 + 拼装函数**；本模块不 import 任何模块（叶子），谁都能引用而不引入环；
// - 一层独占的措辞仍留在本层（协调者规则归 L1 `/index.js`，面板短标签归客户端）；
// - 客户端是浏览器 bundle、无法 import 服务端模块，靠 `test/copy-consistency.test.js` 的同值断言兜住漂移。
//
// 判据（写新文案前先自问）：这句话会不会在第二个模块出现？会 → 放这里；不会 → 留在本层。

/** 计划文档目录（展示用；真实路径由 `src/plan-doc.js` 的 `PLAN_SUBDIR` 拼，两者必须一致）。 */
export const PLAN_SAVE_DIR = '任务产物目录的 docs/'

// ── 拍板流程（版本 A，2026-11-22 用户最终拍板：**只改提示词/文案**） ─────────────────
//
// 背景：计划阶段的批准原先只有一个「批准执行」，多个待拍板项被一把批掉；子会话还把清单压进
// 500 字的 `question` 里，天然逼成「一段话总批准」。用户最终口径：**不做工具层改造**——
// `plan_save` 不加参数、不解析正文、不渲染段、不存待拍板元数据；计划文档仍只是模型写的
// `content` 原样落盘。待拍板清单由模型自己生成，经 `ask_user_question` 逐项提问（平台工具本身
// 已是结构化的）。本段只把「怎么问」的句子收成单源：L1（`src/prompt-layers.js` 的
// `renderDecisionPolicy`）、`plan_save` 工具描述、blocked 通知（`src/notify.js`）只引用，不各写一份。

/** 计划批准的四选一（顺序固定；「均按推荐」必须用户明确点选，协调者不得默认）。 */
export const PLAN_APPROVAL_OPTIONS = Object.freeze(['逐项确认', '均按推荐', '先看计划文档', '放弃'])

/**
 * 显式批准的唯一调用写法（P0-4）：L1 决策段、计划状态行、创建回执、`task_message` 回执都引用它，
 * 避免「续派即批准」的旧口径再长回来。
 */
export const PLAN_APPROVE_CALL = 'task_message({ action: "approve" })'

/** 四选一的展示串（L1 / 文档 / 测试共用，避免各写一遍把顺序改掉）。 */
export const PLAN_APPROVAL_OPTIONS_TEXT = PLAN_APPROVAL_OPTIONS.join(' / ')

/**
 * L1「拍板流程」段的原子句：五条规则 + 计划批准 + 汇总口径。
 *
 * 与用户原话一一对应（《拍板流程优化》版本 A，最终收缩版）：
 *   1. 一项一问；2. 不用代号；3. 依赖分批、独立项可同批连续问（每问独立 options）；
 *   4. 计划审批先逐项确认 / 均按推荐，最后才总批准核对；5. 落地可测（文案 + 汇总函数）。
 */
export const DECISION_FLOW_LINES = Object.freeze({
  heading: '拍板流程（逐项确认，再总批准）',
  oneByOne: '**一项一问**：一个待拍板项一次提问——`ask_user_question` 的 `questions` 里一项一条、每问独立 options；'
    + '**不得**把多项塞进一个选项组，也**不得**只问一个「总体确认」让用户一把批',
  noCodes: '**用问题原文**：直接写待拍板问句本身，不出现 D1/D2、A/B/C 这类代号（代号增加理解成本，用户还得回头对表）；'
    + '需要指代某一项时就用问句原文',
  dependenceBatch: '**依赖分批**：有依赖的按依赖顺序分批问（前一项的答案决定后一项问什么）；彼此独立的可以在同一批里连续问多个——'
    + '仍是每项一问，不是合成一个总体确认',
  planApproval: `**计划审批先逐项**：计划 blocked 后先把摘要 + 计划文档绝对路径交给用户并 present，再用 ask_user_question 问「${PLAN_APPROVAL_OPTIONS_TEXT}」；`
    + '选「逐项确认」就按 blocked 的 question 里列出的待拍板项顺序逐项问完、先给决策汇总，**最后**才做一次总批准核对（只问「就按这些执行？」，不混入新问题）；'
    + '「均按推荐」必须用户明确点选——协调者不得默认、不得替用户选；'
    + `用户明确批准后走两步：先 \`${PLAN_APPROVE_CALL}\`（只记账：plan_state=approved + 审批审计 + 清问题，**不碰沙箱**），再 task_message 续派实现（写权限在续派投递时授予）`,
  summary: '**决策汇总**：每项按提问顺序写「问句原文 → 选择」贴给用户（`renderDecisionSummary`），总批准只核对这份汇总',
  document: '**文档只由模型写**：`plan_save` 的 `content` 原样落盘（工具不加参数、不注入/不改写任何段、不解析正文）；'
    + '用户确认后由模型自己把决策写进新正文，再调一次 `plan_save` 保存新版本即可',
  soft: `**软门禁**：逐项提问是提示词约束，不是执行层拦截；工具层不做格式校验，也不存待拍板元数据；`
    + `批准是**显式动作**——普通 task_message 只记讨论/修订、不会批准计划（见 \`${PLAN_APPROVE_CALL}\`）`,
})

/**
 * blocked 通知的待拍板提示（`src/notify.js` 在 question 里数到「待拍板：」清单时贴一句）。
 *
 * N 由通知层从 `question` 的条目行数粗算（不是文档解析、不是校验）：子会话按 W1 的指引
 * 把待拍板项逐条列在 blocked 的 question 里，协调者收到通知就知道要逐项问、不能一把批。
 */
export const PENDING_DECISION_NOTICE = count => `待拍板 ${count} 项，逐项提问，不要合并成一个总批准（每项一问、用问题原文）`

/**
 * 决策汇总（回答后、总批准前贴给用户）：输入 `[{ question, chosen }]`，输出按提问顺序的
 * `问句原文 → 选择`。顺序与提问顺序一致，不做排序/去重——它要能逐条对上刚才的问法。
 *
 * @param {Array<{question?: string, chosen?: string}>} items
 * @returns {string}
 */
export function renderDecisionSummary(items = []) {
  const rows = (Array.isArray(items) ? items : []).map(item => {
    const question = typeof item?.question === 'string' ? item.question.trim() : ''
    const chosen = typeof item?.chosen === 'string' ? item.chosen.trim() : ''
    if (question === '') return ''
    return chosen === '' ? question : `${question} → ${chosen}`
  }).filter(row => row !== '')
  if (rows.length === 0) return '决策汇总：（无待拍板项）'
  return ['决策汇总：', ...rows].join('\n')
}

/**
 * 计划文档路径文案：**文件名 = 任务名**（版本 B，用户拍板）。
 *
 * 不给 `name` 时写占位符 `<任务名>`（提示词/文档里就是占位口径）；给任务名时原样拼
 * （真实文件名还要过安全化流水线，见 `src/plan-doc.js` 的 `planFileName`——文案只说「在哪、
 * 叫什么」，不重复实现清洗规则）。
 */
export const planDocPathText = name => {
  const value = typeof name === 'string' && name.trim() !== '' ? name.trim() : '<任务名>'
  return `${PLAN_SAVE_DIR}${value}-<版本>.md`
}

/** danger-full-access 的一句话事实（下面四处文案都从这里拼，别再各写一遍）。 */
const FULL_ACCESS_MODE = 'danger-full-access：文件沙箱不限制写入，bash/pwsh 也不再被沙箱拦'

/** 完整访问（per-task `access:'full'`）的一句话事实：状态标签 / brief 行 / 详情提示 / 创建回执共用。 */
export const ACCESS_FULL = Object.freeze({
  label: `完整（${FULL_ACCESS_MODE}）`,
  briefLine: `【访问级别】完整（${FULL_ACCESS_MODE}；只对本任务生效）`,
  workerHint: '完整访问任务：文件沙箱是 danger-full-access，写文件、跑 bash/pwsh 都不会被沙箱拦。'
    + '仍按任务边界只改这个目录/仓库里的东西，别碰无关路径与用户数据（这条是纪律，不是沙箱拦）。',
  createNote: `访问级别：完整（${FULL_ACCESS_MODE}）；只对本任务生效，其他任务与默认策略都没动`
    + '（构建/发版类任务用完照常走终态/清理）。',
})

// 计划阶段的三个原子句先单独定义，下面的句子由它们拼（避免同一句话在对象字面量里再写一遍）。
const REPORT_SUMMARY_SHORT = '3–8 行摘要'
const REPORT_SUMMARY = `${REPORT_SUMMARY_SHORT}（做什么、改哪些文件、怎么验证）`
const REPORT_QUESTION = '计划文档绝对路径 + 待拍板问题清单'
const NO_DIRECT_HUMAN = '子会话没有直接人类，批准会悬空'

/**
 * 计划阶段（planFirst）的原子句：下面所有对外文案都从这里拼，别再各写一份。
 *
 * 计划模式在平台侧是**软引导**（只注入一段提示），真正拦写入的是只读沙箱；这段文案必须把
 * 「写被拒是预期行为」「计划唯一写入口是 plan_save」「出口是 task_report blocked，不是
 * exit_plan_mode」写清楚，否则模型会在计划阶段反复被沙箱拒绝、或把长计划硬塞进 500 字的
 * question 里被截断。
 */
export const PLAN_PHASE_LINES = Object.freeze({
  heading: '【计划阶段】',
  sandbox: '沙箱 read-only（只读）——写文件/写 shell 会被拒绝，这是预期行为，不是权限故障。',
  explore: '- 只读探索：读代码/文档、跑只读命令、验证假设；不要创建或修改文件。',
  saveCall: 'plan_save({ task_id, content })',
  saveEntry: '计划用 plan_save、阶段报告用 artifact_save：路径固定、不接受自定义路径、禁止逃逸，也不要用 write/edit/pwsh 硬写。',
  reportCall: 'task_report 报 blocked',
  reportSummaryShort: REPORT_SUMMARY_SHORT,
  reportSummary: REPORT_SUMMARY,
  reportQuestion: REPORT_QUESTION,
  reportRule: `summary 只写 ${REPORT_SUMMARY}；question 写「${REPORT_QUESTION}」，`
    + '不要把计划正文贴进 question（上限 500 字，会截断）。',
  reportCallFull: `task_report({ status: "blocked", summary: "<${REPORT_SUMMARY_SHORT}>", question: "<${REPORT_QUESTION}>" })`,
  noExitPlanMode: `不要调用 exit_plan_mode：${NO_DIRECT_HUMAN}（调用会被插件拒绝）。`,
  resume: `用户明确批准后协调者先 ${PLAN_APPROVE_CALL}（切可写 + 落审计）再 task_message 续派，插件不会因为普通 message 自动批准。`,
  options: `- options 可给「${PLAN_APPROVAL_OPTIONS_TEXT}」（批准要逐项确认或均按推荐，再总批准核对）。`,
})

/** L3（`task_detail`）里的计划阶段说明：多行，由原子句拼出。 */
export const PLAN_FIRST_DETAIL = [
  `${PLAN_PHASE_LINES.heading}本任务以计划模式起步：${PLAN_PHASE_LINES.sandbox}`,
  PLAN_PHASE_LINES.explore,
  `- 探索完先落盘计划：调 ${PLAN_PHASE_LINES.saveCall} 把计划正文（Markdown）写入${planDocPathText()}，插件自动登记为任务产物。`
    + PLAN_PHASE_LINES.saveEntry,
  `- 再用 ${PLAN_PHASE_LINES.reportCall} 上报：${PLAN_PHASE_LINES.reportRule}`,
  PLAN_PHASE_LINES.options,
  `- ${PLAN_PHASE_LINES.noExitPlanMode}`,
  `- ${PLAN_PHASE_LINES.resume}`,
].join('\n')

/** 子会话被拒 `exit_plan_mode` 时的出口文案（dispatch 层直接返回，不改任何状态）。 */
export const EXIT_PLAN_MODE_DENIAL = `exit_plan_mode 在编排子任务里不可用：${NO_DIRECT_HUMAN}。`
  + `计划阶段的出口是先在 plan_save 里把计划写进${planDocPathText()}，再用 ${PLAN_PHASE_LINES.reportCallFull} 上报，`
  + `由协调者转交用户批准；用户明确批准后协调者先 ${PLAN_APPROVE_CALL} 切回可写，再 task_message 续派执行。`

/** 计划状态行（`task_status` 与面板同口径；六值 = 四态 + none/rejected）。 */
export const PLAN_STATUS_LINES = Object.freeze({
  planning: `计划：计划中｜子会话只读探索，计划用 plan_save 落盘到${PLAN_SAVE_DIR}；`
    + `交回后等用户拍板，批准只能由协调者 ${PLAN_APPROVE_CALL}`,
  waiting_user: '计划：待拍板｜已收到 blocked 报告与计划文档，等用户拍板；'
    + `批准只走 ${PLAN_APPROVE_CALL}（普通 message 只记修订）`,
  revising: '计划：修订中｜子会话仍在只读改计划；修订版 blocked 后再由用户拍板批准',
  approved: '计划：已批准｜沙箱已切回可写；下一步 task_message 续派实现',
  rejected: '计划：未批准｜计划阶段已结束（停止或结算时未获批准）',
  none: '计划：无进行中的计划',
})

/** `task_create` 回执里的计划模式提示（给协调者看的动作指令；路径按**任务名**说）。 */
export const planCreateReceipt = title => `计划模式：子会话只读探索，探索完先 plan_save 把计划写入${planDocPathText(title)}（文件名=任务名加版本，自动登记为产物），`
  + `再用 ${PLAN_PHASE_LINES.reportCall} 只上报 ${PLAN_PHASE_LINES.reportSummaryShort} + ${PLAN_PHASE_LINES.reportQuestion}；`
  + `你转交用户，用户明确批准后先 ${PLAN_APPROVE_CALL} 再 task_message 续派（插件不会因为普通 message 自动批准）。`

/**
 * 普通 `message` 在计划任务上的回执（P0-4）：只记讨论/修订，绝不批准。
 *
 * `discussion` = `planning`（子会话还在探索，没有计划可批准）；`revising` = `waiting_user`/`revising`
 * （把消息当「修订方向」转回同一个子会话，沙箱仍是只读）。两者都由 `task_message` 与面板共用。
 */
export const PLAN_MESSAGE_NOTES = Object.freeze({
  discussion: `普通 message 只记讨论、不会批准计划（子会话仍在只读探索）；要批准请用 ${PLAN_APPROVE_CALL}。`,
  revising: `已按「修订」转回子会话（沙箱仍是只读）；修订版 blocked 后再由用户拍板，批准用 ${PLAN_APPROVE_CALL}。`,
})

/** `plan_save` 工具描述（模型侧唯一的入口说明；只有 content，不加参数、不做格式校验）。 */
export const PLAN_SAVE_TOOL_DESC = `计划模式专用：把计划正文写入${planDocPathText()}并登记为任务产物。${PLAN_PHASE_LINES.saveEntry}`

/** 计划落盘成功后的下一步（`plan_saved_note`：只报摘要，不搬正文）。 */
export const planSavedNextStep = `下一步用 ${PLAN_PHASE_LINES.reportCall}：${PLAN_PHASE_LINES.reportRule}`

/**
 * 推进循环（「报告之后必须推进，不许只汇报」）：协调者收到任何回报或用户消息后，必须落到
 * 三类动作之一——推进 / 提问 / 问新任务——不允许只输出一段汇报文字。
 *
 * 为什么集中在这里：这条口径同时出现在 L1 协调者 policy（`src/prompt-layers.js`
 * 的 `renderAdvanceLoopPolicy` 逐字渲染）与 done/delivered/blocked/needs_auth 通知尾部的
 * 动作指令（`ADVANCE_NOTICE_HINT`）两处；两处必须逐字同源，否则模型会读到两套说法。
 *
 * 与既有口径的边界（不得互相推翻）：
 * - 「不主动问任务能否关闭」不变：问新任务 ≠ 问能否关闭（`distinct` 一句写死这个区别）；
 * - 「少打扰」是执行期口径：本段不新增打断点，只是把「回报之后要接动作」补上；
 * - 计划批准四步与两段式交付不变：已批准计划的续派仍只由用户在协调者这条链上批准之后发生。
 */
export const ADVANCE_LOOP_LINES = Object.freeze({
  heading: '推进循环（报告之后必须推进，不许只汇报）',
  rule: '收到任何任务回报（progress / done / delivered / blocked / needs_auth）或用户消息后，必须落到下面三类动作之一；'
    + '**禁止只输出汇报文字（「X 完成了」/「进展如下」）——那不算响应**：',
  advance: '推进：按已批准的计划 task_message 续派/追问同一个子会话（复用上下文），或任务已授权时 task_create 继续做',
  ask: '提问：ask_user_question（结构化、2–4 个选项、每项带你的建议）；**待拍板项一项一问**'
    + '（每问独立 options、不合成一个总体确认，见下「拍板流程」段），其余待决可合成一条清单一次问完',
  askNewTask: '问新任务：仅当「没有活跃任务、也没有待确认任务」时，用 ask_user_question 问「还有新任务吗」；用户明确说没有之后才可以静默',
  approvedPlan: '已批准的计划任务（plan_state=approved）：用户批准后立即 task_message 续派实现，不要只回一句确认；'
    + `批准本身是显式动作（${PLAN_APPROVE_CALL}），计划需要调整或遇到卡点就 ask_user_question 请用户拍板，不自己改范围`,
  blockers: '卡点（B1–B4）与需要用户拍板的事：必须用 ask_user_question 推进，不能拖着不问，也不能自己代批',
  allDone: '全部任务完成（无活跃、无待确认）：先问「还有新任务吗」；用户明确说没有才静默；'
    + '同一事件只问一次，用户不答不重复轰炸，但也不许宣称「已全部完成」然后静默',
  distinct: '「问是否有新任务」与「问任务能否关闭」是两件事：交付仍默认保持待确认、不主动问能否关闭；'
    + '问新任务只在没有活跃任务且没有待确认任务时问一次',
  directAnswer: 'T0 直答不违反这条：用户问的是事实或看法、答案已在你手里时，直接回答就是本轮的「动作」，'
    + '不必为凑动作去派任务（硬规则「能直接回答就不派任务」仍优先）',
  soft: '这段是提示词约束（软门禁），不是执行层拦截：仍然可能只汇报、不推进；出现时按本段纠正并继续，不要假装它是硬拦截',
})

/** 通知尾部的动作指令（done / delivered / blocked / needs_auth 的通知末尾各贴一次）。 */
export const ADVANCE_NOTICE_HINT = '下一步：推进 / 提问 / 宣布完成前先问新任务——只输出汇报文字不算推进'
  + `（口径见协调者「${ADVANCE_LOOP_LINES.heading}」）。`

/**
 * 任务链（dependsOn）的原子句：协调者 L1 规则、`task_create` 的 dependsOn 描述、waiting_dep 回执共用。
 *
 * 背景（0.28.0，用户原话：「你可以使用 dependson，依赖任务结束时会自动开始。这个机制是不是没写到预设
 * 或者提示词，怎么没怎么使用。」）：机制早就在（`src/deps.js` + `src/queue.js` 的 `promoteDependents`
 * 自动晋升），但提示词里只有硬规则里一句「有先后关系时用 dependsOn」——模型不知道**什么时候**该建链、
 * 也不知道 dependsOn 不占回合，于是习惯性「等 A 完成再派 B」，把一条自动链走成两次人工往返。
 *
 * 五条规则与实现一一对应（都是把既有行为写明，不是新语义）：
 *   1. 判据 + 建链时机：B 的输入是 A 的产物 → 派 A 后同一回合就建 B（`validateDepends` 只认已存在的 id）；
 *   2. 不是阻塞等待：waiting_dep → done 后 `promoteDependents` 在 `queue.pump()` 里晋升 pending；
 *   3. 前置失败 → 下游 failed：`dependencyState` 的 failed/missing 分支立即传播；
 *   4. 前置 delivered ≠ done：就绪只认 `status === 'done'`，delivered 会挡住下游；
 *   5. 同一 worktree 检出串行：同检出不并发（`renderWorktreePolicy` 也指向这里）。
 *
 * 改句子前先确认实现没变：这五条是对 `src/deps.js` 现状的措辞，不是对未来的承诺。
 */
export const TASK_CHAIN_LINES = Object.freeze({
  heading: '任务链（dependsOn：依赖完成自动开始，不占你的回合）',
  criteria: '判据（什么时候该建链）：B 的输入是 A 的产物时就是一条链——实现 → 验收/冒烟、构建 → 发布、'
    + '修复 → 回归、迁移 → 回归复核都算；A 还没产出东西，B 就没法开始',
  buildNow: '建链时机：派 A 之后**同一回合**就把 B 建出来（`task_create({ dependsOn: [A 的编号] })`，A 的编号在创建回执里）——'
    + '不要等 A 完成再来建 B，也不要为「等 A」跑 task_list 轮询',
  notBlocking: 'dependsOn 不是阻塞等待：B 先落 waiting_dep，前置全部 done 后由**插件队列自动晋升** pending 并派发，'
    + '不占你的回合、不用你 wait_agent 也不用轮询——这一回合没有别的事就正常结束，B 到点自己开始',
  upstreamFailed: '前置失败 → 下游自动 failed：前置 failed / cancelled / orphaned / 不存在时下游直接失败并写明原因'
    + '（失败沿链循环传播）；要接着做用 `task_message({ action: "retry" })` 重派，不要原地等一条已经死掉的链',
  deliveredNotDone: '前置「已交付待确认」（delivered）不算 done：依赖就绪只认 done——前置停在等你确认时下游一直 waiting_dep；'
    + '确实要推进就先 `task_message({ action: "close" })` 收成 done（或等超时自动完成），别重复派下游、也别把 delivered 当失败',
  // 用户 2026-11-23 拍板：参数名就是 `chain: "auto"`（不用 closePredecessorOnDelivered）。
  // 语义：只对「交付那一刻仍有 waiting_dep 下游」生效；无下游/不带标记的链行为一个字节都不变。
  // 与执行层一致：`src/delivered.js` 的 chainAutoGate + autoCloseChainDelivered（复用 closeDelivered），
  // 下游晋升仍由 `queue.pump()` 开头的 `promoteDependents` 负责，本段不新增执行语义。
  chainAuto: '链式自动放行（`chain: "auto"`，派上游时显式加）：带标记的任务交付时**仍有 waiting_dep 下游在等**就自动确认完成'
    + '（`accepted_by` / `close_reason` 都是 `chain`），下游随即由队列晋升；没有下游时照旧停在「已交付待确认」，'
    + '不带标记的链行为不变。自动放行后**没有追问窗口**（`done` 不能追问；要接着改用 `resume` 续跑原会话，或 `retry` 新任务）',
  worktreeSerial: '同一 worktree 检出必须用 dependsOn 串行：两个任务同时写一个检出会互相覆盖——后一个带 dependsOn 排队，'
    + '或者各建一个检出（worktree:true）**并行**（互不依赖、无需复用上下文时首选，见下「并行策略」段）；'
    + 'worktreeMode:"continue" 复用检出同样只能串行',
  compat: '与既有口径的关系：这条不推翻「禁止阻塞等待/不轮询」「能直接回答就不派任务」「推进循环」「交付两段式」——'
    + '建链属于「推进」那一类动作；晋升与失败传播是执行层硬机制，建不建链是你的判断（提示词约束）',
})

/**
 * `task_create.dependsOn` 的工具描述：与 L1 的任务链段**逐字同源**（规则句只在 copy.js 写一次）。
 *
 * 为什么工具描述也要写全：协调者读的是工具表，派单那一刻手边只有 schema——只写「依赖完成才派发」
 * 会让人以为要自己等，于是不会用 dependsOn。
 */
export const TASK_CHAIN_TOOL_DESC = '前置任务编号数组（任务链；依赖就绪由插件队列自动晋升，不占你的回合）——'
  + [TASK_CHAIN_LINES.criteria, TASK_CHAIN_LINES.buildNow, TASK_CHAIN_LINES.notBlocking,
    TASK_CHAIN_LINES.upstreamFailed, TASK_CHAIN_LINES.deliveredNotDone, TASK_CHAIN_LINES.worktreeSerial]
    .join('；')

/** waiting_dep 创建回执的补充一句（协调者看到时不要以为要自己等）。 */
export const TASK_CHAIN_WAITING_NOTE = `依赖完成由插件队列自动晋升（不占回合，不用轮询）：${TASK_CHAIN_LINES.notBlocking}`

/**
 * 链式自动放行（`task_create.chain`）的四句文案：工具描述 / 创建回执 / 交付回执 / 通知。
 *
 * 为什么单独一组而不是塞进 TASK_CHAIN_LINES：那组句子有「L1 → 工具描述逐字同源」的探针
 * （`test/task-chain-policy.test.js` 断言 dependsOn 描述 == TASK_CHAIN_TOOL_DESC），
 * 而 `chain` 是**另一个参数**的描述，混进去会让 dependsOn 的描述多讲一个它不管的开关。
 * L1 只讲判断口径（TASK_CHAIN_LINES.chainAuto），回执/通知/工具描述各自引用这组常量，句子仍只定义一次。
 */
export const CHAIN_AUTO_TOOL_DESC = '链式自动放行：只接受 "auto"。带该标记的任务交付（落「已交付待确认」）时，'
  + '若仍有 waiting_dep 的下游在等，插件直接按确认逻辑收成 done（accepted_by=chain、accepted_kind=delivery、close_reason=chain），'
  + '下游自动晋升；没有下游时保持「已交付待确认」，不传则完全不自动放行。自动放行后不能追问（要改请 resume 续跑原会话或重新派任务）'

/** task_create 回执的补充行：让协调者在建链那一刻就知道这条链不会再卡在确认上。 */
export const CHAIN_AUTO_CREATE_NOTE = '链式自动放行：本任务交付时若仍有下游在等，插件会自动确认完成（不必再等 close）；没有下游时仍停在「已交付待确认」。'

/** task_report done 的回执（替代 deliveredReceiptNote）：子会话拿到的是「已自动放行」而不是「等确认」。 */
export const CHAIN_AUTO_RECEIPT_NOTE = '交付即自动放行（chain:"auto"）：交付时仍有下游在等，本任务已自动确认完成并唤醒下游；'
  + 'done 不能追问；要改请 resume 续跑原会话（写域判定仍生效）或重派。'

/** 通知正文追加句（结算与 task_report 两条交付路径共用）：协调者看到的是「已完成」，不再被要求去 close。 */
export const CHAIN_AUTO_NOTICE = '链式自动放行（chain:"auto"）：交付时仍有下游在等，已自动确认完成并唤醒下游；'
  + 'done 不能追问，要改请 resume 续跑原会话或 retry 新任务'

/**
 * 并行策略的原子句：协调者 L1 的「什么时候并行、什么时候串行」判断口径。
 *
 * 背景（t-c8adaeb1，用户原话：「协调者提示词现在有冲突就创建 worktree，尽量提高并行
 * （如果不依赖、无需复用上下文的话）的提示吗？没有就加上」）：worktree / 写域 / 任务链三段各自都对，
 * 但缺一句「没依赖就别排队」——写域被拒时先想到关旧任务，任务链段又只讲怎么建链，合起来读就变成
 * 「默认串行、冲突才隔离」。本段把三段并列成一条判断顺序，**不新增任何执行层语义**。
 *
 * 改句子前先确认实现没变：并行靠的是既有 `task_create.worktree` 与队列并发位，
 * 本段只是把「优先并行、只有依赖/复用上下文才串行」写进协调者每回合都读得到的口径。
 */
export const PARALLEL_LINES = Object.freeze({
  heading: '并行策略（互不依赖、无需复用上下文时优先 worktree 隔离并行）',
  criteria: '判断标准（三条同时满足才并行）：① **互不依赖**——B 的输入不是 A 的产物、谁先谁后都行（不建 dependsOn）；'
    + '② **不需要复用同一子会话上下文**——不是追问、续写，也不是同一份计划的后续轮次；'
    + '③ **同一写域会撞车**——target 相同/互相包含，或 writeScopes 重叠（不撞车就直接并行，不用建检出）',
  prefer: '优先并行：三条都满足时，新任务**直接传 `worktree: true`** 在独立检出里并行跑；'
    + '不要为了省事把两个互不依赖的任务串成 dependsOn 链，也不要在同写域被拒时默认「先关旧任务、再重派」——'
    + '串行是**有依赖**时的解法，不是默认姿势',
  serial: '只有这两种情况才串行：① **有依赖**（B 要用 A 的产物 → 建 dependsOn，见上「任务链」段）；'
    + '② **要复用同一子会话上下文**（续写/追问同一份活 → `task_message` 追问原会话；'
    + '复用同一检出 → `worktreeMode: "continue"` 并串行）',
  cost: '代价（并行前跟用户说清楚）：① 产物在各自分支的检出里，**合并由用户决定**——并行越多合并面越大，'
    + '别把同一批文件拆成两条并行；② 每个检出都是空目录，子会话要先装依赖'
    + '（`pnpm install` / `npm install` / `uv sync`，只装不升），第一个任务会慢一点；③ 并发 `git commit` 会争 `.git` 锁',
  exceptions: '例外（不必隔离）：**只读任务**（`readOnly: true`）与**计划阶段**（`planFirst: true` 批准前）不改文件，'
    + '同目录并行也不冲突，直接派；**同一 worktree 检出永远只能一个任务在写**——'
    + '`worktreeMode:"continue"` 复用或同一条链上的任务必须 dependsOn 串行',
  align: '与三段口径的关系（一致，不互相推翻）：① 「同写域并发防护」默认**拒绝**同目录并行，'
    + '被拒时先考虑 worktree:true 并行，只有「这个目录确实只该有一个任务在写」才关旧任务重派；'
    + '② 「任务链」只用于有依赖的链，不是给无依赖任务排队用的；'
    + '③ 「worktree 隔离」讲怎么建检出，本段讲什么时候该并行、什么时候必须串行；'
    + '④ 计划批准、两段式交付、同写域判定、任务链失败传播这些硬规则一条没变',
})

/**
 * 两段式终态（delivered）的原子句：状态名 / 非终态 / 追问 / 确认 / 超时。
 *
 * 口径（0.14.x 起）：`done` 只是交付，任务停在「已交付待确认」；要改就追问原会话（复用同一个子会话），
 * 用户明确确认（或超时）才收成 `done`。任何模块讲这件事都用这里的原子，别再自己造第三套说法。
 */
export const DELIVERY_LINES = Object.freeze({
  state: '已交付待确认',
  statusWord: '待确认',
  statusCode: 'delivered',
  notFinal: '不是终态',
  followupRule: 'task_message 追问原会话（复用同一个子会话，不新建任务）',
  closeCall: 'task_message({ action: "close" })',
  closeCallWithTaskId: 'task_message({ action: "close", task_id: \'<任务引用>\' })',
  timeoutWord: '超时',
  timeout: '超时自动完成',
})

/** 跨层共享的一句话事实（L1 决策口径、L2 回报指引、L3 完成动作、通知动作指令都依赖它）。 */
export const DELIVERY_NOT_FINAL = `done ${DELIVERY_LINES.notFinal}：`
  + `任务落在「${DELIVERY_LINES.state}」（${DELIVERY_LINES.statusCode}），等你或用户确认，或${DELIVERY_LINES.timeout}`

/** 交付通知的动作指令（协调者收到 delivered 通知时看；`<任务引用>` 由调用方替换成 tk-）。 */
export const DELIVERED_HINT = `默认保持待确认（别急着关闭）：要改 ${DELIVERY_LINES.followupRule}；`
  + `用户明确说确认完成时再 ${DELIVERY_LINES.closeCallWithTaskId}；一直不确认则${DELIVERY_LINES.timeout}。`

/**
 * progress 进展通知的一句话口径（`src/notify.js` 的通知尾部 + L1 协调者 policy 共用）。
 *
 * 为什么必须说死：progress 是「任务还在跑」的信号，不是终态。协调者读成「汇报完了」就会去
 * 转述/重派；读成「要它回话」就会原地等。唯一的动作是**追问同一子会话**（复用已有上下文），
 * 这也正是「不设显式终态、靠 resume/追问继续」这条方向在日常回合里的入口。
 */
export const PROGRESS_NOTICE_HINT = 'progress 只是进度信号、不是终态：任务还在跑，'
  + '要结论就 task_message 追问同一子会话（复用已有上下文），别为此重派任务'

/**
 * 堵塞项四类（L1 交互闸门与 W1 执行期上报的 `BLOCKED_HINT` 共用，措辞只此一处）。
 *
 * 为什么要把「四类」写死：执行期的打断只有在「继续做就是错」时才值得；其余（进度、能否关闭、
 * 自己查得清的事实）都该按建议继续，否则「少打扰」只是一句空话。L1 的 B1–B4 展开是这四类的解释，
 * 不重抄本句；两处引用同一个常量。
 */
export const BLOCKER_RULE = '已确认的验收/范围/方案不可达、需要新授权（权限/远端写/发布/删数据/不可逆）、'
  + '子会话报 blocked 且选项要用户定、事实在你的工具面外查不到'

// ── 任务子会话（W1 per-turn policy）的句子 ─────────────────────────────────────
// 背景（t-4f7ce108，用户原话：「协调者预设有 policy，但任务执行者却没有……将静态提示词内容都统一移入
// 任务执行者的 policy，这样每次跑都会注入，效果更好。」）：这些句子原先分两处——brief 内联（执行中上报 /
// 交付确认 / worktree 装依赖 / task_detail 指引）与 worker 预设 persona（主动读 context）。
// 两者都只在**派发那一刻**到达子会话，续派/多轮之后容易被上下文挤掉；而 per-turn policy 每回合重渲染。
// 现在句子只在本模块定义一次，`src/prompt-layers.js` 的 `renderWorkerPolicy` 负责渲染，
// `index.js` 的 `systemPrompt.context` 负责按任务子会话注入；brief 与 persona 只留一次性参数与身份。

/** 交付 summary 的三要素（W1 的交付口径引用；brief / task_detail 都不再各写一份）。 */
export const SUMMARY_FIELDS = '改了什么、改了哪些文件、怎么验证的'

/** 开工先读详情（W1 唯一措辞）：brief 只留一行指针，字段清单在这里讲一次。 */
export const WORKER_DETAIL_HINT = '开工前先调 task_detail（参数 task_id 就是任务引用 tk-xxxxxx）：'
  + '目标全文、验收标准、约束、背景资料、用户原话、工作目录与权限、前置任务、经验文件、已有产物都以台账为准；'
  + 'brief 只是指针，不要凭它猜任务内容。'

/**
 * 执行期上报（W1 唯一措辞）。
 *
 * 关键事实（平台约束，别写错）：`ask_user_question` 对 subagent 来源的会话直接拒绝——
 * `assertLiveRoot` 见到 `session.header.origin === 'subagent'` 就抛 `DELEGATED_CALLER`。
 * 所以「问用户」始终由协调者做：子会话只负责把问题与选项交回去（blocked + question/options）。
 */
export const BLOCKED_HINT = `执行中只把**堵塞项**交给用户拍板：${BLOCKER_RULE}；`
  + '用 task_report 的 blocked 上报「问题 + 选项建议」，由协调者用 ask_user_question 向用户确认后经 task_message 续派再继续；'
  + 'blocked 的 question 里有多条待拍板项时，以「待拍板：」开头逐条列（一条一行、以「- 」开头、用问句原文、不编号）——通知据此点数，协调者据此逐项提问；'
  + '不要自行假设用户意图、不要阻塞等待、也不要等不到回复就跳过。blocked 只是上报，不等于已获授权。'
  + '协调者转来的方向调整以追加消息为准：先按新方向评估影响面，超出原验收标准或范围就先 blocked 要新范围，不要自行扩大范围。'

/** 交付与确认（W1 唯一措辞；`done` 会清空 question/options 是平台事实）。 */
export const CONFIRM_HINT = `完成后用 task_report 回报（progress / done / blocked / needs_auth）：`
  + `把 summary 写成「结论 + ${SUMMARY_FIELDS}」，并带上待确认要点；`
  + 'done 会清空 question/options，所以要点必须在 summary 里；'
  + 'done 先记录交付请求，回合结束保存最终快照后才交付；回报后不要继续修改文件。阶段文档用 artifact_save；checkpoint:true 保存阶段，changedFiles 补充宿主未捕获文件。'
  + `报 done 只是「交付」：任务停在「${DELIVERY_LINES.state}」，由协调者/用户确认或${DELIVERY_LINES.timeout}；`
  + '收到追问就在同一个会话里继续，不要自行宣告任务结束；'
  + '子会话直接调 ask_user_question 会被平台拒（DELEGATED_CALLER）：交付后协调者不会为「能不能关闭」来问你。'

/**
 * 权限 / 环境失败必须写进回报（W1 唯一措辞，2026-11-23 用户原话：「权限/环境失败必须写进回报」）。
 *
 * 为什么要单独一句：子会话的权限/沙箱拒绝在编排面上原本会消失——协调者只看得到 `task_report` 的
 * summary，子会话若把它当普通报错跳过，主会话就永远不知道「这条命令其实被沙箱拒了」。
 * 配套事实（不在句子里重复讲）：插件侧另有一条 `tools/result` 观察者（`src/child-tool-failure.js`）
 * 会把 denied 类失败自己报给协调者；本句管的是**外部子会话**与「插件没识别出来」的那部分。
 */
export const WORKER_PERMISSION_HINT = '遇到权限/沙箱/审批拒绝或环境失败（命令找不到、依赖缺失、沙箱/runner 起不来）不要只当普通报错：'
  + '能自己用窄一级的 sandbox_permissions + justification 重试一次就重试一次；'
  + '仍不行就在 task_report 的 summary 里写明「哪条命令、什么 code/提示、试过什么」，交付 done 时同样必须写——'
  + '协调者据此决定回喂正确姿势还是改派，别让失败只留在你的上下文里。'

/**
 * worktree 检出依赖（W1 的条件句，只在任务的 `worktree_state` 属于真隔离时渲染）。
 *
 * 检出是全新目录，node_modules/虚拟环境这类依赖不在库里 → 子会话常因依赖缺失跑不了测试/构建。
 * 只说「可以装、只装不升」：不授权改依赖版本，也不放宽任何推送前审查/人工确认门禁。
 */
export const WORKTREE_INSTALL_HINT = '本任务在独立检出里跑，检出目录没有依赖：可执行安装命令（pnpm install / npm install / uv sync 等），'
  + '只安装不升级（不改依赖声明与版本）。'

/**
 * 子会话「主动读上下文」的引导（W1 唯一措辞）。
 *
 * 配套事实（不在本句里重复讲）：`context` 只读且子会话可用（worker 预设 keep 声明它出生即可用）；
 * 写记忆的能力与边界归下一句 `WORKER_MEMORY_HINT`（这里只讲「查」，不讲「写」）。
 */
export const WORKER_CONTEXT_HINT = '需要历史经验/项目背景时主动调 context（mode 取 history / project / workspaces，只读）：'
  + '查本项目经验要显式传 project:<你的 target_dir 或工作区名>（不传只查 global 跨项目记忆），不要等协调者注入。'

/**
 * 子会话「沉淀项目经验」的引导（W1 唯一措辞，2026-11-21 用户方向：子会话也该能写记忆）。
 *
 * 边界写死在句子里（执行层另有硬护栏，这里是模型面口径）：
 * - 只写 `note` / `lesson` / `decision` 三类项目级事实，不写 `preference`（偏好只协调者维护、每回合注入）；
 * - 不写全局/跨项目记忆，不写日志（完成记录由协调者按 `task_report` 的 summary 沉淀）；
 * - `project` 只能是自己任务的 `target_dir`，单任务最多 3 条。
 */
export const WORKER_MEMORY_HINT = '任务收尾时：有值得复用的项目经验就用 memory_note 写一条 note/lesson/decision'
  + '（project 只能是你自己任务的 target_dir，单任务最多 3 条，重复内容不会重复写入）；'
  + '不写 preference、不写全局/跨项目记忆，也不写日志——完成记录由协调者按 task_report 的 summary 沉淀。'

/** W1 段标题（渲染入口在 `src/prompt-layers.js` 的 `renderWorkerPolicy`）。 */
export const WORKER_POLICY_HEADING = '回报与确认（任务子会话每回合都在，不必等 brief 再说）'

/** W1 的固定句子：一句一件事，渲染顺序也在这里定。 */
export const WORKER_POLICY_LINES = Object.freeze({
  detail: WORKER_DETAIL_HINT,
  blocked: BLOCKED_HINT,
  permission: WORKER_PERMISSION_HINT,
  report: CONFIRM_HINT,
  context: WORKER_CONTEXT_HINT,
  memory: WORKER_MEMORY_HINT,
  worktree: WORKTREE_INSTALL_HINT,
})

/**
 * 子会话工具失败的告警文案（NOTIFY 层唯一措辞，2026-11-23 用户拍板：带 stderr 首行但脱敏家目录）。
 *
 * 结构与其它通知一致：一行事实（工具 + code + 沙箱模式）→ 一行归属（任务名 + `tk-` 引用 + 证据首行）→
 * 一行动作（协调者现在能做什么）。只用引用，不写台账内部编号（ID 出口网关版本 B）。
 * `head` 由 `src/child-tool-failure.js` 的 `failureHead` 截断并脱敏后再传进来，这里不再二次处理。
 */
export function toolFailureNotice({ label, ref, tool, code, mode, head } = {}) {
  const name = typeof label === 'string' && label !== '' ? label : '任务'
  const reference = typeof ref === 'string' && ref !== '' ? `（${ref}）` : ''
  const modeText = typeof mode === 'string' && mode !== '' ? `（${mode}）` : ''
  const headText = typeof head === 'string' && head !== '' ? `：${head}` : ''
  return `子会话被权限/沙箱拒绝（疑似）：${tool ?? '工具'} → ${code ?? 'UNKNOWN'}${modeText}\n`
    + `任务「${name}」${reference}${headText}\n`
    + '处理：判断是缺 sandbox_permissions（同回合升级一次）、该给 access:\'full\'、还是改派/回落——'
    + '不要只当普通报错，也不要让它重试同一条命令。'
}

/**
 * 追加调整的评估要素（L1 交互闸门与 `task_message` 描述共用）。
 *
 * 顺序（影响面 → 风险 → 建议）不能换：先算影响再给建议，用户才能选「继续还是停」；
 * 反过来先给建议等于替用户拍板。
 */
export const CHANGE_REVIEW_FIELDS = '影响面（哪些任务/产物/已交付结论会变）、风险（验收是否失效、是否触碰不可逆或授权）、建议（继续/增量追加/停下重派）'

/** `task_report` 交付回执：交付不是结束，确认/超时才收成完成。 */
export const deliveredReceiptNote = `\n${DELIVERY_LINES.state}：这是交付、${DELIVERY_LINES.notFinal}；`
  + `协调者可能用 task_message 追问（同一会话继续），确认或${DELIVERY_LINES.timeoutWord}后才收成完成。`

/**
 * 四个判据的原子句（一句一条判断口径 + 指向对应技能的指针），给 L1 瘦身用。
 *
 * 与上面的 TASK_CHAIN_LINES / PARALLEL_LINES 的关系：那两段是完整展开版（回执、工具描述、通知都引用），
 * 这里是压缩成一句话的判据，只讲「怎么判」，细节交给对应技能，避免同一份口径在提示词里讲两遍。
 * 目前只定义、尚未接线（渲染层改造是下一步），所以不新增任何执行层语义。
 */
export const WORKTREE_CRITERIA = 'worktree 判据：B 的输入是 A 的产物 → dependsOn 串行；'
  + '互不依赖且同写域 → worktree:true 并行，详见 skill({ name: \'orch-worktree\' })'

export const TASK_CHAIN_CRITERIA = '任务链判据：B 的输入是 A 的产物就是一条链（实现→验收、构建→发布、修复→回归），'
  + '派 A 的同一回合就建 B，详见 skill({ name: \'orch-task-chain\' })'

export const PARALLEL_CRITERIA = '并行判据：互不依赖、不复用同一子会话上下文、同写域会撞车三条同时满足，'
  + '就直接 worktree:true 并行，详见 skill({ name: \'orch-parallel\' })'

export const WRITE_GUARD_CRITERIA = '同写域判据：target 相同或 writeScopes 重叠即同写域，默认拒绝并发——'
  + '先考虑 worktree:true 并行，详见 skill({ name: \'orch-parallel\' })'
