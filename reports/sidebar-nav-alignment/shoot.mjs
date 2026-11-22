/**
 * 截图：before / after / 收起态 / 并排对比（DPR=2，窗口 320×320 与 620×360）。
 *
 * 前置：`node extract-host-css.mjs`（抽宿主真实 CSS 到本目录）+ `node measure.mjs`（顺带校验页面能跑）。
 * 用法：`node shoot.mjs`（Chrome 路径可用环境变量 CHROME 覆盖）。
 * 产出：out/wide-before.png / wide-after.png / rail-before.png / rail-after.png / compare-wide.png。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
const base = pathToFileURL(here).href + '/'

const shoots = [
  { name: 'wide-before', url: `${base}harness.html?variant=before&chrome=1`, size: '320,320' },
  { name: 'wide-after', url: `${base}harness.html?variant=after&chrome=1`, size: '320,320' },
  { name: 'rail-before', url: `${base}harness.html?variant=before&mode=rail&chrome=1`, size: '120,320' },
  { name: 'rail-after', url: `${base}harness.html?variant=after&mode=rail&chrome=1`, size: '120,320' },
  { name: 'compare-wide', url: `${base}compare.html`, size: '620,360' },
]

for (const shot of shoots) {
  const png = path.join(out, `${shot.name}.png`)
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--user-data-dir=${path.join(here, 'out', 'chrome-profile')}`,
    '--virtual-time-budget=3000', `--window-size=${shot.size}`,
    `--screenshot=${png}`, shot.url,
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] })
  console.log('shot', shot.name, fs.statSync(png).size)
}
