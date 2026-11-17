# Changelog

## 0.19.2（2026-11-17）

修一个**可触发的真实缺陷**：对**失败任务**点「停止」（面板按钮或 `task_stop`），任务会被改成「已取消」，
「失败」这个信息就丢了——用户再也看不出它是失败，也看不出该重派还是该放弃。

相对 0.19.1 是 **patch**：只改一处判据（「已收尾」vs「流程终态」），不动台账结构、工具入参、状态机与沙箱。

### 停止失败任务不再抹掉「失败」（fix(state)）

- **根因**：面板 `stop` 与工具 `task_stop` 的幂等判定用的是 `TERMINAL_STATUSES`（`done`/`cancelled`/`orphaned`，
  **不含 `failed`**——因为 `failed` 还能重派）。于是失败任务走不到幂等分支，直接落到 `transition(failed → cancelled)`；
  转移表允许这条边（「停止」确实可以从失败态发起），但语义上等于把「失败」降级成「主动取消」。
- **修法**：新增 `stopIsIdempotent(task)`（`src/panel-gates.js`）——判据是「**已收尾**」（`done`/`failed`/`cancelled`/`orphaned`），
  不是「流程终态」。面板与工具两个通道都用它：失败任务再点停止返回 `already:true`，状态保持 `failed`。
- **两个通道一起修**：`src/panel-actions.js` 与 `src/tools.js` 的 `task_stop` 是两份平行实现（审计 §4.1.2），
  只修一侧会让「面板点一下」和「协调者调一次」结果不同——这正是审计指出的分叉风险。
- **兼容性**：对失败任务点「停止」从「改成已取消」变为「幂等成功」。若有人依赖旧行为把失败洗成取消，
  现在要显式 `task_retry`（重派）或面板「删除」。
- **不做的事**：本版**不**引入状态事实源（`status-facts.js`）、不改 `RESUME_STATUS` 里的死分支、
  不删三条不可达边——那些是 0.20.0 的结构收敛，属 minor，不塞进 patch。

### 测试

新增 3 条用例（总数 941 → 944，全绿）：`stopIsIdempotent` 判据单测、面板 `stop` 端到端、工具 `task_stop` 端到端。

## 0.20.0（2026-11-17）

这一版是一次**结构性收敛**，不是新功能：把三件「同一事实在多处判定」的东西各自收成一个唯一事实源——
产物位置（`artifact-location`）、状态判定（`status-facts`）、提示词分层（`prompt-layers`）。
起因是一份全量设计审计（`reports/design-audit/dsh-orchestrator-design-audit.md`）：15 个工具、940 条测试、
零运行时依赖的实现质量高于它的**文本层**，5 天 30 个版本的节奏让「同一句口径写五遍」累积成
**能力失效**——`read_workspace` 上线首日就只覆盖 21.3% 的真实产物。

相对 **0.19.2** 是 **minor**：`read_workspace` 的读取面放宽（能力变化）、偏好机制新增配置键、onboarding 文案瘦身；
台账结构、工具入参、沙箱默认值、状态机语义（只删了三条从未可达的边）都没变。

> 本版**不含** 0.19.2 的停止缺陷修复之外的任何行为修正；那一项已在 0.19.2 单独发布（patch）。
> 本版把 `stopIsIdempotent` 的判据从手写四态改成 `status-facts` 的 `releases` 能力，行为不变。

### 产物位置：已登记产物成为唯一合法性判据（feat(artifact)）

**问题**：`read_workspace` 的边界是「主会话工作区包含性」，而子会话按契约把产物写在 **target 目录**内
（`WRITE_HINT`：所有产出只写到该目录内）。两条规则各自自洽，拼在一起才断裂——真实台账 89 条产物里
**78.7% 落在 `read_workspace` 读不到的地方**，能力上线首日即失效。同时工具描述写着「子会话产物常落在
reports/ 等目录」，模型据此反复撞墙。

**修法**：把台账里**已经存在**的 `tasks.artifacts_json` 提升为产物唯一合法性判据（审计方案 C），四条读取路径
（`read_workspace` / 面板 `preview` / 右侧栏 / `present`）从此同源：

- 新增 `src/artifact-location.js`：`registeredArtifacts(tasks)` 构造登记表、`registeredMatch(realPath, registered)`
  判定命中、`deliverableOf(path)` 统一「能不能交付」的类型判定（`notify.js` 的 `classifyPath` 改为引用它）。
- `src/read-workspace.js`：`resolveWorkspaceTarget` 增加第二个判据——工作区包含性 **OR** 已登记产物；
  已登记的**目录**放开子树（产物允许是目录），已登记的**文件**只放开它自己。
- 两条安全边界（都有测试）：① 登记表**不扩大**读取面，未登记的同目录文件仍被拒；② 登记表**不借符号链接**
  放行——登记一个指向 `~/.ssh` 的链接不等于登记了任意文件。
- 工具描述与拒绝文案改口径：说清「工作区 **或** 已登记产物」，拒绝时区分「越界（未登记）」与「不存在」。
- 读取结果头行标明来源：`【工作区文件】` / `【已登记产物文件】（任务 t-xxxx 登记）`；审计日志加 `via` 与
  `artifactTaskId` 字段。
- **存量兼容**：不需要迁移任何数据、不需要改 `WRITE_HINT`。用宿主真实台账验证：91 条仍存在的产物
  **91/91 全部可读**（19 条工作区内 + 72 条登记产物），此前只有 19 条可读。

### 状态判定：单一 caps 表（refactor(status)）

**问题**：`state.js` 有唯一转移表，但**状态集合**被复制到 9 个模块，已产生三处真实不一致：

1. `tools.js` 的 `RESUME_STATUS` 含 `failed`，面板层不含——但 `followupGate` 一直拒绝 failed，工具层那个 `failed`
   是**死分支**，表达的是错误意图；
2. 「流程终态」（无 `failed`）与「要释放资源的终态」（有 `failed`）名字几乎一样、语义不同；
3. 面板 stop 用「不含 failed 的终态」做幂等判定 → 对**失败任务**点「停止」会走 `failed → cancelled`，
   把「失败」抹成「已取消」（**已在 0.19.2 修复**；本版把判据改由 `releases` 能力表达，行为不变）。

**修法**：新增 `src/status-facts.js`，一张 `STATUS_CAPS` 表回答 13 个具体问题（`active` / `followup` / `resumable` /
`deletable` / `terminal` / `releases` / `retryable` / `waiting` / `rotationActive` / `liveness` / `catalog` /
`watchdog` / `planSettled`），其余模块全部派生：

- 删掉 13 处本地状态 Set（`tools` / `panel-gates` / `panel-actions` / `settlement` / `reconcile` / `watchdog` /
  `main-rotation` / `host-route` 内联三态 / `ledger` 的两处 SQL 字面量）。
- `ledger.js` 的活跃状态 SQL 由 `ACTIVE_STATUSES` 生成，不再手抄字面量。
- **三条不可达边已删**：`running → done`、`failed → running`、`orphaned → pending`（自加入起无调用点）。
  `test/state.test.js` 的 10×10 矩阵曾把它们写成 `allowed`——**测试在保护死代码**；矩阵现在从 `TRANSITIONS` 派生，
  另有正向用例断言这三条必须被拒。
- **修掉三处不一致**：`resumable` 与 `followup` 分开（`running` 能续派但续派不改状态）；`terminal` 与 `releases`
  分开（`failed` 只属后者）；面板与工具的 stop 幂等判定统一用 `stopIsIdempotent`（`releases` 能力）——
  0.19.2 已就地修过这个缺陷，本版只是把判据换成能力表表达，行为不变（有回归用例）。
- **迁移有审计日志了**：`transition` 是全部状态变化的唯一入口，`index.js` 通过 `setTransitionObserver` 挂一次
  `task.transition` 日志（19 个调用点里此前只有 6 个有日志）。

### worktree 状态：caps 表 + 转移校验（refactor(worktree)）

- 新增 `src/worktree-facts.js`（叶子模块，不 import 任何东西——`worktree.js` 与 `worktree-request.js` 本来就互相
  引用，表放在其中一边会撞 TDZ）：`WORKTREE_STATE_CAPS`（`occupiesTarget` / `needsCreate` / `hasCheckout` /
  `showsBadge` / `retryable` / `notifyIsolated`）+ `WORKTREE_TRANSITIONS` + `canWorktreeTransition`。
- 7 份独立列表改为查表，派生结果与原先**逐一等价**（有测试锁定）。
- `setTaskWorktree` 现在校验转移（非法抛错，同 `tasks.status` 的做法）；同状态重复写入幂等。
- 这修的是同类 bug 第二次发生的结构原因：0.17.0 的 P1「`requested` 被误当占用目录」就是 7 份列表漂移的产物。

### 提示词分层：五层职责边界（refactor(prompt)）

**问题**：同一批口径写在 5 个地方（policy 3403 字 / brief / task_detail / onboarding 708 字 / 通知 hint），
**L1 与 L4 重叠 6 条**、**L1 与通知重叠 3 条**，还有 3 处措辞互相打架。

- 新增 `src/prompt-layers.js`：`PROMPT_LAYERS` 表定义五层的**独占职责**与 `forbids`，`layerViolations(id, text)`
  是机器可读的归层探针（测试用它防止「删掉的重叠又抄回来」）。
- **L4 onboarding 瘦身 708 → 525 字**：删掉 6 条与 L1 重复的能力边界（只协调不写文件 / 原生 read-glob 被拒 /
  read_workspace 边界 / 默认 worker 无自动化 / full 只改单任务沙箱）。理由：L1 每回合都在且不会被 compaction 吃掉；
  onboarding 是一次性 user message，轮换时还会被直接标 `sent` 跳过。
- **三处矛盾已修**：① 文档不再教「交付时选项进 `question+options`」（实现明确不支持，`done` 会清空）；
  ② brief 的 `CONFIRM_HINT` 与 task_detail 的 `FINISH_HINT` 统一成「summary = 结论 + 改了什么/改了哪些文件/
  怎么验证的 + 待确认要点」，同源 `SUMMARY_FIELDS`；③ `DETAIL.md` 的 brief 行数改为「4 行基准 → 4–6 行」。
- 跨层共享口径只留一份常量：`PRESENT_LIMIT_TEXT`（1-4 个）、`DELIVERY_NOT_FINAL`（done 不是终态）。

### 偏好机制：L1 policy 第 4 段（feat(preferences)）

- 新增 `src/preferences.js`：出厂种子 2 条（`cli-access-full` / `worktree-build-access-full`）、
  `normalizePreferences`（坏数据逐条丢弃不抛）、`loadPreferences` / `savePreferences` / `upsertPreference` /
  `setPreferenceEnabled` / `renderPreferenceBlock`。
- 存 `settings.orchestrator_preferences` 单键 JSON（与 `workspace_repo_index` 同一种存法），**不需要** `ALTER TABLE`。
- 注入点是 L1 的 `systemPrompt.context().text` 回调——**每回合重渲染**，改完下一回合生效，不用重启；
  放在 policy **末尾**（阅读顺序即优先级顺序），可单独开关（`preferencesInject`）。
- 预算：`preferencesMaxChars`（默认 1200，区间 200–4000）为主约束、`preferencesMaxItems`（默认 12，区间 1–20）
  为安全阀；超限按 priority 降序保留**完整条目**，段尾写明「另有 N 条未展示」——**不静默丢弃**。
- **不双写**（审计 §5.3 待定项 2 的结论）：全局偏好只写 settings，`history_search` 查不到；项目偏好只写 memories，
  随 `task_detail` 注入子会话。`memory_note` 的返回文案会明确告知这条偏好去了哪儿、会不会生效。
- **偏好不是权限通道**：只是提示词文本，不进 config、不改 dispatch、不碰 `sandboxPolicy`；内置种子里不放任何
  「放宽安全边界」的条目（测试有正向断言）。v1 不带 `scripts/preferences.mjs`（避免第二套写入路径）。

### 文档漂移修正

- `docs/ARCHITECTURE.md`：全局工具数 14 → 15（含 `read_workspace`）；新增「状态事实源」「worktree 状态事实源」
  「提示词分层」三节；`read_workspace` 一节改为「两个判据的并集」。
- `docs/DETAIL.md`：常用工具补 `read_workspace`；brief 行数与实现对齐（4–6 行）。
- `docs/LIMITATIONS.md`：删掉「选项进 question+options」（教用户用不存在的能力），改为如实说明 `done` 不支持；
  新增「状态与提示词的单一事实源」一节。
- `README.md`：`read_workspace` 边界、brief 行数、交付 summary 口径、偏好机制各节与实现对齐。

### 测试

新增 4 个测试文件、53 条用例（总数 944 → 997，全绿）：

- `test/artifact-location.test.js`（13 条）：已登记产物可读 / 未登记仍拒 / 符号链接不放行 / 目录子树 /
  工作区优先 / 存量台账抽样（真实台账 91 条全部可读）。
- `test/status-facts.test.js`（11 条）：caps 表完整性、三处不一致的回归、静态断言「`src/` 里不再有本地状态集合」。
- `test/prompt-layers.test.js`（12 条）：五层归层探针、onboarding 瘦身、三处矛盾回归、跨层常量同源。
- `test/preferences.test.js`（13 条）：归一化、预算截断、不双写路由、出厂种子约束、配置夹取。

`test/state.test.js` 的矩阵改为从 `TRANSITIONS` 派生并新增「三条死边必须被拒」；
19 处 `transition(db, id, 'done')` 测试夹具改为 `markDone(db, id)` 走合法的
`… → delivered → done` 路径（这正是「测试锁死死代码」的清理）。

## 0.19.1（2026-11-17）

修一个视觉不统一的小问题：主会话会话头左上角的「任务」入口按钮原本带 1px 描边 + 不透明白底 +
hover 悬浮阴影，而同一排的**协调者预设标签**和**子智能体计数**都是无描边、透明底的 chip，
于是它一个人在同排里「凸」出来。

相对 0.19.0 是 **patch**：只改一条 CSS 规则（加删一条 hover 规则），不动逻辑、结构、槽位注册与台账。

### 任务入口去掉外边框（fix(ui)）

- `.orch-btn--entry` 不再自己声明 `border-color` 与 `background`，改为沿用基类 `.orch-btn` 的
  `border: 1px solid transparent` + `background: transparent`。保留 1px 透明描边是为了**不改盒模型**：
  按钮高度仍是 26px，与宿主头部 28px 紧凑控件同基线（`<button>` 默认 `border-box`）。
- 删掉 `.orch-btn--entry:hover`（原来换描边色 + 加 `--dsw-shadow-lv1`）。hover / active / disabled /
  focus-visible 四态全部继承 `.orch-btn`：hover 只换 `--dsw-alias-interactive-bg-hover` 并转文字色，
  active 再加 `scale(.985)`，disabled 降到 `opacity: .45`，focus-visible 走焦点环——都不出现描边或阴影。
- 内边距 `0 10px` → `0 4px`：10px 是给描边按钮留的呼吸位，收窄后与相邻 chip 同级（协调者标签 0/2px、
  子智能体计数 2/2px）。品牌色方块（`.orch-entry-mark`）与文字（`.orch-entry-label`）未动。
- 新增一条测试守住「不画外框」：断言该规则块里没有 `border*` / `background*` / `box-shadow` 声明、
  不再引用描边色 token、样式表里不存在 `.orch-btn--entry:hover`、内边距是 `0 4px`。反向验证过：
  把描边加回去这条用例立刻失败。

## 0.19.0（2026-11-17）

这一版给**协调者**加了一只受控的手：新增 `read_workspace`，主会话终于能直接「看一眼」子会话落在工作区的
产物正文（报告、调研、评审、`diag/` 快照），不必再派一个子任务或靠 `task_status include:'full'` 读最后一条
返回消息；同时**派发 brief 多了三段提示**，把「执行中遇阻怎么上报、交付时怎么给选项、worktree 里可以装依赖」
从口头约定变成子会话一开始就看得到的话。

相对 0.18.2 是 **minor**：新增 1 个工具（协调者 11 → 12 个，全局 14 → 15 个）、brief 行数与文案变化；
台账结构、状态机、配置键、派发/沙箱/通知链路都没动。

### 协调者受控读工作区产物（feat(coordinator)）

- 新工具 `read_workspace({ path, offset?, limit? })`，**只对主会话开放**（`requireMain`）。读的是
  `$DSH_HOME/state/orchestrator/workspace` 之下（`reports/`、`diag/`、`backups/` 等），不是全盘。
- **为什么不开放原生 `read`/`glob`**：平台的文件工具没有读路径白名单——`dsh-fs-sandbox` 只给写操作加栅栏
  （`Reads pass through untouched: every mode permits reading.`），`LocalFileSystem` 的 `cwd` 只是相对路径基准
  而非包含性边界，`glob` 直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。给协调者开原生 `read`
  等于给它一个**全盘可读**的宿主进程读者（`~/.dsh/.credentials.yaml` 也在射程内）。所以自建一条只读工作区的入口。
- **三道闸**：① 形状（空路径 / 含 NUL / `~` 开头拒绝，不做家目录展开）；② `realpathSync` 真实路径包含性
  （挡符号链接逃逸，含中间目录是链接的情况）；③ 真实路径解析失败时退回词法包含性，把「越界」与「不存在」分开报。
- **体积与截断**：单文件 > 4 MB 直接拒绝（不整块读入）；正文按行窗口返回（默认 400 行 / 上限 2000 行、
  单次 ≤ 64 K 字符），截断给 `nextOffset` 续读；单行本身超上限时只返回该行前 64 K 字符并标 `truncatedLine`，
  `nextOffset` 仍指向**下一行**。目录只列一层、最多 200 项，指向工作区外或断链的符号链接条目标 `readable:false`。
- **入参宽容**：`offset`/`limit` 收数字也收字符串（先 `Number()` 再判有限），非法值回落默认，不静默忽略。
- **审计**：`workspace.read`（只记路径/类型/体积，不记正文）、`workspace.read.rejected`。
- **不用于校验存在性**：存在性仍由插件（通知路径已 `lstat`）与子任务保证，`present` 只列真实文件。

### brief 三段提示（feat(brief)）

派发 brief 从「任务编号 + 先调 `task_detail`」两行，扩成含两段固定提示的四行（完整访问多一行【访问级别】，
隔离任务再多一行【worktree 依赖】）：

- **【执行中待确认】`blocked` 上报**：执行中遇到需要用户拍板的事（业务取舍、范围变更、不可逆操作、方案歧义），
  用 `task_report` 的 `blocked` 上报「问题 + 选项建议」，由协调者 `ask_user_question` 问用户后经 `task_message`
  续派再继续；不自行假设用户意图、不阻塞等待、不因等不到回复就跳过。**`blocked` 只是上报，不等于已获授权。**
- **【确认方式】交付时给选项**：`done` 会清空 `question`/`options`，所以待确认要点必须写进 `summary`；
  子会话直接调 `ask_user_question` 会被平台以 `DELEGATED_CALLER` 拒绝（`assertLiveRoot` 见到
  `origin === 'subagent'` 就抛），问用户始终由协调者带选项做——brief 因此不写「你去调 ask_user_question」。
- **【worktree 依赖】隔离任务可装依赖**：检出目录是全新目录，`node_modules/`/虚拟环境不在库里，
  子会话可执行安装命令（`pnpm install` / `npm install` / `uv sync` 等），**只安装不升级**（不改依赖声明与版本）。
  只在 `requested`/`created`/`reused`（`ISOLATED_WORKTREE_STATES`）出现；`none`/`degraded` 仍在原工作树、依赖齐全，不给这行。
- 字段映射收敛到 `renderBriefForTask(task)`（`src/brief.js`）：`tasks.access` / `tasks.worktree_state` 是唯一真相，
  `task_create` / `task_retry` / 面板 retry / 队列兜底四个入口共用，不再各自拼一遍参数。

### 行为说明（升级者注意）

- **协调者获得了读工作区文件的能力**：这是本版最实质的变化。范围被限制在主会话工作区，越界/`../` 穿越/
  符号链接逃逸都会被拒并留审计日志，但「工作区里本来就有的文件」都能读——包括子会话写进去的产物正文。
- **IM 外发风险（残余风险，不可配置）**：若 profile 开了 IM 双向同步（如 `@xmanrui/dsh-im`），协调者读进上下文的
  正文可能随「最终助手文字」同步到外部渠道且**不可撤回**。涉密产物不要用 `read_workspace` 读进主会话。
- **子会话在 target 目录里写的产物仍读不到**：`read_workspace` 只能读主会话工作区；仓库里的改动、worktree
  检出里的文件要子会话回报路径，或把摘要写进工作区产物。这是「只开一个受控入口」的直接代价。
- **brief 变长但不含详情**：新增的都是固定提示行，目标/验收/经验/前置/产物仍不内联，仍靠 `task_detail` 现取。
- **不需要迁移**：没有台账结构、配置键、状态机变化；升级后新派发的任务才带新 brief，已存在的任务不受影响。

### 文档

- README 增「读工作区产物（`read_workspace`）」一节（含边界表、截断口径与 IM 外发提示）、工具清单 11 → 12 /
  14 → 15、brief 三段提示说明与自检口径；四处版本号同步到 `0.19.0`。
- ARCHITECTURE 补 `read_workspace` 的分层（`src/read-workspace.js` 纯逻辑 + `src/tools.js` 身份校验/审计）与三道闸。
- LIMITATIONS 补「协调者读工作区产物」与「子会话不能直接问用户」两组边界，写明 IM 外发与只读主会话工作区的代价。
- DETAIL / qa-checklist 同步 brief 形态（两行 → 四行）与提示触发条件。

### 验证

- `pnpm test`（`pretest` 自动构建）**940 passed / 0 failed**；`pnpm run check:client` exit 0。

## 0.18.2（2026-11-17）

这一版是**一处交互补齐的 patch**：主会话回复底部那排「关联任务」chip，点下去以前只会开任务面板再弹详情抽屉，
用户以为它能跳会话。现在**有子会话的任务点一下就跳进那个子会话**（与面板行「打开子会话」走同一个宿主入口）；
**没子会话**（待派发 / 等前置 / 台账里没有 `session_id`）仍降级打开任务详情，并把「点下去会发生什么」写进
tooltip。相对 0.18.1 没有工具入参、台账结构、配置项、服务端行为变化，只有客户端 chip 的点击语义。

### chip 点击跳转子会话（feat(client)）

- 新增 `chipOpenTargetOf(task)`（`client/src/logic.js`）：`childSessionId` 有值 → `{ kind: 'session', sessionId }`，
  否则 → `{ kind: 'detail' }`。点击目标只由这一个纯函数决定，视图与 tooltip 都读它，不会再各写一份而分叉。
- 快照裁剪 `slimTask` 补上 `childSessionId` 并计入身份签名（`client/src/feed.js`）——子会话一变就触发重渲染，
  不必等台账再动一下。
- 跳转走宿主唯一官方入口 `ctx.uiWorkspace.openSession(sessionId)`，抽成 `openChildSession`；
  面板行的「打开子会话」、详情抽屉、主会话启动器与 chip 四处同一实现（`client/src/client.js`）。
- **降级两条路**：① 任务本身没有子会话 → 老行为（一次性 focus 请求 + 开面板 + 弹详情抽屉）；
  ② 宿主不认这个 id（会话已归档 / 目录已清理 / 宿主无该能力）——`openSession` 同步抛
  `sessions.retain: unknown session <id>`，客户端 try/catch 兜住后同样开面板定位，并在抽屉顶部显示一条提示：
  「子会话已打不开（原因），已改为展示任务详情」。
- **不假装能跳**：`chipTooltipOf` 追加「点击打开子会话 / 无子会话，点击打开任务详情」；`data-orch-chip-open`
  落在按钮上（测试的稳定观察点）；无子会话的 chip 用 `cursor: default`，不给「可跳转」的手感误导。
- **提示生命周期**：`createFocusRequest` 增加 `takeNotice()`——与 `take()` 同样「取走即清空」，而 `take()` 的
  返回值仍是任务 id 字符串（老契约不变）；抽屉关闭时清空，不残留到下一次打开面板。
- **测试**：点击目标判定、tooltip/cursor 分化、无子会话降级、`openSession` 抛错降级 + 提示、签名含
  `childSessionId`、chip 首帧结构（`test/client.test.js`）；`dist/` 重建（`pnpm run build` 产物随源码提交）。

### 文档

- README 四处版本号同步到 `0.18.2`（当前版本、安装命令、故障排查「确认装的是」、镜像未同步时的显式版本）。
- `docs/UI.md` §7 仍写着「点 chip 打开面板并定位」，与本次新行为不一致；本版按「发版提交只含版本文件」不动文档，
  已记为待办（另开文档单统一口径）。

### 验证

- `pnpm test`（`pretest` 自动构建）**905 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build` 通过；
  干净树里重跑 `pnpm run build` 后 `git status --short dist/` 为空（已入库产物与源码同源）。

## 0.18.1（2026-11-17）

这一版是**两处收尾的 patch**：会话头部底部那排 chip 在真实宿主里**根本不渲染**（判「最新一轮」时把
`TurnLocation` 对象当数字比），以及主会话轮换的检查**每次打开都做一遍**（读台账 + `listSnapshots` +
`stat` 会话日志）把打开拖慢——现在默认**一天最多查一次**。相对 0.18.0 没有工具入参、台账结构、既有状态机
变化；轮换只新增 1 个配置键 `rotateCheckIntervalHours`（默认 24h）。

### chip 渲染修复（fix(client)）

- **根因**：turnTail 槽位的 `owner.turn` 是 `TurnLocation` 对象（`{turn,start,end,status,steps,data}`），
  而 `snapshot.timeline.turnOrder` 是 `number[]`；旧实现直接 `order[last] === turn`，对象与数字恒不相等 →
  `isLatestTurn` 在真实宿主里永远 `false`，底部 chip 永不渲染。单测只传裸数字，正好绕过了这个 bug。
- **修法**：新增 `turnNumberOf`（`TurnLocation` 取 `.turn`，裸 number 保留兼容），`isLatestTurn` 改为字段比较；
  非法入参、空时间线不误判。
- **测试**：改用真实 `TurnLocation` + `ChatSnapshot` 形状，并加回归用例锁死「整对象比较」这一类错误；
  `dist/` 重建（`pnpm run build` 产物随源码提交）。

### 检查节流（feat(main-rotation)）

- 打开主会话的判定前先看 `settings.main_rotation_checked_at`：距上次真正检查不足 `rotateCheckIntervalHours`
  （默认 24，区间 1–168）就**整段跳过**——零采集、零判定，只留一条 `main.rotation.check.skipped` 日志；这次打开
  的固定开销从「读台账 + `listSnapshots` + `stat` 会话日志」压成一次 settings 读。
- `rotationCheckWindow()` 纯函数：首次检查 / 时钟回拨按「该检查」，到点用 `>=` 口径；间隔复用
  `normalizeRotationConfig` 归一化（非法值回落 24、越界夹到 1–168）。
- **只在「不需要换」时写检查时间戳**：`due = true` 不写（动作失败或进程崩了，下次打开还能重试），检查整体
  异常也不写。
- **三个时间参数分工别混**：`rotateCheckIntervalHours` 管「查不查」，`rotateCooldownHours`（48h）/
  `rotateMinAgeHours`（12h）仍管「换不换」——冷却期内检查照做，只是不换。
- `readRotationState` / `writeRotationState` 扩到五个键。

### 文档

- README 增「检查节流」小节（开关口径、三个时间参数分工、如何回到「每次打开都检查」、手动验证时先清
  `main_rotation_checked_at`），配置表补 `rotateCheckIntervalHours` 一行、故障排查与「已知限制」同步口径。
- ARCHITECTURE 补检查节流的执行顺序（节流 → 采集 → 判定 → 动作）、跳过日志字段与「只在 not-due 时写时间戳」
  的理由；LIMITATIONS 写明「调低阈值后可能先被节流挡一次」。

### 验证

- `pnpm test`（`pretest` 自动构建）**901 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build`
  通过；干净树里重跑 `pnpm run build` 后 `git status --short dist/` 为空（已入库产物与源码同源）。
- `chip` 回归用例覆盖：真实 `TurnLocation` 形状、`turnOrder` 尾项比较、空/非法入参；`rotationCheckWindow`
  覆盖：首次、未到点、到点边界、时钟回拨、间隔归一化，以及「due 不写时间戳」与「跳过零采集」。

## 0.18.0（2026-11-17）

这一版给主会话加**轮换**：协调者跑久了（默认 10 天 / 120 个子任务 / 会话日志 6 MiB / 上下文 15 万 token /
指挥舱日志总占用 512 MiB 等六个因子任一命中）会在**你下一次打开主会话**时换一个干净的新会话，
旧会话改名「主会话（已退役 …）」并按配置归档。判定是纯函数 + 只读采集，动作有 marker 崩溃锚点与启动恢复；
默认阈值都在「跑很久」量级，正常使用不会触发，`mainRotation: 'off'` 可完全关闭。

相对 0.17.1 是 **minor**：工具入参、台账结构、既有状态机都没动；新增 11 个配置键、4 个 settings 键
与一组 `main.rotation.*` 日志。

### 主会话轮换（feat(main-rotation)）

- **判定**：`src/main-rotation.js` 的 `evaluateRotation` 纯函数——M1–M6 六个触发因子（子任务数/子会话数/主会话日志/
  上下文 token/龄/日志总占用）+ 12 条保护（`active-tasks`、`delivered-pending`、`agent-running`、`recent-activity`、
  `min-age`、`cooldown`、`mode-off` 等）+ 冷却/最小龄；指标采不到按「未知」降级、六项全缺才 fail-closed；
  结论只进日志，不写任何 settings。
- **单点判定**：只在「打开主会话」时算一次（`main-session.openOnce` → `createRotationService.evaluate`），
  `due === true` 才动作；启动、`agent/created`、面板轮询都不判定（S4 的三处检测已回退）。
- **动作时序**：create → 写 marker → 切指针 → 写时间戳/跳过 onboarding → 新会话改名 → 旧会话改名+归档 →
  写审计+清 marker；create 失败 **零处置**、切指针失败旧会话仍可用（空白新会话归档）、后续每步只降级不回滚；
  启动时按 marker 幂等恢复（complete 补完 / abandoned 归档残留 / invalid 只清不猜）。
- **安全阀**：`rotateArchiveOld:false` 只改名退役不归档（**归档不可逆，平台无 unarchive**）；判定与动作之间不复查；
  并发 `open()` 单飞；轮换后新会话未 live 的 60 秒窗口内再打开直接交回同一 id，不重复建。
- **配置**：`mainRotation`（默认 `auto`，只认 `'off'` 关闭）+ 六个阈值 + 冷却/最小龄/闲置 + `rotateArchiveOld`，
  非法值回落默认、越界夹边界（见 README 配置表）。

### 文档

- README 增「主会话轮换」用户向说明（触发因子与阈值、十二条保护、默认策略与关闭方法、如何手动触发、归档不可逆等风险）、
  配置表 11 行、故障排查三条、已知限制一组。
- ARCHITECTURE 补模块分工、判定与保护、动作时序与回退边界、崩溃恢复四态、settings 键与日志事件。
- LIMITATIONS 补「主会话轮换」边界，重点写明**归档不可逆**、判定快照与动作之间不复查、采集降级口径、恢复的不可逆操作。

### 冒烟与验证

- 隔离冒烟（临时台账 + 桩平台动作，**不碰真实主会话**）跑通 13 项矩阵：隔离自检、not-due 零副作用（×2）、off 模式、
  open-main 命中路径、create 失败零处置、指针写失败 F3、只退役不归档、60s 窗口、崩溃恢复 complete/abandoned、
  配置归一化、纯判定契约。探针脚本是一次性验证件，不进仓库。
- `pnpm test`（`pretest` 自动构建）**892 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build` 通过。

### 升级提示

- 装新版仍要**彻底退出 DSH 再启动**（插件宿主侧代码在启动时加载，刷新页面不会换版本）。
- 升级后第一次打开主会话会**正常判定一次**：龄不到 12 小时、没有活跃任务时不会换；不想要这套机制就配
  `mainRotation: 'off'`，只想留旧会话入口就配 `rotateArchiveOld: false`。
- 旧主会话升级后不会被补做轮换，也不会补首次介绍/工作区索引任务。

## 0.17.1（2026-11-17）

这一版是**纯修复**：会话头「任务」入口的图标与文字没对齐。根因不在 flex、字号或间距算错，而是那套样式
**根本没生效**——桌面端升级插件包时，宿主会在页面存活期间热替换客户端插件（JS 重新求值），上一代构建注入的
`<style id="dsh-orchestrator-styles">` 却还留在 `<head>` 里；旧实现按 id 去重直接 return，于是 0.17.0 的新标记
（`.orch-entry-mark` / `.orch-entry-label`，0.14.1 的样式表里没有）一条规则都匹配不到，12px 的内联 SVG 便裸坐在
18px 行盒的基线上，比「任务」文字高约 2px，品牌气泡与主色也一并丢失。同排其他宿主 chip 有自己的样式，所以只有它偏。
相对 0.17.0 是 **patch**：工具入参、台账结构、配置项与既有行为都没动。

### 样式注入自愈（fix(client)）

- **按内容判定，不再按 id 一刀切**（`client/src/styles.js`）：`ensureStyles()` 发现同 id 的 `<style>` 文本与当前构建的
  样式不一致时**就地覆盖**，一致时不白写 DOM（幂等）。热替换后 CSS 自动追平 JS，不会再出现「新 JS + 旧 CSS」的混合态。
- **入口对齐规格回到样式表**（规则 0.17.0 已有，本次保证它们真的被应用）：按钮与图标块都走 flex 居中、
  `gap: 6px`、图标块 18×18、文字 12px。
- **测试**：新增两条回归 —— ① 旧样式内容不同 → 整段覆盖且不重复插 `<style>`，同一构建二次 `apply()` 不重写；
  ② 入口的 flex 居中、间距、尺寸、字号规则必须在本构建样式表里（断样式表，不只看标记）。另修一条既有断言在
  Windows 上的必挂（`test/write-guard.test.js` 的路径归一改为断不变量，不动 `src/write-guard.js` 行为）。

### 升级提示

- 装 0.17.1 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 已经在 0.17.0 上整页刷新过的人看到的是一致态（不会有错位）；本次修的是**以后再热替换**时样式跟着刷新。
  若此刻仍看到图标偏高，先整页刷新（Ctrl+R）恢复，再升级到 0.17.1。

## 0.17.0（2026-11-17）

这一版补上**同写域并发防护**：修掉一个真实事故的缺口——协调者在**同一个目标目录**并发派了两个都没开 worktree 的任务，
两个子会话同时写同一份工作树、改动互相覆盖。此前 `task_create` 的检查里 `target_dir` **从不参与冲突判定**，
`writeScopes` 只是 advisory 提示，`worktreePolicy=auto` 也没有代码分支。

相对 0.16.0 是 **minor，但含行为变更**：台账结构、状态迁移、既有工具入参都没动，但**同目录并发派任务默认被拒**——
这是本次要修的问题本身，不是顺带收紧。放宽方式见下「升级提示」。

### 同写域并发防护（feat(guard)）

- **默认拒绝**：新任务 target 与某个**活跃且未隔离**任务的 target 相同或互相包含（或两者 `writeScopes` 重叠）时，`task_create` 不创建任务，
  返回可操作错误并列出冲突任务名 + 目录。三条出路：先 `task_close`/`task_stop` 旧任务、传 `worktree:true` 隔离、或显式 `allowConcurrent:true`。
- **新增参数 `task_create.allowConcurrent`**（布尔，默认不传）：唯一显式放行开关；放行时返回里标注「并发风险」并记 `task.create.concurrent-write` 日志。
- **新增配置 `sameDirGuard`**：`require`（默认，拒绝）/ `warn`（只强警告）/ `off`（关闭，退回旧的 advisory）；非法值一律回落 `require`。
- **不受影响**：不同 target、worktree 隔离任务（`requested` 待建检出 / `created` / `reused` 都算隔离，含因 `dependsOn` 停在等前置的）、`dependsOn` 链上的前置任务、`readOnly` 任务、终态任务；`delivered`（待确认）算活跃，拒绝文案会提示改用 `task_message` 追问。
  例外：`degraded`（目标不是 git 仓库、隔离降级）仍在原工作树里写，照常占目录，拒绝文案会标注降级原因。
- **协调者 policy** 新增「同写域并发防护」段（含三条出路），避免被拒后原样重试。
- **文档**：README「同写域并发防护」+ 配置表、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/DETAIL.md`。
- **测试**：新增 `test/write-guard.test.js`（纯函数 + task_create 集成：同目录被拒、父子目录、`allowConcurrent` 放行、隔离放行、只读不参与、
  `dependsOn` 不拦、写域重叠被拒、`warn`/`off` 降级、`task_close` 后可再派、日志留痕；隔离状态口径含
  `requested` 不占原目录、`degraded` 仍占、`worktree:true` + `waiting_dep` 不阻塞同目录任务）；`test/tools.test.js` 的写域 advisory 用例改为显式 `sameDirGuard:'off'`。

### 升级提示

- **行为变更（需要你确认一遍既有用法）**：以前「同一个目标目录并发派多个任务」是可以的（`writeScopes` 只打一行提示），
  现在默认**被拒**并返回可操作错误。三条放宽路径：改成 `worktree:true`（推荐，两个任务各在独立检出里跑）、
  先 `task_close`/`task_stop` 旧任务再派、或显式传 `allowConcurrent:true`（放行后返回里标注「并发风险」，冲突自负）。
  想整体退回旧行为就把配置改成 `sameDirGuard:'warn'`（只警告）或 `'off'`（完全关闭）。
- **`delivered`（待确认）也占目录**：它还占着目标目录，要接着改就用 `task_message` 追问原会话，不要新建同目录任务。
- 装 0.17.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；版本号以 `package.json` 为唯一真源，
推 `vX.Y.Z` tag 触发 `.github/workflows/release.yml` 发布到 npm。

## 0.16.0（2026-11-16）

这一版全是**面板与入口的 UI 改造**：会话头入口按面板设计语言重做、删掉一个从来发不出请求的「追加」按钮、
产物预览改为复用宿主的会话右侧栏。相对 0.15.0 是 **minor**：没有破坏性变更——台账结构、工具入参、
状态迁移、门控判定（`canFollowup`/`canClose`/`canDelete`）与后端接口都没动，`preview` 端点也保留作回退。

### 会话头「任务」入口重做（feat(ui)）

- **视觉与面板顶栏 `.orch-brand` 同一套语言**：品牌色方块（`.orch-entry-mark`，18×18、`--dsw-radius-xs` 圆角、
  `--dsw-specific-bubble` 底、`--dsw-alias-state-business-primary` 前景）内装 `ui.js` 新增的 `menu` 内联 SVG
  （三条横线），右侧半粗文字（`.orch-entry-label`，12px）；不再用裸字符 `☰`。
- **按钮规格**：`.orch-btn--entry` 高 26px、`padding: 0 10px`、`--dsw-alias-border-l2` 描边、
  `--dsw-alias-bg-layer-1` 底、`--dsw-alias-label-primary` 半粗字；hover 换 `--dsw-alias-border-l3` + `--dsw-shadow-lv1`。
  hover/active/disabled/focus-visible 四态继承 `.orch-btn`，不重复声明。补 `aria-label="打开任务面板"`。
- 闸门不变：仍由 `client/src/gate.js` 的 fail-closed 判定控制「只在主会话显示」。

### 移除面板「追加消息」（fix(ui)）

- 旧「追加」按钮点击走 `window.prompt`，而 Electron 渲染进程把 `window.prompt` 换成抛错桩
  （`prompt() is not supported.`）——**这个入口从来没有真正发出过请求**。任务卡、抽屉底部动作条与 `messageControl`
  一并删除，`ui.js` 的 `message` 图标随之移除。
- **续派与计划批准统一走协调者 `task_message`**；服务端 `canFollowup` 门控与 `message` 端点都保留
  （快照仍下发该布尔值，只是前端不再消费）。README / ARCHITECTURE / UI 里「面板追加」的说法同步改掉。

### 产物预览复用宿主右侧栏（feat(ui)）

- **不自建预览视图**：产物库「预览」、任务卡产物路径、抽屉「产物」区块的路径，统一走
  `client.js` 的 `openArtifactPreview(path)` → `ctx.sidebarRight.openResource(address)`，由宿主的
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（`kind:'text'`）渲染 Markdown / 代码 / 图片 / PDF / Office。
- **地址拼装对齐宿主**：`logic.js` 新增 `fileAddressOf` / `fileAddressProblem`，拼
  `dsh-resource://file/session/<编码 id>/<逐段编码 path>`，与 `@deepseek-ai/dsh-util-workspace-path` 的
  `sessionFileAddress` 逐条对齐（`:` 保持字面以兼容盘符、**不 trim** 以保留 POSIX 合法首尾空格、
  非法 UTF-16 收敛成空串不让 `URIError` 冒到事件处理器）。文件预览类型只认领 `session` 作用域，所以必须带会话 id。
- **必须先切回会话**：右侧栏按 Session 挂载，面板占主栏时 `ctx.sidebarRight.mounted` 是 `undefined`，
  直接 `openResource` 会抛。顺序固定为 `selectPanel(null)` → `openResource`；**全部可用性探测都前置在切面板之前**，
  `openResource` 抛错时切回 `PANEL_ID` 再报错，保证提示落在还活着的面板上。时序不靠轮询 `mounted` 的宏任务轮数
  （早期实现的 4 轮 `setTimeout(0)` 已删）——座位没就绪就让宿主抛错、如实上报。
- **失败分四档**：`sidebar-missing`（宿主没装侧栏）/ `no-session`（拿不到当前会话 id）/ `bad-path`（路径为空或编码不出地址）/
  `host-refused`（宿主抛错，带原始 message）。**只有产物库那一行**能就地回退旧 `preview` 端点 + `previewBlock` 行内预览，
  任务卡与抽屉只提示「到产物页看或复制路径」，不假装成功。
- **不绕开「已登记产物」校验**：服务端 `preview` 端点只读本任务已登记产物，而右侧栏链路是宿主直接读文件；
  因此 `views.js` 的 `isRegisteredArtifact(path)` 在前端做等价校验，只允许快照卡片 / 产物库 / 详情抽屉三个
  服务端下发来源里出现过的路径。
- **依赖是软依赖**：`package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right` 与
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（只是加载顺序的预取提示）；客户端 `inject` 数组**不加**
  `sidebarRight`——用 `serviceOf('sidebarRight')` 现取，写进 `inject` 会变成硬依赖、服务缺失时卡住 `apply`，
  那就没有「缺侧栏 → 提示 + 行内回退」这条路了。宽度/折叠/多 Tab/窄屏全屏由宿主负责，插件不存预览状态。

### 升级提示

- 装 0.16.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 产物右侧栏预览需要宿主装了 `ui-sidebar-right` 与 `ui-sidebar-documentpreview`；缺了会在产物库那一行提示
  「右侧栏不可用（<原因>），已改为行内预览」，其余位置提示去「产物」页看或复制路径。
- **本版 UI 未经真机视觉验证**：只过了 `vite build`、`npm test`（793 条）、`npm run check:client`、槽位探针与静态核对。
  入口按钮的实际观感、右侧栏 Tab 的真实滑出与几何、深浅色主题下的观感都需要在真实宿主里手工确认（见 [docs/UI.md](docs/UI.md) §8）。

## 0.15.0（2026-11-16）

这一版给协调者接上**宿主原生自动化**（不再只是派任务），并让新建主会话**首次打开时自报能力、顺手把已登记工作区的仓库映射存下来**。
相对 0.14.1 是 **minor**：新增能力与一个只读回报契约，没有破坏性变更——台账结构、既有工具入参、状态迁移、默认 worker 工具面都没动。

### 主会话原生自动化（feat(schedule)）

- **协调者预设挂宿主 `@deepseek-ai/dsh-tool-schedule`**：`cordis.patch.yml` 只给 coordinator 加一行，allow 显式保留
  `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`；worker 预设不挂、不新增 allow。不另造调度器。
- **`index.js` 白名单同步**：`COORDINATOR_DENY` 删掉三个 schedule deny 名（原本是「缺失能力就当危险工具拦掉」的旧口径），
  文件/shell/团队/子任务专属禁止项一律不变；执行层 guard 对四工具放行。
- **协调者 policy 补真实契约**：四个工具的真实入参（`schedule_create` 必填 `title`/`prompt`/`rrule`/`target`；
  `schedule_edit` 用 `action:'update'|'delete'`，暂停/恢复用 `active:false|true`，没有独立 delete/pause 工具）、
  **Host-wide** 可见性、写操作需用户明确授权、`target:'this_session'` 自动编排边界、
  `new`/`new_once` 不是唯一主会话所以不能直接 `task_create`、`expectedUpdatedAt` 冲突保护、默认 worker 不开放、`access:full` 不增加工具。
- **缺能力诊断**：`checkScheduleCapability` 只在唯一主会话、打开/非 running 创建/idle/每轮 policy 渲染时检查
  `ctx.schedule` 与 `tools.get(name, agent)`；缺失去重 warning + policy 提示，恢复后自动消失，不改运行回合工具表、不调真实自动化 API。
  四个工具不进入 `createTools`，**插件全局工具数仍为 14**。
- **文档**：README「主会话原生自动化」、`docs/ARCHITECTURE.md`「原生自动化工具面」、`docs/LIMITATIONS.md`「原生自动化」。
- **测试**：预设挂载、preset-tools 初始/晚注册保留、白名单与诊断边界、口径一致性各一组。

### 首次打开介绍 + 工作区仓库索引（feat(onboarding)）

- **新建主会话启动一次模型轮次**：先介绍能力与权限边界，再立即派一个只读「工作区与仓库索引」子任务；
  `settings.main_onboarding:<id>` 用 CAS `pending→sending→sent` 防并发重复，**await 预设恢复成功再投递**，
  注入失败退 `pending` 并让 open 返回 `onboardingError`（HTTP 503 可见、重开可重试）。老主会话与 `coordinatorSession` 覆盖不补初始化。
- **新增 `src/workspace-index.js` + 随包 `scripts/workspace-index.mjs`**：只读扫描 **DSH 已登记**工作区，
  复用 `runGit`（`execFile`/timeout）读 `repoRoot`/`branch`/`HEAD`/`origin`/`commonDir`；remote 去 userinfo/query/fragment，
  非仓库/不存在/无权限逐项记录，**不 fetch/pull、不写文件、不新增依赖**。
- **回报契约 `task_report.workspace_index`**：仅接受该任务本人 `done` 的完整 JSON，按创建时名单校验覆盖并用名单真 title/path，
  与每任务成功标记同 `SAVEPOINT` 写入 settings 独立快照，**不覆盖手写 memories**；`project_context({workspaces:true})` 可查映射与采样快照。
- **结算兜底**：索引任务 `completed` 但缺本任务成功标记时落 `failed` 并提示 `task_retry`，防止遗漏/非法回报被自然误交付；
  普通任务与已交付只补消息的路径不变。
- **文档**：README「打开主会话」、`docs/ARCHITECTURE.md`「首次打开与工作区索引」、`docs/LIMITATIONS.md` 同名章节。
- **测试**：新增 `test/workspace-index.test.js`（扫描/脱敏/校验/回滚），并补首次打开、并发一次、投递失败重试、名单持久化回归。

### 升级提示

- 装 0.15.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 自动化四工具依赖宿主 `@deepseek-ai/dsh-tool-schedule`（契约核实于 DSH **0.2.2-rc.3**）；宿主缺该包时主会话会收到能力缺失提示，
  现有编排照常可用。升级宿主后请复核契约。
- 首次打开的介绍轮次**只在新建主会话时跑一次**，升级后历史主会话不会补跑；需要索引就自己派一个只读「工作区与仓库索引」任务。

## 0.14.1（2026-11-16）

这一版只改「怎么说」和「怎么读」：README 按**只服务使用者**重写（维护者内容移到 `docs/CONTRIBUTING.md`），
协调者预设从「默认立刻 `task_close` 确认」改成**默认保持待确认、不主动关闭**，并把 6 个文案面查出的 **13 处口径冲突**一次修干净、用测试锁住。
相对 0.14.0 **无破坏性变更**（patch）——台账结构、工具入参、状态迁移一字未动；唯一可感知的变化是「交付后默认停在待确认等用户拍板」。

### README 拆分：只写使用者要的

- **README 重写为 360 行使用者文档**：一句话定位 / 安装与升级（含「刷新页面不会换版本，必须彻底重启 DSH」）/ 快速上手 /
  状态机与交付口径 / 各任务类型 / 工具清单 / 配置 / 状态与数据 / 已知限制 / 故障排查 / 文档索引。
- **维护者内容移入新建的 `docs/CONTRIBUTING.md`（103 行）**：环境、仓库结构（模块地图）、本地开发命令、测试策略、
  发版流程（版本真源、`release.yml`、provenance、`NPM_TOKEN`、npmmirror 同步）、发布前清仓库、`dist/` 入库约定、改动边界。
- `package.json` 的 `files` 补 `docs/CONTRIBUTING.md`，保证 npm 包里 README 的链接打得开。
- 删掉过时内容：0.13 时代的「工具表 13 个」、keep-alive「与旧版逐字一致」、goal/keep-alive 各占一节的长篇历史叙述
  （压成「可选能力」两段）、「reports 文件确认存在后再 present」、「默认立刻 task_close」。

### 预设默认：交付后不自动关闭

- **协调者预设（`COORDINATOR_POLICY`）**：子任务报 `done` 后默认**保持待确认、不要主动 `task_close`**——追问窗口留着，
  用户看完结果常还要改；只有用户明确说「确认 / 没问题 / 不用再改」，或确实需要终态（派依赖它的任务、删任务、收尾）时才关闭。
  要改一律 `task_message` 追问（复用同一个子会话），一直不确认按 `deliveredTimeoutMinutes` 超时自动完成。
- **通知与视图同口径**：`DELIVERED_HINT` 不再以「确认：task_close」开头催关闭；`task_status` 交付行、`task_inbox`「待确认」栏头、
  `task_message` 追问回执、`task_report` 回执（受众是子会话，不再教它 `task_close`）全部改成「默认保持、确认才关、超时兜底」。
- **对子会话讲清语义**：`task_detail` 的收尾提示与 keep-alive 默认提示都补上「报 done 只是交付，会停在『已交付待确认』；
  收到追问就在同一会话继续，不要自行宣告任务结束」。
- 行为本身不变：超时自动完成仍默认 60 分钟兜底，协调者仍可随时 `task_close`；不想多一步可配 `deliveredTimeoutMinutes: 1`。

### 文案一致性：13 处冲突修复 + 测试锁定

- **6 个文案面、13 处**：`index.js` 预设（1）、`src/notify.js`（注释 / `PRESENT_HINT` / `DELIVERED_HINT`，3）、
  `src/tools.js`（`task_status` / `task_message` / `task_inbox` / `task_report`，4）、`src/task-detail.js`（收尾提示，1）、
  `src/keepalive.js`（默认续跑提示，1）、文档（`docs/DETAIL.md` 补「两段式交付」/`task_close`/`delivered` 可追问，1；
  `docs/ARCHITECTURE.md` 错字与旧版对比句，1；`README.md` 整篇重写，1）。
- **present 口径归一**：通知正文与注释里的「1-2 个最关键的」改为「1-4 个最关键的」（与 0.13.1 起的偏好一致）。
- **新增 `test/copy-consistency.test.js`（8 条）**：锁「口径」不锁措辞——`done` 不是终态、协调者默认不主动 `task_close`、
  追问复用原会话、present 1-4、brief 不越权定义交付语义、README 不写维护者内容；并用冲突正则
  （`默认立刻 task_close` / `done 即结束` / `自动关闭` / `1-2 个最关键`）防止改回去。
- **测试**：`npm test` **775/775**（0.14.0 基线 767 + 新增 8）。

### 升级提示

- 装 0.14.1 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 行为差异只有一条：任务交付后默认停在「已交付待确认」，等你确认或用追加消息提修改；不需要这个窗口就配 `deliveredTimeoutMinutes: 1`。

## 0.14.0（2026-11-16）

这一版把「交付」和「完成」拆成两段（`delivered` → `done`），并补上两个长期缺口：计划模式终于能把计划落盘成交付物（`plan_save`），构建/发版类任务可以只对**单条任务**放开沙箱（`access:'full'`）。
相对 0.13.2 无破坏性变更（minor）——不开 `planFirst` / `access` 的任务行为不变，存量 `done` 任务一个字段都不动。
行为上唯一需要协调者记住的差别：**子任务报 `done` 后任务先停在「已交付待确认」**，要协调者 `task_close` 确认（或等超时自动完成）才落 `done`。

### 两段式终态：交付（`delivered`）→ 确认（`done`）

- **新状态 `delivered`（已交付待确认）**：`task_report({ status:'done' })` 与「子会话自然结束」的结算都先落 `delivered`，不再直接 `done`；中断/异常仍直接 `cancelled` / `failed` / `orphaned`（两段式只改「自然交付」这一条路）。新增台账列 `delivered_at`（超时判据）与 `close_reason`（`coordinator` / `timeout`，审计与面板展示），旧库 `ALTER TABLE` 补列，存量行都是 `NULL`。
- **新工具 `task_close`（仅主会话）**：把 `delivered` 收成 `done`（`close_reason=coordinator`）。与面板「确认交付」共用 `closeDelivered()`，副作用顺序统一：迁移 + 审计消息 + 释放可写根 + goal `complete` + 检出清理 + 队列补位；已 `done` 的重复确认按幂等成功返回（「无需重复确认」），非 `delivered` 返回 `CLOSE_NOT_DELIVERED` / 已是终态返回 `CLOSE_TASK_ENDED`。
- **追问复用原会话**：`delivered` 上 `task_message`（或面板「追加」）投递成功 → 任务回 `running`、**同一个子会话**继续跑（可写根与平台 goal 都**不**提前收），完成后再次交付；投递失败保留 `delivered`（只记原因，不降级成 `waiting_user` / `failed`，交付结果不丢）。
- **超时自动完成**：新增 `createDeliveredSweeper()`（`src/delivered.js`），每分钟扫一次 `delivered`，超过 `deliveredTimeoutMinutes`（新增配置，默认 60，1–1440）自动 `done` + `close_reason=timeout`；启动时先扫一次（覆盖进程停机期间过期的任务），timer `unref()` 不阻止退出。
- **状态机与视图**：`delivered` 计入活跃任务与收件箱（`task_inbox` 单独一栏「待确认」）、不进历史列表；依赖就绪只认 `done`（`delivered` 会短暂挡住下游，确认/超时后晋升）；keep-alive、可写根释放、goal 收口都只对真终态生效。`task_status` 给「交付：已交付待确认（如何确认 / 追问 / 超时阈值）」与「关闭：协调者确认 / 超时自动完成」；`task_list` 给「·待确认」与组进度「待确认 N」；面板任务卡有「待确认」小标、抽屉有交付时间/关闭原因与「确认交付」（两步确认，`canClose` 门控）。
- **通知**：交付通知带动作指令「确认：`task_close <编号>`；要改：`task_message` 追问原会话（不新建任务）；不确认则按超时自动完成」；重复的 `done` 回报不再发第二条通知、不重复沉淀记忆。
- **修复（B1「最后一条返回消息」时序）**：`task_report done` 会先把状态推到 `delivered`，本回合结束时到达的结算一直被「只改 `running`」的闸门挡掉，导致**真实台账里所有经 `task_report done` 收尾的任务 `last_message` 全为空**（存量 104 条 `done` 全缺）。现在 `delivered` / `done` 上到达的结算只**补写** `last_message`（不动状态、不发通知、不写 settle 行、不释放会话），短消息内联、超 64 KiB 落 reports 文件只留路径 + 摘要。

### 计划落盘（`plan_save`，计划阶段的唯一写入口）

- **新工具 `plan_save({ task_id, content })` + `src/plan-doc.js`**：计划模式子会话把计划正文（Markdown：目标 / 步骤 / 要改的文件 / 验证方式 / 待拍板问题）写进**主会话工作区**的 `reports/plans/<taskId>.md`（目录自动创建，文档头带任务名/编号/目标/落盘时间），写完自动登记为任务产物——通知、`task_status`、面板抽屉都从台账产物读，不另开视图。
- **没有自定义路径**：只收任务编号，路径由插件拼；编号形状白名单（`^t-[0-9a-z]{4,32}$`，`..`、`/`、`\`、盘符、换行、NUL 全部不合法）+ `relative()` 目录包含性校验两道闸，校验发生在 `mkdir` / `writeFile` **之前**（被拒不留空目录、不写半截文件）。正文上限 200000 字、空正文拒绝（不静默截断）；重复保存覆盖同一份（只留一版，无版本对比/审批流 UI）。
- **谁能写**：只有任务自己的子会话（与 `task_report` 同口径）且任务本身是 `planFirst`；普通任务被告知「直接写到自己的工作目录」；别的子会话越权拒绝；协调者侧 `COORDINATOR_DENY` + 执行层 guard 硬拦。
- **planFirst 交付流程改写**：只读探索 → `plan_save` 落盘 → `task_report blocked` 只上报 **3–8 行摘要 + 计划文档绝对路径 + 待拍板清单**（不再把计划正文塞进 500 字上限的 `question`）→ 用户批准后 `task_message` 续派执行；`PLAN_FIRST_DETAIL` / `EXIT_PLAN_MODE_DENIAL` / `task_create` 返回提示同步改写，`task_detail` 直接渲染同一份说明。
- **协调者提示（`COORDINATOR_POLICY`）**：新增硬规则「向用户汇报任务时用任务名（可附编号），不只甩 id」；planFirst 那条改成「先 `plan_save` 落盘 → 摘要 + 路径」。
- **沙箱语义不变**：`plan_save` 是插件在宿主进程写固定路径，不是给子会话开写权限；只读沙箱对 `write` / `edit` / `pwsh` 的拦截一字未改。

### 完整访问任务（`task_create({ access: 'full' })`）

- **per-task 放宽沙箱**：`access: 'full'` 只给**这一条任务**的子会话 append 一条 `sandbox/mode { mode:'danger-full-access', source:'delegation' }`，复用只读任务的同一条注入路径（`agent/created` 时早注入压掉首回合窗口 + 激活返回/续派时幂等补设，已有则跳过）。用途只有一个：构建 / 发版 / 装依赖 / 写仓库外目录这类确实要越过默认沙箱边界的任务。
- **默认一点都不动**：不传 `access` = 完全沿用会话策略（不 append 任何事件、不改部署默认、不碰父会话、不碰其他任务）；台账 `access` 为 `NULL`。
- **只接受 `'full'`**：`'workspace-write'` / `'read-only'` / `'true'` / `true` / 数字等一律创建期报错并提示，不静默降级（「以为放开了、其实没放开」比报错危险）。与 `readOnly` / `planFirst` **互斥**（创建期拒绝）；与 `worktree` 不冲突（目录隔离 vs 权限放开是两件事）。team 后端给可读拒绝。
- **不继承、可观测**：`access` 不写进配置/默认值、不往孙任务传；重派（`task_retry` / 面板重派）与面板追问沿用原任务的 `access`。台账新增 `tasks.access` 列（旧库 `ALTER TABLE` 补列，非 `'full'` 一律归一成 `NULL`）；brief 第二行「【访问级别】完整」、`task_detail` 「访问级别：完整（danger-full-access…）」+ 任务边界纪律（只读/计划阶段压过 full）、`task_status` / `task_list` 文案、通知标题「（完整访问）」、`task.create.created` 审计字段。
- **新增 `scripts/verify-access-full.mjs`**：离线跑**生产代码**（台账 → brief → 派发参数 → 会话沙箱事件 → 通知）核对整条链，不用真派子会话也能看出「只对这一条任务 inject、其他会话 0 条」。

### 测试与构建

- **测试**：`npm test` **767 条全绿**（0.13.2 基线 723，本版 +44）。新增 `test/delivered.test.js`（9）、`test/plan-save.test.js`（8）、`test/access-full.test.js`（6），并补齐 ledger / dispatch / tools / settlement / notify / task-detail / brief / panel-* / client 等回归。
- **构建**：`client/src/**` 改了交付相关 UI（`确认交付` 按钮、`待确认` 小标、详情「交付」「关闭」行），`dist/client.js` 与 `.map` 由 `vite build` 重建（`pretest` 自动跑），`npm run check:client` 通过。
- **文档**：README 新增「两段式终态（交付 → 确认）」「完整访问任务（per-task access:'full'）」两节、重写「计划任务」为四步流程（含工具表、数据位置、安全边界），并发版/配置/排障/已知限制同步；`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/UI.md`、`docs/qa-checklist.md`、`cordis.patch.yml` 同步。

## 0.13.2（2026-11-16）

计划任务这一版的收尾修复：`planFirst` 不再因读不到平台计划服务而整单创建失败；任务 blocked 后答问续派会把**原会话**拉回「进行中」；只读任务续派时回执如实写明仍只读。相对 0.13.1 无破坏性变更（patch）——不开 `planFirst` 的任务行为不变。

### 计划任务（P8 修复）

- **`task_create({ planFirst: true })` 不再整单失败**：某些 profile 下平台把计划模式装在每个 agent 预设的隔离作用域里，插件读不到就报错、任务直接落 failed，只能退回只读任务。现在读不到计划服务只降级成「只有只读沙箱」并 warn 一行，创建与批准照常。
- **批准即在同一会话继续**：计划任务 `task_report blocked` → 用户答问 → 协调者 `task_message`（或面板「追加」）→ 原会话由只读切回可写并继续执行，不新建会话；计划服务不可用时也照切可写。
- **blocked 续派复用原会话**：`task_message` / 面板「追加」对「等你确认」的任务投递成功后回到「进行中」、清空待确认问题、在原会话继续（原有行为，本次补回归测试锁住）。要「接着跑」请续派；`task_create` / `task_retry` 必然新开会话。
- **只读任务续派如实提示**：`readOnly` 任务 blocked 后答问续派，回执会写明「子会话仍是 read-only 沙箱、写操作会被拒」，并给两条出口（新派可写任务 / 下次用 `planFirst`），避免把「投递成功」误解成「已切可写」。
- **已知限制（未变）**：`readOnly` 任务续派不会转可写（只读契约保持）；计划服务彻底不可用时，计划阶段的硬拦只剩「只读沙箱」，`exit_plan_mode` 仍被拒，请用 `task_report blocked` 上报计划。
- **测试**：新增 5 条回归（服务不可见时降级、预设隔离域读取、批准仍切回可写、blocked 续派复用原会话且不新建、只读续派回执明示仍只读），当前 `npm test` 723 条全绿。

## 0.13.1（2026-11-16）

### 偏好内置（present 默认交付）

- **`present` 默认交付偏好写进协调者提示**：`index.js` 的 `COORDINATOR_POLICY` 里 present 那条改写成
  「子任务回报产物路径后，默认用 present 展示 1-4 个最关键的产物（最多 4 个；只列真实存在的文件、写绝对路径），
  不必等用户点名；没有产物就不提 present；不要自行 stat/read 校验存在性（协调者的 read/glob 已被 deny，
  插件与子任务负责确认），present 只声明交付、不读文件内容。」
- **为什么改**：旧句的触发条件是「子任务完成、`reports` 文件确认存在后」，而协调者的 `read` / `glob` 本来就被 deny，
  它无法自查文件存在性——结果要么漏交付，要么先撞一次被拒的工具调用才肯交付。新句把存在性判断交回插件与子任务，
  协调者只按回报的产物路径交付。
- **范围**：只改这一句措辞；工具挂载、`COORDINATOR_DENY`、guard、执行逻辑与面板一律未动，无破坏性变更（patch）。

## 0.13.0（2026-11-15）

通知与产物回流闭环（T6）+ 客户端源码化与 vite 构建（P7）+ 子任务计划模式（P8）+ 子任务 worktree 隔离（P9），
另修 0.13.0 UI 冒烟发现的 F4：面板「隔离」小标没接线，台账里一旦出现 worktree 任务整块面板变白。
相对 0.12.0 无破坏性变更（minor）——不开 `planFirst` / `worktree` 的任务行为不变，只是面板与 `task_status`
多了计划/隔离两种小标。

### 交付闭环（T6：通知与 `task_status` 带产物 + present 交付指令）

- **通知产物按可交付性过滤**（T6.1）：`src/notify.js` 的产物区块只列 present 接得住的候选（`lstat` 判普通文件 +
  绝对路径），目录 / 符号链接 / 不存在 / 相对路径跳过并计数（「另有 K 条产物不能交付（目录 1、不存在 1）」）；
  候选上限 4，超出折叠成「另有 N 条产物未列出」。
- **交付指令一条**：单条 done、合并 done、`blocked`/`needs_auth` 打断三条投递路径都写「在你自己的回合里调用
  `present`，`files` 填上面这些绝对路径」；无可交付候选时不写指令（不诱导一次必然失败的 present）。
- **`task_status` 产物区块**（T6.2）：`产物：共 N 条（可交付 M 条）` + 可交付绝对路径 + 不可交付按类型计数，
  与通知**共用同一个渲染函数** `artifactLines()`（不是两处各写一份）；无产物时零字样。
- **结算通知带产物（D5）**：`settlement.notify()` payload 总带 `artifacts`；新增 `beforeNotify(task, status)` 钩子排在
  `transition → lastMessage → beforeNotify → notify` 上，`index.js` 把产物收集改接该钩子（通知拿到补齐后的台账行）；
  钩子抛错只记日志，不回滚终态、不阻塞通知。

### 构建（P7：客户端源码化 + vite）

- **vite 构建脚手架**（T7.1）：`vite@7.3.8` pin 成唯一新增 devDependency；`npm run build` → `dist/client.js`
  （iife classic script，只有一个 `window.__ModuleLoader__.load`，不含 react）；`pretest` 自动构建、`check:client`
  校验产物；`test/client-build.test.js` 把「无顶层 import/export」「`__ModuleLoader__.load` 且 id = 包名」
  「源码不许引 react」三条契约钉住。
- **源码迁入 `client/src/**`**（T7.2）：2283 行手写 `client.js` 拆成 10 个 ESM 文件（入口 / styles / logic / api / 组件），
  `STYLE_TEXT` 落到 `client/src/styles.css` 用 `?inline` 构建期内联，旧代码逐字保留；`exports["./client"]` 与 `files`
  切到 `dist/`，根 `client.js` 删除（`npm pack` 里只剩 `dist/client.js`）；两次构建产物字节一致、map 里 `sources`
  全为相对路径。

### 计划模式（P8）

`task_create({ planFirst: true })` 让子会话以**计划阶段**起步：只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）。
子会话只读探索后用 `task_report blocked` 上报计划；用户批准后协调者 `task_message`（或面板「追加」）续派，
插件在投递成功且任务回到 `running` 之后切回 `workspace-write`、关闭 plan mode。不开 `planFirst` 的任务行为不变。

- **`task_create` 新增 `planFirst`**：只认显式 `true`；与 `readOnly` 互斥（创建期拒绝并给可读原因）。
- **台账两列**：`plan_first`（0/1）+ `plan_state`（`none` / `planning` / `approved` / `rejected`），
  旧库逐列 `ALTER TABLE` 补；计划任务在 `planning` 状态进终态收口成 `rejected`，已 `approved` 的保留。
- **派发进入**：复用 `ensureReadOnly`（`agent/created` 先设 + 激活后幂等补），再用子 agent 作用域的
  `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode；`planMode` 服务缺失只 warn，降级为「只有只读沙箱」；
  计划任务批准前不注册 target 可写根。
- **`exit_plan_mode` 拒绝**：在子会话 **agent 作用域** 装 `agent.ctx.tools.guard`（插件根的 guard 是全局的，会误伤协调者），
  文案指向 `task_report blocked`；协调者与其它会话不受影响。
- **批准退出**：投递成功 + 回到 `running` 后 `sandbox/mode → workspace-write` + `planMode.set(agent,false)` +
  补登记 target 可写根；投递失败路径不碰 plan 状态。
- **视图**：`task_list` 「·计划中」、`task_status` 「计划：」行、`task_detail` 计划阶段说明（只读是预期）、
  快照/详情下发 `planFirst`/`planState`、面板任务卡「计划中」小标 + 「计划·…」chip + 抽屉概览「计划」行；非计划任务无任何计划字样。
- **文档**：README「计划任务」、`docs/ARCHITECTURE.md`「计划阶段（P8）」、`docs/LIMITATIONS.md`「计划阶段（P8）」、
  `docs/UI.md` 概览行、`docs/qa-checklist.md` §35 复核矩阵。
- **测试**：新增 `test/plan-mode.test.js` 26 条（映射/台账/工具/派发/面板/客户端），当期 `npm test` 672 条全绿。
- 发版：随 0.13.0 一版打包（原计划 0.13.0 / 0.14.0 分批发改为一版）。

### 隔离（P9）

`task_create({ ..., worktree: true })` 时插件在宿主进程建 `git worktree`，子会话在检出目录
（`<repo>/.agents/worktrees/<taskId>`）里干活；分支留在你的仓库、**合并由你决定**。不开 `worktree` 的任务行为一字不改
（一次 git 都不调）。

- **结构化声明只有两处**（零自然语言解析）：profile 配置 `worktreePolicy` / `worktreeBranchPrefix` /
  `worktreeRecentDays`，与 `task_create` 的 `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` /
  `worktreeCleanup`。插件不读 `AGENTS.md`、不解析自然语言、不缓存指令文件（v2 删除 v1 的 `worktree-policy.js` 方案）。
- **职责切分**：DSH 注入用户级/工作区级指引 → 协调者判断「要不要建 / 基线 / 分支名」（policy 文本里给了三条件引导
  与 `ask_user_question` 闭环）→ 插件只做校验 + 执行。`AGENTS.md` 里的要求仍有效，路径是「注入 → 协调者读懂 →
  传 `worktree:true`」；要硬保证就配 `worktreePolicy: 'required'`（漏传也兜底建，来源标 `config`）。
- **新增 `src/worktree.js`**：宿主侧 git 能力（`probeRepo` / `create` / `remove` / `ensureExcluded` / 分支名校验 /
  `prepareTaskWorktree` / `cleanupTaskWorktree` / `retryWorktreeOf`），7 类失败分类（`NOT_A_REPO` / `BASE_NOT_FOUND` /
  `BRANCH_INVALID` / `BRANCH_EXISTS` / `PATH_EXISTS` / `GIT_MISSING` / `FAILED`），全部走 `execFile`（不经 shell）。
- **新增 `src/worktree-request.js`**：结构化请求校验 + 机械映射（§4.5 全表）+ 全部展示文案（纯函数）。
  多分支时返回 `needsBranchChoice` 且**不落库**；基线与分支名缺省值由插件填（不算判断）。
- **台账七列**：`worktree_path` / `worktree_branch` / `repo_root` / `worktree_base` / `worktree_mode` /
  `worktree_source`（`task`/`config`/`default`）/ `worktree_state`（`none`/`requested`/`created`/`reused`/
  `degraded`/`rejected`/`failed`/`cleaned`），旧库逐列 `ALTER TABLE`。
- **派发接线**：`queue.pump` 在 spawn 前建树（或复用），`target_dir` = 检出目录 + 原 target 相对 `repoRoot` 的偏移，
  可写根天然覆盖；`.agents/` 写进 `.git/info/exclude`；非仓库降级、建树失败标 `failed`（不静默降级）。
- **清理三档**：`off`（默认全保留）/ `checkout-only`（只删检出）/ `full`（连分支一起删，未合并提交会提示）。
- **视图**：`task_status`「隔离：」行、`task_list`「·隔离」、通知「产物在分支 X 的检出目录 Y，合并由你决定」、
  面板「隔离」小标 + 「隔离·…」chip + 抽屉「隔离」行；普通任务零隔离字样。
- **文档**：README「隔离任务」、`docs/ARCHITECTURE.md`「worktree 隔离（P9）」、`docs/LIMITATIONS.md`
  「worktree 隔离（P9）」、`docs/qa-checklist.md` §36 复核矩阵。
- **测试**：新增 `test/worktree.test.js` 26 条 + `test/worktree-request.test.js` 19 条，当期 `npm test` 717 条全绿。
- 发版：随 0.13.0 一版打包（原计划 0.13.0–0.16.0 分批发改为一版）。

### 修复（F4：面板「隔离」小标未接线会让整块面板变白）

- **根因**：`client/src/views.js` 从 `createViews({…})` 参数里解构 `WORKTREE_STATE_LABEL` / `WORKTREE_SOURCE_LABEL`，
  但 `client/src/client.js` 既没 import 也没传，两个值恒为 `undefined`；台账里只要有一条 `worktree_state != 'none'`
  的任务，卡片渲染就抛 `TypeError`，`main` 槽位被宿主错误边界清空（面板全白）。0.13.0 UI 冒烟第 4 项（F4）发现。
- **修复**：`client.js` 补 import 与传参；`views.js` 两处使用点改成 `WORKTREE_STATE_LABEL?.[…]` /
  `WORKTREE_SOURCE_LABEL?.[…]`，文案表缺失或服务端新增枚举时退化成原始值、不再打死面板。
  `dist/client.js` 由 `vite build` 重建（未手改产物）。
- **回归**：`test/client.test.js` 新增 1 条（+67 行）：喂 `worktreeState:'created'` 快照断言卡片出现「隔离·已隔离」、
  抽屉「隔离」行状态/分支/检出/决定者四段齐全；未知状态 `weird-state` 断言不抛错并退化成原始值；`none` 任务零「隔离」字样。
  真机复测（dsh-dev 临时宿主 + headless Chrome/CDP）：`.orch-shell` 1、122 张卡片、console 0 error。
  发版前 `npm test` **718 条全绿**（717 + 本条回归）。

## 0.12.0（2026-11-15）

面板门控 + 删除任务/子会话 + 发版后镜像同步固化：新增 `src/panel-gates.js` 做唯一的「能否续派」判定，面板与 `task_message`
共用同一套状态门控（只有可续派状态才显示「追加」）；面板任务卡与详情抽屉新增「删除」，仅终态可用、复用内联二次确认并级联清理台账；
发布链路把 npmmirror 镜像同步固定成 `release.yml` 最后一步（`continue-on-error`），并补 `npm run mirror:sync` / `npm run mirror:check`
手动兜底。相对 0.11.0 无破坏性变更（minor）。

### 面板优化（续派门控 + 删除任务/子会话）

- **追加消息按状态门控**：新增 `src/panel-gates.js` 作为唯一判定（`followupGate`），面板动作与 `task_message`
  共用；`snapshot` / `detail` 下发 `canFollowup`，`client.js` 只读字段渲染。只在 `running` / `waiting_user` /
  `waiting_auth` 且已有子会话时显示「追加」；终态、等前置、待派发、失败任务都不再显示。
  失败任务新增 `MESSAGE_NOT_FOLLOWABLE`（提示改用重派），避免消息投进死会话。
- **新增删除任务/子会话**：面板任务卡与详情抽屉的「删除」只在终态（`done` / `failed` / `cancelled` / `orphaned`）
  显示，复用停止的内联二次确认（确认删除 → 取消）；活跃任务不显示并提示先「停止」。
  后端 `endpoint: 'delete'` → `panel.delete`：活跃任务 `DELETE_TASK_ACTIVE`，还有活跃下游依赖
  `DELETE_HAS_ACTIVE_DEPENDENTS`；成功时台账级联删除 `tasks` + `messages` + `notifications`，
  返回 `deleted:{messages,notifications}`。产物文件、`reports/` 正文、`memories` 保留；平台子会话历史没有删除 API。
- **测试**：新增 `test/panel-gates.test.js`（门控矩阵）并补 panel-actions / host-route / ledger / tools / client
  用例（渲染门控、二次确认、级联清理、活跃/下游拦截）；`npm test` 626 条全绿。

### 流程（发版后镜像同步，固化进发布链路）

- **主动触发 npmmirror 同步**：新增 `scripts/mirror-sync.mjs`（`npm run mirror:sync` / `npm run mirror:check`）——
  先查镜像 `dist-tags.latest`，缺版本就 `PUT /-/package/{name}/syncs` 触发回源再轮询到出现；
  上游 npm 没这个版本时直接报错退出（不同步空气），镜像已有则幂等退出 0。`--no-wait` 只触发，`--timeout/--interval` 调等待。
- **release.yml 加「触发 npmmirror 镜像同步」步骤**：Publish 之后触发同步并轮询约 3 分钟，
  `continue-on-error` + 超时 `::warning::`，镜像慢了不把发布判红；文件头把这一步写进发布流程注释。
- **README 发版章节**新增「npm 发布后：触发 npmmirror 镜像同步」小节（自动/手动两条路、syncs 接口的 scoped 编码、
  幂等与上游校验、同步完的验收），排障表补「装到的是旧版」一行。
- **踩坑记录**：`npm view --registry=https://registry.npmmirror.com` 会命中本地 npm 缓存（曾显示旧 `latest` / `404`），
  要用 `--prefer-online` 或直接看 HTTP 才准；`npm run mirror:check` 发真请求，不受缓存影响。
- 0.11.0 的补同步已于 2026-11-15 完成：syncs `id=6af9638ec819a802c9ff64c1`，镜像 `latest` 由 0.10.0 → 0.11.0
  （`dist-tags` 与 `-0.11.0.tgz` 均验证通过），细节见 `reports/mirror-sync-0.11.0.md`。

## 0.11.0（2026-11-15）

回合间 keep-alive + 子会话读任务详情 + 任务入口仅主会话可见 + 面板/详情 UI 重做：K2 让子会话在回合边界接着跑（带台账轮数预算、默认关、与 S1 结算去重），
T1 给子会话一个只读 `task_detail` 并把 brief 收成两行指引（经验改存记忆文件指针），U1 把会话头「☰ 任务」入口限定给主会话（fail-closed 闸门 + `session-role` 端点），
U2 用宿主 DeepSeek 设计 token 重做任务面板与详情抽屉（三段式布局 + 抽屉详情 + 骨架/空态/错误态）。相对 0.10.0 无破坏性变更（minor）。

### 变更（U2 面板/详情 UI 重做：DeepSeek 风格 + 三段式 + 右侧抽屉）

- **三段式布局**：任务面板拆成 ① 顶部命令栏（标题、主会话状态点、搜索框、刷新、打开主会话）
  ② 中部工作区（左侧筛选轨带计数徽标 + 任务卡列表 / 产物库）③ 右侧详情抽屉。
  抽屉常驻挂载、`data-open` 驱动 `transform` 滑入滑出，遮罩点击、关闭按钮、`Esc` 都能收起。
  窄屏（≤860px）筛选轨转横向条、指标两列；≤640px 抽屉铺满。
- **DeepSeek 风格 token 落地**：`client.js` 新增 `STYLE_TEXT` 样式表（第 76 行起）与 `ensureStyles()`
  运行时按 `#dsh-orchestrator-styles` 去重注入；颜色/圆角/阴影/动效全部取宿主设计平台 token
  （`--dsw-alias-bg-layer-*`、`--dsw-alias-label-*`、`--dsw-alias-border-l*`、`--dsw-alias-state-*`、
  `--dsw-alias-card-fill*`、`--dsw-radius-*`、`--dsw-shadow-lv1`、`--dsw-elevation-prominent`、
  `--dsw-focus-ring-color`、`--ds-transition-duration*`、`--ds-ease-in-out`），深浅色跟随宿主自动切换。
  **顺带修 bug**：旧代码用的 `--dsw-alias-color-*` 在宿主 token 表里不存在（一直走 fallback、深色下发脏），
  已换成 `--dsw-alias-state-*` / `--dsw-alias-label-*` 语义 token，测试用 `doesNotMatch` 守住。
- **现代化交互**：卡片/按钮/指标/区块 hover 与按下反馈；抽屉滑入、区块 `0fr↔1fr` 折叠动画（chevron 旋转）、
  `@keyframes orch-slide-in` 内容入场、`@keyframes orch-shimmer` 骨架闪光；首帧 5 张骨架卡、产物库/抽屉各有骨架；
  空态（无任务/无匹配/无产物/无消息/无前置/无下游/没有 brief/没有返回消息）与错误态（快照「台账暂不可用」+重试、
  动作错误带错误码、产物加载失败+重试、抽屉「重新加载」、预览失败）；「停止」改内联二次确认（确认停止/取消），
  不再用 `window.confirm`；`aria-expanded/aria-pressed/aria-hidden`、`:focus-visible` 焦点环、
  `prefers-reduced-motion` 关闭动效；顶栏搜索按标题/编号/目录过滤。
- **详情抽屉**：7 个可折叠区块——概览、最新回复（B1）、Brief（验收/约束/背景/用户原话改成结构化列表）、
  目标状态（G1，只读）、消息（投递三态）、依赖（上下游）、产物（复制路径）；底部动作条：停止/重派/追加消息/打开子会话。
- **B1 增补**：`src/panel-actions.js` 的 `detail` 回传 `task.lastMessage`（内联正文或摘要+报告文件路径），
  抽屉「最新回复」区块直接展示子会话最后一条 assistant 消息；没有回复时是 `null`（走空态）。
- **保留功能**：A3 面板动作（stop/retry/message 的错误码、幂等 `already` 提示、在途合并、`clientRequestId`）、
  A4 产物库（`artifacts`/`preview` 端点、按项目/日期分组、复制路径、打开子会话、文本预览 64 KiB）、
  B1 最新回复、G1 目标状态只读区块、U1 任务入口仅主会话可见（闸门与侧栏「◈ 主会话」不变）。
- 测试：`test/client.test.js` 新增 6 条（三段式结构、token 清单、交互清单、样式表自检（括号成对 + class 与规则对齐）、
  纯函数 `countTasks/matchesFilter/matchesQuery/groupArtifacts/artifactDate/artifactProject` 与语义色、面板首帧渲染冒烟）；
  `test/panel-actions.test.js` 新增 1 条（B1 最新回复内联/文件/无回复）。`npm test` 602 条全绿。
- 文档：[docs/UI.md](docs/UI.md)（布局图、token 对照表、交互清单、file:line）、README 面板小节、
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#面板与详情ui-u2)。

### 变更（U1 任务入口仅主会话可见）

- **会话头「☰ 任务」只在协调者/主会话显示**：`client.js` 新增任务入口闸门 `createMainViewGate`（fail-closed）。
  当前会话信号优先取 `uiSession.adapter.current` 的 `key`，取不到时退到 `sessions.list` 里 `retainedBy.mainView > 0` 的会话；
  再 POST `/api/orchestrator` 的 `session-role` 端点，由宿主按台账主会话 id 回答 `isMain`。
  切到子会话（或其他会话）时组件返回 `null`，入口隐藏；同一会话的判定结果会缓存，换会话立即重判。
- **判定信号与降级规则**：宿主侧 `isMainSession(sessionId, mainSessionId)`（`src/session-role.js`）只认非空字符串逐字相等；
  信号与 `task_*` 工具同源（`coordinatorStatus()` → `settings.main_session_id`，`config.coordinatorSession` 覆盖）。
  任一侧缺失、未打开主会话、请求失败、响应不是 `ok:true` 都按 `false`，即入口**默认隐藏**；
  失败不缓存，靠会话切换和 5 秒兜底轮询重试。侧栏「◈ 主会话」跳转入口**始终可见**，不做主会话判定（避免没建主会话时无从引导）。
- **路由**：`src/host-route.js` 新增只读查询端点 `session-role`（`{ sessionId }` → `{ ok:true, isMain }`），
  与 `snapshot` 一样不写台账、不建会话、不派发。
- 测试：`test/session-role.test.js`（相等/不等/空串/非字符串/未打开主会话降级）、`test/host-route.test.js`（主会话/子会话/空 body/无 coordinatorStatus、零写入）、
  `test/client.test.js`（闸门默认隐藏、主会话显示、子会话隐藏、请求失败降级、会话订阅与 5 秒轮询、侧栏入口始终注册、渲染条件）。
  `npm test` 595 条全绿。
- 文档：README（打开入口/排障）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/LIMITATIONS.md](docs/LIMITATIONS.md)、[docs/api-notes.md](docs/api-notes.md)。

### 变更（T1 子会话读任务详情 + brief 纯指引化）

- **新增 `task_detail` 只读工具（只给任务自己的子会话）**：`createTools` 的第 12 个工具（`src/tools.js`），渲染在 `src/task-detail.js`。
  字段：任务编号/标题/状态、目标全文（保留换行）、工作目录 + 可写/只读提示、验收标准、约束、背景资料、用户原话、编排（分组/优先级/写域，非默认才显示）、
  `【前置任务】`（复用 `deps.upstreamBrief`，按**当前**台账现读状态/最近回报/产物）、`【经验文件】`（路径 + 条数 + 「可 read 全文/文件已丢失」；
  记忆文件写不出来时退回内联块）、`【已有产物】`（路径/标签/存在性）、完成口径（`task_report` 选项 + 汇报三问）。
  **只读**：不写消息、不改状态/时间戳/进度，经验文件只 `stat` 存在性（正文由子会话自己的 `read` 决定）。
  **越权拒绝**：`exec.agent.id` 或 `exec.agent.session.id` 必须等于 `tasks.session_id`；主会话、别的子会话、尚未派发的任务都返回
  「读取被拒绝…主会话查任务用 task_status」并记 `task.detail.rejected` 日志。
- **brief 纯指引化**：`renderBrief({ taskId })` 只输出 `【任务编号】` + `【任务详情】先调 task_detail…` 两行，
  不再内联目标/验收/约束/背景/用户原话/工作目录/经验/前置任务/产物，也不再写 `【目标兜底】`；
  `src/brief.js` 的 `goalLines` / `MAX_GOAL_FALLBACK_CHARS` / `GOAL_POINTER_TEXT` / `GOAL_FALLBACK_TEXT` 一并移除。
  目标正文仍写进平台 goal（子会话可 `get_goal` 读实时目标），创建时快照由 `task_detail` 提供，两条路互不依赖。
- **经验改存指针**：`task_create` 命中事实层记忆时仍写 `lessons/<项目>-<hash>.md`，但只把 `{ path, count }`（写文件失败时 `{ inline }`）
  存进 `brief.experience` 供 `task_detail` 读；提示词里不再出现经验正文，长度与记忆条数无关。
- **重派同口径**：`task_retry` 与面板 `retry` 都改用 `renderBrief({ taskId: 新任务编号 })`，面板重派不再回退到内联目标。
- **派发不再拼前置摘要**：`queue.pump` 直接发落库的 brief 消息（缺失时 `renderBrief({ taskId })` 兜底），
  不再在派发时拼 `【任务】标题 + 目标` 或 `【前置任务】` 快照——依赖可能在创建后才完成，改由 `task_detail` 现读。
- **挂载链**：`task_detail` 与其它 `task_*` 一样由 `index.js` 的 `createTools(...).map(tool => ctx.tools.register(tool))` 注册成 host plane 全局工具；
  `dsh-orchestrator-worker` 预设不挂 `preset-tools`、不做 allow/deny 收窄，子会话工具表直接继承（与 `task_report` 同一条路）；
  协调者预设的 `preset-tools` 白名单不含它，执行层 `COORDINATOR_DENY` 也补了 `task_detail`（与 `task_report` 同类）。
  `cordis.patch.yml` 的 worker 预设补了这条挂载链的注释。
- 测试：`test/brief.test.js` 重写为纯指引用例；新增 `test/task-detail.test.js`（字段、只读、越权、未派发、前置现读、经验指针/降级/丢失、产物存在性）；
  `test/tools.test.js`、`test/index.test.js`、`test/config.test.js`、`test/panel-actions.test.js`、`test/queue.test.js`、`test/integration.test.js` 同步改口。
  `npm test` 587 条全绿。
- 文档：README（工具表/目标段/配置/数据目录）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#brief-纯指引t1)、
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md#目标g1)、[docs/DETAIL.md](docs/DETAIL.md)。

### 新增（K2 回合间 keep-alive）

- **`keepAlive` 开关（默认关）**：开启后插件订阅平台 `agent/turn-stopping`，在回合边界（`agent.status` 仍为 `running`、尚未 idle）同步给子会话投递下一轮，
  让它接着跑而不是先 idle 再被 S1 结算。只对「台账 `running` + 平台 goal 未完成（phase 不是 `complete`/`cleared`）」的任务注入；
  默认 `steer`（同 turn 多走一步，不写 `turn/end`），`keepAliveMode: 'followup'` 切新回合。
  停止条件：轮满（`keepAliveMaxRounds`，默认 8，1–50）、goal 已收口、任务不在 `running`（`task_stop`/S1 结算/S2 对账）、回合被中断、
  只读任务、inbox 已有人排了下一轮、注入异常；监听器全量 `try/catch`，绝不把异常抛回 serial dispatch。
- **台账预算 `tasks.keep_alive_rounds`**：旧库自动补列（历史行 0 轮），`bumpKeepAliveRound` 用条件 `UPDATE ... WHERE status='running' AND keep_alive_rounds < ?`
  原子加轮（重复/并发事件不超发），每次进入 `running`（重派/续派/冷恢复）归零；每次注入写一条 `kind='keepalive'` 审计消息 + `task.keepalive.injected` 日志，
  `task_status` 显示「keep-alive 已注入 N/M 轮」。
- **与 S1 结算不冲突**：keep-alive 不改状态、不写 `progress_count`、不写 `kind='followup'` 消息（避开面板同文去重口径）、不触发结算；
  结算仍只在真正的 `subagent.settled` / `subagent/end` 上由 S1 做一次（状态机天然幂等），任务一旦离开 `running`，同一会话后续的 `turn-stopping` 直接跳过。
- 接线：新增 `src/keepalive.js`（`createKeepAlive` / `keepAliveSkipReason` / `keepAliveText`），`index.js` 在 settlement 之后 `start(ctx)` 并在卸载时 dispose；
  `src/config.js` 新增 `keepAlive` / `keepAliveMode` / `keepAliveMaxRounds` / `keepAlivePrompt`；`src/ledger.js` 新增列、迁移、`bumpKeepAliveRound`、
  进入 `running` 归零；`src/tools.js` 的 `task_status` 显示续跑轮数。
- 文档：README（用法小节 + 配置表）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 「回合间 keep-alive（K2）」、[docs/LIMITATIONS.md](docs/LIMITATIONS.md#回合间-keep-alivek2)；
  用例 `test/keepalive.test.js`（12 条：默认关、steer/followup、轮满、goal 完成/缺失、非 running、只读、中断、inbox 排队、注入异常、台账原子加轮与旧库补列、S1 去重）
  + `test/index.test.js` 两条接线用例（默认关不注入 / 开启后 `turn-stopping` 注入且 S1 只结算一次）。

## 0.10.0（2026-11-15）

子会话读目标 + 主会话读全文 + brief 瘦身 + 协调者交付产物：G2 让子会话真正拿到 `get_goal`，B1 把「最后一条 assistant 消息」落进台账供主会话直读，
L1 把目标与经验外置（brief 只留指引与指针），P1 让协调者可用 `present` 交付子会话产物；D2 给调试预设补逐项对齐自检与 `--check` 漂移检查；
另附 K1「回合间 keep-alive」可行性探针（仅文档与探针代码，不动产品逻辑）。相对 0.9.0 无破坏性变更（minor）。

### 变更（L1 brief 精简）

- **目标不再在 brief 里重复一份**：平台 goal 可用时（`goalBridge.available()`，即 `ctx.goals` 方法齐全），`【目标】` 写成
  「先调 `get_goal` 读取完整目标（含「最新指示」）」的指引，紧跟一行 `【目标兜底】get_goal 不可用时按此执行：<目标前 160 字>…`，
  这样目标正文只存在平台 goal 里，brief 不重复。attach 失败 / worker 预设没挂 `tool-goal` 时，子会话至少还有兜底可开工。
  goal 降级（没有 goals 服务、方法不全、能力探测抛错）时**仍然内联目标全文**，与旧行为逐字一致。
  重派（`task_retry` / 面板「重派」）重渲染 brief 时同口径。
- **经验写记忆文件，brief 只留短摘要 + 指针**：`task_create` 命中事实层记忆时，把完整内容写进
  `$DSH_HOME/state/orchestrator/lessons/<项目目录名>-<key 短 hash>.md`（同一项目稳定复用同一文件，每次派发覆盖为最新快照，
  含层标签、日期、`id`、来源任务/会话、生成时间）；brief 里的【历史经验】改成「N 条｜完整内容见经验文件（可 read 全文）」+
  每条 ≤64 字摘要 + `完整经验：<路径>`。worker 预设自带 `read`，子会话能自己读全文。
  降级：`stateDir` 缺失、`lessons/` 建不出来或写文件失败时，退回原来的内联记忆块（不丢经验，只是 brief 变长）。
  路径行永不截断；超 `MAX_MEMORY_BLOCK` 时先丢摘要行、保留路径。
- `src/brief.js` 导出 `goalLines` / `MAX_GOAL_FALLBACK_CHARS` / `GOAL_POINTER_TEXT`；`renderBrief(brief, { goalAvailable })`。
  `src/memory.js` 导出 `buildLessonBlock` / `writeLessonFile` / `renderLessonFile` / `lessonPointerBlock` / `lessonFilePath`，
  `buildMemoryBlock` 拆出 `memoryBlockFromRows`（`project_context` 与降级路径共用）。`createTools` 新增 `stateDir`（`index.js` 传插件写入根）。

### 变更（P1 协调者交付产物）

- **协调者预设挂 `present`**：新增 `@deepseek-ai/dsh-tool-present` 行（与标准预设 `dsh-web-app/presets/cordis.patch.yml`、worker 预设逐字同形），
  主会话可把子会话的 `reports/` 文件作为交付产物声明给客户端。在 web/desktop 里 `present` 是预设自有工具（own），deny 补集本来就遮不到；
  同时把它列进 `preset-tools` 的 `allow` 作跨 profile 保底（allow 只用于过滤 deny、不交给 `restrict`，写 own 名字不会 `unknown global tool`；
  SDK 等 profile 的 host plane 也注册 `present`，不列就会被当成全局工具 deny 掉）。
- **执行层解除拦截**：`COORDINATOR_DENY` 移除 `present`（否则预设挂了也会被 `tools.restrict`/`guard` 硬拦）；
  协调者系统提示补一条：产物确认存在后用 `present` 交付，路径写绝对路径（主会话工作目录不是项目目录）。
- **生效方式**：预设行在 profile 加载时挂载，重启 DSH（或重载 profile）后生效；客户端需支持 `deliverables/presented` 的 present 卡片
  （Desktop/Web 已支持，worker 预设早已在用）。

### 修复（G2 子会话读目标）

- **子会话读不到自己的目标**：`dsh-orchestrator-worker` 预设原先没有任何 goal 工具行，而 web-app 层把 host plane 的 `tool-goal` 行 `disabled: true`（模型面工具改由预设挂载），`goals` 服务则留在 host plane——两边都缺，子会话工具表里就没有 `get_goal`，G1 写进平台的目标只有宿主和面板看得见。
  现在 worker 预设在 `tool-jobs` 后补一行 `tool-goal`（`@deepseek-ai/dsh-tool-goal`，与随包 `standard` / `ptc` / `cordis` 预设逐字同形），子会话可 `get_goal` 读到本任务目标（含「最新指示」拼接文本）。
- **写能力仍然关闭**：`create_goal` / `update_goal` 由平台 `goalToolExecution` + `requireDirectHuman` 校验，要求顶层 agent 的直接人类回合，子会话调用必被拒；改目标仍只走 `task_message` / 面板「追加」。协调者预设不挂 `tool-goal`（它只做协调，工具面由 `preset-tools` 白名单收窄）。

### 新增

- **最新返回消息（B1）**：结算时持久化子会话最后一条 assistant 消息（新增 `src/last-message.js` + `tasks.last_message_json`）。≤64 KiB 内联台账；更大写 `$DSH_HOME/state/orchestrator/reports/<taskId>.md`，台账只留路径 + 240 字摘要；写文件失败降级内联，空输出不覆盖上一次记录。派发侧 `subagent.settled` 的 `detail.output` 仍是 240 字摘要（日志不膨胀），完整正文走事件上的非日志字段 `lastMessage`。
- **`task_status` 新增 `include: 'full'`**：默认给正文（超 1200 字给预览 + 截断提示）或「reports 路径 + 摘要」，`full` 时读全文（文件被删则降级为摘要 + 读取失败原因）。
- **对齐自检**：`prepareDebugPreset` 生成后自动比较「源 cordis 组合 vs 生成物 plugins」，只允许预设 id / 显示名 / 描述 / 排序与 `customSkillDirs` 落点不同；工具行、`!!js` 权限条件、persona 系统提示逐行比对，结果随 `alignment` 返回。
- **`--check` 只读检查**：`node scripts/orch-debug-preset.mjs --check` 读取当前安装的随包 `cordis` 与已生成 bundle，发现漂移时打印逐行差异并以退出码 1 结束；技能根单独报告 `dsh-doc` 是否在位。DSH 升级后先跑它再决定重新生成。
- **技能目录报告**：生成结果新增 `skillNames`（如 `['dsh-doc']`），`--check` 同时复核 `skills/dsh-doc/SKILL.md` 是否存在。
- **文档**：`docs/DEBUG-PRESET.md` 新增「与 `cordis` 的逐项差异」「插件更新流程（`plugin_manager` / client HMR / host HMR / 动态插件边界）」「`cordis_*` 可用性证据与限制」，并修正旧文档「调试子会话里 `plugin_manager` 默认关闭」的错误结论（Desktop/Web profile 下有 `profileContext` 即启用）。

### 测试

- `test/debug-preset.test.js` 新增插件行切分、对齐比较（缺少/多出/顺序/包名/`disabled`/系统提示）、技能根归一化、`skillNamesOf`、`prepareDebugPreset` 自检与 `--check` 漂移检测用例。
- `test/config.test.js` 新增 worker 预设 `tool-goal` 行的回归用例（按 `config.id` 抠 plugins 块：worker 恰好一行、包名正确、纯行无 `config`/`disabled`、整份补丁只出现一次；协调者不挂）。
- P1 用例：`test/config.test.js`（协调者预设恰好一行 `present`、标准包名、纯行、`allow` 含 `present` 保底、整份补丁两行）、`test/index.test.js`（`present` 不在 `COORDINATOR_DENY`、协调者 guard 放行、`present` 不进入运行期 deny）。
- B1 用例：`test/settlement.test.js`（短消息内联、超 64 KiB 写 `reports/` 并与文件内容比对、派发侧只给 `lastMessage`、重复结算幂等且不多写文件、空输出不覆盖）、`test/ledger.test.js`（旧库补 `last_message_json`、坏 JSON、同 digest 回落幂等）、`test/tools.test.js`（默认正文/预览/路径 + 摘要、`include: 'full'` 读全文、报告文件缺失降级）、`test/dispatch.test.js`（事件带完整 `lastMessage`、`detail.output` 仍 241 字符）、`test/index.test.js`（平台 `subagent/end` 全链路短/长两条）。
- L1 用例：`test/brief.test.js`（goal 可用 → 指引 + 截断兜底、短目标兜底即全文、降级内联全文、与工作目录/只读的相对顺序、纯函数）、`test/memory.test.js`（`lessons/` 文件写入并与 brief 摘要比对、路径稳定、摘要截短、`stateDir` 缺失 / `lessons/` 被同名文件占位两种降级、无命中不建目录、指针块超限保路径、`lessonFilePath` 命名）、`test/tools.test.js`（`task_create` 的两种目标形态、能力探测抛错也降级、经验指针 + 文件落盘、`stateDir` 缺失退回内联、`task_retry` 重渲染同口径）。
- `npm test` 570/570，`npm run check:client` 通过。

### 文档（K1 keep-alive 探针）

- **`agent/turn-stopping` 可行性探针**：新增 `docs/probes/keepalive-probe/`（`index.js` 订阅 `agent/turn-stopping`，`followup` / `steer` / `followup-async` / `none` 四模式 + 一次性 `DSH_HOME` 的 `run.ps1`，不碰桌面 profile）与四组原始事件 `out/k1-events.*.jsonl`，结论见 `reports/k1-keepalive-probe.md`。
- **结论**：可行——事件 `serial` 且被 await，监听器里同步调用 `agent.steer()`（同 turn 多跑一步、无 `turn/end`，推荐）或 `agent.followup()`（新 turn、`turn` 计数 +1）都在回合并界面前生效，且天然避开 `idle` 之后的结算/dispose 竞态；必须自带预算与终止条件。**本次只提交探针与结论，不改产品逻辑。**

## 0.9.0（2026-11-15）

记忆分层 + 空闲看门狗 + 子会话目标：done 结果降级为日志层只归档，长时间空转主动告警，子任务目标同步到平台 `ctx.goals`。相对 0.8.0 无破坏性变更（minor）。

### 变更（M1 记忆分层）

- **记忆分层**：`task_report done` 不再写 `kind='task-done'`，改为日志层 `task-log`——一行完成任务记录（≤180 字符，不拼产物清单、不贴 verbatim），
  只归档、**不注入 brief**；旧库里的 `task-done` 在打开台账时自动迁到 `task-log` 并重算 hash（幂等）。分层规则见 `src/memory.js` 的 `memoryLayerOf`。
- **写入即蒸馏**：`addMemory` / `memory_note` 写入前统一清洗（整块丢代码围栏、shell/测试输出行、`>` 引用原话、纯路径清单），
  事实层单条上限 160 字符、日志层 180 字符，不再落长日志或 verbatim。
- **经验才注入**：done 摘要里带「结论/经验/注意/避免/改用/必须…」标记的分句蒸馏成 `lesson` 原子事实（最多 2 条），
  与 `decision`/`preference`/`note` 一起进 brief 的【历史经验】；`history_search` 结果按层标注 `[日志]`/`[经验]`/`[决策]`。
- `memory_note` 的 `kind` 新增 `lesson`；`src/ledger.js` 打开台账时执行 `migrateLegacyTaskDone`。

### 新增（W1 空闲看门狗）

- `src/watchdog.js`：每 `watchdogIntervalMinutes`（默认 5 分钟）巡检 `running` 任务，最新活动（`last_event_at` 心跳 / `messages.at` 消息 / `updated_at` 状态变化三源取最新）早于 `watchdogIdleMinutes`（默认 15 分钟）就推一条 `stalled` 汇总告警。
- **只告警**：不改状态、不 kill、不重派、不写任务表；同一段空闲每任务只报一次，出现新活动后重置、可再报一次；任务离开 `running` 即出表。
- 启动时在 S2 启动对账之后立即巡检一次（先让重启遗留的 `running` 落 `orphaned`）；插件卸载先 `stop()` 再关台账。用法与边界见 `docs/ARCHITECTURE.md`「空闲看门狗（W1）」。
- 配置：`idleWatchdog`（默认 `true`，显式 `false` 关闭）、`watchdogIntervalMinutes`、`watchdogIdleMinutes`（均 1–1440，非法值回落默认）。

### 新增（G1 子会话目标）

- `src/goal.js`：声明式接入平台 `ctx.goals`。spawn 成功后 `create` + **紧接着 `disarm`**（goal 只做持久目标状态，不驱动子会话自动续轮）；
  `task_message`/面板追加把「原目标 + 最新指示」同步为 goal（文本变化才 `edit`，并保持 disarmed）；
  `done` → `complete`，`stop`/`retry`/`orphaned`/`failed` → `clear`。
- 台账新增 `tasks.goal_state_json` 只读镜像（裁剪字段，坏 JSON 按无镜像处理）；面板 snapshot 带紧凑 goalState，
  详情抽屉新增「目标状态」只读区块，列表显示「目标·阶段」小标；面板不提供任何 goal 写操作。
- **静默降级**：`ctx.goals` 缺失/方法不全时所有钩子 no-op，不 warn、不阻塞派发/续派/结算；子 agent 晚出现时等 `agent/created`（最多 3 秒）。
- 边界（不自动续跑、冷恢复窗口、外部 re-arm）见 `docs/LIMITATIONS.md`「目标（G1）」；接入点见 `docs/ARCHITECTURE.md` 同名小节。

### 测试

- `npm test` 532/532：新增看门狗判定数据源/阈值边界、每任务一次去重、活动重置、`system` 汇总通知、无 `summary` 回退 push、关闭开关、`start()` 立即巡检与 `stop()` 卸载清理、台账读失败降级，以及 `apply()` 接入与卸载；配置默认/覆盖/夹取。
- G1 新增 `test/goal.test.js`（桥的 create+disarm 顺序、目标复用/edit、complete/clear、能力缺失静默降级、错误只 warn 一次、台账镜像）与 `test/goal-hooks.test.js`（工具/面板/结算/快照挂钩），`test/dispatch.test.js` 增加 spawn/send/stop 契约，`test/index.test.js` 增加真实 `apply()` 接入与无 goals 降级。

## 0.8.0（2026-11-15）

稳定性闭环 + 调试能力：子会话结算原因自动收场、启动对账兜底孤儿、子会话可切「创造模式」。相对 0.7.0 无破坏性变更（minor）。

### 新增

- **结算原因闭环（S1）**：新增 `src/settlement.js` 消费子会话 `settle` 的 `stopReason`，自动把 `running` 推到终态
  （正常完成→`done`、被中断→`cancelled`、异常→`failed`、只报过进展→`orphaned`），记录死因并合并通知；
  原本只靠子会话自己 `task_report` 的「沉默中断」不再留在 `running`。
  取值与时序见真机探针 `docs/probes/stop-reason-probe.md`。
- **启动对账（S2）**：插件启动与协调者晚加载时扫描台账，`running` 但子会话已不活跃（`agents.get` 查不到）的任务标 `orphaned`，
  补上进程重启/崩溃后的「沉默中断」兜底；`waiting_dep` 不参与、`waiting_*` 不因不 live 被误标；重复启动幂等。
- **孤儿汇总上报**：对账结果合并成一条通知（任务名 + id，超 10 条折叠），协调者未加载时保留待发、`agent/created` 后补发一次。
- **子会话调试能力（D1）**：新增 `config.workerPreset`（默认 `dsh-orchestrator-worker`，透传到子会话启动的 `agentPreset`，
  非法 id 回落并 warn）；`npm run preset:debug` 把随包「创造模式」(`cordis`) 组合复制成可安装的 `orch-debug` 预设
  （含 `cordis_*` 只读洞察工具与 `dsh-doc` 技能），装好后 `workerPreset: orch-debug` 即可让调试子会话拿到创造者能力。
  用法、边界（预设不是沙箱、宿主需彻底重启、升级后要重新生成）见 `docs/DEBUG-PRESET.md`。

## 0.7.0（2026-11-15）

面板操作台收尾：错误码与幂等、详情抽屉、产物自动收集。相对 0.6.1 无破坏性变更，属向后兼容的功能新增（minor）。

### 新增

- **面板动作错误码与幂等**：统一 `action-errors` 错误码表，工具层与面板复用同一口径；`stop` 对重复调用/已终态返回 `already`；
  `retry` 仅允许 `failed` / `orphaned`，同源活跃重派视为幂等；`message` 支持 `clientRequestId` 进程内去重，
  并带同文短窗口兜底；面板直接展示错误码与 `already` 提示。
- **详情抽屉四区块**：面板详情抽屉按「基本信息 / 执行 / 依赖 / 产物」四区块展示，并显示 followup 投递状态。
- **done 自动收集产物**：子任务 `task_report done` 时从 `workspaceChanges` 自动收集改动文件，与显式 `artifacts`
  按路径去重合并；产物库支持按项目/日期分组、预览与复制，并可从任务卡片直达。

### 文档与内部

- 轮询注释对齐实现（2s `POLL_MS`、30s 退避 `POLL_BACKOFF_MS`），清理遗留审计与探针文件。
- README 发版流程改为 annotated tag + `git push --follow-tags`；安装示例与排障版本号同步到 0.7.0。

## 更早版本

按 `git tag` 主题重建的简要索引，细节见对应 tag 的提交与 `docs/`：

| 版本 | 主题 |
|---|---|
| 0.6.1 | 重构 README，拆分 ARCHITECTURE / LIMITATIONS 文档 |
| 0.6.0 | P3 产物库与面板操作台 |
| 0.5.1 | P0 收尾：插件展示元数据与 npm 占位版本清理 |
| 0.5.0 | P2 收件箱 / 问题选项 / `stallRounds` / 日报 |
| 0.4.0 | P1 依赖编排：`dependsOn` / `group` / `writeScopes` / `priority` |
| 0.3.x | 发布流水线（provenance + 重复发布保护）、client id 回归、MIT LICENSE |
| 0.2.x | 插件入口直达主会话、显示名文案、只读子任务（`readOnly`） |
| 0.0.0-stage | npm 占位版本（已 deprecate） |
