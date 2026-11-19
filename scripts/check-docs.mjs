// 文档预算与一致性断言（P1-D）。
//
// 为什么需要它：P1 把文档砍掉一半以后，「再加一篇 / 再抄一张表」没有任何阻力，
// 半年后又会回到 3,000 行；README 的配置表与工具表也一直靠人工同步（已经漂移过：
// 漏了 3 个 preferences* 键）。这里把三件事变成 CI 断言：
//   1. README + 顶层 docs/*.md 总行数 ≤ DOC_LINE_BUDGET（超了直接说改哪篇）；
//   2. README 配置表键集合 == loadConfig({}) 键集合；README 工具表 == createTools() 名单；
//   3. package.json.files 里的 docs 都存在，文档内相对链接（含锚点）都可达。
//
// 口径：预算只算 README.md + docs/ 顶层 *.md。docs/superpowers/（历史计划/规格）与
// docs/probes/（探针脚本与说明）是维护档案，不进预算——它们只增不改，收进去等于逼人删证据。
//
// 用法：`node scripts/check-docs.mjs`（有问题退出码 1）；`pnpm run check:docs`（pretest 会跑）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { createTools } from '../src/tools.js'
// P2-3 交接契约 v1：文档里的字段表 / 事件名必须与代码同源（防止「发布即契约」的字段漂移）。
import { HANDOFF_EVENT, HANDOFF_FIELDS } from '../src/handoff.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 文档总行数预算（P1 批准口径：≤2,250；最终实测远低于它）。 */
export const DOC_LINE_BUDGET = 2250

/** 参与预算的文件：README.md + docs 顶层 *.md（按文件名排序，输出稳定）。 */
export function budgetFiles(root = ROOT) {
  const docs = readdirSync(join(root, 'docs'))
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `docs/${name}`)
  return ['README.md', ...docs]
}

/** 行数口径与 `wc -l` 对齐：末尾无换行也算最后一行。 */
export function lineCount(text) {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** 取某个 `## 标题` 小节正文（到下一个同级或更高级标题为止）。 */
export function sectionOf(markdown, title) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => new RegExp(`^##\\s+${title}\\s*$`).test(line))
  if (start === -1) return ''
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break }
  }
  return lines.slice(start + 1, end).join('\n')
}

/** 取某个 `### 标题` 小节正文（到下一个同级或更高级标题为止）。 */
export function subsectionOf(markdown, title) {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => new RegExp(`^###\\s+${title}\\s*$`).test(line))
  if (start === -1) return ''
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,3}\s+/.test(lines[index])) { end = index; break }
  }
  return lines.slice(start + 1, end).join('\n')
}

/** README 配置表里的键（表格第一列的反引号标识符）。 */
export function readmeConfigKeys(readme) {
  const section = sectionOf(readme, '配置')
  return [...section.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/gm)].map(match => match[1])
}

/** README 工具清单里的工具名（只看「协调者 / 子任务」两张表；后面的迁移映射表是旧名，不算工具面）。 */
export function readmeToolNames(readme) {
  const section = sectionOf(readme, '工具清单').split('\n### ')[0]
  return [...section.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map(match => match[1])
}

export function codeConfigKeys() {
  return Object.keys(loadConfig({}))
}

export function codeToolNames() {
  // 与生产同源：createTools 只需要 config 就能列出 schema（工具执行才用 db/dispatcher）。
  return createTools({ db: {}, config: loadConfig({}) }).map(tool => tool.name)
}

/** GitHub 风格锚点：小写、去标点、空格转连字符（CJK 保留）。 */
export function slugOf(heading) {
  return heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** 文件里所有可用锚点（`## 标题` 的 slug）。 */
export function anchorsOf(markdown) {
  return new Set(markdown.split('\n').filter(line => /^#{1,6}\s+/.test(line)).map(slugOf))
}

/** 收集相对链接（跳过 http(s)/mailto/协议链接与纯代码块外的东西——这里只做粗粒度扫描）。 */
export function relativeLinks(markdown) {
  const links = []
  markdown.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      if (/^(?:https?:|mailto:|tel:|data:|#)/.test(target)) {
        if (target.startsWith('#')) links.push({ target, line: index + 1 })
        continue
      }
      if (/^[a-z]+:/i.test(target)) continue
      links.push({ target, line: index + 1 })
    }
  })
  return links
}

/** 主流程：返回问题清单（空数组 = 通过）。 */
export function collectProblems(root = ROOT) {
  const problems = []
  const read = file => readFileSync(join(root, file), 'utf8')

  // —— 1. 行数预算 ——
  const files = budgetFiles(root)
  const counts = files.map(file => ({ file, lines: lineCount(read(file)) }))
  const total = counts.reduce((sum, item) => sum + item.lines, 0)
  if (total > DOC_LINE_BUDGET) {
    const over = total - DOC_LINE_BUDGET
    const heaviest = [...counts].sort((a, b) => b.lines - a.lines).slice(0, 4)
      .map(item => `${item.file}（${item.lines} 行）`).join('、')
    problems.push(
      `文档总行数 ${total} 超过预算 ${DOC_LINE_BUDGET}（多 ${over} 行）——先删/并重复内容，别抬预算；`
      + `最大的几篇：${heaviest}`,
    )
  }

  // —— 2. README 配置表 / 工具表与代码一致 ——
  const readme = read('README.md')
  const tableKeys = readmeConfigKeys(readme)
  const configKeys = codeConfigKeys()
  const missingConfig = configKeys.filter(key => !tableKeys.includes(key))
  const extraConfig = tableKeys.filter(key => !configKeys.includes(key))
  if (missingConfig.length > 0) {
    problems.push(`README 配置表缺少 ${missingConfig.length} 个键：${missingConfig.join('、')}（loadConfig({}) 有 ${configKeys.length} 个）`)
  }
  if (extraConfig.length > 0) {
    problems.push(`README 配置表多出 ${extraConfig.length} 个不存在的键：${extraConfig.join('、')}（要么删行，要么加进 src/config.js）`)
  }
  const dupConfig = tableKeys.filter((key, index) => tableKeys.indexOf(key) !== index)
  if (dupConfig.length > 0) problems.push(`README 配置表重复行：${[...new Set(dupConfig)].join('、')}`)

  const tableTools = readmeToolNames(readme)
  const toolNames = codeToolNames()
  const missingTools = toolNames.filter(name => !tableTools.includes(name))
  const extraTools = tableTools.filter(name => !toolNames.includes(name))
  if (missingTools.length > 0) problems.push(`README 工具表缺少：${missingTools.join('、')}（createTools() 有 ${toolNames.length} 个）`)
  if (extraTools.length > 0) problems.push(`README 工具表多出：${extraTools.join('、')}（代码里没有这些工具）`)

  // —— 3. package.json.files 里的 docs 都在 ——
  const pkg = JSON.parse(read('package.json'))
  for (const file of Array.isArray(pkg.files) ? pkg.files : []) {
    if (!file.startsWith('docs/')) continue
    if (file.includes('*')) continue
    if (!existsSync(join(root, file))) problems.push(`package.json.files 指向不存在的文档：${file}（发出去就是 404）`)
  }

  // —— 4. 交接契约 v1 的字段表 / 事件名与代码同源（P2-3） ——
  // 字段名一旦发布就是对外承诺：只允许「代码加字段同时改文档」，不允许文档自己长字段。
  const architecture = read('docs/ARCHITECTURE.md')
  const documentedFields = [...subsectionOf(architecture, '契约字段')
    .matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/gm)].map(match => match[1])
  const missingFields = HANDOFF_FIELDS.filter(name => !documentedFields.includes(name))
  const extraFields = documentedFields.filter(name => !HANDOFF_FIELDS.includes(name))
  if (documentedFields.length === 0) {
    problems.push('docs/ARCHITECTURE.md 缺少「### 契约字段」小节：交接契约 v1 的字段表是唯一真源，不能只写在代码里')
  }
  if (missingFields.length > 0) {
    problems.push(`docs/ARCHITECTURE.md 交接契约字段表缺少：${missingFields.join('、')}（src/handoff.js 的 HANDOFF_FIELDS 有 ${HANDOFF_FIELDS.length} 个）`)
  }
  if (extraFields.length > 0) {
    problems.push(`docs/ARCHITECTURE.md 交接契约字段表多出：${extraFields.join('、')}（代码里没有这些字段）`)
  }
  for (const event of Object.values(HANDOFF_EVENT)) {
    if (!architecture.includes(event)) problems.push(`docs/ARCHITECTURE.md 缺少交接事件名 ${event}（src/handoff.js 的 HANDOFF_EVENT 有它）`)
  }

  // —— 5. 相对链接与锚点可达 ——
  for (const file of files) {
    const text = read(file)
    for (const link of relativeLinks(text)) {
      const [rawPath, ...rest] = link.target.split('#')
      const anchor = rest.join('#')
      const targetFile = rawPath === '' ? file : resolve(dirname(join(root, file)), rawPath)
      if (!existsSync(targetFile)) {
        problems.push(`${file}:${link.line} 链接指向不存在的文件：${link.target}`)
        continue
      }
      if (anchor === '' || !targetFile.endsWith('.md')) continue
      const anchors = anchorsOf(readFileSync(targetFile, 'utf8'))
      if (!anchors.has(anchor)) {
        problems.push(`${file}:${link.line} 锚点在目标文档里不存在：${link.target}（检查标题是否改过）`)
      }
    }
  }

  return { problems, total, counts }
}

function main() {
  const { problems, total, counts } = collectProblems(ROOT)
  const detail = counts.map(item => `${item.file}=${item.lines}`).join('，')
  if (problems.length > 0) {
    console.error(`文档检查未通过（${problems.length} 处）：`)
    for (const problem of problems) console.error(`- ${problem}`)
    console.error(`\n当前行数：${total} / 预算 ${DOC_LINE_BUDGET}｜${detail}`)
    process.exitCode = 1
    return
  }
  console.log(`文档检查通过：总行数 ${total} / 预算 ${DOC_LINE_BUDGET}；配置表 ${codeConfigKeys().length} 键、工具表 ${codeToolNames().length} 个、包内文档与内链均可达。`)
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('check-docs.mjs')) main()
