# 架构与关键机制

本文是 README 的技术补充，面向维护者。用户使用只需看 README。

## 角色

- **协调者**：唯一主会话，固定入口；只拆任务、派子会话、看回报，不读写文件、不执行命令。
- **子任务**：独立 DSH 子会话，直连 `ctx.subagents.startActivation`，不占 Team 名册；能力不受限，另有两个插件工具：`task_report`（回报）与 `task_detail`（只读任务创建详情）。
- **客户端**：侧栏「主会话」入口（始终可见）+ 会话头「任务」面板（仅主会话可见）；只读快照 + 面板动作。

## 主会话

解析顺序：

1. `config.coordinatorSession`（显式覆盖，不写台账）
2. 台账 `settings.main_session_id`
3. 未打开：`task_*` 返回「尚未打开主会话」

`open-main` 会确保「指挥舱」工作区存在，用协调者预设 `dsh-orchestrator-coordinator` 创建会话，`rename` 成「主会话」，写入 `settings.main_session_id`，然后跳到该会话。

复用判定以台账 `settings.main_session_preset` 为准；UI 空白会话可能被 rebind 成默认预设，插件会在 `agent/created` 和复用前调用 `agentPresets.select` 拉回，失败只记日志并由 guard 兜底。

### 入口可见性（U1）

- **任务入口（会话头「☰ 任务」）只在主会话显示**：`client.js` 的 `createMainViewGate` 判「当前会话是不是主会话」。
  - 当前会话信号：`uiSession.adapter.current.getSnapshot().key`（优先），取不到退 `sessions.list.getSnapshot().byId` 里
    `retainedBy.mainView > 0` 的会话 id（与 ds-bot 的 `shownSession()` 同口径）。
  - 身份判定：POST `/api/orchestrator` 的 `session-role` → `src/host-route.js` 用 `coordinatorStatus().id` 与请求里的 `sessionId`
    走 `src/session-role.js` 的 `isMainSession`；信号与 `task_*` 工具、通知投递同源（台账 `main_session_id`）。
  - 渲染：`conversation.header.leading` 的 inject 暴露 `hooks.mainView`，`HeaderButton` 在 `useMainView` 为 false/缺失时返回 `null`。
  - 降级（fail-closed）：没有当前会话 id、宿主路由不可用、HTTP/JSON 失败、响应不是 `ok:true` 一律隐藏；失败结果不缓存，
    换会话立即重判，另有 5 秒兜底轮询重试。同一会话的明确答案缓存，避免会话列表频繁刷新时刷请求。
- **侧栏「◈ 主会话」跳转入口始终注册/可见**，不参与主会话判定：它是首次创建主会话的引导入口，不能因为「还没有主会话」而消失。
- 面板主体仍然注册为 `main` keyed 槽位（`key:'orchestrator'`）；入口隐藏不等于面板消失，`selectPanel('orchestrator')` 仍可用（供其他入口/排障）。

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
- 前置任务摘要与产物不在派发时预渲染：子会话用 `task_detail` 按**当前**台账现读（依赖可能在创建之后才完成），见下文「brief 纯指引（T1）」。
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

### 最新返回消息（B1）

两路事件都自带子会话最后一条 assistant 消息（`subagent/result.output` / 平台 `subagent/end.lastAssistantMessage`），结算时顺手落进台账，主会话用 `task_status` 就能读到「它最后说了什么」，不必打开子会话历史：

| 情况 | 存储 | `task_status` 默认 | `include: 'full'` |
|---|---|---|---|
| 正文 ≤ 64 KiB | `tasks.last_message_json.text`（内联） | 正文（超 1200 字给预览 + 截断提示） | 正文全文 |
| 正文 > 64 KiB | `<state>/reports/<taskId>.md`，台账只留 `path` + `summary` | `reports` 路径 + 240 字摘要 | 读文件给全文（文件缺失时给摘要 + 失败原因） |
| 空输出 / `subagent.failed` | 不写（不拿空记录覆盖上一次） | 不显示该区块 | 同左 |

- 摘要（`summarizeText`）仍走原口径：压空白、240 字截断；通知与死因只用摘要，不改文案长度。
- 日志只留 240 字摘要（`detail.output`），完整正文经事件上的非日志字段 `lastMessage` 交给结算；两者分开，避免 jsonl 单行被正文撑大。
- 幂等：结算只认 `running`，第二次事件直接跳过；`setTaskLastMessage` 再按正文 `digest` 兜一层——同一段正文重复落库不重写行、不动 `updated_at`，文件按任务编号覆盖，不会堆一堆副本。
- 文件落盘失败时降级内联（宁可撑大一行台账，也不丢模型最后说的话），`reports/` 目录按需创建、启动时不建。

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

## 空闲看门狗（W1）

结算/对账管「没人跑却挂着 running」，但**有人在跑、却长时间没进展**的回合仍要人来看。`src/watchdog.js` 每 `watchdogIntervalMinutes`（默认 5 分钟）巡检一次台账：

- 只看 `running`：`waiting_user` / `waiting_auth` 是故意停下的，终态不在范围；
- 判定数据源三源取最新（`lastActivityAt`）：`tasks.last_event_at`（心跳：progress、产物/问题更新等 touch）、`tasks.updated_at`（状态变化）、`messages.at`（最近一条回报消息）；最新活动早于 `watchdogIdleMinutes`（默认 15 分钟）即判空闲；
- **只告警**：一条 `stalled` 汇总通知（超过 10 条折叠），**不改状态、不 kill、不重派**，也不写任务表；
- 去重：同一段空闲每个任务只报一次；出现更新的活动（活动水位抬高）后允许再报一次，任务离开 `running` 就从去重表移除；去重表在内存，重启后允许再报一次；
- 启动时放在 S2 对账之后：先让「进程重启后没人跑」的 `running` 落 `orphaned`，避免同一任务既报丢失又报卡住；
- 关闭：`idleWatchdog:false`；插件卸载先 `stop()` 再关台账，定时器不会在 `db.close()` 后继续巡检。

## 子会话目标（G1）

平台有完整的 `ctx.goals` 子系统（durable `goal/change` + 进程内 activation + `goal-round-driver`）。本插件只取它的**状态能力**，不取续轮能力：

- **spawn**：`dispatch.spawn` 成功拿到 childId 后，`src/goal.js` 的桥在子 agent 进注册表时执行 `create(agent,{objective})`，**紧接着** `disarm(agent)`，顺序固定；子会话目标 = `tasks.goal`。
- **task_message / 面板追加**：投递成功后用 `objectiveForMessage(task.goal, message)` 得到「原目标 + 最新指示」，文本变了才 `edit`，随后确保 `disarmed`。目标文本上限 2000 字符。
- **done**：`task_report done` 与结算自动 `done` 走 `complete`；**stop/cancelled/failed/orphaned/retry** 走 `clear`。没有 live agent（冷恢复/孤儿）时只收口台账镜像，平台侧不调用。
- **台账/面板只读**：每次成功变更把裁剪后的 `{id,revision,objective,phase,activation,roundsStarted,maxGoalRounds,updatedAt}` 写进 `tasks.goal_state_json`；snapshot 只下发生命周期字段（不含 objective），详情抽屉展示完整只读状态，面板没有任何 goal 写操作。
- **静默降级**：`ctx.goals` 缺失或方法不全时 `createGoalBridge` 的所有钩子 no-op，不 warn、不阻塞派发/续派/结算、不写镜像。
- **子会话可读**：`dsh-orchestrator-worker` 预设带一行 `tool-goal`（`@deepseek-ai/dsh-tool-goal`）。web-app 层把 host plane 的 `tool-goal` 行 `disabled: true`、改由预设挂载，而 `goals` 服务仍在 host plane（`dsh-base` 的 `goal` / `goal-round-driver` 行），所以子会话拿得到 `get_goal` 读到本任务目标；`create_goal` / `update_goal` 因平台权限校验（`requireDirectHuman`：需要顶层 agent 的**直接人类**回合）在子会话里必然被拒，等于只读。
  平台**不会**把 objective 注入系统提示或消息（`dsh-goal` 的 inject 只有 `agents` / `sessionProjections`），所以 `get_goal` 是子会话读**实时目标（含「最新指示」）**的途径；创建时的目标快照另由 `task_detail` 提供（T1）。不挂这行时子会话仍能从 `task_detail` 拿到创建时的目标，但读不到之后 `task_message` 并进去的最新指示。

## 回合间 keep-alive（K2）

`src/keepalive.js`。平台在回合结束前派发 `agent/turn-stopping`（serial 且被 await）：监听器返回前投递的消息进 inbox，loop 在回合尾部重读 inbox 继续跑——
`steer` → `next-step`（同一 turn 多走一步，不写 `turn/end`），`followup` → `next-turn`（新 turn）。因此 `agent.status` 不经过 `idle`，
而 S1 的结算观察器与平台 goal driver 都以 `idle` 为触发点，轮次之间根本没有可观察的 idle：不是处理了「结算 vs 续轮」竞态，而是不产生这个观察点（K1 探针实测见 [reports/k1-keepalive-probe.md](../reports/k1-keepalive-probe.md)）。

- **接线**：`index.js:348` `createKeepAlive({ db, config, logger, goalState })`，`index.js:355` `keepAlive.start(ctx)` 订阅 `agent/turn-stopping`（`src/keepalive.js:230`），disposer 进 `ctx.effect` 清理列表（`index.js:531`）。
- **续跑判定**（纯函数 `keepAliveSkipReason()`，`src/keepalive.js:49`）：开关开 / 无 `signal.aborted` / `agent.status === 'running'` / 任务存在且 `running` / 非只读 / inbox 无 `nextStep`·`nextTurn` / 平台 goal 存在且 phase 不是 `complete`·`cleared` / 轮数未满；全部通过才注入（`handle`，`src/keepalive.js:129`）。
- **预算**：`tasks.keep_alive_rounds`（旧库自动补列）+ `bumpKeepAliveRound()`（`src/ledger.js` 条件 `UPDATE ... WHERE status='running' AND keep_alive_rounds < ?`，
  重复/并发事件不会超发）；每次 `transition(..., 'running')` 归零，等于「每段 activation 一份预算」。轮满、goal 收口、注入异常都在 `handle` 里就地停。
- **注入形态**：`role:'user'` 消息，`source.kind = 'orchestrator-keepalive'`（带 `taskId`/`round`），正文「（keep-alive 第 N/M 轮）+ 默认提示或 `keepAlivePrompt`」；
  默认 `steer`，`keepAliveMode:'followup'` 切新回合。每次注入写一条 `kind='keepalive'` 审计消息 + `task.keepalive.injected` 日志；停止原因写 `task.keepalive.stopped`（同任务同原因只记一次）。
- **与 S1 的边界**：keep-alive 不改任务状态、不写 `progress_count`、不写 `kind='followup'` 消息（避开面板「同文去重」口径）、不调用结算。
  结算仍然只在 `subagent.settled` / `subagent/end` 上由 S1 做一次（状态机天然幂等）；任务一旦离开 `running`，同一会话后续的 `turn-stopping` 直接跳过，
  不会把已结算任务重新拉起来。`aborted`/`error`/blocked 不经过 `turn-stopping`，keep-alive 也无法阻止显式 stop / 父级 dispose / 模型报错。
- **默认关闭**：`config.keepAlive !== true` 时监听器在查台账之前返回（连 `db` 都不用），升级后行为与旧版一致。

## brief 纯指引（T1）

派发给子会话的 brief 只回答「你是谁、去哪读详情」，创建详情全部留在台账、由子会话用 `task_detail` 现取：

- **brief 形态**：`renderBrief({ taskId })` 只输出两行——`【任务编号】t-xxxxxxxx` + `【任务详情】先调 task_detail（参数 task_id 填上面的任务编号）读取完整任务详情：…`。
  目标、验收、约束、背景、用户原话、工作目录/权限、经验、前置任务、产物都不再内联；也不再有「`get_goal` 不可用」的兜底文本。
  目标正文仍在平台 goal（G1 `attach`）里，子会话也可以 `get_goal` 读；`task_detail` 读的是创建时 `brief_json` 快照，两条路互不依赖。
- **task_detail（只读）**：`src/task-detail.js` 的 `renderTaskDetail` 渲染
  任务编号/标题/状态 → 目标全文（保留换行）→ 工作目录 + 可写/只读提示 → `【验收标准】`/`【约束】`/`【背景资料】`/`【用户原话】`
  → 编排（分组/优先级/写域，只在非默认时出现）→ `【前置任务】`（复用 `deps.upstreamBrief`，按**当前**台账现读状态/最近回报/产物）
  → `【经验文件】<路径>（N 条）｜可 read 全文`（写文件失败时退回内联块）→ `【已有产物】`（路径/标签/存在性）→ 完成口径。
  实现只读台账：不写消息、不改状态/时间戳；经验文件只 `stat` 存在性，正文交给子会话自己的 `read`。
- **越权拒绝**：`task_detail` 只允许任务自己的子会话（`exec.agent.id` 或 `exec.agent.session.id` 等于 `tasks.session_id`）；
  主会话或别的子会话调用返回「读取被拒绝…主会话查任务用 task_status」，并记 `task.detail.rejected` 日志。
- **经验不再进提示词**：`task_create` 命中事实层记忆时 `buildLessonBlock` 照旧写
  `$DSH_HOME/state/orchestrator/lessons/<项目目录名>-<key 短 hash>.md`，但只把指针 `{ path, count }`（或降级时的 `{ inline }`）
  存进 `brief.experience`，由 `task_detail` 给出。`stateDir` 缺失/写文件失败 → 内联块只出现在详情里；无命中 → 不建文件、详情无经验小节。
- **重派同口径**：`task_retry` 与面板 `retry` 都用 `renderBrief({ taskId: 新任务编号 })` 重渲染，`task.brief` 快照（含经验指针）整体复制。
- **挂载链**：`task_detail` 和其它 `task_*` 一样由 `index.js` 的 `createTools(...).map(tool => ctx.tools.register(tool))` 注册成 host plane 全局工具
  （`index.js:430-441`）；`cordis.patch.yml` 的 `dsh-orchestrator-worker` 预设**不挂** `preset-tools`、不做 allow/deny 收窄，
  所以子会话工具表直接继承它（与 `task_report` 同一条路）。协调者预设的 `preset-tools` 白名单不含 `task_detail`，执行层 `COORDINATOR_DENY` 也把它列为子会话专属工具，
  所以主会话看不到/调不到它；即便某个 profile 例外地暴露出来，工具内的 owner 校验仍会拒绝。
- **队列兜底**：`queue.pump` 优先用落库的 brief 消息；没有（直接建台账/旧数据）时用 `renderBrief({ taskId })` 兜底，不再拼 `【任务】标题 + 目标`。
- 接线：`index.js` 把插件写入根作为 `createTools({ stateDir })` 传入；`memoryInject:false` 时整段跳过。`project_context` 仍用内联记忆块（协调者读，不走文件）。


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
| `detail` | 任务详情、消息、依赖、产物、最新回复（B1） |
| `artifacts` | 产物汇总（项目/日期分组所需字段） |
| `preview` | 预览台账里登记的文本产物（前 64 KiB） |
| `stop` | 停止任务 |
| `retry` | 重派 failed/orphaned |
| `message` | 追加消息 |

面板 2s 轮询，连续失败退避 30s；任务卡「详情/停止/重派/追加/打开子会话」；「产物」筛选打开产物库（按项目/日期分组，预览/复制/打开子会话/详情）。

## 面板与详情（UI U2）

面板是 `ctx.slots.register({ name:'main', key:'orchestrator' })` 的整块组件，视觉规范见 [UI.md](UI.md)。三件事值得记在架构里：

- **样式表怎么进来的**：客户端插件是经典脚本（不能 `import` CSS），所以 `client.js` 把整张表写成 `STYLE_TEXT`
  字符串，`ensureStyles()` 在 `apply()` 里按 `#dsh-orchestrator-styles` 去重注入 `<style>`。颜色/圆角/阴影/动效
  全部取宿主 `@deepseek-ai/dsh-client-ui-theme` 的 `--dsw-*` / `--ds-*` token，深浅色由宿主写在
  `body[data-ds-dark-theme]` 的 alias token 决定，面板不做任何主题判断。
- **三段式**：① 顶部命令栏（标题/主会话状态/搜索/刷新/打开主会话）② 中部工作区（筛选轨 + 任务卡列表 / 产物库）
  ③ 右侧详情抽屉。抽屉常驻挂载、`data-open` 驱动 `transform` 过渡；`Esc`/遮罩/关闭按钮都能收起。
  列表侧把纯逻辑提到组件外（`countTasks` / `matchesFilter` / `matchesQuery` / `groupArtifacts`），单测直接断言行为。
- **详情抽屉 7 区块**：概览、**最新回复**（B1，`detail.task.lastMessage`）、**brief**（验收/约束/背景/用户原话，
  结构化列表）、**目标状态**（G1，只读）、**消息**（最近 20 条；`followup` 标待发/已投递/投递失败）、
  **依赖**（上游前置 + 下游依赖本任务，各带状态与错误）、**产物**（路径/标签/存在性，路径可一键复制）。
  每个区块都可折叠（`aria-expanded` + `0fr↔1fr` 过渡），都有空态。底部动作条：停止（内联二次确认）/重派/追加消息/打开子会话。
  投递状态落在 `messages.meta_json.delivery`（pending → delivered/failed，只改 meta 不加行）；A3 之前的旧消息按紧随其后的 `delivery_failed` 行推断。


## 落盘与日志

```
$DSH_HOME/state/orchestrator/
  tasks.sqlite
  snapshots/tasks-YYYY-MM-DD.sqlite
  logs/YYYY-MM-DD.jsonl
  lessons/<项目>-<short-hash>.md   # task_detail 经验指针指向的记忆文件（每次派发覆盖）
  reports/<taskId>.md              # 超 64 KiB 的返回消息全文
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
