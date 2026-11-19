# dsh-orchestrator

> **一句话定位**：给 DeepSeek Harness 加一位「协调者」——主会话只拆活、派子会话、看回报、交付产物；子会话在各自目标目录里把活干完，进度与结论落进持久台账，浏览器里有任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（当前 `0.22.0`）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- License：MIT｜Node `>= 22.15`（`engines`）｜DSH 兼容基线 `0.2.2-rc.3` – `rc.5`（CI 与真机实测在 `rc.3`，Web 表面为主，Desktop 同构）

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
   @wjj865-code/dsh-orchestrator@0.22.0
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

从源码开发/自行构建：见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。仓库用 **pnpm**（版本钉在 `package.json` 的
`packageManager`，锁文件 `pnpm-lock.yaml` 入库）：检出目录、尤其是 **git worktree 里第一步都要先 `pnpm install`**，
`node_modules/` 不会跟着检出。

### 装好后的自检

1. 插件页能看到「任务编排」标题、图标和详情页。
2. 侧栏「主会话」能打开；插件全局共 10 个工具（协调者 7 个、子会话专属 3 个），此外协调者预设提供 `present`、提问及原生自动化四工具；默认 worker 不新增自动化。
3. 派一条任务，子会话 `task_report done` 后主会话收到「已交付待确认」通知；`task_message({ action: 'close' })` 能确认成「已完成」。
4. 会话头「任务」入口只在主会话显示，切到子会话后自动隐藏。

### 入口在哪

- 侧栏「插件」下方「◈ 主会话」：直达协调者对话，**始终可见**（还没建主会话时靠它引导创建）。
- 会话头「任务」入口（品牌色方块 + 图标 + 文字）：打开任务面板，**只在主会话显示**。判定信号是台账主会话 id（`settings.main_session_id`，配置 `coordinatorSession` 覆盖）：客户端把当前会话 id 发到 `/api/orchestrator` 的 `session-role` 端点，宿主回答是不是主会话；信号不可用（拿不到会话、请求失败）时**默认隐藏**——宁可少一个入口，也不在子会话里露出面板。
- 面板右上角「打开主会话」：创建/复用一个主会话。
- 回复底部的关联任务 chip：主会话里协调者**最新一轮**回复的动作行上方，最多两枚「状态图标 + 任务标题」（其余折成「+N」），
  点一下打开任务面板并直接定位到该任务的详情；历史回复、子会话、没有关联任务时都不渲染。规则与状态映射见
  [docs/ARCHITECTURE.md §回复底部关联任务 chip](docs/ARCHITECTURE.md#回复底部关联任务-chip官方-turntail-槽位)。

## 快速上手

### 1. 打开主会话

侧栏「◈ 主会话」（或面板「打开主会话」）。协调者预设只做协调：没有 `read`/`write`/`bash`，也不会阻塞等待子任务。要读子会话落在工作区的产物，用受控的 `read_workspace`（只能读主会话工作区内，越界被拒，见「读工作区产物（`read_workspace`）」）。

首次新建主会话会自动开启介绍轮次：先介绍能做什么及权限边界，再立即派一个只读「工作区与仓库索引」子任务。只扫描 **DSH 已登记**的工作区（标题/路径及 git 根、当前分支、origin、HEAD、commonDir），不全盘搜 git、不 fetch/pull，不写文件；非仓库/不存在/无权限单项记录，remote 去凭证。结果通过 `task_report.workspace_index` 存入插件 settings 的独立采样快照，不覆盖手写记忆。后续 `context({mode:'workspaces'})` 查看全部映射，指定项目也会附仓库快照；有歧义列候选、使用前核对实时状态。

- 每个**新建**主会话一次；重复打开/刷新/并发入口不重复，升级后历史主会话不补初始化。介绍/派发由模型执行，不承诺模型一定遵循；投递失败在打开结果显示，重新打开可重试，索引任务失败用 `task_message({action:'retry'})`，不盲重派。
- 索引不需要 `access:full`，仍由默认只读 worker 执行，名单与脚本在 `task_detail` 给出；如果沙箱或权限读不到某工作区，记录 unavailable，不为扫描全盘升权。自动化不开放给 worker。
- 主会话跑久了（主会话日志 > 6 MiB 或运行 > 10 天，任一命中）会在**这次打开时**判定是否换一个干净的新会话，见[主会话轮换](#主会话轮换把长到拖不动的协调者换掉)。**默认关闭**（`mainRotation: 'off'`）：升级后不会自动换，要自动换就显式配 `auto`。

### 2. 说需求 = 派单

用自然语言对主会话说需求即可，协调者会调用 `task_create` 拆任务（**能从记忆/上下文/已交付结论直接答的就不派**，只有需要新鲜取证、写文件或跨仓库证据时才派子会话）：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

有先后关系用 `dependsOn`，同一需求用 `group`，会改同一批文件用 `writeScopes`（与活跃未隔离任务重叠会被拒，见「同写域并发防护」），紧急的给 `priority`：

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

- 协调者不阻塞等待：进度用 `task_list` / `task_status` / `task_list({view:'inbox'})`，子任务完成会主动通知（`agent.steer` 注入，5 秒合并）。
- 子会话用 `task_report` 汇报：`progress`（有进展未完成）/ `done`（做完了，交付）/ `blocked`（等人决定）/ `needs_auth`（需要授权）。

### 4. 交付、确认与追问（0.14 起是两段式）

子会话报 `done` **不等于**任务结束，而是落到 **`delivered`（已交付待确认）**：

- **默认保持待确认，不主动关闭**：追问窗口留着，用户看完结果常还要改。协调者只在用户明确说「确认 / 没问题 / 不用再改」，或确实需要终态（要派依赖它的任务、要删任务、要收尾）时才 `task_message({ action: 'close' })`。
- **不主动问「任务能不能关闭」**：协调者交付后只汇报结果、产物与注意事项，不再用 `ask_user_question` 追问「确认 / 要改？」——任务保持待确认、等超时自然完成，比催用户当场表态更省事。协调者只在真需要拍板时才提问（方案歧义/业务取舍、不可逆操作、远端写授权），且多条待拍板合并成一条清单一次问完。
- 要改/补充：协调者 `task_message` **复用同一个子会话**，任务回到 `running`，完成后会再交付一次。（面板不再提供「追加」按钮，见下节。）
- 一直不确认：超过 `deliveredTimeoutMinutes`（默认 60 分钟）自动收成 `done`（`close_reason=timeout`）。
- 面板「待你决定」筛选与收件箱都包含 `delivered`，任务卡/抽屉有「待确认」小标、交付时间与关闭原因。

### 5. 面板

会话头「任务」入口打开，DeepSeek 设计平台风格三段式：

| 段 | 内容 |
| --- | --- |
| 顶部命令栏 | 标题 + 主会话状态点、任务搜索、刷新、打开主会话；4 张指标卡（进行中/待你决定/已完成/失败，点击即切筛选） |
| 中部工作区 | 左侧筛选轨（带计数徽标）+ 任务卡列表；切到「产物」变成产物库（按项目/日期分组、可预览/复制） |
| 产物预览 | 点「预览」或产物路径 → **主栏切回会话、会话右侧栏打开该文件**（Markdown/代码/图片/PDF/Office 由宿主渲染；宽度/多 Tab/折叠由宿主右侧栏负责） |
| 右侧详情抽屉 | 遮罩、`Esc`、关闭按钮都能收起；7 个可折叠区块：概览、最新回复、Brief、目标状态、消息、依赖、产物 |

- 颜色/圆角/阴影/动效全部取宿主 `--dsw-*` token，深浅色主题自动跟随。
- 底部动作条：停止（二次确认）/ 确认交付（仅「待确认」，二次确认）/ 重派 / 打开子会话 / 删除（仅终态、二次确认，级联清台账）。可见性与后端门控同源（`src/panel-gates.js`）。
- 面板**没有「追加消息」按钮**（旧实现依赖 `window.prompt`，在 Electron 里被禁用、点了只会抛错）：续派与计划批准统一走协调者 `task_message`。
- 交互细节、`--dsw-*` token 对照与 chip 规则见
  [docs/ARCHITECTURE.md §界面与消息块](docs/ARCHITECTURE.md#界面与消息块合并自原-uimd)。

## 核心概念

### 任务状态机：交付（`delivered`）≠ 完成（`done`）

| 状态 | 含义 | 谁推进 |
| --- | --- | --- |
| `waiting_dep` | 等前置完成，不派发、不占并发位 | 前置 `done` 后自动 → `pending` |
| `pending` | 排队等并发槽位 | 队列自动派发 → `running` |
| `running` | 子会话在跑 | 子会话回报 / 结算 |
| `waiting_user` | 子会话 `blocked`，等人决定 | `task_message` 续派 → `running` |
| `waiting_auth` | 子会话 `needs_auth`，等授权 | 同上 |
| **`delivered`** | **已交付待确认**：成果已落库，等确认或追问 | `task_message({action:'close'})` → `done`；`task_message` → `running`；超时 → `done` |
| `done` | 已完成（**不可逆终态**，不提供 reopen） | — |
| `failed` | 失败（可 `task_message({action:'retry'})` / 面板重派） | — |
| `cancelled` | 被 `task_message({action:'stop'})` 停掉 | — |
| `orphaned` | 会话丢了（上报过 progress 的回合异常结束） | 可重派 |

- 依赖就绪**只认 `done`**：`delivered` 会短暂挡住下游，确认或超时后自动晋升。
- `delivered` 是唯一允许「追问复用原会话」的收尾态；`done` 之后要改只能新派任务。
- 面板「待你决定」与 `task_list({view:'inbox'})` 都把 `delivered` 当待办。

### 依赖、分组、写域、优先级

- `dependsOn`：前置没完成 → `waiting_dep`；全部 `done` → 自动 `pending`；任一失败 → 下游自动 `failed`（写清原因）。创建后不可编辑，也不允许指向未来 id。
- `group`：分组，面板按组汇总进度（`task_list({ group })` 看「已完成/待确认」）。
- `writeScopes`：写域，与活跃未隔离任务重叠时**默认拒绝创建**（见下「同写域并发防护」），不是文件锁。
- `priority`：`-10..10`，高的先派。

### 同写域并发防护（默认拒绝，可显式放宽）

**这是行为变更**：以前同一个目标目录可以并发派多个任务（`writeScopes` 只打一行提示），两个子会话会同时写同一份工作树、互相覆盖。现在默认拒绝。

`task_create` 时，若新任务的目标目录与某个**活跃且未隔离**任务的目录相同或互相包含（或两者 `writeScopes` 重叠），且新任务没有 worktree 隔离，默认**不创建任务**并返回可操作错误：

```
未创建任务：目标目录 /path/to/repo 与活跃任务相同或互相包含，且新任务没有 worktree 隔离——两个子会话会同时写同一份工作树。
冲突任务：
- 「旧任务（t-1a2b3c4d）」（进行中）：/path/to/repo
三种做法（任选其一）：
1. 先 task_message({action:'close'}) 关闭旧任务（或 task_message({action:'stop'}) 取消），再重派；
2. 传 worktree:true 让新任务在独立检出里跑（推荐：两个任务可并行，合并由你决定）；
3. 确认确实要并发写同一目录时，显式传 allowConcurrent:true 放行（冲突风险自负）。
```

- **三条出路**，都不是「不可绕过」：`task_message({action:'close'|'stop'})` 旧任务、`worktree:true` 隔离、或显式 `allowConcurrent:true`（放行时返回里标注「并发风险」，并记 `task.create.concurrent-write` 日志）。
- **不算冲突**（既有用法不受影响）：不同 target、worktree 隔离任务（在各自检出里跑——含 `requested` 待建检出状态，即因 `dependsOn` 停在等前置的隔离任务）、`dependsOn` 链上的前置任务（等它们 `done` 才派发，不会同时跑）、`readOnly` 只读任务（不写文件，既不占目录也不被拦）、已完成/已取消/失败/丢失的任务（已释放目录）。反过来，`degraded`（目标不是 git 仓库、隔离降级）仍在原工作树里写，**照常占目录**。
- **`planFirst` 计划任务照常参与判定**：计划阶段当下是只读沙箱，但批准后会切回可写——放过去等于把冲突推迟到批准那一刻。
- **`delivered`（待确认）算活跃**：它还占着目录。要接着改就用 `task_message` 追问原会话，不要新建同目录任务——拒绝文案也会提示这一点。
- **配置降级**：`sameDirGuard: 'warn'` 只给强警告照常创建，`'off'` 完全关闭（`writeScopes` 退回旧的一行提示）。**默认 `'require'`**，非法值（含拼错）一律回落 `'require'`——默认必须安全。
- 被拒与放行都落日志：`task.create.rejected`（`reason: 'same-dir' | 'write-scope'`，带冲突任务 id）与 `task.create.concurrent-write`（`mode` / `allowed`）。

### 交付口径：`present`

- 协调者不写文件、不执行命令（`write`/`edit`/`bash`/`pwsh`/`glob`/`grep` 与原生 `read` 都被拒），交付靠 `present`，看产物正文靠受控的 `read_workspace`（只能读主会话工作区内）。
- 默认用 `present` 展示 **1–4 个最关键的产物（最多 4 个）**：只列真实存在的普通文件、写绝对路径，不必等用户点名；没有产物就不提 `present`。
- 存在性由插件与子任务负责（通知里的路径已 `lstat` 校验）；`present` 只声明交付、不读文件内容。
- 子任务 `done` 时还会从 `workspaceChanges` 自动收集本轮改动文件，与显式 `artifacts` 按路径去重合并。

### 读产物（`read_workspace`）

以前协调者要「看一眼产物」只能再派一个子任务或靠 `task_status include:'full'` 读最后一条返回消息；现在可以直接读。
边界是**两个判据的并集**：

1. **主会话工作区包含性**：`$DSH_HOME/state/orchestrator/workspace/` 之下（`reports/`、`diag/`、`backups/` 等）；
2. **已登记产物**：任务 `task_report` 回报过、或 `done` 时自动收集进台账（`tasks.artifacts_json`）的路径。
   子会话按契约把产物写在 target 目录内（仓库、worktree 检出），这些路径**不在工作区里**，
   但它们被登记过，所以协调者能直接读正文，不必再派任务。

```js
read_workspace({ path: 'reports/p10-coordinator-read-glob-eval.md' })   // 相对工作区
read_workspace({ path: 'reports/review-ui-1794827205/' })               // 目录：只列条目，不递归
read_workspace({ path: '/repo/reports/preference-mechanism-plan.md' })  // 已登记产物（target 目录内）
read_workspace({ path: 'reports/big.md', offset: 401, limit: 400 })     // 续读行窗口
```

**为什么用「登记表」而不是放开 target 目录**：target 通常就是整个仓库根，放开它等于把未提交改动、`.env`、
`secrets/` 全部暴露给协调者上下文（再叠加 IM 外发风险）。登记表把读取面收窄成「被任务显式/自动登记过的路径」，
与面板预览、右侧栏的判据同源；未登记的同目录文件仍然被拒。

**为什么自建而不是开放原生 `read`/`glob`**：平台的文件工具没有读路径白名单——`dsh-fs-sandbox` 只给写操作加栅栏（`Reads pass through untouched: every mode permits reading.`），
`LocalFileSystem` 的 `cwd` 只是相对路径基准、不是包含性边界（`a resolution default, NOT a containment boundary`），`glob` 直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。
给协调者开原生 `read` 就等于给它一个**全盘可读**的宿主进程读者（`~/.dsh/.credentials.yaml` 也在射程内），且本机桥接了 IM 双向同步，读进上下文的内容可能随回复出站。

**边界（`src/read-workspace.js`）**：

| 闸 | 挡什么 |
|---|---|
| 形状 | 空路径、含 NUL、`~` 开头（不做家目录展开） |
| 词法包含性 | `resolve()` 归一后 `relative()` 判定：`../` 穿越、工作区外的绝对路径 |
| 真实路径包含性 | `realpathSync` 解析整条链后再判一次：**符号链接逃逸**（含中间目录是链接） |
| 已登记产物 | 上面两道都不放行时查台账登记表：命中（文件本身，或已登记目录的子树）才允许；登记表**不借符号链接**放行 |

- 只读：没有写/删/改名参数，也不递归枚举（目录只列一层、最多 200 项）。
- 体积：单文件超过 4 MB 直接拒绝（不整块读入），提示让子会话把摘要写进产物。
- 截断：正文按行窗口返回（默认 400 行 / 上限 2000 行，且单次不超过 64 K 字符），截断时给 `nextOffset` 续读——截断不是失败。单行本身超 64 K 字符时只返回该行前 64 K 字符并标 `truncatedLine`，续读 `offset` 照给（指向下一行）。
- 入参：`offset`/`limit` 收数字也收字符串（`offset: '401'` 等价于 `401`），非法值回落默认，不静默忽略。
- 二进制只报类型不返回内容；越界/穿越/逃逸/未登记都会写 `workspace.read.rejected` 审计日志；成功读取的日志带 `via: workspace|registered`。
- 头行标明来源：`【工作区文件】` 还是 `【已登记产物文件】`（后者附「任务 t-xxxx 登记」），一眼看出这条路径凭什么可读。
- **不用于校验存在性**：存在性仍由插件与子任务保证，`present` 只列真实文件。

> ⚠️ **IM 外发提示**：若本机开启了 IM 双向同步（如 `@xmanrui/dsh-im`），协调者读进上下文的正文可能随「最终助手文字」同步到外部渠道且不可撤回。涉密产物不要用 `read_workspace` 读进主会话。

### 计划任务：`planFirst` + `plan_save`

`task_create({ ..., planFirst: true })` 让子会话以**计划阶段**起步：**只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）**。写文件/写 shell 被沙箱拒绝是预期行为，不是权限故障。

四步流程：

1. **只读探索**：读代码/文档、跑只读命令、验证假设。
2. **计划落盘**：调 `plan_save({ task_id, content })`，插件在宿主进程把计划正文写进**主会话工作区**的 `reports/plans/<taskId>.md`，并自动登记为任务产物。这是计划阶段**唯一**允许的写入口：路径固定、只收任务编号（编号形状白名单 + `relative()` 包含性校验，逃逸在写之前就拒），正文上限 200000 字，重复保存覆盖同一份（只有一版，没有版本对比/审批流）。
3. **摘要上报**：`task_report({ status: 'blocked', summary, question, options })` 只报 **3–8 行摘要 + 计划文档绝对路径 + 待拍板问题**；不要把计划正文塞进 `question`（500 字上限会截断）。
4. **批准执行**：用户批准后协调者 `task_message` 续派（面板已不提供「追加」入口），插件在投递成功且任务回到 `running` 后把沙箱切回 `workspace-write`、关闭 plan mode。

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
- **风险**：等于把该子会话的写权限交给模型——它能改任何用户能改的文件。用完正常进终态，`task_message({action:'stop'})` 照样能收。

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
- **检索**：`context({mode:'history'})` 查插件记忆/历史任务/平台历史会话；`context({mode:'project'})` 读项目白名单文件、顶层结构、最近任务；`memory_note` 记一条跨任务有效的决策/经验。
- **偏好是另一条路**（不进 `memories`）：`memory_note({ kind:'preference' })` **不传 `project`** 时写进协调者偏好
  （`settings.orchestrator_preferences`），**每回合注入协调者提示词**，改完下一回合生效，不用重启。它不进
  `memories`（`context({mode:'history'})` 查不到），避免同一件事存两份。带 `project` 的偏好仍是项目约定，写 `memories`、
  随 `task_detail` 注入子会话。
  - 出厂预制两条：跑包管理器/写 HOME 缓存 → 派任务传 `access:'full'`；worktree 任务验收含装依赖/构建 → 同样传 full。
  - 预算：`preferencesMaxChars`（默认 1200）+ `preferencesMaxItems`（默认 12）；超限按优先级保留并在段尾写明「另有 N 条未展示」。
  - `preferencesInject:false` 关掉整段。偏好只是提示词文本，**不能**用来放宽沙箱/审批/工具边界。

### 收件箱与日报

- `task_list({view:'inbox'})` / 面板「待你决定」：待你决定、待确认（`delivered`）、失败/丢失、长时间没动静。
- `blocked` / `needs_auth` 可带 `question` + `options`，显示在通知、详情与面板。
- 日报默认关闭；profile 配 `digestAt: '09:00'`（`digestTimeZone` 可选）后，打开主会话自动挂 schedule，到点汇总完成/在跑/待决定/失败/产物。
- 空闲看门狗默认开：`running` 长时间无心跳/消息/状态变化时告警一次，只告警、不改状态、不 kill。

### 主会话轮换：把长到拖不动的协调者换掉

主会话是唯一的协调者：所有子任务回报、确认、追问都落在它身上。跑久了上下文变大、会话日志变长，打开它越来越慢。**主会话轮换**就是把旧主会话退役、换一个干净的新会话接着当协调者——台账、任务、经验、产物都留在原处，只有「当前协调者是哪个会话」变了。

它**没有定时器、没有后台巡检、也没有面板按钮**：判定只在**你打开主会话那一次**发生（面板「打开主会话」或侧栏「◈ 主会话」，且旧主会话当前是活的）；每次打开现算，只有该换才换。

| 触发因子（任一命中即「该换」） | 默认阈值 |
|---|---|
| 主会话日志体积（MiB，压缩后） | `rotateAfterMainLogMiB: 6` |
| 主会话已运行天数 | `rotateAfterDays: 10` |

**十二条保护（任一命中就不换，宁可不动）**：`mainRotation` 关闭、显式覆盖协调者、非 `spawn` provider、还有活跃任务、还有「已交付待确认」、待确认任务带未读产物、主会话正在跑回合、10 分钟内刚聊过（`rotateIdleMinutes`）、还有活跃子代理、未到最小龄（`rotateMinAgeHours` 12h）、冷却期（`rotateCooldownHours` 48h）、指标全拿不到（fail-closed）。采不到的指标记「未知」并按降级处理，**不按 0 算**。

**默认 `off`**：仍会检测（日志 `blockedBy: ['mode-off']`）、`due` 恒 false，但**绝不动作**——升级后不会自己换。要自动换就显式配 `mainRotation: 'auto'`；想马上试一次就把两个阈值和最小龄/冷却调低、收掉活跃任务后再打开主会话（判定结论在日志 `main.rotation.decided`）。

**风险**：① **归档不可逆**——默认 `rotateArchiveOld: true`，旧会话改名「主会话（已退役 …）」并交给平台归档，平台没有 unarchive；只想留回看入口就配 `false`（只改名）。② 换的是协调者身份、**不搬历史**，旧会话里没处理完的追问不会再回来（跟进用面板 / `task_list({view:'inbox'})`）。③ 只在打开时判定，重启/刷新/面板轮询都不触发；崩溃中间态由启动恢复补完，极端情况下旧会话可能还留在列表里。

逐条边界（指标口径、崩溃恢复、平台服务缺失的降级）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md#主会话轮换g1)，时序与日志见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#主会话轮换g1)。

### 主会话原生自动化

协调者预设挂载宿主 `@deepseek-ai/dsh-tool-schedule`，不另造调度器、不计入插件全局 10 个工具。当前契约核实于 DSH **0.2.2-rc.3**，升级宿主需复核，不能据此保证未来版本兼容。

| 原生工具 | 用法 |
|---|---|
| `schedule_create` | 必填 `title` / `prompt` / `rrule` / `target` |
| `schedule_list` | `active?` / `limit?` / `offset?` 分页查询 |
| `schedule_view` | `id` 查看最新任务 |
| `schedule_edit` | `id` + `action:'update'|'delete'`；暂停 `active:false`，恢复 `active:true`；编辑携带最新 `updatedAt` 为 `expectedUpdatedAt`（可用时） |

- **Host-wide**：能看到、按 id 管理其他会话创建的任务，不是只管理本主会话的任务。创建/修改/暂停/恢复/删除需用户明确授权；先确认目标，冲突 `schedule_conflict` 先重读，不强行覆盖。不主动清理现有自动化。授权提示是模型行为约束，不是人工审批硬门禁；日期/时间/时区不明确先问。
- **本次自动编排只支持 `target:'this_session'`**：到期唤醒唯一主会话，按已授权 prompt 调 `task_list` 核对后再 `task_create`。`new` / `new_once` 仍是原生选项，但创建普通 root 会话、继承当前目录/预设，非唯一主 id 无法直接 `task_create`，不提供第二协调者/转发桥。
- 默认 worker 不挂自动化包；自定义 worker 即使已有 schema，宿主仍返回 `subagent_session`。`access:full` 只改变沙箱，不增加工具、不绕过委派校验或审批。
- Host 必须运行；投递成功不等于子任务完成，崩溃可能重复投递，删除不会撤回已排队消息，不承诺 exactly-once。已有授权只在原范围内有效。
- 缺服务/工具时主会话会收到能力缺失提示，现有编排继续；不能模拟成功或用 shell/HTTP 绕过。缺包使预设 broken 时看 Loader 诊断并修正宿主版本/配置。安装或升级后须彻底退出再启动 DSH，刷新页面不保证生效；回滚插件不会自动暂停/删除已有原生自动化。

自然语言示例（只是请求范例，不会自行创建）：

> 请创建每天北京时间 09:00 的自动化，投递到本主会话：先查 task_list，已有同组任务在跑就只报告；否则派一个明确授权的只读检查任务。不修改已有自动化。

### 可选能力：平台 goal 与回合间 keep-alive

两者都不参与普通编排（goal 只是只读镜像，keep-alive 默认关）：

- **平台 goal（只读镜像）**：派发后把 `task_create.goal` 同步成子会话的平台 goal 并**立即 disarm**（不会自动续跑）。`task_message` 把消息并成「最新指示」并 `edit`；确认完成时 `complete`，停止/重派/失败时 `clear`。平台没有 goal 服务时静默降级。子会话用 `get_goal` 读，`task_detail` 也有创建时的目标快照。
- **回合间 keep-alive（默认关）**：`keepAlive: true` 时订阅 `agent/turn-stopping`，在回合边界给「`running` 且平台 goal 未完成」的子会话注入下一轮，轮数上限 `keepAliveMaxRounds`（默认 8）。默认 `steer`（同一回合再走一步）。它是宿主替子会话开工，不是成本控制。

## 工具清单

协调者（7 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发；支持 `dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` / `planFirst` / `access`（`'full'`）/ `worktree*` / `allowConcurrent`（显式放行同写域并发） |
| `task_list` | 活跃任务/历史任务（`active` / `group` 过滤看组进度）；`view:'inbox'` 是收件箱：待决、待确认、失败/丢失、长时间没动静 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、交付/关闭时间、最近消息、最新返回（`include:'full'` 看全文） |
| `task_message` | 子任务动作统一入口。`action:'message'`（默认）续派消息（含「待确认」上的追问，复用原会话；排队/等前置返回提示）；`action:'stop'` 停止任务（运行中/排队/等前置/待确认）；`action:'retry'` 重建 failed/orphaned（保留编排字段）；`action:'close'` 把「已交付待确认」确认成 `done`（终态） |
| `context` | 读上下文（只读）。`mode:'history'`（默认）查插件记忆、历史任务、平台历史会话；`mode:'project'` 读项目白名单文件、顶层结构、最近任务、相关记忆；`mode:'workspaces'` 看已登记工作区与仓库采样索引 |
| `memory_note` | 记一条跨任务有效的决策/经验；`kind:'preference'` 不传 `project` 时写进协调者偏好（立即生效） |
| `read_workspace` | 读产物正文：**主会话工作区内**的文件/目录，或**任务已登记**的产物（子会话产物通常写在 target 目录内）；未登记/越界/`../` 穿越/符号链接逃逸被拒；大文件按行窗口截断给续读 `offset` |

子任务（3 个）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`；可带 `question` / `options` / `artifacts`。`done` 落「已交付待确认」，等确认或追问 |
| `task_detail` | 读自己任务的创建详情（只读）：目标全文、验收、约束、背景、用户原话、工作目录与权限、前置任务、经验文件、已有产物；越权会被拒 |
| `plan_save` | 计划模式专用：把计划正文写进主会话工作区 `reports/plans/<taskId>.md` 并登记为产物（计划阶段唯一写入口） |

- 10 个工具**全局注册**，worker 预设不做工具收窄，子会话直接继承。
- `task_create` / `task_list` / `task_status` / `task_message` / `context` / `memory_note` / `read_workspace` 仅主会话可调；`task_detail` / `task_report` / `plan_save` 只对任务自己的子会话开放（`plan_save` 还要求任务是计划任务）。
- 派发给子会话的 **brief 是纯指引**（4 行：任务编号 +「先调 `task_detail`」+「执行中待确认用 blocked 上报」+「交付时怎么回报」；
  `access:'full'` 与 worktree 隔离任务各多一行，所以是 4–6 行），目标全文、验收、经验、前置、产物都不内联进提示词。
  - **执行中**遇到要用户拍板的事：`task_report blocked` 上报「问题 + 选项建议」，协调者用 `ask_user_question` 问用户后 `task_message` 续派；不自行假设、不阻塞等待。
  - **交付时**：`summary` 写「结论 + 改了什么/改了哪些文件/怎么验证的 + 待确认要点」（`done` 会清空 `question`/`options`，
    所以选项要在执行中就用 `blocked` 给出；交付后协调者不会来问「确认 / 要改？」，任务保持待确认、等超时自动完成）。
  - 子会话直接调 `ask_user_question` 会被平台以 `DELEGATED_CALLER` 拒绝，问用户始终由协调者带选项做。
  worktree 隔离任务额外多一行：检出目录没有依赖，可以执行安装命令（`pnpm install` / `npm install` / `uv sync` 等），**只安装不升级**。

### 工具迁移映射（P1-B：15 → 10）

工具面收缩到 10 个（协调者 12 → 7，子会话 3 → 3，子会话名字不变）。**旧名已删除**（不注册、不在 allow 名单里），
照旧名调用会拿到一条可读迁移提示（「已删除 + 改成什么」），不会静默失败；按这张表改一遍就能跑：

| 旧工具名 | 现在怎么调 | 备注 |
|---|---|---|
| `task_stop` | `task_message({ task_id, action: 'stop' })` | 停止任务，行为不变 |
| `task_retry` | `task_message({ task_id, action: 'retry' })` | 重派 failed/orphaned，新任务编号、旧任务留审计 |
| `task_close` | `task_message({ task_id, action: 'close' })` | 确认「已交付待确认」→ `done` |
| `task_inbox` | `task_list({ view: 'inbox' })` | 收件箱，输出与旧工具逐字一致 |
| `history_search` | `context({ mode: 'history', query, project?, limit? })` | 跨项目历史检索 |
| `project_context` | `context({ mode: 'project', target, query? })` | 项目背景；只要工作区与仓库索引用 `context({ mode: 'workspaces' })` |

名字不变的：协调者 `task_create` / `task_status` / `memory_note` / `read_workspace`，子会话 `task_report` / `task_detail` / `plan_save`（子会话契约是 in-band 的，不做改名）。

## 配置

**两种改法，等价**：① 在**插件页**（侧栏「插件」→ dsh-orchestrator 页面里的「配置」卡片）改；
② 直接编辑当前 profile 的 `cordis.patch.yml`（`id: orchestrator` 那一行的 `config`）。

| 要点 | 说明 |
|---|---|
| 保存位置 | **当前 profile** 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`），不是插件目录 |
| 生效方式 | **即时生效**：保存会触发插件重载（台账在 SQLite，不受影响；watchdog / 轮换计时器会重置） |
| 优先级 | 表单写的是 profile 层；若 home patch 或命令行 overlay 覆盖了同一字段，保存会被**拒绝**并提示原因 |
| 非法值 | 一律**回落默认**，不会让插件起不来（schema 用 `.loose()` 兜底，运行时再由 `loadConfig` 二次归一化） |
| 只读字段 | `coordinatorSession` 与 `mainRotation.*`（含 `rotateArchiveOld`）在页面上**只读展示**：它们要么是运维兜底通道，要么牵动不可逆归档，不该在表单里手滑改 |

字段规格的单一事实源是 [`src/config-fields.js`](src/config-fields.js)，schema 投影在
[`src/config-schema.js`](src/config-schema.js)，页面在 [`client/src/config-form.js`](client/src/config-form.js)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id`（页面只读） |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（生成器与说明已移出主包，见 [tools/debug-preset/README.md](tools/debug-preset/README.md)，不随 npm 包发货） |
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
| `preferencesInject` | `true` | 是否把协调者偏好段（`settings.orchestrator_preferences`）注入 L1 提示词 |
| `preferencesMaxChars` | `1200` | 偏好段字数上限，超限按优先级截断并写明被截条数 |
| `preferencesMaxItems` | `12` | 偏好段条数上限 |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |
| `sameDirGuard` | `require` | 同写域并发防护：`require`（默认，拒绝）/ `warn`（只警告）/ `off`（关闭）；见「同写域并发防护」 |
| `worktreePolicy` | `auto` | `required` / `auto` / `off`；渲染进协调者 policy，漏传时兜底 |
| `worktreeBranchPrefix` | `orch/` | 隔离任务分支前缀（默认名 `<prefix><taskId>`） |
| `worktreeRecentDays` | `7` | 「近期活跃分支」窗口（1–90） |
| `mainRotation` | `off` | 主会话轮换总开关：`auto`（判定 + 动作）/ `off`（只检测不动作）；**默认 off**，拼错回落 `off`（页面只读） |
| `rotateAfterMainLogMiB` | `6` | 主会话日志体积 MiB（0.5–4096） |
| `rotateAfterDays` | `10` | 主会话运行天数（1–365） |
| `rotateCooldownHours` | `48` | 两次轮换之间的冷却期（1–720） |
| `rotateMinAgeHours` | `12` | 最小龄，防抖（1–720） |
| `rotateIdleMinutes` | `10` | 多久没交互才算「空下来」（1–1440） |
| `rotateArchiveOld` | `true` | 轮换后是否归档旧主会话（**不可逆**）；`false` = 只改名退役 |

> **配置面 41 → 35（P1-A）**：`backend` 与 `rotateAfterTasks` / `rotateAfterSessions` / `rotateAfterContextTokens` / `rotateAfterDiskMiB` / `rotateCheckIntervalHours` 已删除。老 profile 里留着也不影响加载——启动时各给一条弃用警告、按默认值运行；逐键迁移说明见 [CHANGELOG](CHANGELOG.md#02102026-11-19)。

> **调试预设 `orch-debug`（可选安装）**：生成器与说明已移出主包，在开发仓库的 `tools/debug-preset/`（不随 npm 包发货）。
> 装一次：`node tools/debug-preset/cli.mjs` → `plugin_manager` 的 `install_bundle` → 配 `workerPreset: orch-debug` → 彻底重启 DSH；
> 回退：`workerPreset` 改回 `dsh-orchestrator-worker`（或 `plugin_manager` 的 `remove_bundle`）后重启——插件运行时只透传预设 id，不依赖这些文件。

## 状态与数据

插件只写 `$DSH_HOME/state/orchestrator/`（未设置时 `~/.dsh`）：`tasks.sqlite` 是台账，`snapshots/` 每天一份快照（保留 7 天），`logs/` 是按天的 JSONL 日志（保留 7 天），`lessons/` 放注入任务的经验文件，`reports/` 放超长返回消息的全文。

- 快照损坏时**不会自动恢复**：先备份，再用 `snapshots/` 里最新一份手工替换台账。
- 面板「删除」只删台账记录（任务/消息/通知），产物文件与记忆不删。
- 计划文档不在插件 state 里：`plan_save` 写到**主会话工作区**的 `reports/plans/<taskId>.md`。
- 目录布局与生命周期细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「落盘与日志」。

## 已知限制

**平台与沙箱**

- **委托子会话的审批固定 `never`**：子会话写被拒时**不会弹审批**，沙箱拒绝就是终局；要越过沙箱边界只能用 `access:'full'`（见上）或换 CI/人工执行。
- **插件没有命令白名单**：隔离只在「沙箱模式 / 可写根」这一层做，不对 `bash` / `pwsh` 的命令做 allow/deny；`danger-full-access` 下模型能跑任意命令，不做「假安全」。
- **构建 / 发版需要完整访问或 CI**：子会话默认写不进仓库外（Windows 上 `pwsh` 写 target 也受平台限制）；给**单条**任务 `access:'full'`，或把构建交给 CI/终端。
- 首回合可写窗口与 delegation 继承：只读/计划/完整访问都在 `agent/created` 之后设置，极短窗口内仍是继承来的模式；父会话自己是 `danger-full-access` 时平台会把该覆盖种进所有子会话（不是插件做的）。

**编排与视图**

- **同写域并发默认拒绝**（`sameDirGuard`，三条出路见上）；`dependsOn` 创建后不可编辑；**`done` 不可逆、无 reopen**——要改交付物用「待确认」追问，要新工作就新派/重派。
- 结算自动收场只覆盖「一次 activation」，上报过 progress 的回合异常结束落 `orphaned`；「最后一条回复」在插件提前卸载/进程被杀时可能缺。
- **主会话轮换归档不可逆、且只在打开主会话时判定**（见上「主会话轮换」）；判定是快照，动作前不复查。
- worktree 产物不在你的工作树里（合并由你决定）；计划文档只有一版、没有审批流 UI；会话头入口依赖宿主身份信号（刚打开 1 秒内可能不可见）；产物预览依赖宿主右侧栏，缺失时只有产物库那行回退行内预览；面板轮询 2 秒、没有 SSE；Bot 模式视图停在 Bot 会话。
- 主会话工具表可能残留团队工具（agent-scope 自注册，`restrict` 遮不到），执行层 guard 会拦。

完整清单（指标口径、崩溃恢复、平台服务缺失的降级、通知时序、面板动作幂等等）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.21.0`；**彻底退出 DSH 再启动**（刷新页面无效） |
| 插件页 / `npm i @latest` 装到旧版 | 镜像还没同步（新版本几十分钟到几小时）：过一会儿重装；急着用就换 `@wjj865-code/dsh-orchestrator@0.22.0` 显式版本；维护者侧可主动同步镜像（见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#发版)） |
| 会话头没有「任务」入口 | 只在主会话显示：确认当前会话就是侧栏「主会话」打开的；没建就点「打开主会话」 |
| 点产物「预览」没有右侧栏 | 宿主要装 `ui-sidebar-right` 与 `ui-sidebar-documentpreview`；缺了会提示「右侧栏不可用（原因）…」，产物库那一行会退回面板内预览，任务卡/抽屉只提示去产物页看或复制路径 |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页与 `logs/` |
| 提示「尚未打开主会话」 | 面板点「打开主会话」 |
| 主会话突然变成新的、旧会话变成「主会话（已退役 …）」 | 主会话轮换命中（只在你配了 `mainRotation: 'auto'` 时才会）：旧会话已归档（**不可逆**）。不想再换就删掉该配置或配 `off` 并彻底重启 DSH；只想保留回看入口配 `rotateArchiveOld: false` |
| 打开主会话后什么都没换 | 正常：看日志 `main.rotation.decided` 的 `blockedBy` 第一条（`min-age` / `cooldown` / `active-tasks` / `delivered-pending` / `mode-off`…）；采不到的指标在 `degraded` 里 |
| 想马上换一次主会话 | 没有强制按钮：配 `mainRotation: 'auto'`，调低 `rotateAfterDays` / `rotateMinAgeHours` / `rotateCooldownHours` / `rotateIdleMinutes`，收掉活跃任务后再打开主会话 |
| 子任务报 done 后一直「待确认」 | 正常：默认保持待确认等用户拍板；要收尾就 `task_message({action:'close'})`，或等 `deliveredTimeoutMinutes` 超时自动完成 |
| 任务停在「会话丢失」 | 子会话只在没报过 progress 时自动交付；上报过 progress 的回合异常结束落 `orphaned`。先用 `task_status` 看进展，需要接着做就 `task_message({action:'retry'})` |
| 提示「配置键 X 已删除」 | 老 profile 里的已删键（`backend` / 5 个 `rotate*`）：按提示删掉即可，插件已按默认值运行（迁移见 [CHANGELOG](CHANGELOG.md#02102026-11-19)） |
| 日志提示 `workerPreset` 回落 | 预设 id 只能用小写字母/数字/连字符；改值后彻底重启 |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制；确实要写仓库外用 `access:'full'` 或 CI |
| 子任务没有 `cordis_*` 工具 | 确认 `orch-debug` bundle 已装、`workerPreset: orch-debug`、已彻底重启（生成器在 [tools/debug-preset/README.md](tools/debug-preset/README.md)，不随包发货） |
| 台账损坏 | 用 `snapshots/` 最新快照手工替换 |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |

排障细节（平台缺陷、时序竞态、已知降级）见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/compat.md](docs/compat.md) | 宿主兼容基线（rc.3–rc.5）、9 类能力探测与降级、rc.3 冒烟 3 条 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 内部设计：模块划分、状态机、派发、结算、对账、面板与消息块、落盘 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 平台/沙箱/计划/worktree/通知/UI 的完整限制清单 |
| [docs/testing.md](docs/testing.md) | 测试与复核：怎么跑、门禁、断言口径、历史复核索引、真机矩阵 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 开发、构建、发版与镜像同步（维护者） |
| [tools/debug-preset/README.md](tools/debug-preset/README.md) | `orch-debug` 调试预设的生成、安装/回退与插件更新流程（开发仓库工具，不随包发货） |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本的变化与取舍 |

## License

MIT
