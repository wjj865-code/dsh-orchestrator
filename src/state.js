// 任务状态机（对外门面）：文案表 + 转移判定。
//
// 状态的**事实**（全集、能力表、转移表）在 `src/status-facts.js`——那是唯一判定点，
// 本模块只做两件事：① 保留对外文案（`STATUS_LABEL` / `statusLabel`，工具层与面板共用一套）；
// ② 把 `canTransition` / `nextStatus` 原样转发给老调用点（`ledger.transition` 依赖它们抛错）。
//
// 为什么不把文案也搬进 status-facts：文案是**展示层**（中文措辞会变），能力是**语义层**（不该变）；
// 混在一起会让「改一句文案」看起来像「改了一次状态语义」。
//
// 只有子会话的回报（或结算）能推进 running 之后的状态；协调者只能创建、续派、确认交付（task_message action:close）、
// 停止、重派。
import { STATUSES, canTransition, nextStatus, statusesWith } from './status-facts.js'

export { STATUSES, canTransition, nextStatus }

/** 活跃状态（还没落终态）：台账 listTasks(active)、面板闸门、看门狗共用同一口径（派生自 STATUS_CAPS）。 */
export const ACTIVE_STATUSES = Object.freeze(statusesWith('active'))

// 对外状态文案：工具层、面板动作、卡片共用一套（客户端 client.js 因浏览器环境单独保留同值副本）。
export const STATUS_LABEL = {
  waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  delivered: '待确认', done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}

export const statusLabel = status => STATUS_LABEL[status] ?? status
