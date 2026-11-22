# 侧栏入口垂直对齐（侧栏「主会话」/「能力包」 vs 官方「插件」/「自动化任务」）

任务 t-9c9b1a09｜分支 `orch/t-9c9b1a09`（基线 `main` 69d0a3e）｜只改我们注入的项，不动官方项。

## 1. 结论（根因）

**不是 flex、字号或行高算错，而是「图标这一格的盒子」选错了形态。**

宿主侧栏（`@deepseek-ai/dsh-client-ui-sidebar` 0.2.2-rc.5）把 `sidebar.panellist` 的注册项
当成本行的**直接图标子元素**塞进 `.panelGlyph`（`display:inline-flex`、`align-items:center`、
本身不带尺寸），并按行状态把边长当 `size` 传给注册项（展开 16 / 收起 18）：

```html
<div class="panelEntry"><button class="panelRow">
  <span class="panelGlyph">{注册项按 size 画的图标}</span>
  <span class="panelTitle wide">主会话</span>
</button></div>
```

官方项在这一格放的是 `size × size` 的内联 SVG（`dsh-client-ui-plugin-manager` 的 `PluginsPanelIcon`、
`dsh-client-ui-schedule` 的 `TaskManagerIcon`），宿主的注释把约定写得很直白：

> The glyph is the row's direct icon child, as on every other panel row: an inline wrapper makes it
> the baseline of a line box inside the row's glyph slot, which lifts it above the label.

我们原来放的是**裸字符** `<span class="orch-launcher-icon">◈</span>`（`font-size:16px; line-height:1`）。
在真实布局引擎里它落成一个 13×16 的**行盒**，于是三处都不跟官方项一致：

1. **盒子不是正方形**：13×16（字符 advance 13px）→ 图标那格比官方项窄 3px，**label 左边界整体左移 3px**
   （55 vs 官方 58，展开态）；
2. **墨迹中线偏低 0.5px**：字符墨迹挂在行盒基线上，不是盒心（`getBBox` 的 SVG 才是盒心）；
3. **收起态边长不跟宿主**：宿主给 `size=18`，字符仍是 16px 字号 → 收起态必官方项小 2px。

行高、上下留白、点击区域自始至终由宿主的 `.panelRow`（`min-height:32px`、`padding:5px`、
`line-height:22px`）决定，我们的注册项碰不到——所以「行高不齐」的观感其实来自上面第 1 条：
label 列被拉开了 3px，图标又矮了 1.4px、低了 0.5px。

## 2. 修复（只改我们注入的两项）

| 文件 | 改动 |
| --- | --- |
| `client/src/ui.js` | 新增两个对称字形 `navMain`（菱形套菱形）、`navPacks`（分栏方块），走既有的 `Icon`（24 单位 viewBox、`stroke:1.8`、`stroke:currentColor`） |
| `client/src/views.js` | `LauncherIcon` 从「裸字符 span」改成 `({ size = 16 }) => <Icon name="navMain" size={size} className="orch-nav-glyph" />` |
| `client/src/capability-packs.js` | `CapabilityPacksIcon` 同样改成 `navPacks` 的 SVG 版本 |
| `client/src/styles.css` | 删掉 `.orch-launcher-icon { font-size:16px; line-height:1 }`，改为 `.orch-nav-glyph { display:block; flex:0 0 auto }`（块级落位、不进基线、不被压扁） |
| `test/client.test.js` | 新增用例「侧栏入口图标：按宿主 size 画 size×size SVG」：组件必须 `({ size = 16 })` + `size={size}`、两个字形在图示表里、`.orch-nav-glyph` 规则在、旧字符规则与旧 class 必须清零、`dist/client.js` 真的带上新字形 |

官方项（「插件」「自动化任务」）的注册、样式、DOM 一行未动；宿主 CSS 未改。

## 3. 量测（before / after）

方法：把宿主**真实 CSS** 从已安装的 `app.asar` 里抽出来（`SidebarRoot.module.css` + 设计平台 token），
按宿主源码的 DOM 结构复刻四行（插件 / 主会话 / 自动化任务 / 能力包），交给无头 Chrome 的布局引擎量
（Blink = 真机同一个引擎；不是手算）。量测项：`getBoundingClientRect`（盒子）、`getBBox`（SVG 墨迹）、
canvas `actualBoundingBox` + 隐形行盒基线（文字墨迹）。原始数据见 `out/*.json`。

展开态（侧栏 260px、宿主 `size=16`、14px 正文字号、DPR=1）——**Δ ≤ 1px 验收**：

| 入口 | 图标 DOM | 图标盒 | 墨迹高 | 墨迹中线−行中线 | 墨迹中线−文字墨迹中线 | label 左边界 |
| --- | --- | --- | --- | --- | --- | --- |
| 插件（官方） | svg | 16×16 | 12.4 | 0 | 0 | 58 |
| 主会话 修复前 | span+字符 | **13×16** | 11 | **+0.5** | **+0.5** | **55** |
| 主会话 修复后 | svg | **16×16** | 12 | **0** | **0** | **58** |
| 能力包 修复前 | span+字符 | **13×16** | 11 | **+0.5** | **+0.5** | **55** |
| 能力包 修复后 | svg | **16×16** | 10.67 | **0** | **0** | **58** |
| 自动化任务（官方） | svg | 16×16 | 12.4 | 0 | 0 | 58 |

收起态（56px rail、宿主 `size=18`、36×36 行、只有图标）：官方 18×18 / 墨迹高 13.95；
修复前我们 13×16（矮 2px、中线 +0.5）；修复后 18×18、中线 0。
行高（点击区）全程 32px（展开）/36px（收起），一行都没变——**点击区域没有缩小**。
全表（含每行原始读数）见 [`measurements-table.md`](measurements-table.md)。

## 4. 截图

真机截图的限制：桌面端 GUI（`http://127.0.0.1:50366`）要 app 自己那枚 token，外部无头浏览器拿到的是
401（不能在容器里用用户凭据绕过），所以这里用「宿主真实 CSS + 真实布局引擎」的隔离复刻出图，
窗口宽 320/620 CSS px、`--force-device-scale-factor=2`（即 2× 缩放）。数字比肉眼更可信：上表是量出来的。

| 图 | 内容 |
| --- | --- |
| [`out/compare-wide.png`](out/compare-wide.png) | 并排对比：左 before 右 after（展开 260px，2×） |
| [`out/wide-before.png`](out/wide-before.png) / [`out/wide-after.png`](out/wide-after.png) | 单张展开态前后 |
| [`out/rail-before.png`](out/rail-before.png) / [`out/rail-after.png`](out/rail-after.png) | 收起态（56px rail，`size=18`）前后 |

## 5. 复现

```bash
# 1) 从已安装 DSH 抽真实 CSS（宿主 CSS 不入库）
node reports/sidebar-nav-alignment/extract-host-css.mjs
# 2) 无头 Chrome 量测 + 出图（CHROME 可指定浏览器路径）
node reports/sidebar-nav-alignment/measure.mjs
node reports/sidebar-nav-alignment/shoot.mjs
# 3) 打印表格
node reports/sidebar-nav-alignment/table.mjs
```

`harness.html` 里 `?variant=before|after`（默认 before）、`?mode=rail`（收起态）、`?chrome=1`（截图用，
隐藏量测块）控制变体；`compare.html` 是并排图。

## 6. 边界与已知限制

- 只改我们注册进 `sidebar.panellist` 的两个图标；官方项、宿主 CSS、行几何、点击区一律未动。
- 「真机」用隔离复刻而不是 GUI 截图（原因见 §4）；官方图标用同规格占位 SVG（16/18、`stroke:1.2`、
  墨迹居中），盒子与墨迹中心口径与真实官方图标一致，所以对齐结论不受图形细节影响。
- 图标图形沿用了原来的 `◈` / `◫` 语义（菱形 / 分栏方块），换成 SVG 后线宽、留白跟官方项同级。
- 客户端体积：`dist/client.js` 162,551 B（预算 163,840 B，余 1,289 B）；本次改动 +102 B。
- 版本号/CHANGELOG 未动（本任务不 bump），发版时随版本一节补记。
