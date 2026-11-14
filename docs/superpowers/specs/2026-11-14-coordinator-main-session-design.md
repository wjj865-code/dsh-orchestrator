# dsh-orchestrator 协调者主会话设计（预设开启 + 单协调者）

- 日期：2026-11-14
- 状态：设计待评审
- 取代：首次 `task_create` 自动绑定协调者的旧机制

## 1. 背景与目标

现状是「单绑定 + 首次 `task_create` 自动绑定」：`config.coordinatorSession ?? settings.coordinator_session_id`，第一个 root/lead 调用方被写进台账；运行期用 `restrict` + `guard` 收窄工具。用户要的是：**固定入口打开唯一的「主会话」，由协调者预设开启，不依赖首次 `task_create`**；主会话放在插件专用工作区，不污染用户工作区；子任务可在用户指定的项目目录里跑。

## 2. 范围

**做：**

- 主会话生命周期（创建 / 打开 / 失效重建）与固定入口。
- 协调者 agent preset：工具集在预设层定型。
- 专用工作区「指挥舱」（路径 `~/.dsh/state/orchestrator/workspace`）。
- `task_create` 可选目标目录，子会话在目标目录运行。
- 面板「打开主会话」按钮、状态展示、只读 `snapshot` 扩展。
- 旧机制退役与迁移、测试与真机验收。

**不做：**

- 多协调者（本设计明确只支持一个主会话）。
- 嵌套子任务、跨设备同步、任务间依赖编排。
- 会话自动切换（阶段 2 的入口点击即可）。
- 客户端整体改版（沿用阶段 2 的侧栏入口/面板）。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 主会话 | 唯一的协调者会话，由插件按协调者预设创建，id 存在 `settings.main_session_id` |
| 协调者预设 | agent preset，id `dsh-orchestrator-coordinator`，显示名「协调者」 |
| 指挥舱 | 插件专用工作区，路径 `~/.dsh/state/orchestrator/workspace`，显示名「指挥舱」 |
| 目标目录 | `task_create` 可选参数，子会话的工作目录 |

## 4. 数据与配置

- `settings.main_session_id`（新键）：主会话 id。旧键 `coordinator_session_id` 不再读取、不删除（仅留历史），自动绑定退役。
- `tasks.target_dir TEXT`：任务目标目录；旧库启动时 `ALTER TABLE` 补列。
- 配置 `coordinatorSession`：保留为显式覆盖（测试/高级）。配了就以它为准，不自动创建、不写台账；没有预设保证的会话走运行期收窄兜底。
- 解析顺序：`config.coordinatorSession` → `settings.main_session_id`。

## 5. 主会话生命周期

- **打开**（面板「打开主会话」入口）：
  1. 有配置覆盖：解析 live agent，成功则 `uiWorkspace.openSession(id)`；失败返回可读错误（不自动建）。
  2. 无配置：读 `settings.main_session_id`，live 则打开。
  3. 解析不到（未创建 / 已删除 / 重启后未加载）：**自动创建**——确保「指挥舱」工作区已注册，用协调者预设 `sessionController.create({ workspaceId, agentPreset })` 建会话，写 `main_session_id`，再打开。
- **失效重建**：主会话被删或数据丢失时，下次点「打开主会话」按上面的创建路径重建；台账与旧任务全部保留，旧任务的 `coordinator_session` 只作来源记录。
- **命名**：主会话创建时显示名用「主会话」；若平台创建 API 不支持命名，创建后调用标题接口补上（待探针确认）。
- **单协调者**：`task_create` 不再绑定任何会话；找不到可解析的主会话时返回「请先从面板打开主会话」，不建任务、不落库。
- **只有主会话能派任务**：`task_*` 工具仍全局注册，但非主会话调用返回可读提示「请从主会话派任务」；子会话的 `task_report` 按任务归属校验，不受影响。
- **失败处理**：创建失败 → 可读错误、不写 `main_session_id`；创建成功但打开失败 → 保留 id、提示重试；工作区注册失败 → 报错不建会话。
- **删除主会话**的后果沿用平台行为：关闭会话会释放其子代理树；任务由 `orphaned` 对账兜底。

## 6. 协调者预设与工具集

- bundle 注册 agent preset 行：`id: dsh-orchestrator-coordinator`，显示名「协调者」，`toolFilter` 只保留：
  `task_create`、`task_list`、`task_status`、`task_message`、`task_stop`、`ask_user`、`show_view`、memory 读写。
- 文件 / shell / 浏览器 / web 搜索 / `wait_agent` / 团队控制类工具在预设层就不出现；运行期 `restrict` + `guard` 降为兜底（只对配置覆盖的会话有必要）。
- 提示词仍由插件按主会话 id 动态渲染 `COORDINATOR_POLICY`；不与预设内的 instructions 重复依赖。
- 待探针确认：预设行里 `toolFilter` / composition 的准确字段；`sessionController.create` 是否接受 `agentPreset`；创建出来的工具表是否与预期一致；「指挥舱」工作区的注册方式（workspaceRegistry / create 的参数）。任一不过则退化为「运行期收窄」，设计其余部分不变。

## 7. 任务与目标目录

- `task_create` 新增可选 `target`：必须是**存在的绝对目录**；校验失败返回可读错误、不落任务行。
- 不传 `target` 时子会话 `cwd = 指挥舱` 工作区（主会话的工作目录）。
- `target_dir` 写入台账；渲染文本在【任务编号】后加一行【工作目录】；面板任务行展示目标目录（长路径截断）。
- 子会话创建参数 `cwd = target_dir`；待探针确认沙箱是否随 cwd 授予该目录权限，不成立时退化为「target 必须落在已注册工作区内」。
- 通知：单协调者，全部发**当前主会话**；`tasks.coordinator_session` 只作来源记录。

## 8. 入口与面板

- 入口不变：侧栏底部「任务」（`sidebar.footer.action`）+ 会话头「☰ 任务」（`conversation.header.leading`）打开同一面板。
- 面板右上角「打开协调者会话」改为「**打开主会话**」，旁边显示状态：主会话在线 / 未创建 / 已失效。
- 未创建或失效时给可点击提示「还没有主会话，点击创建」，点击走第 5 节创建/重建路径。
- 只读路由 `snapshot` 返回增加 `mainSession: { id, live }`；任务项增加 `targetDir`；仍只 import 查询函数、不写台账。

## 9. 迁移

- 旧 `coordinator_session_id` 不迁移：首次点「打开主会话」在「指挥舱」新建；旧任务保留，旧会话原样不动。
- 自动绑定代码移除；`task_create` 在无主会话时给可读提示。
- 配置覆盖用户不受影响。

## 10. 错误处理

| 情况 | 行为 |
| --- | --- |
| `task_create` 时无主会话 | 返回「请先从面板打开主会话」，不建任务 |
| 主会话创建失败 | 可读错误，不写 `main_session_id`，不跳转 |
| 创建成功但打开失败 | 保留 id，提示可重试 |
| 指挥舱工作区注册失败 | 报错，不创建会话 |
| `target` 不是绝对目录 / 不存在 / 不是目录 | 可读错误，不落任务 |
| 主会话失效但任务需要通知 | 记 `skipped` + 原因，面板显示「主会话已失效」 |

## 11. 测试与验收

- 单测：主会话创建/打开/重建、配置覆盖、目标目录校验与落库、通知只发当前主会话、无自动绑定、旧键不读取、`snapshot` 形状。
- 探针：预设行/`toolFilter`/`create({agentPreset})` 契约；子会话 `cwd` 与沙箱；面板按钮与状态字段。
- 真机（隔离 profile + desktop 一次重启）：
  1. 点「打开主会话」→ 在「指挥舱」创建带协调者预设的会话并跳转；
  2. 主会话工具表只剩允许项；
  3. 带 `target` 派任务，子会话在目标目录跑；
  4. 删除主会话后再点入口，自动重建；
  5. 用户工作区/会话不受影响。

## 12. 风险与已知局限

- 主会话被删除会释放其子代理树（平台行为），任务靠 `orphaned` 对账兜底。
- 预设/创建 API 探针不通过时退化为运行期收窄。
- 目标目录在沙箱外时可能拿不到写权限，退化为「必须落在已注册工作区」。
- 主会话本身会作为「指挥舱」工作区里的一个会话出现。
- 单协调者：多个会话同时派任务时，通知统一回到主会话，不区分来源会话。
