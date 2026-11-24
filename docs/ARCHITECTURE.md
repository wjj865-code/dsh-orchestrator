# 架构与关键机制

本文是 README 的技术补充，面向维护者。用户使用只需看 README。

## 角色

- **协调者**：唯一主会话，固定入口；只拆任务、派子会话、看回报、交付产物。能**只读**看**单个文件**（`read` 与 `read_workspace`；`glob`/`grep` 已移除，检索类工作派只读任务），但**不写文件、不执行命令**（预设不挂 `write`/`edit`/`bash`/`pwsh`，权限钉 `read-only`）。
- **子任务**：独立 DSH 子会话，直连 `ctx.subagents.startActivation`，不占 Team 名册；另有四个专属插件工具：`task_report`（回报）、`task_detail`（只读创建详情）、`plan_save`（计划落盘）、`artifact_save`（阶段文档）。
- **客户端**：侧栏「主会话」入口（始终可见）+ 会话头「任务」面板（仅主会话可见）；只读快照 + 面板动作。

## 主会话

解析顺序：`config.coordinatorSession`（显式覆盖，不写台账）→ 台账 `settings.main_session_id` → 未打开（`task_*` 返回「尚未打开主会话」）。`open-main` 确保「指挥舱」工作区存在，用协调者预设创建会话、`rename` 成「主会话」、写指针，再跳到该会话。复用判定以台账 `settings.main_session_preset` 为准；UI 空白会话可能被 rebind 成默认预设，插件在 `agent/created` 与复用前调 `agentPresets.select` 拉回，失败只记日志并由 guard 兜底。

**权限（C：徽标 = 实际工具面）**：协调者会话的 `permission preset` 显式钉成宿主出厂预设 `read-only`（沙箱 `read-only` + 审批 `ask`，`src/main-session.js` 的 `MAIN_PERMISSION_PRESET` / `pinPermission`）。0.26.0 起协调者预设挂着**只读**工具（`read`；`glob`/`grep` 已在 t-4f7ce108 随 `tool-fs-search` 行一起移除）与技能加载器（`skill`），但**没有任何写工具**（预设没挂 `write`/`edit`/`bash`/`pwsh`，`tool-fs` 行只开 `read`），所以徽标「Read Only / 仅可查看」与工具面一致；宿主给新会话的默认预设是 `workspace-write`，不钉的话徽标会显示「工作区写入」。写路径只有宿主公开的 `ctx.permissionPresets.set(session,'read-only')`（追加 `permission/preset` + `sandbox/mode` + `approval/policy` 三条事件，`permissions` 投影 = 徽标数据源随之变）。覆盖四条路：open 新建、代建、adopt、复用已有主会话时把用户切走的预设拉回（`main.session.permission-pinned`）。**这不是锁**：宿主没有锁权限选择器的 API，`/permission` 与输入区选择器仍可切（宿主的 `locked` 只针对 agent 预设 `agentPresets.select`），漂移一律在下次观察点拉回。失败只记 `main.session.permission-pin-failed`，不挡打开；宿主没有 `permissionPresets` 服务时整段降级（老宿主/裁剪 profile）。

### 首次打开与工作区索引

- 只有**新建**主会话写 `settings.main_onboarding:<id>=pending`（旧主会话/配置覆盖不补初始化）；CAS `pending→sending→sent` 防并发重复，注入失败退 `pending`。
- 投递前必须 await `guardPreset` 恢复成功，不用固定延时猜就绪；`sent` 只表示消息已入队，不保证模型已介绍/派发（进程在发送与标记之间崩溃有不确定窗口，不盲重投）。
- 索引任务只扫 `workspaceRegistry.list()` 登记的目录：读 `repoRoot/branch/HEAD/origin/commonDir`，单项失败继续，不 fetch/pull、不写文件，remote 去凭证。`task_report.workspace_index` 仅接受本任务 `done` 的完整 JSON，按创建时名单校验覆盖，与 `settings.workspace_repo_index` 同事务写入，不覆盖 `memories`。

### 原生自动化工具面
- `cordis.patch.yml` 只在 coordinator plugins 挂原生 `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`，预设自有工具不进入 `createTools`，也不受 `restrict` 的 deny/keep 影响。worker 不新增自动化挂载。
- **工具面**：`createTools` 返回 12 个（协调者可见 8；worker 专属 4 个，另共用 `context`/受限 `memory_note`）。协调者另挂宿主只读 `read`、`skill`、`present`、`schedule_*`，不计入全局工具数；不挂 `tool-fs-search`。旧入口并入 `task_message.action`、`task_list.view`、`context.mode`；旧名不注册，迁移提示来自 `src/tool-migrations.js`。
- 缺能力诊断只针对唯一主会话：检查 `tools.get(name, agent)` 的可见定义与 `ctx.schedule`，缺失去重 warn + policy 提示；不改运行回合工具表，也不模拟自动化。
- 只支持 `target:this_session`：Host 到期投递消息到唯一主会话，再由模型走 `task_create`。`new`/`new_once` 创建普通 root 会话，不是委托 worker、也不是第二协调者；**非唯一主** id 被 `requireMain` 拒绝。**默认 worker 不新增**挂载；`access:full` 不增加工具、不解除 `subagent_session`。沿用 Host-wide 管理、用户**明确授权**、RRULE 与 `expectedUpdatedAt` 冲突保护；用法见 [TOOLS 原生自动化工具](TOOLS.md#原生自动化工具)，边界见 [LIMITATIONS](LIMITATIONS.md#原生自动化)。

### 入口可见性（U1）

- **会话头「任务」入口只在主会话显示**：`client/src/gate.js` 取当前会话 id → POST `session-role` → `src/session-role.js` 的 `isMainSession`（与 `task_*`、通知投递同源：台账 `main_session_id`）。
- 降级 fail-closed：没有会话 id、路由不可用、HTTP/JSON 失败、`ok:false` 一律隐藏；失败不缓存，换会话立即重判，另有 5 秒兜底轮询；同会话的明确答案缓存。
- 侧栏「◈ 主会话」始终可见、不参与判定（它是首次创建主会话的引导入口）；面板主体仍注册为 `main` 槽位，入口隐藏不等于面板消失。

## 主会话上下文维护（0.25.0：宿主自压 + 插件只提醒 + 手动 adopt）

主会话是唯一协调者。**「轮换」整套已删除**（不再自动归档旧会话、不再自己换人）：上下文过长由宿主 `compaction-basic` 在每个 agent 预设的 isolate 组里自动压缩（阈值是宿主的 `thresholdRatio`，默认 0.8），插件只做观测与提醒。

- **模块**：`src/main-context.js`（观测 `readContextPressure` / `readLogSize` / `readCompactionStats`、只读探测 `probeCompaction`、提醒判定 `decideAlert`、问题卡与代建衔接 `createContextObserver`、老键清理 `cleanupLegacyRotation`）、`src/main-session.js`（`adoptSession` / `createCoordinatorSession`）、`src/main-nav.js`（进程内导航/提示待办 `createMainNav` + 代建结果翻译 `planCoordinatorNav`）、`client/src/nav.js`（轮询执行跳转 `createMainNavPoller`）、`index.js`（装配 + `onOpened` 旁路）、`src/host-route.js`（`adopt-session` / `main-nav` / `main-nav-ack` 端点 + `snapshot.mainSession.context`）。
- **观测**（只在「打开主会话」时算一次，异步不阻塞）：压力 = `tokenMeter.contextPressure(session)` 的 `pressureTokens/contextWindow`；日志体积 = `sessionPersistence.locate` + `stat`；压缩次数 = `sessionQuery.observeSession()` 里 `compaction/start` 的 `turn`（`null` = 手动 `/compact`，数字 = 宿主自动）。
- **提醒**（唯一出口：宿主 `userQuestions` 问题卡）：压力 ≥ `contextPressureThreshold`（默认 0.4，可配）时弹一次；选项「新建协调者会话 / 继续当前会话 / 稍后再说」。去重：settings `main_context_alert = { at, ratio, band, state }`，同一 band（0.1 步长）只问一次，压力回落到 `阈值 − 0.05` 才重新武装。`userQuestions` 缺失或 `NO_PROVIDER` 只 warn 一次、不建会话。
- **有在跑的任务就延后**（t-a79e12d8）：`decideAlert` 该 `ask` 时若 `activeTasks` 里还有 `DEFERRED_TASK_STATUSES`（`statusesWith('active')` 去掉 `delivered`：pending / running / waiting_dep / waiting_user / waiting_auth）就改成 `defer`。`remind` 只写一条 `main.context.alert.deferred`（按 band + 任务集合去重），**不写 `main_context_alert`、不占 band**——任务收尾后下一次 open 仍会问（同一 band 也问）。`delivered` 不算在跑（子会话已结束，换主会话不丢回报）。
- **换协调者**（只切指针，旧会话零处置）：①会话头「设为协调者」→ `adopt-session` → `adoptSession`（校验：会话存在 / 在指挥舱工作区 / agent 已加载 / 预设为协调者或可拉回，否则 `ADOPT_*` 可读错误）；②问题卡选「新建」→ `createCoordinatorSession`（create → 切指针 → `onboarding=sent` → 改名「主会话」→ 审计 `main.adopt.created`；create 失败零处置，切指针失败**新会话留着待重用**、不归档）。同一时刻只允许一次切换（`ADOPT_BUSY`）。
- **跳转（客户端能力，服务端不假装能导航）**：`planCoordinatorNav(代建结果)` → 成功一条 `{kind:'navigate', sessionId}`、失败一条 `{kind:'notice', text}`，写进 `createMainNav` 的**进程内单条待办**（TTL 5 分钟，不写台账/settings）。浏览器 `client/src/nav.js` 每 5s 拉 `main-nav`：`navigate` → `uiWorkspace.openSession(sessionId)` 成功后 `main-nav-ack`（id 匹配才清，多客户端先到先得）；宿主拒绝（`sessions.retain: unknown session`，新会话广播未到）最多试 3 次，仍失败 → ack `ok:false`（审计 `main.nav.navigate-failed`，指针保持不动）+ 切面板顶部可读提示「请从左侧会话列表打开『主会话』」；没有 `openSession` 的旧宿主同样降级为提示、不崩。没有 `mainNav` 装配时两个端点分别回 `{ok:true, nav:null}` / `{ok:true, cleared:false}`。
- **settings**：`main_session_id`（唯一指针）、`main_session_preset`、`main_onboarding:<id>` 语义不变；新增 `main_context_alert`（提醒去重）、`main_log_hint_shown`（16 MiB 一次性提示）；老键 `main_session_created_at` / `main_rotation_*` 在启动时一次性清掉（`main.rotation.legacy-cleaned`）。
- **日志**：`main.context.observed` / `alert.asked|deferred|snoozed|declined|resolved|cleared|create-failed` / `main.nav.pending|consumed|navigate-failed|expired` / `main.adopt.created|pointer-failed` / `main.session.adopted` / `host.capabilities.compaction`（只读探测结果）。
- **插件不压缩**：不调用 `compactNow`、不写宿主阈值/预设行内 config、不重试；`/compact` 手动路径照旧。

## 队列与并发

平台有 `maxActiveSubagents` 上限（默认 8），满了抛 `ACTIVATION_LIMIT_REACHED` 且平台不排队，插件自己维护队列：`task_create` 只校验、去重、落库、入队，派发异步；容量满保持 `pending`，按 2s/5s/10s/30s 退避重试；唤醒 = 子会话结算、任务终态、`stop`、插件启动、协调者 `agent/created`；高优先级先派，同级 FIFO；只有子会话创建的非容量错误才标 `failed` 并推通知（不留幽灵 `pending`）。子会话预设由 `config.workerPreset` 决定，`dispatch` 只在 `spawn` provider 上传 `agentPreset`；续派/冷恢复沿用会话创建时记下的预设。调试用的 `orch-debug` 副本不在本包内（P1-E 已外移）。

## 依赖 / 分组 / 写域 / 优先级

**任务产物**：`artifact_dir` 是创建时主会话 `artifacts/<taskId>` 暂存/引用目录，`artifact_store_dir` 是宿主 `artifact-store/<taskId>` 私有真源，两者固定。文档/快照只登记真源；展示引用不驱动读取或迁移。`artifact-protection` 检查已解析默认/额外根、目标和 temp 的覆盖，派发/续派及再授予失败即拒绝；完整访问明确无保护。target/worktree 与 writeScopes 契约不变。统一阶段保存后结算，缺摘要/省略不完整，非 Git 不完整不自动 chain；历史路径不搬移。
- `dependsOn` 最多 20 个，必须指向已存在且不是 `failed/cancelled/orphaned` 的任务；创建时不接受未来 id，因此不会成环。
- 前置未完成 → `waiting_dep`；`queue.pump` 前先晋升：全部 `done` → `pending` 入队；任一失败/取消/丢失/不存在 → 下游 `failed`（写明原因）；晋升是循环的，失败沿依赖链传播。
- 前置任务摘要与产物不在派发时预渲染：子会话用 `task_detail` 按**当前**台账现读。
- **任务链规则进 L1（0.28.0）**：`renderTaskChainPolicy()`（`src/prompt-layers.js`，拼在推进循环之后、worktree/写域之前）把既有机制写成协调者每回合都读得到的判断口径，句子唯一真源是 `src/copy.js` 的 `TASK_CHAIN_LINES`，`task_create.dependsOn` 描述（`TASK_CHAIN_TOOL_DESC`）与 `waiting_dep` 回执（`TASK_CHAIN_WAITING_NOTE`）逐字引用同一批句子。六条：① B 的输入是 A 的产物就在派 A 的同一回合建 `dependsOn`（不要等 A 完成再建、不要轮询）；② `dependsOn` 不是阻塞等待——晋升发生在 `queue.pump()` 的 `promoteDependents`，不占协调者回合、不是 `wait_agent`；③ 前置失败/取消/丢失/不存在 → 下游 `failed`（循环传播）；④ 就绪只认 `done`，前置 `delivered` 会挡住下游；⑤ 同一 worktree 检出必须串行。**0.28.0 只改提示词与工具描述**：`deps.js`/`queue.js`/状态机/权限一行未动。⑥ 之后新增的**链式自动放行**（`task_create.chain:'auto'`，句子 `TASK_CHAIN_LINES.chainAuto`）：带标记的任务交付（落 `delivered`）时若台账里仍有 `waiting_dep` 的下游在等，插件在交付的**同一同步段**复用 `closeDelivered` 收成 `done`（`accepted_by`/`close_reason` 都是 `chain`、`accepted_kind='delivery'`），下游仍由 `promoteDependents` 晋升；没有下游或没带标记 → 照旧停在「已交付待确认」等确认；自动放行后 `done` 不能追问/续跑（判据与边界见「两段式终态」的进入段与出口列表）。
- **并行策略进 L1（t-c8adaeb1）**：`renderParallelPolicy()`（`src/prompt-layers.js`，拼在任务链之后、worktree/写域之前）把「什么时候并行、什么时候串行」写成协调者每回合都读得到的判断口径，句子唯一真源是 `src/copy.js` 的 `PARALLEL_LINES`。三条同时满足才并行（① 互不依赖：B 的输入不是 A 的产物；② 无需复用同一子会话上下文；③ 同写域会撞车）→ **优先 `worktree:true` 隔离并行**，不排 `dependsOn` 链；只有「有依赖」或「要复用同一子会话上下文/同一检出」才串行；只读与计划任务同目录直接并行；同一 worktree 检出永远只能一个任务在写。代价（合并由用户决定、检出要先装依赖、并发 commit 争 `.git` 锁）与例外写在同段，并与 worktree / 写域 / 任务链三段互相引用、不出现「默认先串行」。**只改提示词**：派发、队列、写域判定一行未动。
- `group` 只用于展示/过滤；`priority` 只影响队列顺序。
- **同写域并发防护**（`src/write-guard.js`，默认拒绝）：`task_create` 在「去重 / 容量 / worktree 决定」之后、`createTask` 之前的**同一个同步段**里判定——新任务 target 与活跃未隔离任务的 target 相同或互相包含，或两者 `writeScopes` 重叠 → 按 `config.sameDirGuard` 处理（`require` 拒绝 / `warn` 只警告 / `off` 关闭）。不参与判定：`readOnly`、`requested/created/reused` 隔离任务、`dependsOn` 祖先、终态任务。例外是 `degraded`（不是 git 仓库而降级）：仍在原工作树里写，必须继续占目录。**`delivered`（已交付待确认）不占目录**：交付那一刻就释放该会话的可写根，同目录可以新派；要接着改用追问，追问回 `running` 前由 `decideFollowupGuard` 复判 target/写域（工具与面板同口径，被拒返回 `MESSAGE_WRITE_CONFLICT`、记 `task.followup.rejected`）。**隔离任务重新拿写根**（resume / 追问 / retry / 派发 chokepoint）只判它那份检出：`isolatedConflicts` 算「同一份检出（含 `worktreeMode:'continue'` 复用）」与「别人写进我的检出」，**原 target 不判**——检出天生在仓库根内（`<repo>/.agents/worktrees/<taskId>`），父子包含不是同一份工作树（0.34.x 修掉的误拦：仓库根任务在跑时隔离任务 resume/追问被拒）。唯一显式放行是 `allowConcurrent:true`（记 `task.create.concurrent-write`）。拒绝对应 `task.create.rejected`（`reason: same-dir | write-scope | checkout-busy`）。

## 派单选项一览（`task_create`）

| 参数 | 作用 |
|---|---|
| `planFirst` | 计划任务：**只读沙箱（硬拦）+ plan-mode（软引导）**，流程顺序固定：①子会话只读探索 → ②`plan_save` 把计划落盘到 `reports/plans/<任务名>.md`（计划阶段唯一写入口；只有 `content`，插件原样落盘、不解析/不改写；文件名=任务名，安全化与同名 `-2` 见 `src/plan-doc.js`）→ ③`blocked` 只上报摘要 + **绝对路径** + question 里逐条列出的待拍板清单 → ④协调者**先**把摘要与绝对路径回给用户并 `present` 计划文档，**再**用 `ask_user_question` 请拍板（四选一「逐项确认 / 均按推荐 / 先看计划文档 / 放弃」）；选「逐项确认」按清单**一项一问**、答完先给决策汇总再做总批准核对（「均按推荐」必须用户明确点选）→ ⑤**计划批准必须由用户拍板、协调者不得自行批准**，批准动作只能是 `task_message({ action: 'approve' })`（切可写 + 落审计），再用 `task_message` 续派实现；普通 `message` 只记讨论/修订、不会批准。与 `readOnly` 互斥；批准顺序与失败分支见「计划阶段（P8）」 |
| `readOnly` | 只读任务：只认显式 `true`，续派也**不会**转可写 |
| `access: 'full'` | 这一条任务跑在 `danger-full-access`：沙箱不限制写入、`bash`/`pwsh` 解封。只接受 `'full'`，不继承、不改部署默认；与 `readOnly`/`planFirst` 互斥 |
| `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` / `worktreeCleanup` | 在 `<repo>/.agents/worktrees/<taskId>` 独立检出里干活，产物在分支上、**合并由用户决定**；多活跃分支且没给基线时先返回候选让用户选 |
| `goalRounds` | 1–50；`>0` 时交宿主 `dsh-goal-round-driver` 续跑，默认 0 = 不续跑（见「子会话目标（G1）与续跑」） |
| `teamTaskId` | 关联官方 Team 板任务；**人/协调者确认交付**时按 CAS 反写官方任务 `complete`（超时自动完成不反写） |
| `allowConcurrent` | 显式放行同写域并发（返回里标注风险并记日志） |

## 回报、通知、收件箱、日报

`task_report` 四档：

| status | 通知级别 | 说明 |
|---|---|---|
| progress | coalesce | **默认送达**（不是 silent）：进 5 秒合并窗口；同任务 60 秒水位，窗口内只留最新一条、到水位线补投；**追问/续跑后的第一条不看水位、立即送** |
| done | notify | 落「已交付待确认」（`delivered`）；5 秒合并窗口后注入协调者 |
| blocked | interrupt | 立即投递，可带 `question` / `options` |
| needs_auth | interrupt | 立即投递，可带 `question` / `options` |

- 通知走 `agent.steer` 直插协调者，不经过 Team 的 `sendMessage`；每次投递写 `notifications` 行（`delivered`/`failed`/`skipped`，合并后续行 `merged_into` 指向首条）。
- **progress 为什么必须送达**：它是「任务还在跑」的协调信号，不是终态——协调者据此决定 `task_message` 追问同一子会话（或 `resume`），而不是重派新任务。silent 时代「追问 → 子会话先报部分结论 → 继续跑」这条最需要被看见的路径对主会话永久不可见（实测 t-1f70bedb：8 次追问后的 progress 零通知，只剩 15 分钟看门狗）。
- **追问必达**（`tasks.report_expected_at`）：`task_message` / `resume` 投递成功后置位（面板「追加」同口径，`src/panel-actions.js`）；下一份回报带 `answeredFollowup` → progress 跳过水位与合并窗口立刻投递。回报一到就清标记——必达只对**第一条**生效，长任务不会因为一次追问变成每条 progress 都即时唤醒。
- **节流不刷屏**：同任务 60 秒水位内只留最新一条、到点补投（尾沿保留最后状态）；合并窗口内同一任务的第二条 progress 覆盖第一条，被同窗口的 `done`/`blocked` 取代的直接撤掉（一条消息里不重复列同一任务）。被压住/覆盖/取代的写 `notifications` 行（`skipped` + `reason: progress_watermark | progress_merged | progress_superseded`）——**每条 progress 都有审计行**，排查「主会话为什么没收到」不用再猜。水位在进程内，重启后重置（重启后的第一条 progress 立即送）。
- `task_list({view:'inbox'})` 汇总待决、失败/丢失、长时间没动静；问题/选项来自台账 `question` / `question_options_json`，`progress`/`done`/`task_message` 会清掉旧问题。
- **卡住提醒**：连续 3 次 progress 且距上次提醒超过 `staleMinutes` 推一次「可能卡住」（与上面的送达并列，不互相替代）。
- 日报：`digestAt`（HH:MM）开启后在主会话上维护一条每日 `schedule`，到点提示协调者汇总；主会话重建/时区变化会重建，配置为空会删除。

## 两段式终态（D1：交付 → 确认）

`done` 是不可逆终态，但「子会话说做完了」不等于「用户验收过」。状态机在 `running` 与 `done` 之间加了 `delivered`（已交付待确认）：

- **进入**：`task_report done`，或结算 `completed` 且没上报过 progress（`SETTLE_MAP`）。**例外（链式自动放行，`task_create.chain:'auto'`）**：交付时台账里若仍有 `waiting_dep` 的下游依赖它，交付钩子（`src/delivered.js` 的 `chainAutoGate` + `autoCloseChainDelivered`）在**同一同步段**立刻复用 `closeDelivered`（`reason`/`by` 都是 `chain`）收成 `done`——`accepted_by='chain'`、`accepted_kind='delivery'`、`close_reason='chain'`；没有下游 / 不带标记则停在 `delivered` 等确认。
- **出口 1 · 确认**：`task_message({action:'close'})`（或面板「确认交付」）→ `done`，`close_reason=coordinator`；超过 `deliveredTimeoutMinutes`（默认 60）由 sweeper 自动收成 `done`，`close_reason=timeout`。
- **出口 2 · 追问**：`task_message` 投递成功 → `running`，复用同一个子会话（**可写根不释放**），完成后再次交付。
- **出口 3 · 停止/丢失**：`stop` → `cancelled`；追问时子会话不可达 → `orphaned`。
- 归属：`delivered` 是活跃状态（`listTasks(active)`、面板门控、`inboxCount` 都算），但不是终态；状态集合与转移表只有一份（`src/status-facts.js`，见下「状态事实源」）。
- 依赖就绪仍只认 `done`；goal 不收口（`delivered` 期间保持 active + disarmed，只有 `done` 才 `complete`）；对账不查 `delivered` 的 liveness（成果已落库，超时 sweeper 兜底）。
- 审计：`tasks.delivered_at` 记录本次交付时间（追问后再交付会重写），`close_reason` 记关闭原因，`messages` 里 `kind='close'` 写「协调者确认 / 超时自动完成 / 链式自动放行」。
- 四条关闭路径（工具 / 面板 / 超时 / 链式自动放行）共用 `src/delivered.js` 的 `closeDelivered`，副作用顺序固定：迁移 + 审计消息 → 释放可写根 → goal 收口 → 按档位清检出 → 唤醒队列。
- 通知去重：进入 `delivered` 发一条（带 `close`/追问指令），确认/超时**不再发**通知，只写审计消息；**链式自动放行**例外——交付那一刻就收成 `done`，发的是 `done` 通知（不再渲染「已交付待确认」、不给 close 指引），正文追加「链式自动放行」一句。

## 交接契约 v1（D2：`acceptedBy` / `acceptedAt` + JSONL）

「交付 → 确认 / 追问 → 完成」是插件独有的一段语义（官方宿主没有），v1 把它从内部状态机提升为**可被外部消费的只读契约**：稳定字段 + 版本号 + JSONL 审计事件。**v1 只做数据契约与事件，不做进程内订阅 API**（回调/事件总线留 v2）。

四条确认路径各自带 `by`，落库与事件只在 `closeDelivered` 一处写：

| 入口 | `acceptedBy` | `close_reason` |
|---|---|---|
| `task_message({action:'close'})`（`src/tools.js`） | `coordinator` | `coordinator` |
| 面板「确认交付」（`src/panel-actions.js`） | `panel` | `coordinator` |
| 超时 sweeper（`src/delivered.js`） | `timeout` | `timeout` |
| 链式自动放行（交付钩子，`src/delivered.js`） | `chain` | `chain` |

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
| `acceptedBy` | `coordinator` \| `panel` \| `timeout` \| `chain` \| null | 谁确认的；未确认是 null |
| `rounds` | object | `{ turns, followups }`：派发/续派次数与追问次数 |
| `evidence` | object | `{ acceptance, artifacts }`：A1 的验收记录原样（没跑过 null）与已登记产物 |
| `status` | string | 当前状态（`delivered` / `done` / …） |
| `closeReason` | `coordinator` \| `timeout` \| `chain` \| null | 关闭原因（台账原文） |

**没有交接 = `null`**：从没交付过的任务（pending / running / failed / 存量 done）没有 `handoff`（不是空壳对象）；「交付了但没确认」是 `acceptedAt: null` + `acceptedBy: null`，两者必须能区分。

三个视图粒度不同、字段同源：面板 snapshot 只下发精简版 `{contract, deliveredAt, acceptedAt, acceptedBy, acceptedByLabel, acceptanceOk}`（不给证据，避免快照变大）；`task_status` 渲染「交接 / 交接轮次」两行；面板 detail 与 JSONL 事件给完整契约对象。

### JSONL 事件

落 `$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`（**不进仓库、不写台账 messages**）：按天分文件、单文件超 5 MiB 换新、保留 30 天，与运行日志共用 `src/log.js` 的同一套轮转实现。

| 事件 | 何时写 | 幂等 |
|---|---|---|
| `task.handoff.delivered` | 任务进入 `delivered`（`transition` 观察者；`task_report done` 与结算 `completed` 两条路都覆盖） | 每次交付一条（追问后再交付是新的一次交付） |
| `task.handoff.confirmed` | `closeDelivered` 落库成功后（四条确认路径共用，含链式自动放行） | 只发一次：重复确认走 `already` 分支提前返回 |

一行一个 JSON 对象：`{"at":"ISO","event":"…","taskId":"t-…","sessionId":"c-…","detail":{"contract":1,"handoff":{…完整契约对象…}}}`。消费方式：按行 `JSON.parse`、按 `event` 过滤；文件只追加不改写，重复投递由读方按 `(event, taskId, deliveredAt)` 去重（`jq` 示例见仓库内 `docs/api-notes.md`，该文件不随包发布）。

### 兼容性与边界

- **字段只增不改**：v1 冻结字段名与语义；改名/改语义必须升 `contract`，读方见到不认识的版本应忽略而不是猜。
- **幂等**：`already` 分支不写 accepted_*、不发事件；并发确认（工具与面板撞车）只会有一次真实写入。
- **超时也是确认**：超时走同一条 `closeDelivered`，`acceptedBy: 'timeout'`、`close_reason: 'timeout'`，事件照发——「没人确认」与「超时自动完成」必须能区分。
- **存量行**：`accepted_by` / `accepted_at` 旧库启动时 ALTER 补列，存量行 NULL；v1 之前已 `done` 的存量任务直接没有 `handoff`，面板与 `task_status` 按「没有交接记录」显示，不猜。
- **失败是旁路**：事件写入失败只 warn 一次，不影响迁移/确认（JSONL 是审计旁路，不是交付的前置条件）。

## 机器可判定验收（A1：`task_create.checks`）

`acceptance` 是给人读的标准，`checks` 是给机器执行的证据：**子会话报 `done` 时由插件先跑检查，全过才记录待交付请求，回合结束保存最终阶段后落 `delivered`；任一条失败即拒绝交付**。这让「任务做完了」不再只靠子会话自述。

| 项 | 规格 |
|---|---|
| 结构 | `[{ name?, command: string[], timeoutMs?, skipIfMissing? }]`，1–5 条；`command` 是 **argv 数组**（第 1 项是命令），不接受 shell 字符串 |
| 上限 | 单项参数 ≤2000 字符、整条 ≤4000 字符、argv ≤16 项；`timeoutMs` 1000–600000（默认 120000） |
| 通过 | 退出码 0（且未超时、无 spawn 错误）；`skipIfMissing:true` 时命令不存在（ENOENT）记「跳过」，不算失败 |
| 超时 | 先 SIGTERM，5 秒后 SIGKILL；结果 `timedOut:true`、`exitCode:null` |
| 输出 | stdout / stderr 各只留最后 4 KiB，超出标 `truncated`；失败回执给最后 10 行 |
| 台账 | `tasks.acceptance_json`：`{ spec, ranAt, cwd, ok, total, passed, skipped, failed, attempts, results[] }`（`attempts` 是跑这一轮验收时的 `tasks.attempts`，结算据此判断证据属于哪一轮）；旧库启动时 ALTER 补列，存量行 NULL = 没跑过 |
| 消息 | 每次跑都写 `messages.kind='acceptance'`（通过写「验收通过」，失败写完整失败清单） |
| 面板 | detail 端点下发完整证据，抽屉「验收」区块逐条显示；`task_status` 有验收段；snapshot 只下发摘要（计数/ranAt） |

**安全边界**（不做假安全，如实声明）：命令只来自协调者的 `task_create`（写进 brief 快照），`task_report` 没有任何命令参数，子会话无法注入或覆盖；执行用 `spawn(argv[0], argv.slice(1), { shell:false })`，不经 sh 拼串；**Windows 唯一例外**：无扩展名命令先按 PATH × PATHEXT 解析到 `.com/.exe/.bat/.cmd` 入口（`pnpm`/`npm` 的真实入口是 `*.cmd` shim，同目录的无扩展名 bash shim 不认），`.cmd/.bat` 由 ComSpec `/d /s /c` 执行且命令行从 argv 逐项转义（参数含双引号/控制字符直接判失败：cmd 没有引号转义语法，拼下去就是注入面）。cwd 固定为 `worktree_path ?? target_dir`，**不继承主会话目录**（没有 target 的任务创建阶段就拒绝配 `checks`）；**`readOnly:true` 的任务拒绝配 `checks`**（宿主进程执行保证不了只读）；环境变量继承插件进程；检查跑在**插件宿主进程**里，不是子会话沙箱——隔离任务只是 cwd 在检出目录，权限仍来自宿主。

**失败语义**：状态不迁移（保持 `running`）、不登记产物、不发交付通知；只落验收证据与 `kind='acceptance'` 消息，返回可读失败清单。子会话修完重报 `done`（会重跑），或报 `blocked`。确认交付与超时 sweeper **都不重跑**检查——确认是人的动作，不是再验一次。brief 里的 `checks` 无法解析时同样**拒绝交付**（fail-closed）。**结算侧同样 fail-closed**：`completed` 自然结束要落 `delivered` 前必须查「本轮通过验收的证据」（`acceptanceGapOf`：`ok===true` 且 `attempts` 匹配），没有就落 `failed` 并写死因（`task.settle.acceptance-gap`）——否则「不报 done」或「验收失败后再结束回合」都能绕过验收。

**为什么没有「只标记不阻断」**：验收的价值在于退出码，允许 `delivered + ok:false` 等于又回到自述。需要宽松时用 `skipIfMissing`（环境差异）或把检查写宽，而不是绕过闸门。

## 官方 Team 板互通（D6：只读 + 确认反写）

**方向已定：D6 优先，不做 workspace 第二后端。** 官方 Team 板挂在 **subagent 树**上（`subagents.rootOf(caller)` 才能定位），一旦派发改走 root 工作区会话，插件任务就脱离 Team 树、D6 直接失效；因此本片**不新增任何 root 会话派发路径**，也**不新增配置键**。D6 只做两件事：把官方板**只读**接进插件视图；插件任务被确认交付时**可选地**把关联的官方任务标 `complete`。

| 项 | 规格 |
|---|---|
| 宿主契约 | `agentTeams.isEnabled(caller)` / `listTasks(caller)` / `updateTask(caller, { taskId, expectedRevision, action })`（rc.5 `@deepseek-ai/dsh-agent-team`）；全部经 `host-capabilities` 的 `agentTeams()` 惰性取（**只走 `ctx.get('agentTeams')`**，`agentTeams` 不在插件 `inject` 里，读 `ctx.agentTeams` 属性会被 cordis get trap 直接抛），`report()` 第 10 类 `team-board` 只探测 `isEnabled` + `listTasks` |
| 只读快照 | `snapshot.teamBoard = { enabled, rows, degraded }`；`rows[] = { id, revision, subject, status, statusLabel, owner, blockedBy, writeScopes, ready }`（**不含 description**：官方允许 16 KiB 正文，每帧下发会把快照撑大）。`enabled:false` 时**不调用** `listTasks` |
| 面板可见性 | `enabled !== true`（服务缺失/形状变了/Team 未开启）→ **整区不渲染、不显示提示条**；`enabled:true` 且 `degraded` 有值（Team 开着但这次 `listTasks` 失败）→ 只读提示一条，不显示表格 |
| 关联 | `task_create.teamTaskId`（可选）：只读校验存在并记 `tasks.team_task_id` / `team_task_revision`（CAS 基线）。不 claim、不改官方任务；重派复制这两列 |
| 反写 | **人/协调者确认**（`closeDelivered` 成功且 `acceptedBy` 是 `coordinator` / `panel`，见 `shouldReverseConfirm`）→ `updateTask({ action:'complete', expectedRevision })`；只对**显式关联**的任务、只由协调者（Team Lead）发起。超时自动完成与**链式自动放行**都**不反写**（都不是人的确认），只记 `team.board.skipped`（`reason: timeout` / `chain`） |
| CAS | `expectedRevision` = 创建时读到的 revision；`TEAM_TASK_STALE_REVISION` 只**重读一次**再试**一次**，仍冲突就停手记 `team.board.stale`，不重试轰炸 |
| 降级 | 服务缺失/形状变了/`isEnabled` 抛错 → `degraded.code=TEAM_BOARD_UNAVAILABLE`（面板整区隐藏）；Team 未开启 → `enabled:false, degraded:null`（同样隐藏）；反写失败/冲突**只 warn + 日志**，本地 `done` 已落库、不回滚 |
| 事件 | `team.board.confirmed`（成功）、`team.board.stale`（冲突放弃）、`team.board.confirm-failed`（官方拒绝/异常）、`team.board.skipped`（未关联/服务缺失/未开启） |
| 边界 | 不接管官方派发/认领/生命周期；不把官方任务同步进台账；不做 workspace 后端。面板里官方板是**只读分区**（行内没有按钮） |

**为什么 CAS 是硬要求**：官方板可能同时被 Lead 与 teammate 操作；不带 `expectedRevision` 的 `complete` 会覆盖别人刚做的 `claim` / `edit`。反过来「冲突就自动改到最新再写」也危险——那等于替别人拍板，所以只重读一次、只再试一次。

**为什么失败只 warn**：交付是本地状态机的事实，官方板只是并行看板；为了一个看板写失败把已确认的任务回滚成 `delivered`，会让「用户已经确认过」这件事消失。

**为什么超时自动完成不反写**：超时是「没人确认」的兜底，不是人的判断。让它去改官方板，等于系统替别人把共享看板上的任务标完成；所以只记一条 `team.board.skipped`，`updateTask` 一次都不调。

## 任务状态机

| 状态 | 含义 | 谁推进 |
|---|---|---|
| `waiting_dep` | 等前置完成，不派发、不占并发位 | 前置 `done` 后自动 → `pending` |
| `pending` | 排队等并发槽位 | 队列自动派发 → `running` |
| `running` | 子会话在跑 | 子会话回报 / 结算 |
| `waiting_user` | 子会话 `blocked`，等人决定 | `task_message` 续派 → `running` |
| `waiting_auth` | 子会话 `needs_auth`，等授权 | 同上 |
| **`delivered`** | **已交付待确认**：成果已落库，等确认或追问 | `close` → `done`；`task_message` → `running`；超时 → `done` |
| `done` | 已完成（**不可逆终态**，不提供 reopen；`close` 确认的不可续跑） | — |
| `failed` | 失败（可 `resume` 续跑原会话 / `retry` 新派） | `resume` → `running` |
| `cancelled` | 被 `stop` 停掉（尊重意图，不续跑） | — |
| `orphaned` | 会话丢了（上报过 progress 的回合异常结束；重启后常见） | `resume` 续跑 / `retry` 新派 |

- **`resume` vs `retry`**：`resume` = 同一任务同一子会话接着跑（失败/额度中断/重启中断的默认出口）；`retry` = 新任务编号 + 新子会话（上下文跑偏、换检出/权限、会话真的不可达时用）。会话不可达时 `resume` **报错回退**、不静默新建；历史消息 > 60 条只**建议** `retry`，不拦截。
- 状态集合与转移表只有一份（`src/status-facts.js`），面板、工具、结算、对账都从它派生。

## 状态事实源（`src/status-facts.js`）

0.19.x 的状态集合被复制到 9 个模块并产生过三处真实不一致，现在只有一个判定点：

| 能力字段 | 回答什么问题 | 谁用 |
|---|---|---|
| `active` | 还算「没落终态」吗？ | `listTasks(active)`、面板筛选、`ledger` 的 SQL |
| `followup` / `resumable` | 能续派吗 / 续派后要迁回 running 吗？ | `task_message`、面板 |
| `deletable` / `retryable` | 能删吗 / 能重派吗？ | 面板删除、`retry` |
| `resume` | 能续跑**原会话**吗？（`failed`/`orphaned`/超时收尾的 `done`） | `task_message({action:'resume'})`（判定与阈值在 `src/resume.js`） |
| `terminal` / `releases` | 是流程终态吗 / 要释放可写根与 goal 吗？ | `close` 判定、结算收尾、面板与工具的 stop 幂等判定 |
| `waiting` | 是等人（用户/授权）的停顿态吗？ | `task_message` 续派 / 面板门控（计划批准另走显式 `approve`） |
| `liveness` / `catalog` / `watchdog` | 要对账活着吗 / 要查目录吗 / 要巡检空闲吗？ | `reconcile`、`watchdog` |
| `planSettled` | 计划任务进这个状态要收口 `plan_state` 吗？ | `ledger.transition` |

- **不可达边**（`running→done`、`orphaned→pending`）已删：它们自加入起就没有调用点，而测试曾把它们写成 `allowed`——**测试在保护死代码**。矩阵现在从 `TRANSITIONS` 派生，另有正向用例断言这些边必须被拒。
- **v0.24 重开三条入边给 `resume`**：`failed→running`、`orphaned→running`、`done→running`（`done` 还多一道行级白名单：只认 `close_reason='timeout'`，判定在 `src/resume.js`）。它们只服务「续跑同一 task_id 的同一子会话」，`retry` 仍是新建任务；`cancelled→running` 刻意没有（用户主动停的不复活）。
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

六层文本各有独占职责，**一条口径只许有一个所有者层**：

| 层 | 载体 | 生命周期 | 唯一职责 |
|---|---|---|---|
| **L1** | `ctx.systemPrompt.context().text`（`index.js`，order 130） | 每回合重渲染 | 协调者行为规则：**能直接答就不委派**、工具可用/禁用（原生只读 `read` 与 `skill`；**不挂 `glob`/`grep`**）、交付与确认口径（**不主动问「能否关闭」**，只在真歧义/不可逆/远端写授权时提问）、`present` 与两条读路径（`read`/`read_workspace`）的用法、**复杂需求先 `skill({name:'grill-me'})` 拷问**、**交互三闸门（T0–T3 判级、堵塞项四类、追加调整 R0–R2）**、**推进循环（回报后必须落到推进/提问/问新任务之一，不许只汇报）**、任务链、并行策略、worktree 与写域策略、**用户偏好（第 4 段）**、能力诊断 |
| **W1** | 同一个 `ctx.systemPrompt.context`（`index.js`，order 131，**只命中 `tasks.session_id` 属于任务的子会话**） | 每回合重渲染 | 任务子会话的回报与确认：开工先读 `task_detail`（`WORKER_DETAIL_HINT`）、执行中 `blocked` 上报（`BLOCKED_HINT`）、交付 `task_report` 四状态 + summary + 两段式终态（`CONFIRM_HINT`）、隔离任务装依赖授权（`WORKTREE_INSTALL_HINT`，条件渲染）、主动调 `context`（`WORKER_CONTEXT_HINT`）；句子真源 `src/copy.js` 的 `WORKER_POLICY_LINES`，渲染入口 `renderWorkerPolicy` |
| **L2** | 派发消息（`src/brief.js`）＋ worker 预设 persona（`cordis.patch.yml`） | 每次派发/续派；persona 出生即带 | 只留**一次性参数**：任务编号、访问级别（`access:'full'`）、一行 `task_detail` 指针；persona 只说身份 |
| **L3** | 子会话按需调用（`src/task-detail.js`） | 按需 | 任务创建详情（目标/验收/约束/背景/原话/目录与权限/前置/经验/产物/计划/隔离说明） |
| **L4** | 一次性 `agent.steer`（`src/onboarding.js`） | 仅新主会话首次 | 只开场：一句话自我介绍 + 派索引任务（能力边界一条都不重复） |
| 旁路 | 通知（`src/notify.js`） | 每次通知 | 只讲「现在要你做什么」的动作指令 |

- **W1 是 t-4f7ce108 新增的层**（用户原话：「协调者预设有 policy，但任务执行者却没有……将静态提示词内容都统一移入任务执行者的 policy」）：brief 与 persona 只在出生那一刻到达子会话，续派/多轮之后容易被上下文挤掉；per-turn policy 每回合重渲染。注入判定：`subagent.spawn.accepted` 事件先记「子会话 id → 任务 id」，台账 `tasks.session_id`（`transition(..., 'running', { sessionId })` 写入）是唯一真相，两者都查；协调者、无关会话、孙会话一律拿到空串。两条 context 用不同 `order`（130 / 131）分开注册，互不覆盖。
- **偏好归 L1 末尾**（`src/preferences.js`）：存 `settings.orchestrator_preferences` 单键 JSON，每回合现渲染；字数 1200 为主约束、条数 12 为安全阀；超限**显式告知**被截条数；全局偏好只写 settings（不双写 memories），项目偏好只写 memories。偏好只是提示词文本，不进 config、不改 dispatch、不碰沙箱。

## 交互三闸门（T0–T3 / 堵塞项 / 调整评估）

`index.js` 的 `renderInteractionPolicy()`：协调者每回合都在的行为规则，拼在硬规则之后、worktree/写域之前（判级决定「要不要派单、怎么派」，逻辑上更靠前）。三条原则是一条生命周期上的三个入口，**不是三次打扰**：

| 阶段 | 原则 | 什么时候 | 问不问用户 |
|---|---|---|---|
| A 理解 | 开工前确认意图（T0–T3） | 收到需求、开工前 | T0/T1 不问；T2/T3 问一次 |
| B 执行 | 计划确认后少打扰（B1–B4） | 开工后到交付前 | 只有四类堵塞项 |
| C 变更 | 追加调整先评估（R0–R2） | 用户改方向时 | 先评估再问，确认后才通知子任务 |

- **判级（T0–T3）**：T0 不动文件不跑命令 → 直接答；T1 单点、可回退、不动用户数据、不碰远端 → 直接做（回复里先写「我的理解：…」）；T2 给的是现象/方案代价不同/改可见默认行为/目标或验收有歧义 → 只读调研 + `ask_user_question` 问一次；T3 跨仓库或跨工作区、动 5 个以上文件、重构·迁移、不可逆、要推远端或发布、要写仓库外、范围不确定 → `task_create({ planFirst: true })` → `plan_save` → 用户拍板 → 才实现。**判级只做一次**；不可逆永远最低 T2；用户说「你看着办」至多降一档。
- **堵塞项四类**（措辞真源 `src/copy.js` 的 `BLOCKER_RULE`，brief 的 `BLOCKED_HINT` 共用同一句）：B1 已确认的验收/范围/方案不可达；B2 要新授权（权限/远端写/发布/删数据/不可逆）；B3 子会话报 `blocked` 且选项要用户定；B4 事实在协调者工具面外查不到。其余（进度、能否关闭、可给默认值的细节、自己查得清的事实、能回退的取舍）**不算堵塞项**；一个堵塞项只问一次，多个合成一条清单，用户不答按建议继续——B2 与计划批准除外（必须等明确答复、不代批）。
- **追加调整（R0–R2）**：先给评估三行（`CHANGE_REVIEW_FIELDS`：影响面 / 风险 / 建议），再分档——R0 只补细节、不动验收与已交付结论 → 直接 `task_message` 转原会话；R1 动验收/范围/方案 → 评估 + 确认；R2 不可逆/权限/推翻已交付结论/换 target 或仓库 → 必须拍板。**顺序闸门**：评估与确认必须早于 `task_message`；计划任务上的普通 message 只记讨论/修订、**不会批准计划**（批准必须显式 `approve`，见「计划阶段（P8）」）。
- 与既有机制衔接：T3 的唯一闸门就是 `planFirst`（审批四步不变）；T2/R1/R2 的确认只用宿主 `ask_user_question`（由协调者发起，子会话调用会被平台拒）；「少打扰」限定在执行期，与硬规则里「不催关闭」「能直接回答就不派任务」同向，不推翻任何既有口径。
- **grill-me 技能是 T2/T3 的澄清动作**（0.26.0）：协调者判为 T2/T3 后先 `skill({ name: 'grill-me' })` 加载技能，按它一次只问一个决定性问题（每问带推荐）、事实自己查、决策归用户、最多 2 轮 8 问、给三栏决策记录。它只负责**澄清需求**，不替代 T2 的 `ask_user_question` 确认，也不替代 T3 的计划批准（grill ≠ 批准）。技能只挂在协调者预设作用域，子会话看不到。
- **回报之后必须推进（推进循环，独立一段）**：`renderCoordinatorPolicy()` 在三闸门之后、worktree/写域之前拼 `src/prompt-layers.js` 的 `renderAdvanceLoopPolicy()`（句子全部来自 `src/copy.js` 的 `ADVANCE_LOOP_LINES`）。三闸门回答「**什么时候可以打断用户**」，这一段回答「**回报之后必须做什么**」——分开成段是因为混在一起时模型容易只记住「少打扰」，把「不推进」当成合规：收到任何回报（progress / done / delivered / blocked / needs_auth）或用户消息后必须落到三类动作之一（推进 = 按已批准计划 `task_message` 续派/追问；提问 = `ask_user_question`；问新任务 = 仅无活跃且无待确认时问「还有新任务吗」），**禁止只输出汇报文字**；已批准计划立即续派实现；卡点必须提问、不自批；全部完成先问新任务、同一事件只问一次、不许宣称「已全部完成」后静默。边界：与「不催关闭」明确区分（问新任务 ≠ 问能否关闭，交付仍默认待确认）、与 T0 直答不冲突（直接回答就是本轮动作）、与「少打扰」同向（不新增打断点）。通知侧用同一份文案（`ADVANCE_NOTICE_HINT`）贴在 done / delivered / blocked / needs_auth 通知末尾；progress 已有追问指令、不重复贴，结算异常（failed/cancelled/orphaned）只报事实。**这是提示词约束（软门禁），没有执行层拦截**。

## 文案单源（`src/copy.js`）

分层解决「谁该说什么」，本模块解决「这句话写在哪」。跨模块共享的句子只在 `src/copy.js` 定义一次：

| 文案域 | 真源常量 | 复用到 |
|---|---|---|
| 计划阶段 | `PLAN_PHASE_LINES` / `PLAN_FIRST_DETAIL` / `EXIT_PLAN_MODE_DENIAL` / `PLAN_STATUS_LINES` / `PLAN_APPROVE_CALL` / `PLAN_MESSAGE_NOTES` / `planDocPathText()` / `planCreateReceipt()` / `PLAN_SAVE_TOOL_DESC` / `planSavedNextStep` | `task-detail`（L3）、`plan-mode`、`plan-doc`、`tools`、`panel-actions`、`dispatch`、`index.js` |
| 两段式终态 | `DELIVERY_LINES` / `DELIVERY_NOT_FINAL` / `DELIVERED_HINT` / `finishHint()` / `deliveredReceiptNote` | `task-detail`、`brief`、`notify`、`prompt-layers`、`write-guard`、`tools`、`deps` / `tool-migrations` |
| 完整访问 | `ACCESS_FULL.label` / `.briefLine` / `.workerHint` / `.createNote` | `brief`、`task-detail`、`tools` |
| 交互闸门 | `BLOCKER_RULE` / `CHANGE_REVIEW_FIELDS` | `index.js`（L1 交互三闸门）、`brief`（`BLOCKED_HINT`）、`tools`（`task_message` 描述） |
| 推进循环 | `ADVANCE_LOOP_LINES` / `ADVANCE_NOTICE_HINT` | `prompt-layers`（`renderAdvanceLoopPolicy`，L1 独占）、`index.js`（`renderCoordinatorPolicy` 拼接）、`notify`（done / delivered / blocked / needs_auth 通知尾部） |

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
- **例外：`delivered` / `done` 上要补写最后一条消息**（`task_report done` 先把任务推到 `delivered`，本回合结束时到达的结算已不在 `running`）：落消息、不改状态、不发通知、不写 settle 行、不重复释放。
- `delivered` 与真终态都释放可写根（交付即放手，同目录才能新派）；但 **goal 收口仍只认真终态**，会话也保留给追问——追问投递成功时由 `dispatch.send` 幂等重建写根（两段式语义不变）。
- 每次结算写一条 `settle` 消息 + `tasks.error` 死因 + 一条 `system` 通知，并唤醒队列补位；配了 `checks` 的任务多一道验收闸门（`completed` 落 `delivered` 前要求本轮通过证据，见上「可执行验收」）。取证与时序见 `docs/probes/stop-reason-probe.md`。

### 最新返回消息（B1）

两路事件都自带子会话最后一条 assistant 消息，结算时顺手落账——但**台账只存借条**（见下节「台账正文去重」）：`tasks.last_message_json = {at, stopReason, source, bytes, chars, digest, summary, stored:'host'}`，不带正文、不写 `reports/` 文件。`task_status` 默认给 240 字摘要，`include:'full'` 时**按需冷读**宿主会话日志（`src/session-body.js`：live 会话走 `sessions.get(id).snapshotEvents(0)`，冷会话走 `sessionPersistence.open(id,'read')` + `handle.read(0)`）；读不到就给摘要 + `unavailable:'host-log-missing'`，不抛错、不伪造。空输出不写（不拿空记录覆盖上一次）。`setTaskLastMessage` 按正文 `digest` 幂等（重复落库不重写行、不动 `updated_at`）。

### 台账正文去重（P1，0.30.1）

**为什么**：会话正文真源是宿主会话日志（`~/.dsh/sessions` 的 jsonl + `sessionPersistence`/`sessionQuery`），dsh-context 的「编队/Fleet」也是读它。插件台账再存一份 brief/report/最后一条消息的正文，就是同一段文本两份副本（实测 333 个任务里 `messages` 561 KB + `last_message_json` 300 KB 都是副本）。P1 把**正文**从台账里拿掉，只留可回查的借条。

**三类数据分开看**（判断「能不能删」的唯一口径）：

| 数据 | 宿主有没有 | 处理 |
|---|---|---|
| `messages.kind` = brief / followup / resume / report | 有：子会话日志里的 `user/message`（简报/追问）与 `tool/call`（`task_report` 参数） | **只存借条**：`rendered` = 单行摘要（≤240 字），`meta_json = {body:'host', chars, digest, summary}` |
| `tasks.last_message_json` | 有：该会话最后一条 `assistant/message` | **只存借条**（同上 + `at`/`stopReason`/`source`） |
| `tasks.brief_json`（创建快照：目标/验收/约束/背景/原话/checks/workspaceIndex/worktreeCleanup） | **没有**（这是用户输入的编排参数，宿主不存） | **原样保留**——删了 `task_detail` 会丢字段、A1 机器验收拿不到 `checks` |
| 交付确认（`delivered`/`accepted_*`/`close_reason`）、依赖链、验收证据、`notifications`、`question`、goal/worktree/team 列、`memories`/`groups_v1`/`automations` | **没有** | **一律不删**（删了就丢编排语义） |

**读侧口径**（`src/message-body.js` + `src/last-message.js`）：

- 新行：`meta.body === 'host'` → brief 用 `renderBriefForTask(task)` **确定性重渲染**（`source:'derived'`）；followup/resume 按 `digest` 在宿主 `user/message` 里精确找回；report 按 `digest` 在 `task_report` 的 `tool/call` 参数里找回（`source:'host'`）。
- 旧行（P1 之前的行）：没有 `body` 标记 → `rendered`/`text`/`path` 就是正文，**原样返回**（`source:'inline'|'file'`），不需要任何数据迁移。
- 读不到：返回摘要 + `unavailable`（`panel.detailBody` 的 `body:{source:'summary', unavailable:'host-log-missing'}`、`task_status` 的「正文不可读：…」），**不抛错、不伪造**。
- 缓存：按 `sessionId` 短 TTL（5 秒、最多 32 条），失败不缓存。

**改了什么**：`src/session-body.js`（新：宿主事件抽取 + 冷读 + 短缓存）、`src/message-body.js`（新：借条写入/解析口径）、`src/last-message.js`（借条 + `resolveLastMessage`）、`src/settlement.js`（只落借条）、`src/tools.js`（写入瘦身 + `task_status include=full` 冷读）、`src/panel-actions.js`（`detailBody` 异步补正文 + 消息行标 `body`）、`src/host-route.js`（detail 走 `detailBody`）、`src/queue.js`（派发改用 `renderBriefForTask` 现渲染）、`index.js`（装配唯一 `bodySource`）、`client/src/views.js`（「正文来自子会话 / 正文不可读（摘要）」徽标）。

**回滚**：P1 不删列、不重建表、不 VACUUM；回滚只需把写入侧切回「也写正文」+ 派生读路径改回读台账，历史行（含旧正文）一直都在。**风险**：正文可用性从此与「宿主会话是否还在」绑定——宿主会话被删/归档/迁移待办时，插件只剩摘要。


## 启动对账（S2）

进程重启/崩溃后，子会话的结算事件可能没人消费，台账会留下「running 但实际没人在跑」的幽灵。`src/reconcile.js` 在 `apply()` 与协调者 `agent/created` 晚加载时各对一次账：

- 活跃性对账只认 `running`：`agents.get(session_id)` 不存在 → `orphaned`；catalog 查不到 → `orphaned`；`waiting_user`/`waiting_auth` 不 live 但 catalog 有 → 保持原状态（靠 `task_message` 冷恢复）。
- catalog 读失败只 warn，`running` 的 liveness 判定照做；标记前重读状态，已落终态的不覆盖，重复启动幂等。
- 标记完发**一条汇总通知**（超过 10 条折叠）；启动时协调者还没加载导致投递 `skipped` 时保留待发，`agent/created` 后补发一次。
- 汇总通知里的默认出口是 `task_message({action:'resume'})`：标 `orphaned` 时把死因落 `last_stop_reason`，子会话 durable 就能冷恢复接着跑；**不自动 resume**（会花 token 且可能重复写文件），会话真不可达再 `retry`。

## 空闲看门狗（W1）

结算/对账管「没人跑却挂着 running」，但**有人在跑、却长时间没进展**的回合仍要人来看。`src/watchdog.js` 每 `watchdogIntervalMinutes`（默认 5）巡检一次：只看 `running`；判定数据源三源取最新（`last_event_at` / `updated_at` / `messages.at`），最新活动早于 `watchdogIdleMinutes`（默认 15）即判空闲；**只告警**（一条 `stalled` 汇总通知，超过 10 条折叠），不改状态、不 kill、不重派；同一段空闲每任务只报一次（去重表在内存）；启动时放在 S2 之后，避免同一任务既报丢失又报卡住；`idleWatchdog:false` 可关。

## 子会话工具失败监听（tools/result 观察者）

- **为什么**：子会话被权限/沙箱拒绝时，协调者原本只拿得到 `task_report` 的 summary，这条事实在编排面上会消失。`src/child-tool-failure.js` 订阅宿主 `tools/result`（`index.js` 装配，只观察、不改结果、不拦子会话自我纠错），把 denied 类失败变成一条日志 + 一条去重通知。
- **判定三通道（顺序固定）**：`result.error.info.code` 结构化优先 → pwsh/bash 的 `value.sandbox.denied` → `value.stderr` 文本兜底（`Permission denied` / `拒绝访问`）；**不要求退出码非零**（`git add` 撞 `.git/index.lock` 的拒绝退出码就是 0），`timedOut`/`aborted`/`stopped`/`signal` 一律不算失败；环境类（沙箱后端起不来、命令/依赖找不到）只写日志。
- **归属与告警**：`workerTaskOf(exec.agent.id)` 归任务，协调者自身调用与包会话/普通 root 会话直接丢弃，只有任务还在 `followup` 状态集合（running / waiting_user / waiting_auth / delivered）才打断；`subagent.tool.failure` 日志每个命中都写（被窗口压住的重复另写 `…suppressed`），`denied` 走 notifier 并按 `(taskId, tool, code)` 10 分钟去重（文案带脱敏后的 stderr 首行），台账字段不做；外部子会话与文本误判是盲区，见 [LIMITATIONS](LIMITATIONS.md)。

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

## brief 只留一次性参数（T1 / t-4f7ce108）

派发给子会话的 brief 只回答「你是哪个任务、去哪读详情」，创建详情全部留在台账、由子会话用 `task_detail` 现取；静态提示改由 W1 每回合注入：

- **形态**：`renderBrief({ taskRef, access })` 输出两行（完整访问多一行【访问级别】）——`【任务引用】tk-xxxxxx` + `【任务详情】先调 task_detail 读完整详情（task_id 就是上面的任务引用）。`（版本 B：brief 只写**引用**，不写台账内部编号）。目标、验收、约束、背景、用户原话、工作目录/权限、经验/前置/产物都不内联；`worktree_state` 不进 brief（装依赖提示归 W1，按同一台账字段条件渲染）。
- **静态提示归 W1（per-turn policy）**：`WORKER_DETAIL_HINT`（先读 `task_detail` 的字段清单与「不要凭 brief 猜任务内容」）、`BLOCKED_HINT`（执行中要拍板 → `blocked` 上报「问题 + 选项」，协调者问用户后续派）、`CONFIRM_HINT`（`task_report` 四状态；交付把 summary 写成「结论 + 改了什么/改了哪些文件/怎么验证的」；子会话**不能**调 `ask_user_question`——平台对 `origin === 'subagent'` 抛 `DELEGATED_CALLER`；`done` 会清空 `question`/`options`；交付后协调者**不会为「任务能否关闭」提问**，任务保持「已交付待确认」、等 `deliveredTimeoutMinutes` 超时自动完成，用户要改再 `task_message` 追问）、`WORKTREE_INSTALL_HINT`（隔离任务：可以装依赖，**只安装不升级**）、`WORKER_CONTEXT_HINT`（主动读上下文）、`WORKER_MEMORY_HINT`（收尾沉淀项目经验：只写自己任务 `target_dir` 的 `note`/`lesson`/`decision`，不写 `preference`/全局/日志）。句子真源都在 `src/copy.js`，渲染在 `renderWorkerPolicy`，注入在 `index.js` 的第二条 `systemPrompt.context`。
- **task_detail（只读）**：`src/task-detail.js` 渲染编号/标题/状态 → 目标全文 → 工作目录 + 可写/只读提示 → `【验收标准】`/`【可执行检查】`/`【约束】`/`【背景资料】`/`【用户原话】` → 编排（非默认才出现）→ `【前置任务】`（按**当前**台账现读）→ `【经验文件】<路径>（N 条）` → `【已有产物】`。实现只读台账：不写消息、不改状态/时间戳；交付/完成口径不在这里重复（归 W1）。
- **越权拒绝**：只允许任务自己的子会话；主会话或别的子会话调用返回「读取被拒绝…主会话查任务用 task_status」，并记 `task.detail.rejected`。
- **挂载链**：和其它 `task_*` 一样由 `index.js` 注册成 host plane 全局工具；协调者预设的 `preset-tools` 把 `task_detail` 列进 `deny`（0.26.0 起它与 `task_report` / `plan_save` 一起按「角色专属」遮在预设层），主会话看不到/调不到。
- **重派同口径**：`retry` 用 `renderBrief({ taskRef: 新任务引用 })` 重渲染，`task.brief` 快照整体复制；队列兜底也用 `renderBrief`，不再拼「【任务】标题 + 目标」。

## 子会话读上下文（只读 `context`）

子会话以前只能拿到协调者注入的那一点记忆（`task_detail` 的经验指针），自己查不到历史/项目背景。现在 `context` 对子会话开放，模型**主动读**，注入侧只留关键指针。

**权限矩阵（能力声明在预设层，执行层只做只读语义兜底）**：

| 工具 | 协调者（主会话） | 子会话 | 依据 |
|---|---|---|---|
| `context` | 可调（只读） | 可调（只读，**同一条实现**，同参数输出逐字一致） | worker 预设 `preset-tools` 的 `keep: [context, …]`；`src/tools.js` 三种 mode 都不再拦主会话 |
| `memory_note` | 可写（任意项目 + 全局偏好） | 可写，但**只能写自己任务 `target_dir` 的项目记忆**（`note`/`lesson`/`decision`，单任务 ≤3 条、同 `kind`+`text` 幂等、行上记 `source:'worker'` + taskId/sessionId）；`preference`、`global`/跨项目一律拒绝并给替代路径 | worker 预设 `preset-tools` 的 `keep`（keep-only，不遮任何工具）；执行层 `taskOfWorker` + `countWorkerMemories` 做归属与护栏校验，拒绝记 `memory.note.rejected`（见下「子会话写入项目记忆」） |
| `task_report` / `task_detail` / `plan_save` | 不可见（协调者预设 `preset-tools` 的 `deny`） | 只对任务自己的子会话 | 预设层遮挡 + 执行层 `task.detail.rejected` 等归属校验 |

- **两种收窄形态**（`preset-tools.js`）：0.26.0 起本插件的**两个预设都用遮挡式**（点名 `deny` + `keep` 正向声明）。协调者只遮「编排正确性」项与三个角色专属工具（`keep` 声明 7 个任务工具）；worker 是 **keep-only**（deny 为空）：不遮任何工具，只 keep 声明 `context` / `task_detail` / `task_report` / `memory_note` 出生即可用（0.29.x 起子会话也可写项目记忆，见上表与下面「子会话写入项目记忆」一节）。不再用 `allow` 补集：那要把平台所有全局工具名抄全，漏一个就悄悄少一个工具（协调者还会把只读工具也遮掉）。保留式（`allow`）形态仍留在模块里兼容旧 profile 与探针，新配置不再使用。真机语义实验见 `docs/probes/preset-scope-restrict.mjs`（10/10 PASS，含「deny 名单只遮点名项」「`keep` 晚注册后补确认」）。
- **`keep` 是正向声明**：声明这些全局工具必须对子会话出生即可用；挂载后随 `tools/change` 校验，确认到就写 `preset.keep` 审计（写 `$DSH_HOME/state/orchestrator/logs/*.jsonl`），未注册先静默、不抛——可见性以平台真值为准。
- **引导写在 W1 per-turn policy 里**（不是每条 brief、也不再写进 persona）：`src/copy.js` 的 `WORKER_CONTEXT_HINT`（「需要历史经验/项目背景时主动调 context：查本项目经验要显式传 project:<你的 target_dir 或工作区名>（不传只查 global 跨项目记忆），不要等协调者注入」）与 `WORKER_MEMORY_HINT`（「有值得复用的项目经验就用 memory_note 写一条 note/lesson/decision：project 只能是你自己任务的 target_dir、单任务最多 3 条；不写 preference、不写全局/跨项目记忆，也不写日志」）由 `renderWorkerPolicy` 每回合渲染，`test/prompt-layers.test.js` 逐字校验；brief 只剩两行、persona 只剩身份一句，都不重复这两句。
- **注入侧只做减法**：brief 自 T1 起就没有记忆正文；`task_detail` 的 `【经验文件】<路径>（N 条）` 保留（关键指针），只在末尾加一句出口「更多历史与项目背景用 `context({ mode: 'history' | 'project' })`」。

### 记忆检索与容量（0.25.1，审 t-c8df6366 后的最小落地包）

审计（`reports/memory-and-main-session-audit.md`）的结论是「写健康、读靠运气」：默认 `history` 只查 `global`（254 条项目记忆一条查不到）、注入命中 token 重合度均值 20%、日志层占 65% 却在混算配额里淘汰手记事实、worktree 任务的记忆落在 8 个分裂键下。落地包只改检索与配额、不改表：

- **检索范围可见（P0-a）**：`historyView` 首行固定打印 `【检索范围】<project_key>｜+ global` 或 `【检索范围】global（未含项目记忆）`；L1 硬规则与 W1 的上下文引导（`WORKER_CONTEXT_HINT`）都写明「查本项目经验要显式传 `project:<target_dir 或工作区名>`」。**默认键仍是 global**（不采纳「默认改 `defaultDir()`」：协调者 cwd 是指挥舱，推断出来的项目键对指挥舱无效）。
- **多键与 all（P0-b）**：`resolveHistoryScope` 接受 绝对路径 / 工作区名 / 数组（去重后取前 **2** 个键）/ `'all'`；`normalizeProjectKeys` 统一归一（自动补 `global`，`'all'` = 不按项目过滤），`searchMemories` 合并后统一按分数截 `limit`。未知名项目给一行 `【警告】`，不再静默回落。
- **质量门槛**：`memoryTokens` 的停用词表扩到 27 个（任务/插件/测试/代码/文件/项目… + 常见英文）；`searchMemories` 对多词查询要求命中 ≥2 个词或 `score ≥ 2`（decision 的 +2 权重也算分），单词查询命中即相关。
- **分层配额**：`pickLayered` 让 `decision`/`preference` 在一次结果里最多占 2 条，剩余槽位先给 `lesson`/`note`；候选全是决策类时按分数补满。
- **结果分块**：`historyView` 把事实层（`MEMORY_FACT_KINDS`）与日志层（`task-log`/旧 `task-done`）分两次查，日志单独成块、最多 2 条、排在事实层之后，不再挤占 `limit` 槽位。
- **淘汰分层**：`addMemory` 只在写入日志层时执行淘汰，单项目保留最新 `MAX_TASK_LOG_PER_PROJECT = 200` 条；事实层一条不删（旧「单项目 300 条」常量已删除）。
- **worktree 归一**：`task_report done` 的 projectKey 取 `brief.target ?? repo_root ?? target_dir`——隔离任务的 `target_dir` 是检出目录，以前直接用它写出 `.agents/worktrees/t-*` 分裂键。
- **项目背景白名单**：`projectContextFor` 增加 `docs/ARCHITECTURE.md`（默认前 1200 字，`include:['docs/ARCHITECTURE.md']` 给前 4000 字；总输出 ≤8000 字），未识别 include 给一行提示。
- **旧偏好迁移**：`migrateLegacyPreferences`（`src/preferences.js`）启动时把 `memories` 的 global `preference` 搬进 `settings.orchestrator_preferences`：带「更正/修正/纠正/推翻/不再用」标记的条目按共享主题词（≥3）取代旧条目，写成功后删除 memories 行（不双写），失败不写标记、下次重试；没有旧行时不动 settings。

### 子会话写入项目记忆（0.29.x，t-94b99f3f）

用户方向：「子会话在执行任务也能读到很多项目背景和已有实践，也需要进行写入记忆」。放开的是**写项目记忆**，不是权限模型：

- **能力声明**：worker 预设的 `preset-tools` 改 **keep-only**（deny 为空、`keep` 含 `memory_note`）——子会话工具表里出生就有它；`preset-tools.js` 允许「deny 空 + keep 非空」的形态。
- **归属由台账判定**（`src/tools.js` 的 `taskOfWorker`）：先查 `index.js` 注入的 spawn 映射（首回合 `tasks.session_id` 可能还没回写），再退 `findTaskBySession`。项目键只取 `tasks.target_dir`（`projectKeyOf` 归一），**不接受模型自由传**：`project` 不传 → 强制落本项目；传别的项目/`global` → 拒绝并点名两个键。
- **只放三类 kind**：`note`/`lesson`/`decision`；`kind:'preference'` 直接拒绝（偏好每回合注入协调者 policy，只由协调者维护）。没有 target 的任务、找不到归属的会话（别的 profile/孙会话）同样拒绝，并给替代路径（写 `task_report` 的 summary / 让协调者 `memory_note`）。
- **硬护栏**（不是提示词约束）：同 `project + kind + text` 由 `memories.hash` 唯一约束幂等（重复返回 `already`）；单任务上限 `MAX_WORKER_MEMORIES_PER_TASK = 3`，用 `countWorkerMemories` 按 `source='worker' + source_task_id` 计数，超限拒绝。
- **来源审计**：`memories` 新增 `source` 列（旧库 ALTER 补），子会话写入记 `source='worker'` + `source_task_id` + `source_session_id`；每条写入/拒绝都记 `memory.note` / `memory.note.rejected` 日志（含 `written`/`cap`）。
- **不改的**：记忆检索与注入语义、`task_detail` 的经验指针、brief、派发/状态机/权限模型、`memory_note` 的公开参数（只是角色化行为）。

## 产物

- `task_report.artifacts: [{path,label?}]` 仍是显式交付项，相对路径按任务工作目录解析；工作目录或 staging 内的文件复制到 `artifact_store_dir/docs`，已有真源文档直接登记。输入最多 20 项，省略/拒绝/失败记入阶段清单；产物按 `path` 合并（最多 50 条），优先保留完整阶段清单，不以原文件存在冒充保存成功。
- **统一阶段收集与交付**：`artifact-stage` 从宿主摘要与 `changedFiles` 取候选；非 Git 保存普通文件副本，Git 只记录工作文件引用与未归档状态。`checkpoint` 请求阶段快照；`done` 验收通过后持久记录待交付并收紧工作权限，回合结束保存最终阶段后才由既有结算器迁移、通知和释放占用。缺摘要/截断/保存失败标不完整，非 Git/unknown 不完整不自动 chain、不清理来源；当前 DSH worker 无自动摘要，需显式补报，仍不保证完整备份。
- 面板「产物」筛选打开产物库：按项目（目标目录末段）或日期分组、复制路径、文本预览（前 64 KiB）、打开子会话/详情。

### 协调者读产物（`read_workspace`）

新产物登记宿主 `artifact_store_dir` 内的稳定副本，历史产物仍可位于 target 或主会话工作区；不批量迁移历史路径。读取边界仍是**两个判据的并集**：工作区包含性 **OR** 已登记产物（台账 `tasks.artifacts_json`），不因存在 `storage.json` 引用而开放整个私有库。

- **为什么还要保留它（协调者的原生工具只有 `read`，`glob`/`grep` 已在 t-4f7ce108 移除）**：原生读没有路径白名单、看得到全盘的凭据（`dsh-fs-sandbox` 只给写操作加栅栏，`dsh-fs-local` 的 `cwd` 只是相对路径基准，`glob` 会 spawn ripgrep 全树枚举）。`read_workspace` 是**产物边界**的受控读：只认工作区 ∪ 已登记产物，越界/`../`/符号链接逃逸/未登记都拒并写 `workspace.read.rejected`。两者并存：`read` 用来核对改动与读技能，受控读用来读产物；1.0 前不退役。
- **实现分层**：`src/read-workspace.js` 是纯函数 + 一次有界读（路径判定、行窗口切分、目录列条目、二进制识别、文案渲染）；`src/tools.js` 只做 `requireMain` 身份校验、调用、审计日志。
- **判据分层**：`src/artifact-location.js` 是产物唯一合法性判据（`registeredArtifacts` / `registeredMatch` / `deliverableOf`）；`read_workspace`、`preview`、右侧栏、`present` 四条路径对「什么算合法产物」同源。
- **闸**：① 形状（空 / NUL / `~` 拒绝，不做家目录展开）；② `realpathSync` 真实路径包含性（挡符号链接逃逸）；③ 解析失败时退回词法包含性，把「越界」与「不存在」分开报；④ 都不放行时查**已登记产物**（文件本身或已登记目录子树），登记表不借符号链接放行。
- **体积与截断**：单文件 > 4 MB 直接拒绝；正文按行窗口返回（默认 400 行 / 上限 2000 行，单次 ≤ 64 K 字符），截断给 `nextOffset`；单行超上限时截断该行并标 `truncatedLine`。目录只列一层、最多 200 项。

## 协调者只读工具与 grill-me 技能（0.26.0，`t-48e8ce06`）

用户决策：「工作区只读权限下没必要限制工具；手切 full 是用户自担风险」。落地分两片，都只对本插件自己的两个预设生效：

- **B 片：只读文件工具**。协调者预设挂 `tool-fs`（`read: true`，`write` / `edit` / `applyPatch` / `readImage` 全 `false`）→ 协调者拿到 `read`，工具表里**没有写工具**。**t-4f7ce108 把 `tool-fs-search` 整行移除**：该包的 `Config` 只有 `sampleOverCapGlobResults` 与各 `max*` 上限，`glob`/`grep` 在 `apply()` 里无条件一起注册、没有按工具开关；`preset-tools` 的 `deny` 只作用于「已注册的全局工具」，`restrict` 遮不到预设自有行，所以「只关 grep、保留 glob」做不到，只能整行移除。理由（用户原话）：主会话一有搜索就会自行检索文件、绕过派发自行调研。执行层 `COORDINATOR_DENY` 同步缩到「编排正确性」名单（`wait_agent` / 团队工具 / `plugin_manager` / 密钥 / IM）；角色专属的 `task_report` / `task_detail` / `plan_save` 改由预设 `preset-tools` 的 `deny` 遮掉（工具表里看不到，执行层各自还有归属校验）。`bash` / `pwsh` **不挂**；默认权限仍是钉死的 `read-only`，用户手切 `full` 时插件不加限制、也不放宽工具面。
- **`working_directory` 被两处遮掉**（发版前真机复验补漏）：宿主全局工具 `@deepseek-ai/dsh-tool-working-directory` 在 0.25.x 的 `allow` 补集下被顺带遮住，0.26.0 改遮挡式后漏进了协调者工具表。它会改**协调者会话的 cwd**——而 cwd 是指挥锚（`task_create` 未给 `target` 时子会话继承它、工作区/写域判定与 `projectKeyOf` 推断都以它为准），会话内切目录会让锚点静默漂移。所以协调者预设 `preset-tools` 的 `deny` 与执行层 `COORDINATOR_DENY` 各列一份（预设层出生即生效、执行层再硬拦），`test/config.test.js` / `test/index.test.js` 双锁。看文件不需要它：`read` 收绝对路径。
- **A 片：grill-me 技能**。`skills/grill-me/SKILL.md` 随包发（`package.json.files` 含 `skills/`），`skill-grill-me.js` 在 `apply()` 里读该文件 → `parseSkillMarkdown` 解析 frontmatter（name/description/whenToUse，只认顶层标量）→ `ctx.skills.register({ name, description, whenToUse, content, source: 'bundled', path })`。注册进的是**调用方 context 的作用域层**（dsh-skill 的分层注册表：预设挂载的插件进该预设层，unscoped 插件进全局层），所以协调者预设挂的这份**只有协调者可见**，worker 预设没挂这个模块就看不到。`@deepseek-ai/dsh-tool-skill` 同挂该预设，提供模型面 `skill({name})` 与技能目录（目录随会话注入、只含 name+description，正文按需加载）。
- **不用 `customSkillDirs` 指目录**：patch 里的 `!!js` 表达式在磁盘上求值，`createRequire(baseUrl)` 在 bundle 里会 `MODULE_NOT_FOUND`（`test/config.test.js` 锁了这条）。运行时注册只依赖 `import.meta.url` 解析出的 SKILL.md 文本，安装目录在哪都成立。
- **L1 只加一行触发语**（判为 T2/T3 时先 `skill({ name: 'grill-me' })`），技能正文不进系统提示；SKILL.md 缺失或格式不合法时只 `warn`、不注册——技能是增强项，不能让协调者预设挂载失败（`test/skill-grill-me.test.js` 覆盖）。
- **协议**：多轮前沿提问（一次一个决定性问题）、每问带我的推荐、事实自己查、决策归用户、最多 2 轮 8 问、最后给三栏决策记录（决策点｜你定的｜影响），与交互三闸门 T2/T3 衔接；**grill ≠ 批准**。灵感来自 Matt Pocock 的 grilling（MIT），措辞重写。

## 只读子任务

`readOnly:true`（只认显式 true）在 `agent/created` 一到就给子会话 append `sandbox/mode {mode:'read-only'}`，激活后再幂等补一次，续派/重启会再补；只读任务不注册 target 可写根。

## per-task 完整访问（`access:'full'`）

`access:'full'`（只认显式 `'full'`）**复用只读的整条注入路径**，只是模式换成 `danger-full-access`：`ensureSandboxMode(childId, mode)` 在 `agent/created` 一到就 append（`source:'delegation'`），激活返回后再幂等补一次，续派/冷恢复再补；`taskOf` 只把 `tasks.access='full'` 当真。普通任务（不传 `readOnly`/`planFirst`/`access`）同样走这条入口，显式钉 `workspace-write`：宿主会把父会话的显式 `sandbox/mode` 覆盖按 `source:'delegation'` 种进每个子会话（`@deepseek-ai/dsh-subagent` 的 `appendDelegatedPolicyOverrides`），主会话钉成只读后不写回来，子任务就会跟着只读、写不了文件。都不碰默认配置、不碰父会话。视图：brief `【访问级别】完整`、`task_detail`「访问级别：完整」、`task_list`「·完整访问」、`task_status`「访问级别：完整」、通知标题「（完整访问）」、日志 `subagent.full-access` / `subagent.read-only` / `subagent.workspace-write`。

## 计划阶段（P8）
`planFirst:true` 的任务 = **只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）**；不开 `planFirst` 的任务行为一字不改。

- **进入**：`queue.pump` 从台账透传 `plan_first` 给 `dispatcher.spawn`；派发时复用 `ensureReadOnly`（压首回合窗口），再用**子 agent 作用域**的 `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode；`planMode` 缺失只 warn（降级为只有只读沙箱）。批准前**不注册** target 可写根。
- **计划落盘（`plan_save`）**：复用 `artifact_save` 的 `artifact-store` 宿主受限保存实现，写入 `artifact_store_dir/docs/<安全任务名>-<版本>.md`；`artifact_dir` 仅暂存/引用，不是真源。调用重放幂等、旧版本不覆盖，保存后更新 `plan_path`，批准使用最新计划。参数仍只有 `task_id`/`content`，正文原样落盘，不解析待拍板元数据。子会话只回报 **3–8 行摘要 + 文档绝对路径 + 待拍板清单**，待拍板问题由模型生成并经 `ask_user_question` 逐项提问。
- **交付顺序（0.25.0）**：先回复计划摘要 + 计划文档**绝对路径**并 `present` 该文档 → 再 `ask_user_question`（四选一 **逐项确认 / 均按推荐 / 先看计划文档 / 放弃**；「均按推荐」必须用户明确点选）→ 用户选「先看计划文档」只展示正文/路径、不推进不催 → 选「逐项确认」按清单一项一问、答完先贴决策汇总（`renderDecisionSummary`）再做总批准核对 → 只有明确「批准」才续派实现。
- **出口**：`plan_save` 落盘 → `task_report blocked` 上报摘要 + 路径 → 用户决定 → 协调者 `task_message` 续派，**不用** `exit_plan_mode`（子会话没有直接人类）。插件在子会话 **agent 作用域**拒绝 `exit_plan_mode`（插件根的 guard 是全局的，会误伤协调者）。
- **批准闸门（人工 + 显式动作）**：**计划批准必须由用户拍板，协调者不得自行批准**（不得把用户沉默/含糊回应当成批准），且批准动作只能是 `task_message({ action: 'approve' })`——插件校验通过才切可写并落审计。普通 `task_message` 在计划任务上**不会批准**：`planning` 只记讨论、`waiting_user`/`revising` 转「修订中」，沙箱始终只读；用户答「调整」就把修改点原样转回同一个子会话（写明「只修订计划、不要开始实现」）并再 `blocked` 一次重新拍板。
- **approve 前置与结果**：`plan_state='waiting_user'`（= 已收到 blocked 报告）+ `status='waiting_user'`（子会话空闲）+ `plan_path` 已落盘，三条缺一给可读拒绝（`PLAN_APPROVE_*`，不动沙箱、不写审计）；成功 = `sandbox/mode=workspace-write` + `planMode.set(agent,false)` + 释放 guard + 补 target 可写根 + `plan_state='approved'` + 审计 `accepted_kind='plan'`，**不投递消息、不改 status**（协调者紧接着 `task_message` 续派实现）。
- **四态迁移**：

| `plan_state` | 进入条件 | 可用动作 |
|---|---|---|
| `planning` | 派发后只读探索 | `message`（只记讨论）/ `plan_save` / `task_report blocked` |
| `waiting_user` | 子会话 `blocked` 交回计划 | **`approve`（唯一批准入口）** / `message`（转修订）/ `stop` |
| `revising` | 用户在 `waiting_user` 上要求调整（收到 `message`） | `message`（继续修订）/ 再 `blocked` 回 `waiting_user` |
| `approved` | 显式 `approve` 成功 | `message` 续派实现 / `stop` / `close` |

- **停止/终态与视图**：释放 guard；`planning`/`waiting_user`/`revising` 进 `planSettled` 状态（含 `delivered`）收口成 `rejected`，`approved` 保留；台账 `plan_first` + `plan_state`（六值：`none`/`planning`/`waiting_user`/`revising`/`approved`/`rejected`）+ `plan_path`，审批审计复用 `accepted_by`/`accepted_at` + `accepted_kind`（`plan` vs 交付确认的 `delivery`；历史以 `task.plan.approved` 日志为准）；面板「计划」小标覆盖批准前三态，**面板没有批准入口**（`plan-approve` 仍是反例清单，计划批准只走协调者），非计划任务不下发任何计划字样；`planFirst` 与 `readOnly` 互斥。

## 任务引用（tk-）：ID 出口网关（版本 B）

目标：用户面与工具面不再出现台账内部编号（`t-xxxx`）。做法是**三层分治**，只有第 ② 层是硬的：

1. **不喂**（结构性）：参考值统一是**任务引用**——`task_refs` 表（`token` 主键、`task_id` 唯一、`retired_at` 墓碑），`token = tk-` + 6 位（字母表去掉 `0/1/l/o/i`）。生成时机：`createTask` 与任务行**同事务**（`SAVEPOINT`）、打开台账时幂等回填（`LEFT JOIN … IS NULL`）、`getTask` 命中无 token 时懒补。删除任务置墓碑、**永不复用**。读任务行一律 `LEFT JOIN task_refs` 带出 `ref`，所以面板/回执/详情不必各自查表。brief、`task_list`、`task_status`、`task_detail`、通知、`resume` 提示、对账/看门狗摘要、面板与抽屉都只写「任务名 + 引用」。
2. **写入前清洗**（`src/user-facing.js`）：标题、`task_report` 的 summary/question/options/产物 label、`plan_save` 正文在**落库/落盘前**把台账里**真实存在**的编号换成引用（命中记 `task.ref.sanitized`）。只认台账已知编号——不做泛化脱敏，真实文件路径（例如历史 `reports/plans/t-xxxx.md`）一个字都不改。
3. **宿主改写（未做，版本 C）**：`llm/stream` + `tools/post-execute` 能改回复正文与工具结果，但那要 patch 宿主行为；先按本版上线实测泄漏率再定。

接口不变：参数仍叫 `task_id`、仍接受台账编号；`resolveTaskInput`（`src/task-ref.js`）是**五个 `task_*` + `plan_save` 的唯一解析入口**——先按 `t-xxxx` 查台账，未命中再按 `tk-` 查引用，空值/未知值/已失效都给可读文案（不出现表名/SQL/内部列/裸编号），不支持 session id 别名、不做空参绑定。`task_create.dependsOn` 同样接受两种值并归一成台账 id 落库。

白名单（**不清洗**，审计真源）：`tasks.id`、`messages`/`notifications` 的 `task_id` 列、`logs`、`handoff/*.jsonl`、官方 Team 板 id、`worktree` 路径与分支名（`orch/<taskId>`）。计划文档文件名同理不迁移：历史 `t-xxxx.md` 保持原样。

## worktree 隔离（P9）

`task_create({ worktree: true })` 时插件在**宿主进程**建检出，子会话在检出目录里干活；不开 `worktree` 的任务行为一字不改（**一次 git 都不调**）。

- **声明只有结构化两处**：profile 配置 `worktreePolicy` / `worktreeBranchPrefix` / `worktreeRecentDays`，以及 `task_create.worktree*` 字段。插件**不读** `AGENTS.md`、**不解析**自然语言：「要不要隔离」由协调者判断。
- **模块**：`src/worktree.js` = 宿主侧 git 能力（`probeRepo` / `create` / `remove` / `ensureExcluded` / 分支名校验 / `prepareTaskWorktree` / `cleanupTaskWorktree` / `retryWorktreeOf`）；`src/worktree-request.js` = 结构化请求校验 + 机械映射 + 展示文案（纯函数）。
- **创建期**：先互斥校验（`readOnly`/`planFirst`）与复用查找（`worktreeMode:'continue'`，按 `worktree_path` 判活跃占用——被占用就拒绝并给「dependsOn 串行 / `worktreeMode:'new'` 新建」两条路，`task.create.rejected` 记 `reason: checkout-busy`）；真要建时才 `probeRepo`（普通任务零 git 调用）→ 非仓库 `degrade`；基线：显式 `worktreeBase` 要 `rev-parse --verify` 通过、缺省时 n=0 用默认分支 / n=1 用那条 / **n≥2 返回 `needsBranchChoice` 且不落库**。落库七列（`worktree_path` / `_branch` / `repo_root` / `_base` / `_mode` / `_source` / `_state`），`state='requested'`。
- **派发期**：`git worktree add -b <branch> <repo>/.agents/worktrees/<taskId> <base>`——**永远 -b 新分支**（直接检出已在主工作树检出的基线会被 git 拒绝）；`reused` 不调 git，只换算路径；`target_dir` 换成「检出目录 + 原 target 相对 repoRoot 的偏移」。建树失败标 `failed` 并写原因（不静默降级）。
- **`.git/info/exclude`**：建树成功后把 `.agents/` 追加进去（幂等、不动 `.gitignore`；不可写只 warn）。
- **清理三档**：`off`（默认，全留）/ `checkout-only`（只 `worktree remove`）/ `full`（连分支一起删，有未合并提交会提示）；在终态异步跑，失败只记日志。
- **产物语义**：产物在检出目录里，**用户工作树没有这些改动**；平台没有合并工具，插件也不提供。

## 目标目录推断

不传 `target` 时，用 `title` + `goal` 匹配 `workspaceRegistry.list()` 的显示名与路径末段：精确名优先、否则子串层；纯 ASCII 键至少 3 个字母数字，CJK 至少 2 字；通用末段（workspace/documents/desktop/default/src/app/tmp）不参与匹配；被更具体名字严格包含的泛命中丢弃；唯一命中写 `target_dir`，多命中不建任务、列候选，无命中沿用主会话目录；registry 不可用时按无工作区降级。

## 能力包（0.32.0）

- **分层**：`src/pack/manifest.js`（schemaVersion 2 校验：路径不越界、精确版本、pnpm + registry 白名单、env 只声明不落值）→ `store.js`（唯一写入根 `$DSH_HOME/state/orchestrator/capability-packs`、原子写、`.trash` 回退）→ `preset-template.js`（固定预设行：写/执行/skill/web/todo，禁 `task_*`/`plan_save`/`capability_pack`）→ `preset-registry.js`（`agentPresets.register()` 运行时注册，失败降级静态 YAML）→ `install.js`（包内 pnpm 安装、确认卡、版本校验、realpath 入口、render 冒烟）→ `wenyan.js`（render/publish 封装、错误映射、草稿记账）→ `service.js`（dry-run/confirm/幂等/回滚的唯一闸门）→ `tool.js`（`capability_pack` 工具）与 `panel.js` + `host-route.js`（面板只读快照 + 窄写口）。
- **数据**：内置包随插件只读发（`packs/`，`packs/wechat-mp-article`）；用户包与全部运行期状态在 `capability-packs/{packs,tools,.trash,registry.json}`。`cli.invocation` 是运行期事实，写在 `.state/install.json`，不回写内置 `pack.json`。
- **安装链路**：argv 数组 + `shell:false`，`--ignore-workspace --ignore-scripts --registry=https://registry.npmjs.org --store-dir <tools>/.store`；装后校验锁定版本、`realpathSync.native()` 解析 bin 入口、跑 `--version` 与 `render` 冒烟（带 `APPDATA`/`LOCALAPPDATA` 重定向）；任一步失败删 `tools/<id>`、记 failed、包与技能照常可用。
- **闸门**：`create/update/delete/install` 都要 `confirm:true`（安装还要求 `planHash`）；`clientRequestId` 请求级幂等；更新失败把旧目录从 `.trash` 搬回；内置包只读；能力包会话只调 `sessionController.create({cwd, agentPreset})`，不写台账、不进队列。
- **安全**：插件不落盘、不读、不回显凭据值；`setx` 执行需二次确认、只回 `{ok, code}`；审计只记 `{ref, mode, result}`；`render`/`publish` 不自动重试（无幂等），重复建草稿前必须问用户。

## 路由与面板

`POST /api/orchestrator`，connection owner-only：

| endpoint | 作用 |
|---|---|
| `snapshot` | 只读快照（含 `handoff` 精简版、`teamBoard`、任务行 `acceptance` 摘要） |
| `open-main` | 创建/打开主会话 |
| `main-nav` / `main-nav-ack` | 读「跳到新主会话 / 一条可读提示」的进程内待办；客户端处理完 ack（id 匹配才清） |
| `detail` | 任务详情、消息、依赖、产物、最新回复、交接、官方板关联 |
| `artifacts` | 产物汇总（项目/日期分组所需字段） |
| `preview` | 预览台账里登记的文本产物（前 64 KiB） |
| `stop` / `retry` / `message` / `delete` | 面板动作（门控见 `src/panel-gates.js`；`message` 仅可续派状态，但面板已无「追加」按钮） |

面板 2s 轮询，连续失败退避 30s；`canDelete` 由服务端判定并随 snapshot/detail 下发。

工作台 v1 的只读投影与窄写口同挂这一条路由：只读 `groups` / `group` / `calendar` / `automations` / `stats`（复盘页的窗口统计——交付数、确认数、平均「创建→交付」时长、失败归因（`tasks.error` 首行）、产物类型（按路径扩展名，不读文件内容）、组维度排行与消息条数；窗口 ≤62 天、缺省 7 天，只读台账既有时间戳）；写 `group-save` / `group-archive` / `plan-set` / `automation-save|toggle|delete`（`clientRequestId` 幂等 + 危险动作 `confirm:true` + 审计）。**0.33.0 起 `automation-save` 的创建分支面板不再调用**（创建改走主会话里的官方 `schedule_create`），端点保留给兼容/脚本，`toggle|delete` 仍由面板使用。**刻意没有** `task-create` / `plan-approve` / `close-all` / `task-message` / `patch-task`。

工作台（任务台）六页与边界：

- **总览**：4 张指标卡（点击即切筛选）、今日排期、下一条自动化、待你决定提示、任务卡列表 / 产物库。
- **任务组**：按 `task_create({ group })` 聚合，组卡显示进度、待确认/在跑/失败计数、产物数、下次排期与自动化小标；没有 group 的任务单列「未分组」（不落库、不可改名）。组名可改，**组键（`tasks.group_id`）不可变**——worktree 检出复用与 `task_list({ group })` 都按它判定。
- **组工作台**：状态列板（等前置/待派发、在跑、待确认、待你决定、完成、失败·取消）+ 右侧 dock + 详情抽屉 + 产物格。列板只做筛选，**不支持拖拽改状态**。
- **排期**：月历（周一起始）拖任务到某天即排期，拖回「待排期」取消；另有任务卡里的「排期」按钮（不依赖拖拽）。右栏的「待排期」是**派生分组**不是任务状态：`waiting_dep`/`pending` 且没有计划日才算待排期，`running`/`waiting_user`/`waiting_auth` 归「进行中」，`delivered` 归「待确认」，有计划日的任务只出现在月历与「下一条」（`client/src/logic.js` 的 `scheduleBucketOf`/`scheduleGroups`，状态机与 `planned_at` 语义都不变）。**两层互不推导**：L1 计划日（`tasks.planned_at`，纯展示）与 L2 自动化触发（`automations` 表镜像 + 宿主 `ctx.schedule` 真身）——排一天不会自动派任务，建自动化也不会改计划日。
- **自动化**（0.33.0 对齐官方「会话创建」）：到点由宿主 `schedule` 投递一条话术给唯一主会话，协调者按话术 `task_list` 核对后再 `task_create`。创建入口只有**一个按钮**（卡头「创建自动化」，官方 primary/small 样式）：点击 → `open-main` → `uiWorkspace.openSession(主会话)` → `conversation.input.requestDraftInitialization(binding,{prompt,whenDraftExists:'append'})` 把提示词写进主会话输入框，由主会话里的模型调官方 `schedule_create` 创建（默认绑定主会话）。**面板不再自己建自动化**，也不再按组绑定（范围只有「全部任务」一种语义，写在提示词里）；列表只读本插件 `automations` 镜像表，卡头另有「官方自动化任务页」（`layout.selectPanel('schedules')`）看全部宿主任务。暂停/恢复/删除仍走 `automation-toggle|delete`（二次确认 + 审计）。宿主没有自动化服务时整页只读降级。
- **复盘**：三张数字卡（交付数、确认数、平均「创建→交付」时长）+ 失败归因横向条（`tasks.error` 首行，最多 5 类）+ 产物类型分布（按扩展名，最多 8 类，**不读文件内容**）+ 组维度排行（最多 10 个组）+ 窗口内 `messages` 条数；只读台账既有时间戳，不新增埋点、不新增写口。
- **右侧 dock 是只读镜像**：摘要、最近消息、阻塞问题、`打开子会话` 与 `到主会话说` 两个跳转；没有输入框、没有发送按钮、没有「批准计划」——**不代发消息、不代批计划**。刻意不做：新任务直写台账（只生成派单草稿）、批量确认交付。

## 面板与详情（UI U2）

面板是 `ctx.slots.register({ name:'main', key:'orchestrator' })` 的整块组件。四件事值得记在架构里：

- **构建链与产物路径**：客户端源码在 `client/src/**`（ESM），由 `vite.client.config.mjs` 构建成 `dist/client.js`（iife classic script + `.map`），**产物入库**。平台按 `exports["./client"]` 把该文件原样 serve 成 `/plugins/<id>/client.js`，路由只服务这一个 JS（+ 同名 `.map`），`.css` 一律 404 → 样式必须 `?inline` 回 JS（构建期内联成 `STYLE_TEXT`，`ensureStyles()` 按 id 去重注入）。改 UI = 改 `client/src/` + `pnpm run build`。
- **体积闸门（P2-5 → 工作台 v1 → 0.32.0 能力包）**：默认开 esbuild minify（`sourcemap: true` 保留；`CLIENT_MINIFY=0 pnpm run build` 出可读产物），产物 ≤ **160 KiB**（工作台 v1 由 95 KiB 抬到 148 KiB；0.32.0 能力包面板没有代码分割，只能加进同一产物 → 用户拍板抬到 160 KiB；0.33.0 自动化创建入口与删表单是净减，不抬预算。子预算表在 `scripts/check-client-size.mjs` 头部，合计 = 160）由 `scripts/check-client-size.mjs` 断言，挂在 `pretest` 与 `prepublishOnly`。源码分模块：`index.js`（只注册 factory）→ `client.js`（装配 + `apply` + `__test`）→ `views.js`（面板/抽屉/启动器/工作台壳）→ `workbench.js`（总览/任务组/组工作台/排期/自动化/复盘六页 + dock）→ `ui.js`（展示件）、`styles.css`、`logic.js`（纯函数）、`api.js`（宿主 HTTP 契约）、`gate.js`（入口闸门）、`constants.js`（文案/常量）。
- **三段式与抽屉**：顶部命令栏（标题/主会话状态/搜索/刷新/打开主会话 + 4 张指标卡）、中部（筛选轨 + 任务卡列表 / 产物库）、右侧详情抽屉（概览、最新回复、Brief、验收、交接、目标状态、消息、依赖、产物）。抽屉常驻挂载、`data-open` 驱动 `transform` 过渡；每区块可折叠（`aria-expanded` + `0fr↔1fr`）都有空态。列表侧纯逻辑提到组件外（`countTasks` / `matchesFilter` / `matchesQuery` / `groupArtifacts`），单测直接断言行为。
- **按钮可见性与动作门控同源**：`src/panel-gates.js` 是唯一判定（`followupGate` / `deleteGate`），服务端面板动作与 `task_message` 都先过它，`snapshot`/`detail` 把 `canFollowup` / `canDelete` 下发，客户端只读这两个布尔值渲染按钮。删除 = 终态且没有活跃下游依赖，只清台账行（任务 + messages + notifications），不删产物文件与 memories。
- **P2 的只读视图**：官方 Team 板分区（折叠、行内无按钮、`enabled !== true` 整区不渲染且不显示提示条；`enabled:true` 但这次读不到时只给一条降级提示）、抽屉「交接」区块（契约版本/交付与确认时间/谁确认/轮次/验收结论/官方板关联）、任务卡「验收 2/2」小标（来自 `snapshot.tasks[].acceptance`）。

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

- **常用工具**（11 个，完整清单与角色差异见 [TOOLS](TOOLS.md#工具清单)）：协调者 `task_create` / `task_list` / `task_status` / `task_message` / `context` / `memory_note` / `read_workspace` / `capability_pack`（另有预设自有的只读 `read`、`skill`、`present`、`schedule_*`，不计入这 11 个）；子会话 `task_report` / `task_detail` / `plan_save` / 共用的只读 `context` 与**只能写自己任务目录项目记忆**的 `memory_note`。
- **面板动作与错误码同源**：面板 stop / retry / message / delete 与 `task_message({action})` 共用 `src/action-errors.js` 的 code 与门控；面板失败返回 `{ok:false, code, error}`，`host-route` 按 code 映射 HTTP 状态（400 参数 / 404 不存在 / 409 状态冲突 / 502 投递失败 / 500 内部）。
- `stop`：已结束再 stop 返回 `{ok:true, already:true}`；收子会话失败不阻断取消（`warnings[].code=STOP_DISPATCH_FAILED`）。
- `retry`：只允许 failed/orphaned；已有活跃重派直接返回那条任务；同 title+goal 的其他活跃任务返回 `RETRY_DUPLICATE_ACTIVE`。
- `message`：只允许 running / waiting_user / waiting_auth / delivered 且已有子会话（`delivered` 上是追问）；错误码 `MESSAGE_TASK_ENDED` / `MESSAGE_WAITING_DEP` / `MESSAGE_NO_SESSION` / `MESSAGE_NOT_FOLLOWABLE` / `MESSAGE_DELIVERY_FAILED`。面板每次点击生成 `clientRequestId`，按 `(taskId, clientRequestId)` 进程内去重。
- `resume`：只允许 `failed` / `orphaned` / 超时收尾的 `done`，且已有子会话、隔离检出未清理（`src/resume.js` 的 `resumeGate`，与 `retry` 的分工写在文件头）。投递走 `dispatch.send` 的同一条冷恢复链（幂等补沙箱/可写根/goal），成功后 `attempts` 与 `resume_count` 自增、清死因与 `close_reason`；**投递失败只报错回退**（`RESUME_UNREACHABLE` / `RESUME_DELIVERY_FAILED`，文案指向 retry），绝不静默新建任务。历史消息 > 60 条只回「建议 retry」，不拦截。台账列 `resume_count` / `last_stop_reason` 由旧库 ALTER 补。
- `delete`：只允许终态；还有活跃下游返回 `DELETE_HAS_ACTIVE_DEPENDENTS`；成功时级联删 messages / notifications，产物文件与 memories 不动。
- **边界**：依赖只能指向已存在任务、不支持编辑；`writeScopes` 是冲突提示不是文件锁；`done` 不可逆、不提供 reopen；台账每天快照，损坏要手工恢复（见 [LIMITATIONS](LIMITATIONS.md)）。

### 插件页配置卡片

插件页（侧栏「插件」→ dsh-orchestrator 详情）的「配置」卡片：**25 个字段**，与 `loadConfig({})` 的实际键集合一一对应
（已删键不出现在表单上——P2-2 删的 7 个 `keepAlive*` 与阈值键、0.25.0 删的轮换 8 键——只由 `src/config.js` 的 `DEPRECATED_KEYS` 给弃用警告），等价于手改 profile 的 `cordis.patch.yml`。DSH 的插件配置 UI 是「插件自带组件」模型——宿主只提供 `configForms`（值 + 写操作）与 slot，**不生成表单**（0.2.2-rc.3 的 `autoGenerate` 字段全 asar 无 client 消费方）。

**三件套**（字段规格只声明一次，三方共用，避免漂移）：

| 文件 | 职责 |
|---|---|
| `src/config-fields.js` | 字段单一事实源：名称/类型/枚举/区间/默认/只读/分组 |
| `src/config-schema.js` | 投影成 schemastery `Config`（每字段 `.default().loose().volatile()`）+ `unwrapVolatile` + 降级加载 |
| `client/src/config-form.js` + `config-logic.js` | 分组折叠表单；纯逻辑（`buildOps`/`isDirty`/`parseInput`）单独拆出以便 node 直测 |

**注册的三个 key 各不相同**（写错任一处都是静默不渲染）：slot 名 `plugins.bundle.config`；
slot key = bundle **包名**（`CONFIG_SLOT_KEY`）；`configForms.get()` / `whileServed()` 参数 = Loader **entry id**
（`CONFIG_ENTRY_ID` = `orchestrator`，即 `cordis.patch.yml` 的 id）。`whileServed` 保证插件没加载时页面完全无痕。

**暴露策略**：**除 `coordinatorSession` 外全部可编辑**（含 0.25.0 新增的 `contextPressureThreshold`：插件自己的提醒阈值，改它不改宿主压缩）；
**`coordinatorSession` 只读**（运维兜底通道：填错会让协调者指向不存在的会话，
且只能改配置才恢复，只在运维场景手改 `cordis.patch.yml`）。不可逆动作（归档/删除会话）已不在插件里，插件只切指针。
写通道 `mutate(ops, revision)` 带 revision 栅栏，别人先改过就拒绝并刷新，
不静默覆盖；清空一个「已覆盖」字段发 `unset`（回落组合默认且不再算覆盖）。

**保存语义（0.23.0 发版前冒烟订正）**：保存**只**写当前 profile 的 `cordis.patch.yml`——运行中的插件实例**不会**重新 apply，
判定/计时器仍按启动时那份配置，**重载插件或重启 DSH 后生效**（台账在 SQLite，不受影响）。卡片回执/简介、README 与 LIMITATIONS 都是这一口径；0.23.0 及以前回执写的「保存后热重载」与实际不符，别按它做用户承诺。

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
`rotateAfterDiskMiB`、`rotateCheckIntervalHours`）与 0.25.0 删掉的轮换 8 键（`mainRotation` / `rotateAfterMainLogMiB` /
`rotateAfterDays` / `rotateCooldownHours` / `rotateMinAgeHours` / `rotateIdleMinutes` / `rotateCheckIntervalHours` /
`rotateArchiveOld`）由 `src/config.js` 的 `DEPRECATED_KEYS` 给一次性迁移提示；
它们**不出现在配置卡片上**（字段表不含），无需 UI 侧额外接入。

## 落盘与日志

```
$DSH_HOME/state/orchestrator/
  tasks.sqlite
  snapshots/tasks-YYYY-MM-DD.sqlite
  logs/YYYY-MM-DD.jsonl
  handoff/handoff-YYYY-MM-DD.jsonl  # 交接契约 v1 事件（task.handoff.*，保留 30 天）
  lessons/<项目>-<short-hash>.md   # task_detail 经验指针指向的记忆文件（每次派发覆盖）
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
