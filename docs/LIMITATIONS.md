# 已知限制

本文件记录维护者需要知道、但不必塞进 README 的边界（README 只留用户会踩到的几条，细节都在这里）。
每条都是**当前实现的真实边界**，不是 todo；改实现前先读对应章节。

## 恢复与数据

- 台账每天生成快照，但**不自动恢复**；损坏时手工用 `snapshots/tasks-YYYY-MM-DD.sqlite` 替换 `tasks.sqlite`。周期内重启不会重复覆盖。
- 产物自动收集依赖平台 `workspace/changes` + `workspaceChanges`：Host 没挂这两个能力、会话在摘要登记前被释放、或改动发生在临时目录时收集为空；显式 `task_report.artifacts` 始终保留。当前回合的摘要要等 turn stopping 才追加，`task_report done` 当刻只能收到之前回合的摘要（当前回合由 `session/event` 监听在微任务里补收）。
- 产物预览只读前 64 KiB 文本；二进制/目录只显示元信息。详情与产物页只能**复制路径**，不能直接打开本地文件（网页不允许脚本静默打开）；「打开子会话」打开的是产出它的任务会话，不是文件。
- 消息投递状态（待发/已投递/失败）写在 `messages.meta_json`；A3 之前的旧行没该字段，只能按紧随的 `delivery_failed` 行推断，失败行落到 50 条消息窗口外的会显示成已投递。
- **最新返回消息只留最后一次**：≤64 KiB 内联 `tasks.last_message_json`，更大写 `reports/<taskId>.md`（台账只留路径 + 240 字摘要）；后续回合/续派会覆盖，没有历史版本。`reports/` 不参与每日快照、没有保留期清理；手删报告后 `task_status` 仍显示摘要，`include:'full'` 给出读取失败原因。
- **只认结算事件**：插件在结算前被卸载、或进程被杀时没有返回消息可落；`subagent.failed`（激活被拒）本身没有输出，只留死因。

## 目标（G1）与自动续跑（P2-2：委托宿主 goal）

- **默认不续跑**：`goalRounds` 默认 0 —— 派发后 `create` 立刻 `disarm`，与旧行为完全一致。要续跑必须按任务显式传 `task_create({ goalRounds: N })`（1–50）；配置面上的 `keepAlive*` 四键已删除（弃用警告 + 按默认运行）。
- **续跑能力属于宿主，不属于插件**：插件只把平台 goal 建成 armed 并给 `maxGoalRounds`，之后由 `dsh-goal-round-driver` 在回合结束后续轮。旧宿主没有这个 driver（或裁剪 profile 没挂）时**不会续跑**，插件只记一条 `goal.degraded`，不注入消息、不模拟续跑。插件不再订阅 `agent/turn-stopping`，也就不会和别的插件抢 inbox。
- **轮次预算不归插件管**：`tasks.keep_alive_rounds` 停写（列保留兼容旧库），进度看平台 goal 的 `roundsStarted` / `maxGoalRounds`。`maxGoalRounds` 是「最多续几轮」，**不是成本上限**：单轮工作量、工具调用次数都不受它约束，子会话仍可能继续花钱。
- **计划模式不接受 `goalRounds`**：计划任务每轮结束都要停下来等人批准，自动续轮会绕过批准闸门；批准后用 `task_message` 续派。
- **外部 re-arm 不实时压回**：`goalRounds=0` 的任务只在 spawn/续派/终态钩子上压 `disarmed`；别的组件（宿主 `/goal resume`）把同一子会话重新 arm 时，下一次钩子才处理，中间平台可能自动续轮。
- **不是所有环境都有 goal**：`ctx.goals` 缺失、旧 profile 或方法被裁剪时静默降级——不创建、不 warn、不影响派发/续派/结算；台账与面板不显示 goal 状态。
- **子会话写入限制**：goal 只能由宿主对本插件注册表里的 live agent 操作。冷恢复/重启后子 agent 未进注册表时 `attach`/`update` 最多等 3 秒，超时跳过；该轮不补建，下一次 `task_message` 成功后才可能补上。
- **目标不自动注入子会话**：平台 `dsh-goal` 只管状态与投影，不往系统提示/消息里写 objective；子会话要看**实时**目标必须自己 `get_goal`（worker 预设有 `tool-goal` 行；缺它就读不到之后 `task_message` 并进去的「最新指示」，创建时的目标快照仍能从 `task_detail` 拿）。`create_goal`/`update_goal` 要**顶层 agent 的直接人类回合**（`GOAL_TOOL_AUTHORITY_REQUIRED`），子会话调用必被拒。目标文本 = `task.goal` + `最新指示：<消息>`，超 2000 字符截断。
- **终态收敛的边界**：`done→complete`；`stop/retry/orphaned/failed→clear`。孤儿/失败时子 agent 往往已不在注册表，平台侧不会真的 `clear`，插件只把台账镜像标成 `cleared`。面板只读：能看 phase/activation/轮次/修订，没有暂停/恢复/清除的按钮或工具。

## 子会话与检查（A1）

- **brief 只有编号和指引，详情要自己取（T1）**：brief 只有 `【任务编号】` + 三条回报指引；子会话第一个动作应当是 `task_detail`。若它跳过，只能靠 `get_goal` 与自身上下文；前提是工具表里有 `task_detail`——换成自带 allow 名单的 `workerPreset` 时要把它列进 allow。
- **子会话不能直接问用户**：`userQuestions.ask` 的 `assertLiveRoot` 对 `origin === 'subagent'` 抛 `DELEGATED_CALLER`。要拍板只能交回协调者：`blocked`/`needs_auth` 带 `question` + `options`；`done` **不支持** `question`/`options`（`clearTaskQuestion` 会把它们清空），要点必须写进 `summary`。
- **`blocked` 上报不等于授权**：它只是把决策点交回协调者；子会话不能因为「报过 blocked」就自行推进，也不能拿它绕过推送前双审查或人工确认门禁。
- **检查跑在宿主进程，不是沙箱**：`checks` 按宿主权限执行（命令只来自协调者的 `task_create`，子会话无法注入）。cwd 固定为任务 target / 检出目录，**不继承主会话目录**；没有 `target` 或 `readOnly` 的任务不接受 `checks`。环境差异（命令不存在、CI 专用命令）用 `skipIfMissing`，不是绕过闸门。
- **超时/失败语义**：超时先 SIGTERM、5 秒后 SIGKILL；失败即拒绝交付（状态不变），**确认交付与超时 sweeper 都不重跑**检查。
- **worktree 装依赖提示只是「允许装」**：`【worktree 依赖】` 只在隔离任务里出现，措辞限定「只安装不升级」；插件不代为执行、不保证锁文件不变。
- **经验文件是快照，不是台账（T1）**：`lessons/<项目>-<hash>.md` 每次派发覆盖为本次命中事实层记忆；无历史版本、不参与快照。手删后 `task_detail` 指针显示「已丢失」（下次派发重建）；写文件失败时经验改为只出现在 `task_detail` 的内联块。
- **`task_detail` 只读且只给自己**：按创建时 `brief_json` 返回目标/验收/检查/经验，前置与产物按**当前**台账现读；主会话或别的子会话调用被拒。
- **子会话能读上下文，但不能写记忆**：`context` 三种 mode 对子会话只读开放（与协调者同一条实现）；`memory_note` 不在子会话工具表里（worker 预设 `preset-tools` 的 `deny`）。若换成自带 allow 名单的 `workerPreset`、或旧会话里它仍在表上，执行层会拒绝并给替代路径（`task_report` 的 summary / `context` 只读查 / 请协调者记），记 `memory.note.rejected`。**能力声明在预设层、执行层只做只读语义兜底**：预设没生效时工具会「看得见但写不了」，而不是运行时按角色开关。
- **`context` 不是任意文件读取**：只读台账/记忆/已登记工作区与白名单文件（README/AGENTS/package 等），不枚举全盘、不读 `.env`；子会话拿到的默认项目目录仍是主会话目录（要读自己的目标仓库请显式传 `target` / `project`）。

## 交接契约（D2）

- **v1 只有文件级事件**：没有进程内订阅 API / webhook（留 v2）；读方按 `(event, taskId, deliveredAt)` 去重，文件只追加不改写。
- **字段只增不改**：改名/改语义必须升 `contract`；v1 之前已 `done` 的存量任务没有 `handoff`（不是空壳对象），面板显示「没有交接记录」。
- **事件是审计旁路**：写入失败只 warn，不影响交付与确认；保留 30 天，超期自行清理，没有归档提示。

## 官方 Team 板（D6）

- **只读 + 可选反写**：插件不接管官方派发/认领/生命周期，也不把官方任务同步进台账；面板里是只读分区，行内没有按钮。
- **官方板挂在 subagent 树**：一旦派发改走 root 工作区会话，D6 整段失效——所以不做 workspace 第二后端。
- **反写失败只 warn**：CAS 冲突只重读一次、再试一次，仍冲突记 `team.board.stale` 并停手；本地 `done` 不回滚。**超时自动完成不反写**（那不是人的确认）。
- **官方 API 是 rc 级私有契约**：全部经 `host-capabilities` 惰性取 + fail-soft，缺服务/形状变化就整段降级（`degraded`），不影响现有编排。

## 编排

- `dependsOn` 只能指向已存在任务；没有「编辑依赖」接口，因此不会成环。前置失败后下游标 `failed`；恢复要先重派前置再重派下游。
- **同写域并发防护是「事后判定 + 可绕过」的护栏，不是文件锁**：`sameDirGuard=require` 只在 `task_create` 那一刻按台账判定，三条放行路（关闭/停止旧任务、`worktree:true`、`allowConcurrent:true`）；显式放行后两个子会话仍会同时写，冲突要人兜。判定是**路径字面量**比较（绝对路径相等/父子目录），不解析符号链接与 `..` 之外的挂载点/大小写语义；两个不同路径指向同一实体目录（bind mount/软链）时判不出来。`writeScopes` 是声明不是事实。
- **防护只覆盖 `task_create`**：`retry` 与面板「重派」按原 brief/target 新起任务，不走这条判定。
- `priority` 只影响队列顺序，不抢占正在运行的子会话。连续 3 次 progress 无变化只提醒一次（固定口径），没有二次升级阶梯。
- 空闲看门狗（W1）只告警一次、不改状态也不 kill；去重表在内存，重启后允许再报一次。长时间跑测试的单回合可能被误判「可能卡住」——先用 `task_status` 核对。
- 面板组进度是 `task_list({group})` 文本 + 行内徽标，不是独立分组看板。

## 主会话与工具面

- `spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`wait_agent`/`team_task_*` 是 **agent scope 自注册**的团队工具，`restrict` 遮不到；执行层 `guard` 硬拦协调者，但工具表里仍可能看到残留。
- `config.coordinatorSession` 覆盖的会话没有预设保证，运行期 `restrict` 挂在回合边界：绑定当回合仍是全工具表，下一回合才收窄。同一回合并行发出、且在 guard 判定前就开始执行的 `wait_agent` 不承诺拦住。
- `run_code` / PTC：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；profile 配了 PTC executor 时协调者可能经它间接调用被 deny 的工具（desktop 默认没有）。
- **`workerPreset` 只在派发时生效**：续派/冷恢复沿用会话创建时的 `agentPreset`，改配置不切换已有子会话；值非法时静默回落 `dsh-orchestrator-worker`（日志一行 warn）。
- **`orch-debug` 调试预设**：复制随包「创造模式」组合，预设声明装在 profile 里；升级 DSH 后必须先 `node tools/debug-preset/cli.mjs --check` 看漂移，再重新生成并重装。预设可执行 Host 代码，不是沙箱；生成器与文档自 P1-E 起不随 npm 包发货（开发仓库 `tools/debug-preset/`）。

## 主会话轮换（G1）

- **归档不可逆，这是本功能最硬的边界**：`rotateArchiveOld` 默认 `true`，收尾把旧主会话改名「主会话（已退役 YYYY-MM-DD HH:MM）」再 `archiveSession()`。平台**没有 unarchive API**，插件也不提供恢复；能选的只有事前配置 `rotateArchiveOld:false`（只改名）或 `mainRotation:'off'`（完全不换）。**轮换默认开启（`mainRotation` 默认 `auto`）**：想完全不换就必须显式配 `off`。归档动作本身幂等，但「已归档」不可撤销。
- **判定只有一个调用点**：`main-session.openOnce()` 在**旧主会话 live** 时算一次。启动、`agent/created`、面板轮询、刷新都不判定；旧会话不 live 时走既有「隐式重建」，不算轮换。没有强制轮换的按钮/工具/端点。
- **检查粒度是「一天最多一次」，不是「每次打开都算」**：`rotateCheckIntervalHours`（默认 24，1–168）让判定前先看 `settings.main_rotation_checked_at`，没到间隔就**直接跳过采集与判定**。所以**刚调低阈值不会立刻生效**——当天已经检查过的话最多等一个间隔（或清掉该键再打开）。这个节流只决定「查不查」，不改变「换不换」：`rotateCooldownHours` / `rotateMinAgeHours` 照旧在判定里挡。`mainRotation:'off'` 同样受节流（一次检查仍会写「为什么没换」的日志，只是频率压到一天一次）。
- **判定是快照，动作前不复查**：`evaluate → rotateMain` 之间来新任务/消息/回合仍按旧结论执行；并发打开只生效一次（in-flight 复用），轮换后新会话未 live 的 **60 秒窗口**内再打开交回同一 id。
- **指标口径与降级**：只剩 `main-log`（`sessionPersistence.locate` + `stat`，坏则记 `degraded`、**不按 0 算**）与 `age`（`since`：先 `settings.main_session_created_at`，退 `header.createdAt`）。只有**两个因子全拿不到**才 fail-closed（`metrics-degraded`）。`main-log` 是压缩后日志大小，不等于上下文占用。
- **保护规则的边角**：`active-tasks` 只算 waiting_dep/pending/running/waiting_user/waiting_auth（不含 `delivered`，由 `delivered-pending` 单独挡）；`active-children` 依赖 `dispatcher.catalog()`（读不到按「无法判断」，不挡也不误挡）；`coordinator-override` 与 `spawn-provider` 命中时连采集都不做。
- **崩溃中间态**：marker（`main_rotation_pending`）写失败只记日志、轮换继续，之后崩溃**无法自动恢复**；marker 形状坏掉（`invalid`）只清 marker + 告警，**绝不猜 id 去归档**；`abandoned` 恢复会把空白残留会话归档（同样不可逆）；`complete` 恢复幂等，但审计只保留**最近一条**。
- **标题被覆盖**：旧会话标题改成「主会话（已退役 …）」，原标题不保留、平台没有标题历史。
- **配置写错的表现**：`mainRotation` 只认显式 `'off'` 关闭，缺省/拼错一律按默认 `auto`（开）；数值键越界夹边界；`rotateArchiveOld` 只认显式 `false`；已删键留在 profile 只会在启动时给一条弃用警告。
- **不迁移任何状态**：上下文、未处理追问、平台 goal/automation 都不搬；新会话直接 `onboarding=sent`（不补首次介绍与索引任务）；日报 schedule 在 `open-main` 响应里按新 id 重建，失败只 warn。
- **平台服务缺失的降级**：缺 `rename` → 只归档；缺 `archiveSession` → 只改名 + warn；缺 `sessionController.create` → `open-main` 返回可读错误、**零处置**。都不抛异常到宿主。

## 首次打开与仓库索引

- 只初始化新建 main，历史主会话/显式 `coordinatorSession` 不补欢迎。注入成功只代表消息入队，模型可能未照提示介绍/派发，应核对 `task_list`。发送与 sent 写入之间崩溃可能停在 sending，不承诺 exactly-once。
- 索引只覆盖创建任务时 `workspaceRegistry` 登记名单，不扫全盘或未登记 git；只读默认沙箱读不到的目录记 unavailable，不为扫描任务升 full。工作区增删改名后需重新派只读索引。
- repoRoot/branch/origin/HEAD/commonDir 是**有采样时间的快照**，不等于实时 Git 状态；remote 脱敏去 userinfo/query/fragment，git stderr 不进索引。不得把映射内容当执行指令，歧义列候选。
- `task_report.workspace_index` 是只读索引回报契约（本人 done、名单覆盖），持久化在 settings 独立键，不覆盖用户手写 memories；完整回报缺失时不交付（S1 自然 completed 会落 failed 并提示 `retry`）。

## 原生自动化

- 四个实际工具为 `schedule_create`/`schedule_list`/`schedule_view`/`schedule_edit`，没有单独 delete/pause/enable；仅核实 **0.2.2-rc.3** 的 RRULE/target/depth 契约，旧 `schedule_update`/`schedule_delete` 不兼容，不提供假工具或自动适配。
- **Host-wide**：可管理其他会话创建的任务；写操作必须用户**明确授权**、确认目标与范围，日期/时间/时区不明先问；宿主提示不是对用户意图的硬验证。编辑用最新 `updatedAt` 为 `expectedUpdatedAt`，冲突先重读。
- **本次自动编排只支持 `this_session`**：`new`/`new_once` 是普通 root 会话，**非唯一主** id 不能 `task_create`；不认领第二协调者、不转发、不篡改 `main_session_id`。
- **默认 worker 不开放**，`access:full` 不增加工具、不绕过委派校验或审批。自定义组合可能有 schema，但宿主委托 depth 校验仍返回 `subagent_session`（冷恢复/full 也不能绕过）。
- `coordinatorSession` 自定义组合不强行换预设：仅已有原生工具才可用。缺 Schedule 服务/定义在主会话边界给去重 warning 与能力缺失 policy，恢复后再检查；编排继续，不能模拟自动化成功。
- Host 必须运行；回执只代表投递，不代表模型/子任务完成。崩溃可能重复投递，删除不撤回已排队消息，不承诺 exactly-once。
- 回滚插件不会自动清除已授权的原生自动化；安装/加载与彻底重启另需授权（刷新页面不足）。

## 平台 / 沙箱

- `backend` 键已删除（P1-A）：派发只剩 subagent 一条路；老 profile 留着只会启动时给一条弃用警告。
- rc.3 子会话沙箱根取父会话目录（平台缺陷）：插件给 target 登记可写根，但 Windows 上只对 harness 文件工具（read/write/edit）生效，`pwsh`/`bash` 写 target 仍被拒；`target` 不要用符号链接。
- worker 不强制 chdir：`danger-full-access` 下模型给目标目录外的绝对路径仍可能写成功；硬约束只能调回 `workspace-write`。
- 升级 DSH 后必须重跑 `docs/probes/*` 契约探针（平台入参形状变过 rc.1 → rc.3）。
- **per-task 完整访问（`access:'full'`）**：等于本会话 `sandbox/mode = danger-full-access`，`fs`/`pwsh`/`bash` 全部解封——**写权限等于模型能改的一切**，没有额外护栏。首回合窗口同样存在。平台在派发时把父会话自己的沙箱覆盖按 `source:'delegation'` 种进子会话：父会话是 `danger-full-access` 时**所有**子任务默认完整访问（不是插件给的，`access` 只能往上设）。Windows 下只解除沙箱，**不解除平台审批/权限预设**，也不改 `chdir`。

## 协调者读产物（`read_workspace`）

- **边界 = 主会话工作区 ∪ 已登记产物**（`tasks.artifacts_json`）。子会话按契约把产物写在 target 目录内，那些路径不在工作区里，但**只要登记过就能读**；未登记的同目录文件仍被拒——读取面不是整个 target。
- **没回报 artifacts 的产物读不到**：`done` 时的自动收集只覆盖本轮被改动/新建的文件。
- **登记表不借符号链接放行**：登记一个指向别处的链接不等于登记真实路径。**已登记目录会放开子树**：回报「整个仓库根」会把面放得很大，属使用纪律。
- **不是全盘读，也不是 glob**：没有目录递归枚举、没有模式匹配；看目录就逐层读条目（一层最多 200 项）。符号链接逃逸、`../` 穿越、工作区外且未登记的绝对路径都被拒并写 `workspace.read.rejected`。
- **截断是常态**：默认 400 行、单次 ≤64 K 字符；单行超上限时只返回前 64 K 并标 `truncatedLine`。`offset`/`limit` 收字符串，非法值回落默认。> 4 MB 直接拒绝。
- **IM 外发风险**：profile 开了 IM 双向同步时，读进上下文的正文可能随「最终助手文字」同步到外部且**不可撤回**；涉密产物不要读进主会话——这是本能力最主要的残余风险，不是可配置项。
- **不用于校验存在性**：存在性仍由插件（通知路径已 `lstat`）与子任务保证。

## 状态与提示词的单一事实源

- **状态能力表只有一份**（`src/status-facts.js` 的 `STATUS_CAPS`）：新增状态只改这张表，其余引用自动跟上。**死边已删**：`running→done`、`orphaned→pending` 从未有调用点（要「直接完成」走 `running→delivered→done`）；v0.24 反过来给 `resume` 重开了 `failed→running` / `orphaned→running` / `done→running`（`done` 只认 `close_reason='timeout'`）。
- **`failed` 不是流程终态但已收尾**：`terminal:false`（能重派）、`releases:true`（释放资源）；对失败任务「停止」是幂等成功（`already:true`），不会被改成「已取消」。
- **续跑（`resume`）的边界**：只续 `failed` / `orphaned` / 超时自动完成的 `done`；`cancelled`（用户主动停）与确认过的 `done` 不续。只读/计划任务续跑后沙箱仍按原样（`readOnly` 就还是只读）；历史消息 > 60 条只**建议** `retry`（冷恢复要重放历史，可能比新派贵），不拦截；子会话不可达时报错回退、**不静默新建任务**。
- **worktree 状态转移会校验**（`WORKTREE_TRANSITIONS`）：非法转移抛错而不是静默写入。
- **提示词五层各有独占职责**（`src/prompt-layers.js` 的 `PROMPT_LAYERS`）；`layerViolations` 是机器可读归层探针，测试用它防「删掉的重叠又抄回来」。
- **偏好不是权限通道**：只是 `settings.orchestrator_preferences` 里的提示词文本，不进 config、不改 dispatch、不碰 `sandboxPolicy`；内置种子里不放「放宽安全边界」的条目。超限（默认 12 条 / 1200 字）按 priority 降序保留并写明「另有 N 条未展示」，被截掉的**不会生效**也不报错。

## 计划阶段（P8）

- **plan mode 是软引导**：平台只注入一段系统提示，不拦工具、不写沙箱状态；真正挡住写入的是只读沙箱。模型仍可能反复尝试写，被拒错误会回灌给它。
- **服务可见性**：`planMode` 挂在子会话预设作用域，插件必须走 `agent.ctx.get('planMode')`；没挂时静默降级为「只有只读沙箱」并 warn 一行，派发不受影响。`exit_plan_mode` 被拒（子会话没有直接人类），出口固定是「`plan_save` 落盘 + `task_report blocked`」。
- **计划文档只有一版**：重复 `plan_save` **覆盖**同一份文件，没有版本对比、没有审批流 UI。计划路径绑主会话工作区：换主会话/工作区后新计划落新目录，旧文件留原处。
- **`plan_save` 是插件的写，不是沙箱写**：由宿主进程按固定路径写，只能写这一个路径，不能当通用写入。
- **切回可写的范围**：`workspace-write` 的根 = 子会话 `header.cwd` + 插件登记的 target 可写根，子会话理论上也能写插件 state 目录。可接受但不理想。
- **两处真相**：平台会话日志的 `plan/mode` 是运行期事实，台账 `plan_state` 是编排视图；重启/压缩后平台投影会恢复，台账靠续派/终态事件对齐，极端时序下可能短暂滞后。`planFirst` 与 `readOnly` 创建期互斥。

## worktree 隔离（P9）

- **合并责任在用户**：平台没有合并工具，插件也不提供；worktree 任务的产物**不在你的工作树里**。要不要合并由你决定。
- **判定权在协调者（模型）**：声明只有结构化两处，插件不解析自然语言。「用户写了必须隔离但模型漏传」是真实风险——缓解是配置 `required`，以及 `task_status`/面板显示「未隔离（决定 …）」让人能发现。
- **`needsBranchChoice` 多一次往返**：仓库近 N 天 ≥2 个活跃分支且没给 `worktreeBase` 时**不建任务**、只返回候选；任务不落库、不占并发位。
- **检出目录占磁盘**：默认 `worktreeCleanup:'off'` 全保留，长期会堆积（`.agents/worktrees/<taskId>`）；推荐 `checkout-only`。
- **宿主依赖 git**：没装 git/不在 PATH 时建树失败 → 任务 `failed`（`GIT_MISSING`），不自动降级。`.git/info/exclude` 不可写时只 warn，`.agents/` 可能出现在 `git status`。
- **并发**：同一仓库多个任务各自独立检出、互不干扰；并发 `git commit` 会争 `.git` 锁。**同一检出上不要并发两个任务**——`worktreeMode:'continue'` 复用同一目录时必须 `dependsOn` 串行。
- **Windows 长路径**：检出用 `<repo>/.agents/worktrees/<taskId>` 固定短路径，分支名不进路径；仍建议真机先验一次。

## 通知与生命周期

- 通知走 `agent.steer`：空闲唤醒、忙时 next-step 排队；平台另发 `subagent-settled`，不经过本插件、不写 `notifications`，不能当成插件投递成功。
- **结算自动收场（S1）只覆盖「一次 activation」**：派发侧 `activation.result` 只对第一次生效，续派/冷恢复起的轮次只能靠 `subagent/end` 观察；平台若停发该事件，续派轮次退回「只有 `task_report` 才推终态」。
- **`completed` 不等于「工作做完了」**：continuable 子会话可以一轮正常收场等续派，所以只在「没上报过 progress」时自动 `done`；上报过 progress 的回合结束落 `orphaned`（可 `resume` 续跑，会话真不可达才 `retry`）。
- `refusal` 只有源码级依据（pre-step hook deny / 策略拒绝），真机没有稳定构造；`max-tokens` 由 `maxTokens` 截断触发，真实长输出落同一个值。
- headless 一次性进程在 5 秒合并窗口内退出时，`steer` 可能因 initiator scope dispose 失败；`notifications` 记 `failed` 是正确审计。重启窗口内子会话已完成但结算未消费时，会对账为 `orphaned`，重建即可。
- Bot 模式：ds-bot 的 Bot 表面只认自己的 DSH Agent 会话，打开主会话后视图可能仍停在 Bot 会话；纯 dsh 表面不受影响。

## UI

- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见入口是侧栏「主会话」和会话头「任务」面板。
- **任务入口依赖宿主身份信号**：显示条件 = 当前会话 id 与台账 `main_session_id` 相等。id 取不到或 `session-role` 请求失败时按「不是主会话」处理，入口**默认隐藏**；会话切换立即重判，另有 5 秒兜底轮询——刚打开主会话 1 秒内可能短暂看不到入口。
- 入口隐藏只是 UI 层：`main` 面板仍注册，`/api/orchestrator` 的动作端点也没有会话身份校验（owner-only 由平台 connection 负责）；真正的主会话权限仍由 `task_*` 工具的调用方校验兜底。
- 面板是 2s 轮询、没有 SSE；任务很多时快照会变大。面板产物 ≤95 KiB 由 `check:client-size` 守着（minify 后排查用 `CLIENT_MINIFY=0`）。
- **删除只删台账，不删盘**：级联清 `tasks`/`messages`/`notifications`，产物文件、`reports/<taskId>.md` 全文、`memories` 都保留；平台侧子会话历史也没有删除 API。删除不可恢复。
- **删除不给活跃任务**：活跃状态先「停止」；终态任务若还有活跃下游依赖也不让删（`DELETE_HAS_ACTIVE_DEPENDENTS`）。
- 日报默认关闭；开启后每个主会话一条 schedule，主会话重建会重建 schedule。
- **配置卡片保存不热重载**：点「保存」只把值写进当前 profile 的 `cordis.patch.yml`，**运行中的插件不会 reload**——轮换判定、看门狗/陈旧计时器仍按启动时那份配置；改动不会自动生效：**重载插件或重启 DSH 后生效**（卡片回执与简介都写明这一点）。

## 面板动作幂等

- message 的 `clientRequestId` 去重只在 host-route 进程内（LRU 200 条），插件重启后失效；跨重启的严格去重需要把 id 落台账（当前 messages 表没有该列）。
- 没有 `clientRequestId` 的旧客户端按「同任务 3 秒内相同文本」去重；3 秒内故意发两条一模一样消息会被吞掉一条。
- 面板 stop 对已结束任务按幂等成功（`already:true`）返回；工具层 `task_message({action:'stop'})` 返回「已结束，无需停止」文本。两者都是 no-op。
- 面板 retry 在主会话失效时先拒绝、不建 ghost 任务；工具层历史行为是创建后标 failed 再抛错（兼容保留）。
