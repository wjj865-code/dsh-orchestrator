# dsh-orchestrator

> **一句话定位**：给 DeepSeek Harness 加一位「协调者」——主会话只拆活、派子会话、看回报、交付产物；子会话在各自目标目录里把活干完，进度与结论落进持久台账，浏览器里有任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（当前 `0.24.0`）｜仓库：<https://github.com/wjj865-code/dsh-orchestrator>｜License：MIT
- Node `>= 22.15`（`engines`）｜DSH 兼容基线 **`0.2.2-rc.3` – `rc.5`**（CI 与真机实测在 `rc.3`，Web 表面为主，Desktop 同构）

**三分钟看懂**：装插件 → 打开「主会话」→ 用自然语言说需求（协调者拆成 `task_create` 派给子会话）→ 子会话回报「已交付待确认」→ 你看面板与产物，确认或追问。下面按这个顺序走一遍。

## 安装与升级

1. DSH → 插件 → **添加插件**，粘贴 `@wjj865-code/dsh-orchestrator@0.24.0`。
2. **彻底退出 DSH 再启动**（只关窗口、重开窗口都不生效）：宿主侧代码在 DSH 进程启动时加载，**刷新页面不会换版本**，装完还是旧行为就是没重启。
3. 自检：插件页有「任务编排」与详情页；侧栏「插件」下方有「◈ 主会话」；插件全局 **10 个工具**（协调者 7；子会话 4：`task_report` / `task_detail` / `plan_save` / 只读的 `context`）；派一条任务回报后主会话收到「已交付待确认」，`task_message({action:'close'})` 能收成「已完成」。
4. 升级 = 装新版 + 彻底重启。registry 包用插件页的更新入口；从 GitHub 装（`https://github.com/wjj865-code/dsh-orchestrator`）的先卸载旧版。旧包名 `dsh-orchestrator` 与新版不兼容，先移除。
5. `npm i @latest` 装到旧版 = 镜像还没同步（几十分钟到几小时）：过一会儿重装，或直接用上面的显式版本号。

从源码开发/自建见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)（仓库用 pnpm；检出后、尤其 **worktree 里第一步先 `pnpm install`**）。

## 三分钟跑通

### 1. 打开主会话

侧栏「◈ 主会话」或面板「打开主会话」。协调者预设只做协调：没有 `read`/`write`/`bash`，也不阻塞等待子任务；要看产物正文用受控的 `read_workspace`（只读，边界 = 主会话工作区 ∪ 任务登记过的产物）。新建主会话会自动介绍能力并派一个只读「工作区与仓库索引」任务，细节见 [ARCHITECTURE](docs/ARCHITECTURE.md#首次打开与工作区索引)。

### 2. 说需求 = 派单

用自然语言说需求即可，协调者会拆成 `task_create` 派给子会话（**能从记忆/上下文/已交付结论直接答的就不派**，只有需要新鲜取证、写文件或跨仓库证据时才派子会话）：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

有先后关系用 `dependsOn`，同一需求用 `group`，会改同一批文件用 `writeScopes`（与活跃未隔离任务重叠**默认拒绝**），紧急的给 `priority`。

**要机器验收就加 `checks`（可选）**：子会话报 `done` 时插件先在任务目录跑一遍检查，全过才落「待确认」，失败**拒绝交付**（任务保持进行中，回执带失败项、退出码与输出尾部）。

```js
task_create({ ..., target: '/abs/path/to/repo',
  checks: [{ name: '单测', command: ['pnpm', 'test'], timeoutMs: 300000 }] })
```

每条 `command` 是 **argv 数组**、按 argv 直接执行（不经 shell）、cwd 固定为任务 target 目录；最多 5 条，`timeoutMs` 1s–600s，`skipIfMissing` 让缺失命令记「跳过」而不是失败。检查跑在**插件宿主进程**（宿主权限，不是子会话沙箱），命令只能由协调者写进 `task_create`（`task_report` 没有命令参数）；没配 `checks` 的任务行为与以前完全一致。

### 3. 看进度

协调者不阻塞等待：`task_list` / `task_status` / `task_list({view:'inbox'})`，子任务完成会主动通知（`agent.steer` 注入，5 秒合并）。子会话用 `task_report` 回报：`progress` / `done` / `blocked`（等人决定）/ `needs_auth`（要授权）。

### 4. 交付、确认与追问（两段式）

子会话报 `done` **不等于**任务结束，而是落 **`delivered`（已交付待确认）**：

- **默认保持待确认、不主动关闭**：追问窗口留着，用户看完常还要改；协调者只在你说「确认 / 没问题 / 不用再改」或确实要收尾时 `task_message({ action: 'close' })`。
- **协调者不主动问「任务能不能关闭」**：交付后只汇报结果、产物与注意事项，不再用 `ask_user_question` 追问「确认 / 要改？」——任务保持待确认、等超时自然完成，比催你当场表态更省事；只在真需要拍板（方案歧义、范围/权限变更、不可逆操作、远端写授权）时才提问，且**必须用 `ask_user_question` 结构化提问**——带选项、别用纯文字问句（容易被忽略），多条合并成一条清单一次问完。
- 要改/补充：`task_message` **复用同一个子会话**，任务回到 `running`，完成后会再交付一次。
- 一直不确认：超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动收成 `done`（`close_reason=timeout`）。
- 面板「待你决定」与收件箱都包含 `delivered`，任务卡有「待确认」小标、交付时间与关闭原因。

### 5. 面板

会话头「任务」进入（**只在主会话显示**），DeepSeek 设计平台风格三段式：顶部命令栏（4 张指标卡，点击即切筛选）、中部工作区（筛选轨 + 任务卡列表 / 产物库）、右侧详情抽屉（概览、最新回复、Brief、验收、交接、目标状态、消息、依赖、产物）。

- 动作条：停止 / 确认交付 / 重派 / 打开子会话 / 删除（都带二次确认）；产物预览复用宿主右侧栏（Markdown / 代码 / 图片 / PDF / Office）。
- 面板**没有「追加消息」按钮**：续派与计划批准统一走协调者 `task_message`。
- 装了官方 Agent Teams 且 Team 模式开着时，任务列表上方多一块可折叠的「官方 Team（只读）」分区（行内没有按钮，认领/完成只能在官方 Team 里做）；Team 未开启或宿主没有该服务时**整块不显示**（不刷提示条），Team 开着但这一次没读到时才给一条降级提示。
- 颜色、圆角、阴影、动效全部取宿主 `--dsw-*` token，深浅色自动跟随；交互细节见 [ARCHITECTURE](docs/ARCHITECTURE.md#面板与详情ui-u2)。

## 工具清单

协调者（7 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发。`dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` / `planFirst` / `access`（`'full'`）/ `worktree*` / `allowConcurrent` / `checks`（交付前机器验收）/ `goalRounds`（续跑预算，默认 0 不续跑）/ `teamTaskId`（关联官方 Team 板，确认时按 CAS 反写 `complete`） |
| `task_list` | 活跃/历史任务（`active` / `group` 过滤）；`view:'inbox'` 是收件箱：待决、待确认、失败/丢失、长时间没动静 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、交付/关闭时间、验收（每条检查的退出码/耗时）、交接、目标状态与轮次（`x/y`）、官方 Team 关联、最近消息、最新返回（`include:'full'` 看全文） |
| `task_message` | 子任务动作统一入口：`action:'message'`（默认，续派/追问，复用原会话）/ `'resume'` 续跑失败·丢失（或超时完成）任务的原会话 / `'stop'` 停止 / `'retry'` 重派 failed·orphaned（新任务新会话）/ `'close'` 把「已交付待确认」确认成 `done` |
| `context` | 只读读上下文（协调者与子会话都能调）：`mode:'history'`（默认，记忆/历史任务/历史会话）/ `'project'`（项目白名单文件、结构、最近任务、相关记忆）/ `'workspaces'`（已登记工作区与仓库采样索引） |
| `memory_note` | 记一条跨任务有效的决策/经验（**仅主会话可写**：子会话工具表里没有它）；`kind:'preference'` 不传 `project` 时写进协调者偏好（每回合注入、立即生效） |
| `read_workspace` | 读产物正文：主会话工作区内文件/目录，或任务已登记产物；越界/`../`/符号链接逃逸/未登记均被拒；大文件按行窗口截断给续读 `offset` |

子任务（3 个，外加与协调者共用的只读 `context`）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`，可带 `question` / `options` / `artifacts`；`done` 落「已交付待确认」，配了 `checks` 的先跑验收、失败拒绝交付 |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收标准、可执行检查、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物 |
| `plan_save` | 计划模式专用：把计划正文写进主会话工作区 `reports/plans/<taskId>.md` 并登记为产物（计划阶段唯一写入口） |

- 10 个工具**全局注册**（`index.js` 的 `createTools(...).map(ctx.tools.register)`），角色差异全在**预设层**：协调者预设用 allow 补集只留 7 个；worker 预设用**遮挡式 deny** 只遮 `memory_note`（写记忆仍仅主会话），其余全局工具子会话都继承。所以 `context` 子会话也能调——**只读**、与协调者同一条实现（同参数输出逐字一致）；`task_report`/`task_detail`/`plan_save` 只对任务自己的子会话开放；`memory_note` 万一被别的 profile 露出，执行层会拒绝并给替代路径（写 `task_report` 的 summary / 用 `context` 只读查 / 请协调者记）。
- 派发给子会话的 **brief 是纯指引**（4 行，`access:'full'` 与隔离任务各多一行 → 4–6 行）：只给任务编号 +「先调 `task_detail`」+「执行中用 `blocked` 上报」+「交付时怎么回报」；目标、验收、经验、前置、产物都不内联进提示词，由子会话用 `task_detail` 现读。交付后协调者**不会**来问「确认 / 要改？」，任务保持待确认、等超时自动完成；用户要改时协调者用 `task_message` 回到同一个子会话。

### 工具迁移映射

P1-B 把工具面收缩到 10 个（协调者 12 → 7）。**旧名已删除**（不注册、不在 allow 名单里），照旧名调用会拿到一条可读迁移提示（「已删除 + 改成什么」），按这张表改一遍就能跑：

| 旧工具名 | 现在怎么调 | 备注 |
|---|---|---|
| `task_stop` | `task_message({ task_id, action: 'stop' })` | 停止任务，行为不变 |
| `task_retry` | `task_message({ task_id, action: 'retry' })` | 重派 failed/orphaned，新任务编号、旧任务留审计 |
| `task_close` | `task_message({ task_id, action: 'close' })` | 确认「已交付待确认」→ `done` |
| `task_inbox` | `task_list({ view: 'inbox' })` | 收件箱，输出与旧工具逐字一致 |
| `history_search` | `context({ mode: 'history', query, project?, limit? })` | 跨项目历史检索 |
| `project_context` | `context({ mode: 'project', target, query? })` | 项目背景；只要工作区与仓库索引用 `context({ mode: 'workspaces' })` |

## 配置

**两种改法，等价**：① 在**插件页**（侧栏「插件」→ dsh-orchestrator 页面里的「配置」卡片）改；② 直接编辑当前 profile 的 `cordis.patch.yml`（`id: orchestrator` 那一行的 `config`）。

| 要点 | 说明 |
|---|---|
| 保存位置 | **当前 profile** 的 `cordis.patch.yml`，不是插件目录 |
| 生效方式 | **重载插件或重启 DSH 后生效**：保存只把值写进当前 profile 的 `cordis.patch.yml`，运行中的插件不热重载（判定与计时器仍按启动时那份配置；台账在 SQLite 不受影响） |
| 优先级 | 表单写 profile 层；若 home patch 或命令行 overlay 覆盖同一字段，保存被**拒绝**并提示原因 |
| 非法值 | 一律**回落默认**，不会让插件起不来（schema 用 `.loose()` 兜底，运行时再由 `loadConfig` 二次归一化） |
| 可编辑范围 | 轮换的 8 个键（`mainRotation` + 7 个 `rotate*`）与其余字段都可编辑；**`coordinatorSession` 只读**（运维兜底通道，填错会让协调者指向不存在的会话，仅在运维场景手改 profile YAML）；不可逆动作仍由 `rotateArchiveOld` 显式控制（`false` = 只改名） |

字段规格的单一事实源是 [`src/config-fields.js`](src/config-fields.js)，schema 投影在 [`src/config-schema.js`](src/config-schema.js)，页面在 [`client/src/config-form.js`](client/src/config-form.js)——三处都只投影 `loadConfig()` 真实存在的键。

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id`（**页面只读**：运维兜底通道，仅手改 profile YAML；填错会让协调者指向不存在的会话） |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider（只支持 `spawn`） |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（生成器与说明已移出主包，见 [tools/debug-preset/README.md](tools/debug-preset/README.md)，不随 npm 包发货） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / 卡住提醒间隔 |
| `deliveredTimeoutMinutes` | `60` | 「已交付待确认」多久没确认就自动 `done`（1–1440） |
| `idleWatchdog` | `true` | 空闲看门狗，只告警 |
| `watchdogIntervalMinutes` | `5` | 看门狗巡检间隔（1–1440） |
| `watchdogIdleMinutes` | `15` | 判空闲阈值（1–1440） |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `digestTimeZone` | `''` | 日报时区；空 = 系统时区 |
| `maxQueue` | `50` | `pending` + `waiting_dep` 安全阀 |
| `autoResumeQueue` | `true` | 重启后自动恢复排队任务 |
| `memoryInject` | `true` | 新任务是否注入事实层记忆 |
| `memoryLimit` | `3` | 注入记忆条数（1–10） |
| `preferencesInject` | `true` | 是否把协调者偏好段（`settings.orchestrator_preferences`）注入 L1 提示词 |
| `preferencesMaxChars` | `1200` | 偏好段字数上限（条数上限固定 12 条，P2-2 起不可配） |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |
| `sameDirGuard` | `require` | 同写域并发防护：`require`（默认，拒绝）/ `warn`（只警告）/ `off`（关闭） |
| `worktreePolicy` | `auto` | `required` / `auto` / `off`；渲染进协调者 policy，漏传时兜底 |
| `worktreeBranchPrefix` | `orch/` | 隔离任务分支前缀（默认名 `<prefix><taskId>`） |
| `worktreeRecentDays` | `7` | 「近期活跃分支」窗口（1–90） |
| `mainRotation` | `auto` | 主会话轮换总开关：`auto`（默认，判定 + 动作）/ `off`（只检测不动作）；只有显式 `off` 才关，拼错保持默认 `auto` |
| `rotateAfterMainLogMiB` | `6` | 主会话日志体积 MiB（0.5–4096） |
| `rotateAfterDays` | `10` | 主会话运行天数（1–365） |
| `rotateCooldownHours` | `48` | 两次轮换之间的冷却期（1–720） |
| `rotateMinAgeHours` | `12` | 最小龄，防抖（1–720） |
| `rotateIdleMinutes` | `10` | 多久没交互才算「空下来」（1–1440） |
| `rotateCheckIntervalHours` | `24` | 打开主会话时最多多久做一次检查（采集 + 判定，1–168）；**检查节流 ≠ 轮换冷却**：冷却期内检查照做但不换 |
| `rotateArchiveOld` | `true` | 轮换后是否归档旧主会话（**不可逆**）；`false` = 只改名退役 |

> **配置面 41 → 35 → 28 → 29**：P1-A 删了 `backend` 与 5 个 `rotate*` 键；P2-2 又删了续跑四键（续跑改用 `task_create({ goalRounds })`）和三个固定成常量的阈值键；本批恢复 `rotateCheckIntervalHours`（检查节流，默认一天一次）。老 profile 里留着已删键也不影响加载——启动时各给一条弃用警告、按默认值运行；逐键迁移说明见 [CHANGELOG](CHANGELOG.md#02302026-11-19)。

## 核心概念

### 任务状态机：交付（`delivered`）≠ 完成（`done`）

| 状态 | 含义 | 谁推进 |
| --- | --- | --- |
| `waiting_dep` | 等前置完成，不派发、不占并发位 | 前置 `done` 后自动 → `pending` |
| `pending` | 排队等并发槽位 | 队列自动派发 → `running` |
| `running` | 子会话在跑 | 子会话回报 / 结算 |
| `waiting_user` | 子会话 `blocked`，等人决定 | `task_message` 续派 → `running` |
| `waiting_auth` | 子会话 `needs_auth`，等授权 | 同上 |
| **`delivered`** | **已交付待确认**：成果已落库，等确认或追问 | `close` → `done`；`task_message` → `running`；超时 → `done` |
| `done` | 已完成（**不可逆终态**，不提供 reopen；`close` 确认的不可续跑） | — |
| `failed` | 失败（可 `resume` 续跑原会话 / `retry` 新派） | `resume` → `running` |
| `cancelled` | 被 `stop` 停掉（尊重意图，不续跑） | — |
| `orphaned` | 会话丢了（上报过 progress 的回合异常结束；重启后常见） | `resume` 续跑 / `retry` 新派 |

- 依赖就绪**只认 `done`**：`delivered` 会短暂挡住下游，确认或超时后自动晋升。
- **能复用会话的三条收尾态各有出口**：`delivered` 用 `task_message` 追问；`failed`/`orphaned` 用 `resume` 冷恢复同一个子会话（上下文还在）；只有超时自动完成的 `done` 允许 `resume`——确认过的 `done` 要改只能新派。
- **`resume` vs `retry`**：`resume` = 同一任务同一子会话接着跑（失败/额度中断/重启中断的默认出口）；`retry` = 新任务编号 + 新子会话（上下文跑偏、换检出/权限、会话真的不可达时用）。会话不可达时 `resume` **报错回退**、不静默新建；历史消息 > 60 条只**建议** `retry`（长会话冷恢复可能更贵），不拦截。
- 状态集合与转移表只有一份（`src/status-facts.js`），面板、工具、结算、对账都从它派生。

### 依赖、分组、写域、优先级

- `dependsOn`：前置没完成 → `waiting_dep`；全部 `done` → 自动 `pending`；任一失败 → 下游自动 `failed`。创建后不可编辑，也不允许指向未来 id。
- `group`：分组，面板按组汇总进度（`task_list({ group })` 看「已完成/待确认」）。
- `writeScopes`：写域声明，与活跃未隔离任务重叠时默认拒绝创建（见下），**不是文件锁**。
- `priority`：`-10..10`，高的先派；同优先级按创建时间 FIFO。

### 同写域并发防护（默认拒绝，可显式放宽）

**这是行为变更**：以前同一个目标目录可以并发派多个任务（`writeScopes` 只打一行提示），两个子会话会同时写同一份工作树、互相覆盖。现在默认拒绝。

`task_create` 时，若新任务的目标目录与某个**活跃且未隔离**任务相同或互相包含（或两者 `writeScopes` 重叠），且新任务没有 worktree 隔离，默认**不创建任务**并返回可操作错误：

```
未创建任务：目标目录 /path/to/repo 与活跃任务相同或互相包含，且新任务没有 worktree 隔离——两个子会话会同时写同一份工作树。
冲突任务：「旧任务（t-1a2b3c4d）」（进行中）：/path/to/repo
三种做法（任选其一）：
1. 先 task_message({action:'close'}) 关闭旧任务（或 task_message({action:'stop'}) 取消），再重派；
2. 传 worktree:true 让新任务在独立检出里跑（推荐：两个任务可并行，合并由你决定）；
3. 确认确实要并发写同一目录时，显式传 allowConcurrent:true 放行（冲突风险自负）。
```

- **不算冲突**：不同 target、worktree 隔离任务、`dependsOn` 链上的前置、`readOnly` 只读任务、终态任务。`degraded`（不是 git 仓库而隔离降级）仍在原工作树里写，**照常占目录**；`planFirst` 计划任务照常参与判定；`delivered`（待确认）算活跃。
- **配置降级**：`sameDirGuard: 'warn'` 只给强警告照常创建，`'off'` 完全关闭。**默认 `'require'`**，非法值（含拼错）一律回落 `'require'`——默认必须安全。
- 被拒与放行都落日志：`task.create.rejected`（`reason: 'same-dir' | 'write-scope'`）与 `task.create.concurrent-write`。

### 派单选项一览

| 参数 | 作用 |
|---|---|
| `planFirst` | 计划任务：**只读沙箱（硬拦）+ plan-mode（软引导）**。`plan_save` 把计划写进 `reports/plans/<taskId>.md`（计划阶段唯一写入口），再 `blocked` 上报摘要 + 路径；**计划批准必须由用户拍板**（协调者转交摘要+路径并用 `ask_user_question` 请批准，**协调者不得自行批准**），你明确批准后才续派切回可写。与 `readOnly` 互斥 |
| `readOnly` | 只读任务：只认显式 `true`，续派也**不会**转可写 |
| `access: 'full'` | 这一条任务跑在 `danger-full-access`：沙箱不限制写入、`bash`/`pwsh` 解封。只接受 `'full'`，不继承、不改部署默认；与 `readOnly`/`planFirst` 互斥 |
| `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` / `worktreeCleanup` | 在 `<repo>/.agents/worktrees/<taskId>` 独立检出里干活，产物在分支上、**合并由你决定**；多活跃分支且没给基线时先返回候选让你选 |
| `goalRounds` | 1–50；`>0` 时交宿主 `dsh-goal-round-driver` 续跑，默认 0 = 不续跑（见下） |
| `teamTaskId` | 关联官方 Team 板任务；**人/协调者确认交付**时按 CAS 反写官方任务 `complete`（超时自动完成不反写） |
| `allowConcurrent` | 显式放行同写域并发（返回里标注风险并记日志） |

worktree 任务发到子会话的 brief 会多一行：检出目录没有依赖，可以执行安装命令（`pnpm install` / `npm install` / `uv sync`），**只安装不升级**。

计划任务的批准是**人工闸门**：子会话 `blocked` 后，协调者把计划摘要 + 文档路径转交给你，并用 `ask_user_question` 请你明确**批准 / 调整**（options 至少「批准执行 / 调整计划」）——**协调者不得自行批准**，不会自己判断「计划没问题」就直接续派。答「调整」：修改点原样转回同一子会话先出修订版计划（消息里会写明「只修订计划、不要开始实现」），再请你拍板；不回答就一直是「计划中」，协调者不续派、不代批。

### 交付口径：`present` 与 `read_workspace`

- 协调者不写文件、不执行命令（`write`/`edit`/`bash`/`pwsh`/`glob`/`grep` 与原生 `read` 都被拒），交付靠 `present`：默认展示 **1–4 个最关键的真实产物**（绝对路径），没有产物就不提。
- 看产物正文用 `read_workspace`：读**主会话工作区内**文件，或**任务登记过**的产物（子会话产物通常在 target 目录里，登记过就能读）。越界/`../`/符号链接逃逸/未登记都被拒，大文件按行窗口截断给 `nextOffset`。
- 存在性由插件与子任务保证（通知里的路径已 `lstat` 校验），`present` 只声明交付、不读内容。
- ⚠️ 若本机开了 IM 双向同步，读进上下文的正文可能随回复同步到外部且不可撤回——涉密产物不要用 `read_workspace` 读进主会话。

### 记忆与偏好

- **日志层**：`done` 摘要写进 `task-log`（一行一条），只归档、永不注入任务详情。
- **事实层**：摘要里的经验/教训分句蒸馏成 `lesson`，加上 `decision`/`preference`/`note` 原子事实，随 `task_create` 写进 `lessons/` 记忆文件、由 `task_detail` 给出路径；`memoryLimit` 控制注入条数。
- **检索**：`context({mode:'history'})` 查记忆/历史任务/历史会话，`context({mode:'project'})` 读项目白名单与最近任务。
- **子会话自己读**：`context` 对子会话开放（只读、同一条实现）；`task_detail` 只给本次命中的经验指针，想要更多历史/项目背景由子会话自己调 `context`——worker 预设 persona 写明「主动读，不要等协调者注入」。写记忆仍仅主会话（`memory_note` 不在子会话工具表里）。
- **偏好**：`memory_note({ kind:'preference' })` 不传 `project` 时写进协调者偏好（每回合注入、下一回合生效、不用重启）；带 `project` 的偏好仍是项目约定，写 `memories` 随 `task_detail` 注入。偏好只是提示词文本，**不能**放宽沙箱/审批/工具边界。

### 收件箱、日报与看门狗

- `task_list({view:'inbox'})` / 面板「待你决定」：待你决定、待确认（`delivered`）、失败/丢失、长时间没动静；`blocked`/`needs_auth` 可带 `question` + `options`。
- 日报默认关闭；配 `digestAt: '09:00'`（`digestTimeZone` 可选）后，打开主会话自动挂 schedule，到点汇总完成/在跑/待决定/失败/产物。
- 空闲看门狗默认开：`running` 长时间无心跳/消息/状态变化时告警一次，只告警、不改状态、不 kill。

### 主会话轮换：把长到拖不动的协调者换掉

主会话是唯一协调者，跑久了上下文变大、会话日志变长。轮换 = 把旧主会话退役、换一个干净的新会话接着当协调者——台账、任务、经验、产物都留在原处，只有「当前协调者是哪个会话」变了。

- **没有定时器、没有后台巡检、没有面板按钮**：判定只在**你打开主会话那一次**发生（`main-session.openOnce()`），且先过**检查节流**（默认一天最多查一次），只有该换才换。
- **检查节流（默认一天最多查一次，和轮换冷却不是一回事）**：每次检查都要读台账、`locate` + `stat` 主会话日志，随手一开就查浪费。所以判定前先看 `settings.main_rotation_checked_at`：距上次真正检查不足 `rotateCheckIntervalHours`（默认 24，区间 1–168）就**直接跳过采集与判定**——这次打开只剩一次 settings 读，日志里留一条 `main.rotation.check.skipped`。从没检查过（首次、或升级后第一次打开）视为需要检查；判定完成且结论是「不需要换」才记时间戳（需要换时不记：动作失败或进程崩了，下次打开还能重试）。三个时间参数各管一件事，别混：`rotateCheckIntervalHours` 管**查不查**；`rotateCooldownHours`（48h）与 `rotateMinAgeHours`（12h）管**换不换**（它们命中时检查照做、只是不换）。想回到「每次打开都检查」就把 `rotateCheckIntervalHours` 调成 `1`。
- **触发因子**（任一命中即「该换」）：主会话日志体积 `rotateAfterMainLogMiB`（默认 6 MiB）、运行天数 `rotateAfterDays`（默认 10 天）。
- **十二条保护**（任一命中就不换）：`mainRotation` 关闭、显式覆盖协调者、非 `spawn` provider、还有活跃任务、还有「已交付待确认」、待确认任务带未读产物、主会话正在跑回合、10 分钟内刚聊过、还有活跃子代理、未到最小龄（12h）、冷却期（48h）、指标全拿不到（fail-closed）。采不到的指标记「未知」，**不按 0 算**。
- **默认 `auto`（开启）**：跑久了会在你**下一次打开主会话**时换掉（判定照旧，12 条保护任一命中就不换）。不想换就配 `mainRotation: 'off'`——仍会检测（日志 `blockedBy: ['mode-off']`），但绝不动作；插件页配置卡片里也能直接关。`off` 也受检查节流约束（一天最多一次「为什么没换」的日志）。
- **风险**：归档**不可逆**（平台没有 unarchive；`rotateArchiveOld:false` 只改名）；换的是身份、**不搬历史**；只在打开时判定且默认一天最多查一次，重启/刷新都不触发；刚调低阈值又撞上「今天已经查过」时，把 `rotateCheckIntervalHours` 调成 `1`，或清掉 `settings.main_rotation_checked_at` 后再打开。
- 逐条边界见 [LIMITATIONS](docs/LIMITATIONS.md#主会话轮换g1)，时序与日志见 [ARCHITECTURE](docs/ARCHITECTURE.md#主会话轮换g1)。

### 主会话原生自动化

协调者预设挂载宿主 `@deepseek-ai/dsh-tool-schedule`，不另造调度器、不计入插件全局 10 个工具（契约核实于 DSH `0.2.2-rc.3`，升级宿主需复核）。

| 原生工具 | 用法 |
|---|---|
| `schedule_create` | 必填 `title` / `prompt` / `rrule` / `target` |
| `schedule_list` | `active?` / `limit?` / `offset?` 分页查询 |
| `schedule_view` | `id` 查看最新任务 |
| `schedule_edit` | `id` + `action:'update'|'delete'`；暂停 `active:false`、恢复 `active:true`；编辑携带最新 `updatedAt` 为 `expectedUpdatedAt`（可用时） |

- **Host-wide**：能看到并按 id 管理其他会话创建的任务；创建/修改/暂停/恢复/删除需用户**明确授权**，冲突 `schedule_conflict` 先重读、不强行覆盖。授权提示是模型行为约束，不是人工审批硬门禁。
- **本次自动编排只支持 `target:'this_session'`**：到期唤醒唯一主会话，按已授权 prompt 调 `task_list` 核对后再 `task_create`。`new` / `new_once` 仍是原生选项，但创建普通 root 会话、**非唯一主** id 无法直接 `task_create`，不提供第二协调者/转发桥。
- **默认 worker 不新增**自动化包；自定义 worker 即使有 schema，宿主仍返回 `subagent_session`。`access:full` 只改沙箱，**不增加工具**、不绕过委派校验或审批。
- Host 必须运行；投递成功不等于子任务完成，崩溃可能重复投递，删除不撤回已排队消息，不承诺 exactly-once。

### 可选能力：平台 goal 与续跑

平台有 `ctx.goals` 时，插件把子任务目标同步成子会话的**平台 goal**，并且是它唯一的写方（P2-2 起）：

- **默认不续跑（`goalRounds` 默认 0）**：派发后只 `create` + 立刻 `disarm`，goal 是只读镜子，与旧行为完全一致。`task_message` 把消息并成「最新指示」并 `edit`，确认完成时 `complete`，停止/重派/失败时 `clear`。
- **要续跑就按任务显式开**：`task_create({ goalRounds: 8 })`（1–50）。插件在 `create` 时带 `maxGoalRounds` 并**保持 armed**，之后由宿主 `dsh-goal-round-driver` 自动续轮，跑满预算就停；插件**不注入消息、不模拟续跑、也不持有轮次预算**（`task_status` 的「目标轮次 x/y」直接读平台 goal 的 `roundsStarted` / `maxGoalRounds`）。
- **降级**：平台没有 goal 服务、或旧宿主没接 driver 时，钩子静默 no-op / 记一条 `goal.degraded`，任务照常派发与结算，只是不会自动续跑。计划模式不接受 `goalRounds`（批准闸门不能被续轮绕过）。
- 子会话用 `get_goal` 读实时目标，`task_detail` 另有创建时的目标快照。

## 已知限制

**平台与沙箱**

- **委托子会话的审批固定 `never`**：子会话写被拒时**不会弹审批**，沙箱拒绝就是终局；要越过边界只能给单条任务 `access:'full'` 或换 CI/人工执行。
- **插件没有命令白名单**：隔离只在「沙箱模式 / 可写根」这一层，不对 `bash`/`pwsh` 的命令做 allow/deny；`danger-full-access` 下模型能跑任意命令，不做假安全。
- **构建 / 发版需要完整访问或 CI**：子会话默认写不进仓库外（Windows 上 `pwsh` 写 target 也受平台限制）。

**编排与视图**

- **同写域并发默认拒绝**（`sameDirGuard`，三条出路见上）；`dependsOn` 创建后不可编辑；**`done` 不可逆、无 reopen**——要改交付物用「待确认」追问，要新工作就新派/重派。
- **主会话轮换归档不可逆、且只在打开主会话时判定、默认一天最多查一次**（`mainRotation: 'off'` 可关、`rotateCheckIntervalHours` 可调）；判定是快照，动作前不复查。
- worktree 产物不在你的工作树里（合并由你决定）；计划文档只有一版、没有审批流 UI；面板轮询 2 秒、没有 SSE；产物预览依赖宿主右侧栏。
- 结算自动收场只覆盖「一次 activation」，上报过 progress 的回合异常结束落 `orphaned`。

完整清单（指标口径、崩溃恢复、平台服务缺失的降级、通知时序、面板动作幂等等）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.24.0`；**彻底退出 DSH 再启动**（刷新页面无效） |
| 插件页 / `npm i @latest` 装到旧版 | 镜像还没同步（新版本几十分钟到几小时）：过一会儿重装；急着用就换 `@wjj865-code/dsh-orchestrator@0.24.0` 显式版本；维护者侧可主动同步镜像（见 [CONTRIBUTING](docs/CONTRIBUTING.md#发版)） |
| 会话头没有「任务」入口 | 只在主会话显示：确认当前会话就是从侧栏「主会话」打开的；没建就点「打开主会话」 |
| 点产物「预览」没有右侧栏 | 宿主要装 `ui-sidebar-right` 与 `ui-sidebar-documentpreview`；缺了会提示原因，产物库那行退回面板内预览 |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页与 `logs/` |
| 子任务报 done 后一直「待确认」 | 正常：默认保持待确认；要收尾就 `task_message({action:'close'})`，或等 `deliveredTimeoutMinutes` 超时 |
| 任务停在「会话丢失」/「失败」 | 先用 `task_status` 看进展；要接着做就 `task_message({action:'resume'})`（同一个子会话冷恢复，上下文还在）；会话确实不可达或已跑偏才 `task_message({action:'retry'})` |
| 提示「配置键 X 已删除」 | 老 profile 里的已删键按提示删掉即可，插件已按默认值运行（迁移见 [CHANGELOG](CHANGELOG.md#02302026-11-19)） |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制；确实要写仓库外用 `access:'full'` 或 CI |
| 台账损坏 | 用 `snapshots/` 里最新快照手工替换（不会自动恢复） |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |
| 想马上换一次主会话 | 确认没被 `mainRotation: 'off'` 关掉（默认 `auto`），调低 `rotateAfterDays` / `rotateMinAgeHours` / `rotateCooldownHours` / `rotateIdleMinutes` / `rotateCheckIntervalHours`，收掉活跃任务后再打开主会话；今天已检查过就清掉 `settings.main_rotation_checked_at` |

排障细节（平台缺陷、时序竞态、已知降级）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 内部设计：模块划分、状态机、派发、结算、对账、验收、交接契约、官方板互通、面板与消息块、落盘 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 平台/沙箱/计划/worktree/通知/UI 的完整限制清单 |
| [docs/testing.md](docs/testing.md) | 测试与复核：怎么跑、门禁（含文档预算与面板体积闸门）、断言口径、历史复核索引、真机矩阵 |
| [docs/compat.md](docs/compat.md) | 宿主兼容基线（rc.3–rc.5）、10 类能力探测与降级、冒烟 3 条 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 开发、构建、发版与镜像同步（维护者） |
| [tools/debug-preset/README.md](tools/debug-preset/README.md) | `orch-debug` 调试预设的生成、安装/回退（开发仓库工具，不随包发货） |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本的变化与取舍 |

## License

MIT
