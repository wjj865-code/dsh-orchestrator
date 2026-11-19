# 已知限制

本文件记录维护者需要知道、但不必塞进 README 的边界（README 只留用户会踩到的 6 条，细节都在这里）。
每条都是**当前实现的真实边界**，不是 todo；改实现前先读对应章节。

## 恢复与数据

- 台账每天生成快照，但**不自动恢复**；损坏时手工用 `snapshots/tasks-YYYY-MM-DD.sqlite` 替换 `tasks.sqlite`。周期内重启不会重复覆盖。
- 产物自动收集依赖平台 `workspace/changes` + `workspaceChanges`：Host 没挂这两个能力、会话在摘要登记前被释放、或改动发生在临时目录时收集为空；显式 `task_report.artifacts` 始终保留。
- 当前回合的摘要要等 turn stopping 才追加；`task_report done` 当刻只能收到之前回合的摘要，当前回合由 `session/event` 监听在微任务里补收（面板下一次轮询可见）。
- 产物预览只读前 64 KiB 文本；二进制/目录只显示元信息。详情与产物页只能**复制路径**，不能直接打开本地文件（网页不允许脚本静默打开）；「打开子会话」打开的是产出它的任务会话，不是文件。
- 消息投递状态（待发/已投递/失败）写在 `messages.meta_json`；A3 之前的旧行没该字段，只能按紧随的 `delivery_failed` 行推断，失败行落到 50 条消息窗口外的会显示成已投递。
- **最新返回消息只留最后一次**：结算时把子会话最后一条 assistant 消息写进台账——≤64 KiB 内联 `tasks.last_message_json`，更大写 `reports/<taskId>.md`（台账只留路径 + 240 字摘要）。后续回合/续派会覆盖，没有历史版本。
- `reports/` 不参与每日快照、没有保留期清理；手删报告后 `task_status` 仍显示摘要，`include:'full'` 给出读取失败原因。
- **只认结算事件**：插件在结算前被卸载、或进程被杀时没有返回消息可落；`subagent.failed`（激活被拒）本身没有输出，只留死因。

## 目标（G1）

- **goal 不驱动自动续跑**：插件只把 goal 当持久目标状态；`create` 之后**立即 `disarm`**，不让平台 `goal-round-driver` 自动续轮。回合结束后仍等 `task_message` 续派。
- **不是所有环境都有 goal 能力**：`ctx.goals` 缺失、旧 profile 或服务方法被裁剪时静默降级——不创建、不 warn、不影响派发/续派/停止/结算；台账与面板不显示 goal 状态。
- **子会话写入限制**：goal 只能由宿主对本插件对注册表里的 live agent 操作。冷恢复/重启后子 agent 未进注册表时 `attach`/`update` 最多等 3 秒，超时跳过；该轮不补建，下一次 `task_message` 成功后才可能补上。
- **目标不自动注入子会话**：平台 `dsh-goal` 只管状态与投影，不往系统提示/消息里写 objective；子会话要看**实时**目标必须自己 `get_goal`（worker 预设有 `tool-goal` 行，缺它就读不到之后 `task_message` 并进去的「最新指示」，创建时的目标快照仍能从 `task_detail` 拿）。
- **子会话只读目标**：`create_goal`/`update_goal` 要**顶层 agent 的直接人类回合**（`GOAL_TOOL_AUTHORITY_REQUIRED`），子会话调用必被拒；只有协调者的 `task_message`（或面板动作）会触发 `edit`。目标文本 = `task.goal` + `最新指示：<消息>`，超 2000 字符截断。
- **brief 只有编号和指引，详情要自己取（T1）**：brief 只有 `【任务编号】` + 三条回报指引；子会话第一个动作应当是 `task_detail`。若它跳过，只能靠 `get_goal` 与自身上下文；前提是工具表里有 `task_detail`（全局注册，worker 预设不收窄）——换成自带 allow 名单的 `workerPreset` 时要把它列进 allow。
- **子会话不能直接问用户**：`userQuestions.ask` 的 `assertLiveRoot` 对 `origin === 'subagent'` 抛 `DELEGATED_CALLER`。要拍板只能交回协调者：`blocked`/`needs_auth` 带 `question` + `options`；`done` 不支持 `question`/`options`（`clearTaskQuestion` 会把它们清空），要点必须写进 `summary`；真正提问始终由协调者带选项完成。
- **`blocked` 上报不等于授权**：它只是把决策点交回协调者；子会话不能因为「报过 blocked」就自行推进，也不能拿它绕过推送前双审查或人工确认门禁。
- **worktree 装依赖提示只是「允许装」**：`【worktree 依赖】` 只在隔离任务里出现，措辞限定「只安装不升级」；插件不代为执行、不保证锁文件不变。
- **经验文件是快照，不是台账（T1）**：`lessons/<项目>-<hash>.md` 每次派发覆盖为本次命中的事实层记忆；无历史版本、不参与快照、无保留期。手删后 `task_detail` 指针显示「已丢失」（下次派发重建）；要改记忆用 `memory_note` / `context({mode:'history'})`。写文件失败时经验改为只出现在 `task_detail` 的内联块。
- **`task_detail` 只读且只给自己**：按创建时 `brief_json` 返回目标/验收/经验，前置与产物按**当前**台账现读；主会话或别的子会话调用被拒。它不写消息、不改状态，不能用来「续派」或「修正」任务。
- **终态收敛的边界**：`done→complete`；`stop/retry/orphaned/failed→clear`。孤儿/失败时子 agent 往往已不在注册表，平台侧不会真的 `clear`，插件只把台账镜像标成 `cleared` 供面板显示。
- **外部重新 arm 的窗口**：插件只在 spawn/续派/终态钩子上保证 `disarmed`；别的组件把同一子会话重新 `arm` 时不会实时压回，下一次钩子才处理，中间平台可能自动续轮。
- **面板只读**：面板与 `task_status` 能看 goal 的 phase/activation/轮次/修订，但没有暂停/恢复/清除的按钮或工具；调整目标请 `task_message`。

## 回合间 keep-alive（K2）

- **默认关闭，且需要平台 goal**：`keepAlive` 只认显式 `true`；`ctx.goals` 缺失或到结算都没 attach 成功时没有 `goal_state`，一律不注入（否则没人判定「目标完成」，只能跑到轮数上限）。判定只看 phase 不是 `complete`/`cleared`。
- **只在正常结束路径生效**：`agent/turn-stopping` 只在 turn 正常收尾时派发；`aborted`（stop/父级 dispose）、`error`、blocked 都不经过它，所以 keep-alive 不能阻止显式停止、救不回异常回合；`max-tokens` 的最终结算原因仍由 `turn/end` 决定。
- **续跑是宿主替子会话开工**：注入 `role:'user'` 消息（`source.kind='orchestrator-keepalive'`），子会话可能继续调工具、继续花钱；轮数上限只是「不再主动续」，不是成本控制，也不限制单轮工作量。自定义 source 在真实 Web UI/历史压缩里的表现尚未真机验证。
- **不和 armed goal 混用**：keep-alive 期间 agent 不 idle，平台 `goal-round-driver` 等不到 idle，`roundsStarted`/`maxGoalRounds` 不推进；预算只有台账的 `keep_alive_rounds`。
- **监听器必须吞错**：`turn-stopping` 是 serial 且被 await，监听器抛错会打断当前回合；实现全量 try/catch，注入失败只记日志并算掉一轮（宁可少续）。
- **进程重启不跨回合**：keep-alive 只在进程内生效；重启后任务仍 `running` 但 agent 不在的走对账 → `orphaned`。`keep_alive_rounds` 只读保留，不阻止人工续派/重派。
- **多驱动叠加**：别的插件也监听 `turn-stopping` 时 inbox 会叠加；本插件发现 `nextStep`/`nextTurn` 非空就不再注入，但阻止不了别人注入。

## 编排

- `dependsOn` 只能指向已存在任务；没有「编辑已有任务依赖」的接口，因此不会出现环。前置失败后下游标 `failed`；恢复要先重派前置再重派下游。
- **同写域并发防护是「事后判定 + 可绕过」的护栏，不是文件锁**：`sameDirGuard=require` 只在 `task_create` 那一刻按台账判定，三条放行路（关闭/停止旧任务、`worktree:true`、`allowConcurrent:true`）；显式放行后两个子会话仍会同时写，冲突要人兜；也不拦同一任务内部的并行写。
- 判定是**路径字面量**比较（绝对路径相等/父子目录），不解析符号链接与 `..` 之外的挂载点/大小写语义；两个不同路径指向同一实体目录（bind mount/软链）时判不出来。`writeScopes` 是声明不是事实。`sameDirGuard=off` 等于退回旧的只打一行 advisory。
- **防护只覆盖 `task_create`**：`task_message({action:'retry'})` 与面板「重派」按原 brief/target 新起任务，不走这条判定；重派前先 `task_list` 看同目录任务。
- `priority` 只影响队列顺序，不抢占正在运行的子会话。`stallRounds` 达到阈值只提醒一次，没有二次升级阶梯。
- 空闲看门狗（W1）只告警一次、不改状态也不 kill；去重表在内存，重启后允许再报一次。阈值只看台账心跳/消息/状态时间，长时间跑测试的单回合可能被误判「可能卡住」——先用 `task_status` 核对。
- 面板组进度是 `task_list({group})` 文本 + 行内徽标，不是独立分组看板。

## 主会话与工具面

- `spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`wait_agent`/`team_task_*` 是 **agent scope 自注册**的团队工具，`restrict` 遮不到；执行层 `guard` 硬拦协调者，但工具表里仍可能看到残留。
- `config.coordinatorSession` 覆盖的会话没有预设保证，运行期 `restrict` 挂在回合边界：绑定当回合仍是全工具表，下一回合才收窄。同一回合并行发出、且在 guard 判定前就开始执行的 `wait_agent` 不承诺拦住。
- `run_code` / PTC：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；profile 配了 PTC executor 时协调者可能经它间接调用被 deny 的工具（desktop 默认没有）。`show_view` 在 base asar 未证实存在，allow 默认不带。
- `task_report` 靠全局注册对子会话可见；若某 profile 不可见，改为专用轻量工具模块，不把整个插件塞进 worker 预设。
- **`workerPreset` 只在派发时生效**：续派/冷恢复沿用会话创建时的 `agentPreset`，改配置不切换已有子会话；值非法时静默回落 `dsh-orchestrator-worker`（日志一行 warn）。
- **`orch-debug` 调试预设**：复制随包「创造模式」组合，预设声明装在 profile 里；升级 DSH 后必须先 `node tools/debug-preset/cli.mjs --check` 看漂移，再重新生成并重装，否则组合里的包名/行 id 可能与新版对不上而 broken。预设可执行 Host 代码，不是沙箱。生成器与文档自 P1-E 起不随 npm 包发货（开发仓库 `tools/debug-preset/`）。

## 主会话轮换（G1）

- **归档不可逆，这是本功能最硬的边界**：`rotateArchiveOld` 默认 `true`，收尾把旧主会话改名「主会话（已退役 YYYY-MM-DD HH:MM）」再 `archiveSession()`（从列表隐藏）。平台**没有 unarchive API**，插件也不提供恢复；能选的只有事前配置 `rotateArchiveOld:false`（只改名）或 `mainRotation:'off'`（完全不换，**P1-A 起是默认值**）。归档动作本身幂等，但「已归档」不可撤销。
- **判定只有一个调用点**：`main-session.openOnce()` 在**旧主会话 live**时算一次。启动、`agent/created`、面板轮询、刷新都不判定；旧会话不 live 时走既有「隐式重建」，不算轮换。没有强制轮换的按钮/工具/端点/配置。**每次打开都现算**（P1-A 删了检查节流：采集只剩一次 `locate` + `stat`）。
- **判定是快照，动作前不复查**：`evaluate → rotateMain` 之间来新任务/消息/回合仍按旧结论执行；保护规则挡的是判定时刻的 `active-tasks`/`delivered`/`agent-running`/`recent-activity`；并发打开只生效一次（in-flight 复用），轮换后新会话未 live 的 **60 秒窗口**内再打开交回同一 id，过期后回到「不 live 就重建」。
- **指标口径与降级**：只剩 `main-log`（`sessionPersistence.locate` + `stat`，坏则记 `degraded`、**不按 0 算**）与 `age`（`since`：先 `settings.main_session_created_at`，退 `header.createdAt`）。只有**两个因子全拿不到**才 fail-closed（`metrics-degraded`）。`main-log` 是压缩后日志大小，不等于上下文占用。
- **保护规则的边角**：`active-tasks` 只算 waiting_dep/pending/running/waiting_user/waiting_auth（不含 `delivered`，由 `delivered-pending` 单独挡）；`delivered-artifacts` 是其子集；`recent-activity` 只看主会话日志 mtime（定位失败时缺席）；`active-children` 依赖 `dispatcher.catalog()`（读不到按「无法判断」，不挡也不误挡）；`coordinator-override` 与 `spawn-provider` 命中时连采集都不做。
- **崩溃中间态**：marker（`main_rotation_pending`）写失败只记日志、轮换继续，之后崩溃**无法自动恢复**；marker 形状坏掉（`invalid`）只清 marker + 告警，**绝不猜 id 去归档**；`abandoned` 恢复会把空白残留会话归档（同样不可逆）；`complete` 恢复幂等，但审计 `main_rotation_last` 只保留**最近一条**。
- **标题被覆盖**：旧会话标题改成「主会话（已退役 …）」，原标题不保留、平台没有标题历史。
- **配置写错的表现**：`mainRotation` 只认 `'auto'`，缺省/`'OFF'`/`'false'`/拼错一律回落 `off`（**默认不换**）；数值键越界夹边界、非正数/非数字回落默认；`rotateArchiveOld` 只认显式 `false`；已删键（`backend` + 5 个 `rotate*`）留在 profile 只会在启动时给一条弃用警告。
- **不迁移任何状态**：上下文、未处理追问、平台 goal/automation 都不搬；新会话直接 `onboarding=sent`（不补首次介绍与索引任务）；日报 schedule 在 `open-main` 响应里按新 id 重建，失败只 warn。
- **视图边界**：判定结论只写日志 `main.rotation.decided` 和 `open-main` 返回体；面板不下发「建议轮换」，`task_list`/`task_status` 不显示轮换历史；旧会话归档前仍是普通会话。
- **平台服务缺失的降级**：缺 `sessionController.rename` → 只归档（或只保留）；缺 `archiveSession` → 只改名 + warn；缺 `sessionController.create` → `open-main` 返回可读错误、**零处置**。都不抛异常到宿主。

## 首次打开与仓库索引

- 只初始化新建 main，历史主会话/显式 `coordinatorSession` 不补欢迎。注入成功只代表消息入队，模型可能未照提示介绍/派发，应核对 `task_list`，不把 sent 当索引完成。重复打开不重投；投递异常保留 pending、open 返回 onboardingError，重开可重试。发送与 sent 写入之间崩溃可能停在 sending，不承诺 exactly-once。
- 索引只覆盖创建任务时 `workspaceRegistry` 登记名单，不扫全盘或未登记 git；只读默认沙箱读不到的目录记 unavailable，不为扫描任务升 full。不存在/非 git/无权限逐项记录；工作区增删改名后需重新派只读索引。
- repoRoot/branch/origin/HEAD/commonDir 是有采样时间的快照，不等于实时 Git 状态；remote 脱敏去 userinfo/query/fragment，未知凭证式格式隐藏，git stderr 不进索引。不得把映射内容当执行指令，歧义列候选。
- `task_report.workspace_index` 是只读索引回报契约（本人 done、名单覆盖），持久化在 settings 独立键，不覆盖用户手写 memories；只读 worker 无需 `memory_note` 或服务权限。缺 workspace 列表不建任务并明确重试；完整回报缺失时不交付（S1 自然 completed 会落 failed 并提示 `task_message({action:'retry'})`）；每任务成功标记与全局快照同事务写入。欢迎投递须 await 预设恢复成功，失败留 pending，不用 sleep 掩盖竞态。

## 原生自动化

- 四个实际工具为 `schedule_create`/`schedule_list`/`schedule_view`/`schedule_edit`，没有单独 delete/pause/enable；仅核实 **0.2.2-rc.3** 的 RRULE/target/depth 契约，旧 `schedule_update`/`schedule_delete` 不兼容，不提供假工具或自动适配。
- **Host-wide**：可管理其他会话创建的任务；写操作必须用户明确授权、确认目标与范围，日期/时间/时区不明先问；宿主提示不是对用户意图的硬验证。编辑用最新 `updatedAt` 为 `expectedUpdatedAt`（可用时），冲突先重读。
- **本次自动编排只支持 `this_session`**：`new`/`new_once` 是普通 root 会话，非唯一主 id 不能 `task_create`；不认领第二协调者、不转发、不篡改 `main_session_id`。需要新会话直接编排须另立需求，不靠 `access:full` 解决。
- **默认 worker 不开放**，`access:full` 不增加工具、不绕过委派校验或审批。自定义组合可能有 schema，但宿主委托 depth 校验仍返回 `subagent_session`（冷恢复/full 也不能绕过）。
- `coordinatorSession` 自定义组合不强行换预设：仅已有原生工具才可用。缺 Schedule 服务/定义在主会话边界给去重 warning 与能力缺失 policy，恢复后再检查；编排继续，不能模拟自动化成功。缺包造成预设 broken 需看 Loader 诊断并修正支持版本/配置。
- Host 必须运行；回执只代表投递，不代表模型/子任务完成。崩溃可能重复投递，停机/忙时沿用原生合并语义，删除不撤回已排队消息，不承诺 exactly-once；按授权 prompt 先 `task_list` 核对重复任务。
- 本地模块测试不是已安装插件/当前 GUI 验证；安装/加载与彻底重启另需授权（刷新页面不足）；真实临时自动化写入与到期 `task_create→worker→task_report` 另行验收。回滚插件不会自动清除已授权的原生自动化。
- 契约来源：宿主 `@deepseek-ai/dsh-tool-schedule` 的 registerScheduleTools/runForCaller/targetFor 与同包 README.zh.md、宿主 `docs/subsystems/schedule.zh.md`（0.2.2-rc.3）；可复跑 [真实 scope 探针](probes/preset-scope-restrict.mjs)。

## 平台 / 沙箱

- `backend` 键已删除（P1-A）：派发只剩 subagent 一条路；老 profile 留着只会启动时给一条弃用警告。
- rc.3 子会话沙箱根取父会话目录（平台缺陷）：插件给 target 登记可写根，但 Windows 上只对 harness 文件工具（read/write/edit）生效，`pwsh`/`bash` 写 target 仍被拒；`target` 不要用符号链接。
- worker 不强制 chdir：`danger-full-access` 下模型给目标目录外的绝对路径仍可能写成功；硬约束只能调回 `workspace-write`。
- 升级 DSH 后必须重跑 `docs/probes/*` 契约探针（平台入参形状变过 rc.1 → rc.3）。
- **per-task 完整访问（`access:'full'`）**：等于本会话 `sandbox/mode = danger-full-access`，`fs`/`pwsh`/`bash` 全部解封——**写权限等于模型能改的一切**，没有额外护栏。首回合窗口同样存在（`agent/created` 之后才补）。平台在派发时把父会话自己的沙箱覆盖按 `source:'delegation'` 种进子会话：父会话是 `danger-full-access` 时**所有**子任务默认完整访问（不是插件给的，插件也不改写，`access` 只能往上设）。不继承到孙任务（插件只对直接子会话 append），但平台层面子会话再派生仍继承自己的覆盖。Windows 下只解除沙箱，**不解除平台审批/权限预设**，也不改 `chdir`。

## 协调者读产物（`read_workspace`）

- **边界 = 主会话工作区 ∪ 已登记产物**（`tasks.artifacts_json`：`task_report` 显式回报 + `done` 自动收集）。子会话按契约把产物写在 target 目录内，那些路径不在工作区里，但**只要登记过就能读**；未登记的同目录文件仍被拒——读取面是「工作区 + 登记集合」，不是整个 target。
- **没回报 artifacts 的产物读不到**：`done` 时的 `workspaceChanges` 自动收集只覆盖本轮被改动/新建的文件，覆盖不到手工放在别处的东西。
- **登记表不借符号链接放行**：登记一个指向别处的链接不等于登记真实路径；链接本身不登记，读取按真实路径判定。
- **`.mr-watch/` 等外部技能私有状态不要读**（`mr-watch-state`/`mr-comments` 的水位与锁是用户级技能私有数据），读进来只会污染协调者上下文。
- **不是全盘读，也不是 glob**：没有目录递归枚举、没有模式匹配；看目录就逐层读条目（一层最多 200 项）。原因是平台读路径没有白名单，自建入口必须自己守边界。
- **边界靠真实路径判定**：符号链接逃逸、`../` 穿越、工作区外且未登记的绝对路径都被拒并写 `workspace.read.rejected`；但工作区里本来就有的软链指向内部是正常文件，允许读。
- **已登记产物的目录条目会放开子树**：产物允许是目录，登记一个目录等于放开它下面所有文件；回报「整个仓库根」会把面放得很大，属使用纪律，插件不做二次收窄。
- **截断是常态**：默认 400 行、单次 ≤64 K 字符；单行本身超 64 K 时只返回前 64 K 并标 `truncatedLine`（这一行后半截读不到）。`offset`/`limit` 收字符串，非法值回落默认。> 4 MB 直接拒绝，不整块读入。
- **IM 外发风险**：profile 开了 IM 双向同步时，读进上下文的正文可能随「最终助手文字」同步到外部且**不可撤回**；涉密产物不要读进主会话——这是本能力最主要的残余风险，不是可配置项。
- **不用于校验存在性**：存在性仍由插件（通知路径已 `lstat`）与子任务保证。

## 状态与提示词的单一事实源（0.19.2）

- **状态能力表只有一份**（`src/status-facts.js` 的 `STATUS_CAPS`）：`active`/`followup`/`resumable`/`deletable`/`terminal`/`releases`/`retryable`/`waiting`/`rotationActive`/`liveness`/`catalog`/`watchdog`/`planSettled`。新增状态只改这张表，13 处引用自动跟上。
- **三条死边已删**：`running→done`、`failed→running`、`orphaned→pending` 从未有调用点；删边只影响未来迁移，不改存量行（要「直接完成」走 `running→delivered→done`）。
- **`failed` 不是流程终态但已收尾**：`terminal:false`（能重派）、`releases:true`（释放资源）；对失败任务「停止」是幂等成功（`already:true`），不会再被改成「已取消」（0.19.x 缺陷已修）。
- **worktree 状态转移会校验**（`WORKTREE_TRANSITIONS`）：非法转移抛错而不是静默写入；历史台账里的非法旧值会在下一次 `setTaskWorktree` 时报错，需要人工修数据。
- **提示词五层各有独占职责**（`src/prompt-layers.js` 的 `PROMPT_LAYERS`）：L1 协调者 policy / L2 brief / L3 task_detail / L4 onboarding / 通知 hint；`layerViolations` 是机器可读归层探针，测试用它防「删掉的重叠又抄回来」。
- **偏好不是权限通道**：只是 `settings.orchestrator_preferences` 里的提示词文本，不进 config、不改 dispatch、不碰 `sandboxPolicy`；内置种子里不放「放宽安全边界」的条目。全局偏好只写 settings 不写 memories，`context({mode:'history'})` 查不到（`memory_note` 返回文案会明确告知）。超限（默认 12 条 / 1200 字）按 priority 降序保留并写明「另有 N 条未展示」，被截掉的**不会生效**也不报错。

## 计划阶段（P8）

- **plan mode 是软引导**：平台只注入一段系统提示，不拦工具、不写沙箱状态；真正挡住写入的是只读沙箱。模型仍可能反复尝试写，被拒错误会回灌给它（提示词已写明只读是预期）。
- **服务可见性**：`planMode` 挂在子会话预设作用域，插件必须走 `agent.ctx.get('planMode')`；没挂/没 isolate 时静默降级为「只有只读沙箱」并 warn 一行，派发不受影响。
- **`exit_plan_mode` 被拒**：插件在子会话 agent 作用域拒绝（子会话没有直接人类，批准会悬空）；出口固定是「`plan_save` 落盘 + `task_report blocked`」。
- **计划文档只有一版**：重复 `plan_save` **覆盖**同一份 `<主会话工作区>/reports/plans/<taskId>.md`，没有版本对比、没有审批流 UI；旧内容不保留。
- **计划路径绑主会话工作区**：换主会话/工作区后新计划落新目录，旧文件留原处（以任务产物与 `task.plan.saved` 日志为准），插件不搬家不清理。
- **`plan_save` 是插件的写，不是沙箱写**：由宿主进程按固定路径写，所以计划阶段「只读」的边界仍是「沙箱拦子会话自己的文件工具」；它只能写这一个路径，不能当通用写入（普通任务会被拒）。
- **切回可写的范围**：`workspace-write` 的根 = 子会话 `header.cwd`（rc.3 是指挥舱）+ 插件登记的 target 可写根，子会话理论上也能写插件 state 目录。可接受但不理想。首回合窗口同样存在。
- **两处真相**：平台会话日志的 `plan/mode` 是运行期事实，台账 `plan_state` 是编排视图；重启/压缩后平台投影会恢复，台账靠续派/终态事件对齐。面板与 `task_status` 显示台账视图，极端时序下可能短暂滞后。`planFirst` 与 `readOnly` 创建期互斥。
- **rc 包**：`@deepseek-ai/dsh-plan-mode` 仍是 rc 包，升级 DSH 后按仓库惯例重跑 `docs/probes/contract-probe-t0.1.mjs` 复核 `set()`/`get()`/`exit_plan_mode` 契约。

## worktree 隔离（P9）

- **合并责任在用户**：平台没有合并工具，插件也不提供；worktree 任务的产物**不在你的工作树里**。通知/`task_status`/面板都写「产物在分支 X 的检出目录 Y，合并由你决定」，但要不要合并由你决定。
- **判定权在协调者（模型）**：声明只有结构化两处（配置 `worktreePolicy` + `task_create.worktree*`），插件不解析自然语言。「用户写了必须隔离但模型漏传」是真实风险——缓解是配置 `required`（漏传也兜底建），以及 `task_status`/面板显示「未隔离（决定 …）」让人能发现。
- **`needsBranchChoice` 多一次往返**：仓库近 N 天 ≥2 个活跃分支且没给 `worktreeBase` 时**不建任务**、只返回候选；协调者可能忘记重调——返回文案固定要求「带 worktreeBase 重调」，任务不落库、不占并发位。
- **检出目录占磁盘**：默认 `worktreeCleanup:'off'` 全保留，长期会堆积（`.agents/worktrees/<taskId>`）；推荐 `checkout-only`（保留分支、只删检出）。
- **宿主依赖 git**：没装 git/不在 PATH 时建树失败 → 任务 `failed`（`GIT_MISSING`），不自动降级（用户显式要的隔离没做成）。
- **`.agents/` 可能出现在 `git status`**：`.git/info/exclude` 不可写时只 warn；同样原因下 `full` 档删分支失败也只记日志。
- **并发**：同一仓库多个任务各自独立检出、互不干扰；并发 `git commit` 会争 `.git` 锁。**同一检出上不要并发两个任务**——`worktreeMode:'continue'` 复用同一目录时必须 `dependsOn` 串行（`writeScopes` 只提示不锁）。
- **Windows 长路径**：检出用「`<repo>/.agents/worktrees/<taskId>`」固定短路径，分支名不进路径；仍建议真机先验一次。
- **互斥**：`worktree` 与 `readOnly`/`planFirst` 创建期拒绝；计划批准后要隔离请重新派发。
- **子会话写范围**：与普通任务同口径（`workspace-write` 根 = `header.cwd` + 登记的 target 可写根），worktree 只是把 target 换成检出目录。

## 通知与生命周期

- 通知走 `agent.steer`：空闲唤醒、忙时 next-step 排队；同一 agent 的忙时排队由平台保证。平台另发 `subagent-settled`，不经过本插件、不写 `notifications`，不能当成插件投递成功。
- **结算自动收场（S1）只覆盖「一次 activation」**：派发侧 `activation.result` 只对第一次生效，`task_message`/冷恢复起的轮次只能靠 `subagent/end` 观察；平台若停发该事件，续派轮次退回「只有 `task_report` 才推终态」。
- **`completed` 不等于「工作做完了」**：continuable 子会话可以一轮正常收场等续派，所以只在「没上报过 progress」时自动 `done`；上报过 progress 的回合结束落 `orphaned`（可重派）。
- **caller signal 在发布后不再取消子会话**（真机 S4 实测 `completed`）：插件侧取消只能靠 `dispose()`/interrupt，落 `aborted`。
- `refusal` 只有源码级依据（pre-step hook deny / 策略拒绝），真机没有稳定构造；`max-tokens` 由 `maxTokens` 截断触发，真实长输出落同一个值。
- headless 一次性进程在 5 秒合并窗口内退出时，`steer` 可能因 initiator scope dispose 失败；`notifications` 记 `failed` 是正确审计。长驻 desktop/服务进程不受影响。重启窗口内子会话已完成但结算未消费时，会对账为 `orphaned`，重建即可。
- Bot 模式：ds-bot 的 Bot 表面只认自己的 DSH Agent 会话，打开主会话后视图可能仍停在 Bot 会话；纯 dsh 表面不受影响。

## UI

- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见入口是侧栏「主会话」（始终可见）和会话头「任务」面板（仅主会话可见）。
- **任务入口依赖宿主身份信号**：显示条件 = 当前会话 id 与台账 `main_session_id` 相等。当前会话 id 取不到（UI 还没选中会话、插件晚加载）或 `session-role` 请求失败时按「不是主会话」处理，入口**默认隐藏**；会话切换立即重判，另有 5 秒兜底轮询——刚打开主会话 1 秒内可能短暂看不到入口。侧栏入口不受影响。
- 入口隐藏只是 UI 层：`main` 面板仍注册，`/api/orchestrator` 的 snapshot/动作端点也没有会话身份校验（owner-only 由平台 connection 负责）；真正的主会话权限仍由 `task_*` 工具的调用方校验兜底，不能把入口隐藏当安全边界。
- 面板是 2s 轮询、没有 SSE；任务很多时快照会变大。
- **删除只删台账，不删盘**：级联清 `tasks`/`messages`/`notifications`，产物文件、`reports/<taskId>.md` 全文、`memories` 都保留；平台侧子会话历史也没有删除 API。
- **删除不给活跃任务**：活跃状态先「停止」；终态任务若还有活跃下游依赖也不让删（`DELETE_HAS_ACTIVE_DEPENDENTS`）。删除不可恢复（每日快照里可能还能找到旧行，但没有自动恢复入口）。
- 删除与续派的按钮可见性由 `src/panel-gates.js` 统一判定并随 snapshot/detail 下发；旧版快照没有 `canFollowup`/`canDelete` 时按 false 处理（fail-closed）。
- 日报默认关闭；开启后每个主会话一条 schedule，主会话重建会重建 schedule。

## 面板动作幂等

- message 的 `clientRequestId` 去重只在 host-route 进程内（LRU 200 条），插件重启后失效；跨重启的严格去重需要把 id 落台账（当前 messages 表没有该列）。
- 没有 `clientRequestId` 的旧客户端按「同任务 3 秒内相同文本」去重；3 秒内故意发两条一模一样消息会被吞掉一条。
- 面板 stop 对已结束任务按幂等成功（`already:true`）返回；工具层 `task_message({action:'stop'})` 返回「已结束，无需停止」文本。两者都是 no-op。
- 面板 retry 在主会话失效时先拒绝、不建 ghost 任务；工具层历史行为是创建后标 failed 再抛错（兼容保留）。
