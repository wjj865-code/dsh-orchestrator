# 侧栏 nav 槽位探针（阶段 4 · 插件入口直达主会话）

- 日期：2026-11-14
- 作者：开发（团队研发 Bot）
- 对象：本机已安装 DeepSeek Harness（asar，`dsh/package.json` 0.2.2-rc.3；前端 `localBuildVersion()` = `0.2.2-rc.3-6b729fe`）+ `~/.dsh/profiles/desktop/node_modules/ds-bot/client.js`
- 脚本：`docs/probes/sidebar-nav-probe.mjs`（解析 asar 按包取源码，不启动 app）→ 本机 `结果：16/16 PASS`
- 结论先行：截图里的「插件 / 自动化任务 / 更多」是**平台侧栏的「全局面板」列表**（`sidebar.panellist`），不是可挂自定义按钮的 nav 槽位。要在「插件」下面放一个「点一下直接进主会话对话」的入口，做法是**启动器面板**：`main` 面板 + 同名 `sidebar.panellist` 条目，面板挂载时跑现有 `open-main` → `uiWorkspace.openSession` → `layout.selectPanel(null)` 回到对话。

## 1. 槽位语义（证据：`@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`）

- 侧栏注册：`"sidebar.panellist":{kind:'list',scope:'root'}`（@40588）。`syncPanels()` 把 `slots.entriesOfSlot('sidebar.panellist')` 映射成 `{id, order, label}` 并按 `order` 升序排序（@39357–39400）；`label` 走 `resolveSlotLabel(options.label)`，即支持 `string | () => string`。
- 契约文档（`dsh-cordis-client-runner` @293699）原文：*Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata.*
- 每个条目渲染成 `PanelRow`：图标由 `PanelIcon` 用 `renderSlot('sidebar.panellist', …, {only:id})` 取该 id 的组件（@35749），按钮和点击由侧栏自己拥有。
- **点击行为固定**：`onClick = selectPanel(id)`（@22216），没有自定义 onClick 参数；「更多」菜单同样 `onOpen(id) → selectPanel(id)`（@34588）。`injectProps.selectPanel` 直连 `ctx.layout.selectPanel(id)`（@40203）。

## 2. 插入位置（同插件面板机制）

- plugin-manager 注册 `main` 面板（`key:'plugins'`）+ `sidebar.panellist` 条目 `{id:'plugins', order:0, label}`（@329878）。
- schedule 注册 `{id:'schedules', order:10, label}`（@535940）。
- 所以「插件」下方 = `order` 取 `0 < order < 10`（本方案用 **5**）。「更多」行是 `PanelMoreMenu`，只在 `sidebar.panellist.actions` 有条目时出现（@39927，entry-customization 常驻），并固定排在面板行之后。

## 3. 点击「直接进对话」怎么成立（启动器面板）

`selectPanel(id)` 只会切 `main` 槽位的面板页；所以：

1. 注册第二个 `main` 面板，`key:'orchestrator-launcher'`，组件为启动器页（挂载即执行，不渲染面板内容）。
2. 注册同名 `sidebar.panellist` 条目 `{id:'orchestrator-launcher', order:5, label:() => '主会话'}`，组件只画图标。
3. 启动器页挂载时复用现有 `open-main`：POST `/api/orchestrator {endpoint:'open-main'}` → `ctx.uiWorkspace.openSession(sessionId)` → **`ctx.layout.selectPanel(null)`**。

`selectPanel(null)` 清空面板已核死：

- `LayoutController.selectPanel` 只对非 null 校验 `hasMainPanel`（`dsh-client-ui-layout` @20113），null 直接透传；store action 就是 `activePanelId = panelId`（@18154）。
- `MainPanel` 渲染 `main` 槽位时 `entryKey = activePanelId ?? 'conversation'`（@8733）→ null 时回到当前会话对话视图，侧栏高亮清掉。

**残余风险**：点击到挂载之间会渲染一帧启动器页（极短）。为避免用户看到空面板，启动器组件挂载即执行且只渲染「正在打开主会话…」的最小占位；失败时留在面板里显示可读错误 + 重试按钮（不吞错、不静默跳走）。

## 4. 与 ds-bot 的冲突

- `ds-bot/client.js` 含 `[class*="_newSession"],nav[class*="_panelList"]{display:none!important}`（@901725，源码行约 15493）→ **Bot 表面把整个面板列表藏掉**，`sidebar.panellist` 条目在 Bot 模式下不可见（与阶段 3 结论一致，属同一外部依赖）。
- 当前用户截图是**纯 dsh 表面**（左下角有 ds-bot 的「返回 DS Bot」，`sidebar.footer.action` 里是 `bot-return`）：截图里「插件 / 自动化任务 / 更多」都可见 → 纯 dsh 表面 `panellist` 正常渲染，启动器条目可见。
- ds-bot 保留了 `sidebar.footer.action` 并注册自己的 `bot-return`(-300)/`bot-account`(-200)：**我们删掉自己的 footer action 不会影响它们**。
- Bot 模式下的任务面板入口：保留 `conversation.header.leading` 按钮（阶段 2 已证不被 ds-bot 的 `HeaderPill` 阴影覆盖），所以 Bot 模式仍能开任务面板，只是没有侧栏启动器。

## 5. 候选槽位排序与退化方案

| 方案 | 槽位 | 点击行为 | 结论 |
| --- | --- | --- | --- |
| A 启动器面板（推荐） | `sidebar.panellist` 条目（order 5）+ `main` 面板 `orchestrator-launcher` | selectPanel → 启动器挂载 → open-main → openSession → selectPanel(null) | 满足「插件下方、点一下进对话」；纯 dsh 表面可见；有一帧占位 |
| B 「更多」菜单行 | `sidebar.panellist.actions` | 菜单项 `onOpen(id)` 仍走 selectPanel | 藏在「更多」里，不满足「插件下方」；仅作退化 |
| C 保留底部 footer action | `sidebar.footer.action` | 现在开的是任务面板 | 用户明确要删；不采用 |
| D 自定义 nav 槽位 | —— | —— | 平台没有这类槽位（已核），不存在 |

## 6. 附带证据

- 截图（用户提供）：左侧「新会话 / 插件 / 自动化任务 / 更多」可见；底部「返回 DS Bot」+ 我们的 footer「任务」；符合「纯 dsh 表面」判断。
- 现有 `client-slots-probe.md` 的 `sidebar.panellist` 结论（插件下方是面板列表）与本探针一致；本次把「点击语义」「selectPanel(null)」「order 插入点」补成可复跑的断言。
- 探针输出：`node docs/probes/sidebar-nav-probe.mjs` → `16/16 PASS`（含 ds-bot 隐藏规则与 footer 归属）。
