# dsh-orchestrator（npm 包名：@wjj865-code/dsh-orchestrator）

协调者会话 + 子任务工作台（服务端核心 + 阶段 2 客户端入口/任务面板）。

协调者只做协调：把需求拆成结构化任务、派给子会话、看回报、决定是否打扰用户；子任务就是一个独立子会话（直连 `ctx.subagents.startActivation`，不占 Team 名册），能力不受限，只多一个 `task_report` 回报工具。

平台并发有上限（`maxActiveSubagents`，默认 8，满了抛 `ACTIVATION_LIMIT_REACHED` 且**平台不排队**），所以插件自己维护待派发队列：任务先进台账排队，槽位空出来按创建顺序自动补位，用户不会看到「名额满了」这种失败。

## 落盘范围

唯一写入都在 `$DSH_HOME/state/orchestrator/` 下：

```
tasks.sqlite                      （+ -wal / -shm）
logs/YYYY-MM-DD.jsonl             （按天一个文件，保留 7 天，单文件超 5MB 换新）
snapshots/tasks-YYYY-MM-DD.sqlite （每天一份 VACUUM INTO 快照，保留 7 天）
```

`DSH_HOME` 未设置时用 `~/.dsh`。不写 profile、不写其他会话目录。快照在插件启动时生成，之后每 6 小时检查一次跨日；同一日不覆盖，`retentionDays` 可配。

## 日志与排障

协调者侧日志写在 `$DSH_HOME/state/orchestrator/logs/YYYY-MM-DD.jsonl`（按天、保留 7 天、单文件超 5MB 换新）。覆盖建任务/去重与额度拒绝/派发成败/回报/通知投递/启动清理/绑定变更，每条带 `callId` 把同一次调用串起来。`goal`/`summary` 只留 80 字摘要，**不写 `user_verbatim`**；写日志失败只 warn 一次，不影响主流程。

只凭当天日志应能回答三个问题：这次创建为什么被拒（reason 码、`maxQueue`、队列情况）、派发为什么失败（平台错误原文、provider）、通知为什么没送到（level、reason、sender/coordinator）。报问题请附当天日志。

## 安装（维护者操作，不碰用户的 `~/.dsh/profiles`）

在目标 profile 目录（`~/.dsh/profiles/<name>`）做两处必改：

1. `package.json` 的 `dependencies` 加本地链接：

   ```json
   "@wjj865-code/dsh-orchestrator": "link:C:/Users/72489/Documents/dsh-orchestrator"
   ```

2. `dsh.profile.bundles` 里加 `@wjj865-code/dsh-orchestrator`：

   ```json
   [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-headless",
     "@wjj865-code/dsh-orchestrator"
   ]
   ```

   无头 profile 用 `@deepseek-ai/dsh-headless`，桌面 profile 用 `@deepseek-ai/dsh-web-app`。
   直连子会话还要 `ctx.subagents` 和本地 `spawn` provider（`@deepseek-ai/dsh-subagent` + `dsh-subagent-spawn-in-process`，随平台 bundle 自带）。`agentTeams` **不再是前置**：插件按需惰性获取，缺它照常激活、subagent 后端正常工作；只有显式把 `backend` 配成 `team` 时才需要 `@deepseek-ai/dsh-experimental-agent-team-profile`（缺了给可读错误，不影响其它功能）。

3. 可选：需要显式指定协调者时，profile 的 `cordis.patch.yml` 加配置行；不配就自动绑定：

   ```yaml
   - id: orchestrator
     name: '@wjj865-code/dsh-orchestrator'
     config:
       coordinatorSession: session-c0531830-f695-42d3-879c-6d5b8e9a8799
   ```

4. 重新安装/重启该 profile 使其生效。

## 其他地方安装（从 GitHub 装）

适用于另一台电脑或另一个 profile，**不需要本仓库源码**：

1. 打开 DSH → 插件 → **添加插件** → 在输入框粘贴仓库地址，点「安装」：

   ```
   https://github.com/wjj865-code/dsh-orchestrator
   ```

   仓库是 Public，直接粘贴地址即可安装（私有仓库才需要先配 SSH key）。
2. **装完必须彻底退出 DSH 再启动**（只关窗口不生效）：宿主进程只在启动时加载插件。
3. **升级**：先卸载旧版、再安装新版（平台不对非官方插件做原地升级），装完同样彻底重启。
4. **入口**：纯 dsh 表面左侧栏「插件」下方有「◈ 主会话」，点一下直达主会话对话；Bot 模式下 ds-bot 会隐藏整条侧栏面板列表，此时用会话头「☰ 任务」按钮进任务面板，也可在面板里点「打开主会话」。
5. **无需额外配置 profile**：`agentTeams` 不是前置（插件惰性获取，缺它照常激活、subagent 派发正常）；只有把 `backend` 配成 `team` 才需要 agent-team profile。

装好后按「真机冒烟清单（隔离 profile）」逐条确认。

## 从 npm 安装（推荐，更新更简单）

仓库包名是 `@wjj865-code/dsh-orchestrator`（scoped 包）。这个 scope 必须属于你的 npm 账号：如果 `wjj865-code` 不是你的 npm 用户名，先在 npmjs.com 创建同名组织，或把 scope 改成你自己的用户名。npm 上的无 scope 名 `dsh-orchestrator` 已被另一个项目占用。

维护者发布：

```bash
npm config get registry   # 应为 https://registry.npmjs.org/
npm login                 # npm 10 会打开浏览器；按提示登录
npm whoami                # 确认登录账号
npm publish --access public
```

scoped 包默认是私有，**必须带 `--access public`** 才会公开；开了 2FA 时 publish 会要 OTP，可加 `--otp=123456`。如果浏览器登录打不开，可用 `npm login --auth-type=legacy`（老账号/密码方式），或先在 npmjs.com 网页登录后重试。

用户安装：

1. DSH → 插件 → **添加插件** → 粘贴包名（或带版本）：

   ```
   @wjj865-code/dsh-orchestrator
   ```

   也可以安装指定版本：`@wjj865-code/dsh-orchestrator@0.4.0`。
2. 装完彻底退出 DSH 再启动。
3. 以后升级：`npm version patch` → `npm publish` → 在 DSH 插件页用 registry 包的更新入口升级（DSH 的 plugin manager 对 registry 包支持 `listVersions` / `updateBundle`），不再需要卸了重装 GitHub 版。

> 从旧包名 `dsh-orchestrator` 迁过来时，先卸载旧包；本地 link 安装的 profile 要把依赖键和 `dsh.profile.bundles` 一起改成 `@wjj865-code/dsh-orchestrator`。

## 主会话（预设开启）

解析顺序：`config.coordinatorSession`（显式覆盖，优先级最高，**不写台账**）→ 台账 `settings.main_session_id` → 未打开。

- **固定入口**：面板右上角「打开主会话」调用 `POST /api/orchestrator {endpoint:'open-main'}`。插件确保指挥舱工作区（`~/.dsh/state/orchestrator/workspace`，显示名「指挥舱」）存在，用**协调者预设** `dsh-orchestrator-coordinator` 创建会话，`rename` 成「主会话」，写 `settings.main_session_id`，然后跳到该会话。
- **不再自动绑定**：`task_create` 不再把调用方会话绑成协调者。没有主会话时 `task_*` 返回「尚未打开主会话，请先从面板「打开主会话」」，不建任务、不写库。
- **只允许主会话**：`task_create` / `task_list` / `task_status` / `task_message` / `task_stop` / `task_retry` / `history_search` / `project_context` / `memory_note` 拒绝非主会话调用（含子会话）；`task_report` 仍归子会话。
- **复用与预设守护**：创建/重建时把预设记进台账 `settings.main_session_preset`；之后只要「`settings.main_session_id` 指向的会话 live + 台账标记是 `dsh-orchestrator-coordinator`」就复用，**不因平台读回漂移而重建**（重建会换 id、通知目标漂移）。旧版本没有台账标记的主会话，只有能明确读到协调者预设时才认领复用，否则重建一次。UI 打开空白会话可能把它 rebind 成默认（`standard`）；主会话在 `agent/created` 和每次复用前会调 `agentPresets.select(agent, 'dsh-orchestrator-coordinator')` 拉回，非空白会话抛 `agent-preset/locked` 只记日志、由 guard 全名单兜底；读回不一致记 `main.session.preset-mismatch`，`open-main` 返回 `presetMismatch` 供面板提示。旧任务留在面板。
- **工具集在预设层定型**：协调者预设只挂 `persona`、`agent-instructions`、`time-context`、`tool-ask-user`、`compaction` 和 `@wjj865-code/dsh-orchestrator/preset-tools`；`preset-tools` 用 deny 补集把 allow 名单（5 个 `task_*` + `task_retry`、`history_search`、`project_context`、`memory_note`）之外的全局工具挡掉，`ask_user_question` 由预设自己的行提供。`show_view` 默认不带（待真机确认）。
- **任务执行者预设**：子会话由 dispatch 显式带 `dsh-orchestrator-worker`，是一份缩小的工作栈（文件/shell/web/todo/skill/compaction/present，无 delegation/goal/plan/schedule），绕开协调者预设的收窄。
- `spawnProvider` 必须是 `spawn`（`fork` 不支持 `agentPreset`）；不是 `spawn` 时「打开主会话」返回可读错误，不静默降级、不改配置。

## 跨项目记忆与项目背景

- `memories` 表与任务台账同库。`task_report` 的 `done` 自动沉淀一条「任务完成 + 摘要 + 产物」；`memory_note` 显式记录用户决策、偏好、约束。
- `task_create` 默认按目标项目 + 标题/目标关键词召回 top N 条，追加到 brief 的 `【历史经验】`；上限 1.2k 字，`memoryInject` / `memoryLimit` 可调，检索失败不阻塞派发。
- `history_search` 聚合三路：插件 memories、台账历史任务、平台 `sessionQuery.searchSessions`；按项目过滤，关键词走 CJK 二元组 + ASCII 词，按命中数和时间排序。**不是向量语义检索**，召回是近似的。
- `project_context` 只读项目白名单：`README.md` / `AGENTS.md` / `package.json` / `pyproject.toml` / `go.mod` 等 + 顶层目录 + 最近任务 + 相关记忆；不读 `.env`，不开放任意文件读取。
- 快照损坏时错误信息指向 `snapshots/`；当前**不自动恢复**，需要手工用快照替换 `tasks.sqlite`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `coordinatorSession` | `undefined` | 可选显式覆盖主会话；不配则读 `settings.main_session_id`（面板「打开主会话」写入） |
| `backend` | `subagent` | 派发后端：`subagent`（直连 `ctx.subagents`）或 `team`（旧的 agentTeams 名册，仅旧版平台可用；**rc.3 起平台移除了成员 API，选它会加载时告警、派发返回可读错误**） |
| `spawnProvider` | `spawn` | subagent provider（本地 fresh 子会话用 `spawn`） |
| `staleMinutes` | `30` | `task_list` 里超过这么多分钟无动静就标 `⚠` |
| `stallRounds` | `3` | 预留：阶段 3 的连续无进展升级阈值，阶段 1 只校验并保存 |
| `maxQueue` | `50` | 队列安全阀：`pending` + `waiting_dep` 到这个数就拒绝新建（不落库） |
| `autoResumeQueue` | `true` | 重启后把排队中的任务自动重新入队并派发；关掉则只恢复队列不自动跑 |
| `maxActive` | — | **已移除**：并发上限改由平台 `ACTIVATION_LIMIT_REACHED` + 插件队列自适应，旧配置里写了也会被忽略 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |
| `memoryInject` | `true` | 新建任务时把相关历史经验注入 brief；显式 `false` 关闭 |
| `memoryLimit` | `3` | brief 注入的记忆条数，1–10 |
| `snapshotRetentionDays` | `7` | 台账快照保留天数，1–30 |

## 派发与排队

- `task_create` 只做「校验 → 去重 → 落库 → 入队」，派发由队列异步完成；返回文案区分「已派发」和「已创建，前面还有 N 个任务在排队」。
- 队列单锁串行（同时只有一个 pump）；`spawn` 抛 `ACTIVATION_LIMIT_REACHED` 时任务留在 `pending` 并标 `queued_at`，不报错、不标 `failed`，按 2s/5s/10s/30s 退避重试。
- 唤醒时机：子会话 `result` 结算（平台完成即释放并发槽位）、任务到终态、`task_stop`、插件启动、协调者 `agent/created`。
- 子会话创建的非容量错误（真正的失败）才标 `failed` 并写可读原因，不留 `pending` 幽灵；**失败会给主会话推一条「任务「X」失败：原因」通知**（系统通知没有子会话 sender，用主会话自身 id 投递），不再静默 failed。
- 「协调者会话尚未就绪（`agent.session` 为空）」按可重试处理：任务留在队列，等主会话就绪后重试，不标 failed。
- 排队中的任务被 `task_stop` 会直接取消并移出队列；`task_message` 对排队任务返回可读提示（还没有子会话可续派）。

## 依赖、分组、写域与优先级（P1）

- `task_create` 新增可选参数：
  - `dependsOn`：前置任务编号数组（最多 20 个），必须存在且不能是 `failed/cancelled/orphaned`。
  - `group`：分组名，`task_list({ group })` 可看该组进度；面板行显示分组。
  - `writeScopes`：写域（目录/文件路径），与活跃任务重叠时返回冲突提示，仅 advisory，不阻断。
  - `priority`：`-10..10`，高的先派发；同优先级按创建时间 FIFO。
- 前置未完成时任务落 `waiting_dep`（不派发、不占并发位）；每次 `queue.pump` 先做依赖晋升：
  - 前置全部 `done` → `pending` 并入队；派发时 brief 追加 `【前置任务】` 摘要和产物路径。
  - 前置 `failed/cancelled/orphaned` 或不存在 → 下游自动 `failed`，错误写明哪个前置未完成。
- 只允许依赖已存在的任务，创建时不接受“未来的 id”，因此不会出现环；依赖失败后先 `task_retry` 前置，再重派下游。
- `maxQueue` 口径包含 `waiting_dep`，避免等待图无限膨胀。
- 面板/快照行新增 `dependsOn`、`groupId`、`writeScopes`、`priority`；`waiting_dep` 显示「等前置」。

## 只读子任务（显式 `readOnly`）

- `task_create` 可选 `readOnly: true`（默认 false）；**只认显式 true**，字符串/偏真值不算，不按标题关键词猜。协调者自己判断任务性质（分析/审查/评估）后显式传。用法：

  ```js
  task_create({ title: '审查登录模块', goal: '找出风险点并给结论', acceptance: ['列出风险'], readOnly: true })
  ```

  只读任务照常参与 target 推断、照常上报 artifacts（只标存在性）。
- 派发时给该子会话 append 一条 `sandbox/mode { mode:'read-only' }`（平台唯一写入口；等价于导出的 `setSandboxMode`，插件不 import 平台包，单测锁定事件形状/名称）：`agent/created` 一到就设一次，激活返回后再幂等补一次；`sandboxPolicy.overrideOf(session)` 已是 `read-only` 就跳过。事件按会话持久化，续派/重启 replay 后仍生效；resume 出新的 Session 对象且投影尚未读回时，续派会再补一次。
- 效果：读、`task_report`、artifacts 照常；写文件/写 shell 被沙箱拒绝并给可读错误；**只读任务不会注册 target 可写根**（否则「只读」有后门）。不改用户的 `permissionPreset` 与全局沙箱默认；只 append 到我们派出的 child session，不碰协调者（协调者被设只读会污染后续所有子任务）。
- 文案：brief 加 `【权限】只读` 与「不要写文件/写 shell，产物写进回报正文」；台账 `read_only`、`task_list`/`task_status` 标记「只读」；通知标题与面板任务行也标「只读」。
- **首回合时序（已用勾子关住，仍如实记录）**：`agent/created` 一到就设只读，早于首个模型请求；真机复核（`0.2.2`）子会话首个请求的 runtime-context 就是 `Current DSH file policy: read-only`，写调用直接被拒。极端时序下若某次写抢在设置之前，会拿到一次沙箱拒写、下一回合生效；判据始终是子会话首个请求的 policy 行。
- **仅 `subagent` 后端支持**：`backend:'team'` 没有会话级只读通道，`readOnly:true` 会得到可读错误「team 后端不支持只读任务…」，不会出现「台账标只读、实际可写」。

## 目标目录推断与交付产物

**目标目录**（`task_create`）：

- 显式传 `target`：必须是已存在的绝对目录，行为不变（相对/不存在/非目录都拒绝）。
- 不传 `target`：用 `title` + `goal` 匹配 `workspaceRegistry.list()` 的工作区**显示名（`title`）与路径末段**，大小写不敏感；纯 ASCII 键至少 3 个字母数字、CJK 键至少 2 字，避免 `ai`/`main` 误命中。
- 精确名（与 title 或 goal 全等）优先，且只在精确命中集合里取结果；否则看子串层。
- **通用词末段黑名单**：路径末段归一化后全等 `workspace / documents / document / desktop / default / src / app / tmp` 时不参与路径末段匹配（显示名照常参与），避免「指挥舱」的末段 `workspace` 把任何提到 workspace 的任务都算命中；`default-workspace` 这类更具体的末段不受影响。
- **子串层包含消歧**：某个命中的全部匹配文本都被另一命中的某个文本**严格包含**时，丢掉更泛的那条（`orchestrator ⊂ dsh-orchestrator` 只留更具体的）；key 相等（两个同名工作区）或互不包含时都保留，仍走多命中候选。
- **唯一命中**：直接用该工作区 `path`，同时写入 `tasks.target_dir`（面板显示、artifacts 相对路径都靠它）。
- **多命中**：不建任务、不猜测，返回「匹配到多个工作区」+ 候选 `title → path`，请协调者让用户用 `target` 指定绝对路径。
- **无命中**：不写 `target_dir`，**沿用主会话所在目录**（通常是指挥舱；用 `coordinatorSession` 显式覆盖时跟随该会话目录），与旧行为一致。
- `workspaceRegistry` 不可用时按无工作区降级，不影响派发。
- **已知取舍**：黑名单是固定小词表，不按语言/词频扩展；末段是表外通用词时仍可能多命中。此时按「不猜」给候选，用户用显式 `target` 即可；要收紧就往表里加词，不在命中逻辑里做猜测。

**交付产物**（`task_report`）：

- 可选 `artifacts: [{ path, label? }]`；`path` 可相对，按任务目录（`target_dir`，没有则指挥舱）解析成绝对路径。
- 非法条目（非数组、缺 path、非字符串）静默丢弃；存在性只做 `stat`，不存在标 `exists:false`、展示「未找到」，**任务照常 done**。
- 落台账 `tasks.artifacts_json`（旧库自动 ALTER），`task.artifacts` 读出数组。**同一任务多次回报按 `path` 累积合并**：不同路径保留，同路径后报覆盖；最多 50 条，避免覆盖掉前一步的产物。
- `done`/`blocked`/`needs_auth` 通知在摘要后追加：

  ```
    产物：
    - <绝对路径> — <说明>（未找到）
  ```

  合并窗口内多条 report 的产物各自保留，不互相覆盖；不传 `artifacts` 时通知文本与旧版逐字一致。
- 面板任务行显示「产物 N」徽标，点击展开绝对路径列表；旧任务无字段按空数组处理。
- 只认子会话**显式上报**，不扫描目标目录。

## 子会话与孤儿

- 子会话是 `origin:'subagent'` 的会话，**不在普通会话列表里**；卡片/`task_status` 带子会话 id，客户端要按协调者会话的子代理目录（subagent catalog）打开。
- 启动/协调者加载时对账，两条判据：① `running` 但子代理不 live（进程重启后本来就没有在跑的回合）→ `orphaned`，不留「台账在跑、实际没人在跑」的幽灵；② `running`/`waiting_*` 的 `session_id` 在 `listChildren(协调者会话)` 里查不到 → `orphaned`（已丢失）。`waiting_user`/`waiting_auth` 即使子级不 live 也保持原状态（故意停下，靠 `task_message` 冷恢复）。
- 对账本身失败（catalog 服务不可用）只 warn、保留原状态，不把 running 全判死；`orphaned` 是终态，不参与去重，可再派同 title+goal 的新任务重建。
- 父会话关闭会释放后代子会话，但子会话是 durable 的：协调者重开后 `task_message` 可冷恢复。

插件按绑定的会话 id 惰性解析 live agent，所以协调者会话可以在插件加载后再打开；白名单在绑定时安装，并通过 `agent/created` 补装。非法值（0、负数、NaN、Infinity、字符串）一律回落默认，不会把插件带崩。

## 客户端入口与任务面板（阶段 4 起）

- **侧栏入口（直达主会话）**：`sidebar.panellist` 条目 `{id:'orchestrator-launcher', order:5, label:'主会话'}`，排在「插件」(order 0) 与「自动化任务」(order 10) 之间；点击由侧栏固定 `selectPanel('orchestrator-launcher')`，对应的 `main` 启动器面板挂载即复用 `open-main` → `uiWorkspace.openSession(sessionId)` → `layout.selectPanel(null)` 回到对话，**不先停在面板上**（只有一帧「正在打开主会话…」占位）。`open-main` 与面板按钮共用同一个 in-flight 去重，不另起创建逻辑。
- **任务面板**：从会话头按钮 `conversation.header.leading` 进入（`selectPanel('orchestrator')`）。**侧栏底部 `sidebar.footer.action` 不再注册**（用户要求删掉底部「任务」入口）。面板页是 `main` 的 `key:'orchestrator'`；每条任务可「打开子会话」，走 `ctx.uiWorkspace.openSession(id)`（与平台 `ui-subagent.openChild` 同款）。任务行显示目标目录（截断 60 字）。
- **Bot 模式**：ds-bot 用 `!important` 藏掉整个 shell 面板列表（`nav[class*="_panelList"]{display:none!important}`），所以侧栏启动器只在**纯 dsh 表面**可见；Bot 模式仍可用会话头按钮打开任务面板。不碰 ds-bot 的 `sidebar.workspaces`/`conversation.session.header`。
- **数据**：`/api/orchestrator` POST。`{ endpoint: 'snapshot' }` 只读；`{ endpoint: 'open-main' }` 是唯一动作端点（创建/打开主会话，返回 `sessionId`）。鉴权由 connection 服务统一负责（401/403、exact 路由 owner-only）；snapshot handler 只 import 查询函数、**不写台账**。面板打开时拉一次、可见时 5s 轮询，连续失败退避 30s，可按状态筛选；失败显示「台账暂不可用」，不阻塞会话（平台对 handler 异常回 400 空体，客户端会显示 `HTTP 400`）。
- **产物**：`client.js` 是**经典脚本**（`window.__ModuleLoader__.load({ id:'@wjj865-code/dsh-orchestrator', factory })`，顶层无 import/export），`package.json` 声明 `dsh.client.platform:'web'`、`exports["./client"]`、`files` 含 `client.js`。MVP 无构建；`npm run check:client` 只做语法检查。

## 真机冒烟清单（隔离 profile）

1. **加载**：10 个工具出现（5 个 task_* + `task_retry`、`history_search`、`project_context`、`memory_note` + `task_report`）；日志无「未找到协调者会话」「白名单安装失败」「缺 `agentTeams`」。
2. **建任务**：`task_create` 返回「已派发」；子会话真的被创建；台账 `running` 且 `session_id`/`target` 已写。
3. **输入**：子会话收到的是渲染文字，不是 JSON。
4. **回报**：`progress` 不打扰；`done` 是插件 5 秒合并后 `agent.steer` 注入协调者会话，`notifications` 一行 `delivered`；平台自己还会发一条 `subagent-settled`，不写行、不算插件通知。
5. **等待态闭环**：`blocked`/`needs_auth` → `task_message` 续派 → `running` → `done` 能走通。
6. **R8 忙时排队**：协调者正在跑一轮时再回报，插件注入在下一步边界被接纳、不丢。
7. **白名单**：协调者工具列表里没有 `read`/`bash` 等；无安装失败日志。`spawn_teammate`/`send_message`/`list_agents` 阶段 1 仍可见（见已知局限）。
8. **落盘**：`DSH_HOME` 下新增 `state/orchestrator/tasks.sqlite`（+`-wal`/`-shm`）、当天 `snapshots/tasks-YYYY-MM-DD.sqlite`，不写 profile 和其他会话目录。
9. **审计口径**：插件通知与 `notifications` 行 1:1；`failed` 带 `reason`，`skipped` 的 `delivered_at` 为空；平台 settlement 通知不写行。
10. **主会话**：面板右上角「打开主会话」→ 指挥舱工作区 + 协调者预设创建会话，`settings.main_session_id` 写入，自动跳到「主会话」；再次点击复用、不重复创建。
11. **工具集**：主会话工具表只有 `task_create/list/status/message/stop/retry`、`history_search`、`project_context`、`memory_note` 与 `ask_user_question`（`read`/`write`/`bash`/`wait_agent` 不可见）；平台日志有 `preset-tools: deny …` 审计行；任务子会话有 `read`/`write`/`bash`/`task_report`，且不叠协调者的 deny。
12. **失效/覆盖**：删掉主会话后点入口能重建、旧任务还在；配置 `coordinatorSession` 时不写 `main_session_id`、运行期白名单只装该会话；未打开主会话时 `task_*` 返回提示、不建任务。
13. **并发排队**：连续建 12 个任务，前 8 个跑起来、第 9 个起进队列不报错；完成一个后队列自动补位，且不出现双派。
14. **排队操作**：`task_stop` 能取消排队中的任务并从队列移除；`task_message` 对排队任务给可读提示、不写消息。
15. **孤儿对账**：重启前让某个任务的子会话在 catalog 里查不到，重启后该任务标 `orphaned`，不留幽灵 `running`；catalog 服务不可用时只 warn、不改状态。
16. **卡片数据**：`taskCard` 返回 `childSessionId` / `queued` / `openVia:'subagent-catalog'`，snapshot 每行带 `targetDir`，`task_status` 带打开方式。
17. **记忆闭环**：`memory_note` 写一条 → `history_search` 能查到 → 新建相关任务时 brief 带 `【历史经验】`；`task_report done` 后再 `history_search` 能查到该任务摘要。
18. **项目上下文**：`project_context` 对项目目录返回 README/package/顶层结构/最近任务；不出现 `.env` 内容；不存在的 target 给可读错误。
19. **重派与快照**：人为让任务 `failed` 后 `task_retry` 生成新任务、旧任务保留；`snapshots/tasks-YYYY-MM-DD.sqlite` 可打开且含任务；重启同一天不重复覆盖。
20. **依赖/分组/优先级**：A 运行中建 `dependsOn:[A]` 的 B → B 是 `waiting_dep` 不派发；A `done` 后 B 自动派发且 brief 带 `【前置任务】`；A 失败时 B 自动失败。高 `priority` 任务先派发；同 `group` 可在 `task_list({group})` 看进度；`writeScopes` 重叠只提示不阻断。


## 工具

协调者（9 个）：

| 工具 | 作用 |
| --- | --- |
| `task_create` | 建台账 + 渲染 brief + 入队派发；支持 `dependsOn`（前置）、`group`（分组）、`writeScopes`（写域冲突提示）、`priority`（-10..10）；缺验收标准/队列满（`maxQueue`）会拒绝；并发满自动排队，不报错；`readOnly:true` 时子会话沙箱只读 |
| `task_list` | 默认只列活跃任务（含 `waiting_dep`）；带标题、目标摘要、最近一条消息、排队/缺前置/陈旧标记；`group` 过滤并看组进度；`active:false` 看全量 |
| `task_status` | 单任务详情 + 依赖/写域/分组/优先级 + 最近 3 条消息 + 子会话打开方式 |
| `task_message` | 续派消息（不新建任务），失败重试 3 次后转 `waiting_user`；排队/等前置任务返回提示 |
| `task_stop` | 中断当前一轮并标 `cancelled`；排队中或 `waiting_dep` 的任务直接取消 |
| `task_retry` | 重派 `failed`/`orphaned` 任务：用原 brief 新建一次尝试（新任务号，`retry_of` 留审计）；保留依赖/分组/写域/优先级 |
| `history_search` | 查跨项目记忆、历史任务、平台历史会话；给新任务补上下文 |
| `project_context` | 读项目背景白名单文件、顶层结构、最近任务与相关记忆；只读 |
| `memory_note` | 记一条跨任务有效的决策/偏好/约束，供之后检索与 brief 注入 |

子任务（1 个）：

| 工具 | 作用 |
| --- | --- |
| `task_report` | 每轮结束调用：`progress` / `done` / `blocked` / `needs_auth` |

10 个工具是**全局注册**，子任务会话也能看到协调者工具；`history_search` / `project_context` / `memory_note` / `task_retry` 带 `requireMain`，子会话调用会被拒绝。协调者侧由预设 allow 名单收窄，子任务侧不做限制（设计允许）。

`task_report` 的四档通知：`progress` 静默只写台账；`done` 在 5 秒窗口内合并后汇报；`blocked` / `needs_auth` 立即打扰。插件通知**不经过 Team 的 `sendMessage`**（延迟后发送方已离队，会 `TEAM_NOT_MEMBER`），而是 5 秒合并后直接 `agent.steer` 注入协调者会话，所以合并窗口保得住。每次插件投递尝试都写 `notifications` 表：成功 `delivered`、失败 `failed`（带 `reason`）、跳过 `skipped`；后两者 `delivered_at` 为空。合并的后续行 `merged_into` 指向首条。

平台另有一条 `subagent-settled` 通知：continuable 子会话 settle/dispose 时由 `dsh-subagent` 自动发给父会话，不经过本插件、不写 `notifications`，只能解释「协调者为什么被唤醒」，不能当成插件通知成功。审计看 `notifications` 行与插件注入是否 1:1。

`task_message` 续派成功会把 `waiting_user`/`waiting_auth`/`failed` 拉回 `running`，`task_report` 的 `progress` 也会从等待态恢复，`done` 从等待态会先回 `running` 再完成。

## 协调者不得等待

协调者会话**禁止 `wait_agent` 和任何阻塞等待**：会把当前回合卡住，用户没法再发消息。看进度只用 `task_list` / `task_status`；子任务完成会主动通知；需要等就结束回合，等通知回来再处理。平台 `team:policy` 里有「Lead must wait for required teammates」，本插件的协调者提示会显式覆盖它。

`wait_agent` 是平台按 agent scope 注册的工具，`restrict` 去不掉（`restrictableNames` 里没有），所以用两层保护：

- **执行期 guard**：`ctx.tools.guard` 同步拒绝协调者调 `wait_agent`（返回中文原因）。`task_create` 写入绑定后，**同一回合里顺序执行**的 `wait_agent` 也会被拒；子任务和普通会话不受影响。
- **系统提示**：`orchestrator:coordinator-policy`（`order:130`）只对协调者会话渲染；绑定发生在 step N，禁令从 **step N+1** 的 prompt 起生效（prompt 每步重新装配）。
- **白名单收窄延到回合边界**：文件/shell 等工具的 `restrict` 不在绑定/装配当步装——绑定时若协调者还在 `running`，收窄挂起到回合 `idle` 后再装（本来就 idle 则立即装）。所以绑定回合仍是全工具表，不会出现 mid-turn `unknown tool`，下一回合才收窄。

时序上**不承诺「首绑回合绝对安全」**：同一条 assistant 消息里并行发出、且在绑定写入前就开始执行的 `wait_agent` 可能漏过（执行顺序不保证）。首绑回合里 `task_create` 之后要么结束回合、要么只做只读查看，别并发等待类工具。阶段 2 用 agent preset 的 `composition.toolFilter` 把协调者工具集从根上固化，运行期 guard/白名单降为兜底。

## 一次完整流程

1. 用户说「空数据时报表啥也不显示，修一下」。
2. 协调者调用 `task_create`：

   ```
   task_create({
     title: '修复空数据文案',
     goal: '空窗口时报表给出明确说明而不是空表',
     constraints: ['只改 src/report.js'],
     acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
     user_verbatim: '你看这个空数据啥也没显示'
   })
   ```

3. 子会话收到的输入是渲染文字，不是 JSON：

   ```
   【任务编号】t-1a2b3c4d
   【任务】修复空数据文案
   【目标】空窗口时报表给出明确说明而不是空表
   【约束】- 只改 src/report.js
   【验收标准】
   - 空窗口输出「该窗口没有调用记录」
   - npm test 全绿
   【用户原话】
   > 你看这个空数据啥也没显示
   完成后请汇报：改了什么、改了哪些文件、怎么验证的。
   ```

4. 子任务每轮末尾 `task_report({ task_id:'t-1a2b3c4d', status:'progress', summary:'已定位渲染分支' })`，协调者收到静默台账更新。
5. 完成后 `task_report({ status:'done', summary:'改了空数据分支，npm test 全绿' })`，协调者会话收到：

   ```
   任务「修复空数据文案」完成：改了空数据分支，npm test 全绿
   ```

6. 会话内卡片数据用 `taskCard(task, { summary })` 产出：`taskId`、`title`、`status`、中文 `label`、`tone`、截断到 80 字的 `summary`、子会话 id（`childSessionId`）、是否排队（`queued`）、打开方式（`openVia:'subagent-catalog'`）。客户端按 `childSessionId` 走协调者会话的子代理目录打开，不要假设它是普通会话。

## 错误与降级

- 打不开/损坏的台账：损坏（`SQLITE_CORRUPT`/`NOTADB`）给 `台账损坏：<路径>（可尝试从 snapshots 目录恢复）：<原因>`；目录不可用（`ENOTDIR` 等）给 `台账不可用：<路径>：<原因>`；被占用给 `台账暂时不可用（被占用）`。都不泄漏 `SQLITE_` 和堆栈。
- 找不到协调者会话：工具仍注册；配置的协调者失效时 `task_create` 直接失败（任务标 `failed` + 可读原因，不挂进永远派不出去的队列）；协调者只是还没加载时任务保持排队，等 `agent/created` 后自动补跑。
- `task_report` 归属：回报方必须是任务绑定的子会话（`exec.agent.id === task.session_id`），否则返回「回报被拒绝」，不改状态、不写消息、不发通知。
- 子会话创建失败（非容量错误）：任务标 `failed`，`error` 写原因；容量满不是失败，任务排队等待。
- 子会话不可达（被删/不是直接子级）：任务标 `orphaned`，可再派同 title+goal 的新任务重建；启动对账也会做这一步。
- 续派投递失败：重试 3 次（1s/2s/4s），仍失败标 `waiting_user`，记失败消息行；不可达则标 `orphaned`。
- 通知投递失败/跳过：写 `notifications` 行（`failed` 带原因，`skipped` 只有状态），不产生未处理 rejection。

## 已知局限（持续更新）

- **台账快照与恢复**：已每天生成 `snapshots/tasks-YYYY-MM-DD.sqlite`（保留 7 天）；损坏时给快照目录提示，但**不自动恢复**，需要手工替换台账文件。
- **卡片跳转**：子会话不在普通会话列表，阶段 1 只给数据（`childSessionId` + `openVia`），客户端入口/面板在阶段 2 按父会话的 subagent catalog 打开。
- **30 分钟打扰升级**：`stallRounds` 只保存不生效，阶段 1 只有 `task_list` 的陈旧标记。
- **`run_code`/PTC**：平台禁止 `restrict` 指名 PTC 保留传输 `run_code`；若 profile 配了 PTC executor，协调者可能经它间接调用被 deny 的工具。真机确认 desktop 默认没有 PTC executor；有则记录并禁用该路。
- **deny 审计日志**：`preset-tools` 同时写平台 `ctx.logger.info`（`preset-tools: deny …`）和插件自己的 `$DSH_HOME/state/orchestrator/logs/orchestrator-*.jsonl`（事件 `preset.deny`，`detail.tools` 是被 deny 的名单），真机用后者对表即可。
- **`show_view`**：base asar 未证实有这个全局工具，协调者 allow 默认不带；memory 已由插件自己的 `memories` 表实现，不依赖平台 memory 服务。
- **`task_report` 子会话可见性**：靠全局注册，Task 10 真机确认；看不到就改用专用轻量工具模块，不把整个 `dsh-orchestrator` 塞进 worker 预设。
- **配置覆盖会话的运行期白名单**：`config.coordinatorSession` 指定的会话没有预设保证，仍用 `agent.ctx.tools.restrict({ deny })` 兜底；收窄挂在**回合边界**（会话在跑时等 `idle` 再装），所以当回合仍是全工具表、下一回合才收窄，避免 mid-turn `unknown tool`。`spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`/`team_task_*` 是 agent scope 注册，不在 `restrictableNames` 里，`restrict` 去不掉；`wait_agent` 由执行期 guard + 动态提示兜底。**guard 对主会话同样生效**：判定源是 `config.coordinatorSession ?? settings.main_session_id`，所以预设只收窄全局工具、`wait_agent` 仍留在工具表时，主会话调用它也会拿到可读拒绝、不会阻塞回合（用例：`settings.main_session_id 的主会话调用 wait_agent 也被 guard 拒绝`）。
- **同回合并行等待**：guard 管得住调用的顺序链；同一条 assistant 消息里并行、且在 guard 判定前已开始执行的 `wait_agent` 不承诺拦住。
- **唤醒时序**：通知走 `agent.steer` 直插协调者会话（等价于 TeamService 给 lead 投递时的 `root.steer`），空闲唤醒、忙时 `next-step` 排队；机制证据见 `docs/api-notes.md`。真机忙时排队由维护者冒烟验证。
- **平台 settlement 通知**：`subagent-settled` 是平台独立链路，不受本插件控制、不写 `notifications`。
- **headless 收尾竞态**：一次性进程在 5 秒合并窗口内退出时，`steer` 可能抛 `agent initiator scope is disposed`（进程级 initiator 作用域已 dispose），此时消息可能已进 inbox 但没有回合消费，`notifications` 记 `failed` + reason 是正确审计；长驻 desktop/服务进程不受影响。冒烟要在最后一条回报后保持进程活过 `mergeWindowMs` 才能看到 `delivered`。
- **`inject` 只要求 `tools`/`agents`/`systemPrompt`/`subagents`（阶段 4 起）**：`agentTeams` 不在 `inject` 里，按需惰性获取，所以缺 agent-team 的 profile（如默认 web 模板）也能正常激活、subagent 派发可用——真机在无 agent-team 的隔离 profile 验过。只有显式 `backend:'team'` 才需要它：缺服务或 rc.3 缺成员 API 时都返回可读错误「请把 backend 改回 subagent」，不影响其它功能。旧平台（team 仍可用）上若插件先于 agent-team 加载，显式选 `team` 可能落到占位派发器；rc.3 无实际影响。
- **主会话工具表残留团队工具（平台无干净解，双保险）**：主会话预设能收窄全局工具，但 `spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`wait_agent`/`team_task_*` 是 **agent-scope 自注册**的团队工具，`restrict` 遮不到（`view()` 里 own 无条件可见、`restrictableNames` 不含 own），`ToolsService` 也没有 unregister/remove API；`session.create` 入参只有 `{workspaceId?, cwd?, sessionId?, agentPreset?}`，没有 composition/toolFilter 通道；agent-team 工具组 Config 只有 `interrupt` 一个开关且是 profile 全局（会误伤子会话）。`session.create` 的 schema 也堵死了旁路。因此这一版：preset 层收窄全局工具 + 提示词明确禁止 + **执行层 guard 对主会话硬拦整个 `COORDINATOR_DENY` 名单**（`wait_agent` 返回禁止阻塞提示，其余返回可读拒绝；只对 `settings.main_session_id`/`coordinatorSession` 指向的主会话生效，子会话同名工具放行）。工具表里仍能看到这些残留，属于已知局限；guard 是唯一硬拦截点。
- **`backend:'team'` 在 rc.3 不可用**：rc.3 的 `agentTeams` 只剩 `state`/`transact` 与团队任务板，`spawnTeammate`/`sendMessage`/`interrupt`/`listMembers` 整体移除。插件在构造 team 派发器时按服务方法探测，缺方法则**插件照常加载**、启动时告警一条，派发/续派/停止返回可读错误「team 后端不可用…请把 backend 改回 subagent」（不再是 `is not a function`）；`catalog()` 也抛同一条错误，让启动对账走「目录不可用 → 跳过 catalog 维度」而不是把 running 任务误标 orphaned。文档与接口保持两版兼容，旧安装（rc.1）仍可选 team。
- **rc.3 子会话沙箱根取父会话目录（平台缺陷，插件兜一半）**：rc.3 的 `childSessionMeta` 把子会话 `header.cwd` 写成 `parentHeader.cwd`，派发时给的 `cwd` 只记一条 `working-directory` 事件；而 `sandboxPolicy` 的 `workspaceRoot` 只读 `session.header.cwd`。所以 `workspace-write` 下子会话**写不进 target**（`%TEMP%` 属平台豁免例外，之前的真机证据都在 `%TEMP%` 下，不算数）。插件兜法：派发成功后，用 `sandboxPolicy.registerWritableRoot(agents.get(childId).session, targetDir)` 给子会话登记 target 可写根（必须传 agent 的 Session **对象**，平台按对象身份查 WeakMap；同一 `(session 对象, 目录)` 幂等；**settle 不释放**，`task_stop` 与任务进终态时释放）。续派时子会话在发送前通常已 settle/冷恢复、解析不到，**投递成功后**再幂等补注册（恢复后会拿到新的 Session 对象，只有按新对象注册才生效）；注册只追加不替换，终态按会话 id 把新旧对象的 disposer 全部释放。边界：Windows 上只对 harness 文件工具（`read`/`write`/`edit`）生效，**`pwsh`/`bash` 子进程写 target 仍会被拒**；`target` 不要用符号链接（注册只校验绝对路径，执行侧才拒符号链接）。冷恢复/续派首回合与派发首回合一样，有极小窗口可能先写后注册、被拒一次，下一回合 policy 行会带 `Additional writable directories`，可重试。彻底修复需平台把 `meta.cwd` 改成 `create.cwd`，插件不 patch asar。审计字段：`subagent.writable-root`（`sessionId` + `detail.directory`）与 `task.message.sent`（`taskId`、`sessionId`、`detail.targetDir`），按日志时间序即「投递 → 注册」，可与子会话 transcript 首个 `tool/call` 对表。
- **worker 不强制 chdir（模型侧已知局限）**：即使平台根修好，worker 回合内也不强制 `chdir`；在 `danger-full-access` 这类权限预设下，模型给一个目标目录之外的绝对路径照样能写成功。brief 只在带 `target` 时加了正向提示（「所有产出只写到该目录内，不要写到父会话目录或其他绝对路径」），这不是硬约束。要硬约束只能把该 profile 的 `permissionPreset` 调回 `workspace-write`，让沙箱拒掉越界写——属于环境选择，插件不擅自改。
- **侧栏启动器（阶段 4）**：点侧栏「插件」下方「主会话」→ 启动器面板一帧「正在打开主会话…」→ 跳到对话（`selectPanel(null)` 清掉面板高亮）。Bot 模式下 ds-bot 藏掉面板列表，启动器不可见，改用会话头按钮开任务面板；侧栏条目被用户「取消固定」后会自动出现在「更多」菜单里，同样走 open-main，无需额外入口。
- **升级 DSH 后必须重跑契约探针**：平台大版本变过入参形状（rc.1→rc.3 把 `startActivation` 从 `spec.request.*` 改成扁平 `spec.*`，`interruptByParent`→`interrupt(target, authority)`，`listChildren`→`listDescendants`），升级后不重跑 `docs/probes/*` 会让阶段 1/2/3 的能力在真机上静默失效。当前代码已按服务方法探测兼容两版，但**每次升级 desktop 后必须重跑全部契约探针**。
- **ds-bot Bot 模式下「打开主会话」视图不切（外部依赖）**：主会话在服务端创建/复用正确，`snapshot.mainSession` 与 `open-main` 返回都对，但 ds-bot 的 Bot 表面只认**它自己的 DSH Agent 会话**——`client.js:41886` 的 `plain = isAgentSessionId(main)` 对我们的外部 root 会话恒为 `false`，皮肤和输入框仍留在 Bot 会话；`41894-41897` 的 adopt 前置 `agentOfSession(before)` 在 Bot 会话下是 `undefined`，所以连 `agent-adopt` 都不会触发（无 console 错误、无面板报错）。主视图实际上已经切到主会话。插件侧只能给提示：「主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」」。要根治需 ds-bot 放宽撤皮肤判据或提供「打开纯 dsh 会话」的 action；纯 dsh 表面不受影响。严格对照在 Bot 表面不可达（只列 Bot 会话，造不出非 bot root 会话）；反向证据是同一主会话在纯 dsh 表面一次切换成功、加 `plain` 判据覆盖所有非 bot root 会话，详见 `docs/qa-checklist.md` §29。
- **重启窗口**：子会话已完成但 `task_report` 还没被协调者消费时恰好重启，对账会按「running 不 live」标 `orphaned`；这个窗口里报告本来也会丢，重建即可。
- 会话内卡片仍只提供数据（`taskCard`），不渲染 UI；可见的入口/面板在阶段 2 的侧栏与面板里，卡片渲染 UI 留阶段 3。

## 开发

```bash
npm test
node docs/probes/api-probe.mjs   # 核对已安装平台里 agentTeams 的契约
```
