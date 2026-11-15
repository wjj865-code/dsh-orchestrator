# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；版本号以 `package.json` 为唯一真源，
推 `vX.Y.Z` tag 触发 `.github/workflows/release.yml` 发布到 npm。

## 未发布

调试预设 D2：`orch-debug` 与随包「创造模式」(`cordis`) 逐项对齐可验证，文档补全插件更新流程（client 热重载 / host 更新 / 动态插件边界）。
G1 补齐：worker 预设挂 `tool-goal`，子会话终于能 `get_goal` 读自己的任务目标。
B1：子会话结算时把完整的「最后一条 assistant 消息」落进台账，主会话用 `task_status` 直接读（长消息写 `reports/` 文件）。
L1：brief 瘦身——目标改成「用 `get_goal` 读」的指引 + 兜底，经验改成短摘要 + 记忆文件指针。相对 0.9.0 无破坏性变更。
P1：协调者主会话可用 `present` 交付子会话产物（协调者预设补行 + 解除执行层拦截）。

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

### 修复

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
