// 客户端产物体积闸门（P2-5 / S9′）：`dist/client.js` ≤ 95 KiB。
//
// 为什么需要它：面板产物入库、随包发布，体积以前只是「读起来舒服」的约定（126 KB，minify 关着）；
// 一旦没有闸门，随便加个视图就会长回去，而且没人会发现。这里把「面板预算」变成可执行的断言：
// 超了直接说超了多少、怎么回到预算内（删重复渲染 / 收敛样式 / CLIENT_MINIFY=0 只用于排查）。
//
// 口径：只算 `dist/client.js`（平台按 exports["./client"] 原样 serve 的那个文件）。
// sourcemap 保留（`dist/client.js.map`），不计入预算——它不随页面加载，只服务排障。
//
// 用法：`node scripts/check-client-size.mjs`（超预算退出码 1；产物缺失也退出 1，先 `pnpm run build`）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 预算（字节）：95 KiB。计划 P2-5 的硬指标，改它要先改计划与 CHANGELOG。 */
export const CLIENT_SIZE_LIMIT = 95 * 1024

/** 人类可读：`75.5 KB (77315 B)`。 */
export const formatSize = bytes => `${(bytes / 1024).toFixed(1)} KB (${bytes} B)`

/** 纯函数：产物字节数 → 问题清单（空数组 = 通过）。 */
export function collectClientSizeProblems({ bytes, limit = CLIENT_SIZE_LIMIT } = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ['dist/client.js 不存在或为空：先跑 `pnpm run build`']
  if (bytes <= limit) return []
  const over = bytes - limit
  return [
    `dist/client.js ${formatSize(bytes)} 超出预算 ${formatSize(limit)}（多 ${formatSize(over)}，约 ${((bytes / limit - 1) * 100).toFixed(0)}%）`,
    '回到预算内的办法：删重复渲染 / 收敛样式 / 确认没把新视图整块复制；CLIENT_MINIFY=0 只用于排查，不要提交那样的产物',
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
