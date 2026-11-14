# 主会话平台契约探测（Task 0）

- 日期：2026-11-14
- 作者：开发（团队研发 Bot）
- 对象：本机已安装 DeepSeek Harness（asar，203.3 MB / 22102 files）
- 方法：`docs/probes/main-session-probe.mjs` 解析 asar 文件表、按包路径取源码取证（不启动 app）；本机运行 `结果：40/40 PASS`，exit 0
- 用途：给「协调者主会话（预设开启）」的 Task 1–10 提供平台契约依据；静态探针不能证明的项列在 §8，留 Task 10 真机/单测

## 结论摘要

1. **预设没有 `toolFilter` 字段**（计划里的假设不成立）。预设行只认 `config: { id, name?, description?, order?, plugins }`，工具由 `plugins` 里的行拥有；`toolFilter` 只存在于 **subagent descriptor**，由子代理对 child ctx 调 `childCtx.tools.restrict(...)`。所以在预设层定型 = 在 `plugins` 里放我们自己的 `dsh-orchestrator/preset-tools`（agent-scoped `tools.restrict({allow})`）。
2. **⚠ 预设 scope 是共享的，restrict 会继承给子会话**：preset 用 `createScope(owner, key)` 挂载，agent 通过 `bindScopeParent(key, generation.key)` 绑上去；子会话未指定 preset 时走 `composeFrom(childCtx, parent.ctx)` 加入**同一个 generation**，`tools.view` 沿 scope 链取交集。所以协调者 preset 里的 restrict 会作用到任务子会话，子会话会丢 `read/write/bash/task_report`。
3. **双预设可行，但 worker 不能是 `plugins: []`**：`startActivation.request.agentPreset` 存在（`composition: { agentPreset: request.agentPreset }` → `presets.mount`），可强制子会话用别的 preset、绕开继承。但预设是**独立组合**（`mountPreset` 只挂声明的行），空 `plugins` 的 worker 预设**不会**继承 profile 全量工具——`tool-fs`/`tool-bash` 都是标准预设里的行，空预设里子会话没有文件/shell 工具。worker 预设必须带自己的工具行（§6 给了最小清单）。
4. `sessionController.create` 入参是 `{ workspaceId | cwd, sessionId?, agentPreset? }`，**没有 `title`**；标题用 `sessionController.rename({ sessionId, title })`（依赖 `sessionTitle` 服务）。返回 `{ sessionId, agentPreset? }`；`workspaceId` 创建后自动 `attachSession`。
5. 工作区：`workspaceRegistry.create(path, title?)` / `resolveByPath(path)` / `get(id)` / `list()`；实体有 `setTitle` / `attachSession`。指挥舱 = mkdir 目录 → `resolveByPath` → 没有就 `create(path, '指挥舱')`。
6. 子会话 `cwd`：**session cwd 就是 workspace-write 边界**（`sandboxPolicy.resolve` 用 `header.cwd` 作 `workspaceRoot`），`startActivation.request.cwd` 直接采用；目录必须存在（`workingDirectory.set` 先 `fs.stat` 查 directory）。不要求 cwd 在已注册工作区内；target 不存在会 spawn 失败。沙箱模式从父会话的显式 override 继承（approval 固定 `never`）。
7. `session/created` 载荷是整个 **Session**（`id`/`header`/`seq`/`firstLiveSeq`），不是 `{sessionId}`；事件完成前不能 append。主会话 id 直接用 `create` 返回值，不要依赖事件。

## 1. 预设工具集：`toolFilter` 字段与嵌套

**结论：预设没有 toolFilter；工具 = `plugins` 行的组合；`preset-tools` 的 restrict 必须防继承。**

- 预设 Config（`@deepseek-ai/dsh-agent-preset/lib/index.js`）：`record.config.id` / `name` / `description` / `order` / `plugins`；`mountPreset(context, record.config.id, record.config.plugins)` 只挂这些行。源码里没有 `toolFilter`。
- `toolFilter` 只在 `ContinuableSubagentDescriptorData`（`readonly toolFilter?: ToolRestriction`），由 `applyChildOverrides` 里 `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter)` 消费——只作用于子代理 context，不作用于普通预设。
- **继承链（审查发现、探针复核）**：`@deepseek-ai/dsh-agent-preset-registry` 的 `activate` 用 `createScope(this.owner, key)` + `mountPreset(context, …)`；`bind`/`join` 用 `bindScopeParent(key, generation.key)`；`@deepseek-ai/dsh-subagent` 的 `applyChildComposition` 在无显式 preset 时 `agentPresets.composeFrom(childCtx, parent.ctx)` → 子会话加入同一 generation。`@deepseek-ai/dsh-tools` 的 `view(scope)` 沿 scope 链取交集。**所以协调者 preset 里的 `restrict({allow:[task_*]})` 会漏给子会话。**
- **双预设通道可用**：`SubagentStartRequest.agentPreset?: string`；`startLocal` 组 `composition: { agentPreset: request.agentPreset }`；`applyChildComposition` 在 `composition.agentPreset !== void 0` 时 `presets.mount(childCtx, composition.agentPreset)`（不 `composeFrom`）。派发时显式带 worker preset 即可绕开继承。
- **worker 预设不能空**：`entryListProblem` 只拒绝非数组，`plugins: []` 合法；但 `mountPreset` 只挂声明行，标准预设的 `tool-fs`/`tool-bash`/`tool-pwsh` 都是行，空 worker 的 child 没有文件/shell 工具（`task_report` 来自全局插件，仍在）。worker 必须自带工具行，见 §6。

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
  - id: time-context
    name: '@deepseek-ai/dsh-time-context'
  - id: tool-ask-user
    name: '@deepseek-ai/dsh-tool-ask-user'
  - id: preset-tools
    name: dsh-orchestrator/preset-tools        # 本包 exports['./preset-tools']
```

- `task_*` 工具来自本插件（host bundle 全局注册），不在 preset 行里；`preset-tools` 的 allow 取 `task_create/task_list/task_status/task_message/task_stop/ask_user/show_view`，用 `tools.view()` 的 `knownNames` 过滤未知名字，避免 `restrict` 因 unknown name 抛错。
- **`task_report` 不进 allow**（子会话专用）；`show_view` 在 base asar 里没有工具包（ds-bot/deep-view 提供时才存在），被过滤掉是预期降级。
- 顺序风险：`preset-tools` 若在工具注册前 mount，`knownNames` 可能还缺 `task_*` → 不要硬抛，延到 `tools/change`/`agent/created` 再 `restrict`（实现里处理，见 §8-4）。

### 6.2 worker 预设 `dsh-orchestrator-worker`（子会话用，必须自带工具栈）

标准 `cordis` 预设共 33 行（`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`：persona、agent-instructions、time-context、tool-bash、tool-pwsh、tool-fs、tool-fs-search、tool-jobs、tool-schedule、command-goal、tool-goal、planning/plan-mode、compaction×3、delegation×5、tool-ask-user、tool-todo、tool-web、tool-cordis、skill-filesystem、tool-skill、present、tool-plugin-manager、tool-plugin-market）。worker 只需干活，候选最小集：

```yaml
plugins:
  - id: persona            # name: '@deepseek-ai/dsh-persona'
  - id: agent-instructions
  - id: time-context
  - id: tool-bash          # win32 上 disabled，与标准预设一致
  - id: tool-pwsh          # 非 win32 disabled
  - id: tool-fs            # read/write/edit；applyPatch: false
  - id: tool-fs-search     # glob/grep
  - id: tool-web
  - id: tool-todo
  - id: tool-ask-user
  - id: compaction         # cordis:group（compaction-basic/command-compact/tool-result-pruner）
  - id: skill-filesystem
  - id: tool-skill
  - id: present
```

- 不含 `delegation`/`tool-subagent*`（`maxDepth` 默认 1，子任务不再派子任务）、不含 goal/plan/schedule/plugin-manager/market/cordis。
- `task_report` 来自全局插件，不在这里；若 Task 10 发现子会话看不到它（preset 隔离），再把本插件行加进 worker（同步 allow 讨论）。
- **这是「复刻标准栈」的缩小版**：仍要维护一份行清单。若 Chief 认为成本高，用 §1 的退化方案（运行期收窄）更省。

## 7. 退化方案对照

| 方案 | 做法 | 代价/风险 |
| --- | --- | --- |
| A 双预设（Chief 已拍） | 协调者 preset + `preset-tools`；worker preset 带 §6.2 工具栈；dispatch 给子会话显式 `request.agentPreset` | 需要维护 worker 行清单；载入顺序/allow 注册待真机验 |
| B 运行期收窄 | 不碰 preset scope，主会话 `agent/created` 后 `agent.ctx.tools.restrict({allow})` | 不是预设层；但子会话 scope 链不含父 agent layer，**不会漏给子会话** |
| C 空 worker `plugins: []` | ~~继承 profile 全量工具~~ | **不成立**：空预设 = 空组合，子会话没有 read/write/bash |

## 8. 待真机/单测验证（静态探针证不了）

1. **子会话工具表**：协调者 preset 建主会话 → 派一个子会话 → 断言子会话有 `read/write/bash/task_report`、无 `wait_agent`/`spawn_teammate`；主会话有 `task_*`、无 `read/write/bash/wait_agent`。
2. **worker preset 生效**：子会话 header/日志记录 `agentPreset === 'dsh-orchestrator-worker'`，且不叠加协调者的 restrict。
3. **loader 子路径**：profile 安装后 `dsh-orchestrator/preset-tools` 能解析（`exports['./preset-tools']` + `files` 含 `preset-tools.js`）。
4. **allow 注册顺序**：主会话 mount 时 `task_*`/`ask_user` 是否已注册；缺则 `preset-tools` 延到 ready（`tools/change` 或 `agent/created`）再 restrict，不能因 unknown name 抛错。
5. **rename 服务**：desktop 真机 `sessionController.rename({sessionId, title:'主会话'})` 成功（`sessionTitle` 已挂）。
6. **target 目录**：`cwd=target` 时 `sandboxPolicy.resolve` 的 `workspaceRoot === target`，writes 成功、越界 writes 被拒。

## 9. 证据位置

- 探测脚本：`docs/probes/main-session-probe.mjs`（解析 asar 文件表；`结果：40/40 PASS`）
- 预设：`dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js`（Config/plugins）；`.../dsh-agent-preset-registry/lib/index.js`（`mountPreset` @20724、`createScope` @20430、`bindScopeParent`、`entryListProblem` @865）
- 子代理：`.../dsh-subagent/lib/index.js`（`composition.toolFilter` @18239、`composeFrom` @17706、`presets.mount` @17557、`request.agentPreset` @62638、`resolveDirectory` @61346、`captureDelegatedPolicyOverrides` @19233）
- 会话 API：`.../dsh-api-session-controller/lib/index.js`（`create` @28402、`rename` @31327、`session/created` listener @53600）
- 工作区：`.../dsh-workspace/lib/index.js`（`create` @16333、`get` @18517、`list` @18844、`resolveByPath` @26959、`attachSession` @4286、`setTitle` @4193）
- 沙箱/工作目录：`.../dsh-sandbox-policy/lib/index.js` @7933、@8386；`.../dsh-working-directory/lib/index.js` @3842
- 工具限制：`.../dsh-tools/lib/index.js` @8375
- 标准预设：`.../dsh-web-app/presets/cordis.patch.yml`（33 行，persona @559、tool-bash @966、tool-fs @1222、tool-ask-user @6204）
- 会话事件：`.../dsh-session/lib/index.js` @74503 / @74482
