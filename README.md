# dsh-orchestrator

> **一句话定位**：给 DeepSeek Harness 加一位「协调者」——主会话只拆活、派子会话、看回报、交付产物；子会话在各自目标目录里把活干完，进度与结论落进持久台账，浏览器里有任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（当前 `0.14.1`）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- License：MIT｜Node `>= 22.15`（`engines`），DSH rc.3+ 实测（Web 表面为主，Desktop 同构）

## 目录

- [安装与升级](#安装与升级)
- [快速上手](#快速上手)
- [核心概念](#核心概念)
- [工具清单](#工具清单)
- [配置](#配置)
- [状态与数据](#状态与数据)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [更多文档](#更多文档)

## 安装与升级

### 从 npm 安装（推荐）

1. DSH → 插件 → **添加插件**，粘贴：

   ```text
   @wjj865-code/dsh-orchestrator@0.14.1
   ```

2. **彻底退出 DSH 再启动**（只关窗口、重开窗口都不生效）。
3. 纯 dsh 表面左侧栏「插件」下方会出现「◈ 主会话」；Bot 模式用会话头「任务」按钮进面板。

### 升级

- 升级 = **装新版 + 彻底重启 DSH**：插件宿主侧代码在 DSH 进程启动时加载，**刷新页面不会换版本**（页面刷新最多重载前端资源，不会重新加载插件）。装完发现还是旧行为，先确认「是否真的重启过」。
- 在 DSH 插件页用 registry 包的更新入口升级；从 GitHub 装的先卸载旧版再装新版。
- 旧包名 `dsh-orchestrator` 与新版不兼容，先移除。
- 升级后建议核对一次：插件页版本号、工具表里 `task_*` 是否齐全、子会话是否能 `task_report`。

### 从 GitHub 安装（备选）

```text
https://github.com/wjj865-code/dsh-orchestrator
```

装完同样要彻底重启；升级时先卸载旧版再装新版。

### 装好后的自检

1. 插件页能看到「任务编排」标题、图标和详情页。
2. 侧栏「主会话」能打开；协调者工具表 11 个工具，子会话另有 3 个（全局共 14 个）。
3. 派一条任务，子会话 `task_report done` 后主会话收到「已交付待确认」通知；`task_close` 能确认成「已完成」。
4. 会话头「☰ 任务」只在主会话显示，切到子会话后自动隐藏。

### 入口在哪

- 侧栏「插件」下方「◈ 主会话」：直达协调者对话，**始终可见**（还没建主会话时靠它引导创建）。
- 会话头「☰ 任务」：打开任务面板，**只在主会话显示**。判定信号是台账主会话 id（`settings.main_session_id`，配置 `coordinatorSession` 覆盖）：客户端把当前会话 id 发到 `/api/orchestrator` 的 `session-role` 端点，宿主回答是不是主会话；信号不可用（拿不到会话、请求失败）时**默认隐藏**——宁可少一个入口，也不在子会话里露出面板。
- 面板右上角「打开主会话」：创建/复用一个主会话。

## 快速上手

### 1. 打开主会话

侧栏「◈ 主会话」（或面板「打开主会话」）。协调者预设只做协调：没有 `read`/`write`/`bash`，也不会阻塞等待子任务。

### 2. 说需求 = 派单

用自然语言对主会话说需求即可，协调者会调用 `task_create` 拆任务：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

有先后关系用 `dependsOn`，同一需求用 `group`，会改同一批文件用 `writeScopes`，紧急的给 `priority`：

```js
task_create({ title: '改接口', goal: '...', acceptance: ['...'], group: '登录改造' })
task_create({
  title: '联调登录',
  goal: '...',
  acceptance: ['...'],
  dependsOn: ['t-xxxxxxxx'],
  group: '登录改造',
  writeScopes: ['src/auth'],
  priority: 5,
})
```

### 3. 看进度

- 协调者不阻塞等待：进度用 `task_list` / `task_status` / `task_inbox`，子任务完成会主动通知（`agent.steer` 注入，5 秒合并）。
- 子会话用 `task_report` 汇报：`progress`（有进展未完成）/ `done`（做完了，交付）/ `blocked`（等人决定）/ `needs_auth`（需要授权）。

### 4. 交付、确认与追问（0.14 起是两段式）

子会话报 `done` **不等于**任务结束，而是落到 **`delivered`（已交付待确认）**：

- **默认保持待确认，不主动关闭**：追问窗口留着，用户看完结果常还要改。协调者只在用户明确说「确认 / 没问题 / 不用再改」，或确实需要终态（要派依赖它的任务、要删任务、要收尾）时才 `task_close`。
- 要改/补充：`task_message`（或面板「追加」）**复用同一个子会话**，任务回到 `running`，完成后会再交付一次。
- 一直不确认：超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动收成 `done`（`close_reason=timeout`）。
- 面板「待你决定」筛选与收件箱都包含 `delivered`，任务卡/抽屉有「待确认」小标、交付时间与关闭原因。

### 5. 面板

会话头「☰ 任务」打开，DeepSeek 设计平台风格三段式：

| 段 | 内容 |
| --- | --- |
| 顶部命令栏 | 标题 + 主会话状态点、任务搜索、刷新、打开主会话；4 张指标卡（进行中/待你决定/已完成/失败，点击即切筛选） |
| 中部工作区 | 左侧筛选轨（带计数徽标）+ 任务卡列表；切到「产物」变成产物库（按项目/日期分组、可预览/复制） |
| 右侧详情抽屉 | 遮罩、`Esc`、关闭按钮都能收起；7 个可折叠区块：概览、最新回复、Brief、目标状态、消息、依赖、产物 |

- 颜色/圆角/阴影/动效全部取宿主 `--dsw-*` token，深浅色主题自动跟随。
- 底部动作条：停止（二次确认）/ 确认交付（仅「待确认」，二次确认）/ 重派 / 追加消息（仅可续派状态）/ 打开子会话 / 删除（仅终态、二次确认，级联清台账）。可见性与后端门控同源（`src/panel-gates.js`）。
- 交互细节与 token 对照见 [docs/UI.md](docs/UI.md)。

## 核心概念

### 任务状态机：交付（`delivered`）≠ 完成（`done`）

| 状态 | 含义 | 谁推进 |
| --- | --- | --- |
| `waiting_dep` | 等前置完成，不派发、不占并发位 | 前置 `done` 后自动 → `pending` |
| `pending` | 排队等并发槽位 | 队列自动派发 → `running` |
| `running` | 子会话在跑 | 子会话回报 / 结算 |
| `waiting_user` | 子会话 `blocked`，等人决定 | `task_message` 续派 → `running` |
| `waiting_auth` | 子会话 `needs_auth`，等授权 | 同上 |
| **`delivered`** | **已交付待确认**：成果已落库，等确认或追问 | `task_close` → `done`；`task_message` → `running`；超时 → `done` |
| `done` | 已完成（**不可逆终态**，不提供 reopen） | — |
| `failed` | 失败（可 `task_retry` / 面板重派） | — |
| `cancelled` | 被 `task_stop` 停掉 | — |
| `orphaned` | 会话丢了（上报过 progress 的回合异常结束） | 可重派 |

- 依赖就绪**只认 `done`**：`delivered` 会短暂挡住下游，确认或超时后自动晋升。
- `delivered` 是唯一允许「追问复用原会话」的收尾态；`done` 之后要改只能新派任务。
- 面板「待你决定」与 `task_inbox` 都把 `delivered` 当待办。

### 依赖、分组、写域、优先级

- `dependsOn`：前置没完成 → `waiting_dep`；全部 `done` → 自动 `pending`；任一失败 → 下游自动 `failed`（写清原因）。创建后不可编辑，也不允许指向未来 id。
- `group`：分组，面板按组汇总进度（`task_list({ group })` 看「已完成/待确认」）。
- `writeScopes`：写域，**只做冲突提示**，不是文件锁。
- `priority`：`-10..10`，高的先派。

### 交付口径：`present`

- 协调者不读写文件（`read`/`write`/`glob`/`grep`/`bash` 都被拒），交付只靠 `present`。
- 默认用 `present` 展示 **1–4 个最关键的产物（最多 4 个）**：只列真实存在的普通文件、写绝对路径，不必等用户点名；没有产物就不提 `present`。
- 存在性由插件与子任务负责（通知里的路径已 `lstat` 校验）；`present` 只声明交付、不读文件内容。
- 子任务 `done` 时还会从 `workspaceChanges` 自动收集本轮改动文件，与显式 `artifacts` 按路径去重合并。

### 计划任务：`planFirst` + `plan_save`

`task_create({ ..., planFirst: true })` 让子会话以**计划阶段**起步：**只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）**。写文件/写 shell 被沙箱拒绝是预期行为，不是权限故障。

四步流程：

1. **只读探索**：读代码/文档、跑只读命令、验证假设。
2. **计划落盘**：调 `plan_save({ task_id, content })`，插件在宿主进程把计划正文写进**主会话工作区**的 `reports/plans/<taskId>.md`，并自动登记为任务产物。这是计划阶段**唯一**允许的写入口：路径固定、只收任务编号（编号形状白名单 + `relative()` 包含性校验，逃逸在写之前就拒），正文上限 200000 字，重复保存覆盖同一份（只有一版，没有版本对比/审批流）。
3. **摘要上报**：`task_report({ status: 'blocked', summary, question, options })` 只报 **3–8 行摘要 + 计划文档绝对路径 + 待拍板问题**；不要把计划正文塞进 `question`（500 字上限会截断）。
4. **批准执行**：用户批准后协调者 `task_message` 续派（或面板「追加」），插件在投递成功且任务回到 `running` 后把沙箱切回 `workspace-write`、关闭 plan mode。

- 只认显式 `true`；与 `readOnly` **互斥**（创建期拒绝）。
- 出口不是 `exit_plan_mode`：子会话没有直接人类，插件在子会话作用域拒绝它，文案指向「先 `plan_save`、再 `task_report blocked`」。
- `plan_save` 只对本任务的子会话、只对计划任务开放；协调者侧 guard 硬拦。
- 台账 `plan_state`：`planning`（等批准）/ `approved` / `rejected`；`task_list` 给「·计划中」，面板任务卡有「计划中」小标。
- 边界见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md#计划阶段p8)。

### 完整访问任务：`access: 'full'`

`task_create({ ..., access: 'full' })` 让**这一条任务**的子会话跑在 `danger-full-access`：文件沙箱不再限制写入，`bash` / `pwsh` 也不再被沙箱拦。用途只有构建 / 发版 / 装依赖 / 写仓库外目录这类确实要越过默认边界的活。

- **默认一点都不动**：不传 `access` 就完全沿用会话策略，插件不改部署默认、不碰父会话、不碰其他任务。
- **只接受 `'full'`**：`'workspace-write'` / `'read-only'` / `'true'` / 数字一律创建期报错，不静默降级。
- **与 `readOnly` / `planFirst` 互斥**；与 `worktree` 不冲突（隔离目录 vs 放开权限是两件事）。
- **不继承**：任务级字段，不写配置、不往孙任务传；重派/追问沿用原任务的 `access`。
- **可观测**：brief 第二行「【访问级别】完整」、`task_detail`/`task_status` 明写、通知标题带「（完整访问）」、台账 `tasks.access` 审计。
- **风险**：等于把该子会话的写权限交给模型——它能改任何用户能改的文件。用完正常进终态，`task_stop` 照样能收。

### 隔离任务：`worktree`

`task_create({ ..., worktree: true })` 时插件在**宿主进程**里对目标仓库执行 `git worktree add -b <branch> <repo>/.agents/worktrees/<taskId> <base>`，子会话在检出目录里干活，用户工作树保持干净；分支留在仓库里，**合并由你决定**（插件不合并、不 push、不碰远程）。

声明只有结构化两处，插件不解析自然语言：

| 层级 | 载体 | 字段 |
|---|---|---|
| 用户级默认 | profile 配置 | `worktreePolicy`（`required` / `auto` / `off`，默认 `auto`）、`worktreeBranchPrefix`（默认 `orch/`）、`worktreeRecentDays`（默认 `7`） |
| 任务级决定 | `task_create` 参数 | `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` / `worktreeCleanup` |

- **要不要建**：`required` 每个需求都隔离；`auto` 默认不隔离，「目标仓库是 git 仓库 ∧ 同一需求已有任务在跑 ∧ 本次是新需求」三条都满足才建议；`off` 一律不隔离。你在 `AGENTS.md` 里写「必须隔离」的生效路径是 **DSH 注入 → 协调者读懂 → 传 `worktree:true`**；要硬保证就配 `worktreePolicy: required`。
- **基线**：`worktreeBase` 缺省用仓库默认分支；近 N 天只有 1 个活跃分支就直接用它；**≥2 个时插件不建任务**，返回候选让协调者用 `ask_user_question` 问你，拿到答案再带 `worktreeBase` 重调。
- **分支名**：默认 `orch/<taskId>`；想用可读名（如 `orch/fix-login-retry`）就显式传 `worktreeBranch`，用户/项目的命名约定优先。非法或重名**报错不自动改名**（换名或改 `worktreeMode:'continue'` 复用已有检出）。
- **不是 git 仓库** → 降级普通模式并提示；**建树失败**（没装 git / 路径已存在 / 分支已存在）→ 任务失败并写原因，不静默降级。
- **清理**：`worktreeCleanup:'off'`（默认，检出+分支都留）/ `'checkout-only'`（只删检出，推荐）/ `'full'`（连分支一起删，有未合并提交会提示）。
- **并发**：同一检出上不要并发两个任务，用 `dependsOn` 串行。
- 视图：`task_status` 有「隔离：」行，`task_list` 打「·隔离」，通知与面板写「产物在分支 X 的检出目录 Y，合并由你决定」。

### 只读任务

`task_create({ ..., readOnly: true })` 让子会话进 read-only 沙箱，只认显式 `true`；只读任务不注册 target 可写根，续派也**不会**转可写（契约如此）。

### 记忆分层

- **日志层**：`done` 摘要写进 `task-log`（一行一条），**只归档、永不注入**任务详情。
- **事实层**：摘要里带经验/教训标记的分句蒸馏成 `lesson`，加上 `decision` / `preference` / `note` 原子事实，才随 `task_create` 写进 `lessons/` 记忆文件、由 `task_detail` 给出路径；`memoryLimit` 控制注入条数（默认 3）。
- **检索**：`history_search` 查插件记忆/历史任务/平台历史会话；`project_context` 读项目白名单文件、顶层结构、最近任务；`memory_note` 记一条跨任务有效的决策/偏好/经验。

### 收件箱与日报

- `task_inbox` / 面板「待你决定」：待你决定、待确认（`delivered`）、失败/丢失、长时间没动静。
- `blocked` / `needs_auth` 可带 `question` + `options`，显示在通知、详情与面板。
- 日报默认关闭；profile 配 `digestAt: '09:00'`（`digestTimeZone` 可选）后，打开主会话自动挂 schedule，到点汇总完成/在跑/待决定/失败/产物。
- 空闲看门狗默认开：`running` 长时间无心跳/消息/状态变化时告警一次，只告警、不改状态、不 kill。

### 可选能力：平台 goal 与回合间 keep-alive

两者都不参与普通编排（goal 只是只读镜像，keep-alive 默认关）：

- **平台 goal（只读镜像）**：派发后把 `task_create.goal` 同步成子会话的平台 goal 并**立即 disarm**（不会自动续跑）。`task_message` 把消息并成「最新指示」并 `edit`；确认完成时 `complete`，停止/重派/失败时 `clear`。平台没有 goal 服务时静默降级。子会话用 `get_goal` 读，`task_detail` 也有创建时的目标快照。
- **回合间 keep-alive（默认关）**：`keepAlive: true` 时订阅 `agent/turn-stopping`，在回合边界给「`running` 且平台 goal 未完成」的子会话注入下一轮，轮数上限 `keepAliveMaxRounds`（默认 8）。默认 `steer`（同一回合再走一步）。它是宿主替子会话开工，不是成本控制。

## 工具清单

协调者（11 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发；支持 `dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` / `planFirst` / `access`（`'full'`）/ `worktree*` |
| `task_list` | 活跃任务/历史任务；`group` 过滤看组进度 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、交付/关闭时间、最近消息、最新返回（`include:'full'` 看全文） |
| `task_message` | 续派消息（含「待确认」上的追问，复用原会话）；排队/等前置会返回提示 |
| `task_close` | 把「已交付待确认」（`delivered`）确认成已完成（`done`，终态） |
| `task_stop` | 停止任务（运行中/排队/等前置/待确认） |
| `task_retry` | 重建 failed/orphaned，保留编排字段 |
| `task_inbox` | 收件箱：待决、待确认、失败/丢失、长时间没动静 |
| `history_search` | 查插件记忆、历史任务、平台历史会话 |
| `project_context` | 只读项目白名单文件、顶层结构、最近任务、相关记忆 |
| `memory_note` | 记一条跨任务有效的决策/偏好/经验 |

子任务（3 个）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`；可带 `question` / `options` / `artifacts`。`done` 落「已交付待确认」，等确认或追问 |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物；越权会被拒 |
| `plan_save` | 计划模式专用：把计划正文写进主会话工作区 `reports/plans/<taskId>.md` 并登记为产物（计划阶段唯一写入口） |

- 14 个工具**全局注册**，worker 预设不做工具收窄，子会话直接继承。
- `task_close` / `task_retry` / `task_inbox` / `history_search` / `project_context` / `memory_note` 仅主会话可调；`task_detail` / `task_report` / `plan_save` 只对任务自己的子会话开放（`plan_save` 还要求任务是计划任务）。
- 派发给子会话的 **brief 是纯指引**（任务编号 + 「先调 `task_detail`」），目标全文、验收、经验、前置、产物都不内联进提示词。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id` |
| `backend` | `subagent` | 派发后端；`team` 仅旧平台可用，rc.3 起返回可读错误 |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / stall 提醒间隔 |
| `deliveredTimeoutMinutes` | `60` | 「已交付待确认」多久没确认就自动 `done`（1–1440；设成 1 约等于「交付即完成」的旧行为） |
| `stallRounds` | `3` | 连续 progress 达阈值后提醒一次「可能卡住」 |
| `idleWatchdog` | `true` | 空闲看门狗，只告警 |
| `watchdogIntervalMinutes` | `5` | 看门狗巡检间隔（1–1440） |
| `watchdogIdleMinutes` | `15` | 判空闲阈值（1–1440，同一段空闲每任务只报一次） |
| `keepAlive` | `false` | 回合间续跑开关（需要 `ctx.goals`） |
| `keepAliveMode` | `steer` | `steer`（同回合再走一步）/ `followup`（新回合） |
| `keepAliveMaxRounds` | `8` | 每段 activation 的续跑轮数上限（1–50） |
| `keepAlivePrompt` | `''` | 覆盖默认续跑提示 |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `digestTimeZone` | `''` | 日报时区；空 = 系统时区 |
| `maxQueue` | `50` | `pending` + `waiting_dep` 安全阀 |
| `autoResumeQueue` | `true` | 重启后自动恢复排队任务 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |
| `memoryInject` | `true` | 新任务是否注入事实层记忆 |
| `memoryLimit` | `3` | 注入记忆条数（1–10） |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |
| `worktreePolicy` | `auto` | `required` / `auto` / `off`；渲染进协调者 policy，漏传时兜底 |
| `worktreeBranchPrefix` | `orch/` | 隔离任务分支前缀（默认名 `<prefix><taskId>`） |
| `worktreeRecentDays` | `7` | 「近期活跃分支」窗口（1–90） |

## 状态与数据

插件只写 `$DSH_HOME/state/orchestrator/`（未设置时 `~/.dsh`）：`tasks.sqlite` 是台账，`snapshots/` 每天一份快照（保留 7 天），`logs/` 是按天的 JSONL 日志（保留 7 天），`lessons/` 放注入任务的经验文件，`reports/` 放超长返回消息的全文。

- 快照损坏时**不会自动恢复**：先备份，再用 `snapshots/` 里最新一份手工替换台账。
- 面板「删除」只删台账记录（任务/消息/通知），产物文件与记忆不删。
- 计划文档不在插件 state 里：`plan_save` 写到**主会话工作区**的 `reports/plans/<taskId>.md`。
- 目录布局与生命周期细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「落盘与日志」。

## 已知限制

**平台与沙箱**

- **委托子会话的审批固定 `never`**：子会话写被拒时**不会弹审批**，沙箱拒绝就是终局。子会话里没有「升级权限再试一次」这条路；要越过沙箱边界只能用 `access:'full'`（见上）或换 CI/人工执行。
- **插件没有命令白名单**：隔离只在「沙箱模式 / 可写根」这一层做，**不对 `bash` / `pwsh` 的命令做 allow/deny 名单**；`danger-full-access` 下模型能跑任意命令，没有命令级护栏。字符串白名单本身可被复合命令绕过，这里不做「假安全」。
- **构建 / 发版需要完整访问或 CI**：子会话默认 `workspace-write`，写不进仓库外的东西，也可能被平台限制 `pwsh` 写 target（Windows）。两条正路：① 给**单条**任务 `access:'full'`；② 把构建交给 CI 或人在终端跑（子会话只改源码 + 交构建清单），插件零改动。
- 首回合可写窗口：只读/计划/完整访问都在 `agent/created` 之后设置，极短窗口内仍是继承来的模式。
- 父会话自己是 `danger-full-access` 时，平台会把该覆盖按 delegation 种进所有子会话（不是插件做的，插件也不改写）。

**编排**

- `writeScopes` 只做冲突提示；`dependsOn` 创建后不可编辑。
- `done` 不可逆、无 reopen；要改交付物用追问窗口，要新工作新派/重派。
- 结算自动收场只覆盖「一次 activation」；上报过 progress 的回合异常结束会落 `orphaned`。
- 「最后一条回复」可能缺：插件在结算事件到达前被卸载/进程被杀时拿不到。
- 主会话工具表可能残留团队工具（agent-scope 自注册，`restrict` 遮不到），执行层 guard 会拦。

**worktree / 计划 / 视图**

- worktree 需宿主有 `git`；未合并的产物不在你的工作树里，合并责任在用户；默认不清理会占磁盘。
- 计划模式硬拦只靠只读沙箱，plan mode 本身是软引导；计划文档只有一版，没有审批流 UI。
- 会话头「☰ 任务」依赖宿主身份信号，刚打开主会话 1 秒内可能短暂不可见；面板轮询 2 秒，没有 SSE。
- 面板「删除」只删台账（级联清消息/通知），产物文件、`reports/` 全文、记忆不删。
- Bot 模式视图停在 Bot 会话；纯 dsh 表面不受影响。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.14.1`；**彻底退出 DSH 再启动**（刷新页面无效） |
| 插件页 / `npm i @latest` 装到旧版 | 镜像还没同步（新版本几十分钟到几小时）：过一会儿重装；急着用就换 `@wjj865-code/dsh-orchestrator@0.14.1` 显式版本；维护者侧可主动同步镜像（见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#发版)） |
| 会话头没有「☰ 任务」 | 只在主会话显示：确认当前会话就是侧栏「主会话」打开的；没建就点「打开主会话」 |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页与 `logs/` |
| 提示「尚未打开主会话」 | 面板点「打开主会话」 |
| 子任务报 done 后一直「待确认」 | 正常：默认保持待确认等用户拍板；要收尾就 `task_close`，或等 `deliveredTimeoutMinutes` 超时自动完成 |
| 任务停在「会话丢失」 | 子会话只在没报过 progress 时自动交付；上报过 progress 的回合异常结束落 `orphaned`。先用 `task_status` 看进展，需要接着做就 `task_retry` |
| 提示「team 后端不可用」 | `backend` 改回 `subagent` |
| 日志提示 `workerPreset` 回落 | 预设 id 只能用小写字母/数字/连字符；改值后彻底重启 |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制；确实要写仓库外用 `access:'full'` 或 CI |
| 子任务没有 `cordis_*` 工具 | 确认 `orch-debug` bundle 已装、`workerPreset: orch-debug`、已彻底重启（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| 台账损坏 | 用 `snapshots/` 最新快照手工替换 |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |

排障细节（平台缺陷、时序竞态、已知降级）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/DETAIL.md](docs/DETAIL.md) | 插件页简介：功能点、工具与面板错误码 |
| [docs/UI.md](docs/UI.md) | 面板/抽屉布局、`--dsw-*` token 对照、交互清单 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 平台/沙箱/计划/worktree/通知/UI 的完整限制清单 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 内部设计：模块划分、状态机、派发、结算、对账、落盘 |
| [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md) | `orch-debug` 调试预设的安装、对齐与插件更新流程 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 开发、构建、测试策略与发版流程（维护者） |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本的变化与取舍 |

## License

MIT
