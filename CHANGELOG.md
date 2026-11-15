# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；版本号以 `package.json` 为唯一真源，
推 `vX.Y.Z` tag 触发 `.github/workflows/release.yml` 发布到 npm。

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
