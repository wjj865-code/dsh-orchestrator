/**
 * 量测侧栏对齐：把 `harness.html` 交给无头 Chrome（真实布局引擎 = 真机同一份 Blink）跑一遍，
 * 从 --dump-dom 里取回量测 JSON。
 *
 * 前置：`node extract-host-css.mjs`（抽宿主真实 CSS 到本目录）。
 * 用法：`node measure.mjs`（Chrome 路径可用环境变量 CHROME 覆盖）。
 * 产出：out/wide-before.json / wide-after.json / rail-before.json / rail-after.json。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
const base = pathToFileURL(path.join(here, 'harness.html')).href

const cases = [
  { name: 'wide-before', query: '?variant=before' },
  { name: 'wide-after', query: '?variant=after' },
  { name: 'rail-before', query: '?variant=before&mode=rail' },
  { name: 'rail-after', query: '?variant=after&mode=rail' },
]

for (const item of cases) {
  const dom = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--user-data-dir=${path.join(here, 'out', 'chrome-profile')}`,
    '--virtual-time-budget=3000', '--window-size=900,420', '--dump-dom', base + item.query,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  fs.writeFileSync(path.join(out, `${item.name}.html`), dom)
  const start = dom.indexOf('<pre id="out">')
  const end = dom.indexOf('</pre>', start)
  if (start < 0 || end < 0) throw new Error(`no measurement block for ${item.name}`)
  const json = dom.slice(start + 14, end)
    .replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  JSON.parse(json) // 先校验，再落盘
  fs.writeFileSync(path.join(out, `${item.name}.json`), json)
  console.log('measured', item.name)
}
