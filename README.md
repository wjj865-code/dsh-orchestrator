# dsh-orchestrator

协调者会话 + 子任务工作台的服务端核心（阶段 1，无客户端）。

协调者只做协调：把需求拆成结构化任务、派给子会话、看回报、决定是否打扰用户；子任务是普通 DSH 会话（同队 teammate），能力不受限，只多一个 `task_report` 回报工具。

## 落盘范围

唯一写入是：

```
$DSH_HOME/state/orchestrator/tasks.sqlite        （+ -wal / -shm）
```

`DSH_HOME` 未设置时用 `~/.dsh`。不写 profile、不写其他会话目录、不建快照（阶段 3 再做）。

## 安装（维护者操作，不碰用户的 `~/.dsh/profiles`）

在目标 profile 目录（`~/.dsh/profiles/<name>`）做两处必改：

1. `package.json` 的 `dependencies` 加本地链接：

   ```json
   "dsh-orchestrator": "link:C:/Users/72489/Documents/dsh-orchestrator"
   ```

2. `dsh.profile.bundles` 里加 `dsh-orchestrator`，并确认已有：

   ```json
   [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-headless",
     "@deepseek-ai/dsh-experimental-agent-team-profile",
     "dsh-orchestrator"
   ]
   ```

   无头 profile 用 `@deepseek-ai/dsh-headless`，桌面 profile 用 `@deepseek-ai/dsh-web-app`。
   `@deepseek-ai/dsh-experimental-agent-team-profile` 提供 `ctx.agentTeams`；缺了它，插件会因缺服务加载失败。

3. 可选：需要显式指定协调者时，profile 的 `cordis.patch.yml` 加配置行；不配就自动绑定：

   ```yaml
   - id: orchestrator
     name: dsh-orchestrator
     config:
       coordinatorSession: session-c0531830-f695-42d3-879c-6d5b8e9a8799
   ```

4. 重新安装/重启该 profile 使其生效。

## 协调者绑定

解析顺序：`config.coordinatorSession`（显式覆盖，优先级最高，**不写台账**）→ 台账 `settings.coordinator_session_id` → 未绑定。

- 未绑定时，**root/lead 会话**第一次调用 `task_create`（通过 brief 校验和活跃上限后）会把**调用方会话**绑定为协调者；首绑用 `INSERT ... ON CONFLICT DO NOTHING` + 回读，先到先得、后到不覆盖，日志一行，并给该会话装白名单。
- 子会话（`session.header.parentSession` 非空）不能首绑或重绑，避免把子任务绑成协调者。
- 已绑定且 live 不重绑；绑定会话失效（找不到 live agent）时，只有 root/lead 调用方能重绑（CAS，先到先得），结果带「协调者会话已变更：旧 → 新」，旧协调者失效的通知记 `skipped` + `reason`，工具结果带「协调者会话已失效，可用配置覆盖或在新会话里派任务重新绑定」。
- 未绑定时 `task_message` / `task_stop` 只返回「尚未绑定协调者，请先 task_create」，不写库、不投递、不改状态。
- `task_list` / `task_status` 这类只读工具不触发绑定。
- 误绑用配置覆盖修正；覆盖期间始终以配置为准，不写台账。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `coordinatorSession` | `undefined` | 可选显式覆盖；不配则首次 `task_create` 自动绑定调用方 |
| `staleMinutes` | `30` | `task_list` 里超过这么多分钟无动静就标 `⚠` |
| `stallRounds` | `3` | 预留：阶段 3 的连续无进展升级阈值，阶段 1 只校验并保存 |
| `maxActive` | `8` | 并发额度上限，只算 `pending` + `running`；等待态（`waiting_user`/`waiting_auth`）不占额度 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |
| `spawnProvider` | `spawn` | `spawnTeammate` 的 provider（fresh 用 `spawn`；平台要求必填） |

插件按绑定的会话 id 惰性解析 live agent，所以协调者会话可以在插件加载后再打开；白名单在绑定时安装，并通过 `agent/created` 补装。非法值（0、负数、NaN、Infinity、字符串）一律回落默认，不会把插件带崩。

## 真机冒烟清单（隔离 profile）

1. **加载**：6 个 `task_*` 工具出现；日志无「未找到协调者会话」「白名单安装失败」「缺 `agentTeams`」。
2. **建任务**：`task_create` 返回「已派发」；子会话真的被创建；台账 `running` 且 `session_id`/`target` 已写。
3. **输入**：子会话收到的是渲染文字，不是 JSON。
4. **回报**：`progress` 不打扰；`done` 是插件 5 秒合并后 `agent.steer` 注入协调者会话，`notifications` 一行 `delivered`；平台自己还会发一条 `subagent-settled`，不写行、不算插件通知。
5. **等待态闭环**：`blocked`/`needs_auth` → `task_message` 续派 → `running` → `done` 能走通。
6. **R8 忙时排队**：协调者正在跑一轮时再回报，插件注入在下一步边界被接纳、不丢。
7. **白名单**：协调者工具列表里没有 `read`/`bash` 等；无安装失败日志。`spawn_teammate`/`send_message`/`list_agents` 阶段 1 仍可见（见已知局限）。
8. **落盘**：`DSH_HOME` 下只新增 `state/orchestrator/tasks.sqlite`（+`-wal`/`-shm`），不写 profile 和其他会话目录。
9. **审计口径**：插件通知与 `notifications` 行 1:1；`failed` 带 `reason`，`skipped` 的 `delivered_at` 为空；平台 settlement 通知不写行。
10. **自动绑定**：无配置 profile 第一次 `task_create` 后 `settings.coordinator_session_id` = 调用方 root 会话；并发首绑先到先得、后到不覆盖；第二次不再重绑；`task_list`/`task_status` 不写 `settings`；子会话首绑被拒。
11. **配置覆盖**：设置 `coordinatorSession` 时以配置为准、`settings` 为空，白名单只装在配置指定的会话。
12. **失效降级**：绑定会话找不到 live agent 时，通知记 `skipped` + `reason`、结果带提示；只有 root 调用方能重绑，结果带「协调者会话已变更」；未绑定时 `task_message`/`task_stop` 只提示、不半执行。


## 工具

协调者（5 个）：

| 工具 | 作用 |
| --- | --- |
| `task_create` | 建台账 + 渲染 brief + 派生一个 fresh 子会话；缺验收标准/超并发额度会拒绝（额度只算 `pending`+`running`，命中时列出占用任务） |
| `task_list` | 默认只列活跃任务；带标题、目标摘要、最近一条消息、陈旧标记；`active:false` 看全量 |
| `task_status` | 单任务详情 + 最近 3 条消息 |
| `task_message` | 续派消息（不新建任务），失败重试 3 次后转 `waiting_user` 并记原因 |
| `task_stop` | 中断当前一轮并标 `cancelled`；已结束任务不重复中断 |

子任务（1 个）：

| 工具 | 作用 |
| --- | --- |
| `task_report` | 每轮结束调用：`progress` / `done` / `blocked` / `needs_auth` |

6 个工具是**全局注册**，子任务会话也能看到协调者工具；阶段 1 靠协调者侧白名单收窄，子任务侧不做限制（设计允许），阶段 3 再用 agent preset 收口。

`task_report` 的四档通知：`progress` 静默只写台账；`done` 在 5 秒窗口内合并后汇报；`blocked` / `needs_auth` 立即打扰。插件通知**不经过 Team 的 `sendMessage`**（延迟后发送方已离队，会 `TEAM_NOT_MEMBER`），而是 5 秒合并后直接 `agent.steer` 注入协调者会话，所以合并窗口保得住。每次插件投递尝试都写 `notifications` 表：成功 `delivered`、失败 `failed`（带 `reason`）、跳过 `skipped`；后两者 `delivered_at` 为空。合并的后续行 `merged_into` 指向首条。

平台另有一条 `subagent-settled` 通知：continuable 子会话 settle/dispose 时由 `dsh-subagent` 自动发给父会话，不经过本插件、不写 `notifications`，只能解释「协调者为什么被唤醒」，不能当成插件通知成功。审计看 `notifications` 行与插件注入是否 1:1。

`task_message` 续派成功会把 `waiting_user`/`waiting_auth`/`failed` 拉回 `running`，`task_report` 的 `progress` 也会从等待态恢复，`done` 从等待态会先回 `running` 再完成。

## 协调者不得等待

协调者会话**禁止 `wait_agent` 和任何阻塞等待**：会把当前回合卡住，用户没法再发消息。看进度只用 `task_list` / `task_status`；子任务完成会主动通知；需要等就结束回合，等通知回来再处理。平台 `team:policy` 里有「Lead must wait for required teammates」，本插件的协调者提示会显式覆盖它。

`wait_agent` 是平台按 agent scope 注册的工具，`restrict` 去不掉（`restrictableNames` 里没有），所以用两层保护：

- **执行期 guard**：`ctx.tools.guard` 同步拒绝协调者调 `wait_agent`（返回中文原因）。`task_create` 写入绑定后，**同一回合里顺序执行**的 `wait_agent` 也会被拒；子任务和普通会话不受影响。
- **系统提示**：`orchestrator:coordinator-policy`（`order:130`）只对协调者会话渲染；绑定发生在 step N，禁令从 **step N+1** 的 prompt 起生效（prompt 每步重新装配）。
- **白名单收窄延到回合边界**：文件/shell 等工具的 `restrict` 不在绑定/装配当步装——绑定时若协调者还在 `running`，收窄挂起到回合 `idle` 后再装（本来就 idle 则立即装）。所以绑定回合仍是全工具表，不会出现 mid-turn `unknown tool`，下一回合才收窄。

时序上**不承诺「首绑回合绝对安全」**：同一条 assistant 消息里并行发出、且在绑定写入前就开始执行的 `wait_agent` 可能漏过（执行顺序不保证）。首绑回合里 `task_create` 之后要么结束回合、要么只做只读查看，别并发等待类工具。阶段 2 用 agent preset 的 `composition.toolFilter` 把协调者工具集从根上固化，运行期 guard/白名单降为兜底。

## 一次完整流程

1. 用户说「空数据时报表啥也不显示，修一下」。
2. 协调者调用 `task_create`：

   ```
   task_create({
     title: '修复空数据文案',
     goal: '空窗口时报表给出明确说明而不是空表',
     constraints: ['只改 src/report.js'],
     acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
     user_verbatim: '你看这个空数据啥也没显示'
   })
   ```

3. 子会话收到的输入是渲染文字，不是 JSON：

   ```
   【任务编号】t-1a2b3c4d
   【任务】修复空数据文案
   【目标】空窗口时报表给出明确说明而不是空表
   【约束】- 只改 src/report.js
   【验收标准】
   - 空窗口输出「该窗口没有调用记录」
   - npm test 全绿
   【用户原话】
   > 你看这个空数据啥也没显示
   完成后请汇报：改了什么、改了哪些文件、怎么验证的。
   ```

4. 子任务每轮末尾 `task_report({ task_id:'t-1a2b3c4d', status:'progress', summary:'已定位渲染分支' })`，协调者收到静默台账更新。
5. 完成后 `task_report({ status:'done', summary:'改了空数据分支，npm test 全绿' })`，协调者会话收到：

   ```
   任务「修复空数据文案」完成：改了空数据分支，npm test 全绿
   ```

6. 会话内卡片数据用 `taskCard(task, { summary })` 产出：`taskId`、`title`、`status`、中文 `label`、`tone`、截断到 80 字的 `summary`。

## 错误与降级

- 打不开/损坏的台账：损坏（`SQLITE_CORRUPT`/`NOTADB`）给 `台账损坏：<路径>（可尝试从 snapshots 目录恢复）：<原因>`；目录不可用（`ENOTDIR` 等）给 `台账不可用：<路径>：<原因>`；被占用给 `台账暂时不可用（被占用）`。都不泄漏 `SQLITE_` 和堆栈。
- 找不到协调者会话：工具仍注册，派活返回「任务协调失败：未找到协调者会话…」，任务留在 `pending` 并记原因。
- `task_report` 归属：回报方必须是任务绑定的子会话（`exec.agent.id === task.session_id`），否则返回「回报被拒绝」，不改状态、不写消息、不发通知。
- 子会话创建失败：任务留 `pending`，`error` 写原因；阶段 1 没有一键重派，需 `task_stop` 后重新 `task_create`。
- 续派投递失败：重试 3 次（1s/2s/4s），仍失败标 `waiting_user`，记失败消息行。
- 通知投递失败/跳过：写 `notifications` 行（`failed` 带原因，`skipped` 只有状态），不产生未处理 rejection。

## 已知局限（阶段 3 再做）

- **台账快照与自动恢复**：阶段 1 只把损坏库转成可读错误，不写快照、不自动恢复。
- **orphaned 自动检测/一键重建**：子会话被删后状态会停在 `running`，阶段 1 不自动检测。
- **30 分钟打扰升级**：`stallRounds` 只保存不生效，阶段 1 只有 `task_list` 的陈旧标记。
- **协调者白名单的持久声明**：阶段 1 在协调者 agent 已加载时用 `agent.ctx.tools.restrict({ deny })` 做最小收窄（文件/shell/浏览器/web 类）；收窄挂在**回合边界**（绑定回合若在跑，等 `idle` 再装），所以绑定回合仍是全工具表、下一回合才收窄，避免 mid-turn `unknown tool`。真机确认 `spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`/`team_task_*` 是 agent scope 注册，不在 `restrictableNames` 里，`restrict` 去不掉；`wait_agent` 由执行期 guard + 动态提示兜底（见上节），其余工具阶段 2 由 agent preset 的 `composition.toolFilter` 固化，运行期白名单降为兜底。
- **首绑回合的等待时序**：guard 管得住绑定后的同回合顺序调用；同一条 assistant 消息里并行、且在绑定前开始执行的 `wait_agent` 不承诺拦住。
- **唤醒时序**：通知走 `agent.steer` 直插协调者会话（等价于 TeamService 给 lead 投递时的 `root.steer`），空闲唤醒、忙时 `next-step` 排队；机制证据见 `docs/api-notes.md`。真机忙时排队由维护者冒烟验证。
- **平台 settlement 通知**：`subagent-settled` 是平台独立链路，不受本插件控制、不写 `notifications`。
- **headless 收尾竞态**：一次性进程在 5 秒合并窗口内退出时，`steer` 可能抛 `agent initiator scope is disposed`（进程级 initiator 作用域已 dispose），此时消息可能已进 inbox 但没有回合消费，`notifications` 记 `failed` + reason 是正确审计；长驻 desktop/服务进程不受影响。冒烟要在最后一条回报后保持进程活过 `mergeWindowMs` 才能看到 `delivered`。
- 阶段 1 没有客户端入口/历史面板；卡片只提供数据，不渲染 UI。

## 开发

```bash
npm test
node docs/probes/api-probe.mjs   # 核对已安装平台里 agentTeams 的契约
```
