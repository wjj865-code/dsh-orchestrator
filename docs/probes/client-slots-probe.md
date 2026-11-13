# 客户端薄插件技术验证（阶段 2：入口 + 历史面板 + 跳转子会话）

- 日期：2026-11-14
- 作者：开发（团队研发 Bot）
- 对象：本机已安装 DeepSeek Harness（desktop profile，`~/.dsh/profiles/desktop`）+ 已安装的 `ds-bot@0.3.6`
- 目的：验证阶段 2 客户端薄插件的槽位、导航、数据与打包契约，产出实现计划前的事实依据
- 方法：读安装包内实现（`ds-bot/client.js`、`ds-bot/src/host/channel.js`、app.asar 内的客户端包源码/文档），**没有**在真机装探针；标「待装验证」的项必须装了探针才算数

## 结论摘要

1. **左侧入口可用 `sidebar.panellist`**：这是左侧栏图标列表（id/order/label + 图标组件），面板页注册到 `main` 槽位（`key` = 面板 id），点击用 `ctx.layout.selectPanel(id)` 打开。这与内置「插件」页（`sidebar.panellist` 的 `id:'plugins'` + `main` 的 `key:'plugins'`）完全同构，可以放在插件入口下方（`order` 比插件大）。
2. **ds-bot 不占这两个槽位**：它占的是 `sidebar.workspaces`（主会话/团队列表）、`sidebar.footer.action`（账户位）、`conversation.session.header`（整条会话头，单席位，靠 priority 抢）、`shell.overlay`。所以 `sidebar.panellist` / `main` 与它不冲突。
3. **会话头部按钮用 `conversation.session.header.actions`**：这是头部动作列表槽位；**不要**注册 `conversation.session.header`——那是单席位，ds-bot 用 `priority` 抢下了，注册进去会和它打架。头部组件能拿到 `sessionId`（ds-bot 的 `HeaderPill({ sessionId, ... })` 证明 props 里有）。
4. **跳转会话用 `ctx.uiWorkspace.openSession(id)`**：ds-bot 全部用它（bot 会话、普通会话、复制出来的会话）。打开协调者会话 = 面板里调用 `openSession(coordinatorSessionId)`。
5. **面板 MVP 建议用 `main` 面板页**（和插件页同构，占满左侧内容区），不要先做右侧栏；`shell.overlay` 作为浮层备选。右侧栏能用（`ctx.sidebarRight.openTab(kind, { params })` + `sidebar.right.pane.tab` 注册 tab 类型），但复杂，阶段 2 不做。
6. **数据走 host 只读路由**：`ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`，connection 服务负责鉴权（asar 原文：*The connection service supplies authentication*；ds-bot 注释：*the browser authenticates with its session cookie*）。ds-bot 的 `/api/bot` 是同款模式，可直接照抄结构。
7. **打包**：客户端产物是 `client.js`，头部 `window.__ModuleLoader__.load({ id, factory })`；`package.json` 加 `dsh.client.platform: 'web'` 和 `exports["./client"]`，`files` 包含 `client.js`。React 由浏览器模块表提供，不打包 React。

## 1. 槽位清单（与我们的选择）

ds-bot 客户端里出现的槽位（可作为已存在槽位清单的交叉验证）：

```
sidebar.brand.mark / sidebar.brand.name / sidebar.workspaces / sidebar.footer.action
sidebar.settings / sidebar.toggle.badge
settings.trigger / settings.launcher / settings.general.item / settings.action
conversation.session.header / conversation.session.header.actions / conversation.session.header.views.actions
conversation.composer / conversation.composer.dock / conversation.input.*
conversation.chat.node / conversation.chat.turnTail
shell.overlay
```

平台内置包里的补充（asar）：

- `sidebar.panellist`：左侧图标列表；`@deepseek-ai/dsh-client-ui-plugin-manager` 用 `id:'plugins', order:0` 注册「插件」入口。
- `sidebar.panellist.actions`：图标列表的「更多」菜单行（entry-customization 用它加「浏览插件 / 创建插件」）。
- `main`：主面板页槽位，**keyed**，`key` 就是面板 id。插件管理页注册方式：

  ```js
  ctx.slots.register({ name: 'main', key: PANEL_ID, store, inject: () => ({...}), children: {...} }, PageComponent)
  ctx.layout.selectPanel(PANEL_ID)   // 打开面板
  ctx.layout.panelInfo.getSnapshot().activePanelId  // 当前面板
  ```

- `sidebar.right.pane.tab`：右侧栏 tab 类型注册（keyed 座位，builtin 档）；用 `ctx.sidebarRight.openTab(kind, { params })` 打开，`ctx.sidebarRight.isExpanded()/toggleExpanded()/mounted` 可读状态。
- `shell.overlay`：全屏浮层列表，多个注册项按 `id/order` 共存（ds-bot 注册了 `bot-computer`、`bot`；ui-chat 注册了 `chat.quota-notice`）。

### 我们的选择

| 需求 | 槽位 | 理由 |
| --- | --- | --- |
| 左侧栏入口（插件下方） | `sidebar.panellist`，`id:'orchestrator'`，`order: 10`（插件是 0） | 与内置插件页同构；ds-bot 不占 |
| 任务面板主体 | `main`，`key:'orchestrator'` | 占满内容区，和插件页一致 |
| 打开面板 | `ctx.layout.selectPanel('orchestrator')` | 内置页同款 |
| 会话头按钮 | `conversation.session.header.actions` | 列表槽位，不抢 ds-bot 的单席位 |
| 浮层（可选） | `shell.overlay`，`id:'orchestrator-panel'` | 只在需要盖住会话时用 |
| 右侧栏（阶段 2 不做） | `sidebar.right.pane.tab` + `sidebarRight.openTab` | 可行但成本高 |

## 2. 会话与导航

- **当前会话 id**：头部/动作槽位组件的 props 里有 `sessionId`（ds-bot `HeaderPill({ sessionId, useSessions, ... })`）。面板里如果拿不到 props，可用
  `Object.values(ctx.sessions.list.getSnapshot().byId).find(s => (s.retainedBy?.mainView ?? 0) > 0)?.id`
  （ds-bot 的 `shownSession()` 就是这么取的）。
- **跳转**：`ctx.uiWorkspace.openSession(sessionId)`（ds-bot 全用它）。
- **新建**：`ctx.uiWorkspace.startSession(undefined, { ... })`（不用于本阶段）。
- **子会话能不能跳**：**待装验证**。web 客户端的历史列表代码 `flattenLineage` 明确处理 `origin === 'subagent'` 的行（把子会话排在父会话下面），说明 web 的 session 列表数据里**有**子会话；`uiWorkspace.openSession(childId)` 大概率可行。装探针后验证：在面板点一条任务的 `childSessionId`，看是否切到子会话；失败则退化为「复制 id + 提示从父会话的子代理目录打开」。
- **协调者会话 id**：来自 host 路由返回（台账 `settings.coordinator_session_id`），面板只读展示 + 「打开协调者」按钮。

## 3. 数据接口（host 侧只读路由）

ds-bot 的注册方式（`src/host/channel.js:845`，可直接照抄结构）：

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

- 鉴权由 connection 服务统一负责（同源 cookie），handler 内**不再信任 body 里的身份**；只提供只读端点（`listTasks` / `taskStatus` / `coordinatorId`），不写台账。
- 客户端调用（ds-bot `/api/bot` 同款）：

  ```js
  const res = await fetch('api/orchestrator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'tasks', payload: {} }),
    signal,
  })
  ```

- 建议端点：`tasks`（全部任务，字段：id/title/status/label/tone/childSessionId/coordinatorSessionId/updatedAt/stale 摘要）、`coordinator`（当前绑定会话 id 与 live 状态）。失败/离线：客户端显示「台账不可用」并在下次打开面板时重试，不阻塞会话。
- 只读路由不触发协调者绑定、不写 `notifications`、不 spawn。

## 4. 打包与加载

已验证的形态（ds-bot `package.json` + `client.js` 头部）：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "client.js", "src/host/", ...],
  "dsh": { "client": { "platform": "web" }, "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`client.js`：

```js
// Generated from src/client by the build; do not edit by hand.
window.__ModuleLoader__.load({
  id: 'ds-bot',           // 必须等于 package 名
  factory: (require) => {
    const module = { exports: {} }
    // ... 这里拿到 React：const React = require('react')
    module.exports = { apply, inject }
    return module.exports
  },
})
```

- 浏览器模块表提供 React；客户端插件是 cordis 插件（`apply(ctx)` + `inject`），用 `ctx.slots.inject/register` 注册 UI。
- 构建用 esbuild（ds-bot：`scripts/build-client.mjs`；我们仓库目前无构建，阶段 2 需要加一个最小 `scripts/build-client.mjs`，把 `src/client/` 打成 `client.js`）。
- 加载路径：profile 的 bundle patch 挂 host 插件即可；客户端 half 由 `dsh.client` 清单发现（模块系统做 `dsh.client` 扫描 + bundle route），不需要再单独注册。

## 5. 与 ds-bot 的冲突评估

| 座位 | ds-bot 用法 | 我们 | 冲突 |
| --- | --- | --- | --- |
| `sidebar.workspaces` | 整块换成 TeamSidebar | 不用 | 无 |
| `sidebar.footer.action` | 账户位（`bot-account`，order -200） | 不用 | 无 |
| `conversation.session.header` | 单席位，`priority` 抢下 | 不用（用 `.actions`） | 无 |
| `shell.overlay` | 两个浮层（`bot-computer`、`bot`） | 可选，only if needed | 有多个注册项共存机制，不覆盖 |
| `sidebar.panellist` / `main` | 不用 | 用 | 无（待装验证） |

## 6. 待装验证清单（装探针后逐条勾）

1. `sidebar.panellist` 注册后图标出现在「插件」下方；`order` 生效；点击 `ctx.layout.selectPanel('orchestrator')` 能打开 `main` 面板页。
2. `conversation.session.header.actions` 的按钮出现在会话头；组件 props 里能拿到 `sessionId`（拿不到时用 sessions 快照兜底，但要记录）。
3. `ctx.uiWorkspace.openSession(childSessionId)` 能否切到 `origin:'subagent'` 的子会话；不能时记录错误与退化方案。
4. `/api/orchestrator` 路由：未登录/跨源被拒，登录后 200；只读端点不产生台账写入。
5. ds-bot 侧栏、账户位、会话头不受影响；刷新/插件重载后入口仍注册（`ctx.slots.inject` 的生命周期）。

## 7. 建议的阶段 2 实现切分

1. host：`/api/orchestrator` 只读路由 + 查询函数（读台账，不写）。
2. client：`sidebar.panellist` 图标入口 + `main` 面板页（任务列表、状态色、协调者/子会话跳转按钮、离线降级）。
3. 会话头按钮（`conversation.session.header.actions`）打开同一面板。
4. 构建脚本 + `package.json` 的 `dsh.client` / `exports["./client"]` / `files`。
5. 真机验证 + 测试清单（入口可见可点、面板数据、跳转、离线、ds-bot 不受影响）。

## 7. 对测试四个待明确的结论

1. **入口槽位与 priority**：`sidebar.panellist`，`id:'orchestrator'`，`order:10`（内置插件入口是 `order:0`），**不设 priority**——priority 是单席位（如 `conversation.session.header`）的抢位机制，图标列表是按 `order` 排序，不用 priority。`sidebar.footer.action` 完全不碰（ds-bot 账户位，`id:'bot-account'`）。
2. **面板形态与跳转**：MVP 用 `main` 面板页（`key:'orchestrator'`，与内置插件页同构），不用 `shell.overlay`；只有需要盖住会话的临时弹层才用 overlay。子会话跳转 `ctx.uiWorkspace.openSession(childSessionId)`（**待装验证**，见 §6-3）；没有 URL/路由可拼，客户端是进程内调用，不是页面跳转。右侧栏不做（不抢 ds-bot 的右侧栏 tab）。
3. **未绑定协调者**：面板顶部显示「未绑定」，入口照常可点；点击给「先从任意会话用 `task_create` 派第一个任务，会自动绑定协调者」的提示。**不在客户端创建会话或写绑定**（只读约束）。
4. **时间与刷新**：列表主时间用 `last_event_at`（「最近动静」，与 `task_list` 的 stale 标记同源），另存 `updated_at` 供排序；打开面板拉一次，面板可见时每 5s 轮询，关闭即停；连续失败退避到 30s，并显示「台账暂不可用」，不阻塞会话。

## 8. 客户端产物最小形态（可直接作为阶段 2 骨架）

`package.json`（在现有 host 包上补）：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "src/", "client.js", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

`src/client/index.js`（构建入口，esbuild 打包成根目录 `client.js`）：

```js
import { createElement as h } from 'react'

export const name = 'dsh-orchestrator-client'
export const inject = ['slots', 'sessions', 'uiWorkspace']

export function apply(ctx) {
  // 左侧入口
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'orchestrator', order: 10, label: () => '任务',
  }, TaskIcon))
  // 面板页（keyed）
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'orchestrator', locale: 'orchestrator',
  }, TasksPanel))
  // 会话头按钮（列表槽位，不抢单席位）
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'orchestrator', order: 10,
    inject: (sessionId) => ({ openPanel: () => ctx.layout.selectPanel('orchestrator'), sessionId }),
  }, HeaderButton))
}

const TaskIcon = () => h('span', { 'aria-hidden': true }, '◆')
const HeaderButton = ({ openPanel }) => h('button', { type: 'button', onClick: openPanel }, '任务')
const TasksPanel = () => h('div', null, 'orchestrator tasks')
```

构建脚本（`scripts/build-client.mjs`）：用 esbuild 把 `src/client/index.js` 打成 CJS，外层套 `window.__ModuleLoader__.load({ id:'dsh-orchestrator', factory:(require)=>{ const module={exports:{}}; ...; return module.exports } })`。ds-bot 的 `scripts/build-client.mjs` 是参考实现（本机只有其产物，没有源码）；阶段 2 落地时优先复制官方 `templates/decoration` 的构建配置，别手写 loader 协议。

## 9. 证据位置


- ds-bot 包：`~/.dsh/profiles/desktop/node_modules/ds-bot`（`package.json`、`client.js`、`src/host/channel.js`）
- ds-bot 客户端槽位注册：`client.js` `shadow(...)` / `ctx.slots.inject` 段（`sidebar.panellist`、`conversation.session.header.actions`、`shell.overlay`）
- 会话导航：`client.js` `ctx.uiWorkspace.openSession(...)`、`shownSession()`、`HeaderPill({ sessionId, ... })`
- host 路由：`src/host/channel.js:845`（`ctx.connection.fetch.register`，注释「browser authenticates with its session cookie」）
- 平台槽位实现：app.asar 内 `@deepseek-ai/dsh-client-ui-plugin-manager`（`sidebar.panellist` + `main` keyed 页）、`@deepseek-ai/dsh-client-ui-entry-customization`（`sidebar.panellist.actions`）、`@deepseek-ai/dsh-client-ui-layout`（`ctx.layout`）、`@deepseek-ai/dsh-client-ui-deliverables` 文档（`sidebarRight.openResource` / `sidebar.right.pane.tab`）
- 客户端加载：asar 文档「UI plugins in the Web page」「Client module」段（`dsh.client` / `exports["./client"]` / `window.__ModuleLoader__.load`）
