// 客户端产物体积闸门（P2-5 / S9′ → 工作台 v1 抬到 148 KiB → 0.32.0 能力包抬到 160 KiB）。
//
// 为什么需要它：面板产物入库、随包发布，体积以前只是「读起来舒服」的约定（126 KB，minify 关着）；
// 一旦没有闸门，随便加个视图就会长回去，而且没人会发现。这里把「面板预算」变成可执行的断言：
// 超了直接说超了多少、怎么回到预算内。
//
// 预算变更（0.32.0 能力包，用户拍板）：148 KiB → **160 KiB**。
// 原因：能力包面板（独立 main panel + 侧栏入口 + 安装确认卡 + 环境变量卡 + 增量样式）没有代码分割，
// 只能加进同一个 client.js；子预算见下表，合计 = 160。
//
// 子预算（0.33.0，KiB；0.33.0 = 自动化创建入口对齐官方「会话创建」）：
//   - 0.32.0 已有产物（面板 / 工作台 / 配置卡片 / 能力包）                 ≤ 160
//   - 自动化创建入口（单按钮 + 主会话预填 + 官方页跳转 + 会话头角色判定）  ≈ +1（由下面两行抵掉）
//   - 删除自定义自动化表单（绑定对象/触发方式/星期/标题/做什么/授权勾选）  ≈ −3.3
//   - 合计                                                               ≤ 160（实测有净余量）
//
// 复核（0.33.0）：删表单 + 加创建入口后 dist/client.js 实测见闸门输出；本次改动是**净减**，
// 不抬预算；再加功能前先按上表核对，超了先复用现有卡片/样式，再谈抬预算。
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

/** 预算（字节）：160 KiB。0.32.0 由用户拍板从 148 KiB 抬上来（能力包面板子预算见文件头）。 */
export const CLIENT_SIZE_LIMIT = 160 * 1024

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
