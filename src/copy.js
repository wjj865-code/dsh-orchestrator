// 文案单一真源（copy）：同一句话只写一次，brief / task_detail / 工具回执 / 通知 / 计划文档一律引用。
//
// 背景（P1-C，承接审计 §5.1 的文案矛盾）：计划阶段与「两段式终态」的表述原先散在 8 个模块里，
// 同一件事被写了 3–5 遍（`plan-mode` / `plan-doc` / `task-detail` / `tools` / `notify` /
// `prompt-layers` / `keepalive` / `write-guard`）；改一处其余就跟不上，已经发生过漂移
// （工具数 15→14、`full` 的三种说法各写一份）。
//
// 分工（与 `src/prompt-layers.js` 的层归属配套）：
// - 这里只放**跨模块共享的原子句 + 拼装函数**；本模块不 import 任何模块（叶子），谁都能引用而不引入环；
// - 一层独占的措辞仍留在本层（协调者规则归 L1 `/index.js`，面板短标签归客户端）；
// - 客户端是浏览器 bundle、无法 import 服务端模块，靠 `test/copy-consistency.test.js` 的同值断言兜住漂移。
//
// 判据（写新文案前先自问）：这句话会不会在第二个模块出现？会 → 放这里；不会 → 留在本层。

/** 计划文档目录（展示用；真实路径由 `src/plan-doc.js` 的 `PLAN_SUBDIR` 拼，两者必须一致）。 */
export const PLAN_SAVE_DIR = '主会话工作区的 reports/plans/'

/** 计划文档路径文案：不给 `taskId` 时写占位符 `<taskId>`（提示词/文档里就是占位口径）。 */
export const planDocPathText = taskId => {
  const id = typeof taskId === 'string' && taskId.trim() !== '' ? taskId.trim() : '<taskId>'
  return `${PLAN_SAVE_DIR}${id}.md`
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
  saveEntry: '计划阶段唯一允许的写入口：路径固定、不接受自定义路径、禁止逃逸，也不要用 write/edit/pwsh 硬写。',
  reportCall: 'task_report 报 blocked',
  reportSummaryShort: REPORT_SUMMARY_SHORT,
  reportSummary: REPORT_SUMMARY,
  reportQuestion: REPORT_QUESTION,
  reportRule: `summary 只写 ${REPORT_SUMMARY}；question 写「${REPORT_QUESTION}」，`
    + '不要把计划正文贴进 question（上限 500 字，会截断）。',
  reportCallFull: `task_report({ status: "blocked", summary: "<${REPORT_SUMMARY_SHORT}>", question: "<${REPORT_QUESTION}>" })`,
  noExitPlanMode: `不要调用 exit_plan_mode：${NO_DIRECT_HUMAN}（调用会被插件拒绝）。`,
  resume: '用户批准后协调者会 task_message 续派，插件把沙箱切回可写，再按计划执行。',
  options: '- options 可给「批准执行 / 调整计划」。',
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
  + '由协调者转交用户批准；批准后协调者用 task_message 续派，插件会把沙箱切回可写再执行。'

/** 计划状态行（`task_status` 与面板同口径）。 */
export const PLAN_STATUS_LINES = Object.freeze({
  planning: `计划：计划中｜子会话只读探索，计划用 plan_save 落盘到${PLAN_SAVE_DIR}；`
    + '用 task_message（或面板「追加」）批准后自动切回可写执行',
  approved: '计划：已批准｜沙箱已切回可写，子会话按计划执行',
  rejected: '计划：未批准｜计划阶段已结束（停止或结算时未获批准）',
  none: '计划：无进行中的计划',
})

/** `task_create` 回执里的计划模式提示（给协调者看的动作指令）。 */
export const planCreateReceipt = taskId => `计划模式：子会话只读探索，探索完先 plan_save 把计划写入${planDocPathText(taskId)}（自动登记为产物），`
  + `再用 ${PLAN_PHASE_LINES.reportCall} 只上报 ${PLAN_PHASE_LINES.reportSummaryShort} + ${PLAN_PHASE_LINES.reportQuestion}；`
  + '你转交用户，批准后用 task_message 续派（插件自动切回可写）。'

/** `plan_save` 工具描述（模型侧唯一的入口说明）。 */
export const PLAN_SAVE_TOOL_DESC = `计划模式专用：把计划正文写入${planDocPathText()}并登记为任务产物。${PLAN_PHASE_LINES.saveEntry}`

/** 计划落盘成功后的下一步（`plan_saved_note`：只报摘要，不搬正文）。 */
export const planSavedNextStep = `下一步用 ${PLAN_PHASE_LINES.reportCall}：${PLAN_PHASE_LINES.reportRule}`

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
  closeCallWithTaskId: 'task_message({ action: "close", task_id: \'<任务编号>\' })',
  timeoutWord: '超时',
  timeout: '超时自动完成',
})

/** 跨层共享的一句话事实（L1 决策口径、L2 回报指引、L3 完成动作、通知动作指令都依赖它）。 */
export const DELIVERY_NOT_FINAL = `done ${DELIVERY_LINES.notFinal}：`
  + `任务落在「${DELIVERY_LINES.state}」（${DELIVERY_LINES.statusCode}），等你或用户确认，或${DELIVERY_LINES.timeout}`

/** 交付通知的动作指令（协调者收到 delivered 通知时看；`<任务编号>` 由调用方替换）。 */
export const DELIVERED_HINT = `默认保持待确认（别急着关闭）：要改 ${DELIVERY_LINES.followupRule}；`
  + `用户明确说确认完成时再 ${DELIVERY_LINES.closeCallWithTaskId}；一直不确认则${DELIVERY_LINES.timeout}。`

/**
 * L3（`task_detail`）的完成动作：交付口径与 brief 的 `CONFIRM_HINT` 同源（summary 三问）。
 *
 * @param {string} summaryFields 例如 brief.js 的 `SUMMARY_FIELDS`（改了什么、改了哪些文件、怎么验证的）
 */
export const finishHint = summaryFields => '完成后用 task_report 回报（progress / done / blocked / needs_auth），'
  + `summary 写：${summaryFields}。`
  + `报 done 只是「交付」：任务会停在「${DELIVERY_LINES.state}」，由协调者/用户确认或${DELIVERY_LINES.timeout}；`
  + '收到追问就在同一个会话里继续，不要自行宣告任务结束。'

/** `task_report` 交付回执：交付不是结束，确认/超时才收成完成。 */
export const deliveredReceiptNote = `\n${DELIVERY_LINES.state}：这是交付、${DELIVERY_LINES.notFinal}；`
  + `协调者可能用 task_message 追问（同一会话继续），确认或${DELIVERY_LINES.timeoutWord}后才收成完成。`
