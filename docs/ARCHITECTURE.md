# 架构与关键机制

本文是 README 的技术补充，面向维护者。用户使用只需看 README。

## 角色

- **协调者**：唯一主会话，固定入口；只拆任务、派子会话、看回报，不读写文件、不执行命令。
- **子任务**：独立 DSH 子会话，直连 `ctx.subagents.startActivation`，不占 Team 名册；能力不受限，另有三个插件工具：`task_report`（回报）、`task_detail`（只读任务创建详情）与 `plan_save`（计划任务的计划落盘，见「计划阶段（P8）」）。
- **客户端**：侧栏「主会话」入口（始终可见）+ 会话头「任务」面板（仅主会话可见）；只读快照 + 面板动作。

## 主会话

解析顺序：

1. `config.coordinatorSession`（显式覆盖，不写台账）
2. 台账 `settings.main_session_id`
3. 未打开：`task_*` 返回「尚未打开主会话」

`open-main` 会确保「指挥舱」工作区存在，用协调者预设 `dsh-orchestrator-coordinator` 创建会话，`rename` 成「主会话」，写入 `settings.main_session_id`，然后跳到该会话。

复用判定以台账 `settings.main_session_preset` 为准；UI 空白会话可能被 rebind 成默认预设，插件会在 `agent/created` 和复用前调用 `agentPresets.select` 拉回，失败只记日志并由 guard 兜底。

### 首次打开与工作区索引

- `main-session.js` 仅新建主会话写 `settings.main_onboarding:<id>=pending`，旧主会话/配置覆盖不会因升级补初始化。复用既有 open in-flight 锁；`onboarding.js` 用 settings CAS pending→sending→sent 防并发重复，注入失败退 pending、打开结果给错误，重开可重试。不在 apply 自动唤醒历史主会话。
- index 在成功 open/主会话晚加载后由 onboarding **await guardPreset 恢复成功**再CAS投递，缺选择服务/恢复失败留pending并返回可见错误，不用固定2秒延迟猜就绪；复用 `injectNotification`（agent.steer）启动模型轮次；prompt 要求先能力介绍再走现有 task_create 只读任务，不直接替模型扫描或绕过台账。sent 表示消息已入队，不保证模型已介绍/派发；进程在发送和标记之间崩溃有不确定窗口，不盲自动重投。
- task_create 对「工作区与仓库索引」只读任务捕获 workspaceRegistry.list 的 id/title/path 到 brief，task_detail 提供名单与随包 scripts/workspace-index.mjs。worker 仅扫描登记目录，复用 runGit 的 execFile/timeout，读取 repoRoot/branch/HEAD/origin/commonDir，单项失败继续，不 fetch/pull、不写文件。
- task_report.workspace_index 仅接受该任务本人 done 的完整 JSON，按创建时名单验证覆盖并使用名单真 title/path，remote 再脱敏，以同SAVEPOINT写既有 settings.workspace_repo_index及workspace_index_saved:<taskId>成功标记，不改 memories 或 workspaceRegistry。S1仅索引completed缺本任务成功标记时落failed（task_retry可重试），防止遗漏/非法回报后自然误交付；普通任务与已交付只补消息路径不变。project_context(workspaces:true) 返回全部注册映射与采样索引；指定项目附快照，歧义列候选、不猜路径。
- 不新增工具、索引服务、调度服务或数据库迁移，不改变 worker 默认工具/沙箱；索引数据只作采样事实，读取受限记录 unavailable。重新索引通过正常只读任务派发，失败可见且可 task_retry。

### 原生自动化工具面

- `cordis.patch.yml` 只在 coordinator plugins 挂 `@deepseek-ai/dsh-tool-schedule`，allow 显式保留 `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`；`preset-tools.js` 仍用增量 deny 补集。`index.js` 的 runtime restrict 与 guard 不再拒绝这四工具，其余文件、shell、团队和子会话专属禁止项不变。
- 这四工具由原生包在预设 scope 等待 Schedule 服务后注册，不进入 `createTools`，插件全局工具数仍为 14。default worker 不新增挂载，不新增 host global plane 工具或 schema 包装。
- 缺能力诊断仅针对唯一主会话：打开/非 running 创建/idle/下一轮 policy 渲染检查 `tools.get(name, agent)` 的可见定义与 `ctx.schedule` 服务。缺失状态去重 warning + policy 提示，边界重新检查可恢复；不等待 Loader preset list、不改运行回合工具表，也不调用真实自动化 API。
- 本次自动编排只支持 `target:this_session`，Host 到期投递消息到唯一主会话，再由模型走 `task_create`。`new/new_once` 创建 ordinary root Session（当前 cwd/composed preset），不是委托 worker，也不是第二协调者；非唯一主 id 被现有 `requireMain` 拒绝，不改变 main_session_id。
- 沿用原生 Host-wide 管理与用户明确授权提示、RRULE、updatedAt/expectedUpdatedAt 冲突保护；审批提示是模型约束，不是新增硬门禁。委托 depth 校验仍由宿主负责，`access:full` 不增加工具或解除 `subagent_session`。
- 使用方法和失败恢复见 [README 原生自动化](../README.md#主会话原生自动化)，契约与宿主验证边界见 [LIMITATIONS](LIMITATIONS.md#原生自动化)。不修改日报、dispatch、ledger、默认沙箱或 UI。

### 入口可见性（U1）

- **任务入口（会话头「任务」按钮）只在主会话显示**：`client/src/gate.js` 的 `createMainViewGate` 判「当前会话是不是主会话」。
  - 当前会话信号：`uiSession.adapter.current.getSnapshot().key`（优先），取不到退 `sessions.list.getSnapshot().byId` 里
    `retainedBy.mainView > 0` 的会话 id（与 ds-bot 的 `shownSession()` 同口径）。
  - 身份判定：POST `/api/orchestrator` 的 `session-role` → `src/host-route.js` 用 `coordinatorStatus().id` 与请求里的 `sessionId`
    走 `src/session-role.js` 的 `isMainSession`；信号与 `task_*` 工具、通知投递同源（台账 `main_session_id`）。
  - 渲染：`conversation.header.leading` 的 inject 暴露 `hooks.mainView`，`HeaderButton` 在 `useMainView` 为 false/缺失时返回 `null`。
  - 降级（fail-closed）：没有当前会话 id、宿主路由不可用、HTTP/JSON 失败、响应不是 `ok:true` 一律隐藏；失败结果不缓存，
    换会话立即重判，另有 5 秒兜底轮询重试。同一会话的明确答案缓存，避免会话列表频繁刷新时刷请求。
- **侧栏「◈ 主会话」跳转入口始终注册/可见**，不参与主会话判定：它是首次创建主会话的引导入口，不能因为「还没有主会话」而消失。
- 面板主体仍然注册为 `main` keyed 槽位（`key:'orchestrator'`）；入口隐藏不等于面板消失，`selectPanel('orchestrator')` 仍可用（供其他入口/排障）。

## 主会话轮换（G1）

主会话是唯一协调者，跑久了上下文与日志只会更大。轮换 = 把旧主会话退役、换一个干净会话继续当协调者；台账、任务、记忆、产物都不搬。**判定与动作严格分离**，且判定只有一个调用点：`main-session.openOnce()`。

### 模块与接线

| 位置 | 职责 |
|---|---|
| `src/main-rotation.js` | 全部轮换逻辑：S1 纯判定 `evaluateRotation`；S2 采集 `collectRotationMetrics` + settings 键读写 + `inspectRotationPending` 只读判定；S3 动作面 `createRotationService`（marker / 时间戳 / 审计 / 旧会话处置 / `recoverPendingRotation`）；S7 检查节流 `rotationCheckWindow`（纯函数）+ 在 `evaluate` 采集之前的那道闸门 |
| `src/config.js` | `loadConfig` 直接 `Object.assign(config, normalizeRotationConfig(raw))`，12 个键的默认值/区间/回落都在 S1 |
| `src/main-session.js` | `openOnce()` 是**唯一**判定点：`rotation.evaluate({ mainSessionId, liveAgent, source:'open' })` → `decision.due === true` 才 `rotateMain()`，否则照旧走复用分支（`decision.skipped === true` 时什么都不用做） |
| `index.js` | 装配 `createRotationService`（平台服务全是**惰性 getter**：`sessionPersistence` / `tokenMeter` / `catalog` / `sessionController.rename` / `workspaceRegistry.archiveSession`）；`apply()` 启动时调一次 `rotation.recoverPending({ pointer })` 补完上次崩溃的轮换；`open-main` 响应里对新 id 跑 `ensureDigestFor` |

判定**不在**启动、`agent/created`、面板轮询里跑，也没有定时器；settings 里不存任何判定结论，`snapshot` 不下发「建议轮换」（S4 曾接过这三处，已按「判定收敛到打开那一次」回退）。

### 判定

`evaluateRotation(input)` 是纯函数（不读库、不读盘、不看时钟，`now` 由调用方给），输入 = 台账快照 + 配置 + 时间：

- 判定只在旧主会话 **live** 时做：`openOnce` 里 `live === undefined` 走既有「隐式重建」路径，不做判定，`agent/created` 也不补判——所以重启后第一次打开是重建，不是轮换。

- **触发因子（M1→M6，顺序固定）**：`tasks`（自 since 新增子任务）→ `sessions`（新增子会话，按 `header.cwd` 过滤指挥舱）→ `main-log`（主会话日志 MiB）→ `context-tokens`（live 会话的 `tokenMeter.measure().totalTokens`）→ `age`（`since` 起算小时）→ `disk`（指挥舱全部会话日志合计 MiB）。任一 `value >= threshold` 进 `triggers`/`reasons`。
- **保护规则（12 个 code，`ROTATION_BLOCKS` 定优先级，`blockedBy[0]` 即首要原因）**：`mode-off`、`coordinator-override`、`spawn-provider`、`active-tasks`（`waiting_dep`/`pending`/`running`/`waiting_user`/`waiting_auth`）、`delivered-pending`、`delivered-artifacts`、`agent-running`、`recent-activity`（`logMtimeAt` 距今 < `rotateIdleMinutes`）、`active-children`（catalog 里 `activity==='active'`）、`min-age`、`cooldown`（距 `main_rotation_at` < `rotateCooldownHours`；从未轮换视为满足）、`metrics-degraded`（**六项全缺**才 fail-closed，缺一两项只记 `degraded`）。
- **结论**：`due = mode==='auto' && triggers.length>0 && blockedBy.length===0`；龄/冷却/闲置一律由时间戳现算，不信任调用方传小时数。

采集（S2）只读：一次 `persistence.listSnapshots()` 供 M2/M6 共用，`locate`+`stat` 拿 M3 体积与 mtime（顺带给 P4）；每项独立 `try/catch`，失败记 `degraded` 并给 `null`（**未知 ≠ 0**，0 会被当成「很干净」而漏判）。`since` 先读 `settings.main_session_created_at`，退 `header.createdAt`，都拿不到时 M1/M2/M5 一起降级。判定整体异常 → `evaluate` 返回 `null`（调用方视为「本次不换」，打开主会话照常）。

### 检查节流（S7：`rotateCheckIntervalHours` / `main_rotation_checked_at`）

采集要读台账 + `listSnapshots()` + 逐个 `stat` 会话日志，随手一开主会话就查一次很浪费。所以 `createRotationService.evaluate` 的顺序是：

1. 配置覆盖 `coordinatorSession` / 没有主会话 id → 直接 `null`（连检查都不做）；
2. **检查节流闸门**：读 `settings.main_rotation_checked_at`，交给纯函数 `rotationCheckWindow({ now, lastCheckedAt, intervalHours })`；
   - `shouldCheck === false`（距上次检查 < `rotateCheckIntervalHours`）→ 返回 `{ due:false, skipped:true, skipReason:'check-interval', check:{…} }`，
     **不采集、不读台账、不判定、不碰平台服务**，只写一条 `main.rotation.check.skipped` 日志；
   - 没有记录（首次 / 升级后第一次打开）或到点（`elapsed >= 间隔`，`>=` 口径）→ 继续；
   - 记录时间在未来（时钟回拨）→ 不信任，按「该检查」处理，检查完用当前时间覆盖，避免把检查冻结到时钟追上来；
3. 采集 + 判定，**结论为「不需要换」时**才写 `main_rotation_checked_at = now`（写失败只记 `main.rotation.check.record-failed`，不影响本次判定）；
   `due === true` **不写**——动作（create / 切指针）还在后面，失败或崩溃后下一次打开要能重试，不能被自己刚记的时间戳挡一个间隔；
   检查整体异常（`evaluate` 落 `catch`）同样**不写**时间戳 → 下次打开重试。

口径边界（三个时间参数各管一件事，别混）：
- `rotateCheckIntervalHours`（默认 24，1–168）——**查不查**：这次打开要不要花开销做检查；
- `rotateCooldownHours`（默认 48）——**换不换**：距上次轮换不足冷却就挡 `cooldown`，但检查照做；
- `rotateMinAgeHours`（默认 12）——**换不换**：主会话跑得不够久就挡 `min-age`，同样不拦检查。

`skipped` 的返回**不是判定结论**（`triggers`/`blockedBy` 都是空），所以它也不会把上一次的 blocks 重算一遍；要看「为什么没换」得看真正检查那次的 `main.rotation.decided`。轮换动作之后的下一次打开会再检查一次（因为 `due` 那次没记时间戳），那之后才按间隔节流——这是「失败/崩溃能重试」的代价，换来节流不会被一次没做完的检查消费。

### 动作时序（顺序即回退边界，改顺序前先读 `src/main-rotation.js` 顶部注释）

1. `ensureWorkspace()`（指挥舱工作区）+ `sessionController.create({ workspaceId, agentPreset: 协调者预设 })`。**失败 = 零处置**（F2）：不写 marker、不动指针、不碰旧会话，`open()` 返回可读错误。
2. `beginRotationMarker` 写 `main_rotation_pending = {newId, oldId, at, reasons}`：**先 marker、后切指针**，它是崩溃后区分「空白残留」与「指针已切、只差处置」的唯一锚点。写不进只记 `main.rotation.marker.failed`，不放弃这次轮换。
3. `setMainSessionId(newId)` 切指针（单条 UPSERT）。失败 = 轮换没发生（F3）：`discard` 尽力归档空白新会话 + 清 marker，返回「轮换失败，旧主会话仍可用」。**指针切换后不再回滚**——回滚等于把人踢回旧会话又换了一次主会话。
4. `setMainSessionPreset` + `markRotationTimes` 写 `main_session_created_at` / `main_rotation_at`；失败只记 `main.rotation.commit.failed`（少了防抖时间戳，轮换已成立）。
5. `settings.main_onboarding:<newId> = 'sent'`：跳过首次介绍与「工作区与仓库索引」任务，避免每次轮换多派一个重复索引任务。
6. `sessionController.rename(newId, '主会话')`；失败只记日志。
7. `disposeOldMainSession`：先 `rename(oldId, '主会话（已退役 YYYY-MM-DD HH:MM）')`，再 `archive(oldId)`（`rotateArchiveOld:false` 时 `archiveOld=undefined`，只改名）。两步各自降级：rename 失败不影响归档，archive 失败只留「旧会话还在列表里」，轮换仍成立。
8. `recordRotation` 写审计 `main_rotation_last`（`old/new/at/triggers/reasons/metrics/renamed/archived/recovered`）并清 marker；写失败则 marker 留着，下次启动幂等补完（rename 是覆盖标题、archive 幂等）。
9. 记 `freshMain = {sessionId, at}`：新会话还没 live 的 **60 秒窗口**内再点「打开主会话」直接交回同一个 id，不给「不 live 就新建」留双建。

并发：`open()` 的 in-flight Promise 复用保证多个入口只建一次；`evaluate` 本身只读。**判定与动作之间不复查**（保护规则挡的是判定时刻的状态）。

### 崩溃恢复（`recoverPendingRotation`，`apply()` 启动时跑一次，永不抛）

| marker 状态 | 条件 | 处理 |
|---|---|---|
| `none` / `unknown` | 没有 marker / 启动早期还没有指针 | 无事可做 |
| `invalid` | `newId` 不是非空字符串 | 只告警 + 清 marker，**绝不猜 id 去归档**（不可逆） |
| `abandoned` | `marker.newId !== 指针` | 死在切指针之前：旧指针一直有效，新会话是空白残留 → 尽力归档 + 清 marker，不回滚指针 |
| `complete` | `marker.newId === 指针` | 指针已切：补缺失的时间戳（按 `marker.at`）、补 `onboarding=sent`、对旧会话补「改名 + 归档」、写审计 `recovered:true`、清 marker（幂等） |

### settings 键（只存事实，不存结论）

| 键 | 语义 |
|---|---|
| `main_session_created_at` | 当前主会话起点（M1/M2/M5 的 `since`） |
| `main_rotation_at` | 上次轮换时刻（冷却期起点；从未轮换 = 无键） |
| `main_rotation_last` | 审计记录（事后排查唯一入口：换了谁、为什么、改名/归档成没成、是否恢复补完） |
| `main_rotation_pending` | 崩溃锚点（转瞬即逝，收尾清掉） |
| `main_rotation_checked_at` | 上次真正做过「采集 + 判定」的时刻（S7 检查节流；不是判定结论，也不代表轮换过） |

五个键统一走 `readRotationState` / `writeRotationState`（`null` 删键、对象存 JSON、`undefined` 不动）。

### 日志（`logs/YYYY-MM-DD.jsonl`）

- `main.rotation.decided`：每次**真正检查**都写（`source`、`due`、`triggers`、`blockedBy`、`degraded`、指标、`since`/`sinceSource`/`scanned`、`checkedAt`、`checkRecorded`）——复盘「为什么换 / 为什么没换」，以及这次检查有没有消费节流。
- `main.rotation.check.skipped`：检查节流跳过（`intervalHours`、`checkedAt`、`nextCheckAt`、`elapsedHours`）——复盘「这次打开为什么没查」；跳过不写 `decided`。
- `main.session.rotated`：轮换成功（old/new/triggers/renamed/archived/marker/audit）。
- 失败/降级：`main.rotation.failed`、`check.record-failed`（节流时间戳写不进，只降级）、`pointer-failed`、`commit.failed`、`onboarding.failed`、`audit.failed`、`marker.failed`、`marker.clear.failed`、`rename.ok|failed`、`archive`、`discard`、`metrics.degraded`、`recovered-complete|abandoned|invalid|failed`。

冒烟（临时台账 + 桩平台动作，不碰真实主会话）：13 项矩阵覆盖 not-due 零副作用、open-main 命中路径、create 失败零处置、
指针写失败、只退役不归档、60s 窗口、崩溃恢复 complete/abandoned、配置归一化与纯判定契约；S7 检查节流的跳过/首检/到点/
越界夹取/与冷却叠加在 `test/main-rotation.test.js` 的 S7 用例组与 `test/main-session.test.js` 的「检查节流」用例里；
探针脚本是一次性验证件，不入库。

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
- `priority` 为 `-10..10`，只影响队列顺序。
- **同写域并发防护**（`src/write-guard.js`，默认拒绝）：`task_create` 在「去重 / 容量 / worktree 决定」之后、`createTask` 之前的**同一个同步段**里判定——
  新任务 target 与活跃未隔离任务的 target 相同或互相包含，或两者 `writeScopes` 重叠 → 按 `config.sameDirGuard` 处理：
  `require`（默认）拒绝并返回可操作错误、`warn` 只给强警告、`off` 关闭（`writeScopes` 退回一行 advisory）。
  不参与判定：`readOnly` 任务（不写文件）、`requested`/`created`/`reused` 隔离任务（各自检出；`requested` 是派发时建检出的待建状态，`target_dir` 还没换算但任务注定在检出里跑）、`dependsOn` 链上祖先（等它们 `done` 才派发）、终态任务。
  例外是 `degraded`（目标不是 git 仓库而降级）：它仍在原工作树里写，必须继续占目录。
  `delivered` 算活跃（还占目录）；唯一显式放行开关是 `task_create.allowConcurrent:true`，放行时返回带「并发风险」并记 `task.create.concurrent-write`。
  拒绝对应 `task.create.rejected`（`reason: same-dir | write-scope`）。

## 回报、通知、收件箱、日报

`task_report` 四档：

| status | 通知级别 | 说明 |
|---|---|---|
| progress | silent | 只更新台账；连续达到 `stallRounds` 才推一次 `stalled` |
| done | notify | 落「已交付待确认」（`delivered`）；5 秒合并窗口后注入协调者，带确认/追问动作指令 |
| blocked | interrupt | 立即投递，可带 `question` / `options` |
| needs_auth | interrupt | 立即投递，可带 `question` / `options` |

## 两段式终态（D1：交付 → 确认）

`done` 是不可逆终态，但「子会话说做完了」不等于「用户验收过」。为既保留 `done` 的审计语义、又给追问留窗口，状态机在 `running` 与 `done` 之间加了 `delivered`（已交付待确认）：

- **进入**：`task_report done`，或结算 `completed` 且没上报过 progress（`SETTLE_MAP`）。
- **出口 1 · 确认**：协调者 `task_close`（或面板「确认交付」）→ `done`，`close_reason=coordinator`；超过 `deliveredTimeoutMinutes`（默认 60）由 sweeper 自动收成 `done`，`close_reason=timeout`。
- **出口 2 · 追问**：`task_message` 投递成功 → `running`，复用同一个子会话（**可写根不释放**），完成后再次交付。
- **出口 3 · 停止/丢失**：`task_stop` → `cancelled`；追问时子会话不可达 → `orphaned`。
- 归属：`delivered` 是活跃状态（`listTasks(active)`、面板门控、`inboxCount` 都算），但不是终态；`TERMINAL_STATUSES` 不变。
- 依赖就绪仍只认 `done`（`deps.js`）：交付不等于确认，下游要等确认/超时；正常情况协调者收到通知几秒内就确认。
- goal 不收口：`delivered` 期间 `goal_state` 保持 active+disarmed，追问时 `edit` 正常；只有 `done` 才 `complete`。
- 对账：`delivered` 不参与 S2 的 liveness/catalog 检查（成果已落库，等确认即可），超时 sweeper 兜底，重启不会卡死。
- 审计：`tasks.delivered_at` 记录本次交付时间（追问后再交付会重写，超时从新时间起算），`tasks.close_reason` 记录关闭原因；`messages` 里 `kind='close'` 一行写「协调者确认 / 超时自动完成」。
- 关闭三条路径（工具 / 面板 / 超时）共用 `src/delivered.js` 的 `closeDelivered`，副作用顺序固定：迁移 + 审计消息 → 释放可写根 → goal 收口 → 按档位清检出 → 唤醒队列。
- 通知去重：进入 `delivered` 发一条（带 `task_close`/`task_message` 指令），确认/超时**不再发**通知，只在台账写审计消息。

## 结算闭环（S1）

子会话不一定都会回报：模型可能忘了 `task_report`，也可能被打断或起不来。`src/settlement.js` 消费平台的**结算**信号，把 `running` 推到终态（自然结束先落 `delivered`），用户不再看到「永远在跑」的幽灵任务：

| 事件源 | 覆盖 |
|---|---|
| `dispatch.js` 的 `subagent.settled` / `subagent.failed` | 本次派发的那一次 activation |
| 平台 `subagent/end`（`local === true`） | 含 `task_message` / 冷恢复起的新 activation（派发侧的 `result` 只覆盖第一次） |

映射（`SETTLE_MAP` / `mapSettle`）：

| stopReason | 台账 | 死因 / 通知 |
|---|---|---|
| `completed` 且没上报过 progress | `delivered` | 无死因；自动交付还会补一次产物收集，等 `task_close`/超时收成 `done` |
| `completed` 但上报过 progress | `orphaned` | 回合结束却没报终态（可重派） |
| `aborted` | `cancelled` | 被子会话中断（`dispose` / interrupt / 父级取消） |
| `error` / `max-tokens` / `refusal` | `failed` | 异常结束 / 输出截断 / 被策略拒绝 |
| 缺失或未知 | `orphaned` | 结算原因未知，按会话丢失处理 |

- 只改 `running` 的状态：`waiting_user` / `waiting_auth`（子任务自己报了 blocked/needs_auth）与已有终态都不改，重复结算天然幂等。
- **例外：`delivered` / `done` 上要补写最后一条消息**。`task_report done` 会先把任务推到 `delivered`，本回合结束时到达的结算已经不在 `running`；旧实现直接 `skipped`，导致 `tasks.last_message_json` 永远为空（真实台账 104/104 done 全缺）。现在这两个状态走「只补消息」分支：落消息、不改状态、不发通知、不写 settle 行、不释放。
- 只有真终态（`done`/`cancelled`/`failed`/`orphaned`）才释放可写根、收敛 goal、写 `settle` 消息；`delivered` 保留会话给追问用。
- 每次结算写一条 `settle` 消息 + `tasks.error` 死因 + 一条 `system` 通知（`cancelled`/`orphaned` 也走合并窗口），并唤醒队列补位。
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
- **时序（B1 修复）**：`task_report done` 在回合中途把任务推到 `delivered`，本回合真正结束（`turn/end` 之后 13–46ms）才到结算事件。旧实现用「只认 `running`」把这条事件整条丢弃，`last_message` 永远为空（真实台账 104 条 done 全缺、唯一一条是 aborted 中途中断）。现在 `delivered`/`done` 上走「只补消息」分支：落消息但不改状态、不发通知、不写 `settle` 行、不释放可写根；更晚 activation 的正文可以覆盖旧的（它才是「最后一段话」）。
- 幂等：`setTaskLastMessage` 按正文 `digest` 兜一层——同一段正文重复落库不重写行、不动 `updated_at`，文件按任务编号覆盖，不会堆一堆副本；`delivered`/`done` 的补写也只靠这一层去重。
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

- 只看 `running`：`waiting_user` / `waiting_auth` 是故意停下的、`delivered` 已交付待确认，终态不在范围；
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
- **默认关闭**：`config.keepAlive !== true` 时监听器在查台账之前返回（连 `db` 都不用），默认路径零开销。

## brief 纯指引（T1）

派发给子会话的 brief 只回答「你是谁、去哪读详情」，创建详情全部留在台账、由子会话用 `task_detail` 现取：

- **brief 形态**：`renderBrief({ taskId, access, worktreeState })` 输出四行（完整访问任务多一行【访问级别】，隔离任务多一行【worktree 依赖】）——
  `【任务编号】t-xxxxxxxx` + `【任务详情】先调 task_detail（参数 task_id 填上面的任务编号）读取完整任务详情：…`
  + `【执行中待确认】…` + `【确认方式】…`。
  目标、验收、约束、背景、用户原话、工作目录/权限、经验/前置任务/产物都不再内联；也不再有「`get_goal` 不可用」的兜底文本。
- **三段常驻提示**（都不越权改交付口径，措辞只讲「怎么做」；都明确「不等于已获授权」，不给绕过推送前双审查的口子）：
  - `BLOCKED_HINT`（【执行中待确认】，**所有任务都有**）：执行中遇到需要用户拍板的决策点（业务取舍、范围变更、不可逆操作、方案歧义等）
    用 `task_report blocked` 上报「问题 + 选项建议」，协调者用 `ask_user_question` 问用户、拿到答复后 `task_message` 续派；
    明确三种不许（不自行假设用户意图、不阻塞等待、不等不到回复就跳过）。它排在【确认方式】之前——
    这条是**执行期**就要用的，不能只出现在交付环节。
  - `CONFIRM_HINT`（【确认方式】，所有任务都有）：**交付时**不要只在正文里问——把待确认要点写进 `summary`。
    **不能**让子会话去调 `ask_user_question`——平台的 `assertLiveRoot` 对 `session.header.origin === 'subagent'`
    直接抛 `DELEGATED_CALLER`（human interaction is unavailable while the calling agent is owned by another live agent），
    子会话是 `subagents.startActivation({ parent })` 起的 subagent，必然撞墙。
    注意 `done` 会清掉 `question`/`options`（`task_report` 里 `progress`/`done` 都走 `clearTaskQuestion`），
    所以交付阶段的要点只能走 `summary`；要结构化选项就得在执行中走 `blocked`/`needs_auth`（提示三）。
    问用户始终由协调者带同一批选项做；待确认/关闭语义仍只在 `task_detail` 与协调者 policy 里定义。
  - `WORKTREE_INSTALL_HINT`（【worktree 依赖】，只有隔离任务有）：检出目录没有 `node_modules`/虚拟环境，可以执行安装命令
    （`pnpm install` / `npm install` / `uv sync` 等），**只安装不升级**（不改依赖声明与版本）。
    触发条件是台账 `worktree_state ∈ ISOLATED_WORKTREE_STATES`（`requested` / `created` / `reused`，与同写域防护共用同一份列表）；
    `none` / `degraded`（不是 git 仓库，仍在原工作树里跑）不给——那里依赖齐全，加了只是噪音。
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

### 协调者读工作区产物（`read_workspace`）

子会话产物落在**主会话工作区**（`$DSH_HOME/state/orchestrator/workspace`，如 `reports/`、`diag/`），协调者要看正文不必再派子任务。

- **为什么不开放原生 `read`/`glob`**：平台读路径没有白名单——`dsh-fs-sandbox` 只给写操作加栅栏（`Reads pass through untouched: every mode permits reading.`），
  `dsh-fs-local` 的 `cwd` 只是相对路径基准（`a resolution default, NOT a containment boundary`），`glob` 直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。
  给协调者开原生 `read` = 给它全盘可读的宿主进程读者（含 `~/.dsh/.credentials.yaml`），叠加 IM 双向同步还会外发。所以自建一条只读工作区的入口。
- **实现分层**：`src/read-workspace.js` 是纯函数 + 一次有界读（路径判定、行窗口切分、目录列条目、二进制识别、文案渲染）；
  `src/tools.js` 的 `read_workspace` 只做 `requireMain` 身份校验、调用、审计日志（`workspace.read` / `workspace.read.rejected`）。
- **三道闸**（`resolveWorkspaceTarget`）：① 形状（空 / NUL / `~` 拒绝，不做家目录展开）；② `realpathSync` 真实路径包含性（挡符号链接逃逸，含中间目录是链接；同时吃掉工作区根自身在符号链接下的差异，如 macOS `/var` → `/private/var`）；
  ③ 真实路径解析失败时退回词法包含性，把「越界」与「不存在」分开报，不把安全边界说成普通错误。
- **体积与截断**：单文件 > 4 MB 直接拒绝（不整块读入，提示让子会话写摘要）；正文按行窗口返回（默认 400 行 / 上限 2000 行，单次 ≤ 64 K 字符），
  截断给 `nextOffset` 续读；单行本身超上限时截断该行并标 `truncatedLine`，`nextOffset` 仍指向**下一行**（截断的是这一行，不是读不下去；返回 null 会被误读成文件到头）。目录只列一层、最多 200 项，指向工作区外或断链的符号链接条目标 `readable:false`。
- **不用于校验存在性**：存在性仍由插件与子任务保证，`present` 只列真实文件；`read_workspace` 是「看内容」的入口，不是 stat 替身。

## 只读子任务

`readOnly:true`（只认显式 true）会在 `agent/created` 一到就给子会话 append `sandbox/mode {mode:'read-only'}`，激活后再幂等补一次；续派/重启会再补。只读任务不注册 target 可写根。`backend:'team'` 没有会话级只读通道，会返回可读错误。

## per-task 完整访问（`access:'full'`）

`access:'full'`（只认显式 `'full'`）**复用只读的整条注入路径**，只是模式换成 `danger-full-access`：
`ensureSandboxMode(childId, mode)` 在 `agent/created` 一到就 append `sandbox/mode {mode, source:'delegation'}`
（`source` 与平台把父会话覆盖种进子会话时的事件形状一致），激活返回后再幂等补一次，续派/冷恢复再补；
`taskOf` 只把 `tasks.access='full'` 当真，其它值一律按默认（NULL = 沿用会话策略）。
不传 → 一次 append 都没有、不碰默认配置、不碰父会话，也不注册/撤销任何额外授权；完整访问任务照旧登记
target 可写根（`danger-full-access` 下用不上，只当注入失败时的兜底）。`readOnly`/`planFirst` 优先且创建期互斥；
`backend:'team'` 没有会话级沙箱写入口，返回可读错误。视图：brief `【访问级别】完整`、`task_detail`
「访问级别：完整」、`task_list`「·完整访问」、`task_status`「访问级别：完整」、通知标题「（完整访问）」、
日志 `subagent.full-access` + `task.create.created.detail.access`。

## 计划阶段（P8）

`planFirst:true` 的任务 = **只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）**。不开 `planFirst` 的任务行为一字不改。

- **进入**：`queue.pump` 从台账 `task.plan_first` 透传给 `dispatcher.spawn`；派发时复用 `ensureReadOnly`
  （`agent/created` 一到先设、激活后幂等补，压首回合窗口），再用 **子 agent 作用域**的
  `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode。`planMode` 服务缺失/拿不到只 warn，
  降级为「只有只读沙箱」，派发不受影响。计划任务在批准前**不注册 target 可写根**。
- **计划落盘（`plan_save`）**：计划阶段是只读沙箱，子会话没有任何写文件的手段，长计划也塞不进
  `task_report.question`（上限 500 字）。所以计划文档由**插件在宿主进程**写（不受子会话沙箱限制）：
  `src/plan-doc.js` 只做纯函数——`planDocPath()` 把 `<主会话工作区>/reports/plans/<taskId>.md` 算出来
  （没有 `path` 入参；编号形状白名单 `^t-[0-9a-z]{4,32}$` + `relative()` 包含性校验，两道闸把
  `..`/绝对路径/盘符/跨目录拒在 `mkdir`/`writeFile` 之前），`renderPlanDocument()` 加文档头
  （任务名/编号/目标/落盘时间），`writePlanDocument()` 只做一次 mkdir + 覆盖写。
  写完走 `setTaskArtifacts` 登记为任务产物（通知、`task_status`、面板抽屉都从台账产物读，不另开视图）；
  越权（非本任务子会话）、非计划任务、空正文、超 `MAX_PLAN_CHARS` 都在 `src/tools.js` 拒绝并给可读原因。
  子会话拿到结果后只上报**3–8 行摘要 + 文档绝对路径 + 待拍板清单**。
- **出口**：子会话只读探索后先 `plan_save` 落盘计划，再用 `task_report blocked` 上报摘要 + 路径，走既有的
  blocked → 通知 → 用户 → `task_message` 续派闭环，**不用** `exit_plan_mode`（子会话没有直接人类，
  批准请求会悬空）。插件在子会话 **agent 作用域** `agent.ctx.tools.guard` 拒绝 `exit_plan_mode`：
  插件根的 `ctx.tools.guard` 是全局的，会误伤协调者，所以不能注册在那里。
- **退出（批准）**：协调者 `task_message` 或面板「追加」投递成功、任务从 `waiting_user`/`waiting_auth`
  回到 `running` 之后，`session.append('sandbox/mode', {mode:'workspace-write'})` +
  `planMode.set(agent, false)` + 台账 `plan_state='approved'`；同时补登记 target 可写根
  （rc.3 子会话 `header.cwd` 是父会话目录）。投递失败路径不碰 plan 状态（任务仍等你决定）。
- **停止/终态**：`task_stop` 与结算/对账进终态时释放 guard；还在 `planning` 就结束的 `plan_state` 收口成
  `rejected`，已 `approved` 的保留（历史里能看出批准过）。
- **台账视图**：`plan_first`（0/1）+ `plan_state`（`none` / `planning` / `approved` / `rejected`）。
  运行期真相在平台会话日志的 `plan/mode` 事件（重启/压缩由平台投影恢复），台账只是编排视图；
  两者以续派/终态事件对齐，面板显示台账视图。
- **面板/工具视图**：`snapshot` / `detail` 下发 `planFirst` / `planState`；任务卡「计划中」小标 +
  「计划·…」chip、抽屉概览「计划」行；`task_list` 给「·计划中」标记，`task_status` 给「计划：」行。
  非计划任务不下发任何计划字样。
- **互斥**：`planFirst` 与 `readOnly` 在 `task_create` 创建期拒绝（只读任务永远不切回可写）。

## worktree 隔离（P9）

`task_create({ worktree: true })` 时插件在**宿主进程**建检出，子会话在检出目录里干活；不开 `worktree` 的任务行为一字不改（**一次 git 都不调**）。

- **声明只有结构化两处**（v2，零自然语言解析）：profile 配置 `worktreePolicy` / `worktreeBranchPrefix` /
  `worktreeRecentDays`（用户级默认，渲染进协调者 policy），以及 `task_create.worktree*` 字段（任务级决定）。
  插件**不读** `AGENTS.md`、**不解析**自然语言、**不缓存**指令文件：「要不要隔离」由协调者判断
  （DSH 的 `dsh-agent-instructions` 负责把用户级/工作区级指引注入它的上下文）。
- **模块**：`src/worktree.js` = 宿主侧 git 能力（`probeRepo` / `create` / `remove` / `ensureExcluded` / 分支名校验 /
  `prepareTaskWorktree` / `cleanupTaskWorktree` / `retryWorktreeOf`）；`src/worktree-request.js` = 结构化请求校验 +
  机械映射（`parseWorktreeRequest` / `decideWorktreeIntent` / `decideWorktreeFacts`）与全部展示文案（纯函数）。
- **创建期（`task_create`）**：先做互斥校验（`readOnly` / `planFirst`）与复用查找（`worktreeMode:'continue'` 按同
  `group` / `dependsOn` 找台账里已建好的检出）；真要建时才 `probeRepo`（普通任务零 git 调用）→ 非仓库 `degrade`；
  基线：显式 `worktreeBase` 要 `rev-parse --verify` 通过、缺省时 n=0 用默认分支 / n=1 用那条 / **n≥2 返回
  `needsBranchChoice` 且不落库**（协调者去 `ask_user_question`，拿到答案带 `worktreeBase` 重调）。落库七列
  （`worktree_path` / `_branch` / `repo_root` / `_base` / `_mode` / `_source` / `_state`），`state='requested'`。
- **派发期（`queue.pump` → `prepareTaskWorktree`）**：`git worktree add -b <branch> <repo>/.agents/worktrees/<taskId> <base>`
  ——**永远 -b 新分支**（直接检出已在主工作树检出的基线会被 git 拒绝）；`reused` 不调 git，只换算路径。
  `target_dir` 换成「检出目录 + 原 target 相对 repoRoot 的偏移」→ 子会话的 target 可写根天然覆盖（既有
  `ensureWritableRoot` 机制）；检出目录必须在仓库内，否则 `.git/worktrees` 的写入不成立。
  建树失败标 `failed` 并写原因（**不静默降级**），非仓库才 `degraded`。
- **`.git/info/exclude`**：建树成功后把 `.agents/` 追加到 `.git/info/exclude`（幂等；不动用户被跟踪的 `.gitignore`；
  不可写只 warn）。
- **清理三档**：`worktreeCleanup` 默认 `off`（全部保留）；`checkout-only` 只 `worktree remove`；`full` 连分支一起删
  （有未合并提交时保留分支并提示）。清理在终态（结算 / `task_stop` / 面板 stop）异步跑，失败只记日志、不改终态。
- **重派**：`task_retry` / 面板重派在有检出且目录还在时复用（`state='reused'`），被清理过按原基线重建。
- **产物语义**：产物在检出目录里，**用户工作树没有这些改动**；通知 / `task_status` / 面板 / README 四处标注
  「分支 X / 检出 Y / 合并由你决定」。平台没有合并工具，插件也不提供。
- **视图**：`snapshot` / `detail` 下发 `worktreeState/Branch/Path/Base/Source`；任务卡「隔离」小标 + 「隔离·…」chip、
  抽屉概览「隔离」行；`task_list`「·隔离」、`task_status`「隔离：」行（含决定者 task/config/default）。

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
| `message` | 追加消息（仅可续派状态，见 `src/panel-gates.js`；**面板已无「追加」按钮**，只有协调者 `task_message` 在走） |
| `delete` | 删除终态任务（台账级联清 messages/notifications） |

面板 2s 轮询，连续失败退避 30s；任务卡「详情/停止/重派/删除/打开子会话」，「删除」只在终态显示（`canDelete` 由服务端判定并随 snapshot/detail 下发，见下节）；「产物」筛选打开产物库（按项目/日期分组，预览/复制/打开子会话/详情）。

> 面板不再有「追加」按钮：旧实现点击后走 `window.prompt`，而 Electron 渲染进程把 `window.prompt` 换成抛错桩
> （`prompt() is not supported.`），从来没有真正发出过请求。`canFollowup` 仍随快照下发（服务端门控不变），只是
> 前端不再渲染这个入口；续派与计划批准统一由协调者 `task_message` 完成。

## 面板与详情（UI U2）

面板是 `ctx.slots.register({ name:'main', key:'orchestrator' })` 的整块组件，视觉规范见 [UI.md](UI.md)。四件事值得记在架构里：

- **构建链与产物路径（P7，T7.2 已切生效入口）**：客户端源码在 `client/src/**`（ESM），由 `vite.client.config.mjs`
  构建成 `dist/client.js`（iife classic script，配 `dist/client.js.map`），**产物入库**。平台 `clientExportOf()` 读
  `package.json` 的 `exports["./client"]`，把那个文件**原样** serve 成 `/plugins/<id>/client.js`；路由只服务
  这一个 JS（+ 同名 `.map`），`.css` 一律 404 → 样式必须 `?inline` 回 JS。当前 `exports["./client"]` 已指向
  **`./dist/client.js`**（`files` 含 `dist/`），根目录不再有手写 `client.js`；改 UI = 改 `client/src/` + `pnpm run build`
  （`pnpm test` 经 `pretest` 自动构建）。源码分模块：`index.js`（只注册 factory）→ `client.js`（装配 + `apply` +
  `__test`）→ `views.js`（面板/抽屉/启动器）→ `ui.js`（展示件）、`styles.css`（样式表）、`logic.js`（纯函数）、
  `api.js`（宿主 HTTP 契约）、`gate.js`（任务入口闸门）、`constants.js`（文案/常量）。
- **样式表怎么进来的**：产物是 classic script（不能 `import` CSS），所以 `styles.css` 在构建期被 `?inline`
  内联成 `STYLE_TEXT` 字符串，`ensureStyles()` 在 `apply()` 里按 `#dsh-orchestrator-styles` 去重注入 `<style>`。颜色/圆角/阴影/动效
  全部取宿主 `@deepseek-ai/dsh-client-ui-theme` 的 `--dsw-*` / `--ds-*` token，深浅色由宿主写在
  `body[data-ds-dark-theme]` 的 alias token 决定，面板不做任何主题判断。
- **三段式**：① 顶部命令栏（标题/主会话状态/搜索/刷新/打开主会话）② 中部工作区（筛选轨 + 任务卡列表 / 产物库）
  ③ 右侧详情抽屉。抽屉常驻挂载、`data-open` 驱动 `transform` 过渡；`Esc`/遮罩/关闭按钮都能收起。
  列表侧把纯逻辑提到组件外（`countTasks` / `matchesFilter` / `matchesQuery` / `groupArtifacts`），单测直接断言行为。
- **详情抽屉 7 区块**：概览、**最新回复**（B1，`detail.task.lastMessage`）、**brief**（验收/约束/背景/用户原话，
  结构化列表）、**目标状态**（G1，只读）、**消息**（最近 20 条；`followup` 标待发/已投递/投递失败）、
  **依赖**（上游前置 + 下游依赖本任务，各带状态与错误）、**产物**（路径/标签/存在性，路径可一键复制）。
  每个区块都可折叠（`aria-expanded` + `0fr↔1fr` 过渡），都有空态。底部动作条：停止（内联二次确认）/重派/打开子会话/删除（仅终态，内联二次确认）。
  投递状态落在 `messages.meta_json.delivery`（pending → delivered/failed，只改 meta 不加行）；A3 之前的旧消息按紧随其后的 `delivery_failed` 行推断。
- **按钮可见性与动作门控同源**：`src/panel-gates.js` 是唯一判定（`followupGate` / `deleteGate`）。
  服务端面板动作与 `task_message` 工具都先过它；`snapshot`/`detail` 再把 `canFollowup` / `canDelete`
  下发给客户端，`client/src/views.js` 只读这两个布尔值渲染按钮（`canFollowup` 目前没有消费方），不另抄一份状态表——避免「按钮在、点了 409」或反过来的分叉。
  续派 = `running` / `waiting_user` / `waiting_auth` 且已有子会话；删除 = `done` / `failed` / `cancelled` / `orphaned`
  且没有活跃下游依赖。删除只清台账行（任务 + messages + notifications），不删产物文件与 memories（见 LIMITATIONS）。

### 产物预览复用宿主右侧栏（U2.1）

产物预览不自建视图：`client/src/client.js` 的 `openArtifactPreview(path)` 把面板里的点击转成宿主右侧栏的一次
`ctx.sidebarRight.openResource(address)` 调用，Tab 类型由宿主的 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
（`kind:'text'`）认领，Markdown / 代码 / 图片 / PDF / Office 都有渲染器。

- **地址**：`client/src/logic.js` 的 `fileAddressOf(sessionId, path)` 拼
  `dsh-resource://file/session/<encodeURIComponent(sessionId)>/<逐段编码 path>`，与
  `@deepseek-ai/dsh-util-workspace-path` 的 `sessionFileAddress` 逐条对齐（`:` 保持字面以兼容盘符）。
  预览类型只认领 `session` 作用域（`absolute` 不会被认领），所以地址必须带会话 id。
- **必须先切回会话**：右侧栏按 Session 挂载；任务面板占主栏时 `ctx.sidebarRight.mounted` 是 `undefined`，
  直接 `openResource` 会抛 `sidebarRight: no session surface is mounted`。因此顺序固定为
  `ctx.layout.selectPanel(null)` → `openResource`。
- **探测前置、失败提示不依赖面板存活**：`openArtifactPreview` 先做完全部可用性探测（侧栏服务是否有
  `openResource`、地址是否拼得出），只有探测全通过才 `selectPanel(null)`；`openResource` 抛错时若刚切过面板就
  `selectPanel(PANEL_ID)` 切回来，再返回 `{ ok:false, reason, message }`。时序不靠轮询 `mounted` 的宏任务轮数
  （早期实现的 4 轮 `setTimeout(0)` 已删）——座位没就绪就让宿主抛错、如实上报，避免静默失败。
- **降级分四档**：`sidebar-missing`（旧 profile 没装侧栏）/ `no-session`（拿不到当前会话 id）/
  `bad-path`（路径为空或编码不出地址）/ `host-refused`（宿主抛错，带原始 message）。`views.js` 的 `previewInSidebar` 按 reason 给出可区分的中文提示；
  产物库行额外回退旧 `preview` 端点 + `previewBlock`（行内预览），任务卡 / 抽屉只提示「到产物页看或复制路径」。
- **产物登记校验不绕开**：服务端 `preview` 端点只读「本任务已登记产物」（`panel-actions.js` 先查
  `task.artifacts` 再读盘）；右侧栏链路是宿主直接读文件、不过这道校验，所以 `views.js` 的
  `isRegisteredArtifact(path)` 在前端做等价校验——只允许快照卡片 / 产物库 / 详情抽屉这三个**服务端下发来源**
  里出现过的路径。
- **`fileAddressOf` 不 trim**：宿主 `sessionFileAddress` 也不 trim；POSIX 允许路径首尾带空格，
  trim 会静默改写调用方的合法路径。
- **不接管宿主几何**：宽度（首次 45% 视口、按 Session 记忆、上限 70%、保底 300px、可拖拽）、折叠、
  多 Tab / 分栏、`<768px` 自动全屏都由宿主 `ui-layout` + `ui-sidebar-right` + dockkit 负责，插件不存任何预览状态。
- **与 present 同源**：聊天交付卡片的预览也走 `ctx.sidebarRight.openResource(fileAddressFor(...))`，
  面板打开的 Tab 与交付卡片落在同一个右侧栏，`reports/` 等绝对路径语义不变。
- 依赖声明：`package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right` 与
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（**只是预取提示**，见下）；客户端的 `inject` 数组**不加**
  `sidebarRight`——它用 `serviceOf('sidebarRight')` 现取，与 `uiSession`/`sessions` 同一口径。写进 `inject` 会让 cordis
  在服务缺失时卡住 `apply`，那就没有「缺侧栏 → 提示 + 产物库行内回退」这条路了。

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
