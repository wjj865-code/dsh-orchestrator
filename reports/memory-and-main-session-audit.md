# 记忆机制与主会话唤起频率审计报告

> **出处**：本报告由 `t-dde45926`（只读调研：记忆读写机制与主会话触发频率）的结论整理落盘，未做新的调研结论；所有数字、代码坐标与判断均取自该任务回报全文。
>
> | 项 | 值 |
> | --- | --- |
> | 底稿 | `tasks.sqlite` → `messages` 表，`task_id = t-dde45926`、`seq = 2`、`kind = report`、`at = 2026-11-21T03:40:48Z`（报告正文 16,280 字符） |
> | 落盘任务 | `t-608124eb`（可写任务，仅落盘整理） |
> | 数据时点 | 2026-11-21T03:40Z（底稿报告时刻）；落盘时点的快速复核见 [§11](#11-底稿对照与落盘说明) |
> | 报告对象 | 插件自身：记忆的写入链路、读取链路、主会话被唤起的方式与频率 |
> | 方法性质 | 只读；底稿执行时未写入任何业务文件，也未改台账数据 |

**目录**：[0 结论摘要](#0-结论摘要tldr)｜[1 方法](#1-方法与取证范围)｜[2 写入链路](#2-写入链路)｜[3 读取链路与触发时机](#3-读取链路与触发时机)｜[4 主会话唤起频率](#4-主会话唤起频率与来源)｜[5 三类内容可达性诊断](#5-三类内容可达性诊断)｜[6 业界对照](#6-业界对照无联网基于公开知识)｜[7 改进建议](#7-改进建议ranked)｜[8 不做与风险](#8-不做-风险)｜[9 取证与复现](#9-取证与复现只读)｜[10 待确认点](#10-待确认要点)｜[11 底稿对照与落盘说明](#11-底稿对照与落盘说明)

---

## 0 结论摘要（TL;DR）

记忆的「写」链路是健康的、可观测的；**「读」链路基本靠运气**：真正自动到达子会话的只有 task_create 那 3 条字面命中，协调者自身没有任何常驻记忆注入，`context` 默认参数还会避开项目记忆。主会话一周 607 个回合，**46% 由插件通知拉起**，而通知合并率只有 1%（316 条里合并 3 条）——唤醒量本身不是问题，唤醒质量（空转 9.5%）与检索质量（注入命中的词重合度均值 20%）才是。

### 0.1 九条最硬的事实（全部实测）

1. memories 共 322 条：task-log 208 / lesson 93 / decision 9 / preference 8 / note 4。事实层只有 114 条，日志层占 **65%**。
2. 221/322（69%）记忆**从未被任何路径读过**；task-log 只为 21/208（10%）被读过。
3. 每天写入 ~60 条（fact 9–29 + log 21–58），单项目上限 300（`src/memory.js:32`），项目 `dsh-orchestrator` 已 254 条 → **再活跃一天就开始静默淘汰最老的条目**（按 created_at，先删的正是 11-14 手记的 decision/note）。
4. 自动注入（task_create）对 305 个任务做了事实层检索：83%（252 个）拿到满 3 条，但**查询词与首条命中的 token 重合度均值 20.3%**（多数只共 1/12 个词，如「任务/插件」）；另有 25 个任务一条都没命中。117/304（38%）的任务 brief 里没有经验指针。
5. 协调者默认调 `context({mode:'history'})`（不传 project）时 `resolveProjectHint('')` 返回 `global`（`src/tools.js:317-319`），检索条件变成 `project_key IN ('global','global')`（`src/memory.js:238-246`）→ **254 条项目记忆一条都查不到**，只查 4 条 global。实测当次调用只回「历史任务」，无【记忆】块。
6. `context({mode:'project'})` 只读 README 前 **1800 字**（`src/tools.js:377-381`）、AGENTS、package 顶层，**不读 docs/ARCHITECTURE.md（70 KB 的决策正本）**；本仓库**没有 AGENTS.md**，实测输出里 README 被截在 `go` 半句。协调者的 cwd 是指挥舱 `…\state\orchestrator\workspace`，那里也没有 AGENTS.md。
7. 写入侧两处「死数据」：① 11-15 写的 3 条全局偏好落在 memories（0.19.0 才改成写 `settings.orchestrator_preferences`，CHANGELOG:1045），而 settings 里**从来没有这个键**（7 份快照全无）→ 这 3 条永不生效，今天实际生效的偏好只有 2 条出厂种子；② `settings.workspace_repo_index` 也从未存在、`brief.workspaceIndexEntries` 任务数 = 0 → `context({mode:'workspaces'})` 一直降级为「尚无仓库索引」。
8. worktree 任务的记忆写在检出路径键下（`.agents\worktrees\t-xxx`，共 11 条、8 个分裂键），从项目键检索不到（done 时用 `projectKeyOf(next.target_dir)`，`src/tools.js:1796`）。
9. 读取实测：子会话 **205/292 会话（70%）调过 task_detail**，**185/292（63%）读过 lessons 文件**；但 **只有 9/292（3%）会话调过 context**（10 次，全是默认 history）。协调者 351 个回合里 `context` 只有 2 次（另有 6 次旧名 history_search / 1 次 project_context），且都发生在「调研插件机制」时，从不在派任务前。

### 0.2 主会话唤起频率（实测）

9 个协调者会话、去重后 **607 个回合 / 8 天**（活跃日 45–107 回合）；opener 分布 = 人 300（49%）、插件通知 280（**46%**）、子会话结算 20（3.3%）、批准 6（1%）、schedule 1；回合间隔 p50 **1.8 分钟**、p25 0.9 分钟；通知 308 条 delivered / 7 skipped，**合并只有 3 条（1%）**；通知拉起的回合平均 1.90 次工具调用、9.5% 零工具（纯确认），人拉起的回合 1.67 次、14% 零工具。

---

## 1 方法与取证范围

底稿全程只读，未写任何文件：

- **代码**：`src/memory.js`、`src/tools.js`、`src/preferences.js`、`src/task-detail.js`、`src/prompt-layers.js`、`index.js`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`（0.19.0 偏好、0.25.x 上下文维护）。
- **台账**：`tasks.sqlite` 用 `node:sqlite`（`DatabaseSync {readOnly:true}`）读了 tasks/messages/notifications/settings/memories 五张表；7 份 `snapshots/*.sqlite` 用于对比 settings 键的历史。
- **日志**：`logs/orchestrator-*.jsonl` 7 天全量（2026-11-15～11-21，共 4 726 行、67 种事件）按事件名聚合。
- **主对话记录**：宿主会话日志 `~/.dsh/sessions/--C-Users-72489-.dsh-state-orchestrator-workspace--/<sid>/session.v4.jsonl.zstd`（含 zstd 多帧，逐帧解压后解析 260～7 344 行/会话），据此统计回合、消息来源、工具调用。
- **检索行为用真实实现跑**：`import('…/src/memory.js')` 直接调 `searchMemories` / `distillLessons`（只读连接，`use_count` 的 bump 被内部 try/catch 吞掉，未改数据）。
- 底稿执行时没有联网工具可用，第 6 节业界结论基于公开知识，已逐条标注。

---

## 2 写入链路

### 2.1 存储与表结构

`memories(id, project_key, kind, text, source_task_id, source_session_id, hash UNIQUE, created_at, last_used_at, use_count)`（`src/memory.js:209-213`，schema 实测一致）。

- `project_key` = 规范化绝对路径（Windows 小写），无 target 归一为 `global`；`hash = sha256(project|kind|trim(text))` 做**精确去重**（`:69-71`，无近似去重）。
- 两层：`MEMORY_FACT_KINDS = lesson/decision/preference/note` 才可注入；`task-log`（旧 `task-done` 已迁移，`:429-443`）只归档。

### 2.2 memory_note 的四条路由（`src/tools.js:1574-1617`）

| kind | project | 落点 | 生效方式 |
|---|---|---|---|
| preference | 不传/global | **只写** `settings.orchestrator_preferences`（不双写 memories） | L1 第 4 段每回合现渲染，下一回合生效 |
| preference | 给了项目 | **只写** memories | 随 task_create→task_detail 经验指针进子会话；不进协调者提示词 |
| lesson/decision/note | 任意 | 只写 memories 事实层 | 同上（`context` 可查） |
| 任何 | — | 写前 `distillText` 蒸馏（丢代码围栏/命令/日志/引用原话/路径清单，事实层截 160 字、日志层 180 字） | 空 ⇒ 拒写 |

偏好生效链路的准确表述：**每回合注入、注入在 L1（`ctx.systemPrompt.context().text` 回调，`index.js:529-548`），不是每回合重新读 memories**；`preferencesInject:false` 可关；`preferencesMaxChars` 默认 1200、条数上限 12，超限在段尾显式写「另有 N 条未展示」（`src/preferences.js:160-189`）。偏好只是提示词文本，不是权限通道。

### 2.3 自动写入（唯一的「无人工」入口）

`task_report done`（首次交付，`deliveredNow`）时（`src/tools.js:1791-1815`）：

1. **task-log**：一行 `任务「标题」完成：<蒸馏摘要>`（≤180 字），永不再注入；
2. **lesson ×0–2**：把 summary 按句读拆句，只保留含经验标记词（经验/教训/注意/避免/以后/结论/踩坑/根因/必须/不要/优先…）且长度 4–160 的原子事实（`src/memory.js:128-152`）。

实测产出率：240 条 done 回报里 **94 条（39.2%）能蒸出 ≥1 条 lesson**（1 条：80，2 条：14，0 条：146）。子会话**不能**写记忆（worker 预设 `deny: [memory_note]` + 执行层 `requireMainForWrite` 返回替代路径，`src/tools.js:165-180`），所以子会话的结论只能靠 summary 挤过上面这道 39.2% 的窄门。

### 2.4 写入即蒸馏的副作用（可接受但要知道）

- 160 字上限会把「结论 + 前置条件 + 反例」压成一句；`looksLikePathDump` 会把纯路径/文件名清单整条丢弃 → 「产物在 X」这类事实不会留下。
- `distillLessons` 的标记词表包含「原因/定位/建议」等高频词，容易把**过程叙述**误当经验；没有反例校验。
- 去重是全文 hash：多一个标点就是新行（94 条 lesson 里 16 字前缀相同的对数为 0，说明去重没在起作用是因为文字本就不同，不是去重太强）。

### 2.5 写入侧五个缺陷（按影响排序）

1. **淘汰不分层**：单项目 300 条上限按 `created_at` 删最老（`src/memory.js:216-220`），log 层写入量是 fact 的 2–3 倍（实测 fact 9–29/天、log 21–58/天）→ 项目再活跃一天就会开始删 11-14 的手记 decision/note。
2. **worktree 键分裂**：done 时 `projectKeyOf(next.target_dir)`，隔离任务的 target_dir 是检出目录 → 11 条记忆落在 8 个 `.agents\worktrees\t-*` 键下（`src/tools.js:1796`）。
3. **旧全局偏好是死数据**：3 条（11-15，`[global]` preference）落在 memories；settings 无 `orchestrator_preferences` 键（7 份快照一致），今天生效的只有 2 条出厂种子。无迁移代码。
4. **`workspace_repo_index` 从未生成**：0 个任务带 `workspaceIndexEntries`，settings 无该键 → 仓库索引/`workspaces` 视图长期降级；onboarding 的索引任务在这份台账里不存在（台账 11-13/14 起，可能是 adopt 进来的主会话跳过了 onboarding）。
5. **写入无日志维度**：`memory.note` 事件 20 条，其中 16 条 `route` 为 undefined（老版本），无法从日志区分「走 settings」还是「走 memories」；自动沉淀（task-log/lesson）完全不写日志 → 事后无法回答「这条记忆哪来的」。

---

## 3 读取链路与触发时机

| 通道 | 载体 | 谁调 | 触发时机 | 实测使用率 |
|---|---|---|---|---|
| L1 协调者 policy | `systemPrompt.context().text` | 宿主每回合 | 每回合（不被 compaction 吃掉） | 100% 回合 |
| L1 偏好段 | 同上（`renderPreferenceBlock`） | 同上 | 每回合 | 100%（但只有 2 条种子） |
| `context({mode:'history'})` | 工具 | 协调者 + 子会话 | **模型自愿**，无任何强制点 | 协调者 2/351 回合；子会话 9/292 |
| `context({mode:'project'})` | 工具 | 同上 | 同上（L1 第 111-112 行要求 worktree 决策时调） | 同上（协调者 1 次旧名） |
| `context({mode:'workspaces'})` | 工具 | 协调者 | 需查工作区/仓库事实时 | 1 次（底稿作者当次） |
| **task_create 自动注入** | `buildLessonBlock`→写 `lessons/<slug>-<hash>.md` + `brief.experience` | 插件 | **每次派发**（`memoryInject!==false`） | 187/304 任务（61.5%），其中 165 个恰好 3 条 |
| `task_detail` 经验指针 | L3 文本 | 子会话 | 子会话自觉调 | 205/292 会话（70%） |
| 直接 read 经验文件 | 子会话 `read` | 子会话 | 看到指针后 | 185/292 会话（63%）、191 次 |
| 启动注入 | onboarding 一次性 `agent.steer` | 插件 | 仅新主会话首次 | 不在本次台账 |
| 宿主每回合注入 | `runtime-context` / `time-context` / `working-directory` / `skill-catalog` | 宿主 | 每回合 | 100% |

### 3.1 context 检索的准确范围与打分（`src/tools.js:777-821`, `src/memory.js:229-271`）

- **history**：memories（`project_key IN (hint.key, 'global')`，**默认 hint.key = global**）＋ 全量历史任务（按 title+goal+最后一条消息做 token 计分，**不分项目**）＋ 平台 `sessionQuery.searchSessions`（最多 5 取 3）。
- **project**：workspace 索引文字 → 顶层 30 项 → package deps≤15/scripts≤10 → pyproject/go.mod/Cargo.toml（取一个）→ README 1800 字 → AGENTS 1800 字 → 本项目最近 5 个任务 → `buildMemoryBlock`（事实层 3 条）→ 总长截 6000 字。
- **分词**：CJK 二元组 + ASCII 词，去重后最多 12 个 token；停用词只有 7 个（任务/完成/用户/the/and/for/with）。打分 = 命中词频之和，`decision +2`、`preference/lesson +1`，时间只做 tiebreak。**纯字面 LIKE，无同义扩展、无 IDF、无最低分门槛**。
- **实测检索质量**：8 组真实查询里 5 组拿满 5 条，但 `task-log` 占掉 2/5 槽位（例：`主会话 沙箱 权限 workspace-write` 只回 2 条，首条是 ACL/SID 经验）；对全部 305 个任务做事实层检索，首条命中与查询的 token 重合度均值 **20.3%**。
- **无日志**：`historyView/projectView/workspacesView` 都不写日志 → **无法测量「谁读到了什么」**（本报告的读取统计不得不从会话原始日志反推）。

### 3.2 启动时注入的到底是什么

1. **宿主**：`runtime-context`（含 cwd）、`time-context`、`working-directory`、`skill-catalog`——**没有 README/AGENTS/最近任务/记忆**；AGENTS.md 由 `dsh-agent-instructions` 按 cwd 注入，而协调者 cwd 是指挥舱，仓库与指挥舱都**没有 AGENTS.md**。
2. **插件**：仅 onboarding 一次性 steer（自我介绍一句 + 派索引任务），按设计不复述任何规则（L4，`src/prompt-layers.js:95-109`）。
3. **插件每回合**：L1 = 硬规则 + worktree 策略 + 写域策略 + 偏好 + 能力诊断（`index.js:544`）。**不含任何项目/记忆内容**。

⇒ 「最近任务上下文」在协调者侧的常驻载体只有 L1 的一句「用 task_list/task_status」；一旦 compaction 触发（实测大会话有 1 次 `compact-checkpoint`），此前读过的事实只能靠模型回查工具。

---

## 4 主会话唤起频率与来源

### 4.1 会话谱系与回合量（preset = dsh-orchestrator-coordinator）

| 会话 | 创建 | 日志区间 | 回合 | opener 分布 |
|---|---|---|---|---|
| 6acfc2ee | 11-14T02:36 | 02:36–05:24 | 8 | 人 4 / 通知 4 |
| 1c65ca86 | 11-14T05:49 | 05:49–15:49 | 17 | 人 8 / 通知 8 / 批准 1 |
| 2820c67d | 11-14T06:28 | 06:28–12:22 | 34 | 人 18 / 通知 15 / 结算 1 |
| 38189a4e | 11-14T07:52 | 06:28–15:49 | 32 | 人 18 / 通知 13 / 结算 1 |
| cbdf5c56 | 11-14T13:23 | 13:23–15:49 | 2 | 人 2 |
| ffbc9c4d | 11-14T14:17 | →11-15T15:11 | 140 | 人 74 / 通知 63 / 批准 1 / 结算 2 |
| fcd01826 | 11-15T15:11 | →11-20T02:23 | **360** | 人 166 / 通知 174 / 结算 15 / 批准 4 / 定时 1 |
| 7cd0c2c8 | 11-20T00:55 | 历史复制自 fcd01826，至 11-20T00:55 | 351 | 人 165 / 通知 169 / 结算 12 / 批准 4 / 定时 1（**重复计数，勿叠加**） |
| ff349ffd（当前 `main_session_id`） | 11-15T15:05 | 活跃自 11-20T15:56 | 14 | 人 10 / 通知 3 / 结算 1 |

去重合计 **607 回合 / 8 天**（≈76/天；活跃日 45、90、99、107）。

### 4.2 来源分布（去重后）

| 来源 | 回合 | 占比 | 说明 |
|---|---|---|---|
| 用户消息（`source.kind=user`） | 300 | 49.4% | 人打字 |
| 插件通知（`agent-message`） | 280 | **46.1%** | task_report done/blocked/needs_auth、结算汇总、看门狗、对账 |
| 子会话结算（`subagent-settled`） | 20 | 3.3% | 平台事件直投 |
| 用户批准（`user-approval`） | 6 | 1.0% | 审批卡 |
| 定时（`schedule`） | 1 | 0.2% | digest/automation |

### 4.3 通知量与合并率（`notifications` 表 + 日志）

- 308 delivered、7 skipped（主会话未打开）；logger 里 `notify.delivered` 276（旧版本无该事件名）。
- **`merged_into` 只有 3 条（316 条里 1%）**：5 秒合并窗口几乎不合并，因为同一任务的第二条通知通常在 5 秒之后才到。
- 每任务平均 1.29 条通知（308/239 个创建）。
- 通知拉起的回合**并不比人拉起的轻**：平均 1.90 vs 1.67 次工具调用；9.5% 的通知回合零工具调用（纯确认/收尾）。

### 4.4 节奏

- 回合间隔：p25 0.9 分钟、p50 1.8 分钟、p75 5.2 分钟、p90 9.7 分钟 → 开工期间主会话基本处于「连续短回合」状态，compaction 与上下文压力是真问题（`main.context.observed` 4 次、`main.context.alert.cleared` 1 次；大会话 1 次 `compact-checkpoint`）。
- 其它自发唤醒：`task.idle.watchdog` 11 次、`task.reconcile.summary` 5 + summary-pending 8 次、`task.stalled`（3 次 progress）散见。这些都走同一条「加一条通知 → 可能开一个回合」的路径。

---

## 5 三类内容可达性诊断

### 5.1 关键项目背景（README/AGENTS/决策）

| 需要时想要的 | 实际能不能拿到 | 机制原因 |
|---|---|---|
| 仓库 AGENTS.md 约定 | ❌ 本仓库没有；协调者 cwd 是指挥舱，那里也没有 | `dsh-agent-instructions` 按 cwd 找；插件不读文件（架构明写「插件不读 AGENTS.md」） |
| docs/ARCHITECTURE.md 的决策正本（70 KB） | ❌ 完全不在白名单 | `projectContextFor` 只读 README/AGENTS/package/pyproject/go.mod/Cargo.toml（`src/tools.js:360-381`） |
| README 全文 | ⚠️ 只读前 1800 字，实测截在 `go` 半句 | `readProjectText(README, 1800)` |
| 顶层结构/技术栈 | ✅ | — |
| 项目决策记忆（decision） | ⚠️ 9 条在库里，但只有 `context({mode:'project', target})` 会带 3 条 | 协调者默认 history 查不到项目键 |
| 用户偏好 | ⚠️ 实际只有 2 条出厂种子 | 3 条手写全局偏好是死数据（见 2.5-3） |

**遗漏清单（需要时读不到）**：ARCHITECTURE/LIMITATIONS/CHANGELOG 的架构决策；仓库 AGENTS 约定；「为什么这么做」的历史（虽然写了 decision，但按 3 条随机命中）；当前生效的偏好（只有种子）。

### 5.2 历史实践（lesson/decision）

| 问题 | 数据 |
|---|---|
| 写入覆盖率 | 39.2% 的 done 能蒸出 lesson；117/304（38%）任务 brief 无经验指针 |
| 注入相关性 | 满 3 条但词重合度 20.3%；「总是 3 条」掩盖了「这 3 条可能无关」 |
| 检索召回 | 纯字面 LIKE；实测 8 组查询 3 组拿不满 5 条；协调者/子会话几乎不调 context（2/351、9/292） |
| 日志挤占 | `context history` 不排除 task-log，实测占 40% 槽位；task-log 里 90% 从未被读 |
| 键分裂 | 8 个 worktree 键、11 条不可达 |
| 容量 | 单项目 254/300，按当前 ~60 条/天，**24–48 小时内启动淘汰，先删最老的手记事实** |
| 「完整经验」名不符实 | `lessons/*.md` 每次派发**只写本次命中的 ≤3 条**（`buildLessonBlock`→`renderLessonFile(rows)`），185 个读过它的子会话以为看到了完整经验；并发派发时同项目文件会互相覆盖 |
| 无衰减/无冲突消解 | 只有 use_count 计数，没有 TTL、没有 superseded_by；「0.13.0 发版」这类过期事实与今天的决策同权 |

### 5.3 最近任务上下文

- `task_detail` 给的是**本任务**创建详情 + 按当前台账现读的前置任务摘要（`src/task-detail.js:151`），**不含兄弟任务、不含最近完成的任务**。
- 协调者侧：`task_list` 默认只列活跃任务；历史任务只能 `view:'inbox'`（失败/待决/久无动静）或 `context({mode:'project'})` 的「最近任务 5 条」（不含产物、不含结论）。
- 结果是「刚交付的那批任务」在 compaction 之后没有常驻承载：结论只有两种去处——`delivered` 通知（回合内）、`memories` 的 task-log（永不注入、检索时还挤占槽位）。

---

## 6 业界对照（无联网，基于公开知识）

| 实践 | 本项目现状 | 差距 |
|---|---|---|
| 记忆分层 working / episodic / semantic（MemGPT、Generative Agents 的 memory stream + reflection） | 已有 L1 working、task-log episodic、lesson/decision semantic 三层，分层方向是对的 | 层间没有出口：episodic 不做 reflection 升级为 semantic，只是堆在同一个表里抢配额 |
| 事件边界注入（任务开始/交接时注入，而不是每回合） | task_create 注入正是这个模式 | 注入内容没有质量门槛（IDF/最低分/去重），等于「固定 3 条噪音」 |
| 检索：混合（BM25/向量）+ 重排 + 时间衰减 | 词频计数 + kind 权重 + 时间 tiebreak | 缺 IDF（通用词主导）、缺衰减、缺最低分、缺去重 |
| 去重与合并（同义事实合并、superseded_by） | 全文 hash 精确去重 | 无近似去重、无冲突标记，旧决策与新决策同时可命中 |
| 遗忘曲线 / LRU / 容量治理 | 单项目 300 条 FIFO 淘汰，不分层 | 会先丢最珍贵的手记事实、留最多的是日志 |
| 上下文工程（context rot / lost-in-the-middle / 预算分层） | L1 每回合全量重渲染、prompt-layers 有明确分层与字数预算 | L1 只放规则不放状态；「最近发生了什么」完全没有位置 |
| resume 与记忆（checkpoint + 摘要接力） | 宿主 compaction + `resume` 冷恢复；插件只观测与提醒 | 压缩后没有「任务台账摘要」接力，模型需重新 tool 调用才知道在做什么 |
| 主动检索 vs 被动注入（Tool-based retrieval，如 Claude Code 的 memory 工具） | 两者都有（context 工具 + task_create 注入） | 主动检索**没有强制点**（L1 只是「可用」），模型 99% 不调 |

---

## 7 改进建议（ranked）

排序原则：优先「改动小、收益大」。

| # | 改动点 | 收益 | 成本 | 优先级 |
|---|---|---|---|---|
| 1 | `historyView` 默认键改用 `defaultDir()`（无 project 且能推断项目时），只有真推断不出才 global（`src/tools.js:317-319,777-783`） | 默认调用立刻能查到 254 条项目记忆（现在 0 条）——这是最大的一处「读不到」 | ~10 行 + 1 测试 | **P0** |
| 2 | 注入与检索加质量门槛：最低 token 命中数 ≥2 或 score ≥2；对「插件/任务/测试/实现/代码/文件」等通用词加停用词；`decision/preference` 与 `lesson` 分层配额（如 2+1） | 把「永远 3 条、20% 相关」变成「少而准」；同 1200 字预算下信噪比显著提升 | ~30 行 + 快照测试 | **P0** |
| 3 | 淘汰分层：300 条配额只算 `task-log`，或对 fact 层设「最低保留 + 不参与淘汰」；日志层单项目 200 条 | 阻止 24–48 小时内开始删手记事实；同时压住 log 膨胀 | ~15 行（不改表） | **P0** |
| 4 | worktree 记忆归一：done 写入的 projectKey 取 `brief.target ?? repo_root ?? target_dir` | 8 个分裂键下的 11 条记忆回到项目；未来隔离任务不再丢经验 | ~5 行 | **P0** |
| 5 | `context history` 结果分块与配比：task-log 单独成块、最多 2 条且排在事实层之后（或默认 `kinds=事实层`，加参数才查日志） | 释放 40% 的检索槽位给事实层 | ~10 行 | **P1** |
| 6 | 项目背景白名单加 `docs/ARCHITECTURE.md`（截断 3000–4000 字）+ 支持显式 `include` 参数 | 架构决策正本第一次变得可读；改善「关键项目背景读不到」 | ~40 行 | **P1** |
| 7 | 偏好迁移：启动时一次性把 `memories` 里 `project='global' AND kind='preference'` 合并进 settings（幂等标记） | 3 条死数据复活，避免「记了偏好其实没生效」的长期误解 | ~20 行 | **P1** |
| 8 | 通知质量：把 5 秒窗口改成「同任务/同批次聚合 + 回合结束再投递合并摘要」；`delivered` 与结算摘要合并为一条 | 直接减少 46% 通知驱动回合中的一部分（实测零工具回合 9.5%），降低 token 与抖动 | 中（notify.js 策略 + 测试） | **P1** |
| 9 | `lessons/*.md` 语义修正：写「本项目事实层全部（上限 50 条）」或把文件头改成「本次命中 3 条」 | 消除 185 个读取会话的「完整经验」误解；同时让并发派发不再互相覆盖丢内容 | ~15 行 | **P1** |
| 10 | 读取可观测：`context` 三种 mode 记日志（mode/query/命中数/kinds/调用方），`memory.note` 统一补 `route` | 现在完全无法回答「记忆有没有被读到」，改完才能度量后续优化 | ~10 行 | **P1** |
| 11 | 给协调者一个「最近任务摘要」常驻段（L1 末段或通知尾部：最近 5 个已交付任务的标题+一行结论+产物数，≤400 字） | compaction 后仍有「我在做什么」的锚点；减少重复派发 | 中 | **P2** |
| 12 | 近似去重 + 冲突消解（16 字前缀 + 相似度 ≥0.8 合并；`superseded_by` 字段） | 抑制同义事实堆积；让「方向已变」的旧决策不再命中 | 高（要迁移） | **P2** |
| 13 | 时间衰减与失效标记（30 天未用降权；显式 `expires_at`） | 减少过期事实（如 0.13.0 发版细节）污染 | 高 | **P2** |
| 14 | 语义检索（宿主若有 embedding 服务则混合检索；否则至少 IDF 加权） | 解决「0 命中 / 只共 1 个词」 | 高 | **P2** |

**建议的最小落地包**：1+2+3+4+5（≈70 行 + 测试），一次性把「项目记忆读不到、注入不准、事实被日志挤掉、隔离任务记忆丢失」四个真问题收掉，且都不改表结构。

---

## 8 不做 / 风险

- **不建议**给协调者塞「全量记忆」进 L1：1200 字预算与每回合重渲染意味着成本随回合线性增长，且会与 compaction 抢预算；业界一致做法是「检索 + 门槛」，不是「塞满」。
- **不建议**让子会话写记忆（现有 deny 是对的）：会引入第二个写方与键归属争议；缺的是 summary→lesson 的产出率（39%）与质量，不是写权限。
- **风险**：`context` 默认改成项目键后，跨项目查询的行为会变（旧调用不带 project 会从 global 变成本项目）；需要一个可显式回退的 `project:'global'`，并在 CHANGELOG 标注行为变更。
- **风险**：淘汰分层会改变「300 条」这一既有不变量，需要同步 README/LIMITATIONS 与 `test/memory*.test.js` 的断言。

---

## 9 取证与复现（只读）

- **台账**：`node -e` + `new DatabaseSync(<state>/tasks.sqlite,{readOnly:true})`，查 `memories/tasks/messages/notifications/settings`；`snapshots/tasks-2026-11-15…21.sqlite` 对比 settings 键。
- **日志**：`logs/orchestrator-*.jsonl` 按 `event` 计数；关键事件 `memory.note` / `notify.delivered` / `task.report` / `task.idle.watchdog` / `main.context.observed`。
- **主对话**：逐 `0x28 0xB5 0x2F 0xFD` 帧解压 `<sid>/session.v4.jsonl.zstd`，取 `turn/start`、`user/message.data.source.kind`、`tool/call.data.name/arguments`。
- **检索行为**：`import('src/memory.js')` 直接调 `searchMemories` / `distillLessons`（只读连接）。
- **代码坐标**：`src/memory.js:32,69,128-152,193-222,229-271,399-422`；`src/tools.js:317-319,346-394,777-821,1140-1155,1574-1617,1791-1815`；`src/preferences.js:103-125,160-189,205-212`；`index.js:529-548`；`src/task-detail.js:53-66,151-153`。

---

## 10 待确认要点

以下 5 条全部保留自底稿（`t-dde45926` 报告第 10 节），仅按 [§11.3](#113-编辑约定) 的第三人称化规则调整了第 5 条的自称（「我这边」→「底稿侧」），判断与条件未改：

1. **P0 包里第 1 条是行为变更**：`context({mode:'history'})` 不带 project 时改查「当前项目」，同时保留 `project:'global'` 回退——是否接受这个语义变更？
2. **容量策略**：task-log 是否愿意单独限容（比如留 200 条、fact 不参与淘汰）？这会改变已公开的「单项目 300 条」口径。
3. **架构文档是否进 project 白名单**：读 `docs/ARCHITECTURE.md` 前 3000–4000 字意味着 `context({mode:'project'})` 输出变长（当前总长已截 6000 字），要不要改成显式 `include` 参数（默认不带）？
4. **旧偏好迁移**：11-15 那 3 条全局偏好（present 数量、汇报用任务名、planFirst 交付计划文档）是否要迁进 settings 生效？其中 present 那条还有一条「更正」（1–2 → 1–4），迁移时要取更正后的版本。
5. 底稿执行时是只读任务、未创建任何文件；报告正文即交付物。如需落盘为 `reports/memory-and-main-session-audit.md`，请派一条可写任务（底稿侧沙箱 read-only，写文件会被拒）。

**补充（落盘出处，非底稿原话）**：

6. 本报告由 `t-dde45926` 只读调研整理落盘（落盘任务 `t-608124eb`）。落盘时只做结构重排、标题分层、表格与锚点整理，并修正 1 处底稿笔误（建议 13 中的非中文串改为「减少」）；**未新增任何调研结论，也未改动任何数字、代码坐标或判断**。

---

## 11 底稿对照与落盘说明

### 11.1 章节映射（便于回查原报告）

| 本报告 | 底稿 `t-dde45926` 报告 |
|---|---|
| §0 结论摘要 | 开头「结论摘要（TL;DR）」+「九条最硬的事实」+「主会话唤起频率（实测）」 |
| §1 方法 | §1 方法（只读，未写任何文件） |
| §2 写入链路 | §2.1–§2.5 |
| §3 读取链路与触发时机 | §3 及 §3.1、§3.2 |
| §4 主会话唤起频率与来源 | §4.1–§4.4 |
| §5 三类内容可达性诊断 | §5.1–§5.3 |
| §6 业界对照 | §6 |
| §7 改进建议（ranked） | §7（含「建议的最小落地包」） |
| §8 不做 / 风险 | §8 |
| §9 取证与复现 | §9 |
| §10 待确认要点 | §10（第 1–5 条逐字保留，第 6 条为本次落盘新增的出处说明） |

### 11.2 落盘时点的快速复核（仅佐证，不改结论）

落盘时（2026-11-21T03:44Z 前后）用 `node:sqlite` 只读复测了底稿引用的几处台账事实，结论与底稿一致、且容量压力更紧：

| 检查项 | 底稿（报告时刻 03:40Z） | 落盘时点复测 |
|---|---|---|
| memories 总数 | 322 | 329 |
| 其中 task-log | 208（65%） | 211（64%） |
| 项目 `…\documents\dsh-orchestrator` 的记忆条数 | 254 / 上限 300 | **261 / 300** |
| `settings` 里的键 | 无 `orchestrator_preferences`、无 `workspace_repo_index` | 仍只有 `coordinator_session_id` / `main_session_id` / `main_session_preset` 三键 → 死数据与仓库索引降级结论不变 |
| worktree 分裂键 | 8 个键 / 11 条 | 仍在（如 `...\.agents\worktrees\t-9804a5a3` 3 条等） |

含义：底稿「24–48 小时内启动淘汰」的窗口没有变宽——项目键已到 261/300，按 ~60 条/天写入量，最先被淘汰的仍是 11-14/11-15 手记的 decision/note。

### 11.3 编辑约定

- 数字、比例、代码坐标（`文件:行号`）、事件名、表名一律照抄底稿，不做四舍五入或重算。
- 底稿中的口语化补充（如「我这次调用」）统一改为第三人称「底稿作者当次」，避免读者误以为是本次落盘作者的行为。
- 底稿明确写「无联网」的业界结论，本报告保留该限定，未补充外部来源。
