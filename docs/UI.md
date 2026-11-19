# 面板与详情 UI（U2）

任务面板（会话头「任务」入口打开的那个 `main` 面板）与详情抽屉的界面规范：
DeepSeek 设计平台风格、三段式布局、右侧抽屉详情、现代化交互。实现全部在 `client/src/**`（ESM 源码），
由 vite 构建成 `dist/client.js`；产物是平台要求的 classic script，**不能 `import` CSS**，
所以样式表以 `?inline` 内联回 JS、运行时注入。

- 代码：`client/src/views.js`（面板 / 抽屉 / 启动器 / 会话头按钮 / 回复底部 chip）、`client/src/styles.css`（整张样式表）、
  `client/src/styles.js`（`ensureStyles`）、`client/src/ui.js`（图标 / 徽标 / 空态 / 骨架）、`client/src/feed.js`（chip 的共享快照源）
- 产物预览走宿主的会话右侧栏（`ctx.sidebarRight.openResource` + `dsh-resource://file/session/…`），
  见 [§6 产物预览](#6-产物预览会话右侧栏)
- 回复底部「关联任务」chip 走宿主的 `conversation.chat.turnTail` 槽位，见 [§7 回复底部关联任务 chip](#7-回复底部关联任务-chip官方-turntail-槽位)
- 测试：`test/client.test.js` 的 `U2 …` 用例组（行为断言跑 `dist/client.js`，源码断言读 `client/src/**`）
- 相关：[ARCHITECTURE.md](ARCHITECTURE.md#面板与详情ui-u2)、[README](../README.md#面板长什么样u2)

## 1. 三段式布局

```
┌──────────────────────────────────────────────────────────────┐
│ ① 顶部命令栏 .orch-topbar                                    │
│   ◆ 任务 · 待你决定 N   ● 主会话在线   [搜索] [刷新] [打开主会话] │
├──────────────────────────────────────────────────────────────┤
│   概览卡 .orch-metrics（4 个指标，点卡片 = 切筛选）            │
├──────────┬───────────────────────────────────────────────────┤
│ ② 筛选轨 │ 列表区 .orch-main                                  │
│ .orch-   │   提示条（错误/提示/收件箱/主会话引导）             │
│  rail    │   任务卡 .orch-card × N  或  产物库 .orch-group     │
│ 全部 12  │                                                   │
│ 进行中 3 │          ┌──────────────────────────────┐         │
│ …        │          │ ③ 抽屉 .orch-drawer（右侧滑入）│         │
└──────────┴──────────┴──────────────────────────────┴─────────┘
```

| 段 | 结构 | 代码位置 |
| --- | --- | --- |
| ① 顶部命令栏 | `.orch-shell > .orch-topbar`（标题、主会话状态、搜索、刷新、打开主会话） | `views.js`（`topbar()`）；样式 `styles.css` |
| ① 概览卡 | `.orch-metrics`（进行中/待你决定/已完成/失败，点击即切筛选） | `views.js`（`metrics()`）；样式 `styles.css` |
| ② 筛选轨 | `.orch-body > .orch-rail`（7 个筛选项，带计数徽标） | `views.js`（`rail()`）；样式 `styles.css` |
| ② 列表区 | `.orch-main`（提示条 + 任务卡 / 产物库） | `views.js`（`alerts()` / `renderTask()` / `artifactView()` / `listView()`）；样式 `styles.css` |
| ③ 右侧抽屉 | `.orch-layer > .orch-scrim + .orch-drawer`（常驻挂载，`data-open` 驱动滑入） | `views.js`（`drawerContent()` / `drawerBody()`）；样式 `styles.css` |

要点：

- 抽屉**常驻挂载**，只切 `data-open`：关闭时 `transform: translateX(102%)` 滑出，不是直接卸载（否则没有动画）。
- 遮罩 `.orch-scrim` 用 `--dsw-alias-bg-mask-1`，点击遮罩、点关闭按钮、按 `Esc` 都关抽屉（`views.js` 里 `drawerOpen` 的副作用）。
- 窄屏（≤860px）筛选轨变横向条、指标两列；≤640px 抽屉铺满（`styles.css` 的媒体查询）。

## 2. 设计 token 落地（--dsw-*）

颜色/圆角/阴影/动效一律取宿主 `@deepseek-ai/dsh-client-ui-theme` 的 token（`design-platform.css`、
`base.css`、`gradient-shadow-text.css`），**不写死颜色**；深浅色由宿主把 alias token 绑到
`body[data-ds-dark-theme]` 上，面板只读 token，因此两套主题自动适配。每一处 `var()` 都带一个兜底值，
只在宿主换主题/token 缺失时才会用到。

| 用途 | token | 代码 |
| --- | --- | --- |
| 画布底色 | `--dsw-alias-bg-base` | `styles.css` |
| 顶栏/抽屉头尾底色 | `--dsw-alias-bg-layer-1` | `styles.css` |
| 卡片/抽屉/输入聚焦面 | `--dsw-alias-bg-layer-2` | `styles.css` |
| 卡片底色 / hover | `--dsw-alias-card-fill` / `-hover` | `styles.css` |
| 正文三档文字 | `--dsw-alias-label-primary/secondary/tertiary` | `styles.css` |
| 描边三档 | `--dsw-alias-border-l1/l2/l3` | `styles.css` |
| 选中描边（打开中的卡/指标） | `--dsw-alias-border-selected` | `styles.css` |
| 悬停/按下交互层 | `--dsw-alias-interactive-bg-hover` / `-active` | `styles.css` |
| 危险悬停 | `--dsw-alias-interactive-bg-hover-danger` | `styles.css` |
| 主按钮 | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-inverted` | `styles.css` |
| 圆角阶 | `--dsw-radius-xs/sm/md/lg` | `styles.css` |
| 悬浮阴影 / 抽屉高度 | `--dsw-shadow-lv1` / `--dsw-elevation-prominent` | `styles.css` |
| 骨架底色 | `--dsw-alias-bg-skeleton` | `styles.css` |
| 遮罩 | `--dsw-alias-bg-mask-1` | `styles.css` |
| 焦点环 | `--dsw-focus-ring-color` | `styles.css` |
| 代码/预览底色 | `--dsw-alias-markdown-code-block` | `styles.css` |
| 用户消息气泡 | `--dsw-specific-bubble` | `styles.css` |
| 状态语义色 | `--dsw-alias-state-success/error/warn/business-primary` | `constants.js`（`TONE_COLOR`）、`styles.css` |
| 动效曲线/时长 | `--ds-ease-in-out`、`--ds-transition-duration(-fast/-slow)` | `styles.css` |

> 顺带修掉一个旧 bug：U2 之前客户端用的是 `--dsw-alias-color-success` 这类变量，
> 宿主 token 表里**并不存在**（一直走 fallback，深色主题下颜色发脏）。现在统一成
> `--dsw-alias-state-*` / `--dsw-alias-label-*` 语义 token，测试里有 `doesNotMatch` 守着。

## 3. 交互

| 交互 | 实现 |
| --- | --- |
| hover | `.orch-card:hover`（底色 + 描边 + `--dsw-shadow-lv1`）、`.orch-btn:hover`（含会话头「任务」入口，无描边无阴影）、`.orch-metric:hover`（上浮 1px）、`.orch-rail-item:hover`、`.orch-section-head:hover`、`.orch-artifact:hover`、`.orch-artifact-open:hover`（转品牌色 + 下划线，全在 `styles.css`） |
| 动画/过渡 | 抽屉滑入滑出（`transform` + `--ds-transition-duration-slow`）、展开/折叠 `grid-template-rows: 0fr→1fr`、chevron 旋转、内容入场 `@keyframes orch-slide-in`、骨架 `@keyframes orch-shimmer`、按钮 `transform: scale(.985)` 按下反馈（`styles.css`） |
| 二次确认 | 「停止」先变成「确认停止？/ 取消」，「确认交付」（`delivered` → `done`，不可逆）与删除同样两步「确认交付完成？/ 取消」「确认删除？/ 取消」（`.orch-confirm`，`views.js` 的 `stopControl` / `closeControl` / `deleteControl`），不再用 `window.confirm`；动作进行中禁用按钮并显示「停止中…/重派中…/确认中…/删除中…」 |
| 空态 | `.orch-empty` 图标 + 标题 + 提示（无任务 / 无匹配 / 无产物 / 无消息 / 无前置 / 无下游 / 没有 brief / 没有返回消息），`ui.js` 的 `EmptyState` |
| 加载态 | 首帧 5 张骨架卡（`SkeletonList`，`ui.js`）、产物库 3 张、抽屉骨架；刷新按钮转圈（`.orch-spin`）；回退行内预览有加载占位 |
| 错误态 | 快照错误「台账暂不可用：…」+ 重试；动作错误带错误码（`失败（CODE）：…`）；产物加载失败 + 重试；抽屉详情失败 + 「重新加载」；右侧栏不可用时提示「右侧栏不可用（<原因>）…」并（仅产物库行）回退行内预览 |
| 折叠 | 抽屉每个区块标题都是 `<button>`，`aria-expanded` + `0fr↔1fr` 过渡（`views.js` 的 `detailSection`） |
| 搜索 | 顶栏搜索框按标题/编号/目录过滤（`matchesQuery`，`logic.js`） |
| 键盘/无障碍 | `Esc` 关抽屉、`aria-expanded`/`aria-pressed`/`aria-hidden`/`aria-label`、`:focus-visible` 焦点环 |
| 减少动效 | `@media (prefers-reduced-motion: reduce)` 关掉全部动画/过渡（`styles.css`） |

## 4. 详情抽屉内容（保留 A3/A4/B1/G1）

抽屉自上而下：头部（标题 + 状态徽标 + 关闭）、概要信息、7 个可折叠区块、底部动作条。

| 区块 | 内容 | 来源 |
| --- | --- | --- |
| 概览 | 编号/状态/目标目录/分组/优先级/计划/写域/创建/更新 | `detail.task` |
| 最新回复（B1） | 子会话最后一条 assistant 消息：内联给正文，大文件给摘要 + 报告文件路径 | `detail.task.lastMessage`（`src/panel-actions.js` 新增回传） |
| Brief | 目标、验收标准、约束、背景资料、用户原话（结构化列表，不再是纯文本块） | `detail.task.brief` |
| 目标状态（G1） | 平台 goal 的 objective/阶段/续轮/轮次/修订，只读、无写操作 | `detail.task.goalState` |
| 消息 | 最近 20 条；followup 标「待发/已投递/投递失败」 | `detail.messages` |
| 依赖 | 上游前置 + 下游依赖，各带状态与错误 | `detail.dependencies` / `detail.dependents` |
| 产物 | 路径/标签/存在性；点路径在会话右侧栏预览，另有「复制路径」 | `detail.task.artifacts` |

> P8 计划模式：任务卡状态旁有「计划中」小标（仅 `planState==='planning'`）、卡片 meta 有「计划·…」chip，
> 抽屉概览有「计划」行、抽屉副标题有「计划：…」；均来自 `snapshot`/`detail` 的 `planFirst`/`planState`，前端只读。

> 两段式终态（`delivered` = 已交付待确认）：状态徽标用 `STATUS_LABEL.delivered`「待确认」/ `STATUS_TONE.delivered` 暖色；
> 「待你决定」筛选含 `delivered`（`logic.js` 的 `matchesFilter`）；抽屉概览多「交付」（`deliveredAt` + 待确认文案）与
> 「关闭」（`closeReasonLabel`）两行，列表行与抽屉都带「确认交付」。

底部动作条：停止（二次确认）、重派、确认交付（二次确认）、打开子会话、删除（二次确认）。

按钮可见性由服务端 `src/panel-gates.js` 判定，快照/详情下发 `canFollowup` / `canClose` / `canDelete`，前端只读：

- 面板**不再提供「追加消息」入口**：旧实现点一下走 `window.prompt`，而 Electron 渲染进程把 `window.prompt`
  替换成抛错桩（`prompt() is not supported.`），从来发不出请求。续派 / 批准计划统一走协调者的
  `task_message`（服务端 `canFollowup` 仍随快照下发，面板只是不再渲染这个按钮）。
- 「确认交付」只在 `delivered` 显示（`canClose`，与工具 `task_message({action:'close'})` 同源；`done` 的重复确认按幂等提示「任务已完成，无需重复确认」），列表行与抽屉都以「确认交付」按钮 + 两步确认呈现。
- 「删除」只在终态显示（`done` / `failed` / `cancelled` / `orphaned`）且没有活跃下游依赖；活跃任务不显示删除，抽屉底部给一句「进行中/等派发的任务不能删除：先「停止」再删。」。删除只清台账（任务 + 消息 + 通知），产物文件/记忆不动。

## 5. 会话头入口（任务面板的入口按钮）

注册在 `conversation.header.leading`（单席位、不带 `id`），仅主会话显示（闸门 `client/src/gate.js`，fail-closed）。

视觉与面板顶栏 `.orch-brand` 同一套语言，不再用裸字符 `☰`；**按钮本身不画外框**，
与同排的协调者预设标签（宿主 `AgentPresetLabel`）和子智能体计数（宿主 `SubagentHeaderLineage` 的
trigger）一致：三者都是无描边、透明底的 chip，hover 只换 `--dsw-alias-interactive-bg-hover`。

| 部分 | class | 规格 |
| --- | --- | --- |
| 按钮 | `.orch-btn.orch-btn--entry` | 高 26px、内边距 0 4px、描边 `transparent`（只占 `.orch-btn` 的 1px 盒模型，不画出来）、底色 `transparent`、`--dsw-alias-label-primary` 半粗字；不再有 hover 阴影与描边色切换 |
| 图标块 | `.orch-entry-mark` | 18×18、`--dsw-radius-xs` 圆角、`--dsw-specific-bubble` 底、`--dsw-alias-state-business-primary` 前景，内装 `ui.js` 的 `menu` 内联 SVG（三条横线，12px） |
| 文字 | `.orch-entry-label` | 12px、`letter-spacing: 0.01em`、不换行 |

四个交互状态（hover / active / disabled / focus-visible）全部继承 `.orch-btn`，不重复声明：
hover 是交互底色 + 文字转 `--dsw-alias-label-primary`，active 再加 `transform: scale(.985)`，
disabled 降到 `opacity: .45`，focus-visible 走焦点环——都没有描边。

## 6. 产物预览（会话右侧栏）

产物预览**不在面板里自建视图**，而是复用宿主的右侧栏 Tab（`@deepseek-ai/dsh-client-ui-sidebar-right` +
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`，`kind:'text'`，Markdown / 代码 / 图片 / PDF / Office 都有渲染器）。

调用链：

```
产物库「预览」按钮 / 任务卡产物路径 / 抽屉产物路径
  → views.js  previewInSidebar(taskId, path, inlineFallback)
      ├─ isRegisteredArtifact(path)? 否 → 只提示，不发请求
      └─ client.js openArtifactPreview(path)     ← 由 main 槽位 inject 注入
          ├─ 探测：serviceOf('sidebarRight')?.openResource 是函数？（否 → { ok:false, reason:'sidebar-missing' }）
          ├─ 探测：fileAddressProblem(readSessionId(), path) 为 null？（否 → reason:'no-session' / 'bad-path'）
          ├─ 面板可见时 ctx.layout.selectPanel(null)   ← 只在探测全通过后才切面板
          ├─ sidebar.openResource(address)             ← 座位没就绪就让它抛，不猜时序
          └─ 抛错 → 若刚切过面板则 selectPanel(PANEL_ID) 切回来 → { ok:false, reason:'host-refused', message }
  → 失败时：产物库行提示「右侧栏不可用（<原因>），已改为行内预览」并走旧 preview 端点；
    任务卡 / 抽屉里没有可渲染行内预览的位置，只提示可去「产物」页看或复制路径
```

要点：

- **地址必须带 Session**：`logic.js` 的 `fileAddressOf` 拼 `dsh-resource://file/session/<编码 id>/<逐段编码 path>`
  （`:` 保持字面以兼容 Windows 盘符，**不 trim** 以保留 POSIX 合法的首尾空格）。文件预览类型只认领
  `session` 作用域，`absolute` 作用域不会被认领。孤立代理项等非法 UTF-16 会让 `encodeURIComponent`
  抛 `URIError`，函数内 catch 后按「拼不出地址」返回空串，不让异常冒到事件处理器。
- **必须先切回会话**：右侧栏按 Session 挂载，任务面板占主栏时 `ctx.sidebarRight.mounted` 为 `undefined`，
  直接 `openResource` 会抛 `sidebarRight: no session surface is mounted`。
- **失败提示一定可见**：所有可用性探测都在 `selectPanel(null)` **之前**；只有探测全通过才切面板，
  切了面板就一定在 `openResource` 抛错时切回 `PANEL_ID` —— 所以 `setActionNotice` 不会落在已卸载的组件上。
  时序不靠轮询 `mounted` 的宏任务轮数（原先 4 轮 `setTimeout(0)` 已删），座位没就绪就让宿主抛错、如实上报。
- **不绕开产物登记校验**：服务端 `preview` 端点只读「本任务已登记产物」；右侧栏链路是宿主直接读文件、
  不过这道校验，所以 `isRegisteredArtifact(path)` 在前端做等价校验（快照卡片 / 产物库 / 详情抽屉三个
  服务端下发来源的并集），不在台账里的路径一律不预览。
- **宽度/折叠/多 Tab/窄屏全由宿主负责**：首次打开 45% 视口、之后按 Session 记住像素宽度（上限 70%、保底 300px）、
  可拖拽；`<768px` 自动全屏；同路径重复点击是「聚焦 + 闪烁高亮」，不同路径各一个 Tab，可分栏。
- **与 present 一致**：聊天里的交付卡片预览走的是同一条 `ctx.sidebarRight.openResource(fileAddressFor(...))`，
  所以面板打开的产物 Tab 与交付卡片落在同一个右侧栏，路径语义（`reports/` 等绝对路径）不变。
- **依赖是软依赖**：`sidebarRight` 不进客户端 `inject`（写了会变成硬依赖、服务缺失时 `apply` 卡住），
  只用 `serviceOf('sidebarRight')` 现取；`package.json` 的 `dsh.client.inject` 那两条只是加载顺序的预取提示。
- **回退保留**：`preview` 端点、`togglePreview`、`previewBlock` 都还在，但只有产物库那一行能就地渲染它
  （`previewInSidebar(..., true)`）；卡片与抽屉只给提示，不假装成功。

## 7. 回复底部关联任务 chip（官方 turnTail 槽位）

协调者每轮回复的底部（动作行**之上**）挂一行关联任务 chip：状态图标 + 任务标题，点一下就打开面板并定位到该任务。
它显示的是「这一轮回复之后，我这几个任务在干什么」，因此不是面板的镜像，也不进会话头。

### 7.1 挂载点与槽位契约

- **槽位**：`conversation.chat.turnTail`（`kind:'list'`、`scope:'session'`）。宿主 `TurnTailNodeView` 的渲染顺序是
  `renderSlot('conversation.chat.turnTail', { turn, seq, openFile })` → `MessageIconActions`（复制/分支/时钟），
  所以 chip 天然落在动作行上方、聊天内容下方，**不碰时钟右侧、不做 DOM 注入**。
- **注册点**：`client/src/client.js:252` 起（`id: CHIP_ID`、`order: 20` —— 用本项目自己的 id 追加一条，
  同 id 复注册才是替换，不会顶掉宿主的其它条目）。
- **标准 props**：`sessionId` 与 `useChat` 由槽位作用域自带（`ScopeStandardProps<'session'>`），
  组件不自己造 hook；`inject` 只给三样：`openTask` / `openPanel` / `chips`（共享数据源）与 `hooks:{ mainView }`。

### 7.2 关联规则（可解释、可断言）

| 规则 | 内容 | 判据 |
| --- | --- | --- |
| R1 会话绑定 | 只收 `coordinatorSession === 当前 sessionId` 的任务（服务端 `src/host-route.js:51` 随快照下发） | 子会话 / 别的协调者一个都收不到 |
| R2 轮次 | 只挂在**最新一轮**已完成回复的尾部（`isLatestTurn`：`snapshot.timeline.turnOrder` 末位 === `turn`） | 历史回复不带 chip |
| R3 入选 | 活跃状态（`waiting_dep`/`pending`/`running`/`waiting_user`/`waiting_auth`/`delivered`）全收；终态只在 `lastEventAt` 落在最近 30 分钟内时收 | 「刚跑完」看得见，昨天的旧任务不翻旧账 |
| R4 排序截断 | `lastEventAt ↓` → `updatedAt ↓` → `id ↑`，取前 2 个出 chip，其余折成「+N」 | 顺序确定，不受快照数组顺序影响 |

**空状态 = 不渲染整行**：没关联、快照没到、非主会话、历史轮次都返回 `null`（不占位、不出骨架、不报错）。

> 「等前置」是活跃，不是取消：`waiting_dep` 走 `waiting`（虚线静圈），不会画成 `cancelled`（一横）。

### 7.3 状态图标

台账 10 个状态压成 6 个视觉态（`client/src/constants.js` 的 `CHIP_STATE_OF` / `CHIP_STATE_VIEW`）：

| 视觉态 | 台账状态 | 图标 | 动效 | 语义色 |
| --- | --- | --- | --- | --- |
| `running` | `running` | 留缺口的圆环 | 自转 1s 线性无限（`orch-taskchip-spin`） | `info`（business） |
| `waiting` | `pending`、`waiting_dep` | 虚线圆（`stroke-dasharray:3 2.4`） | 无（不跟运行中抢动效） | `muted` |
| `confirming` | `waiting_user`、`waiting_auth`、`delivered` | 虚线圆 | 半色 `opacity .72` + 脉冲 1.6s | `warn` |
| `done` | `done` | ✓ | 无 | `good` |
| `failed` | `failed`、`orphaned`、`missing` | ✗ | 无 | `bad` |
| `cancelled` | `cancelled` | 一横 | 无 | `muted` |

颜色全部走 `TONE_COLOR` 的 `--dsw-alias-*` token（内联 `style.color`），不写死色值；
`prefers-reduced-motion: reduce` 下停转、停脉冲，但保留形状与颜色（信息不丢）——宿主那份 reduced-motion
规则只作用于 `.orch-shell` 内，chip 在会话流里，必须自带一份（`client/src/styles.css` 的 `@media` 块）。

### 7.4 交互

- **点击 chip**：`openTask(id)` → 记一条一次性 focus 请求 → `ctx.layout.selectPanel(PANEL_ID)`；面板挂载时
  `focus.take()` 取走 id 并直接开该任务详情抽屉（`views.js` 的 `openDetail`）。取走即清空，之后用户自己开面板
  不会被上一次的残留弹窗打扰。
- **点击「+N」**：只打开面板（不定位到某一单 —— 没被展示的那几单没有「就该是它」的理由）。
- **悬浮**：`title` 与 `aria-label` 同为「任务名｜状态」，标题被截断时仍能看到全名与状态。
- **长标题**：先按码点截 24 字（emoji 不被切半，`chipVisibleTitle`），再由 CSS `text-overflow: ellipsis` 按像素兜底；
  chip 自身 `max-width: 260px`，不撑破动作行。

### 7.5 订阅与性能

- **单实例 feed**（`client/src/feed.js`）：一个 `createTaskFeed` 由 `apply` 创建、经 `inject` 下发给槽位；
  一条历史会话里有 N 个 turn-tail 组件，但只有「主会话 + 最新一轮」那一行会订阅，不会 N 份轮询。
- **只在有订阅者时轮询**：首个订阅者立即拉一次，之后自排程 `setTimeout`（不用 `setInterval`）；最后一个订阅者
  退订立刻清表；插件卸载（`ctx.effect`）兜底 `stop()`，热替换不会留下野定时器。
- **节奏自适应**：有活跃任务 3s，全是终态 15s，请求失败退避 30s 且保留上一份快照（chip 不闪没）。
- **快照身份稳定**：响应先剪成 chip 要用的 6 个字段并算签名，内容没变就复用上一份对象 —— `useSyncExternalStore`
  式的比较不会因为「同内容新对象」白重渲染。签名里还带一位「终态任务是否仍在 30 分钟窗口内」，任务跨过这条线时
  签名变一次、发一次通知，chip 自己消失，不必等台账再动一下；活跃任务恒为在窗口内，不会按时钟反复触发。
- **不订阅就没有请求**：切到子会话 / 滚动到历史回复时那一行不渲染，也就没有任何轮询。

## 8. 验证

```bash
pnpm test           # 880 条：含 U2 布局/token/交互/纯函数/样式表自检/首帧渲染、确认交付/删除门控、
                    # 入口按钮视觉、fileAddressOf 与右侧栏预览（含回退）、P8 计划模式、两段式终态用例、
                    # 回复底部 chip（关联规则/状态映射/空状态/点击回调/订阅时序/feed 退避）
pnpm run check:client
node docs/probes/qa-stage2-slots.mjs dist/client.js   # 槽位/inject 探针（ALLOWED 已含 conversation.chat.turnTail）
node docs/probes/qa-taskchip-dom.mjs dist/client.js   # chip 的 DOM 证据页（产物 dist 在 vm 里真实渲染）
# 截图（Chrome/Edge headless，产物在 workspace/reports/）：
#   chrome --headless=new --window-size=1150,400 --screenshot=taskchip-turn-tail.png \
#          --virtual-time-budget=2500 file:///<repo>/workspace/reports/taskchip-dom.html
```

手工回归（真实宿主里）：

1. 主会话 → 会话头「任务」入口（品牌色方块 + 三横线图标 + 半粗文字）→ 面板出现：顶栏、4 张概览卡、左侧筛选轨、列表（首帧应是骨架）。
2. 点任务卡或「详情」→ 右侧抽屉滑入，遮罩变暗，`.orch-drawer[data-open=true]`；再点遮罩/关闭/按 `Esc` → 滑出。
3. 抽屉里逐个点区块标题 → 折叠/展开有过渡；「最新回复」在子会话结算后出现。
4. 点「停止」→ 出现「确认停止？/ 取消」；确认后按钮变「停止中…」，台账状态变已取消。
5. 进行中任务没有「删除」（也没有「追加」）；等它 done/failed/cancelled 后刷新，出现「删除」→ 点一下变「确认删除？/ 取消」，确认后卡片消失（消息/通知级联清理，详情抽屉自动收起）。
6. 切「产物」筛选 → 产物库按项目分组，可切「按日期」、点「预览」→ **主栏切回会话、右侧栏滑出文件 Tab**；
   任务卡展开区与抽屉「产物」区块点路径同样在右侧栏打开；复制路径照旧。
7. 切宿主深浅色主题 → 面板颜色跟随，无硬编码残留。
8. 断网/宿主动作失败 → 出现带「重试」的错误条，而不是空白。
9. 让协调者派 2 个任务后回一轮话 → 回复底部动作行**上方**出现 chip 行（运行中圆环在转、等前置虚线静圈）；
   点 chip → 任务面板打开并直接弹出该任务详情；悬浮看「任务名｜状态」；滚动到历史回复 → 那一轮没有 chip。

## 9. 边界

- **样式靠注入**：产物是 classic script，不能 `import` CSS；`styles.css` 构建期以 `?inline` 内联成
  `STYLE_TEXT`，`ensureStyles()` 按 `#dsh-orchestrator-styles` 去重注入；注入失败只丢样式，面板逻辑仍可用（`styles.js`）。
- **单测不跑真 React**：`test/client.test.js` 用 React 垫片只渲染一帧（结构 + 骨架态）；
  有数据/抽屉/产物视图的渲染由一次性探针（白盒预置 hook 槽位）验证过，未进仓库。
- **图标内联 SVG**：跟随 `currentColor`，随 token 变色；不使用平台 icon sprite（避免跨包私有符号）。
- **窄屏**：面板本身在主区域，宽度由宿主决定；≤640px 抽屉铺满，筛选轨改横向滚动。
