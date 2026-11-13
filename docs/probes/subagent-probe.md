# 子代理 `startActivation` 技术验证（直连 subagent、绕开 Team 名册）

- 日期：2026-11-13
- 对象：已安装 DeepSeek Harness 0.2.2-rc.1（`C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`）
- 方法：源码级探测（读安装包内实现），没有启动完整 app 跑真实子代理；运行时结论标为「待 spike」。
- 目的：验证插件能否直接创建/驱动子会话，绕开 Team 的 8 人名册，从而让任务 = 子会话、用户不用切协调者。

## 结论摘要

**可行，但不能直接无条件替换 Team。** 直连 subagent 能得到独立子会话、后续追加消息、取消和全局工具；默认并发上限仍是 8（可配置、完成后释放），且子会话不属于普通会话列表、父会话关闭会释放后代。建议先做一次 smoke spike（队列 + 真实 `task_report`），再决定是否全量替换。

## 1. 能否自己生成 childId 并调 `startActivation`

可以。`SubagentActivationSpec`（asar @119747147）：

```ts
interface SubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly childId?: SessionId
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}
```

- 传 `childId` 会选择**本地后端**，并保证返回 `messageId`；不传可走外部后端。Team 自己就是生成 `randomUUID()` 作为 `childId` 后调用（@54061200）。
- `request` 需要 `parent: Agent`、`prompt: ContentBlock[]`；可选 `cwd`、`agentPreset`、`agentOptions`、`outputSchema`、`maxDepth`。
- `startActivation` 返回 `{ childId, messageId?, result, dispose }`；本地子级可后续追加消息、可冷恢复；外部子级只执行一次、拒绝继续输入（@119507972）。
- `provider` 取值由已注册 provider 决定：内置 `spawn`（fresh，支持 agentPreset）和 `fork`（继承父上下文，拒绝 agentPreset）；provider 名称可通过配置改，外部插件还能注册自己的 provider。Team 的 fresh/fork 分别默认 `spawn`/`fork`。
- `delivery`：`parent` 在结算后给父会话发完成通知；`caller` 由调用方等待 `result`，不向父级发通知。任务模型建议 `caller`（通知仍由我们的 notifier 发），避免和平台 settlement 双份。

**待 spike**：`request.prompt` 的实际 ContentBlock 校验、`parent` 必须是 exact live Agent、事件/工具作用域是否按预期继承。

## 2. 并发/数量上限

有上限，但不是 Team 的不可变名册：

- `dsh-subagent` 的 `maxActiveSubagents` 默认 **8**，可配置（`subagent` 设置，@119662563）。
- 每次 activation 向 root pool `reserve(capacity)`；满了直接抛 `ACTIVATION_LIMIT_REACHED`（错误文案含 `subagent limit reached (active child limit: 8)`，@119583743），**不排队**。
- 完成/`dispose()` 会释放槽位，所以不是「用过就永久占一个成员」；这是和 Team 名册的根本区别。
- `maxDepth` 默认 1，root 只能直接开一层；子级再开子级要显式提高。

结论：直连 subagent 也默认只能同时跑 8 个，但**可配置、可释放、没有名册成员概念**；要支持更多任务仍需自己排队，或在部署配置里提高 `maxActiveSubagents`。

## 3. 后续消息、取消与收场

- 追加消息：`SubagentService.sendMessage(sender, targetId, content, { signal })`（@121504594）；本地子级接受后续消息并可冷恢复。Team 内部用 `steerHostSubagentPrompt` 走同一个投递层。
- 取消：`activation.dispose()` 取消该 activation 并等待子树停稳；按父地址的远程面是 `interruptByParent(childSessionId, parentSessionId, 'continuable')`（@119676212）。
- 父会话退出：关闭会话会释放其后代（子代理文档：“关闭会话还会释放其后代”）；本地持久化子级可冷恢复，但需要父 Session/查询服务。**隐藏代价**：父会话被删/关闭后，子任务不能独立作为顶层会话长期存活，任务台账要能标 orphaned 并重建。
- 失败/清理：创建前调用方 signal 可取消；发布后用 `dispose()` 收场；父级 `drainChildren(parent, childIds)` 可释放选定的 direct children。

## 4. 会话列表可见性、全局工具

- Session 头有 `parentSession` 和 `origin: 'subagent'`（@19161173）。
- ACP 会话列表/恢复文档明确：**普通 fork（含 `parentSession` 的历史）可以列出/恢复，`origin: 'subagent'` 仍被排除**（@18994791）。
- 子级仍可通过父会话的 `subagent/catalog` 被发现、打开、继续（“已完成的本地工作流子级仍可被发现、打开或继续”，@119533289）。也就是说：**不会作为普通顶层会话自动出现在会话列表；用户可以从父会话的子代理目录/卡片打开它**。卡片跳转要用子代理目录，而不是假设它是普通 Session。
- 工具：子级在继承/独立选择的 preset 下拥有自己的作用域，不导入父方 Agent 局部工具限制（@119492375）；全局注册的工具（包括我们的 `task_report`）原则上可见，但 preset 的 `composition.toolFilter` 仍可能过滤。**必须 spike 验证子会话能看到并调用 `task_report`**。
- 父级退出会释放后代；任务卡片如果指向子会话，需要处理子会话不可达时的 orphaned/重建。

## 建议

1. **先做最小 spike**：插件里用 `ctx.subagents.startActivation({ provider:'spawn', label, delivery:'caller', childId, signal, request:{parent: coordinatorAgent, prompt:[...], cwd} })` 起一个真实子会话，验证：全局 `task_report` 可见、`sendMessage` 追加、`dispose` 取消、任务卡片能打开子会话。
2. **并发治理仍需要**：`maxActiveSubagents` 默认 8 且满了抛错；插件要排队或显式提高配置。不要承诺“没有 8 个上限”。
3. **会话模型要改**：子会话不是普通顶层 Session；UI/卡片跳转要走 subagent catalog；父会话关闭/删除要把任务标 orphaned 并提供重建。
4. 若 spike 通过，再把 Team 那一层整体替换；若 `task_report`/可见性/父退场任一不成立，回到「满 8 轮换协调者」方案。

## 证据定位（asar 偏移）

- `SubagentActivationSpec`：119747147
- `startActivation` 实现：119665086、119837381
- `maxActiveSubagents` 默认 8：119662563
- `reserve` 满额抛 `ACTIVATION_LIMIT_REACHED`：119583743
- `sendMessage`：121504594
- `interruptByParent`：119676212
- SessionHeader `origin: 'subagent'`：19161173
- ACP 会话列表排除 subagent：18994791
- catalog 可发现/打开/继续：119533289
- 父会话关闭释放后代：19005815
