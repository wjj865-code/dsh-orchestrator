// 客户端产物体积闸门（P2-5 / S9′ → 工作台 v1 抬到 148 KiB）。
//
// 为什么需要它：面板产物入库、随包发布，体积以前只是「读起来舒服」的约定（126 KB，minify 关着）；
// 一旦没有闸门，随便加个视图就会长回去，而且没人会发现。这里把「面板预算」变成可执行的断言：
// 超了直接说超了多少、怎么回到预算内。
//
// 预算变更（工作台 v1，用户拍板 D1）：95 KiB → **148 KiB**（中间曾定 128 KiB，实测不够，见下）。
// 原因：改版前产物已到 95,402 B（预算 97,280 B，余 1,878 B）；工作台要新增「总览 / 任务组 / 组工作台 /
// 排期 / 自动化」五个视图与常驻只读 dock，而平台只 serve 一个 client.js（`exports["./client"]`），
// **没有代码分割可用**：实测（同版 esbuild 计量 + vite 与 esbuild 旧产物差值校正）JS 约 +37 KiB、
// 内联 CSS 约 +11 KiB，总计 **143–146 KiB**；128 KiB 差 12–16 KiB，而用户明确要求「保留全功能、不削减」，
// 所以定 148 KiB（留约 2–5 KiB 余量）。抬预算不是放开：148 KiB 之下按下面的子预算核算，
// 任何一页超了先删重复渲染/收敛样式，再谈抬。
//
// 子预算（KiB，设计稿 §7.3 修订版 + 阶段 3 复盘页；实施时按此表验收，合计 = 148）：
//   - 改版前已有（面板壳 / 抽屉 / 启动器 / chip / 配置卡片 + 现有样式）   ≤ 93
//   - 工作台壳（一级导航 + 页面路由 + 会话内记忆 + 三态组件补齐）         ≤ 6
//   - 总览页（复用旧列表 / 产物库 + 今日排期 + 自动化摘要卡）             ≤ 5
//   - 任务组页（组卡网格 + 未分组虚拟卡 + 改名 / 归档）                   ≤ 7
//   - 组工作台（状态列板 + 产物格 + 详情抽屉复用）                        ≤ 8
//   - 右侧 dock（只读镜像 + 边界说明；不含输入框）                        ≤ 5
//   - 排期页（月历 + 拖拽 + 待排 tray + 非拖拽弹层）                       ≤ 8
//   - 自动化页（清单 + 授权表单 + 降级）                                  ≤ 6
//   - 复盘页（数字卡 + 失败归因条 + 产物类型 + 组排行；无图表库）          ≤ 3
//   - 工作台样式（相对改版前新增的 CSS）                                  ≤ 7
//   - 合计                                                               ≤ 148
//
// 复盘页（阶段 3）从组工作台 / 排期 / 自动化三页各让 1 KiB（三页复用同一批卡片与行组件，
// 复盘页只加数字卡 + 横向条 + 排行行，没有图表库），**总预算不变**——加页不加预算。
// 加入复盘页后实测 dist/client.js = 148,323 B（144.85 KiB，余 3,229 B）。
//
// 口径：只算 `dist/client.js`（平台按 exports["./client"] 原样 serve 的那个文件）。
// sourcemap 保留（`dist/client.js.map`），不计入预算——它不随页面加载，只服务排障。
//
// 用法：`node scripts/check-client-size.mjs`（超预算退出码 1；产物缺失也退出 1，先 `pnpm run build`）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 预算（字节）：148 KiB。工作台 v1 由用户拍板从 95 KiB 抬上来（128 KiB 实测不够）；再改要先改设计稿 §7.3 与 CHANGELOG。 */
export const CLIENT_SIZE_LIMIT = 148 * 1024

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
