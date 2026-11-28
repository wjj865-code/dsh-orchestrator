// 客户端产物体积闸门（P2-5 / S9′ → 工作台 v1 抬到 148 KiB → 0.32.0 能力包抬到 160 KiB → 0.35.0 抬到 164 KiB → 未发布（原 0.36.3/0.36.4 两轮）抬到 176 KiB → 0.37.0 界面系统重做抬到 200 KiB）。
//
// 为什么需要它：面板产物入库、随包发布，体积以前只是「读起来舒服」的约定（126 KB，minify 关着）；
// 一旦没有闸门，随便加个视图就会长回去，而且没人发现。这里把「面板预算」变成可执行的断言：
// 超了直接说超了多少、怎么回到预算内。
//
// 预算变更（0.35.0「任务引用人类友好展示」，用户拍板）：160 KiB → **164 KiB**。
// 原因：抽屉「最新回复 / 消息」要把正文里的 `tk-xxxxxx` 渲染成任务名 chip（新增纯函数 + RefText
// 组件 + 详情引用索引），没有代码分割，只能加进同一个 client.js；抬 4 KiB 留出余量后仍是紧预算。
//
// 预算变更（未发布·原 0.36.3 首轮「任务链关系图视图」issue #2，用户拍板）：164 KiB → 168 KiB → **172 KiB**。
// 原因：组工作台第三个只读 tab「关系图」= 新纯函数 `dependencyGraph`（DFS 分层 + 重心排序 + 换行）
// + `GraphView`（SVG 边层 + 绝对定位节点层）+ 10 条样式，纯 SVG 手写、不引 d3，同样没有代码分割。
// 实测：重建后 `dist/client.js` = 173,475 B（相对 HEAD 的 167,848 B 增 +5,627 B），168 KiB 预算下超 1,443 B；
// 而 168 KiB 已压不回去——把新增的 10 条样式（939 B）全删光仍有 172,536 B、超 504 B，
// 所以按拍板 168 → **172 KiB（176,128 B）**，实测余 2,653 B（功能一项没砍：幽灵节点/换行/环边红 marker 全保留）。
//
// 预算变更（未发布·原 0.36.4 关系图 v2「分层 + 干道 + 影响面」，用户拍板）：172 KiB → **176 KiB**。
// 原因：这不是换皮，是交互重设计——`dependencyGraph` 增干道（最长链 `mainIds`）+ 新纯函数 `impactOf`
// （上游/下游 BFS 闭包）+ `GraphView` 加 hover/键盘焦点的淡化状态、层带、跨层边绕行、图例、卡片事实行，
// 样式同步改写。用户原话的规矩：**下一轮若再超，优先砍范围，不再抬预算**，所以这是最后一次抬。
// 实测：重建后 `dist/client.js` = 177,298 B（相对首轮的 173,475 B 增 +3,823 B），172 KiB 下超 1,170 B；
// 176 KiB 预算实测余 2,926 B。子预算见下（新增 6 项交互 = 干道/影响面/事实行/层带/绕行/图例 ≈ 3.6 KiB）。
//
// 子预算（未发布·原 0.36.3 首轮，KiB；= 任务链关系图视图，数字为实测回退构建的差值）：
//   - 0.35.0 已有产物（面板 / 工作台 / 配置卡片 / 能力包 / 自动化入口 / 引用 chip）  ≈ 163.9
//   - 关系图（dependencyGraph + GraphView + tab + 幽灵节点派生 = 4,688 B；样式 939 B） ≈ +5.5
//   - 合计                                                                          ≤ 172（实测 169.4）
//
// 预算变更（0.37.0「工作台界面系统重做（五页 + 控件审计 + 二次确认收敛）」，用户拍板）：176 KiB → **200 KiB**。
// 原因：一次系统级重做落在同一个产物里（平台只 serve 一个 client.js，无代码分割）：公共设计系统
// （字阶/间距/圆角/层次/按钮三档四变体 + 九件组件规格 + ConfirmDialog）+ 五页重排 + 看板三档 +
// 关系图色板 + 排期日历 + 复盘数字排。基线 179,149 B，可用增量 25,651 B，按页分配见本表。
// 分配（估算，来源 = 口径补丁 v5 §3 + 逐片实测结算）：公共系统 1,170 / 总览 3,005 / 任务组 3,595 /
// 关系图 1,760 / 排期 3,490 / 自动化 2,440 / 复盘 2,710 = 18,170；余量 7,481 供文案与调试。
// 规矩不变：**不抬预算**，超了就砍范围（先装饰、再次要列、再说明文案、再砍中栏一档）。
//
// 复核（0.33.0）：删表单 + 加创建入口后 dist/client.js 实测见闸门输出；那次是**净减**，不抬预算；
// 再加功能前先按上表核对，超了先复用现有卡片/样式，再谈抬预算。
//
// 复核（0.32.0 实测）：加入能力包面板后 dist/client.js = 163,160 B（159.3 KiB，余 680 B）。
// 再加功能前先按上表核对，超了先复用现有卡片/样式，再谈抬预算。
//
// 口径：只算 `dist/client.js`（平台按 exports["./client"] 原样 serve 的那个文件）。
// sourcemap 保留（`dist/client.js.map`），不计入预算——它不随页面加载，只服务排障。
//
// 用法：`node scripts/check-client-size.mjs`（超预算退出码 1；产物缺失也退出 1，先 `pnpm run build`）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 预算（字节）：200 KiB。0.37.0 界面系统重做由用户拍板从 176 KiB 抬上来（基线 179,149 B + 可用增量 25,651 B）。 */
export const CLIENT_SIZE_LIMIT = 200 * 1024

/** 人类可读：`75.5 KB (77315 B)`。 */
export const formatSize = bytes => `${(bytes / 1024).toFixed(1)} KB (${bytes} B)`

/** 纯函数：产物字节数 → 问题清单（空数组 = 通过）。 */
export function collectClientSizeProblems({ bytes, limit = CLIENT_SIZE_LIMIT } = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ['dist/client.js 不存在或为空：先跑 `pnpm run build`']
  if (bytes <= limit) return []
  const over = bytes - limit
  return [
    `dist/client.js ${formatSize(bytes)} 超出预算 ${formatSize(limit)}（多 ${formatSize(over)}，约 ${((bytes / limit - 1) * 100).toFixed(0)}%）`,
    '回到预算内的办法：对照脚本头部的子预算表，先删重复渲染 / 收敛样式 / 确认没把新视图整块复制；CLIENT_MINIFY=0 只用于排查，不要提交那样的产物',
  ]
}

async function main() {
  const file = join(ROOT, 'dist', 'client.js')
  let bytes = 0
  try {
    bytes = (await readFile(file)).byteLength
  } catch {
    bytes = 0
  }
  const problems = collectClientSizeProblems({ bytes })
  if (problems.length > 0) {
    console.error(`客户端体积闸门未通过（预算 ${formatSize(CLIENT_SIZE_LIMIT)}）：`)
    for (const problem of problems) console.error(`- ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`客户端体积在预算内：${formatSize(bytes)} / 预算 ${formatSize(CLIENT_SIZE_LIMIT)}（余 ${formatSize(CLIENT_SIZE_LIMIT - bytes)}）`)
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('check-client-size.mjs')) await main()
