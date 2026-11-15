# 面板与详情 UI（U2）

任务面板（会话头「☰ 任务」打开的那个 `main` 面板）与详情抽屉的界面规范：
DeepSeek 设计平台风格、三段式布局、右侧抽屉详情、现代化交互。实现全部在 `client.js`，
样式表在运行时注入（客户端插件是经典脚本，不能 `import` CSS）。

- 代码：`client.js`（`STYLE_TEXT` 从第 76 行开始，`ensureStyles` 在 786 行）
- 测试：`test/client.test.js` 的 `U2 …` 用例组
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
| ① 顶部命令栏 | `.orch-shell > .orch-topbar`（标题、主会话状态、搜索、刷新、打开主会话） | `client.js:1514`；样式 `client.js:92` |
| ① 概览卡 | `.orch-metrics`（进行中/待你决定/已完成/失败，点击即切筛选） | `client.js:1544`；样式 `client.js:226` |
| ② 筛选轨 | `.orch-body > .orch-rail`（7 个筛选项，带计数徽标） | `client.js:1557`；样式 `client.js:278` |
| ② 列表区 | `.orch-main`（提示条 + 任务卡 / 产物库） | `client.js:1576`、`client.js:1612`、`client.js:1754`、`client.js:1804`；样式 `client.js:362` |
| ③ 右侧抽屉 | `.orch-layer > .orch-scrim + .orch-drawer`（常驻挂载，`data-open` 驱动滑入） | `client.js:2060`、`client.js:2097`；样式 `client.js:512`、`client.js:521` |

要点：

- 抽屉**常驻挂载**，只切 `data-open`：关闭时 `transform: translateX(102%)` 滑出，不是直接卸载（否则没有动画）。
- 遮罩 `.orch-scrim` 用 `--dsw-alias-bg-mask-1`，点击遮罩、点关闭按钮、按 `Esc` 都关抽屉（`client.js:1343` 的 `drawerOpen` 副作用）。
- 窄屏（≤860px）筛选轨变横向条、指标两列；≤640px 抽屉铺满（`client.js:756`）。

## 2. 设计 token 落地（--dsw-*）

颜色/圆角/阴影/动效一律取宿主 `@deepseek-ai/dsh-client-ui-theme` 的 token（`design-platform.css`、
`base.css`、`gradient-shadow-text.css`），**不写死颜色**；深浅色由宿主把 alias token 绑到
`body[data-ds-dark-theme]` 上，面板只读 token，因此两套主题自动适配。每一处 `var()` 都带一个兜底值，
只在宿主换主题/token 缺失时才会用到。

| 用途 | token | 代码 |
| --- | --- | --- |
| 画布底色 | `--dsw-alias-bg-base` | `client.js:84` |
| 顶栏/抽屉头尾底色 | `--dsw-alias-bg-layer-1` | `client.js:99` |
| 卡片/抽屉/输入聚焦面 | `--dsw-alias-bg-layer-2` | `client.js:260` |
| 卡片底色 / hover | `--dsw-alias-card-fill` / `-hover` | `client.js:241`、`client.js:253` |
| 正文三档文字 | `--dsw-alias-label-primary/secondary/tertiary` | `client.js:85`、`client.js:166`、`client.js:119` |
| 描边三档 | `--dsw-alias-border-l1/l2/l3` | `client.js:98`、`client.js:133`、`client.js:143` |
| 选中描边（打开中的卡/指标） | `--dsw-alias-border-selected` | `client.js:143`、`client.js:259` |
| 悬停/按下交互层 | `--dsw-alias-interactive-bg-hover` / `-active` | `client.js:178`、`client.js:181` |
| 危险悬停 | `--dsw-alias-interactive-bg-hover-danger` | `client.js:199` |
| 主按钮 | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-inverted` | `client.js:189` |
| 圆角阶 | `--dsw-radius-xs/sm/md/lg` | `client.js:412`、`client.js:109`、`client.js:240`、`client.js:750` |
| 悬浮阴影 / 抽屉高度 | `--dsw-shadow-lv1` / `--dsw-elevation-prominent` | `client.js:255`、`client.js:533` |
| 骨架底色 | `--dsw-alias-bg-skeleton` | `client.js:489` |
| 遮罩 | `--dsw-alias-bg-mask-1` | `client.js:515` |
| 焦点环 | `--dsw-focus-ring-color` | `client.js:144` |
| 代码/预览底色 | `--dsw-alias-markdown-code-block` | `client.js:655` |
| 用户消息气泡 | `--dsw-specific-bubble` | `client.js:671` |
| 状态语义色 | `--dsw-alias-state-success/error/warn/business-primary` | `client.js:53`（`TONE_COLOR`）、`client.js:123` |
| 动效曲线/时长 | `--ds-ease-in-out`、`--ds-transition-duration(-fast/-slow)` | `client.js:138` |

> 顺带修掉一个旧 bug：U2 之前 `client.js` 用的是 `--dsw-alias-color-success` 这类变量，
> 宿主 token 表里**并不存在**（一直走 fallback，深色主题下颜色发脏）。现在统一成
> `--dsw-alias-state-*` / `--dsw-alias-label-*` 语义 token，测试里有 `doesNotMatch` 守着。

## 3. 交互

| 交互 | 实现 |
| --- | --- |
| hover | `.orch-card:hover`（底色 + 描边 + `--dsw-shadow-lv1`）、`.orch-btn:hover`、`.orch-metric:hover`（上浮 1px）、`.orch-rail-item:hover`、`.orch-section-head:hover`、`.orch-artifact:hover`（`client.js:177`、`client.js:252`、`client.js:376`、`client.js:612`） |
| 动画/过渡 | 抽屉滑入滑出（`transform` + `--ds-transition-duration-slow`）、展开/折叠 `grid-template-rows: 0fr→1fr`（`client.js:616`）、chevron 旋转、内容入场 `@keyframes orch-slide-in`（`client.js:538`）、骨架 `@keyframes orch-shimmer`（`client.js:496`）、按钮 `transform: scale(.985)` 按下反馈 |
| 二次确认 | 「停止」先变成「确认停止？/ 取消」内联确认条（`.orch-confirm`，`client.js:1464`），不再用 `window.confirm`；动作进行中禁用按钮并显示「停止中…/重派中…」 |
| 空态 | `.orch-empty` 图标 + 标题 + 提示（无任务 / 无匹配 / 无产物 / 无消息 / 无前置 / 无下游 / 没有 brief / 没有返回消息），`client.js:463` |
| 加载态 | 首帧 5 张骨架卡（`SkeletonList`，`client.js:857`）、产物库 3 张、抽屉骨架；刷新按钮转圈（`.orch-spin`）；抽屉内预览加载占位 |
| 错误态 | 快照错误「台账暂不可用：…」+ 重试；动作错误带错误码（`失败（CODE）：…`）；产物加载失败 + 重试；抽屉详情失败 + 「重新加载」；预览失败 |
| 折叠 | 抽屉每个区块标题都是 `<button>`，`aria-expanded` + `0fr↔1fr` 过渡（`client.js:1858`） |
| 搜索 | 顶栏搜索框按标题/编号/目录过滤（`matchesQuery`，`client.js:895`） |
| 键盘/无障碍 | `Esc` 关抽屉、`aria-expanded`/`aria-pressed`/`aria-hidden`/`aria-label`、`:focus-visible` 焦点环 |
| 减少动效 | `@media (prefers-reduced-motion: reduce)` 关掉全部动画/过渡（`client.js:775`） |

## 4. 详情抽屉内容（保留 A3/A4/B1/G1）

抽屉自上而下：头部（标题 + 状态徽标 + 关闭）、概要信息、7 个可折叠区块、底部动作条。

| 区块 | 内容 | 来源 |
| --- | --- | --- |
| 概览 | 编号/状态/目标目录/分组/优先级/写域/创建/更新 | `detail.task` |
| 最新回复（B1） | 子会话最后一条 assistant 消息：内联给正文，大文件给摘要 + 报告文件路径 | `detail.task.lastMessage`（`src/panel-actions.js` 新增回传） |
| Brief | 目标、验收标准、约束、背景资料、用户原话（结构化列表，不再是纯文本块） | `detail.task.brief` |
| 目标状态（G1） | 平台 goal 的 objective/阶段/续轮/轮次/修订，只读、无写操作 | `detail.task.goalState` |
| 消息 | 最近 20 条；followup 标「待发/已投递/投递失败」 | `detail.messages` |
| 依赖 | 上游前置 + 下游依赖，各带状态与错误 | `detail.dependencies` / `detail.dependents` |
| 产物 | 路径/标签/存在性 + 复制路径 | `detail.task.artifacts` |

底部动作条：停止（二次确认）、重派、追加消息、打开子会话。

## 5. 验证

```bash
npm test            # 602 条：含 U2 布局/token/交互/纯函数/样式表自检/首帧渲染用例
npm run check:client
```

手工回归（真实宿主里）：

1. 主会话 → 会话头「☰ 任务」→ 面板出现：顶栏、4 张概览卡、左侧筛选轨、列表（首帧应是骨架）。
2. 点任务卡或「详情」→ 右侧抽屉滑入，遮罩变暗，`.orch-drawer[data-open=true]`；再点遮罩/关闭/按 `Esc` → 滑出。
3. 抽屉里逐个点区块标题 → 折叠/展开有过渡；「最新回复」在子会话结算后出现。
4. 点「停止」→ 出现「确认停止？/ 取消」；确认后按钮变「停止中…」，台账状态变已取消。
5. 切「产物」筛选 → 产物库按项目分组，可切「按日期」、点「预览」看文本（>64 KiB 标注截断）、复制路径。
6. 切宿主深浅色主题 → 面板颜色跟随，无硬编码残留。
7. 断网/宿主动作失败 → 出现带「重试」的错误条，而不是空白。

## 6. 边界

- **样式靠注入**：客户端插件不能 `import` CSS，`ensureStyles()` 按 `#dsh-orchestrator-styles` 去重注入；
  注入失败只丢样式，面板逻辑仍可用（`client.js:786`）。
- **单测不跑真 React**：`test/client.test.js` 用 React 垫片只渲染一帧（结构 + 骨架态）；
  有数据/抽屉/产物视图的渲染由一次性探针（白盒预置 hook 槽位）验证过，未进仓库。
- **图标内联 SVG**：跟随 `currentColor`，随 token 变色；不使用平台 icon sprite（避免跨包私有符号）。
- **窄屏**：面板本身在主区域，宽度由宿主决定；≤640px 抽屉铺满，筛选轨改横向滚动。
