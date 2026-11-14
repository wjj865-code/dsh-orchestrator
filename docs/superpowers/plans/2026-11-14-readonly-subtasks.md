# 阶段 5 增量计划：只读子任务（显式 readOnly）

- 日期：2026-11-14
- 目标：`task_create` 增加可选 `readOnly:true`（默认 false，**只认显式 true**，不按关键词猜）。只读子任务的子会话沙箱设为 `read-only`：读、`task_report`、artifacts 照常；写文件/写 shell 被沙箱拒绝并给可读错误；台账/面板/通知/brief 标「只读」。非只读任务行为一字不改。

## 平台契约（已核 asar `@deepseek-ai/dsh-sandbox-policy/lib/index.js`）

- 唯一写入口：`setSandboxMode(session, mode)` → `session.append('sandbox/mode', { mode })`，只追加这一条事件，无旁路状态。
- 语义：按会话持久化（重启 replay 后仍在），两会话互不影响；对**下一次**受限调用生效（bash/fs 执行侧读同一投影）；`read-only` 下写文件/写 shell 被拒，读正常。
- 读取当前覆盖：`sandboxPolicy.overrideOf(session)`（投影，未设置返回 `undefined`）。
- 插件侧不 import 平台包（我们没有被允许的包依赖），直接 append 同形事件；**单测锁事件名与形状**。

## Task 0 计划（本提交）

只提交本文档。

## Task 1 台账 + task_create 契约（TDD，单独提交）

- `src/ledger.js`：`tasks` 加 `read_only INTEGER NOT NULL DEFAULT 0`；旧库 `ALTER TABLE`；`taskOf` 映射成布尔。
- `createTask({ readOnly })` 写入；`task_read_only` 读回。
- `src/tools.js` `task_create` 参数 `readOnly: {type:'boolean', description:'只读任务：子会话沙箱 read-only，禁止写文件/写 shell'}`；运行时 `args.readOnly === true` 才算只读（字符串/真值不认）。
- `task_list` 行与 `task_status` 输出带「只读」标记；非只读不加任何字样。
- 用例：默认 false、显式 true 落库、旧库迁移、字符串 `'true'` 不生效、list/status 标记。

## Task 2 brief（TDD，单独提交）

- `renderBrief`：只读任务在 `【目标】` 后加 `【权限】只读`，并附一句「不要写文件、不要执行写操作的 shell；产物路径写进回报正文」。
- 非只读 brief 逐字不变（现有 golden 断言保护）。
- 用例：只读包含权限行与禁写提示；非只读不含。

## Task 3 派发时设置沙箱（TDD，单独提交）

- `src/dispatch.js`：`spawn({ readOnly })` 时——
  - `agent/created`（只认我们派出的 childId）触发一次 `ensureReadOnlyMode(childId)`，压掉首回合窗口；
  - `startActivation` 返回后补一次幂等设置；
  - `ensureReadOnlyMode`：取 `agents.get(childId).session`（对象身份，`sessions.get` 兜底），`sandboxPolicy.overrideOf(session) === 'read-only'` 则跳过，否则 `session.append('sandbox/mode',{mode:'read-only'})`；服务缺失/失败只 warn，不影响派发。
- `send`/`sendReliable` 续派：目标任务 `readOnly` 时，投递前/后各补一次幂等设置（resume 会换 Session 对象）；非只读任务一次都不调。
- 派发入参从 `queue`（`task.read_only`）透传；`task_create` 创建后入队。
- 用例：只读派发 append 的形状/目标 childId；非只读不 append；已设置跳过；resume 换对象补设；缺服务不炸；续派保持只读。

## Task 4 面板/通知标「只读」（TDD，单独提交）

- `src/notify.js`：通知标题显示名后加「（只读）」；`src/tools.js` 的 `notifier.push` 带 `readOnly`。
- `src/host-route.js` snapshot `tasks[].readOnly`；`client.js` 任务行在状态旁显示「只读」徽标（非只读不显示）。
- 用例：通知文案、snapshot 字段、面板渲染（L1 探针 + client 单测）。

## Task 5 文档与全量（单独提交）

- README：`task_create` 参数、只读语义、首回合时序窗口如实写明；qa-checklist 新增只读复核矩阵。
- 全量：`npm test`、全部探针、`node --check client.js`。

## 风险与边界

- 首回合窗口：`agent/created` 后设置仍可能晚于模型第一次写调用（平台已 submit 首条消息）；如实写进 README，不夸大。
- 只读模式是会话级覆盖，只作用于我们派出的 childId；不改用户 `permissionPreset`、不改全局沙箱默认。
- `readOnly` 与 `target` 推断、artifacts 可叠加：只读任务仍可推断工作区、仍可报产物（只标存在性）。
