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

**已知缺口（真机确认）**：`spawn_teammate` / `send_message` / `list_agents` 是平台按 agent scope 注册的团队工具，不在 `restrictableNames` 里，`tools.restrict({deny})` 去不掉；真机冒烟里协调者工具 34→21，这三个仍在。阶段 3 用 agent preset 的 `composition.toolFilter` 固化。

## 6. 通知投递与审计口径

- **插件通知**：`notify.js` 分级 → 5 秒合并（done）/立即（blocked、needs_auth）→ 通过 `agent.steer` 注入协调者会话 → 每次尝试写一行 `notifications`：
  - 成功 `delivered` + `delivered_at`；
  - 失败 `failed` + `delivered_at=NULL` + `reason`；
  - 跳过 `skipped` + `delivered_at=NULL`（缺 sender / 未配置 coordinatorSession / 协调者会话未加载）。
- **平台 settlement 通知**：`subagent-settled`，不经过 notifier、不写行；它只能解释「协调者为什么被唤醒」，不能证明插件通知成功。
- 两者在真机可能同时出现（平台 settlement + 插件注入），验收看 `notifications` 行与插件注入次数是否 1:1，而不是看协调者是否收到任意消息。

