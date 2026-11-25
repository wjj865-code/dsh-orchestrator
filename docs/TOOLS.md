# 工具与能力面

插件注册的全部工具、角色差异与配套能力。**日常使用看 [README](../README.md)**；机制与取舍看 [ARCHITECTURE](ARCHITECTURE.md)，边界看 [LIMITATIONS](LIMITATIONS.md)。

## 工具清单

插件**全局注册 12 个工具**：协调者 8 个；任务执行者可用 `context`、`memory_note` 及 4 个专属工具。工作写入范围 `writeScopes` 仍用于冲突防护，不是产物目录。

协调者（8 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发。`dependsOn` / `chain`（`'auto'`：交付时还有下游在等就自动确认完成，没有下游仍返回「已交付待确认」）/ `group` / `writeScopes` / `priority` / `readOnly` / `planFirst` / `access`（`'full'`）/ `worktree*` / `allowConcurrent` / `checks`（交付前机器验收）/ `goalRounds`（续跑预算，默认 0 不续跑）/ `teamTaskId`（关联官方 Team 板，确认时按 CAS 反写 `complete`） |
| `task_list` | 活跃/历史任务（`active` / `group` 过滤）；`view:'inbox'` 是收件箱：待决、待确认、失败/丢失、长时间没动静 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、交付/关闭时间、验收（每条检查的退出码/耗时）、交接、目标状态与轮次（`x/y`）、官方 Team 关联、最近消息；`include:'full'` 从宿主会话日志冷读最新回复全文（读不到给摘要 + 原因） |
| `task_message` | `action:'message'` 默认追问原会话，计划任务只讨论/修订，**不批准**；`'approve'` 显式批准已落盘、blocked 且停在等确认的计划，之后 message 续派才授予写权限；`'resume'` 续跑失败/丢失或 timeout/chain 自动完成的原会话（面板同入口；收集中/人工确认/检出清理拒绝）；`'stop'` 停止；`'retry'` 重派 failed/orphaned（新任务新会话）；`'close'` 确认 delivered 成 done |
| `context` | 只读读上下文（协调者与子会话都能调）：`mode:'history'`（默认，记忆/历史任务/历史会话；首行【检索范围】，查项目记忆要传 `project`）/ `'project'`（项目白名单文件含 `docs/ARCHITECTURE.md`、结构、最近任务、相关记忆）/ `'workspaces'`（已登记工作区与仓库采样索引） |
| `memory_note` | 记一条跨任务有效的决策/经验，或一条偏好。协调者（主会话）可写任意项目与全局偏好；任务子会话只能写**自己任务 `target_dir`** 的项目记忆（`note`/`lesson`/`decision`，单任务最多 3 条、同 `kind`+`text` 幂等），写 `preference` 与全局/跨项目记忆会被拒并给替代路径；`kind:'preference'` 不传 `project` 时写进协调者偏好（每回合注入、立即生效） |
| `read_workspace` | 读产物正文：主会话工作区内文件/目录，或任务已登记产物；越界/`../`/符号链接逃逸/未登记均被拒；大文件按行窗口截断给续读 `offset` |
| `capability_pack` | 能力包工厂：`list` / `describe` / `create` / `update` / `delete` / `open` / `install` / `uninstall` / `health` / `export-static`。写动作先不传 `confirm` 看 dry-run 计划（文件树 + 预设行 + 安装确认卡），再带 `confirm:true` + `clientRequestId` 执行；装 CLI 须先看确认卡（实测体积/耗时）再带 `planHash`；内置包只读；包会话是普通根会话（不写台账、不进队列） |

子任务（3 个，外加与协调者共用的只读 `context`）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`，可带 `question` / `options` / `artifacts`；`done` 落「已交付待确认」，配了 `checks` 的先跑验收、失败拒绝交付；`progress` 会作为进度信号送达（合并 + 同任务水位，追问后的第一条必达） |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收标准、可执行检查、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物 |
| `plan_save` | 计划模式专用：计划正文写入任务产物目录 `docs/<任务名>-<版本>.md`，保留旧版本并更新最新计划路径 |
| `artifact_save` | 执行者专用：`task_id/name/content` 保存自己的 Markdown 阶段文档；固定目录、版本化、调用重放幂等；只读任务也可保存文档但不能修改工作区 |

### 角色差异（预设层遮挡）

12 个工具**全局注册**（`index.js` 的 `createTools(...).map(ctx.tools.register)`），角色差异在**预设层**：协调者遮「编排正确性」项与四个执行者专属工具；worker 保留产物保存工具。`task_report.checkpoint:true` 请求阶段快照，`changedFiles` 补充工作文件；done 在回合结束保存后交付。非 Git 文件只保存捕获范围，缺失、拒绝和截断进入清单；不完整阶段不自动 chain。

- `context` 与 `memory_note` 子会话都能调：`context` **只读**、与协调者同一条实现（同参数输出逐字一致）；`memory_note` 在子会话里只能写自己任务目录的项目记忆。
- `task_report` / `task_detail` / `plan_save` 只对任务自己的子会话开放。

### 派发时的 brief（只留一次性参数）

派发给子会话的 **brief 只留一次性参数**（2–3 行，`access:'full'` 多一行）：任务引用（`tk-xxxxxx`）+ 一行「先调 `task_detail`」指针。目标、验收、经验、前置、产物都不内联进提示词，由子会话用 `task_detail` 现读。执行中怎么上报、交付怎么回报、隔离任务装依赖、主动读 `context` 这些静态提示由 **W1「任务执行者 policy」每回合注入**（分层见 [ARCHITECTURE](ARCHITECTURE.md) 的「提示词分层」一节）。

### 只读工具与技能

- **`read`**（协调者预设只挂 `tool-fs` 的 `read`）：核对子会话说的改动、看 target 里的某个文件、读插件安装目录里的技能与文档都可以，不必为此新派任务。`tool-fs` 只开 `read`（`write` / `edit` / `apply_patch` / `read_image` 全关），所以协调者工具表里**没有任何写工具**。**`glob`/`grep` 已移除**：主会话一有搜索能力就会自行检索、绕过派发（`tool-fs-search` 没有「只关 grep」的开关，`preset-tools` 的 `deny` 又遮不到预设自有行，只能整行移除）；**要批量检索/枚举目录就派一条只读任务**（`readOnly:true`），让子会话把结果带回来。`read` **没有产物边界、能读到全盘**——凭据类文件一律不读、不转述，风险见 [LIMITATIONS](LIMITATIONS.md#协调者读文件read)。
- **`skill` + grill-me 技能**：插件随包发 `skills/grill-me/SKILL.md`，注册模块 `@wjj865-code/dsh-orchestrator/skill-grill-me` 在**协调者预设作用域**里调 `ctx.skills.register`，所以只有协调者看得到。技能内容是多轮**前沿提问**的澄清协议：一次只问一个决定性问题、每问带推荐、事实自己查、决策归用户、最多 **2 轮 8 问**、最后给一张「决策点｜你定的｜影响」三栏决策记录。**grill ≠ 批准**：澄清完仍要按闸门确认，计划批准只能由用户拍板。目录里除了随包的 `grill-me`，还有**用户本地全局技能**与项目技能根——0.35.0 起协调者预设补挂 `skill-filesystem`（宿主把本地技能发现下放给预设），否则主会话只看得见宿主内置技能（详见 [ARCHITECTURE](ARCHITECTURE.md#协调者只读工具与-grill-me-技能0260t-48e8ce06)）。
- **不挂 `working_directory`**：这个宿主全局工具会把**协调者会话的 cwd** 改掉，而 cwd 是指挥锚（`task_create` 不给 `target` 时子会话继承它、工作区/写域判定与记忆项目键推断都以它为准），会话内切目录会让锚点静默漂移。协调者看文件用 `read` 的绝对路径，不需要切目录。
- `present` 与 `schedule_*` 是协调者预设自带的宿主原生工具，不计入上面 11 个。

### 原生自动化工具

协调者预设挂载宿主 `@deepseek-ai/dsh-tool-schedule`，不另造调度器、不计入插件全局 12 个工具（契约核实于 DSH `0.2.2-rc.3`，升级宿主需复核）。

| 原生工具 | 用法 |
|---|---|
| `schedule_create` | 必填 `title` / `prompt` / `rrule` / `target` |
| `schedule_list` | `active?` / `limit?` / `offset?` 分页查询 |
| `schedule_view` | `id` 查看最新任务 |
| `schedule_edit` | `id` + `action:'update'` / `'delete'`；暂停 `active:false`、恢复 `active:true`；编辑携带最新 `updatedAt` 为 `expectedUpdatedAt`（可用时） |

- **Host-wide**：能看到并按 id 管理其他会话创建的任务；创建/修改/暂停/恢复/删除需用户**明确授权**，冲突 `schedule_conflict` 先重读、不强行覆盖。授权提示是模型行为约束，不是人工审批硬门禁。
- **自动编排只支持 `target:'this_session'`**：到期唤醒唯一主会话，按已授权 prompt 调 `task_list` 核对后再 `task_create`。`new` / `new_once` 仍是原生选项，但创建普通 root 会话、**非唯一主** id 无法直接 `task_create`，不提供第二协调者/转发桥。
- **默认 worker 不新增**自动化包；自定义 worker 即使有 schema，宿主仍返回 `subagent_session`。`access:full` 只改沙箱，**不增加工具**、不绕过委派校验或审批。
- Host 必须运行；投递成功不等于子任务完成，崩溃可能重复投递，删除不撤回已排队消息，不承诺 exactly-once。

### 旧工具名迁移

旧名（`task_stop` / `task_retry` / `task_close` / `task_inbox` / `history_search` / `project_context`）**已删除**、不注册，照旧名调用会拿到一条可读迁移提示；映射表见 [README「工具迁移映射」](../README.md#从旧版本升级工具迁移映射) 与 [CHANGELOG](../CHANGELOG.md)。真源是 [`src/tool-migrations.js`](../src/tool-migrations.js)。
