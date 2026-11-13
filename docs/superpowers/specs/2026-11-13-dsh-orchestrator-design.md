# dsh-orchestrator 设计文档（协调者 + 子任务工作台）

- 日期：2026-11-13
- 状态：待用户审阅
- 作者：Chief（主 Bot）与用户共同确定

## 1. 背景与目标

用户需要一个类 Trae 的工作台：一个**协调者会话**负责拆任务、派活、盯进度，多个**子任务会话**并行干活。子任务就是普通 DSH 会话，能力不受限；协调者本身不写代码、不跑命令，只做协调。

目标：

1. 全局入口（左上角）一键进入固定的协调者会话。
2. 协调者能把用户需求变成结构化任务，派给子会话；能判断新需求该复用已有任务还是新建。
3. 子任务每轮回报状态，协调者据此决定**是否打扰用户**：只有完成要汇报、或需要用户拍板时才出现。
4. 聊天内用卡片显示任务名、状态、跳转；右上角面板看全部历史任务。

## 2. 范围

**做：**

- 服务端插件：任务台账、状态机、子会话创建与消息投递、协议校验与渲染、通知路由、协调者工具集收窄。
- 客户端薄插件：左上角入口、右上角历史任务面板。
- 会话内任务卡片（`show_view`）。
- 复用判定、进度/卡点判定、通知合并。

**不做：**

- 嵌套子任务（子任务不能再创建子任务）。
- 跨设备同步、任务间自动依赖编排。
- 自绘聊天流内的装饰性图标（用工具卡片替代）。
- 替代 DS Bot 的 Bot/群聊机制（两套并存，互不依赖）。

## 3. 角色与术语

| 术语 | 含义 |
| --- | --- |
| 协调者会话 | 固定一个会话，绑定协调者 agent，入口由客户端按钮打开 |
| 子任务 | 台账一条记录 + 一个子会话（插件直连 `ctx.subagents.startActivation` 创建的子会话，不占 Team 名册） |
| brief | 结构化任务对象，内部数据，不直接展示给子会话 |
| 渲染文本 | brief 渲染成的一段结构化文字，才是子会话收到的输入 |
| 通知 | 子任务状态变化后投递给协调者会话的消息，分三级 |

## 4. 架构

三层，边界清晰：

1. **服务端插件 `dsh-orchestrator`**（cordis，ESM，无构建）
   - `ledger`：任务与消息持久化（SQLite，`$DSH_HOME/state/orchestrator/tasks.sqlite`）
   - `lifecycle`：状态机与合法迁移
   - `dispatch`：创建子会话、投递消息、停止子会话（直连 `ctx.subagents`，默认 `backend:'subagent'`；保留 `backend:'team'` 回退）
   - `queue`：容量队列（平台不排队；满了留 `pending`，槽位释放后按创建顺序补位）
   - `brief`：结构化协议校验 + 渲染为文字
   - `notify`：分级、合并、投递协调者会话
   - `judge`：复用判定与卡点判定的辅助数据（不替代 LLM 判断）
   - `tools`：注册协调者工具与子任务回报工具
2. **客户端薄插件**：入口按钮、历史面板；只读台账 API、负责跳转。
3. **平台复用**：`ctx.subagents`（创建/追加/中断子会话、`listChildren` 目录）、`ask_user`、`show_view`、会话加载、memory。

## 5. 数据模型

`tasks`：

| 字段 | 说明 |
| --- | --- |
| id | `t-<uuid 短>` |
| title | 一句话任务名，卡片上显示 |
| goal | 目标（渲染文本的主体） |
| brief_json | 完整结构化对象（含约束、验收、refs、用户原话） |
| status | 见第 6 节 |
| session_id | 子会话 id（= 派发时由插件生成的 `childId`） |
| queued_at | 非空表示任务在排队等并发槽位；为空表示新建未派发 / 派发中断 |
| coordinator_session_id | 所属协调者会话 |
| attempts | 被续派的次数 |
| created_at / updated_at / last_event_at | 毫秒时间戳 |
| error | 失败或卡点原因 |

`messages`：`task_id`、`seq`、`kind`（brief / followup / stop / report）、`rendered_text`、`meta_json`、`at`。保留全部往来，便于复盘与卡点判断。

`notifications`：`task_id`、`level`（silent / notify / interrupt）、`status`、`delivered_at`、`merged_into`。

每天一份台账快照，存在 `$DSH_HOME/state/orchestrator/snapshots/`，保留最近 7 天，用于损坏恢复。

协调者侧日志：`$DSH_HOME/state/orchestrator/logs/YYYY-MM-DD.jsonl`，按天一个文件、保留 7 天、单文件超 5MB 换新。覆盖 create（含拒绝原因、`maxQueue`、队列情况）、spawn 成败、report、notify、启动清理/对账、绑定变更，带 `callId` 串联同一次调用；`goal`/`summary` 只截 80 字摘要，不写 `user_verbatim`；写日志失败只 warn、不阻塞主流程。验收要求：只凭当天日志能还原「这次创建为什么被拒 / 派发为什么失败 / 通知为什么没到」。

## 6. 生命周期与状态机

状态：`pending → running → (waiting_user | waiting_auth) → running → done | failed | cancelled`，异常态 `orphaned`。

迁移规则：

- `pending → failed`：派发失败（spawn 抛非容量错误）直接标失败，`error` 写原因，不留无子会话的 pending；插件启动时把「`session_id` 为空、`queued_at` 为空且超过 `staleMinutes`」的遗留 pending 清理为 failed（记清理条数）。
- `pending` 排队：并发满了（`ACTIVATION_LIMIT_REACHED`）任务保持 `pending` 并标 `queued_at`，不报错、不标 failed；平台结算释放槽位后按 `created_at` 补位。重启时 `pending + session_id 为空` 的任务（含 `queued_at` 为空但未超时的）重新入队，`autoResumeQueue` 默认开。
- `task_create` 去重：`title + goal`（trim 后）相同且仍有活跃任务（`pending/running/waiting_user/waiting_auth`）时返回已有任务，不新建、不 spawn、不占额度；`done/cancelled/failed/orphaned` 不参与去重，用户重跑同一任务放行。
- 队列安全阀 `maxQueue`（默认 50）满时拒绝创建且不落库。

- 只有子会话的 `task_report` 能把状态推进到 `running` 之后。
- 协调者只能：创建（pending）、续派消息、停止（cancelled）、对 failed 重新派发（`attempts + 1`，不新建记录）。
- `waiting_user` / `waiting_auth` 由子任务的授权/卡点触发，由协调者转交用户后回到 `running`；这两个等待态也可以直接转 `orphaned`（子会话已不可达）。
- 超过 30 分钟无事件且未结束 → 视为卡点候选，进入第 8 节判定。
- 子会话被删除或不可达 → `orphaned`：启动/协调者加载时对账。两条判据：① `running` 且 `agents.get(session_id)` 不存在（进程重启后本来就没有在跑的回合）→ `orphaned`；② `listChildren(协调者会话)` 里查不到 `session_id` → `orphaned`（已丢失）。`waiting_user`/`waiting_auth` 即使子级不 live 也保持原状态（故意停下，靠 `task_message` 冷恢复），只有 catalog 查不到才标 `orphaned`。catalog 服务本身不可用只 warn、不误判。`orphaned` 是终态，可再派同 title+goal 的新任务重建。

## 7. 结构化协议与渲染

内部 brief（JSON）：

```json
{
  "title": "修复空数据文案",
  "goal": "空窗口时报表给出明确说明而不是空表",
  "constraints": ["只改 src/report.js", "不引新依赖"],
  "acceptance": ["空窗口输出「该窗口没有调用记录」", "npm test 全绿"],
  "refs": ["src/report.js:66"],
  "user_verbatim": "用户原话……"
}
```

校验：`title`、`goal` 必填；`acceptance` 至少一条；`constraints`、`refs` 可空。

渲染（纯函数，可单测）产出形如：

```
【任务】修复空数据文案
【目标】……
【约束】- 只改 src/report.js；- 不引新依赖
【验收标准】- ……
【背景资料】- src/report.js:66
【用户原话】
> ……
完成后请汇报：改了什么、改了哪些文件、怎么验证的。
```

**JSON 永不出现在子会话的输入里。** 子会话只能看到渲染文本。

## 8. 子任务回报与打扰控制

子任务每轮结束调用 `task_report({ status, summary, needs? })`：

| status | 含义 | 通知级别 | 协调者动作 |
| --- | --- | --- | --- |
| progress | 有进展、未完成 | silent | 只写台账，**不打扰用户** |
| done | 完成 | notify | 汇报用户（同一批 5 秒内完成的任务合并成一条） |
| blocked | 卡住、需要人做决定 | interrupt | 用卡片问用户 |
| needs_auth | 需要授权 | interrupt | 转交用户拿授权后回传 |

没按协议回报（一轮结束无任何声明）按 `progress` 处理；**连续 3 轮无进展或 30 分钟无事件**才升级为卡点，来问用户。阈值可配。

协调者自己也要定期自查：把「running 但长时间没动静」的任务列出来（`task_list` 带 stale 标记）。

## 9. 复用判定

协调者收到新需求时，先 `task_list({ active: true })` 拿到存活任务（含标题、目标摘要、最近一条消息），自行判断：

- 命中唯一且契合 → `task_message` 续派，不新建；台账 `attempts + 1`。
- 命中多个或不确定 → 用 `ask_user` 问"这是 X 的延续，还是新任务？"
- 已完成/已取消的任务不自动复用，除非用户明确要求。

协调者只做判断，判定依据由台账提供；插件不替它决定。

## 10. 协调者能力边界

协调者 agent 的工具集：

- 允许：`task_create`、`task_list`、`task_status`、`task_message`、`task_stop`、`ask_user`、`show_view`、memory 读写。
- 禁止：文件读写、shell、浏览器、web 搜索、其他执行类工具（通过工具白名单实现，而不是靠提示词自觉）。
- 不得凭记忆推断状态：涉及任务数量、重复、冲突、状态的结论，必须先取 `task_list`/`task_status` 的真实返回作为依据。
- 禁止 `wait_agent` 及任何阻塞等待：协调者看进度只用 `task_list`/`task_status`，子任务完成会主动通知，需要等就结束回合。`wait_agent` 是平台按 agent scope 注册的工具，运行期 `restrict` 去不掉，阶段 1 用 `ctx.tools.guard` 执行期硬拒绝 + 按会话动态渲染的系统提示兜底；同一条 assistant 消息里并行、且在绑定写入前就开始执行的等待不承诺拦住。阶段 2 由 agent preset 的 `composition.toolFilter` 固化整个工具集，运行期 guard/白名单降为兜底。

子任务会话不施加任何限制，只多一个 `task_report` 工具。

## 11. UI

- **左上角入口**：点击打开协调者会话（不存在则创建并命名"协调者"），已打开则切过去。
- **右上角历史面板**：全部任务列表，状态色点、标题、更新时间；可按状态筛选；点击跳转到对应子会话。
- **会话内卡片**：`show_view` 渲染，含任务名、状态、最近摘要、"打开会话"按钮；卡片数据与面板同源。

## 12. 错误处理

| 情况 | 行为 |
| --- | --- |
| 子会话创建失败（非容量） | 任务标 `failed`，`error` 写原因；同 title+goal 再 `task_create` 视为重试（终态不参与去重） |
| 并发满（`ACTIVATION_LIMIT_REACHED`） | 任务保持 `pending` 并排队（`queued_at`），不报错；槽位释放后自动补位 |
| 队列满（`maxQueue`） | 拒绝创建、不落库，返回当前排队数 |
| 重复创建（title+goal 相同且仍有活跃任务） | 返回已有任务（id、状态、「已存在任务 X，未重复创建」），不新建、不 spawn、不占额度 |
| 投递消息失败 | 记入 messages 失败态，三次重试后标 blocked |
| 子会话被删 | 启动/加载时对账标 `orphaned`，卡片提供「重建会话」 |
| 台账损坏 | 从 `state/orchestrator/snapshots/` 最近快照恢复，丢失最近变更并提示 |
| 协调者会话不存在 | 入口自动创建 |
| 授权转交失败 | 任务停留 waiting_auth，卡片标红，不静默卡死 |
| 任务超时 | 按第 8 节升级 |

## 13. 测试策略

- 单测：状态机迁移、brief 校验、渲染（含空字段、超长约束、特殊字符）、通知分级与合并、stale 判定。
- 集成（真机）：建任务 → 子会话执行 → 回报 done → 协调者收到 → 卡片出现 → 面板可见 → 点击跳转。
- 并发：同时 8 个子任务，验证不串号、不丢报告。
- 授权：子任务 needs_auth → 协调者问用户 → 用户同意 → 回传后继续。
- 复用：同主题新需求 → 判定续派而非新建。
- 打扰控制：连续 progress 不产生用户可见消息；30 分钟无事件触发升级。

## 14. 分期与工作量

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| 1 | 台账、协议与渲染、派活、完成通知、会话内卡片（无客户端） | 10 天 |
| 2 | 客户端入口与历史面板；协调者工具集由 agent preset 固化（`composition.toolFilter`） | 8 天 |
| 3 | 授权转交、断线恢复、并发治理、打扰阈值调优 | 5 天 |

合计约 23 人日（单人），团队并行约 2.5–3 周墙钟。

## 15. 风险

- 向指定会话注入消息并唤醒：用户已确认平台支持，阶段 1 联调时再验一次时序（协调者正忙时排队不丢）。
- 客户端槽位：入口按钮与右上角面板所需的槽位未逐项验证，阶段 2 开工首日先确认；不成立时退化到"面板做成侧栏"。
- 工具白名单对协调者生效范围：已确认白名单只落在协调者 agent 的 scope，子会话不受影响；但 `wait_agent`/团队类工具是 agent scope 注册，`restrict` 去不掉，阶段 1 靠 guard + 动态提示兜底，阶段 2 由 preset 固化。
- 台账并发写：SQLite WAL + 单写者串行化。
- **平台并发上限**：`maxActiveSubagents` 按 root 池、默认 8（用户设置可改），满了抛 `ACTIVATION_LIMIT_REACHED` 且平台不排队 → 插件自建队列（`pending` + `queued_at`），靠子会话结算唤醒补位；不能承诺「没有 8 个上限」，只能承诺「不报错、排队自动派发」。
- **子会话不在普通会话列表**：`origin:'subagent'` 被普通会话列表/恢复排除；卡片跳转必须走父会话的 subagent catalog（`ctx.subagents.listChildren`），阶段 2 客户端按此实现。
- **父会话关闭释放后代**：关闭协调者会话会 dispose 其实子会话，跑着的任务被中断；子会话 durable，协调者重开后可 `sendMessage` 冷恢复 → 任务不能仅凭「settle」判完成，仍以 `task_report` 为准。
- **Team 回退**：`backend:'team'` 只为旧任务/回退保留，默认不再使用 Team 名册；旧 Team 任务的 `session_id` 是 teammate id，续派前需真机验证 `sendMessage` 仍可投递。
- **团队工具面**：换掉 Team 后协调者仍可能看到 agent-team 注册的团队工具（`spawn_teammate` 等），`restrict` 去不掉；靠白名单/后续 preset 收窄，且非 lead 调用会被平台成员校验拒绝。
