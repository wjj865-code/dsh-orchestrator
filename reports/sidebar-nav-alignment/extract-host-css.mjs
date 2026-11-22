/**
 * 从**已安装的 DSH** 里抽出侧栏对齐量测所需的真实 CSS（不把宿主 CSS 入库）。
 *
 * 为什么需要它：插件在 `sidebar.panellist` 槽位里只提供「图标」这一格，行的几何、`.panelGlyph`
 * 的布局、字号与行高全部由宿主侧栏包决定。要复现真机数字，必须用宿主那一份 CSS，而不是凭印象写。
 *
 * 用法（在仓库根目录）：
 *   node reports/sidebar-nav-alignment/extract-host-css.mjs [app.asar 路径] [输出目录]
 * 默认读 `C:\Users\72489\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，
 * 输出到本脚本所在目录（harness.html 就地从这里读 css）。
 *
 * 抽三样：
 *   1. 设计平台 token（`--dsw-*` / `--dsh-*`）与 base 变量 → 颜色、圆角、字体栈；
 *   2. 宿主侧栏的 CSS Module（`SidebarRoot.module.css`）→ `.panelRow` / `.panelGlyph` / `.panelTitle` 等；
 *   3. 本插件自己的样式表（`client/src/styles.css`）→ 我们注入的图标规则。
 * `:global(...)` 是 CSS Module 语法，浏览器不认，按括号配对剥成裸选择器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const asarPath = process.argv[2]
  ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const outDir = process.argv[3] ?? here

// asar = 8 字节前导 + header pickle（内嵌 JSON 目录树）+ 顺序排列的文件数据。
const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(8)
fs.readSync(fd, head, 0, 8, 0)
const headerPickleSize = head.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerPickleSize)
fs.readSync(fd, headerBuf, 0, headerPickleSize, 8)
const jsonLen = headerBuf.readUInt32LE(4)
const tree = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen))
const baseOffset = 8 + headerPickleSize

const readEntry = target => {
  let node = tree
  for (const part of target.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) throw new Error(`asar 里没有 ${target}`)
  }
  const buf = Buffer.alloc(node.size)
  fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset))
  return buf.toString('utf8')
}

const stripGlobal = css => {
  let result = ''
  let i = 0
  while (i < css.length) {
    const at = css.indexOf(':global(', i)
    if (at === -1) { result += css.slice(i); break }
    result += css.slice(i, at)
    let depth = 0
    let j = at + ':global('.length
    for (; j < css.length; j++) {
      if (css[j] === '(') depth += 1
      else if (css[j] === ')') { if (depth === 0) break; depth -= 1 }
    }
    result += css.slice(at + ':global('.length, j)
    i = j + 1
  }
  return result
}

const sidebarPkg = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar'
fs.writeFileSync(
  path.join(outDir, 'design-platform.css'),
  readEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'),
)
fs.writeFileSync(
  path.join(outDir, 'base.css'),
  readEntry('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'),
)
fs.writeFileSync(
  path.join(outDir, 'sidebar.css'),
  stripGlobal(readEntry(`${sidebarPkg}/src/client/SidebarRoot.module.css`)),
)
fs.writeFileSync(
  path.join(outDir, 'plugin.css'),
  fs.readFileSync(path.join(here, '../../client/src/styles.css'), 'utf8'),
)
fs.closeSync(fd)
console.log(`宿主 CSS 已抽出到 ${outDir}（asar: ${asarPath}）`)
