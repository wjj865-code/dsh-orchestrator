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
- **目标不自动注入子会话**：平台的 `dsh-goal` 只管状态与投影（inject 只有 `agents` / `sessionProjections`），不往系统提示或消息里写 objective；子会话要看到目标必须自己调 `get_goal`。所以 worker 预设挂了 `tool-goal` 行——不挂这行时子会话对目标完全无感（`get_goal` 工具根本不在工具表里）。
- **子会话只读目标、不能改**：`dsh-orchestrator-worker` 预设的 `tool-goal` 只提供 `get_goal` 的可用路径；`create_goal` / `update_goal` 由平台 `goalToolExecution` + `requireDirectHuman` 校验，要求**顶层 agent 的直接人类回合**，子会话调用必被拒（`GOAL_TOOL_AUTHORITY_REQUIRED`）。只有协调者的 `task_message`（或面板「追加」）会触发 `edit`。目标文本 = `task.goal` + `最新指示：<消息>`，超过 2000 字符截断，只是展示用的持久状态，不改变 brief。
- **终态收敛的边界**：`done→complete`；`stop/retry/orphaned/failed→clear`。孤儿/失败时子 agent 往往已不在注册表，平台侧不会真的调用 `clear`（平台 goal 只存在于该会话日志里，进程内也没人再驱动它），插件只把台账镜像标成 `cleared` 供面板显示。
- **外部重新 arm 的窗口**：插件只在 spawn/续派/终态钩子上保证 `disarmed`。如果其它组件（如用户在子会话里 `/goal resume`，或宿主未来改动）把同一个子会话重新 `arm`，插件不会实时监控，下一次钩子才会再压回 `disarmed`；这中间平台可能自动续轮。
- **面板只读**：面板与 `task_status` 能看 goal 的 phase/activation/轮次/修订，但没有暂停、恢复、清除 goal 的按钮或工具；要调整目标请直接 `task_message`。

## 编排

- `dependsOn` 只能指向已存在的任务；没有“编辑已有任务依赖”的接口，因此也不会出现环。
- 前置失败后，下游会被标 `failed`；要恢复需先 `task_retry` 前置，再重派下游。
- `writeScopes` 是冲突提示，不是锁；同域任务仍可能并行写。
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

## 平台 / 沙箱

- `backend:'team'` 在 rc.3 不可用：`agentTeams` 成员 API 被移除，只剩任务板；插件会加载但派发返回可读错误，建议 `backend:'subagent'`。
- rc.3 子会话沙箱根取父会话目录（平台缺陷）：插件会给 target 登记可写根，但 Windows 上只对 harness 文件工具（read/write/edit）生效，`pwsh`/`bash` 子进程写 target 仍会被拒；`target` 不要用符号链接。
- worker 不强制 chdir：`danger-full-access` 下模型给目标目录外的绝对路径仍可能写成功；硬约束只能调回 `workspace-write`。
- 升级 DSH 后必须重跑 `docs/probes/*` 契约探针；平台入参形状变过（rc.1 → rc.3）。

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

- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见入口是侧栏「主会话」和会话头「任务」面板。
- 面板是轮询（2s），没有 SSE；任务很多时快照会变大。
- 日报默认关闭；开启后每个主会话一条 schedule，主会话重建会重建 schedule。

## 面板动作幂等

- message 的 `clientRequestId` 去重只在 host-route 进程内（LRU 200 条），插件重启后失效；跨重启的严格去重需要把 id 落台账（当前 messages 表没有该列）。
- 没有 `clientRequestId` 的旧客户端按「同任务 3 秒内相同文本」去重；3 秒内故意发两条一模一样消息会被吞掉一条。
- 面板 stop 对已结束任务按幂等成功（`already:true`）返回；工具层 `task_stop` 保持返回「已结束，无需停止」文本。两者都是 no-op，不冲突。
- 面板 retry 在主会话失效时先拒绝、不建 ghost 任务；工具层历史行为是创建后标 failed 再抛错（兼容保留）。
