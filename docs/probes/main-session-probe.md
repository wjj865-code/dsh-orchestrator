# 主会话平台契约探测（Task 0）

- 日期：2026-11-14
- 作者：开发（团队研发 Bot）
- 对象：本机已安装 DeepSeek Harness（asar，203.3 MB / 22102 files）
- 方法：`docs/probes/main-session-probe.mjs` 解析 asar 文件表、按包路径取源码取证（不启动 app），本机 `结果：40/40 PASS`；`docs/probes/preset-scope-restrict.mjs` 解出 `cordis`/`dsh-tools`/`dsh-scope` 跑真实 `ToolsService`，`结果：7/7 PASS`
- 用途：给「协调者主会话（预设开启）」的 Task 1–10 提供平台契约依据；静态探针不能证明的项列在 §8，留 Task 10 真机/单测
- rc.3 复跑：同一脚本在 0.2.2-rc.3 上 `40/40 PASS`。三处形状变化（`composition.agentPreset`、沙箱 `workspaceRoot`、`resolveDirectory` 入参）改成「两版形状分别断言」：每条断言保留 rc.3 与 rc.1 的精确原文、命中哪版打印在结论行，两版都不在才红（`docs/probes/lib/phrase-match.mjs`，单测 `test/probe-phrase.test.js`）。

## 结论摘要

1. **预设没有 `toolFilter` 字段**（计划里的假设不成立）。预设行只认 `config: { id, name?, description?, order?, plugins }`，工具由 `plugins` 里的行拥有；`toolFilter` 只存在于 **subagent descriptor**，由子代理对 child ctx 调 `childCtx.tools.restrict(...)`。所以在预设层定型 = 在 `plugins` 里放我们自己的 `dsh-orchestrator/preset-tools`（agent-scoped `tools.restrict({allow})`）。
2. **⚠ 预设 scope 是共享的，restrict 会继承给子会话**：preset 用 `createScope(owner, key)` 挂载，agent 通过 `bindScopeParent(key, generation.key)` 绑上去；子会话未指定 preset 时走 `composeFrom(childCtx, parent.ctx)` 加入**同一个 generation**，`tools.view` 沿 scope 链取交集。所以协调者 preset 里的 restrict 会作用到任务子会话，子会话会丢 `read/write/bash/task_report`。
3. **双预设可行，但 worker 不能是 `plugins: []`**：`startActivation.request.agentPreset` 存在（`composition: { agentPreset: request.agentPreset }` → `presets.mount`），可强制子会话用别的 preset、绕开继承。但预设是**独立组合**（`mountPreset` 只挂声明的行），空 `plugins` 的 worker 预设**不会**继承 profile 全量工具——`tool-fs`/`tool-bash` 都是标准预设里的行，空预设里子会话没有文件/shell 工具。worker 预设必须带自己的工具行（§6 给了最小清单）。
4. `sessionController.create` 入参是 `{ workspaceId | cwd, sessionId?, agentPreset? }`，**没有 `title`**；标题用 `sessionController.rename({ sessionId, title })`（依赖 `sessionTitle` 服务）。返回 `{ sessionId, agentPreset? }`；`workspaceId` 创建后自动 `attachSession`。
5. 工作区：`workspaceRegistry.create(path, title?)` / `resolveByPath(path)` / `get(id)` / `list()`；实体有 `setTitle` / `attachSession`。指挥舱 = mkdir 目录 → `resolveByPath` → 没有就 `create(path, '指挥舱')`。
6. 子会话 `cwd`：**session cwd 就是 workspace-write 边界**（`sandboxPolicy.resolve` 用 `header.cwd` 作 `workspaceRoot`），`startActivation.request.cwd` 直接采用；目录必须存在（`workingDirectory.set` 先 `fs.stat` 查 directory）。不要求 cwd 在已注册工作区内；target 不存在会 spawn 失败。沙箱模式从父会话的显式 override 继承（approval 固定 `never`）。
7. `session/created` 载荷是整个 **Session**（`id`/`header`/`seq`/`firstLiveSeq`），不是 `{sessionId}`；事件完成前不能 append。主会话 id 直接用 `create` 返回值，不要依赖事件。
8. **⚠ 预设 scope 里 `restrict({allow})` 有陷阱**（实验见 §1.5、`docs/probes/preset-scope-restrict.mjs` 7/7 PASS）：它会把**同一 scope 注册的工具**（协调者预设里的 `ask_user_question`）一起遮给 agent；而 allow 里写这个名字又直接抛 `unknown global tool`。所以协调者的「只留 allow」在预设层要用 **deny 补集**（`preset-tools.js`：deny 掉不在 allow 里的已注册全局工具），预设自有工具不受影响。
9. 工具名是 `ask_user_question`（`tool-ask-user` 源码），不是 `ask_user`；`show_view` 与 memory 在 base asar 未证实，**协调者默认不带**，Task 10 再按需补。

## 1. 预设工具集：`toolFilter` 字段与嵌套

**结论：预设没有 toolFilter；工具 = `plugins` 行的组合；`preset-tools` 的 restrict 必须防继承。**

- 预设 Config（`@deepseek-ai/dsh-agent-preset/lib/index.js`）：`record.config.id` / `name` / `description` / `order` / `plugins`；`mountPreset(context, record.config.id, record.config.plugins)` 只挂这些行。源码里没有 `toolFilter`。
- `toolFilter` 只在 `ContinuableSubagentDescriptorData`（`readonly toolFilter?: ToolRestriction`），由 `applyChildOverrides` 里 `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter)` 消费——只作用于子代理 context，不作用于普通预设。
- **继承链（审查发现、探针复核）**：`@deepseek-ai/dsh-agent-preset-registry` 的 `activate` 用 `createScope(this.owner, key)` + `mountPreset(context, …)`；`bind`/`join` 用 `bindScopeParent(key, generation.key)`；`@deepseek-ai/dsh-subagent` 的 `applyChildComposition` 在无显式 preset 时 `agentPresets.composeFrom(childCtx, parent.ctx)` → 子会话加入同一 generation。`@deepseek-ai/dsh-tools` 的 `view(scope)` 沿 scope 链取交集。**所以协调者 preset 里的 `restrict({allow:[task_*]})` 会漏给子会话。**
- **双预设通道可用**：`SubagentStartRequest.agentPreset?: string`；`startLocal` 组 `composition: { agentPreset: request.agentPreset }`；`applyChildComposition` 在 `composition.agentPreset !== void 0` 时 `presets.mount(childCtx, composition.agentPreset)`（不 `composeFrom`）。派发时显式带 worker preset 即可绕开继承。
- **worker 预设不能空**：`entryListProblem` 只拒绝非数组，`plugins: []` 合法；但 `mountPreset` 只挂声明行，标准预设的 `tool-fs`/`tool-bash`/`tool-pwsh` 都是行，空 worker 的 child 没有文件/shell 工具（`task_report` 来自全局插件，仍在）。worker 必须自带工具行，见 §6。

### 1.5 预设 scope 内 `restrict` 的实验语义（决定协调者怎么收窄）

`docs/probes/preset-scope-restrict.mjs` 从 asar 解出 `cordis`/`dsh-tools`/`dsh-scope`，用真实 `ToolsService` 跑（7/7 PASS），复现结论：

| 场景 | 结果 |
| --- | --- |
| preset scope 里 `restrict({ allow: ['task_create'] })` | preset 自己的视图里 `ask_user_question` 仍可见（own registrations 豁免），但 **agent 视图只剩 `task_create`**——沿 scope 链取交集，预设自有工具也被遮 |
| `restrict({ allow: ['task_create', 'ask_user_question'] })` | 抛 `tools.restrict() names unknown global tool "ask_user_question"`（own 工具不在 `restrictableNames`） |
| `restrict({ deny: ['read'] })`（deny 补集） | agent 视图 = `ask_user_question` + `task_create`，`read` 被遮 |
| 之后全局注册 `show_view` | `tools/change` 监听补 deny，agent 视图随即不含 `show_view` |

- 结论：预设层的「allow 名单」只能用 **deny 补集**实现，见根目录 `preset-tools.js`：`allow` 是显式保留名单；mount 时一次性 deny 掉所有已注册、不在 allow 里的全局工具，之后每次 `tools/change` 只 deny 新出现的同类工具（按「不在 allow 的全局工具」判定，不写死工具名）。每批实际被 deny 的工具都写 `preset-tools: deny …` 进日志，便于审计。`run_code`（PTC 保留传输）平台禁止 deny，跳过并在文档标注。
- 时序：预设是 eager 挂载，`task_*` 可能还没注册；deny 补集天然处理顺序——只 deny 已出现的全局工具，allow 名单里的工具后注册也不会被 deny，不硬抛、不把协调者削成空表。
- 覆盖用例（`test/preset-tools.test.js`，8/8 PASS）：`mount 后动态注册的全局工具被 deny，协调者工具表不增加`、`mount 时一次性 deny 已存在的全部非 allow 全局工具，并写审计日志`、`后注册的全局工具在 tools/change 后补 deny，且不重复`。
- `ask_user_question` 由预设行 `tool-ask-user` 自己注册，**不放进 `restrict({ allow })`**（放进去会 `unknown global tool` 抛错）。注意 preset-tools 的 `allow` 是另一回事：它只用于过滤 deny、不交给 `restrict`，列 own 名字是幂等的（当前为 `present` 作跨 profile 保底）。

**退化方案（若 worker 栈复制不可接受）**：不把 restrict 放进 preset scope，只在**主会话自己的 agent scope** 装 `agent.ctx.tools.restrict`（创建后 / `agent/created`）。子会话 scope 链是「child agent → preset scope」，不含父 agent 自己的 layer，所以不会漏给子会话；代价是退回「运行期收窄」，不是预设层。

## 2. `sessionController.create` / `rename`

- 入参（`@deepseek-ai/dsh-api-session-controller/lib/index.js`）：
  - `workspaceId` 与 `cwd` **互斥**：`session.create accepts workspaceId or cwd, not both`；
  - 可选 `sessionId`（复用空白会话）、可选 `agentPreset`；
  - **没有 `title`**。
- `workspaceId` 走 `workspaceRegistry.get(id)`，`cwd = workspace.path`；`agents.createSession(...)` 后 `workspace.attachSession(sessionId)`；返回 `{ sessionId, agentPreset? }`。
- 标题：`async rename(request)` 存在，内部 `ctx.get("sessionTitle")`，缺失时报 `this deployment mounts no session-title service`；desktop 带 `dsh-session-title` 包（asar 里 5 个 session-title 实现）→ Task 10 真机确认该服务已挂。
- 主会话 id 用 `create` 返回值；`session/created` 只用于观察/日志。

## 3. `workspaceRegistry` 注册/查找

`@deepseek-ai/dsh-workspace/lib/index.js`：

| API | 用途 |
| --- | --- |
| `create(path, title?)` | 新建工作区；`path` 必须是已存在的规范目录（先 mkdir） |
| `resolveByPath(path)` | 按规范路径查，不创建；目录不存在时 realpath 抛错 |
| `get(id)` / `list()` | 按 id / 全量 |
| `Workspace.setTitle(title)` | 改显示名 |
| `Workspace.attachSession(sessionId)` | 会话挂到工作区（`create({workspaceId})` 自动做） |

指挥舱：`mkdir -p ~/.dsh/state/orchestrator/workspace` → `resolveByPath(path)` → 没有就 `create(path, '指挥舱')`；工作区 id 存 `settings.main_session_id` 之外的位置（设计 §4）。

## 4. 子会话 `cwd` 与沙箱

- `sandboxPolicy.resolve(request)` 的文档原文：*A session cwd is its workspace-write boundary; the configured root is the fallback for agentless calls and sessions without a cwd.* 实现：`workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`。
- 子会话创建：`startLocal` 用 `const cwd = await this.resolveDirectory(request, spec.signal)`，`workingDirectory.set(child, create.cwd, signal)`；`set` 先 `fs.stat(target)`，只接受 `type === "directory"`。目录不存在 → spawn 失败（可读错误）。
- 不要求 `cwd` 落在已注册工作区内；`target` 不在主会话工作区也能跑，写权限按 workspace-write 边界（cwd）判定。
- 沙箱模式：`captureDelegatedPolicyOverrides(parent)` 把父会话显式 override 的 `sandboxMode` 带给子会话，approval 固定 `never`。

## 5. `session/created` 载荷与时机

- 会话包定义事件；listener 签名 `ctx.on("session/created", (session) => …)`，载荷是 **Session**（`session.id`、`session.header`（含 `cwd`/`origin`/`parentSession`）、`session.seq`、`session.firstLiveSeq`）。
- `Session.append` 在 `session/created` 完成前会抛 `cannot append before session/created completes`；创建生命周期是 session/created → setup/commit → agent/created。主会话 id 以 `create` 返回为准。

## 6. 预设最小可运行 `plugins` 清单（探针确认）

### 6.1 协调者预设 `dsh-orchestrator-coordinator`

```yaml
plugins:
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      prefix: 你是 dsh-orchestrator 的协调者，只做协调：拆任务、派子会话、看回报。
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
    config:
      maxBytes: 65536
  - id: time-context
    name: '@deepseek-ai/dsh-time-context'
  - id: tool-ask-user
    name: '@deepseek-ai/dsh-tool-ask-user'
  - id: compaction
    name: cordis:group
    group: true
    isolate:
      compaction: true
      toolResultPruner: true
    config:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
      - id: command-compact
        name: '@deepseek-ai/dsh-command-compact'
      - id: tool-result-pruner
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
        config:
          thresholdChars: 8192
          headChars: 4096
          tailChars: 1024
  - id: preset-tools
    name: dsh-orchestrator/preset-tools        # 本包 exports['./preset-tools']
    config:
      allow:                                    # 只保留这 5 个全局工具，其余已注册全局工具 deny
        - task_create
        - task_list
        - task_status
        - task_message
        - task_stop
```

- `persona.prefix` 是**必填**（`dsh-persona` 的 Config：`prefix: required`），漏了 preset 直接 broken。
- **协调者也要 `compaction` 组**（长期对话，不挂会撑爆上下文）：与 worker 同一组，带 `isolate: { compaction: true, toolResultPruner: true }` 和三条子行/config。
- `task_*` 工具来自本插件（host bundle 全局注册），不在 preset 行里；`preset-tools` 用 **deny 补集**（§1.5）：allow 名单之外的全局工具逐个 deny，mount 时 + 每次 `tools/change` 增量补，不硬抛、不因 `task_*` 后注册把协调者削空。
- `ask_user_question` 由 `tool-ask-user` 行自己注册（名字是 `ask_user_question`，不是 `ask_user`），**不写进 `restrict({ allow })`**——写进去会抛 `unknown global tool`；预设自有工具本身不受 deny 影响。preset-tools 的 allow 只过滤 deny、不交给 restrict，所以可以列 own 名字（`present` 就列了一份，防 SDK 等 profile 把它注册成全局工具时被 deny）。
- **`task_report` 不进 allow**（子会话专用，全局注册，会被 deny）；`show_view` 与 memory 在 base asar 未证实，**默认不带**，Task 10 在 ds-bot 环境确认后再决定是否补 allow。
- `run_code` 是 PTC 保留传输，平台禁止 deny，`preset-tools` 跳过；若 profile 用 PTC executor，协调者内部的工具调用仍按 `tools.view` 过滤（Task 10 记录）。

### 6.2 worker 预设 `dsh-orchestrator-worker`（子会话用，必须自带工具栈）

标准 `cordis` 预设共 33 行（`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`）。worker 是它的缩小版，**行与 config 都照抄标准**（唯一改动：去掉 delegation/goal/plan/schedule/cordis/plugin-manager/market，补 `tool-jobs`）：

```yaml
plugins:
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      prefix: 你是 dsh-orchestrator 的任务执行者，在目标目录里把活干完，并用 task_report 回报。
  - id: agent-instructions
    name: '@deepseek-ai/dsh-agent-instructions'
    config:
      maxBytes: 65536
  - id: time-context
    name: '@deepseek-ai/dsh-time-context'
  - id: tool-bash
    name: '@deepseek-ai/dsh-tool-bash'
    disabled: !!js process.platform === 'win32'
  - id: tool-pwsh
    name: '@deepseek-ai/dsh-tool-pwsh'
    disabled: !!js process.platform !== 'win32'
  - id: tool-fs
    name: '@deepseek-ai/dsh-tool-fs'
    config:
      applyPatch: false
  - id: tool-fs-search
    name: '@deepseek-ai/dsh-tool-fs-search'
    config:
      sampleOverCapGlobResults: false
  - id: tool-jobs
    name: '@deepseek-ai/dsh-tool-jobs'
  - id: tool-ask-user
    name: '@deepseek-ai/dsh-tool-ask-user'
  - id: tool-todo
    name: '@deepseek-ai/dsh-tool-todo'
    config:
      allowParallelInProgress: true
  - id: tool-web
    name: '@deepseek-ai/dsh-tool-web'
    config:
      fetch: true
      searchTimeoutMs: 60000
  - id: compaction
    name: cordis:group
    group: true
    isolate:
      compaction: true
      toolResultPruner: true
    config:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
      - id: command-compact
        name: '@deepseek-ai/dsh-command-compact'
      - id: tool-result-pruner
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
        config:
          thresholdChars: 8192
          headChars: 4096
          tailChars: 1024
  - id: skill-filesystem
    name: '@deepseek-ai/dsh-skill-filesystem'
  - id: tool-skill
    name: '@deepseek-ai/dsh-tool-skill'
  - id: present
    name: '@deepseek-ai/dsh-tool-present'
```

- 不含 `delegation`/`tool-subagent*`（`maxDepth` 默认 1，子任务不再派子任务）、不含 goal/plan/schedule/plugin-manager/market/cordis；`tool-jobs` 保留（后台任务需要）。
- worker **不放 `preset-tools`**：它是子会话的完整工作栈，协调者的 deny 不继承（显式 preset 绕开 `composeFrom`）。
- `task_report` 来自全局插件，不在这里；若 Task 10 发现子会话看不到它（preset 隔离），**不把整个 `dsh-orchestrator` 行塞进 worker**，另做轻量工具模块。
- **这是「复刻标准栈」的缩小版**：仍要维护一份行清单。若 Chief 认为成本高，用 §1 的退化方案（运行期收窄）更省。

## 7. 退化方案对照

| 方案 | 做法 | 代价/风险 |
| --- | --- | --- |
| A 双预设（Chief 已拍） | 协调者 preset + `preset-tools`（deny 补集，§1.5）；worker preset 带 §6.2 工具栈；dispatch 给子会话显式 `request.agentPreset` | 需要维护 worker 行清单；worker preset 要求 `spawn` provider（fork 不支持 `agentPreset`） |
| B 运行期收窄 | 不碰 preset scope，主会话 `agent/created` 后 `agent.ctx.tools.restrict({allow})` | 不是预设层；但子会话 scope 链不含父 agent layer，**不会漏给子会话** |
| C 空 worker `plugins: []` | ~~继承 profile 全量工具~~ | **不成立**：空预设 = 空组合，子会话没有 read/write/bash |

## 8. 待真机/单测验证（静态探针证不了）

1. **子会话工具表**：协调者 preset 建主会话 → 派一个子会话 → 断言子会话有 `read/write/bash/task_report`、无 `wait_agent`/`spawn_teammate`；主会话有 `task_*` + `ask_user_question`、无 `read/write/bash/wait_agent`。
2. **worker preset 生效**：子会话 header/日志记录 `agentPreset === 'dsh-orchestrator-worker'`，且不叠加协调者的 deny。
3. **loader 子路径**：`dsh-orchestrator/preset-tools` 能解析（`package.json` `exports['./preset-tools']` + `files` 含 `preset-tools.js`）。
4. **deny 时序**：主会话 mount 时 `task_*` 可能未注册；确认 `preset-tools` 不抛错、`tools/change` 后协调者工具表 = allow + `ask_user_question`，`read/write/bash` 与 ds-bot 全局工具被 deny。
5. **`task_report` 子会话可见**：Task 10 在真机子会话里确认；看不到就做专用轻量工具模块，不塞整个 `dsh-orchestrator`。
6. **`show_view` / memory 决策**：Task 10 在 ds-bot 环境确认工具名后再决定是否补进协调者 allow；默认不带。
7. **spawnProvider**：配置 `spawnProvider !== 'spawn'`（如 fork）时，打开主会话给可读错误、不创建；`main-session.js` 装配时校验，不改用户配置。
8. **rename 服务**：desktop 真机 `sessionController.rename({sessionId, title:'主会话'})` 成功（`sessionTitle` 已挂）。
9. **target 目录**：`cwd=target` 时 `sandboxPolicy.resolve` 的 `workspaceRoot === target`，writes 成功、越界 writes 被拒。
10. **预设 broken 排查**：`agentPreset` 创建失败时错误信息能看到 `agent preset …: …`（`diagnostic`），Task 10 记录一次。
11. **PTC / `run_code`**：确认 desktop 默认没有 PTC executor；若有，协调者可能经 `run_code` 绕过 allow，记录并禁用该路。
12. **deny 审计日志**：`preset-tools: deny …` 走平台 `ctx.logger.info`，Task 10 在 desktop 日志里确认可查；查不到再考虑桥接进插件 JSONL。

## 9. 证据位置

- 探测脚本：`docs/probes/main-session-probe.mjs`（解析 asar 文件表；`结果：40/40 PASS`）
- 预设收窄实验：`docs/probes/preset-scope-restrict.mjs`（解出 `cordis`/`dsh-tools`/`dsh-scope` 跑真实 `ToolsService`；`结果：7/7 PASS`）；实现 `preset-tools.js`、单测 `test/preset-tools.test.js`
- 预设：`dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js`（Config/plugins）；`.../dsh-agent-preset-registry/lib/index.js`（`mountPreset` @20724、`createScope` @20430、`bindScopeParent`、`entryListProblem` @865）
- 工具限制：`.../dsh-tools/lib/index.js`（`restrict` @17800：`restrictableNames` 校验、own 豁免；`view` @19006 的 scope 链交集；README「masks intersect, scoped registrations stay visible」）
- 工具名：`.../dsh-tool-ask-user/lib/index.js`（`name: "ask_user_question"`）；`.../dsh-tool-present/package.json`（`@deepseek-ai/dsh-tool-present`）
- 预设行必填：`.../dsh-persona/lib/index.js`（`prefix: z.string().required()`）；标准预设 `dsh-web-app/presets/cordis.patch.yml`（compaction `isolate` + 各 config）
- 子代理：`.../dsh-subagent/lib/index.js`（`composition.toolFilter` @18239、`composeFrom` @17706、`presets.mount` @17557、`request.agentPreset` @62638、`resolveDirectory` @61346、`captureDelegatedPolicyOverrides` @19233）
- 会话 API：`.../dsh-api-session-controller/lib/index.js`（`create` @28402、`rename` @31327、`session/created` listener @53600）
- 工作区：`.../dsh-workspace/lib/index.js`（`create` @16333、`get` @18517、`list` @18844、`resolveByPath` @26959、`attachSession` @4286、`setTitle` @4193）
- 沙箱/工作目录：`.../dsh-sandbox-policy/lib/index.js` @7933、@8386；`.../dsh-working-directory/lib/index.js` @3842
- 工具限制：`.../dsh-tools/lib/index.js` @8375
- 标准预设：`.../dsh-web-app/presets/cordis.patch.yml`（33 行，persona @559、tool-bash @966、tool-fs @1222、tool-ask-user @6204）
- 会话事件：`.../dsh-session/lib/index.js` @74503 / @74482
