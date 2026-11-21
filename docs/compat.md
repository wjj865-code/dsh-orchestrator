# 宿主兼容性与能力探测（compat）

> 适用：`@wjj865-code/dsh-orchestrator` 0.21.x（本文件随包发布）。
> 口径：插件只对下面声明的区间负责；区间外**照常加载**（不阻塞、不关功能），但先跑 §3 冒烟再报 bug。

## 1. 声明基线

| 项 | 值 | 真源 |
|---|---|---|
| 兼容区间 | `>=0.2.2-rc.3 <0.3.0` | `src/host-capabilities.js` 的 `HOST_BASELINE`（唯一真源） |
| 人类可读 | `0.2.2-rc.3` – `rc.5` | `README.md` 首屏定位行 |
| 最低验证版本 | `0.2.2-rc.3`（CI 断言基线声明 + 真机冒烟，§2 / §3） | 本文件 |
| 越界行为 | 启动时 warn **一次**（带实际版本与区间），不拦加载、不关任何功能 | `index.js` 启动自检 |

版本状态四态：`inside` / `below` / `above` / `unknown`。`unknown`（私有构建、`argv` 里没有 asar、安装清单不可读）**不告警**——探测不到不等于不兼容，只在日志与面板诊断行显示 `unknown`。

## 2. 已核实版本

| 宿主 | 核实方式 | 结论 |
|---|---|---|
| `0.2.2-rc.3` | 本机 desktop 真机实测（P0-1 及之前）+ `docs/probes/*` 契约探针 | 基线内。`agentTeams` 成员 API 已移除 → P0-1 删掉 team 后端 |
| `0.2.2-rc.4` | 未单独实测 | 同 minor；**按基线内声明，不代表已逐项验证** |
| `0.2.2-rc.5` | P0-2b 静态复核本机 desktop 安装包（asar 内 338 个 `@deepseek-ai/*` 全为 `0.2.2-rc.5`）；P2-4 复核 `dsh-agent-team` 的任务板契约 | 10 类耦合点的服务仍在（`settings` / `token-meter` / `session-query-sqlite` / 工作区 registry / `plan-mode` / `goal` / `agentTeams` 任务板 / `subagent` 系）；`app-boot` 新增 `engines.dsh` 插件兼容预检（本包尚未声明该字段，见 §5） |

## 3. rc.3 冒烟 3 条（本地可跑）

前置（离线、不装宿主，验证「不改宿主也能过」）：

```bash
pnpm test && pnpm run check:client && pnpm run check-version
node --test test/host-capabilities.test.js      # 10 类访问器 + 版本基线 + 文档同口径
```

再确认本次加载的宿主版本与 10 类能力（插件每次加载写一行 `host.capabilities`）：

```powershell
# Windows / Desktop
Select-String -Path "$env:DSH_HOME\state\orchestrator\logs\orchestrator-$(Get-Date -Format yyyy-MM-dd).jsonl" -Pattern 'host.capabilities'
# macOS / Linux
grep host.capabilities "$DSH_HOME/state/orchestrator/logs/orchestrator-$(date +%F).jsonl"
```

期望：`version` 为 `0.2.2-rc.3`/`-rc.5`、`versionStatus: inside`、`available: 10`（`missing: []`）。缺项时按 §4 的降级行为判读，不要当成「偶发失败」。

**启动瞬间读数 ≠ 最终能力面**：全新 profile 刚加载那一刻，`host.capabilities` 可能报 `available: 8`、`missing: ["registry","team-board"]`——这两项按需懒挂载，不是缺能力；等协调者会话起来（或延迟加载）后即可用：面板快照的 `teamBoard` 不再带 `degraded`、worktree 建树正常。§3 三条冒烟都不依赖这两项，所以「首次加载行不是 10/10」不构成冒烟失败；判能力面缺失前先等主会话起来再看一行。（0.28.0 隔离 web 冒烟实测：启动瞬间 8/10，会话起来后 teamBoard 可用、worktree 正常建出 `orch/<taskId>` 检出。）

**冒烟 1：派 3 个活 → 交付确认 → 追问复用同一子会话**
协调者会话里说：*「用 task_create 给三个不同目录各派一个只读任务，标题分别 call-A/B/C」* → 期望 `task_list` 出现 3 行、`task_status` 可查；让其中一个 `task_report(done)` → 状态变「已交付待确认」；`task_message` 追问 → **同一个 sessionId** 继续；`task_message({action:'close'})` → `done`。
失败判据：`task_create` 报「缺少 subagents 服务」= `team-api` 缺失（§4），不是任务本身的问题。

**冒烟 2：只读任务写文件被拒**
`task_create({ readOnly: true, target: <某目录> })`，让子会话 `write` 一个文件 → 期望被宿主沙箱拒绝（错误里带 sandbox/workspace 字样），任务照常回报。
失败判据：**写得进去** = 只读档失效，立刻记 `session-create` / `team-api` 行的现状并停用 `readOnly`。

**冒烟 3：worktree 隔离建检出**
`task_create({ worktree: true, target: <git 仓库> })` → 期望返回 `worktree` 块（检出目录 + 分支名 `orch/<taskId>`），产物落在检出目录、不在用户工作树。
失败判据：报「缺少 git」/ 检出目录不存在 = 宿主 git 能力或 cwd 形状变了，记 `session-create` 行。

## 4. 能力探测与降级（10 类）

`src/host-capabilities.js` 是**唯一**允许摸宿主的地方（`ctx.get` / `DSH_HOME` / 槽位名 / 安装清单）。`report()` 每次现算（服务晚加载能被看到），首片只接线三处：日志路径、版本探测、`settings` 探针；P2-4 接线第 10 类 `agentTeams`（官方 Team 板只读互通）。

| id | 宿主来源 | 缺失后果 | 降级行为 | 首片接线 |
|---|---|---|---|---|
| `team-api` | `agents` + `subagents`（`startActivation` / `sendMessage` / `interrupt`） | 派不了活 | 工具返回可读错误，不模拟成功 | 访问器就绪，消费点下一片 |
| `session-create` | `sessionController` / `agentPresets`（含只读沙箱 `sandbox/mode`） | 打不开主会话、只读档不生效 | 报「缺 sessionController.rename/select」；任务可建但无法开会话 | 访问器就绪，下一片 |
| `settings` | `settings`（宿主表单缝） | 插件配置页不可用 | 不影响任何现有功能：插件读写自己的台账 `settings` 表 | **已接线**（探针 + 报告行） |
| `registry` | `workspaceRegistry`（归档/工作区） | 轮换归档不可用 | 轮换判 `unknown` 侧降级，不执行不可逆动作 | 访问器就绪，下一片 |
| `token-meter` | `tokenMeter` | 当前无消费点（P1-A 删掉了轮换的上下文因子） | 无需降级：访问器保留，等后续消费点接线 | 访问器就绪，无消费点 |
| `session-query` | `sessionQuery.searchSessions` | `context({mode:'history'})` 会话那一路退化 | 只用台账/记忆命中，回复里如实说明 | 访问器就绪，下一片 |
| `panel-slots` | 槽位名 `main` / `sidebar.panellist` / `conversation.header.leading` / `conversation.chat.turnTail` | 面板入口不渲染（历史「真实宿主永不渲染」） | 退到 `main` 单槽；入口隐藏但不报错 | 访问器就绪，下一片 |
| `log-path` | `$DSH_HOME`（空白按未设置）→ `<home>/state/orchestrator` | 日志/台账写不进去 | 台账打不开即加载失败（这是硬依赖，不是降级项） | **已接线** |
| `version` | 环境变量 `DSH_HOST_VERSION`/`DSH_VERSION`，其次 asar 内 `<root>/app.asar/<inner>/package.json` | 无从判越界 | `unknown`，不告警；功能照常 | **已接线** |
| `team-board` | `agentTeams.isEnabled` / `listTasks`（确认反写另需 `updateTask`） | 看不到官方板、确认时不能反写 | 整段降级：`snapshot.teamBoard = {enabled:false, rows:[], degraded}`，`enabled !== true` 时面板**整区隐藏（不显示提示条）**；确认交付照常完成，只记 `team.board.skipped` | **已接线**（P2-4） |

日志字段：`host.capabilities` 的 `detail` = `{ version, versionSource, versionStatus, available, total, missing[] }`。

## 5. 已知缺口（P0 剩余，按优先级）

1. **消费点迁移（6 类）**：`dispatch.js` 仍裸取 `ctx.get('agentPresets')` / `ctx.get('planMode')`；客户端槽位名与 `TurnLocation` 语义仍在 `client/src` 里硬编码（`client.js:226/247/252/267`、`logic.js:233-247`）。迁移完加静态断言：业务模块出现裸 `ctx.get(` 即测试失败。
2. **面板诊断行**：把 `report()` 渲染成「宿主能力 10/10，缺失 X」一行（复用 `index.js` 里 `checkScheduleCapability` 的降级文案模式）。
3. **`engines.dsh` 声明**：rc.5 的 `app-boot` 会按 `engines.dsh`（否则 `peerDependencies` 里的 `@deepseek-ai/dsh-*`）做加载前兼容预检；本包尚未声明。加之前要确认 rc.3 是否会因此拒载。
4. **CI 宿主矩阵**：当前 CI 跑单测 + 构建 + 版本断言（不装宿主），rc.3 冒烟是真机手工；把 §3 变成 CI 作业（装 `@deepseek-ai/dsh-base@0.2.2-rc.3` 跑契约探针）留待后续。
