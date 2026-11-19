# dsh-orchestrator 平台接口探测记录（Task 5）

- 日期：2026-11-13
- 探测对象：已安装的 DeepSeek Harness 0.2.2-rc.1（`C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`，213,202,918 bytes）
- 复跑：`node docs/probes/api-probe.mjs`（可用参数或 `DSH_ASAR` 指向别的安装包）
- 结果：16/16 PASS；脚本逐条打印命中的实现片段与偏移，下面只摘结论。
- 边界：这是对**已安装实现**的源码级探测（读包内实现文本），不是起一个真实 Team 跑模型回合。R8 的「协调者忙时排队不丢」由 Chief 在真机冒烟时验证；本文件给出机制级结论与代码路径。

## 1. `ctx.agentTeams` 的注入名

最终值：`agentTeams`（服务名），另有 `agents` 与 `tools`。

- 服务注册：`TeamService extends Service`，构造器 `super(ctx, "agentTeams")`。
- 平台真实工具插件 `@deepseek-ai/dsh-experimental-tool-agent-team` 的声明是：
  `const inject = ["agents", "agentTeams", "tools", "systemPrompt"]`。
- 本插件因此声明 `inject = ['tools', 'agentTeams', 'agents']`。若某个运行时没有挂 agent-team 包，加载会因缺服务而失败，这是预期的失败方式（不是静默跳过）。

## 2. `agent` 对象怎么拿到

两条路，作用不同：

1. **插件装配时按会话 id 查**：`ctx.get('agents').get(sessionId)`。
   - `agents` 服务（`AgentRegistry`）的 `get(id)` 文档明确写的是 “the shared agent/session id to look up”，实现是 `return this.store.get(id)?.agent`，只返回**当前 live** 的 agent。
   - 仅当协调者会话已经加载才拿得到；拿不到时不能把插件带崩，工具仍要注册，派活时再给可读错误。
2. **工具执行时拿调用方**：工具 `execute(args, exec)` 的 `exec.agent` 就是发起这次调用的 agent。平台真实工具插件用 `callingAgent(exec.agent, "send_message")` 做同一件事。

结论：`index.js` 采用「惰性解析」——派活/停止时按 `coordinatorSession` 现查 live agent，并订阅 `agent/created` 在协调者会话后来加载时补装白名单；不在 `apply()` 时把 `undefined` 永久缓存。

## 3. teammate 的 `id` 与 `session_id`

`spawnTeammate` 返回 roster 行；实现里：

```js
const childId = brandString(randomUUID())
const member = { id: childId, name, description, provider, context, phase: 'provisioning' }
```

- `member.id` 就是子会话 id（`childId`），台账的 `session_id` 用它；阶段 2 UI 跳转也用它。
- `member.name` 是模型侧 `target`（`listMembers` 的 `modelMember()` 会去掉 `id`，只暴露 `target`），`sendMessage` / `interrupt` 都用这个 name。
- 台账因此分别写 `session_id = member.id`、`target = member.name`。
- **`spawnTeammate` 的 `provider` 和 `signal` 都是必填**：`spawnAdmitted` 里 `provider: requiredText(request.provider, "provider", 200)`，且 `AbortSignal.any([request.signal, this.lifecycle.signal])` 遇到 `undefined` 会直接抛 `TypeError`。平台工具插件的 fresh 默认是 `freshProvider = "spawn"`；本插件默认 `spawnProvider = 'spawn'`（可配），并从工具 `exec.signal` 透传 `signal`。
- **`sendMessage` 的 `signal` 也是必填**：服务内部同样先 `AbortSignal.any([request.signal, ...])`。续派消息从 `exec.signal` 透传；通知不走 `sendMessage`（见第 4、6 节）。

## 4. 向 lead 发消息能不能唤醒协调者自身会话

**能唤醒，但不能拿它做延迟通知的发送方。**

- 发送路径：`sendMessage(caller, {target, content})` → `sendAdmitted`；目标为 root（Lead）时执行 `root.steer(createUserMessage(...))`。
- `steer` 的实现是 `this.send(input, "next-step", true)`；`send()` 把消息 splice 进 inbox 后执行 `if (wakeup) this.wakeDriver(...)`。**wakeup = true，所以会唤醒驱动器。**
- 忙时：消息进入 `next-step` 队列（`inbox.splice(resolvedTarget, Infinity, 0, [message])`），在下一步边界被接纳，不丢；空闲时由 `wakeDriver` 起一轮。
- **限制一**：`sendAdmitted` 里有 `if (target.id === caller.id) throw new TeamError("a Team member cannot message itself", "TEAM_SELF_MESSAGE")`。协调者（Lead）不能给自己发。
- **限制二（真机踩到）**：`sendAdmitted` 先 `resolveActiveMember(root, state, request.target)` 校验发送方仍是 active 成员；fresh teammate 的回合一 settle 就被 dispose，5 秒合并窗口后它已不在 roster，发送报 `TEAM_NOT_MEMBER`。所以「谁回报谁发 + 延迟合并」在真机不可用。
- **因此本插件不经过 `sendMessage` 发通知，改为直接驱动协调者会话**（B 方向）：
  - `ctx.get('agents').get(coordinatorSession)` 拿到 live Agent，调用 `agent.steer(message)`。
  - 消息形状与平台内部一致：`{ id: randomUUID(), role: 'user', content: [{type:'text',text}], source: { kind:'agent-message', form:'relay', senderSessionId } }`。证据：`createUserMessage(input)` 就是 `createMessage({...input, role:'user'})`，而 `createMessage` 只补 `id: brandString(randomUUID())` 并冻结；`agent-message` source 类型是 `{kind:'agent-message', form:'relay', senderSessionId}`。
  - `agent.steer` 的入参、唤醒、忙时排队与上一段完全相同（`next-step` + `wakeDriver`），所以 5 秒合并可以保留，且不要求发送方此刻还在 roster。
  - 协调者会话未加载时 `resolveCoordinator()` 为 undefined：记 `skipped`，不误记 `delivered`。
- **平台还有一条独立链路**：continuable 子会话 settle/dispose 时，`dsh-subagent` 的 `notifySettlement` 会给父会话发一条带 closing message 的 `subagent-settled` 通知。它不经过本插件 notifier、没有 `notifications` 行，**不是插件通知**；审计时不能把「协调者被唤醒」直接当成插件通知成功。

## 5. 协调者工具集/白名单声明方式（R4 探测）

存在低成本机制，但只能声明在 **agent 作用域**：

- `ctx.tools.restrict(filter)`，`filter` 形状是 `{ allow?: string[], deny?: string[] }`（`ToolRestriction`）。
- 实现要求 `scopeOf(ctx)` 非空，否则报 “tools.restrict() requires a scoped context (agent.ctx)”；也就是说必须挂在某个 agent 的 `ctx` 上（`agent.ctx.tools.restrict(...)`），不能从插件根 ctx 全局限制（否则会把所有 agent 一起限制）。
- 名字必须是**全局工具名**：`view(agent).restrictableNames` 是 `restrict()` 实际校验的集合；`knownNames` 还包含 scope 内注册的工具，不能直接喂 `restrict`。返回 disposer，可撤销。
- 平台子 agent 组合也用同一机制：`childCtx.tools.restrict(composition.toolFilter)`，预设层还可以用 `composition.toolFilter` 声明。

决定（阶段 1 最小实现）：协调者 agent 可解析时，对 `agent.ctx.tools` 用 `deny` 列表限制文件/shell/浏览器/web 类工具；取 `view(agent).restrictableNames` 求交集再 `restrict`，避免未知名字抛错。协调者当时未加载时跳过并 warn，靠 `agent/created` 补装。

**已知缺口（真机确认）**：`spawn_teammate` / `send_message` / `list_agents` 是平台按 agent scope 注册的团队工具，不在 `restrictableNames` 里，`tools.restrict({deny})` 去不掉；`wait_agent` 同样是 `register(scoped.tools.register(defineTool({ name: "wait_agent" ... })))` 的 scope 注册，也去不掉。真机冒烟里协调者工具 34→21，这些仍在。阶段 2 用 agent preset 的 `composition.toolFilter` 固化。
- 机制证据：`view(scope)` 只把**继承来的全局工具**同时加进 `knownNames` 和 `restrictableNames`；`own.tools`（scope 内注册）只加进 `knownNames`，而 `restrict()` 校验用的是 `restrictableNames`。
- **运行期收窄必须延到回合边界**：`restrict()` 是即时层；回合中调用会让当前请求的工具表（已组装、含 `pwsh`）与执行视图（已收窄）错位，模型下一调用就是 `unknown tool "pwsh"`。`agent/pre-step` 也不能当挂点——平台 `step()` 先 `tools.resolve()` 再 `systemPrompt.assemble()`，pre-step waterfall 更晚。本插件在绑定时若 `agent.status === 'running'` 只挂 `pendingRestrictions`，监听 `agent/status` 在 `status === 'idle'` 时装（`setPhase(idle)` 在 `wakeDriver()` 起下一轮之前发）；本来就 idle 才即时装。

## 8. `wait_agent` 等待禁令（P0）

`wait_agent` 会阻塞当前模型回合；白名单去不掉它，所以运行期用两层保护：

- **系统提示（按会话动态）**：`inject` 必须包含 `systemPrompt`；注册
  `ctx.systemPrompt.context({ name: 'orchestrator:coordinator-policy', order: 130, interpolate: false, text: context => ... })`。
  - `order` 用数字（`context()` 要求 finite）；`text(context)` 在每次 `systemPrompt.assemble` 时调用，`context.agent` 就是当前会话。
  - 渲染时现查 `config.coordinatorSession ?? settings.coordinator_session_id`，只有 `context.agent.id` 等于协调者才返回禁令，其他会话/子会话返回 `''`，不会串会话；重绑后自动跟着变。
  - 提示里显式声明优先级：以上规则优先于平台 `team:policy` 的 “The Lead must wait for required teammates” 等默认等待要求。
  - 时序：绑定发生在 step N，step N+1 的 prompt 起带禁令；step N 的请求已经组装完，不能承诺首绑回合一定带提示。
- **执行期 guard（同一回合也能拦）**：`ctx.tools.guard(exec => string | undefined)` 是同步、单调的拒绝；返回原因字符串即拒绝，后续监听器无法翻案。guard 在插件 apply 时注册、每次调用时现查绑定 id：只拒绝 `exec.name === 'wait_agent' && exec.agent.id === 协调者`，子任务/普通会话照常。
  - 因为 guard 不依赖工具表，`task_create` 写入绑定后，**同一回合里顺序执行的 `wait_agent`** 也会被拒绝；同一条 assistant 消息里并行发出、且在绑定写入前就开始执行的 `wait_agent` 仍可能漏过（执行顺序不保证），所以「首绑回合绝对安全」不承诺。
- 阶段 2 用 agent preset 的 `composition.toolFilter` 从工具表层面根治，运行期白名单/guard 降为兜底。
- **工具表时序**：绑定发生在 step N 时，step N 的工具表已是全量（`wait_agent`/`pwsh` 都在，也可能还能调用）；收窄延到回合结束（`agent/status idle`），下一回合的 `tools.resolve()` 才看不到被 deny 的工具。step N 的 prompt 若已组装也不会变；step N+1 的 prompt 才带禁令。guard 能拒「绑定写入后、顺序执行」的 `wait_agent`，但同一条 assistant 消息里在绑定前就并行开始的调用仍可能漏过。

## 6. 通知投递与审计口径

- **插件通知**：`notify.js` 分级 → 5 秒合并（done）/立即（blocked、needs_auth）→ 通过 `agent.steer` 注入协调者会话 → 每次尝试写一行 `notifications`：
  - 成功 `delivered` + `delivered_at`；
  - 失败 `failed` + `delivered_at=NULL` + `reason`；
  - 跳过 `skipped` + `delivered_at=NULL`（缺 sender / 未配置 coordinatorSession / 协调者会话未加载）。
- **平台 settlement 通知**：`subagent-settled`，不经过 notifier、不写行；它只能解释「协调者为什么被唤醒」，不能证明插件通知成功。
- 两者在真机可能同时出现（平台 settlement + 插件注入），验收看 `notifications` 行与插件注入次数是否 1:1，而不是看协调者是否收到任意消息。

### 收尾期 `agent initiator scope is disposed`（真机 F 轮）

这个错误不是 sender 子会话的 scope，也不是协调者的 scope，而是 **进程级 `AgentRegistry` 的 initiator 作用域**：

- `ReactLoopAgent.wakeDriver()` 在空闲启动驱动器时执行 `this.loopCtx.agents.withInitiator(this, () => this.kick())`。
- `AgentRegistry.runWithInitiator` 第一行是 `if (this.initiatorState !== "active") throw new Error(DISPOSED_INITIATOR_MESSAGE)`，文案就是 `agent initiator scope is disposed`；`disposeInitiators()` 在服务 effect 卸载时把状态置 `disposed`。
- `steer()` 先 `inbox.splice` 再 `wakeDriver`，所以真机现象是「seq 101 有注入记录，但通知行 `failed`、协调者没起回合」：消息已经进 inbox，进程在收尾，驱动器不允许再启动。
- 因此这是 **headless 一次性进程在 5 秒合并窗口内退出** 的收尾竞态，不是 sender 离队（B 已用 `agent.steer` 绕开 roster），也不是生产长驻进程的路径。长驻进程里 `AgentRegistry` 保持 active，`steer` 会正常唤醒。
- 状态保持 `failed` + reason 是正确审计：注入发生了，但没有回合消费它。headless 冒烟若要在收尾前看到 `delivered`，需让进程在最后一条回报后活过 `mergeWindowMs`。
- source 仍用 `{kind:'agent-message', form:'relay', senderSessionId}`，因为 sender scope 不在这条失败路径上；换成 `orchestrator-notification` 不能解决进程收尾。

## 7. 主会话（固定入口 + 预设开启，替代自动绑定）

平台契约见 `docs/probes/main-session-probe.md`；这里只记本插件的接法。

- 台账 `settings` 键改为 `main_session_id`；解析顺序 `config.coordinatorSession`（显式覆盖，优先，不写台账）→ `settings.main_session_id` → 未打开。
- 主会话由 `src/main-session.js` 创建：`workspaceRegistry.resolveByPath`（没有就 `mkdir` + `create(path, '指挥舱')`）→ `sessionController.create({ workspaceId, agentPreset: 'dsh-orchestrator-coordinator' })` → `sessionController.rename({ sessionId, title: '主会话' })` → 写 `settings.main_session_id`。
- 复用条件以台账为准：`main_session_id` 指向的会话 live **且** `settings.main_session_preset === 协调者预设` 才复用；平台读回（`agentPresets.presetForSession` 是事件投影，空白会话被 UI resume 时会 append `agent-preset/selected: standard` 翻转）只作诊断，不一致记 `main.session.preset-mismatch`，不重建。旧版主会话没有台账标记时，能明确读到协调者预设才认领，否则重建一次（`main.session.recreate`）。
- 预设守护：复用前/`agent/created` 时若读回不是协调者且会话仍 blank，调 `agentPresets.select(agent, 协调者预设)` 拉回；非 blank 抛 `agent-preset/locked` 只记日志，由 guard 兜底。`create` 返回值里的 `agentPreset` 会回传并写进 `main.session.created` 日志。
- 派发可重试：`dispatch.spawn` 在 `parent.session` 为空或 `parent.id` 缺失时抛「协调者会话尚未就绪…」，队列按可重试留在 pending；真失败标 failed 并给主会话推 system 通知（无 sender 时用主会话 id 投递），日志带 `error.stack` 前三行。
- rc.1→rc.3 兼容：`startActivation` 先发扁平 spec（rc.3），报 `spec.parent/request.parent` 形状错误时回退旧 `request` 包装；`stop` 优先 `interrupt(target, { kind: 'user' })`（rc.3 的 authority 只认 `{kind:'ancestor'|'user'}`，`task_message({action:'stop'})` 是用户动作；裸 agent 不在契约里）、否则 `interruptByParent`；catalog 优先 `listDescendants`、否则 `listChildren`。升级后重跑全部契约探针。
- rc.3 起 team 后端整体不可用：`agentTeams` 只剩 `state`/`transact` 与团队任务板，`spawnTeammate`/`sendMessage`/`interrupt`/`listMembers` 已移除。P0-1 直接删掉了 `createTeamDispatcher`（未发版），P1-A 又删掉了 `backend` 配置键与占位派发器：`createDispatcher` 现在只有 subagent 一条路，老 profile 里的 `backend` 会在加载时给一条弃用警告、按默认值运行。
- rc.3 子会话沙箱根缺陷（已实测 + 源码核对）：`childSessionMeta` 用 `parentHeader.cwd` 作子会话 `meta.cwd`，`spec.cwd` 只经 `workingDirectory.set(child, create.cwd)` 追加事件；`sandboxPolicy.sessionWorkspaceRoot = session.header.cwd`，所以 `workspace-write` 下子会话写 target 被拒（`%TEMP%` 豁免）。兜法：`sandboxPolicy.registerWritableRoot(session, targetDir)`，session 必须是 `agents.get(childId).session` 同一对象（平台内部 WeakMap 按身份查）；`dispatch.spawn` 后注册，续派在 `sendMessage` **成功后**按恢复出的新 Session 对象幂等补注册（发送前通常解析不到）；按 targetId 追加记录、settle 不释放、`task_message({action:'stop'})`/终态把新旧对象全部释放。Windows 上只对 harness 文件工具生效，pwsh/bash 进程写仍被拒。
- 工具 schema 注意：`tool.parameters` 会原样进模型 JSON Schema，`required` 只能是字符串数组——写布尔 `required: true` 会被 provider 以 400 拒绝（真机 rc.3 报 `Invalid schema for function 'task_report': true is not of type "array"`，子会话首回合必挂）。必填在运行时校验（如 `normalizeArtifacts` 丢空 path），schema 层不带布尔 required。
- `sessionController.create` 入参没有 `title`，标题必须单独 `rename`；`rename` 依赖 `sessionTitle` 服务，失败只记日志，不影响主会话可用。
- 子会话 cwd：`startActivation.request.cwd` 直接用目标目录（必须是存在的绝对目录），沙箱边界就是该 cwd；没给 target 时沿用父会话 cwd。
- `task_create` 不再绑定调用方；`task_*`（除 `task_report`）只允许主会话调用，没有主会话时返回「尚未打开主会话，请先从面板「打开主会话」」。
- 白名单：主会话由协调者预设的 `preset-tools` 用 deny 补集定型（只留 5 个 `task_*`，`ask_user_question` 由预设自有行提供）；配置覆盖的会话没有预设保证，保留运行期 `restrict` + `wait_agent` guard 兜底。
- 双预设：子会话由 dispatch 显式带 `dsh-orchestrator-worker`（`startActivation.request.agentPreset`），绕开 `composeFrom` 的父预设工具继承；worker 预设必须自带工具行（空 `plugins` 不会继承 profile 全量工具）。
- `spawnProvider` 只支持 `spawn`（fork 不满足 `capabilities.agentPreset`）；不是 `spawn` 时打开主会话返回可读错误，不静默降级。
- 客户端入口判定：`/api/orchestrator` 新增只读端点 `session-role`（`{ sessionId }` → `{ ok:true, isMain }`）。
  宿主用 `coordinatorStatus().id`（`config.coordinatorSession` → `settings.main_session_id`）与请求里的 sessionId 走
  `src/session-role.js` 的 `isMainSession` 比较；任一侧缺失/不等都回 `isMain:false`。客户端只在 `isMain:true` 时显示
  会话头「任务」入口，信号不可用时默认隐藏；侧栏「◈ 主会话」入口不经过该判定，始终可见。

## 8. 工作区推断与 artifacts（阶段 3 增量）

- 工作区实体：`workspaceRegistry.list()` 返回 `{id, path(realpath 规范化), title}`；`title` 默认是路径末段，允许不同路径同名。
- 推断纯函数在 `src/workspace-match.js`：显示名 + 路径末段双键；精确优先、只在最高层取结果；ASCII 键 ≥3、CJK 键 ≥2；按 id 去重；唯一命中用 `path` 并写 `target_dir`，多命中返回候选不建任务，无命中不写（沿用主会话目录，通常是指挥舱；覆盖会话时跟随该会话目录）。
- `task_report` 的 `artifacts`：相对路径按 `target_dir ?? 指挥舱` 解析；只 `stat` 不读文件；非法条目丢弃；`exists:false` 标「未找到」但不失败。
- 台账 `tasks.artifacts_json`（旧库 ALTER + 旧行按 `[]`）；通知在 done/blocked/needs_auth 文本里追加产物块；快照 `tasks[].artifacts` 与 `taskCard.artifactCount` 供面板展示。




