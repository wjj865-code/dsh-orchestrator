/**
 * 面板常量与文案表（P7 / T7.2 从根目录 client.js 迁入，行为不变）。
 *
 * 这里只放「不依赖 React、不依赖 ctx」的纯常量：面板 id、路由、轮询间隔、筛选项与文案映射。
 * 服务端/测试与客户端约定的字符串（STATUS_ / MESSAGE_KIND_ / DELIVERY_ / GOAL_ 系列）改动要同步
 * src/panel-actions.js、src/panel-gates.js 与 test/client.test.js。
 */
// 客户端工厂 id 必须等于包名（DSH client-modules 按包名索引），scoped 包也一样。
export const CLIENT_ID = '@wjj865-code/dsh-orchestrator'
export const PANEL_ID = 'orchestrator'
export const LAUNCHER_ID = 'orchestrator-launcher'
// 0.32.0 能力包：main 面板 key 与侧栏入口 id 同值（一个面板一个 key；侧栏 selectPanel 用它）。
export const CAPABILITY_PACKS_PANEL_ID = 'capability-packs'
// 能力包快照轮询：包状态变化慢（安装/删包是人工动作），15s 足够且不跟任务面板的 2s 抢带宽。
export const PACK_POLL_MS = 15000
export const ROUTE = 'api/orchestrator'
export const POLL_MS = 2000
export const POLL_BACKOFF_MS = 30000
// 任务入口闸门的兜底轮询：会话切换走订阅即时判定；这里只负责「首帧没判出来 / 请求失败」的重试。
export const MAIN_VIEW_POLL_MS = 5000
// 回复底部关联任务 chip（conversation.chat.turnTail 槽位）：
// - CHIP_ID 是 list 槽位的定址 id；同一 id 复注册表示「替换」而不是新增。
// - chip 只挂在最新一轮回复上，所以轮询只在这一行挂载时进行：有活跃任务 3s，全是终态 15s，
//   失败退避 30s（与面板同口径）；没有订阅者立刻停表。
export const CHIP_ID = 'orchestrator-task-chips'
export const CHIP_MAX = 2
export const CHIP_RECENT_MS = 30 * 60 * 1000
export const CHIP_POLL_MS = 3000
export const CHIP_IDLE_MS = 15000
// 入选 chip 的「活跃」状态：等前置/待派发 也算活跃（用户原话：等前置不是取消）。
// feed 用它决定轮询节奏，逻辑用它决定入选；两处同源。
export const CHIP_ACTIVE_STATUSES = ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered']
// 视觉状态：把台账的 10 个状态压成 5 个图标态（运行中 / 等前置 / 待确认 / 完成 / 失败 / 取消）。
export const CHIP_STATE_OF = {
  running: 'running',
  pending: 'waiting', waiting_dep: 'waiting',
  waiting_user: 'confirming', waiting_auth: 'confirming', delivered: 'confirming',
  done: 'done',
  failed: 'failed', orphaned: 'failed', missing: 'failed',
  cancelled: 'cancelled',
}
// 图标 + 文案。半色/脉冲由 confirming 态承担；等待态用虚线静圈，不跟运行中抢动效。
export const CHIP_STATE_VIEW = {
  running: { icon: 'ring', className: 'orch-taskchip-spin', tone: 'info' },
  waiting: { icon: 'dashed', className: 'orch-taskchip-dashed', tone: 'muted' },
  confirming: { icon: 'dashed', className: 'orch-taskchip-dashed', tone: 'warn' },
  done: { icon: 'check', className: '', tone: 'good' },
  failed: { icon: 'close', className: '', tone: 'bad' },
  cancelled: { icon: 'dash', className: '', tone: 'muted' },
}
// 注入的 <style> id：HMR/重复 apply 时按 id 去重，避免样式表被插两遍。
export const STYLE_ID = 'dsh-orchestrator-styles'
export const FILTERS = [
  ['all', '全部'], ['active', '进行中'], ['waiting', '待你决定'],
  ['done', '已完成'], ['failed', '失败'], ['closed', '已取消/丢失'], ['artifacts', '产物'],
]
// 概览卡（三段式第一段）：点卡片等价于切筛选项。
export const METRICS = [['active', '进行中'], ['waiting', '待你决定'], ['done', '已完成'], ['failed', '失败']]

export const STATUS_LABEL = {
  waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  delivered: '待确认', done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失', missing: '缺失',
}
export const STATUS_TONE = {
  waiting_dep: 'warn', pending: 'muted', running: 'info', waiting_user: 'warn', waiting_auth: 'warn',
  delivered: 'warn', done: 'good', failed: 'bad', cancelled: 'muted', orphaned: 'bad', missing: 'bad',
}
// 消息类型与 followup 的投递状态（与 src/panel-actions.js 的 delivery 字段一一对应）。
export const MESSAGE_KIND_LABEL = {
  brief: '任务简报', followup: '追加消息', delivery_failed: '投递失败', report: '回报', progress: '进展',
  settle: '结算', acceptance: '验收',
}
export const DELIVERY_LABEL = { pending: '待发', delivered: '已投递', failed: '投递失败' }
export const DELIVERY_TONE = { pending: 'warn', delivered: 'good', failed: 'bad' }
// 平台 goal 只读展示（G1）：phase/activation 来自 ctx.goals，面板不提供任何写操作。
export const GOAL_PHASE_LABEL = {
  active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成', cleared: '已清除',
}
export const GOAL_ACTIVATION_LABEL = { armed: '自动续轮已启用', disarmed: '不自动续轮' }
// P8 计划模式：plan_state 由服务端台账下发（none/planning/approved/rejected），面板只读展示。
export const PLAN_STATE_LABEL = {
  none: '无计划状态', planning: '计划中（等批准）', approved: '已批准执行', rejected: '计划未通过',
}
// P9 worktree 隔离：worktreeState 由服务端台账下发（none/requested/created/reused/degraded/rejected/failed/cleaned）。
export const WORKTREE_STATE_LABEL = {
  none: '未隔离',
  requested: '待建检出',
  created: '已隔离',
  reused: '复用已有检出',
  degraded: '已降级（不是 git 仓库）',
  rejected: '隔离被拒绝',
  failed: '隔离创建失败',
  cleaned: '检出已清理',
}
// 决定者：task=协调者传字段、config=配置兜底、default=都没说（面板只读展示）。
export const WORKTREE_SOURCE_LABEL = {
  task: '协调者传字段', config: '配置兜底', default: '都没说',
}
// 语义色只取设计平台 token：旧版用的那组 alias color 变量在宿主 token 表里并不存在，
// 一直走的是 fallback（深色主题下会脏）。这里换成 state/label 语义 token，深浅色自动跟随。
export const TONE_COLOR = {
  good: 'var(--dsw-alias-state-success-primary, #01a241)',
  bad: 'var(--dsw-alias-state-error-primary, #ec1313)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59f0a)',
  info: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  muted: 'var(--dsw-alias-label-tertiary, #8a8f99)',
}

// ---------------------------------------------------------------------------
// 工作台 v1（P11）：页面 / 看板列 / 日历 / 右侧 dock
// ---------------------------------------------------------------------------
// 工作台是**一个** main 面板的内部六页（不新开第二个 main key：宿主一次只显示一个面板，
// 切 key 会丢状态、还会起两份快照轮询）。页面状态记在 sessionStorage，因为预览产物会
// `selectPanel(null)` 卸载面板，回来要能复原到同一页同一组。
export const WORKBENCH_PAGES = [['overview', '总览'], ['groups', '任务组'], ['schedule', '排期'], ['automations', '自动化'], ['review', '复盘']]
export const WORKBENCH_STORAGE_KEY = 'dsh-orchestrator:workbench'
// 工作台的独立数据源（组/日历/自动化/复盘）不跟 2s 快照轮询：15s 或动作后刷新，页面不可见时停表。
export const WORKBENCH_POLL_MS = 15000
// 复盘页的两个窗口（天）。窗口口径由服务端 stats 夹到 ≤62 天，客户端只提供这两个入口。
export const REVIEW_DAYS = [7, 30]
// 看板列：把台账 10 个状态压成 6 列（列只承载筛选，**不能靠拖拽改状态**——状态机是插件的核心）。
export const BOARD_COLUMNS = [
  { key: 'queue', label: '等前置 / 待派发', statuses: ['waiting_dep', 'pending'], tone: 'muted' },
  { key: 'running', label: '在跑', statuses: ['running'], tone: 'info' },
  { key: 'delivered', label: '待确认', statuses: ['delivered'], tone: 'warn' },
  { key: 'asking', label: '待你决定', statuses: ['waiting_user', 'waiting_auth'], tone: 'warn' },
  { key: 'done', label: '完成', statuses: ['done'], tone: 'good' },
  { key: 'failed', label: '失败 / 取消', statuses: ['failed', 'orphaned', 'cancelled'], tone: 'bad' },
]
// 日历周起始：周一到周日（中文习惯；media-desk 用周日起始，这里刻意不同）。
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
// 排期默认时刻（照消费级工作台的习惯：没排过就落在晚上 8 点，可再改）。
export const DEFAULT_PLAN_HOUR = 20
// 自动化页「创建自动化」按钮写进主会话输入框的提示词（0.33.0，对齐官方「在会话中创建」）。
// 官方原文只有一句 `请根据需求创建一个自动化任务。`（ui-schedule 的 host.createPrompt）；
// 这里把本插件三条既有产品决策写死在提示词里，避免模型跑偏：
//   1) 只投唯一主会话（target 用本会话，不新建会话）——到点唤醒只走主会话；
//   2) 范围默认全部任务（收件箱巡检），面板不再有「按组建」；
//   3) 到期先 task_list 核对再 task_create——不是定时器直接建任务。
export const AUTOMATION_CREATE_PROMPT = '请创建一个自动化任务：到期把话术投递到本会话（target 用本会话，不要新建会话），'
  + '届时由协调者先 task_list 核对再决定是否 task_create。范围是全部任务（收件箱巡检），具体要做什么、什么时候由我补充。'
