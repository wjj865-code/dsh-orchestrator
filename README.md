# dsh-orchestrator

> DeepSeek Harness 的任务编排插件：一个主会话负责拆任务，子会话并行执行；带跨项目记忆、依赖编排、收件箱、日报和任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（最新 `0.11.0`）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- License：MIT

## 这是什么

| 能力 | 说明 |
|---|---|
| 协调者 | 固定「主会话」，只拆任务、派子会话、看回报、用 `present` 交付产物，不读写文件 |
| 子任务 | 独立 DSH 子会话，按目标目录运行；可只读、续派、停止、重派 |
| 依赖编排 | `dependsOn` 前置；完成自动晋升，失败沿依赖链传播 |
| 分组/写域/优先级 | `group` 分组、`writeScopes` 冲突提示、`priority` 队列排序 |
| 跨项目记忆 | 分层沉淀：done 摘要进 `task-log`（只归档、不进任务详情），经验/决策/偏好蒸馏成原子事实才随 `task_detail` 注入；`history_search` / `project_context` 补上下文 |
| 收件箱/日报 | `task_inbox` 看待决与卡点；`digestAt` 开每日汇总 |
| 任务面板 | 会话头入口；DeepSeek 风格三段式（命令栏 / 筛选轨+任务卡 / 右侧详情抽屉）；详情/停止/重派/追加；产物库按项目/日期分组、可预览/复制 |
| 产物收集 | done 自动从 `workspaceChanges` 收集改动文件，与显式 `artifacts` 按路径去重合并 |
| 结算闭环 | 子会话结束/中断自动收场：正常完成→已完成，被中断→已取消，异常→失败，只报过进展→会话丢失 |
| 目标状态 | 子任务目标同步到平台 `ctx.goals`（create 后立即 disarm，不自动续轮）；台账与面板只读展示 phase/activation |

协调者不阻塞等待：进度用 `task_list` / `task_inbox`，子任务完成会主动通知。

## 快速开始

### 从 npm 安装（推荐）

1. DSH → 插件 → **添加插件**，粘贴：

   ```text
   @wjj865-code/dsh-orchestrator@0.11.0
   ```

2. **彻底退出 DSH 再启动**（只关窗口不生效）。
3. 纯 dsh 表面左侧栏「插件」下方会出现「◈ 主会话」；Bot 模式用会话头「任务」按钮进面板（任务入口只在主会话显示）。

以后升级：在 DSH 插件页用 registry 包的更新入口升级；维护者发版流程见下文。

### 从 GitHub 安装（备选）

```text
https://github.com/wjj865-code/dsh-orchestrator
```

装完同样要彻底重启。升级时先卸载旧版再装新版；旧包名 `dsh-orchestrator` 要先移除。

### 打开入口

- 侧栏「插件」下方「主会话」：直达协调者对话。**始终可见**（还没建主会话时也靠它引导创建）。
- 会话头「☰ 任务」：打开任务面板。**只在主会话显示**；切到子会话或其他会话时自动隐藏。
  判定信号是台账主会话 id（`settings.main_session_id`，配置 `coordinatorSession` 覆盖）：
  客户端把当前会话 id 发给 `/api/orchestrator` 的 `session-role` 端点，宿主回答是不是主会话。
  信号不可用（拿不到当前会话、宿主请求失败、响应异常）时**默认隐藏**——宁可少一个入口，也不在子会话里露出任务面板。
- 面板右上角「打开主会话」：创建/复用一个主会话。

### 面板长什么样（U2）

面板走 DeepSeek 设计平台风格，分成三段：

| 段 | 内容 |
| --- | --- |
| 顶部命令栏 | 标题 + 主会话状态点、任务搜索框、刷新、打开主会话；下面是 4 张指标卡（进行中/待你决定/已完成/失败，点一下等于切筛选） |
| 中部工作区 | 左侧筛选轨（带计数徽标）+ 任务卡列表；切到「产物」变成产物库（按项目/日期分组） |
| 右侧详情抽屉 | 点任务卡或「详情」从右侧滑入，遮罩、`Esc`、关闭按钮都能收起 |

- 颜色/圆角/阴影/动效全部取宿主 `--dsw-*` token，**深浅色主题自动跟随**，面板不写死颜色。
- 抽屉里 7 个可折叠区块：概览、**最新回复**（子会话最后一条回复）、**Brief**（验收/约束/背景/原话）、
  **目标状态**（只读）、**消息**（待发/已投递/投递失败）、**依赖**（上下游）、**产物**（复制路径）；
  底部动作条：停止（二次确认）/重派/追加消息/打开子会话。
- 交互细节：卡片 hover 与按下反馈、抽屉滑入滑出、区块折叠动画、骨架加载态、空态、带「重试」的错误条、
  `prefers-reduced-motion` 下关闭动效。设计细节见 [docs/UI.md](docs/UI.md)。


## 怎么用

用自然语言对主会话说需求即可。协调者会调用 `task_create` 拆任务，例如：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

### 依赖与分组

```js
// 先建 A，再建依赖 A 的 B
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

- 前置没完成：B 是 `waiting_dep`，不派发、不占并发位。
- 前置全部 `done`：B 自动变 `pending`；下游子会话用 `task_detail` 能看到前置任务的摘要和产物（按当前台账现读）。
- 前置失败：B 自动 `failed`，错误写明原因。
- `writeScopes` 只提示冲突，不是文件锁；`priority` 高的先派。

### 收件箱与日报

- 面板「待你决定」/ `task_inbox`：等确认、要授权、失败、长时间没动静。
- `blocked` / `needs_auth` 可带 `question` + `options`，会显示在通知、详情和面板。
- 日报默认关闭；在 profile 配置：

  ```yaml
  - id: orchestrator
    name: '@wjj865-code/dsh-orchestrator'
    config:
      digestAt: '09:00'
      digestTimeZone: Asia/Shanghai
  ```

  打开主会话后自动挂 schedule；到点汇总完成/在跑/待决定/失败/产物。

### 只读任务

`task_create({ ..., readOnly: true })` 会让子会话进入 read-only 沙箱；只认显式 `true`。只读任务不注册 target 可写根。

### 目标状态（平台 goal，只读）

每个子任务派发后，插件会把 `task_create.goal` 同步成该子会话的平台 goal，并**立即 disarmed**——goal 只是持久目标状态，不会自动续跑。之后：

- `task_message` / 面板「追加」把消息并成「最新指示」，目标文本变化时 `edit`；
- 子任务 `done` 时 `complete`；停止、重派、会话丢失、失败时 `clear`；
- 面板列表显示「目标·进行中/已完成…」小标，详情抽屉有「目标状态」只读区块（阶段、续轮、轮次、修订）；
- 平台没有 goal 服务时静默降级，派发/续派/面板都不受影响。

目标文本只是持久状态，平台也不会把它注入系统提示或消息；子会话靠 `get_goal` 读（worker 预设挂了 `tool-goal`），也能用 `task_detail` 读创建时的目标快照。派发给子会话的 brief 是**纯指引**：只有【任务编号】+「先调 `task_detail` 读详情」，目标全文、验收、经验、前置任务、产物都不再内联到提示词。改目标请走 `task_message`，子会话的 `update_goal` 会被平台权限校验拒绝。边界见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md#目标g1)。

### 回合间续跑（keep-alive，默认关）

子会话回合结束后默认就结束这一段 activation，等结算或人工续派。`keepAlive: true` 时，插件订阅平台的 `agent/turn-stopping`，在回合边界（`agent.status` 仍为 `running`、还没 idle）同步投递下一条消息，让子会话**接着跑**：

- 只对「台账 `running` + 平台 goal 未完成（phase 不是 `complete` / `cleared`）」的任务注入；没有平台 goal 的任务不续跑；
- 默认 `keepAliveMode: 'steer'`（同一回合再走一步，不写 `turn/end`）；改成 `followup` 则是新回合；
- 轮数上限 `keepAliveMaxRounds`（默认 8，1–50）落台账 `tasks.keep_alive_rounds`，每次进入 `running`（重派/续派/冷恢复）归零，`task_status` 会显示「已注入 N 轮」；
- 停止条件：轮满、goal 已收口、任务不在 `running`（`task_stop` / S1 结算 / S2 对账都会让它离开 `running`）、回合被中断、只读任务、inbox 已有人排了下一轮、注入异常；
- 默认关闭：关着时监听器在查台账之前就返回，行为与旧版逐字一致。边界见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md#回合间-keep-alivek2)。

### 调试子会话（`orch-debug`）
想让子任务跑在「创造模式」的能力栈上（`cordis_*` 只读运行时洞察工具 + `dsh-doc` 技能 + `plugin_manager`）调试、更新 DSH 插件时：

```powershell
npm run preset:debug   # 把随包「创造模式」组合复制成可安装的 orch-debug 预设
node scripts/orch-debug-preset.mjs --check   # 升级 DSH 后先查：已生成的 bundle 还跟不跟得上随包组合
```

再用 `plugin_manager` 安装生成的 bundle，在插件配置里写 `workerPreset: orch-debug`，**彻底退出 DSH 再启动**。
安装步骤、与 `cordis` 的逐项对齐差异、插件更新流程（`plugin_manager` / client 热重载 / host HMR / 动态插件边界）与验证清单见
[docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)。

## 工具

协调者（10 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发；支持 `dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` |
| `task_list` | 活跃任务/历史任务；`group` 过滤看组进度 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、最近消息、子会话最新返回（`include: 'full'` 看全文） |
| `task_message` | 续派消息；排队/等前置任务返回提示 |
| `task_stop` | 停止任务（运行中/排队/等前置） |
| `task_retry` | 重建 failed/orphaned，保留编排字段 |
| `task_inbox` | 收件箱：待决、失败/丢失、长时间没动静 |
| `history_search` | 查插件记忆、历史任务、平台历史会话 |
| `project_context` | 只读项目白名单文件、顶层结构、最近任务、相关记忆 |
| `memory_note` | 记一条跨任务有效的决策/偏好/经验（写入即蒸馏为原子事实） |

子任务（2 个）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`；可带 `question` / `options` / `artifacts` |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物；只能读自己的任务，越权会被拒绝 |

12 个工具全局注册（worker 预设不做工具收窄，子会话直接继承）；`task_retry` / `task_inbox` / `history_search` / `project_context` / `memory_note` 仅主会话可调；`task_detail` / `task_report` 只对任务自己的子会话开放。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id` |
| `backend` | `subagent` | 派发后端；`team` 仅旧平台可用，rc.3 起会返回可读错误 |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / stall 提醒间隔 |
| `stallRounds` | `3` | 连续 progress 达阈值后提醒一次「可能卡住」 |
| `idleWatchdog` | `true` | 空闲看门狗：`running` 长时间无心跳/消息/状态变化时告警一次（只告警，不改状态、不 kill） |
| `watchdogIntervalMinutes` | `5` | 看门狗巡检间隔（1–1440 分钟） |
| `watchdogIdleMinutes` | `15` | 看门狗判空闲的阈值（1–1440 分钟；同一段空闲每任务只报一次，有活动后重置） |
| `keepAlive` | `false` | 回合间续跑：`agent/turn-stopping` 时给「`running` 且平台 goal 未完成」的子会话投递下一轮（不 idle、不结算）；默认关，需要 `ctx.goals` |
| `keepAliveMode` | `steer` | 续跑注入方式：`steer`（同一回合再走一步，不写 `turn/end`）/ `followup`（新回合） |
| `keepAliveMaxRounds` | `8` | 每段 activation 的续跑轮数上限（1–50；进入 `running` 时归零） |
| `keepAlivePrompt` | `''` | 覆盖默认续跑提示（空 = 内置提示；「第 N/M 轮」标记总在最前） |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `digestTimeZone` | `''` | 日报时区；空 = 系统时区 |
| `maxQueue` | `50` | `pending` + `waiting_dep` 安全阀 |
| `autoResumeQueue` | `true` | 重启后自动恢复排队任务 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |
| `memoryInject` | `true` | 新任务的经验注入：`task_create` 把命中的事实层记忆（`lesson`/`decision`/`preference`/`note`；`task-log` 不注入）写进 `lessons/` 记忆文件，`task_detail` 给出文件路径（brief 不再内联经验） |
| `memoryLimit` | `3` | 注入记忆条数（1–10） |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |

## 数据与日志

唯一写入在 `$DSH_HOME/state/orchestrator/`（未设置时 `~/.dsh`）：

```text
tasks.sqlite
snapshots/tasks-YYYY-MM-DD.sqlite   # 每天一份，保留 7 天
logs/YYYY-MM-DD.jsonl               # 按天，保留 7 天
lessons/<项目>-<short-hash>.md      # task_detail 里经验指针指向的记忆文件（每次派发覆盖为最新快照）
reports/<taskId>.md                 # 超 64 KiB 的子会话返回消息全文
workspace/                          # 「指挥舱」工作区
debug-presets/orch-debug/           # 可选：npm run preset:debug 生成的调试预设 bundle
```

- 日志覆盖建任务/拒绝原因/派发成败/回报/通知/清理；`goal`/`summary` 只留 80 字，不写 `user_verbatim`。
- 快照损坏时只给路径提示，**不自动恢复**；手工用快照替换台账。

## 架构与安全

- 协调者预设挂 `persona` / `agent-instructions` / `time-context` / `tool-ask-user` / `present` / `compaction` / `preset-tools`；执行层还有 guard 硬拦 `read`/`write`/`bash`/`wait_agent`/`task_report`/`task_detail` 等（`present` 不在黑名单，只声明交付、不读文件内容）。
- 子任务用 worker 预设，文件/shell/search/jobs/web/todo/skill/compaction/present + `tool-goal`（只读 `get_goal`，用来读自己的任务目标）；`task_report` / `task_detail` 是插件在全局注册的工具（预设不做 allow/deny 收窄，子会话直接继承），不含 delegation/plan/schedule；预设可用 `workerPreset` 换成副本（如 `orch-debug`）。
- `/api/orchestrator` 由 connection owner-only 鉴权；`snapshot`/`detail`/`artifacts`/`preview` 只读，`stop`/`retry`/`message` 是面板动作。
- 通知走 `agent.steer`，5 秒合并；每次投递写 `notifications`。

更细的机制、目标目录推断、沙箱与错误降级见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
面板/抽屉的布局、`--dsw-*` token 对照与交互清单见 [docs/UI.md](docs/UI.md)。

## 发版（维护者）

仓库带 GitHub Actions：

- `ci.yml`：push main / PR 跑测试。
- `release.yml`：推 `v*` tag 时跑测试并发布 npm（`NPM_TOKEN`，带 provenance）。

发布流程：

```powershell
npm version patch --no-git-tag-version
git add package.json
git commit -m "release: v0.11.0"
git tag -a v0.11.0 -m "v0.11.0"
git push origin main --follow-tags
```

要求仓库 Secrets 里有 `NPM_TOKEN`（npm Granular Token，Read and write，Bypass 2FA）。长期可换 npm Trusted Publishing（OIDC），不再存长期 token。

## 验收

1. 插件页能看到「任务编排」标题、图标和详情页。
2. 侧栏「主会话」能打开；工具表有 12 个工具；主会话里会话头有「☰ 任务」，切到子会话后该入口隐藏。
3. `task_create` 能派发；子会话 `task_report done` 后主会话收到通知。
4. 建 `dependsOn` 任务时先 `waiting_dep`，前置完成后自动派发。
5. 面板「详情」「产物」「停止/重派/追加」可用。
6. 面板三段式布局成立：顶栏指标卡可点、筛选轨有计数、点任务卡从右侧滑出详情抽屉（`Esc`/遮罩可关）；
   抽屉 7 个区块能折叠、有空态；宿主切深浅色时面板配色跟随（细节见 [docs/UI.md](docs/UI.md)）。

## 排障

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.11.0`；刷新页面；彻底重启 DSH |
| 会话头没有「☰ 任务」 | 该入口只在主会话显示：确认当前会话就是侧栏「主会话」打开的那个；没建主会话先从侧栏入口创建 |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页和日志 |
| 提示「尚未打开主会话」 | 面板点「打开主会话」 |
| 提示「team 后端不可用」 | `backend` 改回 `subagent` |
| 日志提示 `workerPreset` 回落 | 预设 id 只能用小写字母/数字/连字符；改值后彻底重启 |
| 子任务没有 `cordis_*` 工具 | 确认 `orch-debug` bundle 已装、`workerPreset: orch-debug`、已彻底重启；插件页看 `preset-orch-debug` 是否 broken（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制 |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |
| 台账损坏 | 用 `snapshots/` 最新快照手工替换 |

## 已知限制

- `writeScopes` 只做冲突提示；依赖关系创建后不可编辑；`dependsOn` 不允许指向未来 id。
- 产物在 done 时自动从 `workspaceChanges` 收集改动文件，并与显式 `task_report.artifacts` 按路径去重合并；Host 未挂 `workspaceChanges` 时只剩显式产物。
- 日报默认关闭；`stallRounds` 只提醒一次，没有二次升级阶梯。
- 空闲看门狗只告警：不改状态、不 kill、不重派；去重表在内存，插件重启后同一任务会再报一次。
- 结算自动收场只认「一次 activation」：续派/冷恢复起的轮次靠平台 `subagent/end` 观察；子会话只在「没上报过 progress」时自动判完成，上报过 progress 的回合结束落「会话丢失」等人决定。
- 主会话工具表可能仍残留团队工具（agent-scope 自注册，`restrict` 遮不到）；执行层 guard 会硬拦。
- 回合间 keep-alive 默认关闭，且只对「`running` + 平台 goal 未完成」的任务生效：它是宿主替子会话开工（每轮一次完整模型调用），不是成本控制，也不能阻止显式 stop / 模型报错。
- 平台 rc.3 子会话沙箱根、Bot 模式视图、headless 收尾竞态等平台侧限制，详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 开发

```bash
npm test                # node:test
npm run check:client    # client.js 语法
node docs/probes/api-probe.mjs
```

本地 link 安装（开发用）：在 profile 的 `package.json` 加

```json
"@wjj865-code/dsh-orchestrator": "link:C:/Users/72489/Documents/dsh-orchestrator"
```

并把 `@wjj865-code/dsh-orchestrator` 加入 `dsh.profile.bundles`，重启 profile。

## License

MIT
