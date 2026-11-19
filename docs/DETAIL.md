# 任务编排

协调者 + 子任务工作台：把需求拆成结构化任务，派给独立子会话，看回报、决定是否打扰用户。

## 功能

- **协调者主会话**：固定入口，只做拆任务/派活/看回报，不读写文件、不执行命令。
- **子任务**：独立 DSH 子会话，按目标目录运行；支持只读沙箱、续派、停止、重派。
- **依赖编排**：`dependsOn` 支持前置关系；依赖未完成不派发，完成自动晋升，失败向下游传播。
- **分组/写域/优先级**：`group` 归组看进度，`priority` 高优先级先派；`writeScopes` 与目标目录一起参与**同写域并发防护**（默认拒绝同目录/同写域的未隔离并发任务，可用 `allowConcurrent:true` 或配置 `sameDirGuard` 放宽）。
- **跨项目记忆**：分层沉淀——done 摘要只进 `task-log` 日志层（不进任务详情），经验/决策/偏好蒸馏成原子事实才随 `task_detail` 注入；`context({mode:'history'})` 检索历史，`context({mode:'project'})` 读项目白名单背景。
- **两段式交付**：子会话 `task_report done` 先落 `delivered`（已交付待确认），默认保持待确认，等用户确认（`task_message({action:'close'})`）或用 `task_message` 追问（复用同一个子会话）；超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动完成。`done` 是不可逆终态。
- **brief 纯指引**：派发给子会话的 brief 固定两行（任务编号 +「先调 `task_detail` 读详情」）+ 两行回报指引（「执行中待确认用 blocked 上报」「交付时怎么回报」），共 4 行；
  访问级别（`access:'full'`）与 worktree 隔离任务各多一行（`【访问级别】` / `【worktree 依赖】`），所以实际是 4–6 行。目标/验收/经验/前置任务/产物都由子会话按需现取。
  执行中要用户拍板就 `task_report blocked` 上报「问题 + 选项建议」，协调者问用户后 `task_message` 续派；交付时要点写进 `summary`（`done` 会清空 `question`/`options`）。
  子会话调 `ask_user_question` 会被平台以 `DELEGATED_CALLER` 拒绝，问用户由协调者带选项做。
  worktree 隔离任务的 brief 多一行「检出目录没有依赖，可以装（只安装不升级）」；普通任务与降级任务没有这行。
- **收件箱与日报**：`task_list({view:'inbox'})` 集中看待你决定/失败/卡住；配置 `digestAt` 后每日汇总。
- **任务面板**：侧栏「主会话」入口 + 会话头「任务」面板，显示状态、依赖、分组、问题和产物。

## 使用

安装后从侧栏「插件」下方「◈ 主会话」进入协调者，直接描述需求；协调者会用 `task_create` 拆任务，子任务回报后主动通知。子会话报 `done` 只是交付，任务停在「已交付待确认」，等确认或追问。

常用工具（P1-B 起共 10 个，旧名已删、有迁移映射）：协调者 `task_create`、`task_list`（`view:'inbox'` 是收件箱）、`task_status`、`task_message`（`action` = message/stop/retry/close）、`context`（`mode` = history/project/workspaces）、`memory_note`、`read_workspace`；子会话 `task_report`、`task_detail`、`plan_save`。

## 面板动作与错误码

面板的 stop/retry/message/delete 与工具 `task_message({action:'stop'})`/`task_message({action:'retry'})`/`task_message` 共用 `src/action-errors.js` 的同一套 code、门控语义和文案：面板失败返回 `{ ok:false, code, error }`，host-route 按 code 映射 HTTP 状态（400 参数 / 404 不存在 / 409 状态冲突 / 502 投递失败 / 500 内部）；工具层保持可读字符串返回。面板把错误显示成 `动作 失败（CODE）：原因`。

「能不能点」与「接不接」是同一份判定：`src/panel-gates.js` 的 `followupGate` / `deleteGate` 同时供面板动作、`task_message` 和 snapshot/detail 的 `canFollowup`/`canDelete` 使用，客户端只读下发字段。

- `stop`：已 cancelled/done/orphaned 再 stop 返回 `{ ok:true, already:true }`，面板提示「已是该状态」；并发双击只迁移一次。收子会话失败不阻断取消，结果带 `warnings[].code=STOP_DISPATCH_FAILED`。
- `retry`：只允许 failed/orphaned；同一失败任务已有活跃重派时直接返回那条任务（`already:true` + `retryOf`），不会重复创建；同 title+goal 的其他活跃任务返回 `RETRY_DUPLICATE_ACTIVE`。
- `message`：只允许 running/waiting_user/waiting_auth/delivered 且已有子会话（`delivered` 上是追问，复用原会话）；终态 `MESSAGE_TASK_ENDED`、等前置 `MESSAGE_WAITING_DEP`、待派发/排队/无会话 `MESSAGE_NO_SESSION`、失败任务 `MESSAGE_NOT_FOLLOWABLE`（改用重派）。面板每次点击生成 `clientRequestId`，host-route 按 `(taskId, clientRequestId)` 进程内去重；没有 id 的旧客户端退回「同任务 3 秒内相同文本」窗口去重。投递失败返回 `MESSAGE_DELIVERY_FAILED`，失败记录不会被当成已投递，窗口内可立刻重发。
- `delete`：只允许终态（done/failed/cancelled/orphaned），活跃任务返回 `DELETE_TASK_ACTIVE`（先停止）；还有活跃下游依赖返回 `DELETE_HAS_ACTIVE_DEPENDENTS`（删了会让下游缺前置）。成功时级联删除该任务的 messages/notifications，返回 `deleted:{messages,notifications}`；产物文件、报告正文与 memories 不动。

## 边界

- 依赖只能指向已存在的任务，暂不支持编辑已有任务的依赖。
- `writeScopes` 是冲突提示，不是文件锁。
- `done` 不可逆、不提供 reopen；要新工作用 `task_create` / `task_message({action:'retry'})`，要改交付物用「已交付待确认」上的追问。
- 协调者禁止 `wait_agent` 和任何阻塞等待；进度靠 `task_list` / `task_list({view:'inbox'})` 和主动通知。
- 台账快照每天生成，损坏时需手工用快照恢复。
