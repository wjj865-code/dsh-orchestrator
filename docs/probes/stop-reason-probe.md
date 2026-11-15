# 子会话 settle 的 stopReason：取值与时序（S1 结算闭环的探针依据）

- 日期：2026-11-15
- 对象：DeepSeek Harness 0.2.2-rc.3（`dsh --version`），安装包 `C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`，Node v22.23.2
- 目的：S1「消费 settle 的 stopReason/output，自动把台账从 running 更新为 done/cancelled/failed/orphaned」需要先确认：平台到底给哪些值、什么时候给、续派后还给不给。
- 方法：两部分都给，可复跑
  1. **源码级**：`node docs/probes/stop-reason-probe.mjs`（15 项检查全命中，输出见 `docs/probes/out/stop-reason-probe.txt`）。
  2. **真机**：临时 profile 里装 `docs/probes/settle-probe` 探针插件，`dsh settle-probe --json "…"` 跑 7 个场景；原始结果 `docs/probes/out/settle-probe.json`。

> 探针插件只装进 `$DSH_HOME/profiles/settle-probe`（从 headless 模板复制），**不装 desktop profile、不随包发布**。

## 结论 1：stopReason 取值域（源码权威）

```ts
export interface SubagentStopReasonMap {
  completed: 'completed'
  aborted: 'aborted'
  error: 'error'
  'max-tokens': 'max-tokens'
  refusal: 'refusal'
}
```

赋值路径是 `epochStopReason()`（asar @112276150，源码区 @112576741）：把子会话 `turn/end` 的 `reason.kind` 翻成 stopReason。

| 子会话侧事件 | stopReason | 备注 |
| --- | --- | --- |
| `turn/end` `completed`，或整段没有 turn/end | `completed` | 该轮里还有被取消、没跑的输入时降级 `aborted`（`droppedUnrun`） |
| `turn/end` `aborted` / `interrupted` | `aborted` | `dispose()`、父级取消、用户 interrupt 都是这一类 |
| `turn/end` `error` | `error` | |
| `turn/end` `max-tokens` | `max-tokens` | 输出达到长度上限被截断 |
| `turn/end` `blocked` | `refusal` | pre-step 就被拒（hook deny / 策略插件），工作被「拒绝」而不是「做完」 |
| 扩展出来的未知 kind | `error` | 类型是 merge-extensible，未知一律不算成功 |
| `agent/error` 之后没有提交 `turn/end` | `error` | `captureLocalResult` 里 `failureAt` 分支 |

## 结论 2：真机取值与时序（7 场景）

时间来自探针自己的相对时钟（`rel`，插件装载起算，毫秒）。

| # | 场景 | 触发方式 | stopReason | 时序（rel） |
| --- | --- | --- | --- | --- |
| S1 | 正常完成 | 子会话只回 `OK` | **completed** | spawn 2139 → turn/end 3121 → `subagent/end` 3134 → `result` 3136 |
| S2 | 派发后立刻停 | `dispose()` 紧接 `spawn` 返回 | **aborted** | spawn 3213 → end 3245 → result 3246（`dispose()` 正常 resolve） |
| S3 | 跑到一半停 | 1500ms 后 `dispose()` | **aborted** | spawn 3327 → dispose ~4827 → end 4900 → result 4903（`lastAssistantMessage` 有残值） |
| S4 | 发布后 abort caller signal | `controller.abort()` 在 spawn 之后 | **completed** | abort 4972 → 回合继续 → turn/end 5547 → end 5596 → result 5598 |
| S5 | 输出被截断 | `agentOptions.maxTokens = 8` | **max-tokens** | spawn 5681 → turn/end 6410 → end 6453 → result 6456 |
| S6 | 模型不可用 | `agentOptions.model = 'probe-not-a-real-model'` | **error** | spawn 6521 → end 6793 → result 6795（其中没有 turn 事件） |
| S7 | 结算后冷链续派 | settle 之后 `sendMessage` 再起一轮 | 首轮 **completed**；第二轮 `subagent/end` **completed** | 首轮 result 7794；`sendMessage` 7911 → 新 activation start 7908 → turn/end 9068 → `subagent/end` 9077（首轮 `result` 不再 resolve） |

时序规律（源码可对照 asar @112358247 `finishDisposal`）：

1. **先清理再结算**：`finishDisposal` 依次做 `cancel + whenIdle + flushFinalState` → `captureLocalResult` → `handle.dispose()` → 释放槽位 → 父级结算通知 → `emitLifecycle('subagent/end')` → `activation.result.resolve()`。所以 result 永远在 `subagent/end` **之后** 1–3ms 到达（S1 3134 → 3136）。源码级断言 `emitLifecycle` 偏移 < `result.resolve` 偏移。
2. **settle 的粒度是「一次 activation」，不是「一个回合」**：子会话 idle 且 inbox 没有待处理输入才算 ready（`settlementState`，asar @112356981）——这正是「一个回合自然跑完」的时点。`turn/end` 到 `result` 之间还夹着 flush + 清理，实测 13–46ms。
3. **`subagent/end` 会给每一次 activation 发**：S7 里续派起的是**新 activation（新 runId）**，首轮 `result` 不会再 resolve，但 `subagent/end` 又发了一次。⇒ 只消费派发侧的 `result` 会漏掉 `task_message`/冷恢复起的所有后续轮次。
4. **caller signal 在发布后不再取消**（S4 = completed；源码文档也写明 “The caller signal cancels only unpublished work”）。取消只有 `dispose()` / `interrupt` 一条路，落 `aborted`。
5. **error 不一定有 turn 事件**（S6）：起不来也在 settle 里报 `error`，不会 hang。

未覆盖项：`refusal`。真机上要稳定触发需要 pre-step hook deny / 策略拒绝，本轮没有一个不影响用户配置的稳定构造；它只有源码级依据（`case 'blocked': return 'refusal'`），插件按「被策略拒绝 → failed」处理。`max-tokens` 是人工调小 `maxTokens` 触发的，真实长输出落的是同一个值。

## 结论 3：对插件的落点（S1 实现）

| 关注点 | 落点 |
| --- | --- |
| 派发侧事件 | `src/dispatch.js:292`（`subagent.settled`，带 `taskId`/`stopReason`/`output` 摘要）、`src/dispatch.js:303`（`subagent.failed`） |
| 续派/冷恢复事件 | `index.js:332`（`ctx.on('subagent/end')`，只认 `local === true`） |
| 映射规则 | `src/settlement.js:10`（`SETTLE_MAP`）、`src/settlement.js:23`（`mapSettle`，含 progress 停顿与未知值兜底） |
| 状态回写 | `src/settlement.js:54`（`createSettlementReporter`）：只动 `running`，落 `settle` 消息 + 死因 + 通知 + 释放可写根 + 队列补位 |
| 通知分级 | `src/notify.js:3`（cancelled/orphaned 走 notify 合并窗口） |

映射（与 `src/settlement.js` 一致）：

| stopReason | 台账状态 | 死因（写 `tasks.error`） |
| --- | --- | --- |
| `completed`（没上报过 progress） | `done` | — |
| `completed`（只上报过 progress） | `orphaned` | 回合结束但没报终态（可重派） |
| `aborted` | `cancelled` | 子会话被中断 |
| `error` | `failed` | 子会话异常结束 |
| `max-tokens` | `failed` | 输出长度上限截断，可重派 |
| `refusal` | `failed` | 被策略拒绝，可重派 |
| 缺失/未知 | `orphaned` | 结算原因未知，按会话丢失处理 |

## 复跑方法

源码级（只读安装包，秒级）：

```powershell
node docs/probes/stop-reason-probe.mjs            # 或 DSH_ASAR=<路径> node ...
```

真机（会真的调模型，约 10 秒 / 7 次子会话）：

```powershell
# 1) 从 headless 模板复制一个临时 profile（只会写 $DSH_HOME/profiles/settle-probe）
dsh settle-probe --from-default-profile headless --dump-config | Out-Null

# 2) 把探针插件链进 profile
$profile = "$env:USERPROFILE\.dsh\profiles\settle-probe"
New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\settle-probe" `
  -Target "C:\Users\72489\Documents\dsh-orchestrator\docs\probes\settle-probe"

# 3) cordis.patch.yml 末尾追加（该 profile 专属）
#    - insert:
#        - id: settle-probe
#          name: settle-probe

# 4) 跑：headless 的模型路由需要 DEEPSEEK_API_KEY（desktop 用账号凭证，headless 读环境变量）
$env:DEEPSEEK_API_KEY = '<key>'
dsh settle-probe --json "回复 ok 即可，不要调用工具。"
```

结果写在 `docs/probes/out/settle-probe.json`（`events` 是生命周期/session 事件时间线，`scenarios` 是 7 个场景的步骤与结论）。

> 注意：headless 进程跑完场景后不自行退出（根的回合已结束后仍有驻留），验证时手动结束即可；探针结果在场景结束时就已落盘。
