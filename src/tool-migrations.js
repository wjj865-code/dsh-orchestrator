// 工具名迁移账（P1-B：工具面 15 → 10，模型面 12 → 7）。
//
// 旧名**立刻删**（不注册、不在 allow 名单里、不在协调者 policy 里），但**不能静默**：
// - `index.js` 的执行层 guard 用它给「旧名调用」返回可读迁移提示（模型照旧 AGENTS.md / 旧提示词
//   调 `task_stop` 时，至少拿到一句「改成什么」，而不是一句未知工具就卡住）；
// - CHANGELOG / README 的映射表、`test/tool-migrations.test.js` 断言都读这张表——
//   一处真源，别再各写一份（0.19.x 的 `RESUME_STATUS` 就是各写一份写歪的）。
//
// 注意：这里**只放被合并掉的 6 个名**；`task_create` / `task_status` / `task_detail` /
// `task_report` / `plan_save` / `read_workspace` / `memory_note` 名字不变（子会话契约稳定）。
import { DELIVERY_LINES } from './copy.js'

/** 旧工具名 → 新调用（`call` 可直接抄进提示词/文档，`note` 说清它原来干什么）。 */
export const REMOVED_TOOLS = {
  task_stop: {
    call: "task_message({ task_id, action: 'stop' })",
    note: `停止任务：运行中/排队/等前置/${DELIVERY_LINES.state}都能停，行为与原 task_stop 一致`,
  },
  task_retry: {
    call: "task_message({ task_id, action: 'retry' })",
    note: '重派 failed/orphaned 任务（新任务编号，旧任务留审计），行为与原 task_retry 一致',
  },
  task_close: {
    call: "task_message({ task_id, action: 'close' })",
    note: `把「${DELIVERY_LINES.state}」确认成 done，行为与原 task_close 一致（走同一个 closeDelivered）`,
  },
  task_inbox: {
    call: "task_list({ view: 'inbox' })",
    note: '收件箱：待你决定/待确认/失败丢失/长时间没动静，输出与原 task_inbox 逐字一致',
  },
  history_search: {
    call: "context({ mode: 'history', query })",
    note: '跨项目历史检索（插件记忆/历史任务/平台会话），输出与原 history_search 一致',
  },
  project_context: {
    call: "context({ mode: 'project', target, query })",
    note: '读项目背景；只看已登记工作区与仓库索引用 context({ mode: \'workspaces\' })，等价旧 project_context({ workspaces: true })',
  },
}

/**
 * 旧工具名 → 可读迁移提示；不是旧名返回 `undefined`（guard 靠这个区分「该不该拦」）。
 *
 * 文案要求：说清三件事——**已删除**、**改成什么**、**原来干什么**，让模型一次就能改对。
 */
export function legacyToolHint(name) {
  const entry = Object.hasOwn(REMOVED_TOOLS, name) ? REMOVED_TOOLS[name] : undefined
  if (entry === undefined) return undefined
  return `${name} 已删除（P1 工具面 15 → 10，0.21.0 起）：改用 ${entry.call}。${entry.note}。`
}

/** 旧名清单（做断言/文档时用；顺序稳定便于 diff）。 */
export const REMOVED_TOOL_NAMES = Object.keys(REMOVED_TOOLS)
