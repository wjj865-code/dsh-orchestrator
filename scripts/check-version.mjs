// 版本口径断言（P0-1）：package.json / README / CHANGELOG 三处版本必须一致，且 CHANGELOG 必须随包发布。
//
// 为什么需要断言：README 曾 4 处停在 `0.19.1`（包已是 `0.20.1`），用户照 README 粘版本会装到旧版；
// `CHANGELOG.md` 在仓库里却不在 `package.json.files`，npm 用户点 README「更多文档」是 404。
// 三处靠人工同步靠不住，发版/CI 各跑一次断言。
//
// 用法：`node scripts/check-version.mjs`（有问题退出码 1）；纯函数 `collectVersionProblems` 供单测用。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?'

/**
 * README 里的版本点位（行号从 1 起）：
 * - 定位行的「当前 `x.y.z`」；
 * - 安装/排障命令里的 `@wjj865-code/dsh-orchestrator@x.y.z`。
 */
export function readmeVersionPoints(readme) {
  const points = []
  const lines = String(readme ?? '').split('\n')
  lines.forEach((text, index) => {
    for (const match of text.matchAll(new RegExp(`当前 \`(${SEMVER})\``, 'g'))) {
      points.push({ kind: 'README 定位行「当前 x.y.z」', version: match[1], line: index + 1 })
    }
    for (const match of text.matchAll(new RegExp(`dsh-orchestrator@(${SEMVER})`, 'g'))) {
      points.push({ kind: 'README 安装/排障命令 @x.y.z', version: match[1], line: index + 1 })
    }
  })
  return points
}

/** CHANGELOG 首条版本标题（`## x.y.z（日期）`）里的版本；没有就返回 undefined。 */
export function changelogHeadVersion(changelog) {
  // 标题里的日期是全角括号且紧贴版本号（`## 0.20.1（2026-11-17）`），所以只取 semver 那一段。
  const match = new RegExp(`^## (${SEMVER})`, 'm').exec(String(changelog ?? ''))
  return match === null ? undefined : match[1]
}

/** 纯函数：返回问题清单（空数组 = 通过）。 */
export function collectVersionProblems({ pkg, readme, changelog } = {}) {
  const problems = []
  const version = String(pkg?.version ?? '')
  if (!new RegExp(`^${SEMVER}$`).test(version)) {
    problems.push(`package.json.version 不是合法版本号：${JSON.stringify(version)}`)
    return problems
  }
  const head = changelogHeadVersion(changelog)
  if (head !== version) {
    problems.push(`CHANGELOG.md 首条版本是 ${JSON.stringify(head)}，与 package.json 的 ${version} 不一致：发版时先补 CHANGELOG`)
  }
  for (const point of readmeVersionPoints(readme)) {
    if (point.version !== version) {
      problems.push(`README.md:${point.line} 的${point.kind}写的是 ${point.version}，应为 ${version}`)
    }
  }
  const files = Array.isArray(pkg?.files) ? pkg.files : []
  if (!files.includes('CHANGELOG.md')) {
    problems.push('package.json.files 没包含 CHANGELOG.md：npm 用户点 README 的「更多文档」会 404')
  }
  return problems
}

async function main() {
  const read = name => readFile(join(ROOT, name), 'utf8')
  const [pkgRaw, readme, changelog] = await Promise.all([
    read('package.json'), read('README.md'), read('CHANGELOG.md'),
  ])
  const pkg = JSON.parse(pkgRaw)
  const problems = collectVersionProblems({ pkg, readme, changelog })
  if (problems.length > 0) {
    console.error(`版本口径不一致（${problems.length} 处）：`)
    for (const problem of problems) console.error(`- ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`版本口径一致：${pkg.version}（README 全部点位 / CHANGELOG 首条 / package.json.files 已核对）`)
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('check-version.mjs')) await main()
