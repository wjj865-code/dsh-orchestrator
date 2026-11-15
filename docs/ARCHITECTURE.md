# 架构与关键机制

本文是 README 的技术补充，面向维护者。用户使用只需看 README。

## 角色

- **协调者**：唯一主会话，固定入口；只拆任务、派子会话、看回报，不读写文件、不执行命令。
- **子任务**：独立 DSH 子会话，直连 `ctx.subagents.startActivation`，不占 Team 名册；能力不受限，只多一个 `task_report` 工具。
- **客户端**：侧栏「主会话」入口 + 会话头「任务」面板；只读快照 + 面板动作。

## 主会话

解析顺序：

1. `config.coordinatorSession`（显式覆盖，不写台账）
2. 台账 `settings.main_session_id`
3. 未打开：`task_*` 返回「尚未打开主会话」

`open-main` 会确保「指挥舱」工作区存在，用协调者预设 `dsh-orchestrator-coordinator` 创建会话，`rename` 成「主会话」，写入 `settings.main_session_id`，然后跳到该会话。

复用判定以台账 `settings.main_session_preset` 为准；UI 空白会话可能被 rebind 成默认预设，插件会在 `agent/created` 和复用前调用 `agentPresets.select` 拉回，失败只记日志并由 guard 兜底。

## 队列与并发

平台有 `maxActiveSubagents` 上限（默认 8），满了抛 `ACTIVATION_LIMIT_REACHED` 且平台不排队。插件自己维护队列：

- `task_create` 只做校验、去重、落库、入队；派发异步。
- 容量满时任务保持 `pending`，按 2s/5s/10s/30s 退避重试。
- 唤醒：子会话结算、任务终态、`task_stop`、插件启动、协调者 `agent/created`。
- 高优先级先派；同优先级按创建时间 FIFO。
- 子会话创建的非容量错误才标 `failed` 并推通知，不留幽灵 `pending`。
- 子会话预设由 `config.workerPreset` 决定（默认 `dsh-orchestrator-worker`），`dispatch` 只在 `spawn` provider 上传 `agentPreset`；续派/冷恢复沿用会话创建时记下的预设。调试用的 `orch-debug` 副本由 `scripts/orch-debug-preset.mjs` 生成、走 bundle 安装（见 [DEBUG-PRESET](DEBUG-PRESET.md)）。

## 依赖 / 分组 / 写域 / 优先级

- `dependsOn` 最多 20 个，必须指向已存在且不是 `failed/cancelled/orphaned` 的任务；创建时不接受未来 id，因此不会成环。
- 前置未完成 → `waiting_dep`；`queue.pump` 前先做晋升：
  - 全部 `done` → `pending` 入队；
  - 任一失败/取消/丢失/不存在 → 下游 `failed`，错误写明原因；
  - 晋升是循环的，失败会沿依赖链传播。
- 派发时 brief 追加 `【前置任务】` 摘要和产物路径。
- `group` 只用于展示/过滤，`task_list({group})` 给出完成数。
- `writeScopes` 是 advisory 冲突提示，不是文件锁。
- `priority` 为 `-10..10`，只影响队列顺序。

## 回报、通知、收件箱、日报

`task_report` 四档：

| status | 通知级别 | 说明 |
|---|---|---|
| progress | silent | 只更新台账；连续达到 `stallRounds` 才推一次 `stalled` |
| done | notify | 5 秒合并窗口后注入协调者 |
| blocked | interrupt | 立即投递，可带 `question` / `options` |
| needs_auth | interrupt | 立即投递，可带 `question` / `options` |

## 结算闭环（S1）

子会话不一定都会回报：模型可能忘了 `task_report`，也可能被打断或起不来。`src/settlement.js` 消费平台的**结算**信号，把 `running` 直接推到终态，用户不再看到「永远在跑」的幽灵任务：

| 事件源 | 覆盖 |
|---|---|
| `dispatch.js` 的 `subagent.settled` / `subagent.failed` | 本次派发的那一次 activation |
| 平台 `subagent/end`（`local === true`） | 含 `task_message` / 冷恢复起的新 activation（派发侧的 `result` 只覆盖第一次） |

映射（`SETTLE_MAP` / `mapSettle`）：

| stopReason | 台账 | 死因 / 通知 |
|---|---|---|
| `completed` 且没上报过 progress | `done` | 无死因；自动 done 还会补一次产物收集 |
| `completed` 但上报过 progress | `orphaned` | 回合结束却没报终态（可重派） |
| `aborted` | `cancelled` | 被子会话中断（`dispose` / interrupt / 父级取消） |
| `error` / `max-tokens` / `refusal` | `failed` | 异常结束 / 输出截断 / 被策略拒绝 |
| 缺失或未知 | `orphaned` | 结算原因未知，按会话丢失处理 |

- 只动 `running`：`waiting_user` / `waiting_auth`（子任务自己报了 blocked/needs_auth）与已有终态都不改，重复结算天然幂等。
- 每次结算写一条 `settle` 消息 + `tasks.error` 死因 + 一条 `system` 通知（`cancelled`/`orphaned` 也走合并窗口），并释放可写根、唤醒队列补位。
- 取证与时序见 `docs/probes/stop-reason-probe.md`（真机 7 场景）。

- 通知走 `agent.steer` 直插协调者，不经过 Team 的 `sendMessage`。
- 每次投递写 `notifications`：`delivered` / `failed`（带 reason）/ `skipped`；合并后续行 `merged_into` 指向首条。
- `task_inbox` 汇总待决、失败/丢失、长时间没动静；问题/选项来自台账 `question` / `question_options_json`。
- `progress`/`done`/`task_message` 会清掉旧问题。
- `stallRounds`：连续 progress 达到阈值且距上次提醒超过 `staleMinutes`，推一次「可能卡住」。
- `digestAt`（HH:MM）开启后，主会话上维护一条每日 `schedule`；到点提示协调者调用 `task_inbox` + `task_list` 汇总。主会话重建/时区变化会重建，配置为空会删除。

## 启动对账（S2）

进程重启/崩溃后，子会话的结算事件可能没人消费，台账会留下「running 但实际没人在跑」的幽灵。`src/reconcile.js` 在插件 `apply()` 启动时和协调者 `agent/created` 晚加载时各对一次账：

- **活跃性对账只认 `running`**：`agents.get(session_id)` 不存在 → `orphaned`（死因「进程重启后子会话没有在运行的回合」）；
- `catalog` 里查不到 `session_id` → `orphaned`（可能已被删除）；查 `running` / `waiting_*`，`waiting_dep` 完全没有子会话、不参与也不误标；
- `waiting_user` / `waiting_auth` 不 live 但 catalog 有 → 保持原状态（故意停下，靠 `task_message` 冷恢复）；
- catalog 读失败只 warn，`running` 的 liveness 判定照做；标记前重读状态，已落终态的不覆盖，重复启动幂等；
- 标记完发**一条汇总通知**（任务名 + id，超过 10 条折叠「另有 N 个」）。启动时协调者还没加载导致投递 `skipped` 时保留待发，`agent/created` 后补发一次，不重复打扰。

## 产物

- `task_report.artifacts: [{path,label?}]`，相对路径按 `target_dir`（无则主会话目录）解析。
- 只 `stat` 存在性，非法条目静默丢弃，不阻断任务完成。
- 同一任务多次回报按 `path` 合并：不同路径保留，同路径后报覆盖，最多 50 条。
- **done 自动收集**：`task_report done` 时若报错方 Session 有 `workspace/changes` 事件，用 `workspaceChanges.summary(sessionId, seq)` 汇总所有回合的改动文件（相对路径按摘要 `cwd` 解析），按路径去重后与显式产物合并；显式产物标签优先，单任务仍受 50 条上限。
- 当前回合的摘要要等 turn stopping 才追加，`index.js` 监听 `session/event` 的 `workspace/changes`，在摘要服务登记后（微任务）把新增路径补进已 done 的任务；没有 `workspaceChanges` 服务或会话已释放时自动收集为空，不影响显式产物。
- 面板「产物」筛选调用 `artifacts` 端点并打开产物库：可按项目（目标目录末段）或日期分组，复制路径、文本预览（前 64 KiB）、打开子会话/详情；详情抽屉显示路径/标签/存在性。

## 只读子任务

`readOnly:true`（只认显式 true）会在 `agent/created` 一到就给子会话 append `sandbox/mode {mode:'read-only'}`，激活后再幂等补一次；续派/重启会再补。只读任务不注册 target 可写根。`backend:'team'` 没有会话级只读通道，会返回可读错误。

## 目标目录推断

不传 `target` 时，用 `title` + `goal` 匹配 `workspaceRegistry.list()` 的显示名与路径末段：

- 精确名优先；否则子串层。
- 纯 ASCII 键至少 3 个字母数字，CJK 至少 2 字。
- 通用末段（workspace/documents/document/desktop/default/src/app/tmp）不参与路径末段匹配。
- 子串包含消歧：被更具体名字严格包含的泛命中丢弃。
- 唯一命中写 `target_dir`；多命中不建任务，列候选；无命中沿用主会话目录。
- `workspaceRegistry` 不可用时按无工作区降级。

## 路由与面板

`POST /api/orchestrator`，connection owner-only：

| endpoint | 作用 |
|---|---|
| `snapshot` | 只读快照 |
| `open-main` | 创建/打开主会话 |
| `detail` | 任务详情、消息、依赖、产物 |
| `artifacts` | 产物汇总（项目/日期分组所需字段） |
| `preview` | 预览台账里登记的文本产物（前 64 KiB） |
| `stop` | 停止任务 |
| `retry` | 重派 failed/orphaned |
| `message` | 追加消息 |

面板 2s 轮询，连续失败退避 30s；任务行「详情/停止/重派/追加」；「产物」筛选打开产物库（按项目/日期分组，预览/复制/打开子会话）。

详情抽屉分四区块：**brief**（验收/约束/背景/用户原话）、**消息**（最近 20 条；`followup` 标待发/已投递/投递失败）、**依赖**（上游前置 + 下游依赖本任务，各带状态与错误）、**产物**（路径/标签/存在性，路径可一键复制）。四区块都有空态。投递状态落在 `messages.meta_json.delivery`（pending → delivered/failed，只改 meta 不加行）；A3 之前的旧消息按紧随其后的 `delivery_failed` 行推断。

## 落盘与日志

```
$DSH_HOME/state/orchestrator/
  tasks.sqlite
  snapshots/tasks-YYYY-MM-DD.sqlite
  logs/YYYY-MM-DD.jsonl
  workspace/                 # 指挥舱
```

- 日志按天、保留 7 天、单文件超 5MB 换新；`goal`/`summary` 只留 80 字，不写 `user_verbatim`。
- 快照启动时生成、每 6 小时跨日检查，保留 `snapshotRetentionDays` 天；损坏不自动恢复。
- 报问题附当天日志。

## 错误与降级

- 台账损坏/不可用/被占用给中文可读错误，不泄漏 `SQLITE_` 和堆栈。
- 协调者会话失效：`task_create` 标 `failed` 并给原因；只是未加载则任务排队等 `agent/created`。
- 子会话不可达：`orphaned`，可重建。
- 续派失败重试 3 次（1s/2s/4s），仍失败转 `waiting_user`。
- 通知失败/跳过写 `notifications`，不产生未处理 rejection。
