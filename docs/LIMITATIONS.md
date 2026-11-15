# 已知限制

本文件记录维护者需要知道、但不必塞进 README 的边界。README 只保留用户会影响的部分。

## 恢复与数据

- 台账每天生成快照，但**不自动恢复**；损坏时需手工用 `snapshots/tasks-YYYY-MM-DD.sqlite` 替换 `tasks.sqlite`。
- 快照按天保留，周期内重启不会重复覆盖。
- 产物自动收集依赖平台 `workspace/changes` + `workspaceChanges` 服务：Host 没挂这两个能力、会话在摘要登记前被释放、或改动发生在临时目录时，自动收集为空；显式 `task_report.artifacts` 始终保留。
- 现有回合的摘要要等 turn stopping 才追加；`task_report done` 当刻只能收到之前回合的摘要，当前回合由 `session/event` 监听在微任务里补收（面板下一次轮询可见）。
- 产物预览只读前 64 KiB 文本；二进制/目录只显示元信息。详情与产物页都只能**复制路径**，不能直接打开本地文件：面板是网页，浏览器不允许脚本静默打开本地文件。产物页的「打开子会话」打开的是产出它的任务会话，不是文件本身。
- 消息投递状态（待发/已投递/投递失败）写在台账 `messages.meta_json`；A3 之前的旧行没有该字段，只能按紧随的 `delivery_failed` 行推断，失败行落到 50 条消息窗口外的会显示成已投递。

## 编排

- `dependsOn` 只能指向已存在的任务；没有“编辑已有任务依赖”的接口，因此也不会出现环。
- 前置失败后，下游会被标 `failed`；要恢复需先 `task_retry` 前置，再重派下游。
- `writeScopes` 是冲突提示，不是锁；同域任务仍可能并行写。
- `priority` 只影响队列顺序，不抢占正在运行的子会话。
- `stallRounds` 达到阈值只提醒一次；没有“提醒后再无进展就二次升级”的完整阶梯。
- 面板的组进度目前是 `task_list({group})` 文本 + 行内徽标，不是独立分组看板。

## 主会话与工具面

- 主会话预设能收窄全局工具，但 `spawn_teammate` / `send_message` / `list_agents` / `interrupt_agent` / `wait_agent` / `team_task_*` 是 **agent scope 自注册**的团队工具，`restrict` 遮不到；执行层 `guard` 会硬拦协调者，但工具表里仍可能看到这些残留。
- `config.coordinatorSession` 覆盖的会话没有预设保证，运行期 `restrict` 挂在回合边界；绑定当回合仍是全工具表，下一回合才收窄。
- 同一回合里并行发出、且在 guard 判定前就开始执行的 `wait_agent` 不承诺拦住；首绑回合 `task_create` 后不要并发等待类工具。
- `run_code` / PTC：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；若 profile 配了 PTC executor，协调者可能经它间接调用被 deny 的工具。desktop 默认没有 PTC executor。
- `show_view` 在 base asar 未证实存在；协调者 allow 默认不带。memory 已由插件自己的 `memories` 表实现，不依赖平台 memory 服务。
- `task_report` 目前靠全局注册对子会话可见；若某 profile 不可见，改为专用轻量工具模块，不把整个插件塞进 worker 预设。

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
