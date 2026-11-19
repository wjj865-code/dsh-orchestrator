# 架构与关键机制

本文是 README 的技术补充，面向维护者。用户使用只需看 README。

## 角色

- **协调者**：唯一主会话，固定入口；只拆任务、派子会话、看回报，不读写文件、不执行命令。
- **子任务**：独立 DSH 子会话，直连 `ctx.subagents.startActivation`，不占 Team 名册；能力不受限，另有三个插件工具：`task_report`（回报）、`task_detail`（只读创建详情）与 `plan_save`（计划落盘）。
- **客户端**：侧栏「主会话」入口（始终可见）+ 会话头「任务」面板（仅主会话可见）；只读快照 + 面板动作。

## 主会话

解析顺序：`config.coordinatorSession`（显式覆盖，不写台账）→ 台账 `settings.main_session_id` → 未打开（`task_*` 返回「尚未打开主会话」）。`open-main` 确保「指挥舱」工作区存在，用协调者预设创建会话、`rename` 成「主会话」、写指针，再跳到该会话。复用判定以台账 `settings.main_session_preset` 为准；UI 空白会话可能被 rebind 成默认预设，插件在 `agent/created` 与复用前调 `agentPresets.select` 拉回，失败只记日志并由 guard 兜底。

### 首次打开与工作区索引

- 只有**新建**主会话写 `settings.main_onboarding:<id>=pending`（旧主会话/配置覆盖不补初始化）；CAS `pending→sending→sent` 防并发重复，注入失败退 `pending`。
- 投递前必须 await `guardPreset` 恢复成功，不用固定延时猜就绪；`sent` 只表示消息已入队，不保证模型已介绍/派发（进程在发送与标记之间崩溃有不确定窗口，不盲重投）。
- 索引任务只扫 `workspaceRegistry.list()` 登记的目录：读 `repoRoot/branch/HEAD/origin/commonDir`，单项失败继续，不 fetch/pull、不写文件，remote 去凭证。`task_report.workspace_index` 仅接受本任务 `done` 的完整 JSON，按创建时名单校验覆盖，与 `settings.workspace_repo_index` 同事务写入，不覆盖 `memories`。

### 原生自动化工具面

- `cordis.patch.yml` 只在 coordinator plugins 挂 `@deepseek-ai/dsh-tool-schedule`，allow 显式保留 `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`；`preset-tools.js` 仍用增量 deny 补集。这四工具不进入 `createTools`，插件全局工具数仍为 10。
- **工具面（P1-B：15 → 10）**：`createTools` 返回 10 个（协调者 7 + 子会话 3）。旧入口并进三个工具：`task_message` 的 `action`、`task_list` 的 `view`、新工具 `context` 的 `mode`。旧名**不注册**、不在 allow 名单，`index.js` 的 `tools.guard` 用 `src/tool-migrations.js` 的映射表返回可读迁移提示（唯一真源，README/CHANGELOG 对齐）。
- 缺能力诊断只针对唯一主会话：检查 `tools.get(name, agent)` 的可见定义与 `ctx.schedule`，缺失去重 warn + policy 提示；不改运行回合工具表，也不模拟自动化。
- 只支持 `target:this_session`：Host 到期投递消息到唯一主会话，再由模型走 `task_create`。`new`/`new_once` 创建普通 root 会话，不是委托 worker、也不是第二协调者；**非唯一主** id 被 `requireMain` 拒绝。**默认 worker 不新增**挂载；`access:full` 不增加工具、不解除 `subagent_session`。沿用 Host-wide 管理、用户**明确授权**、RRULE 与 `expectedUpdatedAt` 冲突保护；用法见 [README 原生自动化](../README.md#主会话原生自动化)，边界见 [LIMITATIONS](LIMITATIONS.md#原生自动化)。

### 入口可见性（U1）

- **会话头「任务」入口只在主会话显示**：`client/src/gate.js` 取当前会话 id → POST `session-role` → `src/session-role.js` 的 `isMainSession`（与 `task_*`、通知投递同源：台账 `main_session_id`）。
- 降级 fail-closed：没有会话 id、路由不可用、HTTP/JSON 失败、`ok:false` 一律隐藏；失败不缓存，换会话立即重判，另有 5 秒兜底轮询；同会话的明确答案缓存。
- 侧栏「◈ 主会话」始终可见、不参与判定（它是首次创建主会话的引导入口）；面板主体仍注册为 `main` 槽位，入口隐藏不等于面板消失。

## 主会话轮换（G1）

主会话是唯一协调者，跑久了上下文与日志只会更大。轮换 = 把旧主会话退役、换一个干净会话继续；台账、任务、记忆、产物都不搬。**判定与动作严格分离**，判定只有一个调用点：`main-session.openOnce()`（启动、`agent/created`、面板轮询都不判定）。

- **模块**：`src/main-rotation.js`（纯判定 `evaluateRotation` / 采集 `collectRotationMetrics` / 动作面 `createRotationService` / 崩溃恢复）、`src/config.js`（轮换相关的 7 个键：`mainRotation` + 6 个 `rotate*`，默认值与回落都在 `normalizeRotationConfig`）、`src/main-session.js`（唯一判定点）、`index.js`（装配 + `apply()` 时 `recoverPending`）。
- **判定**：只在旧主会话 **live** 时做（重启后第一次打开是隐式重建，不是轮换）。触发因子两个：`main-log`（日志 MiB）→ `age`（运行天数）。12 个保护 code 按 `ROTATION_BLOCKS` 排优先级：`mode-off`、`coordinator-override`、`spawn-provider`、`active-tasks`、`delivered-pending`、`delivered-artifacts`、`agent-running`、`recent-activity`、`active-children`、`min-age`、`cooldown`、`metrics-degraded`（两个因子全缺才 fail-closed，缺一个只记 `degraded`）。`due = mode==='auto' && triggers.length>0 && blockedBy.length===0`；`mainRotation` **默认 `off`**，拼错也回落 `off`。
- **动作时序**（顺序即回退边界）：建新会话（失败 = 零处置）→ 写 marker `main_rotation_pending`（先 marker 后切指针，崩溃恢复的唯一锚点）→ 切指针（失败 = 轮换没发生，指针切换后不回滚）→ 写时间戳 → `onboarding=sent`（跳过首次介绍）→ 改名 → 退役旧会话（先改名再归档，各自降级）→ 写审计 `main_rotation_last` → 记 `freshMain`（60 秒窗口内再打开交回同一 id）。
- **崩溃恢复**：`abandoned`（marker.newId ≠ 指针）= 死在切指针前，尽力归档空白残留；`complete` = 指针已切，补时间戳 / onboarding / 旧会话处置，幂等；`invalid` 只清 marker + 告警，**绝不猜 id 去归档**。
- **settings 键只存事实**：`main_session_created_at` / `main_rotation_at` / `main_rotation_last`（审计，只留最近一条）/ `main_rotation_pending`；`main_rotation_checked_at` 已废弃（只读）。
- **日志**：`main.rotation.decided`（每次判定都写）、`main.session.rotated`、以及 `failed` / `marker.*` / `metrics.degraded` / `recovered-*` 等降级项。逐条边界见 [LIMITATIONS](LIMITATIONS.md#主会话轮换g1)。

## 队列与并发

平台有 `maxActiveSubagents` 上限（默认 8），满了抛 `ACTIVATION_LIMIT_REACHED` 且平台不排队，插件自己维护队列：`task_create` 只校验、去重、落库、入队，派发异步；容量满保持 `pending`，按 2s/5s/10s/30s 退避重试；唤醒 = 子会话结算、任务终态、`stop`、插件启动、协调者 `agent/created`；高优先级先派，同级 FIFO；只有子会话创建的非容量错误才标 `failed` 并推通知（不留幽灵 `pending`）。子会话预设由 `config.workerPreset` 决定，`dispatch` 只在 `spawn` provider 上传 `agentPreset`；续派/冷恢复沿用会话创建时记下的预设。调试用的 `orch-debug` 副本不在本包内（P1-E 已外移）。

## 依赖 / 分组 / 写域 / 优先级

- `dependsOn` 最多 20 个，必须指向已存在且不是 `failed/cancelled/orphaned` 的任务；创建时不接受未来 id，因此不会成环。
- 前置未完成 → `waiting_dep`；`queue.pump` 前先晋升：全部 `done` → `pending` 入队；任一失败/取消/丢失/不存在 → 下游 `failed`（写明原因）；晋升是循环的，失败沿依赖链传播。
- 前置任务摘要与产物不在派发时预渲染：子会话用 `task_detail` 按**当前**台账现读。
- `group` 只用于展示/过滤；`priority` 只影响队列顺序。
- **同写域并发防护**（`src/write-guard.js`，默认拒绝）：`task_create` 在「去重 / 容量 / worktree 决定」之后、`createTask` 之前的**同一个同步段**里判定——新任务 target 与活跃未隔离任务的 target 相同或互相包含，或两者 `writeScopes` 重叠 → 按 `config.sameDirGuard` 处理（`require` 拒绝 / `warn` 只警告 / `off` 关闭）。不参与判定：`readOnly`、`requested/created/reused` 隔离任务、`dependsOn` 祖先、终态任务。例外是 `degraded`（不是 git 仓库而降级）：仍在原工作树里写，必须继续占目录。`delivered` 算活跃；唯一显式放行是 `allowConcurrent:true`（记 `task.create.concurrent-write`）。拒绝对应 `task.create.rejected`（`reason: same-dir | write-scope`）。

## 回报、通知、收件箱、日报

`task_report` 四档：

| status | 通知级别 | 说明 |
|---|---|---|
| progress | silent | 只更新台账；连续 3 次（固定口径）才推一次 `stalled` |
| done | notify | 落「已交付待确认」（`delivered`）；5 秒合并窗口后注入协调者 |
| blocked | interrupt | 立即投递，可带 `question` / `options` |
| needs_auth | interrupt | 立即投递，可带 `question` / `options` |

- 通知走 `agent.steer` 直插协调者，不经过 Team 的 `sendMessage`；每次投递写 `notifications` 行（`delivered`/`failed`/`skipped`，合并后续行 `merged_into` 指向首条）。
- `task_list({view:'inbox'})` 汇总待决、失败/丢失、长时间没动静；问题/选项来自台账 `question` / `question_options_json`，`progress`/`done`/`task_message` 会清掉旧问题。
- **卡住提醒**：连续 3 次 progress 且距上次提醒超过 `staleMinutes` 推一次「可能卡住」。
- 日报：`digestAt`（HH:MM）开启后在主会话上维护一条每日 `schedule`，到点提示协调者汇总；主会话重建/时区变化会重建，配置为空会删除。

## 两段式终态（D1：交付 → 确认）

`done` 是不可逆终态，但「子会话说做完了」不等于「用户验收过」。状态机在 `running` 与 `done` 之间加了 `delivered`（已交付待确认）：

- **进入**：`task_report done`，或结算 `completed` 且没上报过 progress（`SETTLE_MAP`）。
- **出口 1 · 确认**：`task_message({action:'close'})`（或面板「确认交付」）→ `done`，`close_reason=coordinator`；超过 `deliveredTimeoutMinutes`（默认 60）由 sweeper 自动收成 `done`，`close_reason=timeout`。
- **出口 2 · 追问**：`task_message` 投递成功 → `running`，复用同一个子会话（**可写根不释放**），完成后再次交付。
- **出口 3 · 停止/丢失**：`stop` → `cancelled`；追问时子会话不可达 → `orphaned`。
- 归属：`delivered` 是活跃状态（`listTasks(active)`、面板门控、`inboxCount` 都算），但不是终态；状态集合与转移表只有一份（`src/status-facts.js`，见下「状态事实源」）。
- 依赖就绪仍只认 `done`；goal 不收口（`delivered` 期间保持 active + disarmed，只有 `done` 才 `complete`）；对账不查 `delivered` 的 liveness（成果已落库，超时 sweeper 兜底）。
- 审计：`tasks.delivered_at` 记录本次交付时间（追问后再交付会重写），`close_reason` 记关闭原因，`messages` 里 `kind='close'` 写「协调者确认 / 超时自动完成」。
- 三条关闭路径（工具 / 面板 / 超时）共用 `src/delivered.js` 的 `closeDelivered`，副作用顺序固定：迁移 + 审计消息 → 释放可写根 → goal 收口 → 按档位清检出 → 唤醒队列。
- 通知去重：进入 `delivered` 发一条（带 `close`/追问指令），确认/超时**不再发**通知，只写审计消息。

## 交接契约 v1（D2：`acceptedBy` / `acceptedAt` + JSONL）

「交付 → 确认 / 追问 → 完成」是插件独有的一段语义（官方宿主没有），v1 把它从内部状态机提升为**可被外部消费的只读契约**：稳定字段 + 版本号 + JSONL 审计事件。**v1 只做数据契约与事件，不做进程内订阅 API**（回调/事件总线留 v2）。

三条确认路径各自带 `by`，落库与事件只在 `closeDelivered` 一处写：

| 入口 | `acceptedBy` | `close_reason` |
|---|---|---|
| `task_message({action:'close'})`（`src/tools.js`） | `coordinator` | `coordinator` |
| 面板「确认交付」（`src/panel-actions.js`） | `panel` | `coordinator` |
| 超时 sweeper（`src/delivered.js`） | `timeout` | `timeout` |

### 契约字段

`handoff` 出现在 `task_status`、面板 detail 端点、JSONL 事件三处，字段与顺序以此表为唯一真源（`src/handoff.js` 的 `HANDOFF_FIELDS`；`scripts/check-docs.mjs` 断言两边逐字一致，防止代码与文档漂移）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `contract` | number | 契约版本，v1 = `1`；只增不改语义 |
| `taskId` | string | 任务编号 |
| `sessionId` | string \| null | 子会话 id（未派发为 null） |
| `title` | string | 任务标题（外部工具直接可读，不必回查台账） |
| `deliveredAt` | number \| null | 交付时间（毫秒时间戳；追问后再交付会重写，超时从新时间起算） |
| `acceptedAt` | number \| null | 确认时间（毫秒）；未确认是 null |
| `acceptedBy` | `coordinator` \| `panel` \| `timeout` \| null | 谁确认的；未确认是 null |
| `rounds` | object | `{ turns, followups }`：派发/续派次数与追问次数 |
| `evidence` | object | `{ acceptance, artifacts }`：A1 的验收记录原样（没跑过 null）与已登记产物 |
| `status` | string | 当前状态（`delivered` / `done` / …） |
| `closeReason` | `coordinator` \| `timeout` \| null | 关闭原因（台账原文） |

**没有交接 = `null`**：从没交付过的任务（pending / running / failed / 存量 done）没有 `handoff`（不是空壳对象）；「交付了但没确认」是 `acceptedAt: null` + `acceptedBy: null`，两者必须能区分。

三个视图粒度不同、字段同源：面板 snapshot 只下发精简版 `{contract, deliveredAt, acceptedAt, acceptedBy, acceptedByLabel, acceptanceOk}`（不给证据，避免快照变大）；`task_status` 渲染「交接 / 交接轮次」两行；面板 detail 与 JSONL 事件给完整契约对象。

### JSONL 事件

落 `$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`（**不进仓库、不写台账 messages**）：按天分文件、单文件超 5 MiB 换新、保留 30 天，与运行日志共用 `src/log.js` 的同一套轮转实现。

| 事件 | 何时写 | 幂等 |
|---|---|---|
| `task.handoff.delivered` | 任务进入 `delivered`（`transition` 观察者；`task_report done` 与结算 `completed` 两条路都覆盖） | 每次交付一条（追问后再交付是新的一次交付） |
| `task.handoff.confirmed` | `closeDelivered` 落库成功后（三条确认路径共用） | 只发一次：重复确认走 `already` 分支提前返回 |

一行一个 JSON 对象：`{"at":"ISO","event":"…","taskId":"t-…","sessionId":"c-…","detail":{"contract":1,"handoff":{…完整契约对象…}}}`。消费方式：按行 `JSON.parse`、按 `event` 过滤；文件只追加不改写，重复投递由读方按 `(event, taskId, deliveredAt)` 去重（`jq` 示例见仓库内 `docs/api-notes.md`，该文件不随包发布）。

### 兼容性与边界

- **字段只增不改**：v1 冻结字段名与语义；改名/改语义必须升 `contract`，读方见到不认识的版本应忽略而不是猜。
- **幂等**：`already` 分支不写 accepted_*、不发事件；并发确认（工具与面板撞车）只会有一次真实写入。
- **超时也是确认**：超时走同一条 `closeDelivered`，`acceptedBy: 'timeout'`、`close_reason: 'timeout'`，事件照发——「没人确认」与「超时自动完成」必须能区分。
- **存量行**：`accepted_by` / `accepted_at` 旧库启动时 ALTER 补列，存量行 NULL；v1 之前已 `done` 的存量任务直接没有 `handoff`，面板与 `task_status` 按「没有交接记录」显示，不猜。
- **失败是旁路**：事件写入失败只 warn 一次，不影响迁移/确认（JSONL 是审计旁路，不是交付的前置条件）。
- **不做订阅 API**：v1 的消费方式是「读文件」；进程内可订阅 API 留 v2。

## 机器可判定验收（A1：`task_create.checks`）

`acceptance` 是给人读的标准，`checks` 是给机器执行的证据：**子会话报 `done` 时由插件先跑检查，全过才落 `delivered`，任一条失败即拒绝交付**。这让「任务做完了」不再只靠子会话自述。

| 项 | 规格 |
|---|---|
| 结构 | `[{ name?, command: string[], timeoutMs?, skipIfMissing? }]`，1–5 条；`command` 是 **argv 数组**（第 1 项是命令），不接受 shell 字符串 |
| 上限 | 单项参数 ≤2000 字符、整条 ≤4000 字符、argv ≤16 项；`timeoutMs` 1000–600000（默认 120000） |
| 通过 | 退出码 0（且未超时、无 spawn 错误）；`skipIfMissing:true` 时命令不存在（ENOENT）记「跳过」，不算失败 |
| 超时 | 先 SIGTERM，5 秒后 SIGKILL；结果 `timedOut:true`、`exitCode:null` |
| 输出 | stdout / stderr 各只留最后 4 KiB，超出标 `truncated`；失败回执给最后 10 行 |
| 台账 | `tasks.acceptance_json`：`{ spec, ranAt, cwd, ok, total, passed, skipped, failed, results[] }`；旧库启动时 ALTER 补列，存量行 NULL = 没跑过 |
| 消息 | 每次跑都写 `messages.kind='acceptance'`（通过写「验收通过」，失败写完整失败清单） |
| 面板 | detail 端点下发完整证据，抽屉「验收」区块逐条显示；`task_status` 有验收段；snapshot 只下发摘要（计数/ranAt） |

**安全边界**（不做假安全，如实声明）：命令只来自协调者的 `task_create`（写进 brief 快照），`task_report` 没有任何命令参数，子会话无法注入或覆盖；执行用 `spawn(argv[0], argv.slice(1), { shell:false })`，不经 cmd.exe / sh 拼串；cwd 固定为 `worktree_path ?? target_dir`，**不继承主会话目录**（没有 target 的任务创建阶段就拒绝配 `checks`）；**`readOnly:true` 的任务拒绝配 `checks`**（宿主进程执行保证不了只读）；环境变量继承插件进程；检查跑在**插件宿主进程**里，不是子会话沙箱——隔离任务只是 cwd 在检出目录，权限仍来自宿主。

**失败语义**：状态不迁移（保持 `running`）、不登记产物、不发交付通知；只落验收证据与 `kind='acceptance'` 消息，返回可读失败清单。子会话修完重报 `done`（会重跑），或报 `blocked`。确认交付与超时 sweeper **都不重跑**检查——确认是人的动作，不是再验一次。brief 里的 `checks` 无法解析时同样**拒绝交付**（fail-closed）。

**为什么没有「只标记不阻断」**：验收的价值在于退出码，允许 `delivered + ok:false` 等于又回到自述。需要宽松时用 `skipIfMissing`（环境差异）或把检查写宽，而不是绕过闸门。

## 官方 Team 板互通（D6：只读 + 确认反写）

**方向已定：D6 优先，不做 workspace 第二后端。** 官方 Team 板挂在 **subagent 树**上（`subagents.rootOf(caller)` 才能定位），一旦派发改走 root 工作区会话，插件任务就脱离 Team 树、D6 直接失效；因此本片**不新增任何 root 会话派发路径**，也**不新增配置键**。D6 只做两件事：把官方板**只读**接进插件视图；插件任务被确认交付时**可选地**把关联的官方任务标 `complete`。

| 项 | 规格 |
|---|---|
| 宿主契约 | `agentTeams.isEnabled(caller)` / `listTasks(caller)` / `updateTask(caller, { taskId, expectedRevision, action })`（rc.5 `@deepseek-ai/dsh-agent-team`）；全部经 `host-capabilities` 的 `agentTeams()` 惰性取，`report()` 第 10 类 `team-board` 只探测 `isEnabled` + `listTasks` |
| 只读快照 | `snapshot.teamBoard = { enabled, rows, degraded }`；`rows[] = { id, revision, subject, status, statusLabel, owner, blockedBy, writeScopes, ready }`（**不含 description**：官方允许 16 KiB 正文，每帧下发会把快照撑大）。`enabled:false` 时**不调用** `listTasks` |
| 关联 | `task_create.teamTaskId`（可选）：只读校验存在并记 `tasks.team_task_id` / `team_task_revision`（CAS 基线）。不 claim、不改官方任务；重派复制这两列 |
| 反写 | **人/协调者确认**（`closeDelivered` 成功且 `acceptedBy ≠ timeout`）→ `updateTask({ action:'complete', expectedRevision })`；只对**显式关联**的任务、只由协调者（Team Lead）发起。超时自动完成**不反写**，只记 `team.board.skipped`（`reason: timeout`） |
| CAS | `expectedRevision` = 创建时读到的 revision；`TEAM_TASK_STALE_REVISION` 只**重读一次**再试**一次**，仍冲突就停手记 `team.board.stale`，不重试轰炸 |
| 降级 | 服务缺失/形状变了/`isEnabled` 抛错 → `degraded.code=TEAM_BOARD_UNAVAILABLE`；Team 未开启 → `enabled:false, degraded:null`；反写失败/冲突**只 warn + 日志**，本地 `done` 已落库、不回滚 |
| 事件 | `team.board.confirmed`（成功）、`team.board.stale`（冲突放弃）、`team.board.confirm-failed`（官方拒绝/异常）、`team.board.skipped`（未关联/服务缺失/未开启） |
| 边界 | 不接管官方派发/认领/生命周期；不把官方任务同步进台账；不做 workspace 后端。面板里官方板是**只读分区**（行内没有按钮） |

**为什么 CAS 是硬要求**：官方板可能同时被 Lead 与 teammate 操作；不带 `expectedRevision` 的 `complete` 会覆盖别人刚做的 `claim` / `edit`。反过来「冲突就自动改到最新再写」也危险——那等于替别人拍板，所以只重读一次、只再试一次。

**为什么失败只 warn**：交付是本地状态机的事实，官方板只是并行看板；为了一个看板写失败把已确认的任务回滚成 `delivered`，会让「用户已经确认过」这件事消失。

**为什么超时自动完成不反写**：超时是「没人确认」的兜底，不是人的判断。让它去改官方板，等于系统替别人把共享看板上的任务标完成；所以只记一条 `team.board.skipped`，`updateTask` 一次都不调。

## 状态事实源（`src/status-facts.js`）

0.19.x 的状态集合被复制到 9 个模块并产生过三处真实不一致，现在只有一个判定点：

| 能力字段 | 回答什么问题 | 谁用 |
|---|---|---|
| `active` | 还算「没落终态」吗？ | `listTasks(active)`、面板筛选、`ledger` 的 SQL |
| `followup` / `resumable` | 能续派吗 / 续派后要迁回 running 吗？ | `task_message`、面板 |
| `deletable` / `retryable` | 能删吗 / 能重派吗？ | 面板删除、`retry` |
| `terminal` / `releases` | 是流程终态吗 / 要释放可写根与 goal 吗？ | `close` 判定、结算收尾、面板与工具的 stop 幂等判定 |
| `waiting` | 是等人（用户/授权）的停顿态吗？ | 续派即批准计划 |
| `rotationActive` | 会阻断主会话轮换吗？ | `main-rotation`（**刻意不含 `delivered`**） |
| `liveness` / `catalog` / `watchdog` | 要对账活着吗 / 要查目录吗 / 要巡检空闲吗？ | `reconcile`、`watchdog` |
| `planSettled` | 计划任务进这个状态要收口 `plan_state` 吗？ | `ledger.transition` |

- **三条不可达边已删**（`running→done`、`failed→running`、`orphaned→pending`）：它们自加入起就没有调用点，而测试曾把它们写成 `allowed`——**测试在保护死代码**。矩阵现在从 `TRANSITIONS` 派生，另有正向用例断言这三条边必须被拒。
- **`failed` 的语义分开了**：`terminal:false`（还能重派）但 `releases:true`（要释放资源）；stop 幂等判定改用 `releases`，不再把失败任务改成「已取消」。
- **迁移有审计日志**：`transition` 是全部状态变化的唯一入口，`index.js` 挂一次 `task.transition` 日志（`{taskId, from, to, reason, closeReason}`）。

## worktree 状态事实源（`src/worktree-facts.js`）

`worktree_state` 的 8 个状态曾有 7 份独立列表（占不占目录、要不要建树、有没有检出、显不显示小标、要不要重派、要不要通知、清理前置）。现在是一张 `WORKTREE_STATE_CAPS` 表 + 派生列表：

| 能力 | 含哪些状态 | 语义 |
|---|---|---|
| `occupiesTarget` | none / degraded / rejected / failed / cleaned | 仍在原工作树里写，参与同写域判定 |
| `needsCreate` | requested | 派发前要真建检出 |
| `hasCheckout` | created / reused / cleaned | 台账里有检出路径（cleaned 的目录已删） |
| `showsBadge` | created / reused / cleaned | 面板小标 |
| `retryable` | created / reused / failed / cleaned | 重派时沿用/重建检出 |
| `notifyIsolated` | created / reused / cleaned | 通知里说「产物在检出目录」 |

`setTaskWorktree` 校验 `WORKTREE_TRANSITIONS`（非法转移抛错）；同状态重复写入幂等。叶子模块（不 import 任何东西）是刻意为之：`worktree.js` 与 `worktree-request.js` 互相引用，能力表放在其中一边会在模块求值期撞 TDZ。

## 提示词分层（`src/prompt-layers.js`）

五层文本各有独占职责，**一条口径只许有一个所有者层**：

| 层 | 载体 | 生命周期 | 唯一职责 |
|---|---|---|---|
| **L1** | `ctx.systemPrompt.context().text`（`index.js`） | 每回合重渲染 | 协调者行为规则：**能直接答就不委派**、工具可用/禁用、交付与确认口径（**不主动问「能否关闭」**，只在真歧义/不可逆/远端写授权时提问）、`present`/`read_workspace` 用法、worktree 与写域策略、**用户偏好（第 4 段）**、能力诊断 |
| **L2** | 派发消息（`src/brief.js`） | 每次派发/续派 | 只指路：任务编号、访问级别、worktree 装依赖提示、`task_detail` 指引、执行中/交付时怎么回报 |
| **L3** | 子会话按需调用（`src/task-detail.js`） | 按需 | 任务创建详情 + 完成动作 |
| **L4** | 一次性 `agent.steer`（`src/onboarding.js`） | 仅新主会话首次 | 只开场：一句话自我介绍 + 派索引任务（能力边界一条都不重复） |
| 旁路 | 通知（`src/notify.js`） | 每次通知 | 只讲「现在要你做什么」的动作指令 |

- L4 从 708 字瘦到 525 字（删掉与 L1 重复的 6 条能力边界）：L1 每回合都在且不会被 compaction 吃掉，onboarding 是一次性消息、轮换时还会被直接标 `sent` 跳过；两处都写 = 每次改 policy 都要同步改它（已漂移过）。
- **三处矛盾已修**：① 文档不再声称交付时可以带结构化选项（`done` 会清空 `question`/`options`）；② brief 的 `CONFIRM_HINT` 与 task_detail 的 `FINISH_HINT` 统一成「结论 + 改了什么/改了哪些文件/怎么验证的 + 待确认要点」，同源 `SUMMARY_FIELDS`；③ 文档里的 brief 行数改为「4 行基准，full/隔离各加一行 → 4–6 行」（`docs/testing.md` 有锁定断言）。
- **偏好归 L1 末尾**（`src/preferences.js`）：存 `settings.orchestrator_preferences` 单键 JSON，每回合现渲染；字数 1200 为主约束、条数 12 为安全阀；超限**显式告知**被截条数；全局偏好只写 settings（不双写 memories），项目偏好只写 memories。偏好只是提示词文本，不进 config、不改 dispatch、不碰沙箱。

## 文案单源（`src/copy.js`）

分层解决「谁该说什么」，本模块解决「这句话写在哪」。跨模块共享的句子只在 `src/copy.js` 定义一次：

| 文案域 | 真源常量 | 复用到 |
|---|---|---|
| 计划阶段 | `PLAN_PHASE_LINES` / `PLAN_FIRST_DETAIL` / `EXIT_PLAN_MODE_DENIAL` / `PLAN_STATUS_LINES` / `planDocPathText()` / `planCreateReceipt()` / `PLAN_SAVE_TOOL_DESC` / `planSavedNextStep` | `task-detail`（L3）、`plan-mode`、`plan-doc`、`tools`、`dispatch`、`index.js` |
| 两段式终态 | `DELIVERY_LINES` / `DELIVERY_NOT_FINAL` / `DELIVERED_HINT` / `finishHint()` / `deliveredReceiptNote` | `task-detail`、`brief`、`notify`、`prompt-layers`、`write-guard`、`tools`、`deps` / `main-rotation` / `tool-migrations` |
| 完整访问 | `ACCESS_FULL.label` / `.briefLine` / `.workerHint` / `.createNote` | `brief`、`task-detail`、`tools` |

1. **判据**：这句话会不会在第二个模块出现？会 → 放 `copy.js`；不会 → 留在本层（协调者规则归 L1、面板短标签归客户端）。
2. `copy.js` 是**叶子**：不 import 任何模块，谁都能引用而不引入环。
3. 客户端是浏览器 bundle、**不能** import 服务端模块：面板的 `STATUS_LABEL` / `PLAN_STATE_LABEL` 仍各存一份字面量，由 `test/copy-consistency.test.js` 的**同值断言**兜住漂移。
4. 静态断言守着「别再抄一份」：`唯一允许的写入口`、`3–8 行摘要`、`不要自行宣告任务结束` 等标记只许出现在 `src/copy.js`。

## 属性测试（`test/status-property.test.js`）

状态机与文案拼装用**固定种子的随机路径**验证，而不是再抄一遍 10×10 矩阵（那由 `test/state.test.js` 锁静态表）：随机迁移 12,000 步（seed `0x9e3779b9`，可复现、< 2s）断言每条边与 `TRANSITIONS` 逐位一致、非法边必抛错；能力位不变量（`terminal ⇒ !followup`、`releases ⇒ !active`、终态闭包等）；文案随机组合 10,000 组断言同输入渲染两次逐字相同。失败信息带种子与步号，抄进新用例即可复现。

## 结算闭环（S1）

子会话不一定都会回报：模型可能忘了 `task_report`，也可能被打断或起不来。`src/settlement.js` 消费平台的**结算**信号，把 `running` 推到终态（自然结束先落 `delivered`）：

| 事件源 | 覆盖 |
|---|---|
| `dispatch.js` 的 `subagent.settled` / `subagent.failed` | 本次派发的那一次 activation |
| 平台 `subagent/end`（`local === true`） | 含 `task_message` / 冷恢复起的新 activation |

（映射 `SETTLE_MAP`：`completed` 且没上报过 progress → `delivered`；`completed` 但上报过 progress → `orphaned`；`aborted` → `cancelled`；`error`/`max-tokens`/`refusal` → `failed`；缺失/未知 → `orphaned`。）

- 只改 `running` 的状态：`waiting_user` / `waiting_auth` 与已有终态都不改，重复结算天然幂等。
- **例外：`delivered` / `done` 上要补写最后一条消息**（`task_report done` 先把任务推到 `delivered`，本回合结束时到达的结算已不在 `running`）：落消息、不改状态、不发通知、不写 settle 行、不释放。
- 只有真终态（`done`/`cancelled`/`failed`/`orphaned`）才释放可写根、收敛 goal、写 `settle` 消息；`delivered` 保留会话给追问用。
- 每次结算写一条 `settle` 消息 + `tasks.error` 死因 + 一条 `system` 通知，并唤醒队列补位。取证与时序见 `docs/probes/stop-reason-probe.md`。

### 最新返回消息（B1）

两路事件都自带子会话最后一条 assistant 消息，结算时顺手落账：正文 ≤ 64 KiB 内联 `tasks.last_message_json.text`（`task_status` 默认给预览、`include:'full'` 给全文）；更大写 `<state>/reports/<taskId>.md`（台账只留 `path` + 240 字摘要）；空输出不写（不拿空记录覆盖上一次）。摘要压空白、240 字截断；日志只留摘要，完整正文经事件上的非日志字段交给结算，避免 jsonl 单行被撑大。`setTaskLastMessage` 按正文 `digest` 幂等（重复落库不重写行、不动 `updated_at`），文件落盘失败时降级内联。

## 启动对账（S2）

进程重启/崩溃后，子会话的结算事件可能没人消费，台账会留下「running 但实际没人在跑」的幽灵。`src/reconcile.js` 在 `apply()` 与协调者 `agent/created` 晚加载时各对一次账：

- 活跃性对账只认 `running`：`agents.get(session_id)` 不存在 → `orphaned`；catalog 查不到 → `orphaned`；`waiting_user`/`waiting_auth` 不 live 但 catalog 有 → 保持原状态（靠 `task_message` 冷恢复）。
- catalog 读失败只 warn，`running` 的 liveness 判定照做；标记前重读状态，已落终态的不覆盖，重复启动幂等。
- 标记完发**一条汇总通知**（超过 10 条折叠）；启动时协调者还没加载导致投递 `skipped` 时保留待发，`agent/created` 后补发一次。

## 空闲看门狗（W1）

结算/对账管「没人跑却挂着 running」，但**有人在跑、却长时间没进展**的回合仍要人来看。`src/watchdog.js` 每 `watchdogIntervalMinutes`（默认 5）巡检一次：只看 `running`；判定数据源三源取最新（`last_event_at` / `updated_at` / `messages.at`），最新活动早于 `watchdogIdleMinutes`（默认 15）即判空闲；**只告警**（一条 `stalled` 汇总通知，超过 10 条折叠），不改状态、不 kill、不重派；同一段空闲每任务只报一次（去重表在内存）；启动时放在 S2 之后，避免同一任务既报丢失又报卡住；`idleWatchdog:false` 可关。

## 子会话目标（G1）与续跑（P2-2）

平台有完整的 `ctx.goals` 子系统（durable `goal/change` + 进程内 activation + `dsh-goal-round-driver`）。**插件是子任务 goal 的唯一写方**：只做 `create` / `edit` / `complete` / `clear`（外加只读 `get` 做镜像与降级），续跑完全委托宿主 driver——自建的 `agent/turn-stopping` 注入器（`src/keepalive.js`，246 行）已删除。

- **spawn（默认 `goalRounds: 0`）**：`dispatch.spawn` 拿到 childId 后，`src/goal.js` 的桥在子 agent 进注册表时 `create(agent, { objective })`，**紧接着** `disarm(agent)`，顺序固定；goal 只当只读镜子，不驱动续轮。
- **spawn（`goalRounds: N`，1–50）**：`create(agent, { objective, maxGoalRounds: N })` 后**不 disarm**，由宿主 driver 按预算续轮，跑满自行停。插件**不注入消息、不写轮次预算**（`tasks.keep_alive_rounds` 停写、列保留兼容旧库），轮次真源是 `goal.roundsStarted` / `goal.maxGoalRounds`。派发层不需要新参数：桥按 `taskId` 从台账读 `goal_rounds`。
- **task_message / 面板**：投递成功后用 `objectiveForMessage(task.goal, message)` 得到「原目标 + 最新指示」，文本变了才 `edit`；`goalRounds=0` 时若发现 goal 是 armed（宿主 `/goal resume` 或上一段 activation 残留），压回 `disarmed`——「默认不续跑」是硬约束，不靠运气。目标文本上限 2000 字符。
- **done**：`task_report done` 与结算自动 `done` 走 `complete`；**stop/cancelled/failed/orphaned/retry** 走 `clear`。没有 live agent 时只收口台账镜像，平台侧不调用。
- **台账/面板只读**：每次成功变更把裁剪后的 `{id,revision,objective,phase,activation,roundsStarted,maxGoalRounds,updatedAt}` 写进 `tasks.goal_state_json`；snapshot 只下发生命周期字段（不含 objective），面板没有任何 goal 写操作。
- **静默降级**：`ctx.goals` 缺失或方法不全时所有钩子 no-op；`goalRounds>0` 但平台没 arm（旧宿主没有 driver）时记一条 `goal.degraded`（`reason:'not-armed'`），`task_status` 显示「不自动续轮」——**不模拟续跑**。
- **子会话可读**：worker 预设带一行 `tool-goal`，子会话用 `get_goal` 读实时目标；`create_goal`/`update_goal` 因 `requireDirectHuman` 在子会话里必然被拒，等于只读。平台不把 objective 注入系统提示，创建时的目标快照另由 `task_detail` 提供。

> 为什么删掉自建层：旧实现是「先把平台 goal disarm 掉，再自己订阅 `agent/turn-stopping` 注入下一轮」——一个宿主私有契约点（rc 级）+ 一套与宿主 driver 重复的轮次预算。P2-2 把这两件事都还给了平台。

## brief 纯指引（T1）

派发给子会话的 brief 只回答「你是谁、去哪读详情」，创建详情全部留在台账、由子会话用 `task_detail` 现取：

- **形态**：`renderBrief({ taskId, access, worktreeState })` 输出四行（完整访问多一行【访问级别】，隔离任务多一行【worktree 依赖】）——`【任务编号】t-xxxxxxxx` + `【任务详情】先调 task_detail…` + `【执行中待确认】…` + `【确认方式】…`。目标、验收、约束、背景、用户原话、工作目录/权限、经验/前置/产物都不内联。
- **三段常驻提示**（都讲「怎么做」，都明确「不等于已获授权」）：`BLOCKED_HINT`（执行中要拍板 → `blocked` 上报「问题 + 选项」，协调者问用户后续派）、`CONFIRM_HINT`（交付时把待确认要点写进 `summary`；子会话**不能**调 `ask_user_question`——平台对 `origin === 'subagent'` 抛 `DELEGATED_CALLER`；`done` 会清空 `question`/`options`；交付后协调者**不会为「任务能否关闭」提问**，任务保持「已交付待确认」、等 `deliveredTimeoutMinutes` 超时自动完成，用户要改再 `task_message` 追问）、`WORKTREE_INSTALL_HINT`（隔离任务：可以装依赖，**只安装不升级**）。
- **task_detail（只读）**：`src/task-detail.js` 渲染编号/标题/状态 → 目标全文 → 工作目录 + 可写/只读提示 → `【验收标准】`/`【可执行检查】`/`【约束】`/`【背景资料】`/`【用户原话】` → 编排（非默认才出现）→ `【前置任务】`（按**当前**台账现读）→ `【经验文件】<路径>（N 条）` → `【已有产物】` → 完成口径。实现只读台账：不写消息、不改状态/时间戳。
- **越权拒绝**：只允许任务自己的子会话；主会话或别的子会话调用返回「读取被拒绝…主会话查任务用 task_status」，并记 `task.detail.rejected`。
- **挂载链**：和其它 `task_*` 一样由 `index.js` 注册成 host plane 全局工具；协调者预设的 allow 名单不含 `task_detail`，执行层 `COORDINATOR_DENY` 也把它列为子会话专属，主会话看不到/调不到。
- **重派同口径**：`retry` 用 `renderBrief({ taskId: 新任务编号 })` 重渲染，`task.brief` 快照整体复制；队列兜底也用 `renderBrief`，不再拼「【任务】标题 + 目标」。

## 产物

- `task_report.artifacts: [{path,label?}]`，相对路径按 `target_dir`（无则主会话目录）解析；只 `stat` 存在性，非法条目静默丢弃，不阻断完成；同任务多次回报按 `path` 合并（最多 50 条）。
- **done 自动收集**：`task_report done` 时若 Session 有 `workspace/changes` 事件，用 `workspaceChanges.summary()` 汇总所有回合的改动文件，按路径去重后与显式产物合并；当前回合的摘要要等 turn stopping，`index.js` 监听 `session/event` 在摘要服务登记后补收。
- 面板「产物」筛选打开产物库：按项目（目标目录末段）或日期分组、复制路径、文本预览（前 64 KiB）、打开子会话/详情。

### 协调者读产物（`read_workspace`）

子会话产物按契约落在 **target 目录**内，只有一部分落在主会话工作区（`$DSH_HOME/state/orchestrator/workspace`）。所以边界是**两个判据的并集**：工作区包含性 **OR** 已登记产物（台账 `tasks.artifacts_json`）。

- **为什么不开放原生 `read`/`glob`**：平台读路径没有白名单——`dsh-fs-sandbox` 只给写操作加栅栏，`dsh-fs-local` 的 `cwd` 只是相对路径基准，`glob` 直接 spawn ripgrep 全树枚举。给协调者开原生 `read` = 给它全盘可读的宿主进程读者（含 `~/.dsh/.credentials.yaml`），叠加 IM 双向同步还会外发。
- **实现分层**：`src/read-workspace.js` 是纯函数 + 一次有界读（路径判定、行窗口切分、目录列条目、二进制识别、文案渲染）；`src/tools.js` 只做 `requireMain` 身份校验、调用、审计日志。
- **判据分层**：`src/artifact-location.js` 是产物唯一合法性判据（`registeredArtifacts` / `registeredMatch` / `deliverableOf`）；`read_workspace`、`preview`、右侧栏、`present` 四条路径对「什么算合法产物」同源。
- **闸**：① 形状（空 / NUL / `~` 拒绝，不做家目录展开）；② `realpathSync` 真实路径包含性（挡符号链接逃逸）；③ 解析失败时退回词法包含性，把「越界」与「不存在」分开报；④ 都不放行时查**已登记产物**（文件本身或已登记目录子树），登记表不借符号链接放行。
- **体积与截断**：单文件 > 4 MB 直接拒绝；正文按行窗口返回（默认 400 行 / 上限 2000 行，单次 ≤ 64 K 字符），截断给 `nextOffset`；单行超上限时截断该行并标 `truncatedLine`。目录只列一层、最多 200 项。

## 只读子任务

`readOnly:true`（只认显式 true）在 `agent/created` 一到就给子会话 append `sandbox/mode {mode:'read-only'}`，激活后再幂等补一次，续派/重启会再补；只读任务不注册 target 可写根。

## per-task 完整访问（`access:'full'`）

`access:'full'`（只认显式 `'full'`）**复用只读的整条注入路径**，只是模式换成 `danger-full-access`：`ensureSandboxMode(childId, mode)` 在 `agent/created` 一到就 append（`source:'delegation'`），激活返回后再幂等补一次，续派/冷恢复再补；`taskOf` 只把 `tasks.access='full'` 当真。不传 → 一次 append 都没有、不碰默认配置、不碰父会话。视图：brief `【访问级别】完整`、`task_detail`「访问级别：完整」、`task_list`「·完整访问」、`task_status`「访问级别：完整」、通知标题「（完整访问）」、日志 `subagent.full-access`。

## 计划阶段（P8）

`planFirst:true` 的任务 = **只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）**；不开 `planFirst` 的任务行为一字不改。

- **进入**：`queue.pump` 从台账透传 `plan_first` 给 `dispatcher.spawn`；派发时复用 `ensureReadOnly`（压首回合窗口），再用**子 agent 作用域**的 `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode；`planMode` 缺失只 warn（降级为只有只读沙箱）。批准前**不注册** target 可写根。
- **计划落盘（`plan_save`）**：计划文档由**插件在宿主进程**写（不受子会话沙箱限制）：`src/plan-doc.js` 只做纯函数——`planDocPath()` 算出 `<主会话工作区>/reports/plans/<taskId>.md`（没有 `path` 入参；编号白名单 + `relative()` 包含性校验把 `..`/绝对路径/盘符拒在 `mkdir`/`writeFile` 之前），`renderPlanDocument()` 加文档头，`writePlanDocument()` 只做一次 mkdir + 覆盖写。写完登记为任务产物。子会话拿到结果后只上报 **3–8 行摘要 + 文档绝对路径 + 待拍板清单**。
- **出口**：`plan_save` 落盘 → `task_report blocked` 上报摘要 + 路径 → 用户决定 → `task_message` 续派，**不用** `exit_plan_mode`（子会话没有直接人类）。插件在子会话 **agent 作用域**拒绝 `exit_plan_mode`（插件根的 guard 是全局的，会误伤协调者）。
- **退出（批准）**：投递成功、任务回到 `running` 后 `sandbox/mode = workspace-write` + `planMode.set(agent,false)` + 台账 `plan_state='approved'`，同时补登记 target 可写根；投递失败不碰 plan 状态。
- **停止/终态**：释放 guard；还在 `planning` 就结束的收口成 `rejected`，已 `approved` 的保留。
- **台账视图**：`plan_first` + `plan_state`（`none`/`planning`/`approved`/`rejected`）；面板「计划中」小标与抽屉「计划」行；非计划任务不下发任何计划字样。`planFirst` 与 `readOnly` 创建期互斥。

## worktree 隔离（P9）

`task_create({ worktree: true })` 时插件在**宿主进程**建检出，子会话在检出目录里干活；不开 `worktree` 的任务行为一字不改（**一次 git 都不调**）。

- **声明只有结构化两处**：profile 配置 `worktreePolicy` / `worktreeBranchPrefix` / `worktreeRecentDays`，以及 `task_create.worktree*` 字段。插件**不读** `AGENTS.md`、**不解析**自然语言：「要不要隔离」由协调者判断。
- **模块**：`src/worktree.js` = 宿主侧 git 能力（`probeRepo` / `create` / `remove` / `ensureExcluded` / 分支名校验 / `prepareTaskWorktree` / `cleanupTaskWorktree` / `retryWorktreeOf`）；`src/worktree-request.js` = 结构化请求校验 + 机械映射 + 展示文案（纯函数）。
- **创建期**：先互斥校验（`readOnly`/`planFirst`）与复用查找（`worktreeMode:'continue'`）；真要建时才 `probeRepo`（普通任务零 git 调用）→ 非仓库 `degrade`；基线：显式 `worktreeBase` 要 `rev-parse --verify` 通过、缺省时 n=0 用默认分支 / n=1 用那条 / **n≥2 返回 `needsBranchChoice` 且不落库**。落库七列（`worktree_path` / `_branch` / `repo_root` / `_base` / `_mode` / `_source` / `_state`），`state='requested'`。
- **派发期**：`git worktree add -b <branch> <repo>/.agents/worktrees/<taskId> <base>`——**永远 -b 新分支**（直接检出已在主工作树检出的基线会被 git 拒绝）；`reused` 不调 git，只换算路径；`target_dir` 换成「检出目录 + 原 target 相对 repoRoot 的偏移」。建树失败标 `failed` 并写原因（不静默降级）。
- **`.git/info/exclude`**：建树成功后把 `.agents/` 追加进去（幂等、不动 `.gitignore`；不可写只 warn）。
- **清理三档**：`off`（默认，全留）/ `checkout-only`（只 `worktree remove`）/ `full`（连分支一起删，有未合并提交会提示）；在终态异步跑，失败只记日志。
- **产物语义**：产物在检出目录里，**用户工作树没有这些改动**；平台没有合并工具，插件也不提供。

## 目标目录推断

不传 `target` 时，用 `title` + `goal` 匹配 `workspaceRegistry.list()` 的显示名与路径末段：精确名优先、否则子串层；纯 ASCII 键至少 3 个字母数字，CJK 至少 2 字；通用末段（workspace/documents/desktop/default/src/app/tmp）不参与匹配；被更具体名字严格包含的泛命中丢弃；唯一命中写 `target_dir`，多命中不建任务、列候选，无命中沿用主会话目录；registry 不可用时按无工作区降级。

## 路由与面板

`POST /api/orchestrator`，connection owner-only：

| endpoint | 作用 |
|---|---|
| `snapshot` | 只读快照（含 `handoff` 精简版、`teamBoard`、任务行 `acceptance` 摘要） |
| `open-main` | 创建/打开主会话 |
| `detail` | 任务详情、消息、依赖、产物、最新回复、交接、官方板关联 |
| `artifacts` | 产物汇总（项目/日期分组所需字段） |
| `preview` | 预览台账里登记的文本产物（前 64 KiB） |
| `stop` / `retry` / `message` / `delete` | 面板动作（门控见 `src/panel-gates.js`；`message` 仅可续派状态，但面板已无「追加」按钮） |

面板 2s 轮询，连续失败退避 30s；`canDelete` 由服务端判定并随 snapshot/detail 下发。

## 面板与详情（UI U2）

面板是 `ctx.slots.register({ name:'main', key:'orchestrator' })` 的整块组件。四件事值得记在架构里：

- **构建链与产物路径**：客户端源码在 `client/src/**`（ESM），由 `vite.client.config.mjs` 构建成 `dist/client.js`（iife classic script + `.map`），**产物入库**。平台按 `exports["./client"]` 把该文件原样 serve 成 `/plugins/<id>/client.js`，路由只服务这一个 JS（+ 同名 `.map`），`.css` 一律 404 → 样式必须 `?inline` 回 JS（构建期内联成 `STYLE_TEXT`，`ensureStyles()` 按 id 去重注入）。改 UI = 改 `client/src/` + `pnpm run build`。
- **体积闸门（P2-5）**：默认开 esbuild minify（`sourcemap: true` 保留；`CLIENT_MINIFY=0 pnpm run build` 出可读产物），产物 ≤ **95 KiB** 由 `scripts/check-client-size.mjs` 断言，挂在 `pretest` 与 `prepublishOnly`。源码分模块：`index.js`（只注册 factory）→ `client.js`（装配 + `apply` + `__test`）→ `views.js`（面板/抽屉/启动器）→ `ui.js`（展示件）、`styles.css`、`logic.js`（纯函数）、`api.js`（宿主 HTTP 契约）、`gate.js`（入口闸门）、`constants.js`（文案/常量）。
- **三段式与抽屉**：顶部命令栏（标题/主会话状态/搜索/刷新/打开主会话 + 4 张指标卡）、中部（筛选轨 + 任务卡列表 / 产物库）、右侧详情抽屉（概览、最新回复、Brief、验收、交接、目标状态、消息、依赖、产物）。抽屉常驻挂载、`data-open` 驱动 `transform` 过渡；每区块可折叠（`aria-expanded` + `0fr↔1fr`）都有空态。列表侧纯逻辑提到组件外（`countTasks` / `matchesFilter` / `matchesQuery` / `groupArtifacts`），单测直接断言行为。
- **按钮可见性与动作门控同源**：`src/panel-gates.js` 是唯一判定（`followupGate` / `deleteGate`），服务端面板动作与 `task_message` 都先过它，`snapshot`/`detail` 把 `canFollowup` / `canDelete` 下发，客户端只读这两个布尔值渲染按钮。删除 = 终态且没有活跃下游依赖，只清台账行（任务 + messages + notifications），不删产物文件与 memories。
- **P2 的只读视图**：官方 Team 板分区（折叠、行内无按钮、`enabled:false` 不渲染）、抽屉「交接」区块（契约版本/交付与确认时间/谁确认/轮次/验收结论/官方板关联）、任务卡「验收 2/2」小标（来自 `snapshot.tasks[].acceptance`）。

### 产物预览复用宿主右侧栏（U2.1）

产物预览不自建视图：`openArtifactPreview(path)` 转成宿主的 `ctx.sidebarRight.openResource(address)`，Tab 类型由 `dsh-client-ui-sidebar-documentpreview`（`kind:'text'`）认领，Markdown / 代码 / 图片 / PDF / Office 都有渲染器。

- **地址**：`fileAddressOf(sessionId, path)` 拼 `dsh-resource://file/session/<id>/<逐段编码 path>`，与宿主的 `sessionFileAddress` 逐条对齐（`: ` 保持字面以兼容盘符）；只认领 `session` 作用域，所以必须带会话 id、且不 trim。
- **必须先切回会话**：右侧栏按 Session 挂载，面板占主栏时直接 `openResource` 会抛 `no session surface is mounted`；顺序固定为 `ctx.layout.selectPanel(null)` → `openResource`。探测全通过才切面板，`openResource` 抛错时切回来并返回 `{ok:false, reason, message}`——不靠轮询 `mounted` 猜时序。
- **降级四档**：`sidebar-missing` / `no-session` / `bad-path` / `host-refused`；产物库行额外回退旧 `preview` 端点 + 行内预览。
- **登记校验不绕开**：服务端 `preview` 只读本任务已登记产物；右侧栏是宿主直接读文件，所以前端用 `isRegisteredArtifact(path)` 做等价校验（只允许快照卡片 / 产物库 / 抽屉三个服务端下发来源出现过的路径）。
- **不接管宿主几何**：宽度、折叠、多 Tab、`<768px` 全屏都由宿主负责，插件不存预览状态；交付卡片的预览走同一个右侧栏。

### 界面与消息块（合并自原 UI.md）

- **布局与 token**：`.orch-topbar` + `.orch-metrics`（4 张指标卡）、`.orch-body`（`.orch-rail` 筛选轨 7 项 + 卡片列表 / 产物库）、`.orch-layer > .orch-scrim + .orch-drawer`；窄屏 ≤860px 筛选轨变横向条、≤640px 抽屉铺满。颜色/圆角/阴影/动效全部取宿主 `--dsw-*` / `--ds-*` token，**不写死颜色**，每处 `var()` 带兜底值；旧 bug 用过的 `--dsw-alias-color-*` 这类不存在的变量已统一成 `--dsw-alias-state-*` / `--dsw-alias-label-*`（测试有 `doesNotMatch` 守着）。
- **交互**：hover、抽屉滑入滑出、`0fr↔1fr` 折叠、骨架 `orch-shimmer`、按钮按下反馈；二次确认用 `.orch-confirm` 两步（不用 `window.confirm`）；空态/加载/错误态齐备；`Esc` 关抽屉、`aria-expanded/pressed/hidden/label`、`:focus-visible` 焦点环；`prefers-reduced-motion: reduce` 关掉全部动画。
- **会话头入口**：注册在 `conversation.header.leading`（单席位），仅主会话显示；视觉与面板顶栏同一套语言（透明底、图标块 `.orch-entry-mark`）。

### 回复底部关联任务 chip（官方 turnTail 槽位）

协调者每轮回复底部（动作行**之上**）挂一行关联任务 chip：状态图标 + 标题，点一下打开面板并定位到该任务。

- **挂载**：槽位 `conversation.chat.turnTail`（`kind:'list'`、`scope:'session'`）；宿主 `TurnTailNodeView` 先 `renderSlot(...)` 再动作行，所以 chip 天然落在动作行上方；注册点在 `client/src/client.js`（同 id 复注册才是替换）。
- **关联规则**：R1 只收 `coordinatorSession === 当前 sessionId` 的任务；R2 只挂最新一轮已完成回复；R3 活跃状态全收、终态只在 `lastEventAt` 最近 30 分钟内收；R4 按 `lastEventAt↓ → updatedAt↓ → id↑` 取前 2 个，其余折「+N」。
- **状态映射**：10 个台账状态压成 6 个视觉态（`CHIP_STATE_OF` / `CHIP_STATE_VIEW`）：`running` 自转圆环、`waiting` 虚线圆、`confirming` 半色脉冲、`done` ✓、`failed` ✗、`cancelled` 一横；颜色走 `TONE_COLOR`，`prefers-reduced-motion` 下停转停脉冲但保留形状。
- **交互与性能**：点 chip → `openTask(id)` 记一次性 focus → 打开面板并定位；「+N」只开面板；长标题按码点截 24 字。单实例 `createTaskFeed`，只有「主会话 + 最新一轮」那行订阅；节奏：有活跃任务 3s、全终态 15s、失败退避 30s；响应先剪成 6 个字段算签名，没变复用对象。空状态 = 不渲染整行。

## 插件页与面板错误码（合并自原 DETAIL.md）

插件页只展示一段简介与文档链接；这里只留运维需要口径：

- **常用工具**（10 个，详见 README「工具清单」）：协调者 `task_create` / `task_list` / `task_status` / `task_message` / `context` / `memory_note` / `read_workspace`；子会话 `task_report` / `task_detail` / `plan_save`。
- **面板动作与错误码同源**：面板 stop / retry / message / delete 与 `task_message({action})` 共用 `src/action-errors.js` 的 code 与门控；面板失败返回 `{ok:false, code, error}`，`host-route` 按 code 映射 HTTP 状态（400 参数 / 404 不存在 / 409 状态冲突 / 502 投递失败 / 500 内部）。
- `stop`：已结束再 stop 返回 `{ok:true, already:true}`；收子会话失败不阻断取消（`warnings[].code=STOP_DISPATCH_FAILED`）。
- `retry`：只允许 failed/orphaned；已有活跃重派直接返回那条任务；同 title+goal 的其他活跃任务返回 `RETRY_DUPLICATE_ACTIVE`。
- `message`：只允许 running / waiting_user / waiting_auth / delivered 且已有子会话（`delivered` 上是追问）；错误码 `MESSAGE_TASK_ENDED` / `MESSAGE_WAITING_DEP` / `MESSAGE_NO_SESSION` / `MESSAGE_NOT_FOLLOWABLE` / `MESSAGE_DELIVERY_FAILED`。面板每次点击生成 `clientRequestId`，按 `(taskId, clientRequestId)` 进程内去重。
- `delete`：只允许终态；还有活跃下游返回 `DELETE_HAS_ACTIVE_DEPENDENTS`；成功时级联删 messages / notifications，产物文件与 memories 不动。
- **边界**：依赖只能指向已存在任务、不支持编辑；`writeScopes` 是冲突提示不是文件锁；`done` 不可逆、不提供 reopen；台账每天快照，损坏要手工恢复（见 [LIMITATIONS](LIMITATIONS.md)）。

### 插件页配置卡片

插件页（侧栏「插件」→ dsh-orchestrator 详情）的「配置」卡片：**28 个字段**，与 `loadConfig({})` 的实际键集合一一对应
（P2-2 删掉的 7 个键——`keepAlive*` 四键与 `mergeWindowMs` / `stallRounds` / `preferencesMaxItems`——不出现在表单上，
只由 `src/config.js` 的 `DEPRECATED_KEYS` 给弃用警告），等价于手改 profile 的 `cordis.patch.yml`。DSH 的插件配置 UI 是「插件自带组件」模型——宿主只提供
`configForms`（值 + 写操作）与 slot，**不生成表单**（0.2.2-rc.3 的 `autoGenerate` 字段全 asar 无 client 消费方）。

**三件套**（字段规格只声明一次，三方共用，避免漂移）：

| 文件 | 职责 |
|---|---|
| `src/config-fields.js` | 字段单一事实源：名称/类型/枚举/区间/默认/只读/分组 |
| `src/config-schema.js` | 投影成 schemastery `Config`（每字段 `.default().loose().volatile()`）+ `unwrapVolatile` + 降级加载 |
| `client/src/config-form.js` + `config-logic.js` | 分组折叠表单；纯逻辑（`buildOps`/`isDirty`/`parseInput`）单独拆出以便 node 直测 |

**注册的三个 key 各不相同**（写错任一处都是静默不渲染）：slot 名 `plugins.bundle.config`；
slot key = bundle **包名**（`CONFIG_SLOT_KEY`）；`configForms.get()` / `whileServed()` 参数 = Loader **entry id**
（`CONFIG_ENTRY_ID` = `orchestrator`，即 `cordis.patch.yml` 的 id）。`whileServed` 保证插件没加载时页面完全无痕。

**暴露策略**：高频子集可编辑；`coordinatorSession` 与 `mainRotation.*`（含 `rotateArchiveOld`）只读展示
（前者是运维兜底通道，后者牵动不可逆归档）。写通道 `mutate(ops, revision)` 带 revision 栅栏，别人先改过就拒绝并刷新，
不静默覆盖；清空一个「已覆盖」字段发 `unset`（回落组合默认且不再算覆盖）。保存触发插件重载（台账不受影响，
watchdog/轮换计时器重置），页面文案写明。

**四个必须守住的 P0**（改动前先读 `src/config-schema.js` 文件头，`test/config-fields.test.js` 逐条反向验证过）：

1. **不得拒载**：Cordis `resolveConfig()` 校验失败抛 `ValidationError` → 插件起不来。解法：每字段 `.default()`、
   不 `required()`、`.loose()` 兜底。反向验证：去掉 `.loose()` → 2 条用例变红。
2. **volatile 不得漏标**：宿主 `volatileForm()` 只保留 volatile 字段，漏标 = 页面上不报错地少一行。解法：单测把
   schema 的 volatile 集合与字段表 key 集合**双向比对**。反向验证：去掉 `.volatile()` → 2 条变红。
3. **volatile 到达 `apply` 是包装对象**：经 Cordis 校验后是带 `.get()` 的 cosmokit Volatile，不解包会让
   `loadConfig` 的 `typeof` 判断全失效、用户配置被无声丢弃（实测 `staleMinutes:10` 变回 30）。解法：`apply` 首行
   `unwrapVolatile(rawConfig)`。
4. **schemastery 解析失败不得拖垮整个插件**：它是宿主自带包，本插件声明为 optional peer，但静态 `import` 失败 =
   模块加载失败 = 任务面板与全部工具一起消失。解法：`createRequire` + try/catch 同步降级为 `Config=undefined`
   （宿主 `resolveConfig()` 遇空 Config 跳过校验，已核实）。

**废弃键**：P1-A 删掉的 6 个键（`backend`、`rotateAfterTasks`、`rotateAfterSessions`、`rotateAfterContextTokens`、
`rotateAfterDiskMiB`、`rotateCheckIntervalHours`）由 `src/config.js` 的 `DEPRECATED_KEYS` 给一次性迁移提示；
它们**不出现在配置卡片上**（字段表不含），无需 UI 侧额外接入。

## 落盘与日志

```
$DSH_HOME/state/orchestrator/
  tasks.sqlite
  snapshots/tasks-YYYY-MM-DD.sqlite
  logs/YYYY-MM-DD.jsonl
  handoff/handoff-YYYY-MM-DD.jsonl  # 交接契约 v1 事件（task.handoff.*，保留 30 天）
  lessons/<项目>-<short-hash>.md   # task_detail 经验指针指向的记忆文件（每次派发覆盖）
  reports/<taskId>.md              # 超 64 KiB 的返回消息全文
  workspace/                       # 指挥舱
```

- 日志按天、保留 7 天、单文件超 5MB 换新；`goal`/`summary` 只留 80 字，不写 `user_verbatim`。
- 交接事件独立目录、保留 30 天（外部订阅方可能一周才拉一次）；不进仓库、不写台账 messages。
- 快照启动时生成、每 6 小时跨日检查，保留 `snapshotRetentionDays` 天；损坏不自动恢复。

## 错误与降级

- 台账损坏/不可用/被占用给中文可读错误，不泄漏 `SQLITE_` 和堆栈。
- 协调者会话失效：`task_create` 标 `failed` 并给原因；只是未加载则任务排队等 `agent/created`。
- 子会话不可达：`orphaned`，可重建；续派失败重试 3 次（1s/2s/4s），仍失败转 `waiting_user`。
- 能力缺失（`ctx.goals` / `agentTeams` / `schedule` / `sidebarRight`）一律「整段消失 + 可读降级」，不模拟成功。
