# 换用直连 subagent（任务 = 子会话）实现计划

- 日期：2026-11-13
- 作者：开发（团队研发 Bot）
- 状态：待审查 / 待 Chief 拍口径
- 依据：`docs/probes/subagent-probe.md`（源码级契约）、smoke profile 真机 spike（Chief 执行，结论：可行，换）

## 0. 前提（已实测，不再讨论）

| 事实 | 影响 |
| --- | --- |
| 插件可传自有 `childId` 调 `ctx.subagents.startActivation`，本地后端（`spawn`）保证返回 `messageId` | 任务 `session_id` 就是子会话 id |
| 子会话 `origin:"subagent"`、有 `parentSession`、`delegationDepth 1`；不在普通会话列表，但可从父会话 catalog 发现/打开/继续 | 卡片跳转不能走 session list；走 `subagents.listChildren(parentSessionId)` |
| 子级里全局 `task_report` 可见可调（spike 返回「没有任务 t-spike」） | 回报链路不用改，`exec.agent.id` 就是任务 `session_id` |
| `sendMessage(parent, childId, content, {signal})` 可追加、可冷恢复 | `task_message` 续派直接用；重启后续派也成立 |
| `dispose()` 正常返回并释放；**顺序**起步完成后可再起（实测），平台文档写的是清理后才归还 | 实现**永远显式 `dispose()`**，不依赖「完成即释放」 |
| 并发上限按 root 池、平台默认 8（用户设置 `subagentMaxActive` 可改），满了抛 `ACTIVATION_LIMIT_REACHED`，**平台不排队** | 队列必须插件自己做；上限多少不写死，靠错误自适应 |
| `maxDepth` 默认 1 | 子级不能再派子级，符合设计 |
| 父会话关闭会释放后代；子会话 durable，可冷恢复 | 任务要 orphaned/重建兜底 |

## 1. 目标

- 任务 = 子会话（`startActivation`），不再占 Team 名册；用户不切会话。
- 平台并发上限之外的排队由插件负责：`task_create` 不再因上限失败，而是排队，槽位一空按创建顺序派发。
- 保留现有台账、状态机、brief、通知（steer 注入）、协调者白名单/guard/动态提示。

不做：嵌套子任务、跨设备同步、客户端（阶段 2）。

## 2. 模块改动

| 文件 | 改动 |
| --- | --- |
| `index.js` | `inject` 去掉 `agentTeams`，加 `subagents`；装配 dispatcher 时传 `ctx.subagents`、协调者 agent 取用函数 |
| `src/dispatch.js` | 重写为 subagent dispatcher：`spawn` / `send` / `stop` / `dispose` / `catalog` / `isLimitError` |
| `src/tools.js` | `task_create` 改为「落库 + 入队 + 立即返回」，由 pump 异步 spawn；`task_message`/`task_stop` 走新 dispatcher；`task_report` 不变 |
| `src/ledger.js` | `tasks` 加 `queued_at`；新增 `listPendingQueue`、`markQueued`、`clearQueued`、`listActiveWithSession` |
| `src/state.js` | 保留 `pending → failed`（设计 §6 已定） |
| `src/card.js` | 卡片/文案带 `childId`，说明从协调者会话的子代理目录打开 |
| `src/config.js` | `backend`（默认 `subagent`，保留 `team` 回退）、`maxQueue`（默认 50）；`maxActive` 见 §7 待拍 |
| `README.md` / 设计文档 | 派发层、排队、孤儿、卡片跳转口径同步 |

dispatcher 窄接口（`tools.js` 只依赖这些）：

```js
createDispatcher({ subagents, getAgent, provider = 'spawn' })
// spawn({ label, prompt, signal }) → { childId, messageId, activation }
// send({ childId, message, signal }) → messageId        // sendMessage(parent, childId, blocks, { signal })
// stop({ childId })                                       // 有 activation → dispose()；否则 interruptByParent(childId, parentSessionId, 'continuable')
// dispose({ childId })                                    // 只清理本地 activation 引用
// catalog() → SubagentCatalogEntry[]                      // listChildren(parentSessionId)
// isLimitError(error) → boolean                           // code === 'ACTIVATION_LIMIT_REACHED'
```

- `spawn` 必须给 `activation.result` 挂 `.catch`（`delivery:'caller'`），并把结算事件抛给上层（唤醒队列、写日志），不把结算当任务终态。
- `cwd` 取协调者会话 `header.cwd`（spawn 保留父级 workspace-write 边界）。
- 不传 `agentPreset`，子级加入父方当前 composition；不传 `maxDepth`（按部署默认 1）。

## 3. 状态机与台账

- `pending` 有两种语义，用 `queued_at` 区分：
  - `queued_at` 非空：**排队中**（等并发槽位）；
  - `queued_at` 为空：新建未派发 / 重启待恢复。
- 新增迁移沿用设计 §6：`pending → running`（spawn 成功）、`pending → failed`（spawn 非容量错误）。
- `task_create` 返回文案区分：「任务 X 已派发」「任务 X 已创建，前面还有 N 个任务在排队」。
- 启动对账（插件 load）：
  1. `pending + session_id 为空 + queued_at 非空` → 重新入队；
  2. `pending + session_id 为空 + queued_at 为空 + created_at 超 staleMinutes` → `failed`（派发中断，沿用 §19）；
  3. `running/waiting_*` 且有 `session_id` 但 **不在** `listChildren(coordinatorSessionId)` → `orphaned`（子会话不可达），`error` 写原因。
- 启动对账一律直接 SQL（不走状态机），记清理条数 + 结构化日志。

## 4. 容量队列

- 内存 FIFO（按 `created_at`），元素是 pending 任务 id；pump 用单 Promise 链串行（防并发 spawn 超发）。
- pump 伪码：

```
pump():
  串行锁内:
    while queue 非空:
      id = peek
      try spawn → transition running, session_id=childId, clearQueued, log task.spawn.ok, dequeue, continue
      catch e:
        if isLimitError(e):
          markQueued(id), log task.spawn.blocked, 退避重试(2s/5s/10s/30s 上限), break
        else:
          transition failed(error), log task.spawn.failed, dequeue, continue
```

- 唤醒时机：`task_create` 入队后、activation 结算（`.then` 回调）、`task_report` 到终态、`task_stop`、插件启动、退避定时器。
- 定时器 `unref()`，卸载时清掉；pump 内所有状态读写仍在主线程同步段完成。
- 并发去重/额度检查/`createTask` 仍收在 `await bind()` 之后的同一同步段（沿用 `60d8ef9`），pump 只负责已落库任务的派发，避免两个窗口。

## 5. 孤儿与父会话退场

- 父会话关闭 → 后代被释放，但其会话是 durable 的：协调者重新加载后 `sendMessage` 可冷恢复，**不立即标 orphaned**。
- 只有以下情况标 `orphaned`：
  - 启动对账时 `listChildren` 里查不到该 `session_id`；
  - 运行期 `send`/`stop` 抛「不存在/无权限/不支持」类错误（不是容量错误）。
- `orphaned` 是终态，不参与去重；用户再派同 title+goal 的任务允许（新建一条，文案提示可用「重建」）。
- `task_stop` 后必须 `dispose()`/`interrupt`，释放并发额度；不依赖平台在完成时释放。

## 6. 卡片与跳转

- 阶段 1（无客户端）：`task_status`、任务卡片带 `childId`，文案「在协调者会话的子代理目录里打开」；不假设它是普通会话。
- 阶段 2：客户端用 `subagents.listChildren(parentSessionId)` 拿目录，走 subagent catalog 打开；面板数据仍从台账读，不靠 session list。
- 卡片字段新增 `childSessionId`，`parentSessionId` 由协调者会话提供。

## 7. 待拍口径（请 Chief / 审查定）

1. **`maxActive` 怎么办**：它原本是 Team 名册时代的「活跃任务硬上限」。换 subagent 后如果保留，等于把 8 个上限又搬回来，与目标冲突。建议：**废弃并发拒绝**，改成 `maxQueue`（默认 50）安全阀——队列满才拒绝创建，且拒绝时不落库。若保留 `maxActive`，需要明确它现在约束什么。
2. **重启后排队任务是否自动派发**：建议自动重新入队（用户视角「没派出去的活会继续」）。若不希望自动跑，需加 `autoResumeQueue` 开关。
3. **旧 Team 任务兼容**：旧任务的 `session_id` 是 Team member id。Team member 也是协调者的直接子级，`sendMessage` 大概率仍能投递；先真机验一条，能投就保持可续派，不能投就把旧任务当只读并提示重建。确认后再决定是否删掉 `backend:'team'` 回退。

## 8. 测试计划

单测（假 `subagents` 服务）：
- spawn 成功 → `running` + `session_id` 正确；spawn 抛 `ACTIVATION_LIMIT_REACHED` → 任务留 `pending` + 排队，队列非空后不再重复 spawn；
- 释放一个槽位（settle/dispose）→ pump 派发队首，顺序按 `created_at`；
- spawn 抛非容量错误 → `failed` + 可读原因，队列继续；
- 12 个并发 `task_create` 只 spawn 上限内数量，其余排队；
- 启动对账：排队 pending 重新入队、超时无 session 的 pending → failed、catalog 查不到的 active → orphaned；`running`/`waiting_*` 不被误伤；
- `task_message` 投递失败分类（容量无关的失败 → orphaned/失败文案）；`task_stop` 两条路径（有 activation → dispose；无 → interruptByParent）；
- `task_report` 的 `session_id` 校验在 childId 上成立；
- 日志事件补齐（`task.spawn.blocked`、`task.queue.drained`、`task.orphaned`）。

真机（smoke profile）：
- 单任务闭环：create → 子会话执行 → `task_report` → 通知到协调者 → 卡片；
- 9 个任务：8 个跑、1 个排队，结束一个后自动派发第 9 个；
- 关闭协调者会话再开：任务保留、续派可冷恢复；catalog 里能打开子会话。

## 9. 分步提交

1. 先把 stash 里的 WIP 落地（去重、spawn 失败收尾、启动清理、结构化日志、禁编状态提示），测试跑 §19/§20/§21。
2. dispatcher 换 subagent 后端（保留 `backend:'team'` 回退）+ `tools.js` 适配 + 单测。
3. 容量队列 + 启动对账 + 单测。
4. 孤儿兜底 + `task_stop` 回收 + 单测。
5. 文档（设计 §4/§5/§6/§12/§14/§15、README、卡片文案）同步 + 全量回归。
6. 交测试真机复验；通过后删 smoke profile。
