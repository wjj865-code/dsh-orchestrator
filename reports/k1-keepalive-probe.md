# K1 探针：`agent/turn-stopping` keep-alive 可行性验证

- 日期：2026-11-15
- 平台：DeepSeek Harness Desktop `0.2.2-rc.3`（`resources/app.asar/dsh`，只读安装包）
- 探针代码：[docs/probes/keepalive-probe/index.js](../docs/probes/keepalive-probe/index.js)、[run.ps1](../docs/probes/keepalive-probe/run.ps1)
- 原始事件：`docs/probes/keepalive-probe/out/k1-events.{followup,steer,followup-async,none}.jsonl`
- 产品代码：**未改动**；本任务只做可行性验证与改动点设计。

## 1. 结论

**可行。** 前提是使用平台自带的扩展点，而不是在 `idle` 之后抢投消息：

1. 插件可以全局订阅 `agent/turn-stopping`；事件是 **serial 且被 await** 的，监听器里同步调用 `agent.followup()` 或 `agent.steer()` 都会在回合边界提交前生效。
2. `followup()` 把消息放进 `next-turn`：本次 turn 正常写 `turn/end`，随后**直接起下一 turn**；`agent.status` 不会经过 `idle`。`steer()` 把消息放进 `next-step`：**同一个 turn 内多跑一步**，连 `turn/end` 都不写。
3. 子会话的结算观察器只在 `agent.whenIdle()` 返回后推进 `settlementState`/`runMaintenance`/`finishDisposal`。keep-alive 期间 agent 始终没有 idle，因此观察器没有机会在轮次之间 dispose 或发 `subagent/end`。停止注入后，下一次正常结束的 turn 仍会照常 `idle → subagent/end`，`stopReason=completed`，最后一条 assistant 消息是 keep-alive 那一轮的输出。
4. 这正好绕开 `goal-round-driver` 的结算 dispose 竞态：goal driver 依赖 `agent/status=idle` 才 `followup`，而 subagent 的 watcher 也在 idle 后结算；两者是同一时机的竞态。turn-stopping 发生在 idle **之前**，把“下一轮”提前到状态机仍为 running 的时候投递，竞态窗口被消除。

**推荐实现用 `steer` 作为默认**（同 turn、无 `turn/end`，也是平台文档明确推荐的 turn-stopping 用法）；`followup` 也已验证可行，但每轮会写一次 `turn/end` 并让 `turn` 计数 +1，适合“新一轮”语义。两者都必须有预算/终止条件，否则每个正常回合都会再次触发，形成无限续跑。

## 2. 订阅面与参数（file:line）

以下路径相对安装包 `resources/app.asar/dsh/node_modules/`，均为 `@deepseek-ai/dsh-0.2.2-rc.3` 的源码副本。

| 事实 | 位置 |
| --- | --- |
| 事件签名：`this: Scoped<Agent>`，payload `{ agent, turn, signal }`，`@mode serial` | `@deepseek-ai/dsh-agent/src/runtime-types.ts:401-418` |
| 文档语义：turn 即将关闭、在边界提交前 await；监听器 `agent.steer(...)` 后机器重读 inbox，fresh steering 再跑一步，没有则关闭 | `@deepseek-ai/dsh-agent/src/runtime-types.ts:401-411`；`@deepseek-ai/dsh/docs/subsystems/core.md:1092-1114`；`@deepseek-ai/dsh-agent/README.md:80` |
| loop 在 turn 尾部 dispatch 并重新检查 `nextStep` | `@deepseek-ai/dsh-agent-loop/src/agent.ts:401-405` |
| `followup` 目标 `next-turn`、`steer` 目标 `next-step`，两者都 `wakeDriver` | `@deepseek-ai/dsh-agent-loop/src/agent.ts:171-186` |
| `claim('next-turn')` 先清空 `next-step`，再取 `next-turn[0]`；`claim('next-step')` 只取 `next-step` | `@deepseek-ai/dsh-agent-loop/src/inbox.ts:108-112` |
| serial 事件通过 `ctx.serial(carrier, name, payload)` 派发并等待 | `@deepseek-ai/dsh-agent/src/dispatch.ts:138-142` |
| 平台内已有插件用 `ctx.on('agent/turn-stopping', ...)` 订阅（workspace-changes） | `@deepseek-ai/dsh-workspace-changes/src/index.ts:155` |
| turn 循环在 `kick()` 里持续消费：`while (await this.turn()) {}`；只有 inbox 为空才回 idle | `@deepseek-ai/dsh-agent-loop/src/agent.ts:274-287`、`333-438` |

直接订阅形态（探针实际使用，已跑通）：

```js
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  // 仅对目标子会话；signal 是当前 turn 的 abort signal
  // 同步或 await 后注入都可以：serial dispatch 会等监听器返回
  agent.followup(message) // 或 agent.steer(message)
})
```

`agent/turn-stopping` 是 root context 也能收到的全局事件；监听器拿到的 `agent` 就是触发它的子会话 agent。探针里同一个监听器同时收到了顶层 agent 和 spawn 出来的子 agent，说明按 `agent.session.id` / 任务台账过滤是可行且必要的。

## 3. 运行时探针

### 3.1 设计

- 用安装包里的 `dsh` CLI 跑 **一次性 headless profile**：`ELECTRON_RUN_AS_NODE=1` + `DSH_HOME=docs/probes/keepalive-probe/.out/home`，不碰真实 desktop profile。
- 探针插件注册一个最小 `LlmAdapter`（provider `probe`、model `mock`），不依赖真实模型/API key：
  - 顶层 mock 第一次请求返回 `probe_run` 工具调用；
  - `probe_run` 通过 `ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', parent, prompt })` 起一个**真实子会话**，并等待 `activation.result`（即结算结果）；
  - 子会话 mock 每次请求返回一行文本（`child turn N`）。
- 插件同时订阅 `agent/turn-stopping`、`agent/status`、`session/event`、`subagent/end`，全部写 JSONL。
- 子会话**第一次** turn-stopping 按模式注入一次；第二次不注入，让它自然结算。四种模式：

| mode | 注入 | 预期 |
| --- | --- | --- |
| `followup` | `agent.followup()` | 新 turn；中间无 idle |
| `steer` | `agent.steer()` | 同 turn 多一步；中间无 turn/end |
| `followup-async` | `await 50ms` 后 `followup` | 证明 serial 会等待异步监听器 |
| `none` | 不注入 | 对照组：第一次停止后立即结算 |

复跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode followup
```

### 3.2 结果

四组都 `exit=0`，子会话都以 `stopReason=completed` 结算。关键时间线（毫秒时间戳来自日志）：

**followup（`out/k1-events.followup.jsonl`）**

```text
1286270 llm.request      child n=1
1286273 turn-stopping    turn=1 n=1 inbox={next:0, turn:0}
1286274 keepalive.injected (followup) inbox={next:0, turn:1}
1286275 turn/end         turn=1 completed
1286276 turn/start       turn=2
1286316 llm.request      child n=2  tail="K1 keep-alive followup"
1286318 turn-stopping    turn=2 n=2 inbox={next:0, turn:0}
1286319 turn/end         turn=2 completed
1286321 agent.status     idle
1286331 subagent.end     completed, last="child turn 2"
```

- `followup` 落在 `next-turn`（inbox 从 `0/0` 变 `0/1`），当前 turn 正常结束，**同一 driver 立刻起 turn 2**。
- turn 1 结束到 turn 2 开始之间只有 1ms，**没有 `agent/status=idle`**。
- 第二次 turn-stopping 不注入后，才 idle 并 `subagent/end`；`subagent/end` 只出现一次。

**steer（`out/k1-events.steer.jsonl`）**

```text
1292893 llm.request      child n=1
1292895 turn-stopping    turn=1 n=1 inbox={next:0, turn:0}
1292897 keepalive.injected (steer) inbox={next:1, turn:0}
1292925 llm.request      child n=2  tail="K1 keep-alive followup"
1292927 turn-stopping    turn=1 n=2 inbox={next:0, turn:0}
1292928 turn/end         turn=1 completed
1292931 agent.status     idle
1292938 subagent.end     completed, last="child turn 2"
```

- `steer` 落在 `next-step`（inbox 从 `0/0` 变 `1/0`），**同一个 turn 1** 内多跑一步，直到第二次 turn-stopping 才写 `turn/end`。
- 对“防止结算 dispose”来说这是更强的形态：连 `turn/end` 都没有出现在两轮之间。

**followup-async（`out/k1-events.followup-async.jsonl`）**

```text
1295012 turn-stopping    turn=1
1295066 keepalive.injected (after 50ms await)
1295071 turn/end         turn=1
1295074 turn/start       turn=2
```

- turn-stopping 到注入间隔 54ms；`turn/end` 在注入之后才发生。说明监听器可以 `await`（例如查台账/预算），serial dispatch 不会提前关闭回合。

**none（对照组，`out/k1-events.none.jsonl`）**

```text
1306729 turn-stopping    turn=1 n=1
1306730 turn/end         turn=1 completed
1306732 agent.status     idle
1306739 subagent.end     completed, last="child turn 1"
```

### 3.3 对结算的影响

`followup`/`steer` 两组最终都是：

- `subagent/end.stopReason = "completed"`
- `lastAssistantMessage = "child turn 2"`（keep-alive 那一轮的输出）
- `subagent/end` 只在最终结算时出现一次
- `activation.result` 正常 resolve，`stopReason` 没有因为 keep-alive 变成 `aborted`/`error`

也就是说 keep-alive 不改变“最终怎么结算”，只是把结算时点推迟到我们停止注入的那一轮。

## 4. 为什么能绕开 goal-round-driver 的 dispose 竞态

现状（平台源码）：

1. `goal-round-driver` 只在 `agent/status` 变成 `idle` 时 `requestDrive()`，`drive()` 里再 `agent.followup(...)`：
   - `@deepseek-ai/dsh-goal-round-driver/src/index.ts:274-300`（idle → requestDrive）
   - `@deepseek-ai/dsh-goal-round-driver/src/index.ts:146-221`（`readyToDrive` 要求 `agent.status === 'idle'`；`agent.followup(message)` 在 208 行）
2. subagent 的结算 watcher 同样从 `whenIdle()` 出发：
   - `@deepseek-ai/dsh-subagent/src/manager.ts:970-1018`：`await activation.handle.agent.whenIdle()` → `settlementState()` → `flushFinalState()` → `runMaintenance(() => close/finishDisposal)`。
3. `settlementState` 会看 inbox：有 `nextTurn`/`nextStep` 时返回 `'wait'`（`manager.ts:1027-1036`），这能挡住“followup 已经先到”的情况；但它挡不住“watcher 已经通过最后检查、进入 `runMaintenance`/close 之后，goal driver 的 followup 才到”的窗口。此时 activation 已开始 dispose，followup 要么落进一个即将被关闭的 agent，要么被当作 `wakeRequested` 但已经没有人再消费。
4. `finishDisposal` 的顺序是 `cancel → whenIdle → flush → handle.dispose() → 释放槽位 → notify → subagent/end → result.resolve()`（`manager.ts:1039-1115`）。所以一旦 watcher 赢得竞态，这一轮 goal round 就丢了。

keep-alive 的时序（实测）：

```text
turn-stopping (dispatch serial, awaited)
  └─ 注入 followup/steer          ← 此刻 agent 仍是 running
turn 尾部检查 inbox
  ├─ followup: turn/end → turn/start 下一 turn（不 idle）
  └─ steer:    继续同一 turn 的下一步（不 turn/end）
```

因为 `kick()` 的循环是 `while (await this.turn()) {}`（`agent.ts:274-287`），只要 inbox 有下一轮，driver 就不会退出、`agent.status` 就不会变 idle；subagent watcher 的 `whenIdle()` 一直 pending，goal driver 的 idle 触发器也不会跑。**竞态不是被“处理”了，而是被“不产生 idle 观察点”消除了。**

## 5. 条件与边界

### 5.1 可行条件

- **必须是正常完成路径**：`agent/turn-stopping` 只在 `turnEnds` 已设置、且 `nextStep` 为空时 dispatch（`agent.ts:401-405`）。
  - 已实测：普通 `completed` turn。
  - 源码上 `max-tokens` 也会走到这里（`turnEnds` 为 max-tokens 仍会 dispatch），但最终结算原因由 `turn/end` 事件决定；keep-alive 不应被当作“把 max-tokens 变成完成”的手段，也不建议在 max-tokens 上续跑。
  - `aborted` / `error` / `pre-step reject(blocked)` 不会走到 turn-stopping（异常路径直接进 catch/提前 return），所以 keep-alive 不能阻止“显式 stop / 父级 dispose / 模型报错”的结算。
- **必须在监听器返回前注入**：同步调用即可；异步 `await` 也可以，serial 会等（实测 50ms）。但监听器不能抛异常/返回 rejected promise，否则可能把整个 turn 打断；生产实现必须 `try/catch` 并吞掉所有失败。
- **必须过滤目标会话**：事件是 agent-scoped 的全局派发；root 插件能收到所有 agent（包括顶层协调者）。用 `findTaskBySession(db, agent.id)` + `task.status === 'running'` 过滤。
- **inbox 已有待处理输入时跳过**：`nextStep` 非空时事件本身就不会触发；`nextTurn` 非空说明已经有人排了下一轮（人/其他驱动），再注入只会重复。探针在注入前检查了两者。
- **必须有预算/终止条件**：`turn-stopping` 每个正常回合都会触发。若监听器每次都注入，会形成无限续跑；必须限制 `maxKeepAliveRounds`、总时长，并在任务进入终态（done/cancelled/failed/orphaned/waiting_*）或 goal 完成时停止。
- **只读任务/无工具任务要谨慎**：注入的是 user message，模型会继续调用工具；只读任务仍可继续，但成本不可控。

### 5.2 followup vs steer

| | `followup` | `steer` |
| --- | --- | --- |
| inbox 目标 | `next-turn` | `next-step` |
| 轮次 | 新 turn（`turn` +1） | 同 turn 多一步 |
| 边界事件 | `turn/end` → `turn/start` | 无 `turn/end`，直接下一步 |
| 实测 | ✅ 不 idle、最终 completed | ✅ 不 idle、最终 completed |
| 语义 | “下一轮/下一回合” | “同一回合再走一步” |
| 风险 | 会触发 `turn/end` 观察者；每轮一次 turn 边界 | 不触发 turn 边界；但仍在同一 turn 内累积 step |
| 建议 | 需要“新一轮”时用 | **默认推荐**，最贴近 turn-stopping 的文档契约 |

平台文档只承诺 `steer` 能让 turn 保持打开（`runtime-types.ts:401-411`、`core.md:1094`）；`followup` 的继续是 loop 的通用 inbox 语义（`hasPending` → 下一 turn），不是 turn-stopping 专属，但实测同样有效。

### 5.3 与 goal-round-driver 的关系

- keep-alive 会让 agent 长时间不 idle，因此**已 arm 的 goal-round-driver 不会自动续轮**（它的触发条件就是 idle）。
- 当前 orchestrator 的 goal 桥是 `create + disarm`（`src/goal.js:186-195`），本来就不驱动；keep-alive 可以取代“平台 goal 驱动”，不会和它抢。
- 但**不要同时**启用“平台 goal armed + keep-alive”：前者永远等不到 idle，goal 的 `roundsStarted/maxGoalRounds` 也不会推进；预算应改由 ledger 的 keep-alive 计数负责。
- 如果未来要让 goal driver 也参与，考虑让 keep-alive 在达到预算后主动 `disarm`/停止注入，把最后一轮交回 idle + goal driver；当前不建议混用。

### 5.4 其他边界

- **消息来源**：注入的是 `role:'user'` 消息；建议 `source` 用自定义 kind（如 `orchestrator-keepalive`）并带 `taskId/round`，避免 UI/历史把它当成真人发言。探针用 `{kind:'user'}` 只为最小化验证；自定义 source 未在真实 Web UI 上验证。
- **插件卸载/HMR**：`ctx.on` 返回 disposer，卸载时必须释放；预算若只放内存，插件重载会重置，建议落台账。
- **并发注入**：如果还有别的插件也监听 turn-stopping 并注入，`nextStep`/`nextTurn` 会叠加；监听器顺序不应决定结果（平台文档说 data decides），但实际要多方约定。
- **异常语义**：未实测“监听器抛错”的行为；实现里必须假设它会破坏 turn，全部 `try/catch`。
- **进程重启/冷恢复**：keep-alive 不会跨进程；重启后任务仍 running 但 agent 不在，走 S2 对账/orphaned；预算字段可保留，但不要用它阻止人工续派。

## 6. 实现方案改动点（可行路径）

> 下面是给后续实现任务的改动清单；本任务没有改产品代码。

### 6.1 新增 `src/keepalive.js`

职责单一：只负责“在 turn-stopping 时决定是否注入下一条消息”，不碰台账终态、不碰 goal 状态。

```js
// 伪代码
export function createKeepAlive({ db, config, logger }) {
  const onTurnStopping = async ({ agent, turn, signal }) => {
    try {
      if (!config.keepAlive || signal?.aborted || agent.status !== 'running') return
      const task = findTaskBySession(db, agent.session?.id)
      if (task === undefined || task.status !== 'running' || task.read_only === true) return
      if (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) return

      const round = bumpKeepAliveRound(db, task.id, config.keepAliveMaxRounds) // 原子 +1，超过上限返回 null
      if (round === null) return

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: keepAlivePrompt(task, round) }],
        source: { kind: 'orchestrator-keepalive', taskId: task.id, round },
      }
      if (config.keepAliveMode === 'followup') agent.followup(message)
      else agent.steer(message)
      logger.log('task.keepalive.injected', { taskId: task.id, detail: { round, mode: config.keepAliveMode } })
    } catch (error) {
      // 绝不能把异常抛回 serial dispatch：那会打断当前 turn。
      logger.log('task.keepalive.failed', { detail: { error: error?.message ?? String(error) } })
    }
  }

  return {
    start(ctx) {
      const dispose = ctx.on('agent/turn-stopping', onTurnStopping)
      return () => dispose?.()
    },
  }
}
```

要点：

- 先做过期/预算判断，再构造消息；`bumpKeepAliveRound` 用条件 UPDATE（`WHERE status='running'`）保证并发/重复事件只加一次。
- 注入失败只记日志；不要回滚台账。
- 终止条件：任务非 running、`signal.aborted`、已有人排队、达到 `maxKeepAliveRounds`、goal 已 complete。
- 每次注入写一条审计事件（round/mode/inbox 长度），便于看是否变成刷轮。

### 6.2 `src/config.js`

新增（默认关闭，避免升级后行为突变）：

```js
config.keepAlive = raw?.keepAlive === true
config.keepAliveMode = raw?.keepAliveMode === 'followup' ? 'followup' : 'steer'
config.keepAliveMaxRounds = Number.isFinite(raw?.keepAliveMaxRounds)
  ? Math.min(50, Math.max(1, Math.floor(raw.keepAliveMaxRounds)))
  : 8
config.keepAlivePrompt = nonEmpty(raw?.keepAlivePrompt, '')
```

建议再加一个 `keepAliveShadow`（只记“本会注入”不真注入），先在真实任务上观察命中率。

### 6.3 `src/ledger.js`

新增迁移与原子计数：

```sql
ALTER TABLE tasks ADD COLUMN keep_alive_rounds INTEGER NOT NULL DEFAULT 0;
```

```js
export function bumpKeepAliveRound(db, taskId, max) {
  const row = db.prepare(`
    UPDATE tasks SET keep_alive_rounds = keep_alive_rounds + 1, updated_at = ?
    WHERE id = ? AND status = 'running' AND keep_alive_rounds < ?
    RETURNING keep_alive_rounds
  `).get(Date.now(), taskId, max)
  return row?.keep_alive_rounds ?? null
}
```

- 旧库通过现有 `PRAGMA table_info` 风格迁移补列（`src/ledger.js:48-64`）。
- `transition(...)` 进入 running（重派/续派）时重置 `keep_alive_rounds = 0`；终态保留只读值。
- `rowToTask`/`task_status` 增加该字段，面板详情可显示“keep-alive 已续 N 轮”。

### 6.4 `index.js`

```js
import { createKeepAlive } from './src/keepalive.js'
// ...
const keepalive = createKeepAlive({ db, config, logger })
const keepaliveDisposer = keepalive.start(ctx)
// cleanup 列表加入 keepaliveDisposer
```

位置建议在 `settlement` 创建之后、`subagents` 派发路径之外；不要放进 `settlement.report` 回调（结算发生在 idle 之后，已经太晚）。

### 6.5 测试

`test/keepalive.test.js`（纯函数/假 ctx，不启动真实 agent）：

- 非 running 任务不注入；
- `followup` 模式调用 `agent.followup`，`steer` 模式调用 `agent.steer`；
- `nextTurn`/`nextStep` 非空不注入；
- `signal.aborted` 不注入；
- 连续 N 次事件只注入 N 次，第 N+1 次到达上限后不再注入；
- `agent.followup` 抛错时监听器不抛（返回 resolved）；
- 任务读不到/台账异常时静默跳过并记日志。

`test/index.test.js` 可加一条：模拟 `agent/turn-stopping` 事件 → 台账出现 `keep_alive_rounds`，消息 source/kind 正确。

### 6.6 文档/配置

- `docs/ARCHITECTURE.md` 新增「宿主 keep-alive」小节，明确“只在正常 turn 结束、默认关、steer 优先、预算/退出条件”。
- `docs/LIMITATIONS.md` 补：aborted/error/blocked 不能 keep-alive；max-tokens 的最终结算取决于 `turn/end`，不能靠 keep-alive 翻转；不要与 armed goal 混用。
- `README.md` 配置表加 `keepAlive` / `keepAliveMode` / `keepAliveMaxRounds` / `keepAlivePrompt`。
- `CHANGELOG.md` 记一条。

### 6.7 分阶段落地

1. **Shadow**：只记录“如果开启会在哪个 task/turn 注入”，不真注入；观察真实任务里 turn-stopping 的触发频率和 inbox 状态。
2. **小预算**：`keepAliveMaxRounds=2`、`steer`，只对显式 opt-in 的任务开启。
3. **默认关闭**，由面板/工具按任务开启；默认策略不要替用户决定“自动续跑”。

## 7. 复跑与产物

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode followup
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode steer
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode followup-async
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode none
```

产物：

- [docs/probes/keepalive-probe/index.js](../docs/probes/keepalive-probe/index.js) — 探针插件（mock adapter + 子会话 + turn-stopping 注入）
- [docs/probes/keepalive-probe/run.ps1](../docs/probes/keepalive-probe/run.ps1) — 一次性 profile + 运行器
- [docs/probes/keepalive-probe/README.md](../docs/probes/keepalive-probe/README.md) — 用法
- `docs/probes/keepalive-probe/out/k1-events.*.jsonl` — 四组原始事件
- 本报告

## 8. 未覆盖/待确认

1. **监听器抛错的确切语义**：serial 链上抛错是否直接让 turn 失败，未实测；实现必须吞错。
2. **max-tokens/refusal/blocked 路径**：源码显示 max-tokens 可能走到 turn-stopping，但最终结算原因由 `turn/end` 决定；未跑真实 max-tokens，也不建议用它续跑。
3. **真实 orchestrator 集成**：本任务只验证平台扩展点，没有改 `index.js`/台账；改动点见第 6 节。
4. **自定义 message source 在 Web UI/历史压缩中的表现**：未验证；探针用了 `{kind:'user'}`。
5. **多插件同时注入**：未验证；实现需要和 goal driver 二选一。
6. **进程重启后的预算持久化**：设计上落台账，但未实现。
7. **成本**：每轮 keep-alive 都是一次完整模型调用；预算只是上限，不是成本控制，建议同时加总 token/时长上限。

## 9. 一句话给决策者

**keep-alive 可行，且是当前不需要改平台、又能消除 idle 结算竞态的干净做法之一；默认用 `steer`，必须带预算、默认关闭、只对 running 任务注入，并和平台 goal driver 二选一。**
