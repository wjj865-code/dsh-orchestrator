# 已知限制

本文件记录维护者需要知道、但不必塞进 README 的边界（README 只留用户会踩到的几条，细节都在这里）。
每条都是**当前实现的真实边界**，不是 todo；改实现前先读对应章节。

## 恢复与数据

- 台账每天生成快照，但**不自动恢复**；损坏时手工用 `snapshots/tasks-YYYY-MM-DD.sqlite` 替换 `tasks.sqlite`。周期内重启不会重复覆盖。
- 产物快照仅保存阶段/交付时已捕获内容，不提供编辑历史或删除前恢复。DSH 0.2.2-rc.5 的 `workspaceChanges` 跳过 worker，非 Git 工作文件需 `changedFiles`；缺摘要/截断/拒绝项标不完整。真源在宿主 `artifact-store`，主会话目录仅暂存与引用；覆盖私有库或无法核验写根时拒绝普通任务派发/续派。临时 DSH_HOME 通常落在宿主默认可写 temp 下，此类 profile 必须将 home 放在 temp 之外验证防覆盖。完整访问、外部进程及历史路径没有防覆盖保证。
- 产物预览只读前 64 KiB 文本；二进制/目录只显示元信息。详情与产物页只能**复制路径**，不能直接打开本地文件（网页不允许脚本静默打开）；「打开子会话」打开的是产出它的任务会话，不是文件。
- 消息投递状态（待发/已投递/失败）写在 `messages.meta_json`；A3 之前的旧行没该字段，只能按紧随的 `delivery_failed` 行推断，失败行落到 50 条消息窗口外的会显示成已投递。
- **最新返回消息只留最后一次**：`tasks.last_message_json` 只存借条（`at`/`stopReason`/`bytes`/`chars`/`digest`/240 字摘要），正文按需从宿主会话日志冷读；后续回合/续派会覆盖，没有历史版本。
- **正文可用性与宿主会话绑定（P1 起）**：简报/追问/回报/最后一条消息的正文住在宿主会话日志里（`~/.dsh/sessions`）。宿主会话被删、被归档、格式迁移待办（`migration-required`）或 profile 没挂 `sessionPersistence`/`sessions` 时，插件只能给摘要：`task_status include:'full'` 显示「正文不可读：host-log-missing」，面板抽屉显示「正文不可读（摘要）」徽标。**读不到不报错、也不伪造**；台账自己的编排状态（状态机/依赖/验收/交付确认）不受影响。
- 正文读取有 5 秒/32 条的进程内缓存：刚结束的回合若宿主还没 flush 完，可能短暂读到上一条正文；重开面板或等一会儿即可。
- **只认结算事件**：插件在结算前被卸载、或进程被杀时没有返回消息可落；`subagent.failed`（激活被拒）本身没有输出，只留死因。

## 目标（G1）与自动续跑（P2-2：委托宿主 goal）

- **默认不续跑**：`goalRounds` 默认 0 —— 派发后 `create` 立刻 `disarm`，与旧行为完全一致。要续跑必须按任务显式传 `task_create({ goalRounds: N })`（1–50）；配置面上的 `keepAlive*` 四键已删除（弃用警告 + 按默认运行）。
- **续跑能力属于宿主，不属于插件**：插件只把平台 goal 建成 armed 并给 `maxGoalRounds`，之后由 `dsh-goal-round-driver` 在回合结束后续轮。旧宿主没有这个 driver（或裁剪 profile 没挂）时**不会续跑**，插件只记一条 `goal.degraded`，不注入消息、不模拟续跑。插件不再订阅 `agent/turn-stopping`，也就不会和别的插件抢 inbox。
- **轮次预算不归插件管**：`tasks.keep_alive_rounds` 停写（列保留兼容旧库），进度看平台 goal 的 `roundsStarted` / `maxGoalRounds`。`maxGoalRounds` 是「最多续几轮」，**不是成本上限**：单轮工作量、工具调用次数都不受它约束，子会话仍可能继续花钱。
- **计划模式不接受 `goalRounds`**：计划任务每轮结束都要停下来等人批准，自动续轮会绕过批准闸门；显式 `task_message({action:'approve'})` 批准后再用 `task_message` 续派实现。
- **外部 re-arm 不实时压回**：`goalRounds=0` 的任务只在 spawn/续派/终态钩子上压 `disarmed`；别的组件（宿主 `/goal resume`）把同一子会话重新 arm 时，下一次钩子才处理，中间平台可能自动续轮。
- **不是所有环境都有 goal**：`ctx.goals` 缺失、旧 profile 或方法被裁剪时静默降级——不创建、不 warn、不影响派发/续派/结算；台账与面板不显示 goal 状态。
- **子会话写入限制**：goal 只能由宿主对本插件注册表里的 live agent 操作。冷恢复/重启后子 agent 未进注册表时 `attach`/`update` 最多等 3 秒，超时跳过；该轮不补建，下一次 `task_message` 成功后才可能补上。
- **目标不自动注入子会话**：平台 `dsh-goal` 只管状态与投影，不往系统提示/消息里写 objective；子会话要看**实时**目标必须自己 `get_goal`（worker 预设有 `tool-goal` 行；缺它就读不到之后 `task_message` 并进去的「最新指示」，创建时的目标快照仍能从 `task_detail` 拿）。`create_goal`/`update_goal` 要**顶层 agent 的直接人类回合**（`GOAL_TOOL_AUTHORITY_REQUIRED`），子会话调用必被拒。目标文本 = `task.goal` + `最新指示：<消息>`，超 2000 字符截断。
- **终态收敛的边界**：`done→complete`；`stop/retry/orphaned/failed→clear`。孤儿/失败时子 agent 往往已不在注册表，平台侧不会真的 `clear`，插件只把台账镜像标成 `cleared`。面板只读：能看 phase/activation/轮次/修订，没有暂停/恢复/清除的按钮或工具。

## 子会话与检查（A1）

- **brief 只有引用和指引，详情要自己取（T1）**：brief 只有 `【任务引用】`（`tk-`）+ 三条回报指引；子会话第一个动作应当是 `task_detail`。若它跳过，只能靠 `get_goal` 与自身上下文；前提是工具表里有 `task_detail`——换成自带 allow 名单的 `workerPreset` 时要把它列进 allow。
- **子会话不能直接问用户**：`userQuestions.ask` 的 `assertLiveRoot` 对 `origin === 'subagent'` 抛 `DELEGATED_CALLER`。要拍板只能交回协调者：`blocked`/`needs_auth` 带 `question` + `options`；`done` **不支持** `question`/`options`（`clearTaskQuestion` 会把它们清空），要点必须写进 `summary`。
- **`blocked` 上报不等于授权**：它只是把决策点交回协调者；子会话不能因为「报过 blocked」就自行推进，也不能拿它绕过推送前双审查或人工确认门禁。
- **检查跑在宿主进程，不是沙箱**：`checks` 按宿主权限执行（命令只来自协调者的 `task_create`，子会话无法注入）。cwd 固定为任务 target / 检出目录，**不继承主会话目录**；没有 `target` 或 `readOnly` 的任务不接受 `checks`。环境差异（命令不存在、CI 专用命令）用 `skipIfMissing`，不是绕过闸门。
- **Windows 上 `pnpm`/`npm`/`npx`/`yarn` 是 `*.cmd` shim**：无扩展名命令先按 PATH × PATHEXT 找到真实 `.cmd`/`.exe` 入口（同名的无扩展名 bash shim 不认），`.cmd`/`.bat` 经 ComSpec `/d /s /c` 执行、命令行从 argv 逐项转义；解析不到时按「命令不存在」记账，错误里列出查找过的候选路径（不再只是干巴巴一句 ENOENT）。参数里带**双引号或控制字符**时直接判失败：cmd 没有引号转义语法，拼下去就是注入面——这类参数请改用 `.exe` 入口或去掉（`skipIfMissing` 不覆盖这种情况）。
- **超时/失败语义**：超时先 SIGTERM、5 秒后 SIGKILL；失败即拒绝交付（状态不变），**确认交付与超时 sweeper 都不重跑**检查。**配了 `checks` 的任务必须 `task_report({status:'done'})` 才算交付**：子会话自然结束（`completed`）时结算会先查「本轮通过验收的证据」（`acceptance.ok` 且 `attempts` 匹配），没有就落 `failed` 并写明「验收未执行/本轮未通过」，用 `resume` 续跑补报或 `retry` 重派；`aborted`/`error`/`refusal` 与只报过 `progress` 的 `orphaned` 不受影响。
- **worktree 装依赖提示只是「允许装」**：`【worktree 依赖】` 只在隔离任务里出现，措辞限定「只安装不升级」；插件不代为执行、不保证锁文件不变。
- **经验文件是快照，不是台账（T1）**：`lessons/<项目>-<hash>.md` 每次派发覆盖为本次命中事实层记忆；无历史版本、不参与快照。手删后 `task_detail` 指针显示「已丢失」（下次派发重建）；写文件失败时经验改为只出现在 `task_detail` 的内联块。
- **`task_detail` 只读且只给自己**：按创建时 `brief_json` 返回目标/验收/检查/经验，前置与产物按**当前**台账现读；主会话或别的子会话调用被拒。
- **子会话能读上下文，也能写项目记忆（但只限自己任务的项目）**：`context` 三种 mode 对子会话只读开放（与协调者同一条实现）；`memory_note` 子会话可用（worker 预设 `preset-tools` 是 keep-only），但执行层按台账归属做硬护栏——只能写自己任务 `target_dir` 的项目 `note`/`lesson`/`decision`，单任务最多 3 条、同 `kind`+`text` 幂等、行上记 `source:'worker'` + taskId/sessionId；`preference`、全局/跨项目记忆、没有 target 的任务、找不到归属的会话一律拒绝，并给替代路径（写 `task_report` 的 summary / 让协调者记），记 `memory.note.rejected`。**能力声明在预设层、归属校验在执行层**：换成自带 allow 名单的 `workerPreset` 时要自己把 `memory_note` 放进 allow，否则子会话看不到它。
- **`context` 不是任意文件读取**：只读台账/记忆/已登记工作区与白名单文件（README/AGENTS/`docs/ARCHITECTURE.md`/package 等），不枚举全盘、不读 `.env`；子会话拿到的默认项目目录仍是主会话目录（要读自己的目标仓库请显式传 `target` / `project`）。

## 记忆容量与检索（0.25.1）

- **淘汰分层**：日志层 `task-log` 单项目留最新 **200 条**（超出按 `created_at` 删最老的日志），**事实层不参与淘汰**。旧口径「单项目 300 条总量」已删除——它把事实和日志混算，日志写入量是事实的 2–3 倍，活跃一两天就会删掉手记的 decision/note。事实层没有全表上限，长期只增；要清只能手删台账行。
- **检索默认范围**：`context({ mode: 'history' })` 不传 `project` 时**只查 `global` 跨项目记忆**（首行【检索范围】写明「未含项目记忆」）。这是有意的：协调者没有单一项目上下文，猜一个项目会串味。查项目记忆要传绝对目录/工作区名；数组最多合并 2 个项目键（另自动带 `global`），`'all'` 查全部项目。未知名项目给一行警告，不静默回落。
- **质量门槛的代价**：多词查询要求命中 ≥2 个词（或分数 ≥2），单词查询命中即相关；「任务/插件/测试/代码/文件/项目」等通用词不进 token。所以「只共一个通用词」的记忆不再返回——召回变少是有意的，别把「查不到」直接当丢数据。
- **配额**：`decision`/`preference` 在一次检索里最多占 2 条，其余槽位给 `lesson`/`note`；如果候选全是决策/偏好，仍按分数补满（不为配额少返回结果）。
- **架构文档的截断**：`context({ mode: 'project' })` 默认只读 `docs/ARCHITECTURE.md` 前 1200 字（项目背景总输出 ≤8000 字），`include: ['docs/ARCHITECTURE.md']` 才给前 4000 字；`include` 白名单外一律不读。
- **旧偏好迁移是一次性写操作**：启动时把 `memories` 里 `project='global'` 的 `preference` 搬进 `settings.orchestrator_preferences`，幂等标记 `orchestrator_preferences_migrated`；带「更正/修正/纠正」标记的条目取代它指向的旧条目（如 present 展示数量取 1–4）。迁移成功后旧行**从 `memories` 删除**（不双写），迁移了哪几条记在日志 `memory.preferences.migrated`；没有旧行时不写任何 settings。
- **worktree 记忆只归一未来写入**：`done` 的 projectKey 取 `brief.target → repo_root → target_dir`，新写入不再落到 `.agents/worktrees/t-*` 键；历史上已经在分裂键下的旧行**没有迁移代码**（要查旧经验得显式传检出路径）。


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
- **同写域并发防护是「事后判定 + 可绕过」的护栏，不是文件锁**：`sameDirGuard=require` 在 `task_create` 那一刻与「追问交付过的任务」那一刻按台账判定，放行路有（关闭/停止旧任务、`worktree:true`、`allowConcurrent:true`；追问没有 `allowConcurrent`）；显式放行后两个子会话仍会同时写，冲突要人兜。**交付即释放**：`delivered` 不再占目录，同目录可以新派；追问回 `running` 前会复判 target/写域，被占用就拒绝投递（`MESSAGE_WRITE_CONFLICT`）——代价是有约一个回合的「回报后到回合结束」窗口，子会话此时再写 target 会被沙箱拒（正常收尾不会发生）。判定是**路径字面量**比较（绝对路径相等/父子目录），不解析符号链接与 `..` 之外的挂载点/大小写语义；两个不同路径指向同一实体目录（bind mount/软链）时判不出来。`writeScopes` 是声明不是事实。
- **防护覆盖 `task_create`、`retry`、`resume`、追问与派发 chokepoint**（都走 `write-gate` 的同一次判定）：`retry` 与面板「重派」按原 brief/target 新起任务，`resume` 是原会话冷恢复、投递前同样复判。**隔离任务**（`worktree`）只按它那份检出判（同一份检出仍拒、别人写进我的检出仍拒），原 target 与 `writeScopes` 不参与——检出天生在仓库根内，父子包含不是同一份工作树。
- `priority` 只影响队列顺序，不抢占正在运行的子会话。连续 3 次 progress 无变化只提醒一次（固定口径），没有二次升级阶梯。
- 空闲看门狗（W1）只告警一次、不改状态也不 kill；去重表在内存，重启后允许再报一次。长时间跑测试的单回合可能被误判「可能卡住」——先用 `task_status` 核对。
- 面板组进度是 `task_list({group})` 文本 + 行内徽标，不是独立分组看板。

## 主会话与工具面

- `spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`wait_agent`/`team_task_*` 是 **agent scope 自注册**的团队工具，`restrict` 遮不到；执行层 `guard` 硬拦协调者，但工具表里仍可能看到残留。
- **协调者的 deny 名单只剩「编排正确性」**（0.26.0）：`read`/`skill` 由预设行自己挂（t-4f7ce108 起协调者的原生只读工具只剩 `read`，`glob`/`grep` 已随 `tool-fs-search` 行移除），`write`/`edit`/`bash`/`pwsh` 不挂；`task_report`/`task_detail`/`plan_save` 改由预设 `preset-tools` 的 `deny` 遮掉（工具表里看不到），执行层仍按任务归属拒绝越权调用。只读工具的读取面风险见「协调者读文件」。
- `config.coordinatorSession` 覆盖的会话没有预设保证，运行期 `restrict` 挂在回合边界：绑定当回合仍是全工具表，下一回合才收窄。同一回合并行发出、且在 guard 判定前就开始执行的 `wait_agent` 不承诺拦住。
- `run_code` / PTC：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；profile 配了 PTC executor 时协调者可能经它间接调用被 deny 的工具（desktop 默认没有）。
- **`workerPreset` 只在派发时生效**：续派/冷恢复沿用会话创建时的 `agentPreset`，改配置不切换已有子会话；值非法时静默回落 `dsh-orchestrator-worker`（日志一行 warn）。
- **`orch-debug` 调试预设**：复制随包「创造模式」组合，预设声明装在 profile 里；升级 DSH 后必须先 `node tools/debug-preset/cli.mjs --check` 看漂移，再重新生成并重装。预设可执行 Host 代码，不是沙箱；生成器与文档自 P1-E 起不随 npm 包发货（开发仓库 `tools/debug-preset/`）。

## 主会话权限徽标（0.25.1）

- **钉只读 ≠ 锁权限**：协调者会话的 `permission preset` 显式钉成宿主出厂预设 `read-only`（沙箱只读 + 审批 ask），徽标与实际工具面一致。但宿主没有锁权限选择器的 API：`/permission` 或输入区选择器**仍能切走**（宿主 `locked` 只针对 agent 预设的 `agentPresets.select`，不覆盖权限预设），插件只在下次「打开主会话」、adopt、协调者 `agent/created` 重建时把漂移拉回（`main.session.permission-pinned`）。用户切走后到下一个观察点之前，徽标如实显示他选的值。
- **需要宿主预设表含 `read-only`**：DSH 出厂表（`@deepseek-ai/dsh-permission-presets` 在 0.2.2 系列 profile 里）有 `read-only`（沙箱只读 + 审批 ask）。被改成只剩 `workspace-write`/`danger-full-access` 的 profile 里 `set` 会抛 `unknown preset`，插件记 `main.session.permission-pin-failed` 并保持宿主默认徽标——不挡打开主会话、不挡派单。
- **旧主会话与升级**：升级前创建的主会话仍是 `workspace-write`；下次打开、重启后协调者 `agent/created`、或 adopt 时钉成只读。插件不改宿主全局 `permission.defaultPreset`（那会连普通新会话一起变只读）。
- **普通任务子会话仍是 `workspace-write`**：宿主会把父会话的显式 `sandbox/mode` 覆盖按 `source:'delegation'` 种进子会话，所以 `src/dispatch.js` 对普通任务显式写回 `workspace-write`（`subagent.workspace-write` 日志）。这不是放宽权限（与原先继承父会话的 workspace-write 等价），但子会话日志里会多一条幂等的 `sandbox/mode` 事件；只读/计划任务照旧 `read-only`，`access:'full'` 照旧 `danger-full-access`。

## 主会话上下文维护（0.25.0）

- **插件不压缩、不换人**：压缩完全由宿主 `compaction-basic`（每个 agent 预设的 isolate 组）负责，阈值 `thresholdRatio` 默认 0.8；插件不调用 `compactNow`、不写宿主阈值/预设行内 config、不重试。`/compact` 手动路径照旧可用。
- **日志只增不减**（append-only、从不重写）：压缩只减小请求面，不减小日志。插件只在打开主会话时读一次压力与日志体积，日志 ≥ 16 MiB 给**一次性**提示；「重置」靠人工换新协调者会话——插件不做自动清理、不删会话、不归档旧会话。
- **压力提醒是唯一出口**：压力 ≥ `contextPressureThreshold`（默认 0.4）时弹一张 `userQuestions` 问题卡（新建协调者会话 / 继续当前会话 / 稍后再说），去重状态在 `settings.main_context_alert`（0.1 band + 0.05 滞回）。`userQuestions` 缺失或无在线客户端（`NO_PROVIDER`）只 warn 一次、不建会话、不弹第二次；压力读不到时不提醒（fail-closed）。
- **有任务在跑时提醒会延后**：`pending` / `running` / `waiting_dep` / `waiting_user` / `waiting_auth` 任一存在就不弹卡，只记 `main.context.alert.deferred`（不写 `main_context_alert`、不占 band），任务收尾后下一次打开主会话再问；`delivered`（已交付待确认）不算在跑，照常问。代价：长期有任务在跑时提醒会一直不出现，需要换会话请手动「设为协调者」。
- **「新建」之后的跳转是尽力而为**：服务端只建会话 + 切指针；跳转由浏览器插件每 5 秒轮询 `main-nav` 后调 `uiWorkspace.openSession`。宿主拒绝（新会话还没在客户端会话表里）最多重试 3 次（约 15 秒），仍失败就 ack 失败并在面板顶部给可读提示——**指针保持已切状态**（当前会话会失去「主会话」身份），用户从左侧会话列表打开标题「主会话」的会话即可；离线客户端在 5 分钟内回到页面会被补跳，超过 TTL（5 分钟）就不跳（避免很久以后把人拽走）。没有 `uiWorkspace.openSession` 的旧宿主/裁剪 profile 只给提示、不崩。
- **换协调者 = 加入名单并提升为主**（0.36.0）：adopt（会话头「设为协调者」）与代建写 `settings.main_session_ids`（首位 = 主协调者）并同步 `main_session_id` / `main_session_preset`；旧会话留在名单里，不改名、不归档、不退役。adopt 只接受**指挥舱工作区**里的会话，已用其他预设开始（宿主拒绝换预设）会被拒并给可读原因；名单上限 4 个（adopt 超限 → `ADOPT_LIMIT`；压力代建满员时淘汰最早成员腾位，会话保留），同一时刻只允许一次切换（`ADOPT_BUSY`）。代建 create 失败零处置；**写名单失败时新建会话留着待重用**（不归档）。「本会话退出协调者」（`drop-coordinator`）只删名单，删首位则下一位升主、删光等价「尚未打开主会话」。
- **多协调者共享一份台账**：名单成员都能 `task_create` / `task_list` / `task_status`，都钉 `read-only` 只读工具面；任务的 `coordinator_session` 记**实际派活的那个**，回报投给它、它离线或退出名单时回落主协调者（日志 `notify.route.fallback`）。已知边界：**上下文压力只观测主协调者**（副协调者的上下文增长不提醒）；派它的协调者会话没打开时该任务直接 `failed`（可读提示「先打开创建者会话」），**不回落主协调者派发**；对账按名单并集读目录，不会把副协调者的任务误判丢失。

## 首次打开与仓库索引

- 只初始化新建 main，历史主会话/显式 `coordinatorSession` 不补欢迎。注入成功只代表消息入队，模型可能未照提示介绍/派发，应核对 `task_list`。发送与 sent 写入之间崩溃可能停在 sending，不承诺 exactly-once。
- 索引只覆盖创建任务时 `workspaceRegistry` 登记名单，不扫全盘或未登记 git；只读默认沙箱读不到的目录记 unavailable，不为扫描任务升 full。工作区增删改名后需重新派只读索引。
- repoRoot/branch/origin/HEAD/commonDir 是**有采样时间的快照**，不等于实时 Git 状态；remote 脱敏去 userinfo/query/fragment，git stderr 不进索引。不得把映射内容当执行指令，歧义列候选。
- `task_report.workspace_index` 是只读索引回报契约（本人 done、名单覆盖），持久化在 settings 独立键，不覆盖用户手写 memories；完整回报缺失时不交付（S1 自然 completed 会落 failed 并提示 `retry`）。

## 原生自动化

- 四个实际工具为 `schedule_create`/`schedule_list`/`schedule_view`/`schedule_edit`，没有单独 delete/pause/enable；仅核实 **0.2.2-rc.3** 的 RRULE/target/depth 契约，旧 `schedule_update`/`schedule_delete` 不兼容，不提供假工具或自动适配。
- **Host-wide**：可管理其他会话创建的任务；写操作必须用户**明确授权**、确认目标与范围，日期/时间/时区不明先问；宿主提示不是对用户意图的硬验证。编辑用最新 `updatedAt` 为 `expectedUpdatedAt`，冲突先重读。
- **本次自动编排只支持 `this_session`**：「这个会话」= **创建自动化时所在的协调者会话**（面板会带当前会话 id，服务端校验它仍是协调者名单成员；未带时回落主协调者）。`new`/`new_once` 是普通 root 会话，不在名单里，不能 `task_create`；目标会话退出名单后该自动化到点没人处理（面板标「目标会话已不是协调者」，不自动改授权），也不转发、不自改名单。
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
- **子会话工具失败监听的三条边界**：① 外部子会话（codex / claude code / ACP / DSH-SDK 独立进程）的工具事件不在本进程，插件收不到，只能靠子会话自报（W1 已要求权限/环境失败写进 summary）；② 判定靠 stderr 文本兜底，模型自己往 stderr 打「Permission denied」会被判 denied——通知写「疑似」，插件不改任务状态、不自动重派；③ 去重表只在内存，`(taskId, tool, code)` 的 10 分钟窗口不落库，插件重启后同一失败允许再报一次（窗口是固定常量，没有配置键）。

## 协调者读产物（`read_workspace`）

- **边界 = 主会话工作区 ∪ 已登记产物**（`tasks.artifacts_json`）。子会话按契约把产物写在 target 目录内，那些路径不在工作区里，但**只要登记过就能读**；未登记的同目录文件仍被拒——读取面不是整个 target。
- **没回报 artifacts 的产物读不到**：`done` 时的自动收集只覆盖本轮被改动/新建的文件。
- **登记表不借符号链接放行**：登记一个指向别处的链接不等于登记真实路径。**已登记目录会放开子树**：回报「整个仓库根」会把面放得很大，属使用纪律。
- **不是全盘读，也不是 glob**：没有目录递归枚举、没有模式匹配；看目录就逐层读条目（一层最多 200 项）。符号链接逃逸、`../` 穿越、工作区外且未登记的绝对路径都被拒并写 `workspace.read.rejected`。
- **截断是常态**：默认 400 行、单次 ≤64 K 字符；单行超上限时只返回前 64 K 并标 `truncatedLine`。`offset`/`limit` 收字符串，非法值回落默认。> 4 MB 直接拒绝。
- **IM 外发风险**：profile 开了 IM 双向同步时，读进上下文的正文可能随「最终助手文字」同步到外部且**不可撤回**；涉密产物不要读进主会话——这是本能力最主要的残余风险，不是可配置项。
- **不用于校验存在性**：存在性仍由插件（通知路径已 `lstat`）与子任务保证。

## 协调者读文件（read）

- **读取面是整台机器**：协调者预设挂 `tool-fs`（只开 `read`），它没有产物边界——`read_workspace` 的「工作区 ∪ 已登记产物」约束只属于 `read_workspace`。能读到 `~/.dsh/.credentials.yaml`、`.env`、SSH key、token 文件等；插件**只靠提示词**要求「不读凭据、不转述」，没有路径黑名单、没有执行层拦截。
- **没有 `glob`/`grep`（t-4f7ce108 起）**：0.26.0 曾挂 `tool-fs-search`；该包没有「只关 grep」的开关（`Config` 只有采样与上限字段，`glob`/`grep` 在 `apply()` 里无条件一起注册），`preset-tools` 的 `deny` 只作用于已注册的全局工具、遮不到预设自有行，所以整行移除。副作用是**协调者不能自己检索/枚举目录**：需要跨文件找证据、批量 grep 或列目录时，只能派一条只读任务（`readOnly:true`）让子会话把结果带回来——这是有意的取舍（搜索会让主会话绕过派发自行调研），代价是多一次派发往返。
- **IM / 外发风险叠加**：读进上下文的正文可能随「最终助手文字」同步到外部且不可撤回（与 `read_workspace` 同一条风险）。涉密文件不要读进主会话。
- **写仍然没有工具**：`tool-fs` 的 `write` / `edit` / `applyPatch` / `readImage` 全部关掉，`bash` / `pwsh` 也没挂；写路径只由钉死的 `read-only` 权限预设（沙箱写全拒）兜底，两处都**不是**「审批门禁」。
- **`working_directory` 不给协调者**：这个宿主全局工具改的是会话 cwd，而协调者 cwd 是指挥锚（子会话未给 `target` 时继承它、工作区/写域判定与记忆项目键推断都以它为准）。它被预设 `preset-tools` 的 `deny` 与 `COORDINATOR_DENY` 两处遮掉，工具表里看不到、硬调被拒。所以**协调者不能切目录**：相对路径读文件会落在主会话默认 cwd（`<state>/workspace`）下，跨目录一律写绝对路径；真要换目录属于用户/子任务侧的事（`task_create` 的 `target` 决定子会话 cwd）。
- **工具面不随权限变**：用户手切 `full` 后沙箱不再挡写，但协调者工具表里仍然没有写工具/命令工具——插件不因权限变化增删工具，也不额外提示「现在可写了」。
- **`grill-me` 是提示词技能**：澄清协议没有执行层校验，判错表现为「问少了」或「问多了」；它不改变任何工具/沙箱边界，也不构成批准。

## 状态与提示词的单一事实源

- **状态能力表只有一份**（`src/status-facts.js` 的 `STATUS_CAPS`）：新增状态只改这张表，其余引用自动跟上。**死边已删**：`running→done`、`orphaned→pending` 从未有调用点（要「直接完成」走 `running→delivered→done`）；v0.24 反过来给 `resume` 重开了 `failed→running` / `orphaned→running` / `done→running`（`done` 只认 `close_reason='timeout'`）。
- **`failed` 不是流程终态但已收尾**：`terminal:false`（能重派）、`releases:true`（释放资源）；对失败任务「停止」是幂等成功（`already:true`），不会被改成「已取消」。
- **续跑（`resume`）的边界**：只续 `failed` / `orphaned` / 超时自动完成的 `done`；`cancelled`（用户主动停）与确认过的 `done` 不续（**链式自动放行的 `done` 等同「确认过的 `done`」**：不能追问/续跑，要改只能 `retry` 新任务）。只读/计划任务续跑后沙箱仍按原样（`readOnly` 就还是只读）；历史消息 > 60 条只**建议** `retry`（冷恢复要重放历史，可能比新派贵），不拦截；子会话不可达时报错回退、**不静默新建任务**。
- **worktree 状态转移会校验**（`WORKTREE_TRANSITIONS`）：非法转移抛错而不是静默写入。
- **提示词五层各有独占职责**（`src/prompt-layers.js` 的 `PROMPT_LAYERS`）；`layerViolations` 是机器可读归层探针，测试用它防「删掉的重叠又抄回来」。
- **偏好不是权限通道**：只是 `settings.orchestrator_preferences` 里的提示词文本，不进 config、不改 dispatch、不碰 `sandboxPolicy`；内置种子里不放「放宽安全边界」的条目。超限（默认 12 条 / 1200 字）按 priority 降序保留并写明「另有 N 条未展示」，被截掉的**不会生效**也不报错。

## 交互规范（软约束）

- **只是提示词文本**：T0–T3 判级、四类堵塞项、R0–R2 分档都在 L1 的 `renderInteractionPolicy()` 里，**没有执行层校验**——插件不拦 `task_message`、不检查是否真的先问过用户，也不记录判级结果。
- **判错的两种表现**：「该问没问」（T2/T3 被当成 T1 直接开做）与「不该问又问」（把进度、能否关闭当成堵塞项）。纠正方式是把用户偏好写成偏好条目（`memory_note(kind:'preference')`，每回合注入）或改 policy 代码；**没有配置档位**能一键关掉三闸门（配置面固定 25 键）。
- **T1/T2 边界是模型判断**：同一需求在两次会话里可能判成不同级别；判据里的「动 5 个以上文件」「跨仓库」是经验阈值，不是代码常量。
- **确认只能由协调者发起**：`ask_user_question` 对子会话直接拒绝（`DELEGATED_CALLER`），所以 T2/T3/R1/R2 的确认都由主会话做；子会话只能 `task_report blocked` 报问题 + 选项。选项数按 policy 2–4 个，多条目清单写进 question 正文。
- **顺序闸门靠措辞**：P0-4 起普通 `task_message` 在计划任务上只记讨论/修订、**不会批准**（批准必须显式 `approve`），但「先评估 → 再确认 → 才通知」仍只能靠 L1 的措辞约束，插件不拦「先追加后解释」。
- **「回报之后必须推进」也是提示词约束**：L1 的推进循环段（`renderAdvanceLoopPolicy`）要求协调者收到任何回报后落到推进 / 提问 / 问新任务三类动作之一，但插件**不检查**它这回合是否真的调了 `task_message` / `ask_user_question`，也没有「只汇报就重试」的执行层拦截。仍然可能只回一段汇报文字——此时按同一段的措辞纠正（推进或提问），不要把这段当成硬门禁。同一事件是否已经问过「还有新任务吗」也只在模型上下文里，插件不记账。

## 计划阶段（P8）

- **plan mode 是软引导**：平台只注入一段系统提示，不拦工具、不写沙箱状态；真正挡住**仓库**写入的是「未登记的 target 可写根」（计划阶段沙箱是 `workspace-write`，所以 `$TMPDIR`/scratch 可写、仓库仍不可写）。模型仍可能反复尝试写仓库，被拒错误会回灌给它。
- **四态、审计与「没有官方审批端点」**：`plan_state` 走 `planning → waiting_user → revising → approved`，未批准进终态收口 `rejected`；审批审计复用 `accepted_by`/`accepted_at` + `accepted_kind`（`plan`），后续交付确认会把它覆盖成 `delivery`——完整审批历史以 `task.plan.approved` 日志为准（刻意不加 `plan_blocked_at` 列，「有 blocked 报告」由 `plan_state='waiting_user'` 表达）。`planMode` 是预设隔离域服务、宿主也没有对插件开放的计划审批端点，所以批准只能由插件自己的 `task_message({action:'approve'})` 承担，面板刻意没有批准入口。
- **服务可见性**：`planMode` 挂在子会话预设作用域，插件必须走 `agent.ctx.get('planMode')`；没挂时静默降级为「只有只读沙箱」并 warn 一行，派发不受影响。`exit_plan_mode` 被拒（子会话没有直接人类），出口固定是「`plan_save` 落盘 + `task_report blocked`」。
- **文档版本**：`plan_save`/`artifact_save` 保存新版本，批准以最新计划路径为准；没有版本对比或审批流 UI。产物目录绑定创建时主会话工作区，后续不重定位；历史路径不搬移。
- **文档保存是宿主受限工具，不是沙箱写例外**：校验任务归属、名称与固定产物根；只读任务不能用文件工具或 shell 绕过工作区只读；计划阶段可写 `$TMPDIR`/scratch，但写仓库同样会被拒。
- **计划阶段的可写面无法再窄化**：`workspace-write` 的根 = 子会话 `header.cwd`（指挥舱）+ 登记的 target 可写根 + `/tmp` + `os.tmpdir()`，宿主按 mode 门禁给整套，插件没法只放行 scratch——所以计划阶段能写指挥舱 `workspace/`（含 artifacts 暂存），但产物真源 `artifact-store/` 在 workspace 之外、仍不可写。可接受但不理想。
- **两处真相**：平台会话日志的 `plan/mode` 是运行期事实，台账 `plan_state` 是编排视图；重启/压缩后平台投影会恢复，台账靠续派/终态事件对齐，极端时序下可能短暂滞后。`planFirst` 与 `readOnly` 创建期互斥。

## worktree 隔离（P9）

- **合并责任在用户**：平台没有合并工具，插件也不提供；worktree 任务的产物**不在你的工作树里**。要不要合并由你决定。
- **判定权在协调者（模型）**：声明只有结构化两处，插件不解析自然语言。**名字也归协调者**：「用户写了必须隔离但模型漏传」是真实风险——缓解是配置 `required`，以及 `task_status`/面板显示「未隔离（决定 …）」让人能发现。分支名同理：漏传 `worktreeBranch` 直接报错（`BRANCH_REQUIRED`，文案带 11 类 type 白名单 + 正例），插件不兜底、不猜、不自动改名。
- **`needsBranchChoice` 多一次往返**：仓库近 N 天 ≥2 个活跃分支且没给 `worktreeBase` 时**不建任务**、只返回候选；任务不落库、不占并发位。
- **检出目录占磁盘**：默认 `worktreeCleanup:'off'` 全保留，长期会堆积（`.agents/worktrees/<taskId>`）；推荐 `checkout-only`。
- **宿主依赖 git**：没装 git/不在 PATH 时建树失败 → 任务 `failed`（`GIT_MISSING`），不自动降级。`.git/info/exclude` 不可写时只 warn，`.agents/` 可能出现在 `git status`。
- **并发**：同一仓库多个任务各自独立检出、互不干扰；并发 `git commit` 会争 `.git` 锁。**同一检出上不会并发**：`worktreeMode:'continue'` 复用前会按 `worktree_path` 查活跃占用（pending/waiting_dep/running/waiting_*/delivered 都算），被占就拒绝并给两条路——把占用任务设为 `dependsOn` 前置串行，或改 `worktreeMode:'new'` 新建检出。
- **Windows 长路径**：检出用 `<repo>/.agents/worktrees/<taskId>` 固定短路径，分支名不进路径；仍建议真机先验一次。

## 通知与生命周期

- 通知走 `agent.steer`：空闲唤醒、忙时 next-step 排队；平台另发 `subagent-settled`，不经过本插件、不写 `notifications`，不能当成插件投递成功。
- **progress 通知是信号、不是终态**：默认送达（旧口径的 silent 已删），但同任务 60 秒水位 + 5 秒合并窗口内只留**最新一条**（被同窗口的 `done` 取代则直接撤掉）；被压住/覆盖/取代的写 `notifications`（`skipped` + `reason: progress_watermark | progress_merged | progress_superseded`），所以「主会话没收到这一条」永远有行可查。水位在进程内，插件重启会重置（重启后第一条 progress 立即送）。要逐条看历史请看台账 / `task_status`，通知面永远按节流口径。
- **追问必达只覆盖第一条**：`task_message` / `resume` 投递成功后的**下一份**回报必达（跳过水位与合并窗口）；之后的 progress 回到正常节奏。子会话一次连发多条时，只有第一条保证即时送达，其余按水位合并（最新一条仍会补投）。
- **结算自动收场（S1）只覆盖「一次 activation」**：派发侧 `activation.result` 只对第一次生效，续派/冷恢复起的轮次只能靠 `subagent/end` 观察；平台若停发该事件，续派轮次退回「只有 `task_report` 才推终态」。
- **`completed` 不等于「工作做完了」**：continuable 子会话可以一轮正常收场等续派，所以只在「没上报过 progress」时自动 `done`；上报过 progress 的回合结束落 `orphaned`（可 `resume` 续跑，会话真不可达才 `retry`）。
- **追问/续跑后只报 `progress` 就结束回合是预期路径，不是缺陷**：`task_message` 追问或 `resume` 起的新一轮里，子会话若只调了 `task_report(progress)` 就收场，台账按上一条判 `running → orphaned`——**progress-only 不当成交付**，也不猜它已经做完；协调者的「推进循环」会接住，按需 `task_message({action:'resume'})`（同会话冷恢复）或再追问，续上后照常 `delivered → done`。0.28.0 隔离 web 冒烟实测的就是这条链路（progress → `orphaned` → `resume` → `delivered` → `done`，task id 与子会话 id 全程不变），排查时不要把它当成状态机 bug。
- `refusal` 只有源码级依据（pre-step hook deny / 策略拒绝），真机没有稳定构造；`max-tokens` 由 `maxTokens` 截断触发，真实长输出落同一个值。
- headless 一次性进程在 5 秒合并窗口内退出时，`steer` 可能因 initiator scope dispose 失败；`notifications` 记 `failed` 是正确审计。重启窗口内子会话已完成但结算未消费时，会对账为 `orphaned`，重建即可。
- Bot 模式：ds-bot 的 Bot 表面只认自己的 DSH Agent 会话，打开主会话后视图可能仍停在 Bot 会话；纯 dsh 表面不受影响。

## 能力包（0.32.0）

- **Desktop-only**：Web 下不注册预设、`capability_pack` 返回 `PLATFORM_UNSUPPORTED`、面板显示不可用；`capabilityPacksAllowOnWeb=true` 是唯一覆盖（安装/`setx` 仍只在 Windows 执行）。
- **预设注册依赖宿主 rc 契约**：`agentPresets.register()` 在 DSH 0.2.2-rc.5 真机通过（P0 门禁），但不是公开承诺；注册失败降级为静态 `cordis.patch.yml`（`capability_pack({action:'export-static'})`），改完必须彻底重启，且宿主 UI 预设选择器的刷新时机未验。
- **CLI 安装是网络+磁盘操作**：冷装实测 259 包 / ≈184 MiB / ≈4 分钟；无镜像回退、不自动重试、升级只能面板确认后执行；安装期间包里技能仍可用，只是 `cli: unavailable`。
- **公众号只到草稿箱**：`publish` 在文颜里就是「建草稿」，不做群发/发布接口；建草稿要求本机出口 IP 在公众号白名单（`invalid ip` 只给指引，不重试）；无幂等，重复执行会新建草稿（面板/技能要求先问用户）。
- **凭据边界**：插件不读值、不落盘；`setx` 会把密钥短暂暴露在进程命令行并写入 `HKCU\Environment`（需用户二次确认）；文颜自己可能缓存 `access_token`，已重定向到包内 `.state/wenyan`，删包即清，但插件不读不管。
- **用户包技能质量无保证**：工厂只生成声明与文本（不生成脚本），也不做内容评分；`dry-run + 健康检查 + 一键删除` 是全部兜底。真实公众号联调（一条草稿）仍属人工验收项。
- **删除包时若会话仍开着（Windows）**：skill watcher 可能占住 `skills/` 目录，整目录 rename 恒 `EPERM`。此时只撤预设 + registry + tools，目录延后到下次启动 `purgeUnregistered()` 清理（不硬删，避免运行中会话中途丢技能）。
- **开包会话的跳转有宿主侧竞态（降级，不静默）**：`pack-open` 的结果走 HTTP，而新会话的目录行经 `api-session/added` 事件走 WebSocket；宿主 `sessions.retain()` 只认已经进客户端会话目录的 id，事件还没落地时会同步抛 `sessions.retain: unknown session <id>`。客户端对这类错误短退避重试 4 次（≈1.2 秒，`client/src/open-session.js`）；仍失败就如实提示「已建好（session-xxx），但打不开：<原因>。请从左侧列表打开。」——**不重试创建、不吞错**。同一竞态在「新建协调者会话」链早就有（见主会话上下文维护一节）。
- **包会话挂工作区**：`sessionController.create` 只给 `cwd` 时宿主不会 `attachSession`（只有 `workspaceId` 分支才挂），会话会落在「未分组」且 UI 只显示「选择一个工作区开始」。所以 open 先用 `workspaceRegistry.resolveByPath(cwd)` 找目标目录所属工作区，找到就传 `workspaceId`；目录不是已登记工作区（或服务缺失）才退回只给 `cwd`——插件**不自动建工作区**（那是主会话「指挥舱」的语义）。

## UI
- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见入口是侧栏「主会话」和会话头「任务」面板。
- **任务入口依赖宿主身份信号**：显示条件 = 当前会话 id ∈ 台账 `settings.main_session_ids`（名单成员一视同仁，主/副协调者都显示「任务」）。id 取不到或 `session-role` 请求失败时按「不是协调者」处理，入口**默认隐藏**；会话切换立即重判，另有 5 秒兜底轮询——刚设为协调者 1 秒内可能短暂看不到入口。
- 入口隐藏只是 UI 层：`main` 面板仍注册，`/api/orchestrator` 的动作端点也没有会话身份校验（owner-only 由平台 connection 负责）；真正的主会话权限仍由 `task_*` 工具的调用方校验兜底。
- 面板是 2s 轮询、没有 SSE；任务很多时快照会变大。面板产物 ≤200 KiB 由 `check:client-size` 守着（工作台 v1 由 95 KiB 抬到 148 KiB，0.32.0 能力包面板抬到 160 KiB，0.35.0 引用 chip 抬到 164 KiB，关系图两轮（原 0.36.3 首轮 / 原 0.36.4 v2）抬到 176 KiB，0.37.0 界面系统重做抬到 200 KiB——子预算见脚本头部与 `docs/testing.md` G10；minify 后排查用 `CLIENT_MINIFY=0`）。
- **删除只删台账，不删盘**：级联清 `tasks`/`messages`/`notifications`，产物文件、`memories` 都保留；平台侧子会话历史（含 P1 起作为正文真源的会话日志）也没有删除 API。删除不可恢复。
- **删除不给活跃任务**：活跃状态先「停止」；终态任务若还有活跃下游依赖也不让删（`DELETE_HAS_ACTIVE_DEPENDENTS`）。
- 日报默认关闭；开启后每个主会话一条 schedule，主会话重建会重建 schedule。
- **配置卡片保存不热重载**：点「保存」只把值写进当前 profile 的 `cordis.patch.yml`，**运行中的插件不会 reload**——轮换判定、看门狗/陈旧计时器仍按启动时那份配置；改动不会自动生效：**重载插件或重启 DSH 后生效**（卡片回执与简介都写明这一点）。

## 面板动作幂等
- message 的 `clientRequestId` 去重只在 host-route 进程内（LRU 200 条），插件重启后失效；跨重启的严格去重需要把 id 落台账（当前 messages 表没有该列）。
- 没有 `clientRequestId` 的旧客户端按「同任务 3 秒内相同文本」去重；3 秒内故意发两条一模一样消息会被吞掉一条。
- 面板 stop 对已结束任务按幂等成功（`already:true`）返回；工具层 `task_message({action:'stop'})` 返回「已结束，无需停止」文本。两者都是 no-op。
- 面板 retry 在主会话失效时先拒绝、不建 ghost 任务；工具层历史行为是创建后标 failed 再抛错（兼容保留）。
