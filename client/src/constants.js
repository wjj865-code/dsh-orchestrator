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
export const ROUTE = 'api/orchestrator'
export const POLL_MS = 2000
export const POLL_BACKOFF_MS = 30000
// 任务入口闸门的兜底轮询：会话切换走订阅即时判定；这里只负责「首帧没判出来 / 请求失败」的重试。
export const MAIN_VIEW_POLL_MS = 5000
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
  settle: '结算',
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
