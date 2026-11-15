# K2 实现：keep-alive goal 多轮续跑

- 日期：2026-11-15
- 起点：`a0ce9d5 release: v0.10.0`（HEAD）
- 依据：[K1 探针报告](k1-keepalive-probe.md) 第 6 节改动清单；本任务只做产品实现与测试，不跑真机冒烟。
- 结论：**已实现并全绿**（`npm test` 584/584，其中 K2 新增 14 条）；config 开关**默认关闭**；keep-alive 不写台账终态、不写结算，S1 仍只在真正的子会话结束事件上结算一次。

## 1. 改了哪些文件

| 文件 | 改动 | 关键行 |
| --- | --- | --- |
| `src/keepalive.js`（新增） | keep-alive 模块：纯判定、注入、订阅、审计 | `keepAliveSkipReason` :49、`createKeepAlive` :93、`handle` :129、预算 :169、消息 `source` :191、审计消息 :218、`start` 订阅 :230 |
| `index.js` | 接线：settlement 之后 `createKeepAlive` + `start(ctx)`，disposer 进卸载列表 | :17 import、:348 创建、:355 `keepAlive.start(ctx)`、:531 清理 |
| `src/ledger.js` | 新列 + 旧库迁移 + 原子加轮 + 进入 running 归零 | schema :17、迁移 :66、`taskOf` :140、`transition` 归零 :238、`bumpKeepAliveRound` :305-312 |
| `src/config.js` | 四个新配置（默认关） | `keepAlive` :63、`keepAliveMode` :65、`keepAliveMaxRounds` :66-68（1–50）、`keepAlivePrompt` :69 |
| `src/tools.js` | `task_status` 显示已续轮数 | :584-587 |
| `test/keepalive.test.js`（新增） | 12 条用例：模块/判定/台账/S1 去重 | 见 §5 |
| `test/index.test.js` | 2 条接线用例（默认关不注入 / 开启后注入且 S1 只结算一次） | 「K2 keepAlive 默认关闭…」「K2 keepAlive 开启…」 |
| `README.md` | 用法小节「回合间续跑（keep-alive，默认关）」+ 配置表 4 行 + 已知限制 1 行 | — |
| `docs/ARCHITECTURE.md` | 新章节「回合间 keep-alive（K2）」（含 file:line 与 S1 边界） | — |
| `docs/LIMITATIONS.md` | 新章节「回合间 keep-alive（K2）」7 条边界 | — |
| `CHANGELOG.md` | 「未发布」段：新增 K2 条目 | — |

## 2. 续跑条件（三条同时满足）

`keepAliveSkipReason()`（`src/keepalive.js:49`，纯函数，返回 `null` = 注入，字符串 = 跳过原因）按固定顺序判定：

1. **开关开启**：`config.keepAlive === true`（否则在查台账之前就返回，默认路径连 `db` 都不用）；
2. **goal 未完成**：平台 goal 存在（`goal_state` / live `goalBridge.stateOf()`）且 `phase` 不是 `complete`·`cleared`；没有 goal 时判定为 `no-goal` 不续跑——否则没人判定完成，只能跑到轮数上限；
3. **轮数未满**：台账 `tasks.keep_alive_rounds < keepAliveMaxRounds`（默认 8，1–50）。

前三条之外还有「不许打扰」的守卫：`signal.aborted`、`agent.status !== 'running'`、任务不存在或不在 `running`、`read_only` 任务、inbox 已有 `nextStep`/`nextTurn`。

## 3. 停止逻辑（轮满 / goal 完成 / stop / 异常）

| 停止条件 | 触发点 | 行为 |
| --- | --- | --- |
| 轮满 | `bumpKeepAliveRound` 条件 UPDATE 返回 `null`（`src/ledger.js:305`） | 本轮不注入；`task.keepalive.stopped{reason:'rounds-exhausted'}`（同任务同原因只记一次）；下一次正常回合结束后 idle → S1 结算 |
| goal 完成/清除 | `goalState.phase ∈ {complete, cleared}` | 不注入，记 `goal-finished`；`done → complete`、`stop/retry/orphaned → clear` 由 S1 的 `onTerminal` 收口 |
| 显式 stop / 已结算 | 任务离开 `running`（`task_stop`→cancelled、S1→done/orphaned、S2→orphaned、blocked→waiting_*） | 条件更新与判定都要求 `status='running'`，注入不可能发生；同一会话后续的 `turn-stopping` 直接跳过 |
| 回合被中断 | `signal.aborted === true`、`agent.status !== 'running'` | 不注入（keep-alive 无法阻止 stop/父级 dispose/模型报错，`aborted`/`error` 根本不走 turn-stopping） |
| 注入异常 | `agent.steer/followup` 抛错 | 记 `task.keepalive.failed{hook:'inject'}`，本轮作废（预算已消耗，不回滚），下一回合自然 idle 交给 S1；**监听器绝不抛错**（`handle` 全量 try/catch + `start` 再兜一层） |
| 台账异常 | 查任务/加轮失败 | 记 `task.keepalive.failed`，静默跳过 |

## 4. 默认关闭 + S1 不误判（守卫与证明）

默认关闭：

- `src/config.js:63` 只认 `raw.keepAlive === true`；`loadConfig({}).keepAlive === false`（用例 1 断言）。
- 关闭时 `handle`（`src/keepalive.js:130`）第一句就 return，**先于** `findTaskBySession`：用例把 `db` 传成 `undefined` 跑 `handle` 也不抛、不注入。
- `index.js:355` 无论开关都会订阅，但订阅到的是「立刻返回」的监听器；`test/index.test.js` 「K2 keepAlive 默认关闭」用例证明：`turn-stopping` 到达后 `keep_alive_rounds` 仍为 0、无 `kind='keepalive'` 消息、没有 `steer`。

S1 不误判的守卫：

1. **不写终态**：keep-alive 只 `addMessage(kind='keepalive')` 与 `keep_alive_rounds+1`，不调用 `transition`、不改 `progress_count`、不写 `last_message`。
2. **不写 `kind='followup'` 消息**：面板 `task_message` 的「同文去重」(`findRecentDeliveredFollowup`) 与 `requestDedupe` 只看 followup 行，keep-alive 用独立 kind + 独立 `source.kind='orchestrator-keepalive'`，不会让面板把宿主续跑当成人工续派去重掉。
3. **不触发结算**：只有真实的 `subagent.settled` / `subagent/end` 会让 S1 `report()`；keep-alive 期间 agent 不 idle，子会话 watcher 的 `whenIdle()` 一直 pending（K1 实测），轮次之间不会 `subagent/end`。
4. **结算后不复活**：任务一旦离开 `running`，后续 `turn-stopping` 一律跳过（`task-not-running`），不会把已 done/orphaned 的任务重新拉起。
5. **幂等证明**：用例里同一任务两次 `subagent/end`（派发侧 + 生命周期）→ 第二次 `action='skipped', reason='not-running'`，`kind='settle'` 消息恒为 1 条。

## 5. 怎么验证

```powershell
cd C:\Users\72489\Documents\dsh-orchestrator
npm test            # 584 tests / 584 pass / 0 fail
npm run check:client
```

K2 新增用例（14 条）：

- `test/keepalive.test.js`（12 条）
  1. 默认关闭：配置默认值、关闭时 `db` 缺失也不碰台账；
  2. steer 默认注入：`role/content/source` 形态、`keep_alive_rounds`、审计消息 kind；
  3. `followup` 模式走 `agent.followup`；
  4. 轮满 maxRounds=2：只注入 2 次，第 3/4 次停止、`stopped` 日志只一条；
  5. goal 完成（complete/cleared）/ 无 goal / 任务非 running（done·orphaned·cancelled·waiting_user）/ 只读 / `signal.aborted` / agent 非 running / inbox 有排队（4 种形态）都不注入；
  6. 注入抛错：监听器不抛、预算已消耗、连续失败只记日志；
  7. 台账查不到/读失败：静默跳过不抛；
  8. `start()` 订阅 `agent/turn-stopping`、返回 disposer、没有 `ctx.on` 时 no-op；
  9. 纯函数覆盖 `keepAliveSkipReason` 全原因、`hasPendingInput`、`keepAliveText`；
  10. `bumpKeepAliveRound` 原子加轮/超上限 null/非 running 不消耗/进入 running 归零；
  11. 旧库自动补 `keep_alive_rounds` 列、历史行 0 轮；
  12. 与 S1：注入不改状态与 `progress_count`，结算只一次、消息只一条，结算后 `turn-stopping` 不再注入。
- `test/index.test.js`（2 条）
  - 默认关闭：`turn-stopping` 到达零注入、台账零变化；
  - 开启（`keepAliveMaxRounds:3`）：三次注入（第 4 次停）、消息 source 带 taskId、`subagent/end` 后 S1 只结算一次、之后 `turn-stopping` 不再注入。

## 6. 未覆盖 / 待真机确认

1. **真实 agent 的 `agent.status`/`agent.inbox` 形态**：实现按 K1 探针实测的形状过滤（`status==='running'`、`inbox.nextStep/nextTurn`）；单元测试用假件覆盖，真机冒烟未做（本任务范围外）。
2. **自定义 `source.kind='orchestrator-keepalive'` 在 Web UI/历史压缩里的表现**：K1 未验证；与插件通知的 `orchestrator-notification` 同构，但没跑真机。
3. **监听器抛错的确切语义**：仍未实测（K1 §8.1），实现按「可能打断回合」假设做全量吞错。
4. **成本**：每轮一次完整模型调用；`keepAliveMaxRounds` 是上限不是预算控制，也没有总时长/token 上限。
5. **不建议与 armed goal 混用**：keep-alive 期间 agent 不 idle，平台 `goal-round-driver` 不会推进 `roundsStarted`；插件自己的 goal 桥永远是 `create + disarm`。

## 7. 复跑

```powershell
node --test --experimental-test-isolation=none --disable-warning=ExperimentalWarning "test/keepalive.test.js"
node --test --experimental-test-isolation=none --disable-warning=ExperimentalWarning "test/index.test.js"
```
