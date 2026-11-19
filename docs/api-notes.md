# 平台接口探测记录（api-notes）

- 日期：2026-11-13（P2-4 复核 rc.5 的 `dsh-agent-team` 任务板契约）
- 对象：已安装的 DeepSeek Harness `0.2.2-rc.1` → `rc.5`（读 asar 内实现文本）
- 复跑：`node docs/probes/api-probe.mjs`（`DSH_ASAR` 可指向别的安装包）；最近一次 16/16 PASS
- 边界：这是对**已安装实现**的源码级探测，不是起真实 Team 跑模型回合；结论过期时先重跑探针，别直接改断言。

## 1. 服务注入名与 agent 对象

- `agentTeams` 是服务名（`TeamService` 构造器 `super(ctx, "agentTeams")`）；平台工具插件声明 `inject = ["agents", "agentTeams", "tools", "systemPrompt"]`。
- 本插件因此声明 `inject = ['tools', 'agentTeams', 'agents']`；缺 agent-team 包时加载失败是预期失败方式（不是静默跳过）。
- **拿 agent 的两条路**：装配时按会话 id 查 `ctx.get('agents').get(sessionId)`（只返回当前 live 的 agent）；工具执行时用 `exec.agent`（调用方）。所以 `index.js` 采用「惰性解析 + `agent/created` 补装」，不在 `apply()` 缓存 `undefined`。

## 2. teammate 的 id / session_id 与必填 signal

- `member.id` 就是子会话 id（台账 `session_id`），`member.name` 是模型侧 `target`；`spawnTeammate` 的 `provider` 与 `signal` 必填（内部 `AbortSignal.any([request.signal, ...])` 遇 `undefined` 直接抛 `TypeError`）。本插件默认 `spawnProvider='spawn'` 并从 `exec.signal` 透传。
- `sendMessage` 的 `signal` 同样必填（续派消息透传 `exec.signal`）。

## 3. 为什么不用 `sendMessage` 发通知

- 向 Lead 发消息**能**唤醒协调者（`root.steer(...)` → `send(input,'next-step',true)` → `wakeDriver`），忙时进 `next-step` 队列不丢。
- 但 `sendAdmitted` 禁止给自己发（`TEAM_SELF_MESSAGE`），且会校验发送方仍是 active 成员：fresh teammate 的回合一 settle 就被 dispose，5 秒合并窗口后它已不在 roster，发送报 `TEAM_NOT_MEMBER`。
- 所以通知改为直接驱动协调者会话：`agents.get(coordinatorSession)` → `agent.steer({id, role:'user', content:[{type:'text',text}], source:{kind:'agent-message', form:'relay', senderSessionId}})`；会话未加载时记 `skipped`，不误记 `delivered`。
- 平台另有一条独立链路：`dsh-subagent` 在子会话 settle 时给父会话发 `subagent-settled`。它不经过本插件、没有 `notifications` 行，**不能当成插件投递成功**。

## 4. 协调者工具面收窄（R4）与已知缺口

- `ctx.tools.restrict(filter)`（`{allow?, deny?}`）只能声明在 **agent 作用域**（`agent.ctx.tools.restrict`），名字必须是 `view(agent).restrictableNames` 里的全局工具名；返回 disposer。
- **已知缺口**：`spawn_teammate` / `send_message` / `list_agents` / `wait_agent` 是 agent scope 自注册工具，不在 `restrictableNames` 里，`restrict({deny})` 去不掉（真机冒烟里协调者工具 34→21，这些仍在）。阶段 2 用 agent preset 的 `composition.toolFilter` 固化，运行期 restrict/guard 降为兜底。
- **收窄必须延到回合边界**：`restrict()` 是即时层，回合中调用会让当前请求的工具表与执行视图错位（下一调用 `unknown tool "pwsh"`）。本插件在绑定时若 `agent.status === 'running'` 只挂 `pendingRestrictions`，监听 `agent/status` 到 `idle` 再装（`setPhase(idle)` 在 `wakeDriver()` 起下一轮之前发）。

## 5. `wait_agent` 等待禁令（P0）

`wait_agent` 会阻塞当前模型回合，白名单去不掉它，所以运行期两层保护：

- **系统提示（按会话动态）**：注册 `ctx.systemPrompt.context({name:'orchestrator:coordinator-policy', order:130, interpolate:false, text})`，只有 `context.agent.id` 等于协调者才返回禁令，并显式声明优先于平台 `team:policy` 的等待要求。绑定发生在 step N，step N+1 的 prompt 才带禁令。
- **执行期 guard**：`ctx.tools.guard(exec => string | undefined)` 同步、单调拒绝；只拒 `exec.name === 'wait_agent' && exec.agent.id === 协调者`。它不依赖工具表，所以同回合里**顺序执行**的 `wait_agent` 也会被拒；同一条 assistant 消息里在绑定写入前就开始执行的仍可能漏过（不承诺「首绑回合绝对安全」）。

## 6. 通知投递与审计口径

- 插件通知：分级 → 5 秒合并（done）/ 立即（blocked、needs_auth）→ `agent.steer` 注入 → 每次尝试写一行 `notifications`（`delivered` + `delivered_at` / `failed` + `reason` / `skipped`）。
- 验收看 `notifications` 行与插件注入次数是否 1:1，而不是看协调者是否收到任意消息（平台 `subagent-settled` 也会唤醒它）。
- **收尾期 `agent initiator scope is disposed`**：`ReactLoopAgent.wakeDriver()` 走 `agents.withInitiator`，服务 effect 卸载后 `runWithInitiator` 直接抛这句。真机现象是「seq 有注入记录，但通知行 `failed`、协调者没起回合」——这是 headless 一次性进程在 5 秒合并窗口内退出的收尾竞态，不是 sender 离队。状态保持 `failed` + reason 是正确审计；单测可用 `DSH_ORCH_NOTIFY_MERGE_MS` 旁路窗口。

## 7. 工具 schema 与子会话沙箱根（rc.3 实测）

- `tool.parameters` 原样进模型 JSON Schema，`required` 只能是字符串数组：写布尔 `required:true` 会被 provider 以 400 拒绝（真机报 `true is not of type "array"`，子会话首回合必挂）。必填一律在运行时校验。
- rc.3 子会话沙箱根取**父会话目录**（`sandboxPolicy.sessionWorkspaceRoot = session.header.cwd`，`spec.cwd` 只经 `workingDirectory.set` 追加事件），所以 `workspace-write` 下子会话写 target 会被拒。兜法：`sandboxPolicy.registerWritableRoot(session, targetDir)`，session 必须是 `agents.get(childId).session` 同一对象；`dispatch.spawn` 后注册，续派在发送成功后按新 Session 幂等补注册，终态全部释放。Windows 上只对 harness 文件工具生效，`pwsh`/`bash` 进程写仍被拒。
- rc.3 起 `agentTeams` 成员 API（`spawnTeammate`/`sendMessage`/`interrupt`/`listMembers`）已移除，只剩 `state`/`transact` 与**团队任务板**（P2-4 消费的就是后者）。`startActivation`/`interrupt`/`catalog` 的入参形状在 rc.1 → rc.3 变过，升级后先重跑探针。
- `sessionController.create` 入参没有 `title`，标题必须单独 `rename`（依赖 `sessionTitle`，失败只记日志）。

## 8. 交接契约 v1 的 JSONL 事件（D2）

契约字段与语义的唯一真源是 [ARCHITECTURE「交接契约 v1」](ARCHITECTURE.md#交接契约-v1d2acceptedby-acceptedat-jsonl)，这里只记**外部消费方式**：

- 文件：`$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`（`$DSH_HOME` 默认 `~/.dsh`），与仓库无关、不随包发布。
- 格式：一行一个 JSON；`event` 只有 `task.handoff.delivered`（进入待确认）与 `task.handoff.confirmed`（确认/超时收成 done）；`detail.contract` 是契约版本（v1 = 1），`detail.handoff` 是完整契约对象。
- 追加写、按天分文件、单文件超 5 MiB 换新、保留 30 天（与运行日志共用 `src/log.js` 的轮转实现）。
- 去重：文件只追加不改写，重复投递由读方按 `(event, taskId, deliveredAt)` 去重；`confirmed` 每次确认只写一条。
- 消费示例（等 `confirmed` 后通知下游）：

```bash
tail -F "$DSH_HOME/state/orchestrator/handoff"/handoff-*.jsonl \
  | jq -c 'select(.event=="task.handoff.confirmed") | {taskId, by: .detail.handoff.acceptedBy, at: .detail.handoff.acceptedAt}'
```

- 边界：v1 只提供文件级事件，**没有**进程内订阅 API / webhook（留 v2）；事件写入失败只 warn，不影响交付与确认。
