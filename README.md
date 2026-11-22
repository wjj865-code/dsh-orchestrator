# dsh-orchestrator

> **一句话定位**：给 DeepSeek Harness 加一位「协调者」——主会话只拆活、派子会话、看回报、交付产物；子会话在各自目录里把活干完，进度与结论落进持久台账，界面里有任务台。

- npm：`@wjj865-code/dsh-orchestrator`（当前 `0.32.0`）｜仓库：<https://github.com/wjj865-code/dsh-orchestrator>｜License：MIT
- Node `>= 22.15`｜DSH 兼容基线 **`0.2.2-rc.3` – `rc.5`**：`package.json` 的 `engines.dsh` 声明 `>=0.2.2-rc.3 <0.3.0-0`（`0.3.0` 连预览一起拒），区间外宿主**拒装 / 启动时禁用**（要越界跑只能给 profile 的 `compatibility.json` 精确豁免，见 [docs/compat.md](docs/compat.md#11-越界到底发生什么硬闸门不是-warn)）；主要在 **DeepSeek Harness Desktop** 上开发与使用，Web 同构
- 安装：插件页「添加插件」→ 粘贴 `@wjj865-code/dsh-orchestrator@0.32.0` → **彻底退出 DSH 再启动**

**三分钟看懂**：装插件 → 打开「主会话」→ 用自然语言说需求 → 协调者拆成子任务派给子会话 → 子会话回报「已交付待确认」→ 你看面板与产物，确认或追问。

## 适合什么、不适合什么

**适合**

- 一个需求要动多个文件、多个仓库，想让它在你视野外跑完，最后只看结论与产物；
- 同一件事有先后关系（先实现，再验收 / 发版），想建好就排队、前置完成自动接上；
- 想留一条可追溯的线：这条任务当时怎么做的、结论是什么、产物在哪；
- 想到点让协调者按你写好的话术核对后排任务（日报、周期性巡检）。

**不适合**

- 一句话问答、查个文档：直接问主会话更快，派子会话还多一轮；
- 需要边做边讨论、频繁改方向的探索：子会话是异步的，一来一回有成本；
- 完全无人值守的长跑：平台有并发上限，写被拒时不会弹审批，卡住要人看一眼。

## 安装与升级

1. DSH → 插件 → **添加插件**，粘贴 `@wjj865-code/dsh-orchestrator@0.32.0`。
2. **彻底退出 DSH 再启动**（只关窗口、重开窗口都不生效）：宿主侧代码在 DSH 进程启动时加载，**刷新页面不会换版本**；装完还是旧行为就是没重启。
3. 自检：插件页有「任务编排」；侧栏有「◈ 主会话」与「能力包」；插件全局 **11 个工具**；派一条任务并确认后，状态能从「已交付待确认」被收成「已完成」。
4. 升级 = 装新版 + 彻底重启。旧包名 `dsh-orchestrator` 与新版不兼容，先卸载。
5. 装到旧版、插件页还是旧文档 = registry 镜像还没同步（几十分钟到几小时）：过一会儿重装，或直接用上面的显式版本号。

从源码开发/自建见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)（仓库用 pnpm；检出后、尤其 worktree 里第一步先 `pnpm install`）。

## 三分钟上手

### 1. 打开主会话

侧栏「◈ 主会话」或面板「打开主会话」。它是**只读的总指挥**：能看单个文件、能派活，**不能写文件、不能执行命令**——所以权限徽标显示「Read Only / 仅可查看」，这是设计而不是故障。想批量检索或枚举目录，就派一条只读任务（`readOnly: true`），让子会话把结果带回来。

### 2. 说需求 = 派单

直接用自然语言说。协调者会判断：能从记忆 / 上下文 / 已交付结论直接答就答，需要新鲜取证或写文件才派子会话，例如「把报表的空数据文案改清楚，改完跑一遍测试」会变成：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

有先后关系用 `dependsOn`，同批需求用 `group`，会改同一批文件用 `writeScopes`，紧急的给 `priority`。

### 3. 看进度（不用守着）

协调者不阻塞等待：它用 `task_list` / `task_status` 看，子会话的回报会主动推给它（`progress` 也会送达，追问后的第一条必定立刻到）。你在面板里同样能看到「在跑 / 待确认 / 待你决定 / 失败 / 已完成」。

### 4. 确认交付（两段式）

子会话说「做完了」只是**交付**，任务落「已交付待确认」：默认保持待确认、不主动关闭，留给你看完再决定。

- 要继续改：直接说，协调者用 `task_message` 回到**同一个子会话**（上下文还在），改完再交付一次；
- 不用改：说一声就行，或者放着——超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动收成「已完成」；
- 「已完成」不可逆（没有 reopen）；要新工作就新派一条。

### 5. 任务台面板

会话头「任务」进入（只在主会话显示）。顶部导航切页：**总览 / 任务组 / 排期 / 自动化 / 复盘**；右侧 dock 是选中任务的只读镜像（摘要、最近消息、跳到子会话），**不代发消息、不代批计划**。把任务拖到日历只是「计划日」，不会自动派单；自动化是到点提醒协调者、由它核对后再派单。

## 核心功能

### 任务台：任务、任务组、排期、复盘

- 任务卡看状态、验收与产物；任务组按 `group` 汇总进度、待确认/在跑/失败数与产物数；日历把任务拖到某天做计划。
- 复盘页只看台账既有时间戳：窗口内交付数 / 确认数 / 平均「创建→交付」时长、失败归因（错误首行）、产物类型分布、组维度排行。
- 停止 / 重派 / 确认 / 删除都在面板上（都带二次确认）。**删除只删台账，不删盘**：产物文件与记忆都保留。

### 同写域并发防护（默认拒绝）

**这是行为变更**：以前同一目标目录能并发派多个任务，两个子会话会同时写同一份工作树、互相覆盖。现在 `task_create` 发现目标目录与某个活跃未隔离任务相同或互相包含（或 `writeScopes` 重叠）时，默认**不创建任务**并给三条出路：① 先 `task_message({ action: 'close' })` 或 `task_message({ action: 'stop' })` 旧任务再重派；② 传 `worktree:true` 让新任务在独立检出里跑（推荐，可并行）；③ 确实要并发写同一目录就显式传 `allowConcurrent:true`（风险自负）。档位由 `sameDirGuard` 控制：默认 `require`（拒绝），`warn` 只警告，`off` 关闭。

### 能力包：把一套技能 + CLI 打包成「新会话」

侧栏「能力包」→ 包卡 → 「用这个包开新会话」。内置包「公众号文章」：写作 → 排版（文颜渲染 HTML 预览）→ 建公众号草稿（**只建草稿，不是群发**）。外部 CLI 懒装进插件自己的目录（不写 PATH、不装全局、不碰 profile），装之前必须看确认卡（体积 / 耗时 / 包数）。凭据只走环境变量（`WECHAT_APP_ID` / `WECHAT_APP_SECRET`），插件**不落盘、不读值、不回显**；设置后要彻底重启 DSH。用户包由协调者用 `capability_pack` 先 dry-run 再确认创建。Desktop-only（Web 默认不启用）。

### 记忆与偏好

- 交付摘要里的经验与教训会被蒸馏成项目记忆；派新任务时按 `memoryLimit` 注入几条，子会话还能自己用只读 `context` 查历史与项目背景。
- 想让协调者长期按某条规矩办事：`memory_note({ kind: 'preference' })` 写进协调者偏好（每回合注入、下一回合生效，不用重启）。偏好只是提示词，**不会放宽沙箱、审批或工具边界**。

### 自动化：到点提醒协调者派单

到点由宿主 `schedule` 投递一条话术给**唯一主会话**，协调者先 `task_list` 核对再 `task_create`——不是定时器直接建任务。面板只有一个「创建自动化」按钮（对齐 DSH 官方「在会话中创建」）：点它会打开主会话并预填提示词，你在输入框补一句「做什么、什么时候」后发送，由协调者用官方 `schedule_create` 创建，**默认绑定主会话**；暂停 / 恢复 / 删除仍要二次确认并落审计日志，全部宿主任务也能在官方「自动化任务」页查看。宿主没有自动化服务时整页只读降级；投递成功不等于任务完成。

### 隔离与验收

- **worktree 隔离**（`worktree: true`）：在 `<repo>/.agents/worktrees/<taskId>` 的独立检出里干活，产物在分支上，**合并由你决定**。
- **只读任务**（`readOnly: true`）/ **计划任务**（`planFirst: true`）：前者只读；后者先只读调研、把计划写到 `reports/plans/<taskId>.md`（计划文档只由子会话自己写、插件原样落盘；待拍板问题也由它逐条列出），**计划批准必须由用户拍板，协调者不得自行批准**——它会用 `ask_user_question` 给你「逐项确认 / 均按推荐 / 先看计划文档 / 放弃」：选「逐项确认」就按待拍板清单一项一问、答完先给决策汇总再总批准核对；「均按推荐」必须你明确点选。
- **完整访问**（`access: 'full'`）：只对这一条任务解除沙箱写与命令限制；不继承、不改部署默认。
- **机器验收**（`checks`）：子会话报 `done` 时，插件先在任务目录按 argv 跑一遍检查，全过才落「待确认」，失败**拒绝交付**并回执失败项、退出码与输出尾部。

### 协作节奏：开工前确认、执行期少打扰、改动先评估

开工前按级别判一次：能直接答就答；单点、可回退的直接做；方案有歧义、会改你可见默认行为的先问一次；跨仓库 / 大改动 / 不可逆的先出一份计划。执行期只有四类堵塞项会打断你（验收不可达、要新授权、子会话报 `blocked` 要你定、事实查不到）。你改方向时它先给「影响面 / 风险 / 建议」三行，确认后才通知子任务。**任务链**（`dependsOn`）不占协调者回合：建好就排队，前置完成自动开始；前置「已交付待确认」不算完成，要推进就确认；同一 worktree 检出必须**串行**。

## 配置

两种改法等价：插件页 → dsh-orchestrator → 「配置」卡片；或直接编辑当前 profile 的 `cordis.patch.yml`（`id: orchestrator` 那一行的 `config`）。

| 要点 | 说明 |
|---|---|
| 保存位置 | 当前 profile 的 `cordis.patch.yml`，不是插件目录 |
| 生效方式 | **重载插件或重启 DSH 后生效**：运行中的插件不热重载，判定与计时器仍按启动时那份配置（台账在 SQLite，不受影响） |
| 非法值 | 一律回落默认，不会让插件起不来 |

常改的几项（完整 25 个键、默认值与区间见 [docs/CONFIG.md](docs/CONFIG.md)）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `deliveredTimeoutMinutes` | `60` | 「已交付待确认」多久没确认就自动完成（1–1440） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / 卡住提醒间隔 |
| `maxQueue` | `50` | 排队任务上限（安全阀） |
| `sameDirGuard` | `require` | 同写域并发防护：`require` 拒绝 / `warn` 警告 / `off` 关闭 |
| `worktreePolicy` | `auto` | 协调者漏传 `worktree` 时的兜底：`required` / `auto` / `off` |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `contextPressureThreshold` | `0.4` | 主会话上下文压力到该比例时提醒换会话（只提醒，不压缩） |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（见 [tools/debug-preset/README.md](tools/debug-preset/README.md)，不随包发货） |
| `capabilityPacks` | `true` | 能力包总开关：关掉后不注册内置包、工具返回停用、面板隐藏入口 |

老 profile 里留着已删除的键不影响加载，启动时各给一条弃用警告、按默认值运行；逐键迁移见 [docs/CONFIG.md](docs/CONFIG.md#已删除的键) 与 [CHANGELOG](CHANGELOG.md)。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装完还是旧版 / 侧栏没有「主会话」 | 没有彻底重启：**刷新页面不会换版本**，彻底退出 DSH 再启动。 |
| 插件页 / `npm i @latest` 装到旧版 | registry 镜像还没同步（几十分钟到几小时）：过一会儿重装，或显式装 `@wjj865-code/dsh-orchestrator@0.32.0`。 |
| 权限徽标显示「Read Only / 仅可查看」 | 正常：协调者就是只读总指挥（没有写与命令工具）。子任务仍是 `workspace-write`；要切走可以 `/permission`，下次打开主会话会被拉回。 |
| 插件加载失败 / 工具表没有 `task_*` | 看插件页报错与 `logs/`；确认是不是主会话之外发起的（`task_*` 只对协调者开放）；仍失败就彻底重启再试。 |
| 插件装不上 / 启动后完全不加载 | 宿主版本不在 `engines.dsh`（`>=0.2.2-rc.3 <0.3.0-0`）区间：宿主会在 pnpm 之前**拒装**、或在启动时打 `disabling profile plugin …` 并禁用该行。换匹配的插件/宿主版本；确实要越界跑就按 [docs/compat.md §1.1](docs/compat.md#11-越界到底发生什么硬闸门不是-warn) 给 `compatibility.json` 精确豁免（`dsh plugin allow-version`）。 |
| 会话头没有「任务」入口 | 它只在主会话显示：确认当前会话是从侧栏「主会话」打开的。 |
| 子任务报完 done 后一直「待确认」 | 正常：默认保持待确认。要收尾用 `task_message({ action: 'close' })`，或等 `deliveredTimeoutMinutes` 超时。 |
| 任务停在「会话丢失 / 失败」 | 先用 `task_status` 看原因；接着做用 `task_message({ action: 'resume' })`（同一子会话冷恢复），会话确实不可达才 `retry`。 |
| 能力包装 CLI 很慢 | 冷装实测 259 个包 / ≈184 MiB / ≈4 分 04 秒（热装 ≈14 秒），是 npm 安装本身，不是插件卡住；失败会在确认卡里给原因，可重试。 |
| 侧栏没有「能力包」 | 确认 0.32.0 + Desktop 宿主；检查 `capabilityPacks` / `capabilityPacksPanel` 没被关（Web 默认不启用，见 `capabilityPacksAllowOnWeb`），改完彻底重启。 |
| 想换一个协调者会话 | 会话头「设为协调者」；或等上下文压力问题卡出现时点「新建协调者会话」（只切指针，旧会话不改名、不归档）。 |

## 安全与边界（必读）

- **协调者是只读的**：没有写工具、没有命令工具；钉 `read-only` 是「钉」不是「锁」，`/permission` 仍能切走，插件只在下次打开主会话时拉回。审批对子会话固定 `never`：写被拒不会弹窗，要越过边界只能给单条任务 `access: 'full'`。
- **`read` 能读全盘**：凭据类文件（`~/.dsh/.credentials.yaml`、`.env`、SSH key、token）任何情况下都不读、不转述——这是提示词约束，不是路径黑名单。
- **IM 外发风险**：开了 IM 双向同步时，读进主会话的正文可能随回复同步到外部且不可撤回——涉密内容不要读进主会话。
- **Desktop 为主**：主要在 DeepSeek Harness Desktop 上使用，Web 同构；能力包 Desktop-only。
- 更多边界（平台沙箱、worktree、通知时序、UI 降级、踩坑）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 从旧版本升级：工具迁移映射

旧工具名**已删除**（不注册），照旧名调用会拿到一条可读迁移提示，按这张表改一遍就能跑：

| 旧工具名 | 现在怎么调 | 备注 |
|---|---|---|
| `task_stop` | `task_message({ task_id, action: 'stop' })` | 停止任务，行为不变 |
| `task_retry` | `task_message({ task_id, action: 'retry' })` | 重派 failed/orphaned，新任务编号、旧任务留审计 |
| `task_close` | `task_message({ task_id, action: 'close' })` | 确认「已交付待确认」→ `done` |
| `task_inbox` | `task_list({ view: 'inbox' })` | 收件箱，输出与旧工具逐字一致 |
| `history_search` | `context({ mode: 'history', query, project?, limit? })` | 跨项目历史检索 |
| `project_context` | `context({ mode: 'project', target, query? })` | 项目背景；工作区与仓库索引传 `context({ mode: 'workspaces' })` |

## 深入了解

| 文档 | 内容 |
|---|---|
| [docs/CONFIG.md](docs/CONFIG.md) | 全部配置键、默认值、保存与生效语义 |
| [docs/TOOLS.md](docs/TOOLS.md) | 11 个工具的完整清单、角色差异、只读工具与技能 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 内部设计：状态机、队列与依赖、派发与结算、验收、面板与落盘 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 完整边界与已知限制（平台、沙箱、计划、worktree、通知、UI） |
| [docs/testing.md](docs/testing.md) | 测试与复核：怎么跑、门禁、断言口径 |
| [docs/compat.md](docs/compat.md) | 宿主兼容基线、能力探测与降级 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 开发、构建、发版与镜像同步（维护者） |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本的变化与取舍 |

## License

MIT
