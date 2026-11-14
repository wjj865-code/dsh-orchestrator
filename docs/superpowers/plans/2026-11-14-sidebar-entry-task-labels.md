# 阶段 4 实现方案：插件入口直达主会话 + 汇报用显示名

- 日期：2026-11-14
- 依据：`docs/probes/sidebar-nav-entry-probe.md`（`sidebar-nav-probe.mjs` 16/16 PASS）
- 原则：入口点击复用现有 `open-main`（互斥、预设复用、失效重建都不另起一套）；文档/代码不再注册 `sidebar.footer.action`；`conversation.header.leading` 保留；阶段 1/2/3 能力不回退。

## Task 1 显示名工具（TDD，单独提交）

- 新增 `src/task-label.js`：
  - `shortTaskId(id)`：取 `t-` 后的前 4 位（不足原样）。
  - `taskLabel(task, { all })`：默认返回 `title`；当 `all` 里存在同名（trim 后相同）任务时返回 `title（t-xxxx）`；空 title 回落 `任务 t-xxxx`。
  - `decorateTaskLines(tasks)`：一次性给列表做重名标注（避免逐行 O(n²)）。
- 应用面：
  - `src/notify.js`：完成/失败/等待通知里用 `taskLabel`，**不出现 t-xxx**（重名才带短后缀）。
  - `src/tools.js`：`task_create` 回执、`task_status` 标题行、`task_message/task_stop/task_report` 文案用显示名；仅 `task_list` 行首保留 `标题（t-xxxx）`——模型要靠它取 `task_id` 去续派/停止（与审查口径一致；若 Chief 要求工具返回也零 id，再改成「按标题模糊匹配」的新契约，不在本任务做）。
  - `client.js` 任务卡片：主标签用 `title`，行尾 id 只在日志/工具视图可见；同名时带短后缀。
- 用例：`test/task-label.test.js`（唯一/重名/空标题/短 id）；`test/notify.test.js`、`test/tools.test.js` 断言通知与工具返回里无裸 `t-`（`task_list` 除外）；`test/client.test.js` 同步。

## Task 2 删除底部入口（单独提交）

- `client.js` 删 `ctx.slots.inject('sidebar.footer.action', …)` 与 `SidebarEntry` 组件。
- `docs/probes/qa-stage2-slots.mjs`：删除 footer action 断言，改为「不再注册 footer.action」+「`sidebar.panellist` 恰 1 条 launcher 条目」+「`conversation.header.leading` 仍注册且点击 `selectPanel('orchestrator')`」。
- 真机/单测：`node docs/probes/qa-stage2-slots.mjs client.js`、`node --check client.js`。

## Task 3 侧栏启动器入口（单独提交）

- `client.js`：
  - 抽 `openMainSession()`：复用现有 POST `open-main` + `uiWorkspace.openSession`，保留客户端防双击互斥与可读错误。
  - 新增 `LauncherPanel`：挂载即 `openMainSession()`，成功后 `ctx.layout.selectPanel(null)`；渲染「正在打开主会话…」；失败显示错误 + 重试（留在面板）。
  - 注册 `main` 面板 `key:'orchestrator-launcher'`（不占用任务面板 `orchestrator`）。
  - 注册 `sidebar.panellist` 条目 `{id:'orchestrator-launcher', order:5, label:()=> '主会话'}`，组件画图标（与「插件」同款行，插在 `plugins`(0) 与 `schedules`(10) 之间）。
- 单测（`test/client.test.js` + `qa-stage2-slots.mjs`）：
  - panellist 条目 id/order/label；`main` 面板 key；启动器点击路径 = `open-main` → `openSession(sessionId)` → `selectPanel(null)`（mock fetch/slots/layout）；
  - 双击只发一次 open-main；失败留在面板、可读错误、不调 `selectPanel(null)`。
- Bot 模式：panellist 被 ds-bot 隐藏（外部依赖，记文档）；任务面板仍可从会话头按钮进入。

## Task 4 文档与收尾（单独提交）

- README：入口交互改为「侧栏插件下方『主会话』→ 直达对话」；删「底部任务入口」描述；记 Bot 模式限制与启动器一帧占位。
- `docs/qa-checklist.md`：新增阶段 4 复核矩阵（L1 断言、L3 勾选项：插件下方入口、点击直达、底部入口消失、头部按钮仍开面板）。
- 全量：`npm test`、`sidebar-nav-probe` 16/16、`qa-stage2-slots`、`qa-stage2-route`、`qa-guard-deny`、`qa-increment`、`main-session-probe` 40/40、`preset-scope-restrict` 7/7。

## 风险与边界

- 启动器点击会有一帧面板占位（`selectPanel(null)` 在 openSession 后立刻执行）；真机若出现「高亮残留/闪面板」按失败记，退化到「更多」菜单行（方案 B），不强行注入其它槽位。
- 「重复点击」「主会话创建互斥」沿用现有 `open-main` 与客户端防抖，不新增服务端端点。
- 显示名重名判断基于当前活跃+历史任务集合；`task_list` 仍给 id，纯用户文案零 id。
