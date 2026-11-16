# 已知限制

本文件记录维护者需要知道、但不必塞进 README 的边界。README 只保留用户会影响的部分。

## 恢复与数据

- 台账每天生成快照，但**不自动恢复**；损坏时需手工用 `snapshots/tasks-YYYY-MM-DD.sqlite` 替换 `tasks.sqlite`。
- 快照按天保留，周期内重启不会重复覆盖。
- 产物自动收集依赖平台 `workspace/changes` + `workspaceChanges` 服务：Host 没挂这两个能力、会话在摘要登记前被释放、或改动发生在临时目录时，自动收集为空；显式 `task_report.artifacts` 始终保留。
- 现有回合的摘要要等 turn stopping 才追加；`task_report done` 当刻只能收到之前回合的摘要，当前回合由 `session/event` 监听在微任务里补收（面板下一次轮询可见）。
- 产物预览只读前 64 KiB 文本；二进制/目录只显示元信息。详情与产物页都只能**复制路径**，不能直接打开本地文件：面板是网页，浏览器不允许脚本静默打开本地文件。产物页的「打开子会话」打开的是产出它的任务会话，不是文件本身。
- 消息投递状态（待发/已投递/投递失败）写在台账 `messages.meta_json`；A3 之前的旧行没有该字段，只能按紧随的 `delivery_failed` 行推断，失败行落到 50 条消息窗口外的会显示成已投递。
- **最新返回消息只留最后一次**：结算时把子会话最后一条 assistant 消息写进台账——≤64 KiB 内联 `tasks.last_message_json`，更大写 `$DSH_HOME/state/orchestrator/reports/<taskId>.md`，台账只留路径 + 240 字摘要。后续回合/续派结算会覆盖旧记录，没有历史版本。
- `reports/` 不参与每日快照，也没有保留期清理（`snapshots/` 只清自己的文件）；手动删掉报告文件后，`task_status` 仍能显示摘要，`include: 'full'` 会给出读取失败原因。
- **只认结算事件**：插件在结算前被卸载、或进程直接被杀时没有返回消息可落；`subagent.failed`（激活被拒）本身没有输出，只留死因。

## 目标（G1）

- **goal 不驱动自动续跑**：插件只把 goal 当持久目标状态；`create` 之后**立即 `disarm`**，不会让平台 `goal-round-driver` 给子会话自动续轮。子会话回合结束后仍按原逻辑等 `task_message` 续派。
- **不是所有环境都有 goal 能力**：`ctx.goals` 缺失、旧版 profile 或服务方法被裁剪时，插件静默降级——不创建 goal、不 warn、不影响派发/续派/停止/结算；台账与面板不显示 goal 状态。
- **子会话写入限制**：goal 只能由宿主（本插件）对**注册表里的 live agent** 操作。冷恢复/重启后子 agent 还没进注册表时，`attach`/`update` 最多等 3 秒，超时跳过；该轮不会补建目标，下一次 `task_message` 成功后才可能补上。
- **目标不自动注入子会话**：平台的 `dsh-goal` 只管状态与投影（inject 只有 `agents` / `sessionProjections`），不往系统提示或消息里写 objective；子会话要看到**实时**目标必须自己调 `get_goal`。所以 worker 预设挂了 `tool-goal` 行——不挂这行时子会话读不到之后 `task_message` 并进去的「最新指示」（创建时的目标快照仍能从 `task_detail` 拿到）。
- **子会话只读目标、不能改**：`dsh-orchestrator-worker` 预设的 `tool-goal` 只提供 `get_goal` 的可用路径；`create_goal` / `update_goal` 由平台 `goalToolExecution` + `requireDirectHuman` 校验，要求**顶层 agent 的直接人类回合**，子会话调用必被拒（`GOAL_TOOL_AUTHORITY_REQUIRED`）。只有协调者的 `task_message`（或面板「追加」）会触发 `edit`。目标文本 = `task.goal` + `最新指示：<消息>`，超过 2000 字符截断，只是展示用的持久状态。
- **brief 只有编号和指引，详情要自己取（T1）**：brief 不再内联目标、验收、经验或兜底，只有 `【任务编号】` + 「先调 `task_detail` 读详情」。所以子会话的第一个动作应当是 `task_detail`；若它跳过这一步直接干活，只能靠 `get_goal`（实时目标）和自身上下文。前提是子会话工具表里有 `task_detail`：它由插件在 host plane 全局注册（`index.js` 的 `createTools(...).map(ctx.tools.register)`），worker 预设没有 `preset-tools` 收窄；如果你把 `workerPreset` 换成自带 allow/deny 收窄的预设、且没把 `task_detail` 列进 allow，子会话就只能靠 `get_goal` 和自己找上下文。
- **经验文件是快照，不是台账（T1）**：`lessons/<项目>-<hash>.md` 每次派发覆盖为「本次命中的事实层记忆」；没有历史版本、不参与每日快照、也没有保留期清理。手动删掉文件后，`task_detail` 里的指针会显示「文件已丢失」（下次派发重新生成）；要改记忆请用 `memory_note` / `history_search`，手改文件会被覆盖。写文件失败时经验以更长的内联块只出现在 `task_detail` 里（brief 长度不变，经验不会丢）。
- **`task_detail` 只读且只给自己**：它按创建时的 `brief_json` 快照返回目标/验收/经验，前置任务/产物按**当前**台账现读；主会话或别的子会话调用会被拒绝（越权）。它不写消息、不改状态，因此也不能用它「续派」或「修正」任务——那些仍走 `task_message` / `task_stop`。
- **终态收敛的边界**：`done→complete`；`stop/retry/orphaned/failed→clear`。孤儿/失败时子 agent 往往已不在注册表，平台侧不会真的调用 `clear`（平台 goal 只存在于该会话日志里，进程内也没人再驱动它），插件只把台账镜像标成 `cleared` 供面板显示。
- **外部重新 arm 的窗口**：插件只在 spawn/续派/终态钩子上保证 `disarmed`。如果其它组件（如用户在子会话里 `/goal resume`，或宿主未来改动）把同一个子会话重新 `arm`，插件不会实时监控，下一次钩子才会再压回 `disarmed`；这中间平台可能自动续轮。
- **面板只读**：面板与 `task_status` 能看 goal 的 phase/activation/轮次/修订，但没有暂停、恢复、清除 goal 的按钮或工具；要调整目标请直接 `task_message`。

## 回合间 keep-alive（K2）

- **默认关闭，且需要平台 goal**：`keepAlive` 只能是显式 `true`；`ctx.goals` 缺失（goal 降级）或到结算时都没能 attach 成功时，任务没有 `goal_state`，keep-alive 一律不注入——否则没人能判定「目标完成」，只能一路跑到轮数上限。开关的判定只看 phase 不是 `complete`/`cleared`，goal 之外的「做完没做完」不在插件判断范围内。
- **只在正常结束路径上生效**：`agent/turn-stopping` 只在 turn 正常收尾时派发。`aborted`（stop/父级 dispose）、`error`、blocked 都不经过它，所以 keep-alive 不能阻止显式停止、不能把异常回合救回来；`max-tokens` 即使走到 `turn-stopping`，最终结算原因仍由 `turn/end` 决定，不能靠 keep-alive「翻转」成完成。
- **续跑是宿主替子会话开工**：注入的是 `role:'user'` 消息（`source.kind='orchestrator-keepalive'`），子会话可能继续调工具、继续花钱；轮数上限只是「不再主动续」，不是成本控制，也不限制单轮内的工作量。自定义 source 在真实 Web UI/历史压缩里的表现尚未在真机验证（K1 探针用的是平台内置 kind）。
- **不和 armed goal 混用**：keep-alive 期间 agent 不 idle，平台 `goal-round-driver` 等不到 idle 触发，`roundsStarted`/`maxGoalRounds` 不会推进；预算只有台账的 `keep_alive_rounds`。插件自己的 goal 桥永远是 `create + disarm`，所以混用只会在外部把同一子会话重新 `arm` 时出现。
- **监听器必须吞错**：`turn-stopping` 是 serial 且被 await 的，监听器抛错可能打断当前回合。实现里 `handle` 全量 `try/catch`、`start()` 再兜一层；注入失败只记日志并算掉一轮（宁可少续，不多发），不回滚台账。
- **进程重启不跨回合**：keep-alive 只在进程内生效；重启后任务仍 `running` 但 agent 不在的，走 S2 对账 → `orphaned`。`keep_alive_rounds` 保留只读值，不阻止人工 `task_message`/重派。
- **多驱动叠加**：别的插件也监听 `turn-stopping` 时 inbox 会叠加。本插件发现 `nextStep`/`nextTurn` 非空就不再注入，但无法阻止别人注入。

## 编排

- `dependsOn` 只能指向已存在的任务；没有“编辑已有任务依赖”的接口，因此也不会出现环。
- 前置失败后，下游会被标 `failed`；要恢复需先 `task_retry` 前置，再重派下游。
- **同写域并发防护是「事后判定 + 可绕过」的护栏，不是文件锁**：`sameDirGuard=require` 只在 `task_create` 那一刻按台账判定，放行方式有三条（`task_close`/`task_stop`、`worktree:true`、`allowConcurrent:true`）；用户显式要求并发时协调者可以传 `allowConcurrent:true`，此时两个子会话仍会同时写同一批文件，冲突要人兜。它也不拦同一任务内部的并发写（同一子会话的并行工具调用）。
- 判定是**路径字面量**比较（解析成绝对路径后比相等/父子目录），不解析符号链接、`..` 之外的挂载点或大小写以外的文件系统语义；两个不同路径指向同一实体目录（bind mount / 符号链接）时判不出来。
- `writeScopes` 是**声明**不是事实：没标写域的任务只能按 target 判定，同目录以外、又没写域声明的重叠写不出护栏。
- `sameDirGuard=off` 等于退回旧的「只打一行 advisory」行为，出事时没有任何拦截。
- **防护只覆盖 `task_create`**：`task_retry` 与面板「重派」按原 brief/原 target 新起任务，不走这条判定。失败任务本身已释放目录，但若另一个活跃任务此时正在同一目录写，重派仍可能与它并发——重派前用 `task_list` 看一眼同目录任务。
- `priority` 只影响队列顺序，不抢占正在运行的子会话。
- `stallRounds` 达到阈值只提醒一次；没有“提醒后再无进展就二次升级”的完整阶梯。
- 空闲看门狗（W1）只告警一次、不改状态也不 kill；同一段空闲的去重表在内存，插件重启后允许再报一次。阈值只看台账里的心跳/消息/状态时间，子会话在长回合里既不上报 progress 也几乎不落消息时（例如长时间跑测试）可能被误判为「可能卡住」——看到告警先用 `task_status` 核对，别直接当成失败。
- 面板的组进度目前是 `task_list({group})` 文本 + 行内徽标，不是独立分组看板。

## 主会话与工具面

- 主会话预设能收窄全局工具，但 `spawn_teammate` / `send_message` / `list_agents` / `interrupt_agent` / `wait_agent` / `team_task_*` 是 **agent scope 自注册**的团队工具，`restrict` 遮不到；执行层 `guard` 会硬拦协调者，但工具表里仍可能看到这些残留。
- `config.coordinatorSession` 覆盖的会话没有预设保证，运行期 `restrict` 挂在回合边界；绑定当回合仍是全工具表，下一回合才收窄。
- 同一回合里并行发出、且在 guard 判定前就开始执行的 `wait_agent` 不承诺拦住；首绑回合 `task_create` 后不要并发等待类工具。
- `run_code` / PTC：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；若 profile 配了 PTC executor，协调者可能经它间接调用被 deny 的工具。desktop 默认没有 PTC executor。
- `show_view` 在 base asar 未证实存在；协调者 allow 默认不带。memory 已由插件自己的 `memories` 表实现，不依赖平台 memory 服务。
- `task_report` 目前靠全局注册对子会话可见；若某 profile 不可见，改为专用轻量工具模块，不把整个插件塞进 worker 预设。
- **子会话预设（`workerPreset`）只在派发时生效**：续派/冷恢复沿用会话创建时记下的 `agentPreset`，改配置不会切换已有子会话；值不是合法 preset id 时静默回落 `dsh-orchestrator-worker`（日志一行 warn）。
- **`orch-debug` 调试预设**复制随包「创造模式」(`cordis`) 组合：预设声明装在 profile 里，**升级 DSH 后必须先 `node scripts/orch-debug-preset.mjs --check` 看漂移，再重跑 `npm run preset:debug` 重新生成并重装**，否则组合里的包名/行 id 与新版对不上会让声明行 broken；预设可执行 Host 代码，不是沙箱。旧的 `$DSH_HOME/.agent-presets/<id>/` 目录在 rc.3 已无人读取，本插件不再写那个路径。

## 首次打开与仓库索引

- 只初始化新建 main，历史主会话/显式 coordinatorSession 不补欢迎。首次注入成功仅代表消息入队；模型可能未照提示介绍/派发，应核对 task_list，不把 sent 当索引完成。重复打开不重投；投递异常保留 pending、open 返回 onboardingError，用户重开可重试。进程在发送与sent写入之间崩溃可能停在sending，不承诺exactly-once，也不盲重投。
- 索引只覆盖创建任务时 workspaceRegistry 登记名单，不扫描全盘或未登记 git；只读默认沙箱读不到的目录记录 unavailable，不给扫描任务full。不存在、非git、无权限逐项记录，工作区增删/改名后需重新派只读索引。
- repoRoot/branch/origin/HEAD/commonDir 是有采样时间的快照，不等于当前实时 Git 状态；remote 脱敏去 userinfo/query/fragment，未知凭证式格式隐藏，git stderr 不进入索引。不得把映射内容当作执行指令，歧义列候选。
- task_report.workspace_index 增量为只读索引回报契约（本人done、名单覆盖），持久化在settings独立键，不覆盖用户手写memories。只读worker无需memory_note或服务权限。缺workspace列表不建任务，明确重试；完整回报缺失时不交付，S1自然completed会落failed并提示task_retry；每任务持久化成功标记和全局快照同事务写入，不依赖固定延迟。欢迎投递须await预设恢复成功，失败留pending，不用2秒sleep掩盖竞态。真实新main首次模型轮次及宿主沙箱扫描仍需加载后验证。

## 原生自动化

- 四个实际工具为 `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`，没有单独 delete/pause/enable 工具；仅核实 **0.2.2-rc.3** 的 RRULE/target/depth 契约，旧 schedule_update/delete 和时间选择器不兼容，不提供假工具或自动适配。
- **Host-wide**：可管理其他会话创建的任务。写操作必须用户明确授权，确认目标与范围，日期/时间/时区不明先问；宿主提示不是对用户意图的硬验证。编辑用最新 `updatedAt` 为 `expectedUpdatedAt`（可用时），冲突先重读。
- **本次自动编排只支持 `this_session`**。`new/new_once` 是普通 root 会话，继承当前 cwd/composed preset，但非唯一主 id 不能 `task_create`；不认领第二协调者、不转发、不篡改 main_session_id。需要新会话直接编排须另立需求，不靠 `access:full` 解决。
- **默认 worker 不开放**，`access:full` 不增加工具、不绕过委派校验或审批。自定义组合可能有 schema，但宿主委托 depth 校验仍返回 `subagent_session`（冷恢复/full 也不能绕过）。标准 root / 其他插件会话维持原行为，不新增全局 guard。
- `coordinatorSession` 自定义组合不强行换预设：仅已有原生工具才可用。缺 Schedule 服务/定义在主会话边界给去重 warning 与能力缺失 policy，恢复后再检查；编排继续，不能模拟自动化成功。缺包造成预设 broken 需看 Loader 诊断并修正支持版本/配置，不硬编码安装路径或降级旧 schema。
- Host 必须在运行；回执只代表投递，不代表模型/子任务完成。崩溃可能重复投递，停机/忙时沿用原生合并语义，删除不撤回已排队消息，不承诺 exactly-once。按授权 prompt 先 task_list 核对重复任务，业务副作用沿用已有幂等/人工核对。
- 本地模块测试不是已安装插件/当前 GUI 验证。安装/加载与彻底重启另需授权（刷新页面不足）；真实临时自动化写入、到期 task_create→worker→task_report 与 new/new_once 独立 Host 探针另行验收。回滚插件不会自动清除已授权的原生自动化。
- 契约来源：宿主 `@deepseek-ai/dsh-tool-schedule/src/index.ts` 的 registerScheduleTools/runForCaller/targetFor、同包 README.zh.md，以及宿主 `docs/subsystems/schedule.zh.md`（0.2.2-rc.3）；可复跑 [真实 scope 探针](probes/preset-scope-restrict.mjs)，不修改用户现有任务。

## 平台 / 沙箱

- `backend:'team'` 在 rc.3 不可用：`agentTeams` 成员 API 被移除，只剩任务板；插件会加载但派发返回可读错误，建议 `backend:'subagent'`。
- rc.3 子会话沙箱根取父会话目录（平台缺陷）：插件会给 target 登记可写根，但 Windows 上只对 harness 文件工具（read/write/edit）生效，`pwsh`/`bash` 子进程写 target 仍会被拒；`target` 不要用符号链接。
- worker 不强制 chdir：`danger-full-access` 下模型给目标目录外的绝对路径仍可能写成功；硬约束只能调回 `workspace-write`。
- 升级 DSH 后必须重跑 `docs/probes/*` 契约探针；平台入参形状变过（rc.1 → rc.3）。

- **per-task 完整访问（`access:'full'`）的边界**：
  - 它就是「本会话 `sandbox/mode = danger-full-access`」，平台侧 `fs`/`pwsh`/`bash` 全部解封（`fs-sandbox` 直接返回原
    目标、`pwsh-sandbox` 走 `super.start/run` 不做 confinement）——**写权限等于模型能改的一切**，没有额外护栏。
  - 与只读同一机制，所以**首回合窗口**同样存在（`agent/created` 之后才补 append，极短窗口内仍是继承来的模式）。
  - 平台在派发时会把**父会话自己的沙箱覆盖**按 `source:'delegation'` 种进子会话（`dsh-subagent` 的
    `appendDelegatedPolicyOverrides`）：父会话是 `workspace-write` 时普通子任务照旧受限，但父会话本身是
    `danger-full-access` 时，**所有**子任务默认就是完整访问——这不是插件给的，插件也不改写它（`access` 只能往上设，
    不会替子任务降级）。
  - **不继承到孙任务**：插件只对直接子会话 append，`access` 也不写进任何默认值/配置；但平台层面「子会话再派孙会话」
    仍会继承子会话自己的覆盖（平台行为），要严格管控就别让完整访问的子会话再派生任务。
  - Windows 下 `danger-full-access` 只解除沙箱，**不解除平台审批/权限预设**（审批被禁时会直接拒绝），也不改 `chdir`。

## 计划阶段（P8）

- **plan mode 是软引导**：平台只注入一段系统提示，不拦工具、不写沙箱状态。真正挡住写入的是只读沙箱；
  模型仍可能在计划阶段反复尝试写，被拒的错误会回灌给它（提示词已写明「只读是预期行为」）。
- **服务可见性**：`planMode` 挂在子会话预设作用域，插件必须走 `agent.ctx.get('planMode')`；
  平台版本没挂 / profile 没 isolate 时静默降级为「只有只读沙箱」并 warn 一行，派发不受影响。
- **`exit_plan_mode` 被拒**：插件在子会话 agent 作用域拒绝它——子会话没有直接人类，批准会悬空。
  计划出口固定是「`plan_save` 落盘 + `task_report blocked` 上报摘要」；协调者与其它会话不受该 guard 影响。
- **计划文档只有一版**：同一任务重复 `plan_save` **覆盖**同一份 `<主会话工作区>/reports/plans/<taskId>.md`，
  没有版本对比、没有审批流 UI（本版明确不做）；旧内容不保留，要留历史请让子会话在自己的目标目录里另存。
- **计划路径绑主会话工作区**：换主会话/换工作区目录后新计划落在新目录，旧文件留在原处（路径以任务产物与
  日志 `task.plan.saved` 为准）；插件不搬家、不清理。
- **`plan_save` 是插件的写，不是沙箱写**：它由宿主进程按固定路径写文件，所以计划阶段「只读」的边界仍是
  「沙箱拦子会话自己的文件工具」——`plan_save` 只能写这一个路径，不能当通用写入用（普通任务会被拒）。
- **切回可写的范围**：`workspace-write` 的根 = 子会话 `header.cwd`（rc.3 是**指挥舱**）+ 插件登记的 target 可写根，
  子会话理论上也能写插件的 state 目录。可接受但不理想，如实记录。
- **首回合窗口**：`ensureReadOnly` 在 `agent/created` 之后补，首回合有极短可写窗口（与 `readOnly` 任务同一风险）。
- **两处真相**：平台会话日志的 `plan/mode` 是运行期事实，台账 `plan_state` 是编排视图；重启/压缩后平台投影会恢复
  plan 状态，台账靠续派/终态事件对齐。面板与 `task_status` 显示的是台账视图，极端时序下可能短暂滞后。
- **互斥**：`planFirst` 与 `readOnly` 创建期互斥（只读任务永远不会切回可写）。
- **rc 包**：`@deepseek-ai/dsh-plan-mode` 仍是 rc 包，升级 DSH 后要按仓库惯例重跑 `docs/probes/contract-probe-t0.1.mjs`
  复核 `set()` / `get()` / `exit_plan_mode` 契约。

## worktree 隔离（P9）

- **合并责任在用户**：平台没有合并工具，插件也不提供。worktree 任务的产物**不在你的工作树里**；
  通知 / `task_status` / 面板都写「产物在分支 X 的检出目录 Y，合并由你决定」，但要不要合并、什么时候合并由你决定。
- **判定权在协调者（模型）**：声明只有结构化两处（配置 `worktreePolicy` + `task_create.worktree*`），插件不解析
  自然语言。所以「用户写了必须隔离但模型漏传」是真实风险——缓解是配置写 `worktreePolicy: required`（漏传也会兜底建），
  以及 `task_status` / 面板显示「未隔离（决定 default）」让人能发现。插件不做语义判断，也不替模型拍板。
- **`needsBranchChoice` 多一次往返**：仓库近 N 天有 ≥2 个活跃分支且没给 `worktreeBase` 时，插件**不建任务**、
  只返回候选。协调者可能忘记重调 —— 返回文案固定要求「带 worktreeBase 重调」，且任务不落库、不占并发位。
- **检出目录占磁盘**：默认 `worktreeCleanup:'off'` 全保留，长期会堆积（`.agents/worktrees/<taskId>`）；
  推荐 `checkout-only`（保留分支、只删检出）。
- **宿主依赖 git**：宿主没装 git / 不在 PATH 时建树失败 → 任务标 `failed`（`GIT_MISSING`），不自动降级
  （用户显式要的隔离没做成，静默降级会让产物落回工作树）。
- **`.agents/` 可能出现在 `git status`**：`.git/info/exclude` 不可写时只 warn，目录会显形；
  同样原因，`full` 档删分支失败也只记日志。
- **并发**：同一仓库多个任务各自独立检出、互不干扰；但并发 `git commit` 会争 `.git` 锁（git 自己处理，失败要能读地报出来）。
  **同一检出上不要并发两个任务**——`worktreeMode:'continue'` 复用同一目录时必须用 `dependsOn` 串行（`writeScopes` 只提示不锁）。
- **Windows 长路径**：检出目录用「`<repo>/.agents/worktrees/<taskId>`」固定短路径，分支名不进路径；仍建议真机先验一次。
- **互斥**：`worktree` 与 `readOnly` / `planFirst` 在创建期拒绝；计划批准后要隔离请重新派发。
- **子会话写范围**：与普通任务同口径（`workspace-write` 根 = 子会话 `header.cwd` + 登记的 target 可写根），
  worktree 只是把 target 换成检出目录，没有额外收紧。

## 通知与生命周期

- 通知走 `agent.steer`：空闲唤醒、忙时 next-step 排队；同一 agent 的忙时排队由平台保证。
- 平台另发 `subagent-settled`，不经过本插件、不写 `notifications`，不能当成插件投递成功。
- **结算自动收场（S1）只覆盖「一次 activation」**：派发侧 `activation.result` 只对第一次生效，`task_message` / 冷恢复起的轮次只能靠 `subagent/end` 观察；平台若停发该事件，续派轮次会退回「只有 `task_report` 才推终态」。
- **`completed` 不等于「工作做完了」**：continuable 子会话可以在一轮结束时正常收场等续派。所以只在「没上报过 progress」时才自动 `done`；上报过 progress 的回合结束落 `orphaned`（可重派），由人决定下一步。
- **caller signal 在发布后不再取消子会话**（真机 S4 实测 `completed`）：插件侧取消只能靠 `dispose()` / interrupt，落 `aborted`。
- `refusal` 只有源码级依据（pre-step hook deny / 策略拒绝），真机没有稳定构造；`max-tokens` 由 `maxTokens` 截断触发，真实长输出落同一个值。
- headless 一次性进程在 5 秒合并窗口内退出时，`steer` 可能因 initiator scope dispose 失败；`notifications` 记 `failed` 是正确审计。长驻 desktop/服务进程不受影响。
- 重启窗口：子会话已完成但结算事件尚未被消费时重启，会对账为 `orphaned`，结果会丢，重建即可。
- Bot 模式：ds-bot 的 Bot 表面只认自己的 DSH Agent 会话，打开主会话后视图可能仍停在 Bot 会话；纯 dsh 表面不受影响。

## UI

- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见入口是侧栏「主会话」（始终可见）和会话头「任务」面板（仅主会话可见）。
- **任务入口依赖宿主身份信号**：会话头「任务」入口的显示条件 = 当前会话 id 与台账 `main_session_id` 相等。当前会话 id 取不到
  （UI 还没选中会话、插件晚加载）或 `session-role` 请求失败时按「不是主会话」处理，入口**默认隐藏**；会话切换会立即重判，
  另有 5 秒兜底轮询。因此刚打开主会话的 1 秒内可能短暂看不到入口，属预期。侧栏「◈ 主会话」入口不受影响。
- 入口隐藏只是 UI 层：`main` 面板（`key:'orchestrator'`）仍然注册，`/api/orchestrator` 的 `snapshot`/动作端点也没有会话身份校验
  （owner-only 由平台 connection 负责）；真正的主会话权限仍由 `task_*` 工具的调用方校验兜底，不能把入口隐藏当成安全边界。
- 面板是轮询（2s），没有 SSE；任务很多时快照会变大。
- **删除只删台账，不删盘**：面板「删除」级联清 `tasks` / `messages` / `notifications`，但产物文件、
  `reports/<taskId>.md` 全文报告、`memories` 里的经验/决策都保留（它们是用户数据与跨任务知识）；
  平台侧的子会话历史也没有删除 API，删的只是本插件的任务记录。
- **删除不给活跃任务**：`waiting_dep` / `pending` / `running` / `waiting_user` / `waiting_auth` 先「停止」；
  终态任务若还有活跃下游依赖也不让删（`DELETE_HAS_ACTIVE_DEPENDENTS`），否则下游会因「前置不存在」直接失败。
  删除不可恢复（每日台账快照里可能还能找到旧行，但没有自动恢复入口）。
- 删除与「追加」的按钮可见性由 `src/panel-gates.js` 统一判定并随 snapshot/detail 下发；旧版快照没有
  `canFollowup`/`canDelete` 字段时按 false 处理（fail-closed，按钮不显示）。
- 日报默认关闭；开启后每个主会话一条 schedule，主会话重建会重建 schedule。

## 面板动作幂等

- message 的 `clientRequestId` 去重只在 host-route 进程内（LRU 200 条），插件重启后失效；跨重启的严格去重需要把 id 落台账（当前 messages 表没有该列）。
- 没有 `clientRequestId` 的旧客户端按「同任务 3 秒内相同文本」去重；3 秒内故意发两条一模一样消息会被吞掉一条。
- 面板 stop 对已结束任务按幂等成功（`already:true`）返回；工具层 `task_stop` 保持返回「已结束，无需停止」文本。两者都是 no-op，不冲突。
- 面板 retry 在主会话失效时先拒绝、不建 ghost 任务；工具层历史行为是创建后标 failed 再抛错（兼容保留）。
