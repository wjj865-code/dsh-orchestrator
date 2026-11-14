# 客户端薄插件技术验证（阶段 2：入口 + 历史面板 + 跳转子会话）

- 日期：2026-11-14
- 作者：开发（团队研发 Bot）
- 状态：已按审查复核意见修订（header 槽位改为 `conversation.header.leading`，路由鉴权/加载清单补全）
- 对象：本机已安装 DeepSeek Harness（desktop profile）+ 已安装的 `ds-bot@0.3.6`
- 方法：读安装包内实现（`ds-bot/client.js`、`ds-bot/src/host/channel.js`、app.asar 内客户端包与 live 槽位目录），**没有**在真机装探针；标「待装验证」的必须装了探针才算数

## 结论摘要

1. **侧栏入口用 `sidebar.footer.action`**（`id:'orchestrator'`、`order:100`）：面板页注册到 keyed 的 `main`（`key` = 面板 id），点击调用 `ctx.layout.selectPanel(id)`。**不能用 `sidebar.panellist`**：ds-bot 的 Bot 模式用 `!important` 把整个 shell 面板列表藏掉（`nav[class*="_panelList"]{display:none!important}`，ds-bot `client.js:15493`），入口会 0×0；footer action 是 ds-bot 保留的列表（它自己的 `bot-account`、`bot-return` 就在这），加一个不同 `id` 不会顶掉账户位。
2. **会话头按钮必须用 `conversation.header.leading`，不能用 `conversation.session.header.actions`**：ds-bot 在 Bot 模式用 `HeaderPill` 把整条 `conversation.session.header`（单席位）以 `priority:-100` 顶掉，而 `HeaderPill` 不渲染 `.actions` 子槽位——按钮会看不见。`conversation.header.leading` 由 `ConversationRoot` 在 header 左侧独立 `renderSlot("conversation.header.leading", {})`，不被 ds-bot 的 shadow 覆盖；该席位目前无占用者（single / `replaceRisk:none`）。它拿不到 `sessionId`，但按钮只做「打开面板」，不需要。
3. **跳转会话用 `ctx.uiWorkspace.openSession(id)`**；平台自己的子代理目录也是这么做的：`ui-subagent` 的 `openChild({ parentSessionId, childSessionId, mode })` 内部调 `uiWorkspace.openSession`。子会话跳转从「大概率」升级为「平台同款路径」，仍需真机验一条。
4. **面板 MVP 用 `main` 面板页**（与内置插件页同构；侧栏点击被平台固定为 `selectPanel`，所以流程是「侧栏 → 任务面板 → 面板里点打开协调者」）。`shell.overlay` 只作临时浮层备选；右侧栏不做。
5. **数据走 host 只读路由**：`ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`。鉴权由 connection 的 `admit()` 负责：Host/Origin 围栏（跨站 403）→ cookie/token（无 401）；exact 路由还要求 `principal.kind === 'owner'`（非 owner 403）；同路径重复注册直接抛。**只读不是平台保证**，handler 必须只 import 查询函数 + 端点白名单，测试断言调用后台账零写入。
6. **打包**：`dsh.client.platform:'web'` + `exports["./client"]` + `files` 含 `client.js`；`dsh.client.inject` 列出依赖的客户端包；官方模板的 `client.js` 是**手写**的 `__ModuleLoader__.load`，MVP 不必上 esbuild；`immediately` 只是预取提示。

## 1. 槽位清单与我们的选择

ds-bot 客户端里出现的槽位（交叉验证用）：

```
sidebar.brand.mark / sidebar.brand.name / sidebar.workspaces / sidebar.footer.action
sidebar.settings / sidebar.toggle.badge
settings.trigger / settings.launcher / settings.general.item / settings.action
conversation.session.header / conversation.session.header.actions / conversation.session.header.views.actions
conversation.composer / conversation.composer.dock / conversation.input.*
conversation.chat.node / conversation.chat.turnTail
shell.overlay
```

平台侧补充（asar）：

- `conversation.header.leading`：`ConversationHeader` 左侧独立渲染，`renderSlot("conversation.header.leading", {})`；single、`scope:'root'`、`occupants:[]`、`replaceRisk:'none'`。**没有 `sessionId` prop。**
- `conversation.session.header`：单席位，ds-bot 用 `HeaderPill` + priority 抢下；它不渲染 `.actions`。
- `conversation.session.header.actions`：列表槽位，只在平台自己的 header 里渲染（Bot 模式下被盖住，不可用）。
- `sidebar.panellist`：左侧图标列表；plugin-manager 用 `id:'plugins', order:0`。
- `sidebar.panellist.actions`：图标列表「更多」菜单行。
- `main`：主面板页，**keyed**；`key` 即面板 id，打开用 `ctx.layout.selectPanel(id)`，当前面板读 `ctx.layout.panelInfo.getSnapshot().activePanelId`。
- `sidebar.right.pane.tab`：右侧栏 tab 类型（keyed 座位），`ctx.sidebarRight.openTab(kind, { params })` 打开；`isExpanded()/toggleExpanded()/mounted` 可读状态。阶段 2 不做。
- `shell.overlay`：全屏浮层列表，多注册项按 `id/order` 共存。

### 我们的选择

| 需求 | 槽位 | 理由 |
| --- | --- | --- |
| 侧栏入口（Bot 模式可见） | `sidebar.footer.action`，`id:'orchestrator'`，`order:100` | ds-bot 保留了 footer action 列表（账户/返回都在），panellist 被它 `!important` 藏掉 |
| 任务面板主体 | `main`，`key:'orchestrator'` | 占满内容区 |
| 打开面板 | `ctx.layout.selectPanel('orchestrator')` | 内置页同款；sidebar 行点击被平台固定为此行为 |
| 会话头按钮 | `conversation.header.leading` | 不被 ds-bot 的 header shadow 覆盖；Bot 模式可见；无 `sessionId` 但按钮只用打开面板 |
| 浮层（可选） | `shell.overlay`，`id:'orchestrator-panel'` | 需要盖住会话时 |
| 右侧栏（阶段 2 不做） | `sidebar.right.pane.tab` + `sidebarRight.openTab` | 成本高，且规则要求不抢 ds-bot 右侧栏 tab |

> 关于 priority：单席位（`conversation.session.header`、`conversation.header.leading`）用 priority 抢位；**列表槽位（`sidebar.panellist`、`shell.overlay` 等）也按 priority 排序，同 `id` 的低 priority 会被顶掉**。我们的入口用 `order` 排序、不设 priority，避免顶掉别人。

## 2. 会话与导航

- **当前会话 id**：`conversation.header.leading` / `main` 组件**都没有 `sessionId` prop**；走 `ctx.uiSession.current`（若可用）或
  `Object.values(ctx.sessions.list.getSnapshot().byId).find(s => (s.retainedBy?.mainView ?? 0) > 0)?.id`。
  ds-bot 的 `shownSession()` 就是后者。
- **跳转**：`ctx.uiWorkspace.openSession(sessionId)`（ds-bot 全用它；`ui-subagent.openChild` 内部也是它）。
- **子会话**：平台 `ui-subagent` 的 `openChild({ parentSessionId, childSessionId, mode })` —— 面板里可以直接 `ctx.uiWorkspace.openSession(childSessionId)`；待装验证一条（§6-3）。
- **协调者会话 id**：host 路由返回（台账 `settings.coordinator_session_id`）；面板只读展示 + 「打开协调者」按钮。

## 3. 数据接口（host 侧只读路由）

注册形态（`src/host/channel.js:845` 同款）：

```js
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/orchestrator',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => {
    let body
    try { body = await request.json() } catch { body = {} }
    const result = await handle(String(body?.endpoint ?? ''), body?.payload, request.signal)
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  },
}), 'dsh-orchestrator: api route')
```

鉴权与边界（审查从 connection 源码核过）：

- `admit()` 先查 Host/Origin 围栏（跨站 403），再查 cookie/token（无凭据 401）；exact 注册的路由还要求 `principal.kind === 'owner'`（非 owner 403）；同 path 重复注册会抛。
- **平台不保证只读**：handler 必须只 import 查询函数（`listTasks`/`getTask`/`recentMessages`/`getSetting`），端点白名单校验（`tasks` / `coordinator`），不调用任何写函数、不触发绑定、不 spawn、不写 `notifications`。
- 客户端调用：`fetch('api/orchestrator', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ endpoint:'tasks', payload:{} }), signal })`。
- 降级：非 200/断网 → 显示「台账暂不可用」并保留上次数据，面板不阻塞会话；下次打开/轮询重试。

## 4. 打包与加载

`package.json`：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "src/", "client.js", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-workspace"
      ]
    }
  }
}
```

- `dsh.client.inject` 是**加载/预取 metadata，不是激活顺序**（client-runner 注释原文：*inject edges are informational … never apply sequencing*）；列依赖的客户端包只为预取提示。这里列的是我们用到的槽位/服务 owner：`ui-sidebar`（`sidebar.footer.action`）、`ui-conversation`（`conversation.header.leading`）、`ui-layout`（`main` / `ctx.layout`）、`ui-workspace`（`uiWorkspace.openSession`）。`dsh.client.external` 用于声明不打进 bundle 的运行时导入（如 `dsh-client-ui-primitives`；不打进 bundle 就必须声明）。
- **加载方式是经典脚本，不是 ESM**：`client.js` 由 `document.createElement("script")` 加载（asar `@deepseek-ai/dsh-client-modules/lib/client.js` 的 `defaultLoadBundle`），所以**顶层不能有 `import`**，否则直接 SyntaxError。骨架必须写成官方 `templates/decoration/client.js` 的形态：`window.__ModuleLoader__.load({ id, factory(require){ const h = require('react').createElement; …; return { inject, apply } } })`。想用 ESM/JSX 就得先 esbuild 打成经典脚本再提交产物；**MVP 直接手写 `client.js`，不需要 esbuild**。
- `immediately` 只是预取提示，不是加载开关；不写也能加载。
- `files` 必须包含 `client.js`，否则装进 profile 后客户端 half 缺失（少一个文件就加载失败）。

## 5. 与 ds-bot 的冲突评估

| 座位 | ds-bot 用法 | 我们 | 冲突 |
| --- | --- | --- | --- |
| `sidebar.workspaces` | 整块换 TeamSidebar | 不用 | 无 |
| `sidebar.footer.action` | 账户位 `bot-account`（-200）、返回 `bot-return`（-300），是列表 | 加 `id:'orchestrator'`、order 100 | 无（id 不同，不顶掉账户位） |
| `sidebar.panellist` | 不用，但 Bot 模式用 `!important` 藏掉整个面板列表 | **不用**（会 0×0） | 从方案里移除 |
| `conversation.session.header` | 单席位，`priority` 抢下；不渲染 `.actions` | 不用 | 无（所以按钮改到 `leading`） |
| `conversation.header.leading` | 不用 | 用（按钮） | 无 |
| `shell.overlay` | 两个浮层（`bot-computer`、`bot`） | 可选 | 多注册项共存，不覆盖 |

## 6. 待装验证清单（装探针后逐条勾）

1. **Bot 模式**下 `sidebar.footer.action` 入口可见（账户/返回旁边多一个「任务」图标），点击打开 `main` 面板页；不遮挡 `bot-account`/`bot-return`。
2. **ds-bot 的 Bot 模式**下 `conversation.header.leading` 按钮仍可见（这是本次修正的原因）；点击打开面板。
3. `ctx.uiWorkspace.openSession(childSessionId)` 能切到 `origin:'subagent'` 的子会话；失败则退化为「复制 id + 提示从父会话子代理目录打开」。
4. `/api/orchestrator`：未登录 401、跨源 403、非 owner 403、正常 200；调用前后台账行数/`settings` 不变（只读断言）。
5. ds-bot 侧栏、账户位、会话头不受影响；插件重载后入口仍注册（`ctx.slots.inject` 生命周期）。

## 7. 对测试四个待明确的结论

1. **入口槽位与 priority**：`sidebar.footer.action`，`id:'orchestrator'`，`order:100`，**不设 priority**；`id` 不同就不会顶掉 ds-bot 的 `bot-account`/`bot-return`。`sidebar.panellist` 在 Bot 模式被 ds-bot 用 `!important` 藏掉，已从方案移除。
2. **面板形态与跳转**：`main` 面板页（`key:'orchestrator'`），不是 `shell.overlay`；侧栏行点击被平台固定为 `selectPanel`，因此流程是「侧栏 → 面板 → 打开协调者会话」。子会话跳转 `ctx.uiWorkspace.openSession(childSessionId)`（平台 `ui-subagent.openChild` 同款），无 URL。
3. **未绑定协调者**：入口照常可点，面板顶部显示「未绑定」+「先从任意会话 task_create 派第一个任务」提示；**客户端不创建会话、不写绑定**。
4. **时间与刷新**：列表主时间用 `last_event_at`（最近动静，与 `task_list` stale 同源），另存 `updated_at` 供排序；打开拉一次，可见时 5s 轮询，关闭即停；连续失败退避 30s，显示「台账暂不可用」。

## 8. 客户端产物最小形态（骨架）

`client.js`（手写经典脚本，**不能有顶层 `import`/`export`**；模块加载器用 `document.createElement("script")` 加载）：

```js
// client.js — classic script，官方 templates/decoration/client.js 同款形态
window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (require) => {
    const h = require('react').createElement
    const inject = ['slots', 'layout', 'uiWorkspace']

    const SidebarEntry = ({ openPanel, wide }) => h('button', { type: 'button', title: '任务面板', 'aria-label': '任务', onClick: openPanel },
      h('span', { 'aria-hidden': true }, '\u2630'), wide ? h('span', null, '任务') : null)
    const HeaderButton = ({ openPanel }) => h('button', { type: 'button', onClick: openPanel }, '任务')
    const TasksPanel = () => h('div', null, 'orchestrator tasks')

    function apply(ctx) {
      // 侧栏底部入口：Bot 模式 panellist 被 ds-bot !important 藏掉，footer.action 是保留席位
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'orchestrator', order: 100,
        inject: () => ({ openPanel: () => ctx.layout.selectPanel('orchestrator') }),
      }, SidebarEntry))
      // 面板页（keyed，与内置插件页同构；不注册 locale 字典就用字面量）
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'orchestrator',
      }, TasksPanel))
      // 会话头按钮：leading 是单席位，不带 id
      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
        name: 'conversation.header.leading',
        inject: () => ({ openPanel: () => ctx.layout.selectPanel('orchestrator') }),
      }, HeaderButton))
    }

    return { inject, apply }
  },
})
```

> 当前会话 id 不在 `leading`/`main` 的 props 里：用 `ctx.uiSession.current` 或 `ctx.sessions.list.getSnapshot()` + `retainedBy.mainView` 兜底。上面是骨架，不是可交付代码；要上 JSX/ESM 就先 esbuild 打成经典脚本再提交 `client.js`。

## 9. 证据位置

- ds-bot 包：`~/.dsh/profiles/desktop/node_modules/ds-bot`（`package.json`、`client.js`、`src/host/channel.js`）
- ds-bot `HeaderPill({ sessionId, … })`：`client.js:34811`；`installHeader` + `BOT_PRIORITY=-100`：`client.js:41712`
- ds-bot host 路由：`src/host/channel.js:845`（`ctx.connection.fetch.register`，注释 *browser authenticates with its session cookie*）
- `ConversationHeader` 渲染 `conversation.header.leading`：asar `@deepseek-ai/dsh-client-ui-conversation`（`renderSlot("conversation.header.leading", {})`，与 `conversation.session.header` 并列、在其左侧）
- `ui-subagent` 目录打开子会话：asar `@deepseek-ai/dsh-client-ui-subagent`（`openChild({ parentSessionId, childSessionId, mode })` → `uiWorkspace.openSession`）
- ds-bot Bot 模式藏面板列表：`client.js:15493`（`nav[class*="_panelList"]{display:none!important}`）；保留 footer：`client.js:15513-15520`（`_footArea` grid、`_footerActions` display:contents）
- 平台侧 `sidebar.panellist` + `main` 注册：asar `@deepseek-ai/dsh-client-ui-plugin-manager`（`id:'plugins'`、`key: PANEL_ID`、`ctx.layout.selectPanel`）
- ui-sidebar 侧栏渲染：asar `@deepseek-ai/dsh-client-ui-sidebar`（`panels.length > 0` 渲染 nav；`footerActions` 渲染 `sidebar.footer.action`）
- 连接鉴权：asar `@deepseek-ai/dsh-client-connection`（`admit()` 403/401、exact route owner 403、重复 path 抛）
- 客户端加载：asar `@deepseek-ai/dsh-client-modules`（`defaultLoadBundle` 的 `document.createElement("script")`）；官方 `templates/decoration/{client.js,package.json}`（手写 loader、`dsh.client` 字段）

## 10. 阶段 2 落地位置

- `client.js`：根目录经典脚本产物（`sidebar.footer.action` 侧栏入口 / `main` 面板 / `conversation.header.leading` 按钮；面板 5s 轮询 + 失败退避 30s + 状态筛选 + 打开协调者/子会话）。
- `src/host-route.js`：`/api/orchestrator` 只读 handler（端点白名单 `snapshot`；只 import 查询函数）。
- `index.js`：`ctx.get('connection').fetch.register` 注册路由，卸载时 dispose；缺服务只 warn。
- `package.json`：`exports["./client"]`、`files` 含 `client.js`、`dsh.client.platform/inject`。
- 验收：`test/client.test.js`（注册捕获 + 经典脚本解析 + 清单）、`test/host-route.test.js`（白名单/零写入/降级）、`node docs/probes/qa-stage2-slots.mjs client.js`（测试维护的 L1 探针）。
