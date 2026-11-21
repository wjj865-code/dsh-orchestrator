# dsh-orchestrator

> **一句话定位**：给 DeepSeek Harness 加一位「协调者」——主会话只拆活、派子会话、看回报、交付产物；子会话在各自目标目录里把活干完，进度与结论落进持久台账，浏览器里有任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（当前 `0.26.0`）｜仓库：<https://github.com/wjj865-code/dsh-orchestrator>｜License：MIT
- Node `>= 22.15`（`engines`）｜DSH 兼容基线 **`0.2.2-rc.3` – `rc.5`**（CI 与真机实测在 `rc.3`，Web 表面为主，Desktop 同构）

**三分钟看懂**：装插件 → 打开「主会话」→ 用自然语言说需求（协调者拆成 `task_create` 派给子会话）→ 子会话回报「已交付待确认」→ 你看面板与产物，确认或追问。下面按这个顺序走一遍。

## 安装与升级

1. DSH → 插件 → **添加插件**，粘贴 `@wjj865-code/dsh-orchestrator@0.26.0`。
2. **彻底退出 DSH 再启动**（只关窗口、重开窗口都不生效）：宿主侧代码在 DSH 进程启动时加载，**刷新页面不会换版本**，装完还是旧行为就是没重启。
3. 自检：插件页有「任务编排」与详情页；侧栏「插件」下方有「◈ 主会话」；插件全局 **10 个工具**（协调者能用其中 7 个；子会话 4：`task_report` / `task_detail` / `plan_save` / 只读的 `context`），协调者另外挂宿主原生的只读工具 `read` / `glob` / `grep` 与技能加载器 `skill`；派一条任务回报后主会话收到「已交付待确认」，`task_message({action:'close'})` 能收成「已完成」。
4. 升级 = 装新版 + 彻底重启。registry 包用插件页的更新入口；从 GitHub 装（`https://github.com/wjj865-code/dsh-orchestrator`）的先卸载旧版。旧包名 `dsh-orchestrator` 与新版不兼容，先移除。
5. `npm i @latest` 装到旧版 = 镜像还没同步（几十分钟到几小时）：过一会儿重装，或直接用上面的显式版本号。

从源码开发/自建见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)（仓库用 pnpm；检出后、尤其 **worktree 里第一步先 `pnpm install`**）。

## 三分钟跑通

### 1. 打开主会话

侧栏「◈ 主会话」或面板「打开主会话」。协调者预设只做协调：**没有** `write`/`edit`/`bash`/`pwsh`，也不阻塞等待子任务；但可以**只读看文件**——原生 `read` / `glob` / `grep`（0.26.0 起挂上，用来核对子会话的改动、读 target 与技能文件）加上受控的 `read_workspace`（边界 = 主会话工作区 ∪ 任务登记过的产物）。宿主导航工具 `working_directory` **不在**协调者工具表里（协调者 cwd 是指挥锚：子会话默认继承目录、记忆项目键都以它为准；看文件直接用绝对路径即可）。看产物正文、交付产物仍走 `read_workspace` 与 `present`。新建主会话会自动介绍能力并派一个只读「工作区与仓库索引」任务，细节见 [ARCHITECTURE](docs/ARCHITECTURE.md#首次打开与工作区索引)。

**权限徽标**：协调者会话的权限预设会被显式钉成宿主的 **`read-only`**（沙箱只读 + 审批 ask），输入区徽标显示「Read Only / 仅可查看」——与「协调者只读」的实际工具面一致（读有 `read`/`glob`/`grep`/`read_workspace`，写没有任何工具，沙箱也一律拒写；0.25.1 起钉、0.26.0 起工具面与之一致）。普通任务子会话仍是 `workspace-write`，照常写文件。钉不是锁：`/permission` 或输入区选择器仍可切走（宿主没有锁权限选择器的 API），下次「打开主会话」/协调者重新加载时拉回，边界见 [LIMITATIONS](docs/LIMITATIONS.md#主会话权限徽标0251)。

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

协调者不阻塞等待：`task_list` / `task_status` / `task_list({view:'inbox'})`，子任务的回报会主动通知（`agent.steer` 注入）。`done` / `blocked` / `needs_auth` 照旧（5 秒合并、要拍板的立即打断）；`progress` 也会送达（5 秒合并 + 同任务 60 秒水位，只留最新一条），**追问或续跑后的第一条必定立刻送到**——所以「先给部分结论再继续跑」不会再石沉大海。子会话用 `task_report` 回报：`progress` / `done` / `blocked`（等人决定）/ `needs_auth`（要授权）。

### 4. 交付、确认与追问（两段式）

子会话报 `done` **不等于**任务结束，而是落 **`delivered`（已交付待确认）**：

- **默认保持待确认、不主动关闭**：追问窗口留着，用户看完常还要改；协调者只在你说「确认 / 没问题 / 不用再改」或确实要收尾时 `task_message({ action: 'close' })`。
- **协调者不主动问「任务能不能关闭」**：交付后只汇报结果、产物与注意事项，不再用 `ask_user_question` 追问「确认 / 要改？」——任务保持待确认、等超时自然完成，比催你当场表态更省事；只在真需要拍板（方案歧义、范围/权限变更、不可逆操作、远端写授权）时才提问，且**必须用 `ask_user_question` 结构化提问**——带选项、别用纯文字问句（容易被忽略），多条合并成一条清单一次问完（开工前的意图确认与追加调整的评估确认同样走结构化提问，见下面「协作节奏」）。
- 要改/补充：`task_message` **复用同一个子会话**，任务回到 `running`，完成后会再交付一次。
- 一直不确认：超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动收成 `done`（`close_reason=timeout`）。
- 面板「待你决定」与收件箱都包含 `delivered`，任务卡有「待确认」小标、交付时间与关闭原因。

### 5. 面板：任务台工作台

**入口**：会话头「任务」进入（**只在主会话显示**，闸门不变）；面板仍注册在宿主原来的 `main` 槽位（`key='orchestrator'`），**不新增第二个面板入口**。侧栏「主会话」条目与「打开主会话」按钮也不变。工作台内部用顶部导航切页，页面与选中的组会记在 `sessionStorage`，预览产物卸载面板后回来仍停在同一页。

**五页**（组工作台是「任务组」的子页；第六页「复盘」属阶段 3，本版未实现）：

- **总览**：4 张指标卡（点击即切筛选）、今日排期、下一条自动化、待你决定提示、任务卡列表 / 产物库（沿用改版前的列表与筛选，行为不变）。
- **任务组**：按 `task_create({ group })` 聚合，组卡显示进度、待确认/在跑/失败计数、产物数、下次排期与自动化小标；没有 group 的任务单独一张「未分组」卡（不落库、不可改名）。组名可改，**组键（`tasks.group_id`）不可变**——worktree 检出复用与 `task_list({ group })` 都按它判定。
- **组工作台**：状态列板（等前置/待派发、在跑、待确认、待你决定、完成、失败·取消）+ 右侧 dock + 详情抽屉 + 产物格（预览 / 右侧栏 / 复制路径）。列板只做筛选，**不支持拖拽改状态**（状态机只能由既有面板动作或协调者推进）。
- **排期**：月历（周一起始）拖任务到某天即排期，拖回「待排期」取消；另有任务卡里的「排期」按钮（键盘/触屏可用，不依赖拖拽）。
- **运行与自动化**（导航里显示「自动化」）：到点由宿主 `schedule` 投递一条话术给**唯一主会话**，协调者按话术 `task_list` 核对后再 `task_create`——不是定时器直接建任务。新建/暂停/恢复/删除都要二次确认 + 授权勾选，落审计日志；宿主没有自动化服务时整页只读降级。投递成功 ≠ 任务完成，平台崩溃可能重复投递（不承诺 exactly-once）。

**右侧 dock 的边界**：它是选中任务/组的**只读镜像**（摘要、最近消息、阻塞问题、`打开子会话` 与 `到主会话说` 两个跳转）。dock 里没有输入框、没有发送按钮、没有「批准计划」——**不代发消息、不代批计划**；追问与计划批准仍只走协调者的 `task_message` 与提问卡。

**排期的两层（互不推导）**：

| 层 | 是什么 | 落库 | 谁会写 |
|---|---|---|---|
| L1 计划日 | 你打算哪天做（纯展示） | `tasks.planned_at` | 面板拖拽 / 「排期」按钮（`plan-set`） |
| L2 自动化触发 | 到点让协调者按话术核对后派单 | `automations` 表（镜像 + 授权审计）+ 宿主 `ctx.schedule` 真身 | 面板「自动化」页（`automation-*`，要授权确认） |

日历上排一天**不会**自动派任务，创建自动化也**不会**改计划日——否则「拖一下」就成了隐性授权。

**工作台的边界（刻意不做）**：不提供「新任务」直写台账（只生成派单草稿让你交给协调者）、不提供计划批准按钮、dock 不能发消息、没有批量确认交付。

**体积口径**：面板产物 `dist/client.js` 由 `scripts/check-client-size.mjs` 卡在 **148 KiB**（工作台 v1 由 95 KiB 抬上来：先定 128 KiB、全功能实测 143–146 KiB 不够，用户拍板保留全功能；子预算表在脚本头部，合计 = 148）。平台只 serve 一个 `client.js`，**没有代码分割**，所以「懒加载」只能做到数据分片（组/日历/自动化独立端点、15s 分频、页面不可见时停表）与视图延迟挂载。

- 面板风格仍沿用设计平台三段式语言：顶部命令栏、中部工作区、右侧详情抽屉（概览、最新回复、Brief、验收、交接、目标状态、消息、依赖、产物）。动作条：停止 / 确认交付 / 重派 / 打开子会话 / 删除（都带二次确认）；产物预览复用宿主右侧栏。
- 面板**没有「追加消息」按钮**：续派与计划批准统一走协调者 `task_message`。
- 装了官方 Agent Teams 且 Team 模式开着时，任务列表上方多一块可折叠的「官方 Team（只读）」分区（行内没有按钮，认领/完成只能在官方 Team 里做）；Team 未开启或宿主没有该服务时**整块不显示**（不刷提示条），Team 开着但这一次没读到时才给一条降级提示。
- 颜色、圆角、阴影、动效全部取宿主 `--dsw-*` token，深浅色自动跟随；交互细节见 [ARCHITECTURE](docs/ARCHITECTURE.md#面板与详情ui-u2)。

### 6. 协作节奏：开工前确认、执行期少打扰、改动先评估

协调者的提问只发生在**三个入口**，其余时间不打扰：

- **开工前按级别确认**：T0 能直接答就答；T1（单点、可回退、不动用户数据、不碰远端）直接做，回复里先写一句「我的理解：…」；T2（需求给的是现象、可行方案代价不同、会改你可见的默认行为、目标或验收有歧义）先只读调研，再用 `ask_user_question` 问一次（2–4 个选项、每项带建议）；T3（跨仓库/跨工作区、动 5 个以上文件、重构迁移、不可逆、要推远端或发布、要写仓库外）先 `task_create({ planFirst: true })` 出计划，你拍板后才实现。判级只做一次，同一需求后续轮次沿用。
- **执行期只报堵塞项**：已确认的验收/范围/方案不可达、需要新授权（权限/远端写/发布/删数据/不可逆）、子会话报 `blocked` 且选项要你定、事实在协调者工具面外查不到——只有这四类会打断你；进度、能否关闭、命名/文案这类细节不打扰，协调者给了建议就按建议继续（要新授权与计划批准除外，必须等明确答复）。
- **改动先评估**：你追加调整时，协调者先给「影响面 / 风险 / 建议」三行，再按影响分档：

| 档 | 影响 | 动作 |
|---|---|---|
| R0 | 只补细节，不动验收与已交付结论 | 直接 `task_message` 转给原会话，下一条汇报里写清改了哪里（不问你） |
| R1 | 动到验收/范围/方案 | 先给评估 + `ask_user_question` 拿确认 |
| R2 | 不可逆、权限、推翻已交付结论、换 target 或仓库 | 必须拍板；不可逆项先等授权 |

顺序不能换：**先评估 → 再确认 → 最后才通知子任务**（计划中的任务收到追加消息即视为批准、沙箱当场切回可写）。

## 工具清单

协调者（插件工具 7 个；另有宿主原生的只读 `read` / `glob` / `grep` 与 `skill`，见下面「技能与只读工具」）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发。`dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` / `planFirst` / `access`（`'full'`）/ `worktree*` / `allowConcurrent` / `checks`（交付前机器验收）/ `goalRounds`（续跑预算，默认 0 不续跑）/ `teamTaskId`（关联官方 Team 板，确认时按 CAS 反写 `complete`） |
| `task_list` | 活跃/历史任务（`active` / `group` 过滤）；`view:'inbox'` 是收件箱：待决、待确认、失败/丢失、长时间没动静 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、交付/关闭时间、验收（每条检查的退出码/耗时）、交接、目标状态与轮次（`x/y`）、官方 Team 关联、最近消息、最新返回（`include:'full'` 看全文） |
| `task_message` | 子任务动作统一入口：`action:'message'`（默认，续派/追问，复用原会话）/ `'resume'` 续跑失败·丢失（或超时完成）任务的原会话 / `'stop'` 停止 / `'retry'` 重派 failed·orphaned（新任务新会话）/ `'close'` 把「已交付待确认」确认成 `done` |
| `context` | 只读读上下文（协调者与子会话都能调）：`mode:'history'`（默认，记忆/历史任务/历史会话；首行【检索范围】，查项目记忆要传 `project`）/ `'project'`（项目白名单文件含 `docs/ARCHITECTURE.md`、结构、最近任务、相关记忆）/ `'workspaces'`（已登记工作区与仓库采样索引） |
| `memory_note` | 记一条跨任务有效的决策/经验（**仅主会话可写**：子会话工具表里没有它）；`kind:'preference'` 不传 `project` 时写进协调者偏好（每回合注入、立即生效） |
| `read_workspace` | 读产物正文：主会话工作区内文件/目录，或任务已登记产物；越界/`../`/符号链接逃逸/未登记均被拒；大文件按行窗口截断给续读 `offset` |

子任务（3 个，外加与协调者共用的只读 `context`）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`，可带 `question` / `options` / `artifacts`；`done` 落「已交付待确认」，配了 `checks` 的先跑验收、失败拒绝交付；`progress` 会作为进度信号送达（合并 + 同任务水位，追问后的第一条必达） |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收标准、可执行检查、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物 |
| `plan_save` | 计划模式专用：把计划正文写进主会话工作区 `reports/plans/<taskId>.md` 并登记为产物（计划阶段唯一写入口） |

- 10 个工具**全局注册**（`index.js` 的 `createTools(...).map(ctx.tools.register)`），角色差异全在**预设层**（两个预设都是**遮挡式 deny + keep**）：协调者预设遮「编排正确性」项（`wait_agent`、团队工具、`plugin_manager`、密钥/IM）与三个子会话专属工具，并用 `keep` 声明 7 个任务工具出生即可用；worker 预设只遮 `memory_note`（写记忆仍仅主会话），其余全局工具子会话都继承。所以 `context` 子会话也能调——**只读**、与协调者同一条实现（同参数输出逐字一致）；`task_report`/`task_detail`/`plan_save` 只对任务自己的子会话开放；`memory_note` 万一被别的 profile 露出，执行层会拒绝并给替代路径（写 `task_report` 的 summary / 用 `context` 只读查 / 请协调者记）。
- 派发给子会话的 **brief 是纯指引**（4 行，`access:'full'` 与隔离任务各多一行 → 4–6 行）：只给任务编号 +「先调 `task_detail`」+「执行中用 `blocked` 上报」+「交付时怎么回报」；目标、验收、经验、前置、产物都不内联进提示词，由子会话用 `task_detail` 现读。交付后协调者**不会**来问「确认 / 要改？」，任务保持待确认、等超时自动完成；用户要改时协调者用 `task_message` 回到同一个子会话。

### 技能与只读工具（0.26.0）

- **`read` / `glob` / `grep`（只读，协调者预设挂 `tool-fs` + `tool-fs-search`）**：核对子会话说的改动、看 target 目录、读插件安装目录里的技能与文档都可以，不必为此新派任务。`tool-fs` 只开 `read`（`write` / `edit` / `apply_patch` / `read_image` 全关），所以协调者工具表里**没有任何写工具**；写路径由钉死的 `read-only` 权限预设（沙箱写全拒）兜底。它们**没有产物边界、能读到全盘**——凭据类文件（`~/.dsh/.credentials.yaml`、`.env`、SSH key、token）一律不读、不转述，风险见 [LIMITATIONS](docs/LIMITATIONS.md#协调者读文件read-glob-grep)。
- **`skill` + grill-me 技能**：插件随包发 `skills/grill-me/SKILL.md`（`files` 含 `skills/`），注册模块 `@wjj865-code/dsh-orchestrator/skill-grill-me` 在**协调者预设作用域**里调 `ctx.skills.register`，所以只有协调者看得到、子会话看不到。技能内容是多轮**前沿提问**的澄清协议：一次只问一个决定性问题、每问带我的推荐、事实我自己查、决策归用户、最多 **2 轮 8 问**、最后给一张「决策点｜你定的｜影响」三栏决策记录，与 T2/T3 闸门衔接。**grill ≠ 批准**：澄清完仍要按闸门确认，T3 的计划批准只能由用户拍板。协议灵感来自 Matt Pocock 的 grilling（MIT），措辞重写。
- **不挂 `working_directory`**（0.26.0 发版前真机复验补漏）：这个宿主全局工具会把**协调者会话的 cwd** 改掉，而 cwd 是指挥锚——`task_create` 不给 `target` 时子会话继承它、工作区/写域判定与记忆项目键推断都以它为准，会话内切目录会让这些锚点静默漂移。所以协调者预设的 `preset-tools` `deny` 与执行层 `COORDINATOR_DENY` 两处都遮（工具表里看不到、硬调被拒）；协调者看文件用 `read`/`glob`/`grep` 的绝对路径，不需要切目录。

### 工具迁移映射

P1-B 把工具面收缩到 10 个（协调者 12 → 7）。**旧名已删除**（不注册、不在 keep 名单里），照旧名调用会拿到一条可读迁移提示（「已删除 + 改成什么」），按这张表改一遍就能跑：

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
| 可编辑范围 | 除 `coordinatorSession` 外全部可编辑（含 `contextPressureThreshold`）；**`coordinatorSession` 只读**（运维兜底通道，填错会让协调者指向不存在的会话，仅在运维场景手改 profile YAML） |

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
| `contextPressureThreshold` | `0.4` | **插件自己的提醒阈值**（0.1–0.95）：主会话最近一次请求 prompt 占上下文窗口的比例达到它时，插件弹一张问题卡问「要不要换新协调者会话」。**与宿主 compaction-basic 的 thresholdRatio（0.8）无关**，改它不会改变宿主压缩行为、也不影响子会话；插件只提醒、不压缩、不自动切换 |

> **配置面 41 → 35 → 28 → 29 → 22**：P1-A 删了 `backend` 与 5 个 `rotate*` 键；P2-2 又删了续跑四键（续跑改用 `task_create({ goalRounds })`）和三个固定成常量的阈值键；**0.25.0 删掉轮换的 8 个键（`mainRotation` + 7 个 `rotate*`），只留插件自己的提醒阈值 `contextPressureThreshold`**。老 profile 里留着已删键也不影响加载——启动时各给一条弃用警告、按默认值运行；逐键迁移说明见 [CHANGELOG](CHANGELOG.md#02302026-11-19)。

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
| `planFirst` | 计划任务：**只读沙箱（硬拦）+ plan-mode（软引导）**，四步顺序固定：①子会话只读探索 → ②`plan_save` 把计划落盘到 `reports/plans/<taskId>.md`（计划阶段唯一写入口）→ ③`blocked` 只上报摘要 + **绝对路径** + 待拍板清单 → ④协调者**先**把摘要与绝对路径回给你并 `present` 计划文档，**再**用 `ask_user_question` 请拍板（选项至少「批准执行 / 先看计划文档 / 调整计划」）；**计划批准必须由用户拍板、协调者不得自行批准**，只有你明确批准才 `task_message` 续派并切回可写。与 `readOnly` 互斥 |
| `readOnly` | 只读任务：只认显式 `true`，续派也**不会**转可写 |
| `access: 'full'` | 这一条任务跑在 `danger-full-access`：沙箱不限制写入、`bash`/`pwsh` 解封。只接受 `'full'`，不继承、不改部署默认；与 `readOnly`/`planFirst` 互斥 |
| `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` / `worktreeCleanup` | 在 `<repo>/.agents/worktrees/<taskId>` 独立检出里干活，产物在分支上、**合并由你决定**；多活跃分支且没给基线时先返回候选让你选 |
| `goalRounds` | 1–50；`>0` 时交宿主 `dsh-goal-round-driver` 续跑，默认 0 = 不续跑（见下） |
| `teamTaskId` | 关联官方 Team 板任务；**人/协调者确认交付**时按 CAS 反写官方任务 `complete`（超时自动完成不反写） |
| `allowConcurrent` | 显式放行同写域并发（返回里标注风险并记日志） |

worktree 任务发到子会话的 brief 会多一行：检出目录没有依赖，可以执行安装命令（`pnpm install` / `npm install` / `uv sync`），**只安装不升级**。

计划任务的批准是**人工闸门**，顺序固定四步：①子会话 `blocked` 后，协调者**先**把计划摘要与计划文档的**绝对路径**原样回给你，并用 `present` 声明该计划文档；②**再**用 `ask_user_question` 请拍板，options 至少「批准执行 / 先看计划文档 / 调整计划」——**计划批准必须由用户拍板，协调者不得自行批准**，不会自己判断「计划没问题」就直接续派；③你选「先看计划文档」，协调者只把文档正文或路径再给一遍，不续派、不催，等你的下一次明确表态回到第②步；④只有你明确「批准」，协调者才 `task_message` 续派（插件此时才把沙箱切回可写）。答「调整」：修改点原样转回同一子会话先出修订版计划（消息里会写明「只修订计划、不要开始实现」），再走回第①步重新请你拍板；不回答就一直是「计划中」，协调者不续派、不代批。

### 交付口径：`present` 与读文件

- 协调者**不写文件、不执行命令**（预设没挂 `write`/`edit`/`bash`/`pwsh`，权限又钉在 `read-only`），交付靠 `present`：默认展示 **1–4 个最关键的真实产物**（绝对路径），没有产物就不提。
- 看文件有两条路：① 原生 `read` / `glob` / `grep`——全盘可读、没有产物边界，用来核对改动与读技能/文档；② `read_workspace`——受控读**主会话工作区内**文件，或**任务登记过**的产物（子会话产物通常在 target 目录里，登记过就能读）。越界/`../`/符号链接逃逸/未登记都被拒，大文件按行窗口截断给 `nextOffset`。
- 存在性由插件与子任务保证（通知里的路径已 `lstat` 校验），`present` 只声明交付、不读内容。
- ⚠️ 若本机开了 IM 双向同步，读进上下文的正文可能随回复同步到外部且不可撤回——涉密产物不要读进主会话；凭据类文件（`~/.dsh/.credentials.yaml`、`.env`、SSH key、token）任何情况下都不读。

### 记忆与偏好

- **日志层**：`done` 摘要写进 `task-log`（一行一条），只归档、永不注入任务详情。
- **事实层**：摘要里的经验/教训分句蒸馏成 `lesson`，加上 `decision`/`preference`/`note` 原子事实，随 `task_create` 写进 `lessons/` 记忆文件、由 `task_detail` 给出路径；`memoryLimit` 控制注入条数；检索有质量门槛（多词要命中 ≥2 个词或分数 ≥2、通用词不参与匹配）与分层配额（`decision`/`preference` 最多 2 条，其余槽位留给经验）。
- **容量（口径已变）**：日志层单项目留最新 **200 条**（超出淘汰最老的日志）；**事实层不参与淘汰**。旧口径「单项目 300 条总量」已删除——它把事实和日志混算，项目一活跃就先删手记的决策/笔记。
- **检索**：`context({mode:'history'})` 首行打印【检索范围】——**不传 `project` 只查 global 跨项目记忆**，要查本项目必须显式传 `target_dir` 或工作区名；也接受数组（合并 ≤2 个项目）与 `'all'`。`task-log` 单独成块、最多 2 条、排在事实层之后。`context({mode:'project'})` 读项目白名单（README/AGENTS/**docs/ARCHITECTURE.md**/package 等）：架构默认前 1200 字，`include:['docs/ARCHITECTURE.md']` 给前 4000 字。
- **子会话自己读**：`context` 对子会话开放（只读、同一条实现）；`task_detail` 只给本次命中的经验指针，想要更多历史/项目背景由子会话自己调 `context`——worker 预设 persona 写明「查本项目经验传 `project:<target_dir 或工作区名>`，不要等协调者注入」。写记忆仍仅主会话（`memory_note` 不在子会话工具表里）。
- **偏好**：`memory_note({ kind:'preference' })` 不传 `project` 时写进协调者偏好（每回合注入、下一回合生效、不用重启）；带 `project` 的偏好仍是项目约定，写 `memories` 随 `task_detail` 注入。旧版写在 `memories` 里的全局偏好会在启动时一次性搬进 settings（幂等；同主题取更正后的版本，如 present 的 1–4），搬完从 `memories` 删除（不双写）。偏好只是提示词文本，**不能**放宽沙箱/审批/工具边界。

### 收件箱、日报与看门狗

- `task_list({view:'inbox'})` / 面板「待你决定」：待你决定、待确认（`delivered`）、失败/丢失、长时间没动静；`blocked`/`needs_auth` 可带 `question` + `options`。
- 日报默认关闭；配 `digestAt: '09:00'`（`digestTimeZone` 可选）后，打开主会话自动挂 schedule，到点汇总完成/在跑/待决定/失败/产物。
- 空闲看门狗默认开：`running` 长时间无心跳/消息/状态变化时告警一次，只告警、不改状态、不 kill。

### 主会话上下文维护：宿主自压 + 插件只提醒

主会话是唯一协调者。0.25.0 起**不再有「轮换」**（不会自动归档旧会话、不会自己换人）：上下文过长交给**宿主**的 `compaction-basic` 自动压缩（每个 agent 预设都挂了它，阈值是宿主自己的 `thresholdRatio`，默认 0.8），插件只做两件事：

- **观测**：打开主会话时算一次上下文压力（`tokenMeter.contextPressure`）与日志体积（`locate` + `stat`），留在 `/api/orchestrator` 的 `snapshot.mainSession.context` 里做诊断；日志 ≥ 16 MiB 给一次性提示。
- **提醒**：压力达到 **`contextPressureThreshold`（默认 0.4，可在插件页配）** 时弹一张问题卡（宿主 `userQuestions`），三个选项：**新建协调者会话**（插件代建一个空白协调者会话并切过去，旧会话保留）、**继续当前会话**（本档压力不再问，下一档再问）、**稍后再说**（压力回落后才重新提醒）。同一段压力只问一次，不会每回合刷屏。

- **换协调者只有两条路**：①会话头的「**设为协调者**」（把当前会话设为协调者，只切指针：不改名、不归档、旧会话随时能回去看）；②问题卡里的「新建协调者会话」。
- **本插件不压缩**：不调用 `compactNow`、不改宿主阈值、不写预设行内 config；`/compact` 手动命令照旧可用（宿主预设自带）。
- **日志只增不减**（append-only，压缩只减请求不减日志）：要「重置」就换新协调者会话——插件不会替你做，也没有自动清理。
- **多会话并存**：`settings.main_session_id` 仍是唯一指针；通知、日报、`task_*` 都只认它。子会话不受影响（各自预设照旧由宿主压缩）。

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
- **主会话不再自动换**：0.25.0 起没有「轮换」（`mainRotation`/`rotate*` 8 键已删除，只在启动时给弃用提示）；上下文过长交给宿主 compaction-basic 自动压缩，插件只在压力达到 `contextPressureThreshold` 时弹问题卡问你要不要换新协调者会话。换会话只切指针：旧会话不改名、不归档、随时可回看；日志 append-only 只增不减，重置靠人工换会话。
- **主会话权限徽标是「钉」不是「锁」**：协调者会话被钉 `read-only`（徽标与实际工具面一致），但宿主没有锁权限选择器的 API——`/permission` 或输入区选择器仍能切走，插件只在下次「打开主会话」/协调者重新加载时拉回（需要宿主预设表里有 `read-only`，DSH 出厂表有）。
- **交互三闸门是提示词软约束，不是执行层门禁**：T1/T2 的边界是模型判断，没有代码校验——判错表现为「该问没问」或「不该问又问」，纠正方式见 [LIMITATIONS](docs/LIMITATIONS.md#交互规范软约束)。
- **只读工具的读取面是整台机器**：`read` / `glob` / `grep` 没有产物边界（`read_workspace` 才有），能读到 `~/.dsh`、`.env`、SSH key 等凭据；插件只靠提示词要求「别碰凭据」，不拦路径。同理 `bash` 仍然没挂，但它一旦由用户手动切到 `full` 权限也不会多出来——工具面不随权限变。
- **grill-me 只是澄清协议**：技能本体是提示词，没有执行层校验；它能减少「需求没问清就动手」，但不能保证一定问够，「grill 完 = 批准」这种理解仍是错的（计划批准只能由你拍板）。
- worktree 产物不在你的工作树里（合并由你决定）；计划文档只有一版、没有审批流 UI；面板轮询 2 秒、没有 SSE；产物预览依赖宿主右侧栏。
- 结算自动收场只覆盖「一次 activation」，上报过 progress 的回合异常结束落 `orphaned`。

完整清单（指标口径、崩溃恢复、平台服务缺失的降级、通知时序、面板动作幂等等）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.26.0`；**彻底退出 DSH 再启动**（刷新页面无效） |
| 插件页 / `npm i @latest` 装到旧版 | 镜像还没同步（新版本几十分钟到几小时）：过一会儿重装；急着用就换 `@wjj865-code/dsh-orchestrator@0.26.0` 显式版本；维护者侧可主动同步镜像（见 [CONTRIBUTING](docs/CONTRIBUTING.md#发版)） |
| 会话头没有「任务」入口 | 只在主会话显示：确认当前会话就是从侧栏「主会话」打开的；没建就点「打开主会话」 |
| 点产物「预览」没有右侧栏 | 宿主要装 `ui-sidebar-right` 与 `ui-sidebar-documentpreview`；缺了会提示原因，产物库那行退回面板内预览 |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页与 `logs/` |
| 子任务报 done 后一直「待确认」 | 正常：默认保持待确认；要收尾就 `task_message({action:'close'})`，或等 `deliveredTimeoutMinutes` 超时 |
| 任务停在「会话丢失」/「失败」 | 先用 `task_status` 看进展；要接着做就 `task_message({action:'resume'})`（同一个子会话冷恢复，上下文还在）；会话确实不可达或已跑偏才 `task_message({action:'retry'})` |
| 提示「配置键 X 已删除」 | 老 profile 里的已删键按提示删掉即可，插件已按默认值运行（迁移见 [CHANGELOG](CHANGELOG.md#02302026-11-19)） |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制；确实要写仓库外用 `access:'full'` 或 CI |
| 台账损坏 | 用 `snapshots/` 里最新快照手工替换（不会自动恢复） |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |
| 想换一个协调者会话 | 0.25.0 起没有「轮换」、也不会定时换：在指挥舱新建一个会话（选「协调者」预设）→ 会话头点「**设为协调者**」（只切指针，旧会话不改名、不归档）；或等压力问题卡出现时点「新建协调者会话」（插件代建并切过去）。日志 append-only 只增不减，插件不做自动清理 |

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
