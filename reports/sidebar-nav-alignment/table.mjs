/**
 * 把 out/*.json 的量测结果压成一张 Markdown 表（reports/sidebar-nav-alignment/measurements.md 的正文）。
 *
 * 用法：`node table.mjs`（先跑 measure.mjs）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'out')
const files = ['wide-before', 'wide-after', 'rail-before', 'rail-after']
const labelOf = {
  plugins: '插件（官方）',
  schedules: '自动化任务（官方）',
  'orchestrator-launcher': '主会话（插件）',
  'capability-packs': '能力包（插件）',
}

const rows = []
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(out, `${file}.json`), 'utf8'))
  for (const row of data.rows) {
    rows.push({
      case: `${data.mode === 'rail' ? '收起 56px' : '展开 260px'} · ${data.variant === 'before' ? '修复前' : '修复后'}`,
      panel: labelOf[row.panel],
      dom: row.icon.tag === 'svg' ? 'svg' : 'span+字符',
      box: `${row.icon.width}×${row.icon.height}`,
      slot: `${row.glyphSlot.width}×${row.glyphSlot.height}`,
      inkHeight: row.iconInk.height,
      deltaRow: row.iconInkVsRowCenter,
      deltaSlot: row.iconInkVsSlotCenter,
      deltaLabel: row.iconInkVsLabelInkCenter ?? '—',
      rowHeight: row.row.height,
      labelLeft: row.labelBox ? row.labelBox.left : '—',
    })
  }
}

const header = '| 场景 | 入口 | 图标 DOM | 图标盒 | glyph 槽盒 | 墨迹高 | 墨迹中线−行中线 | 墨迹中线−槽中线 | 墨迹中线−文字墨迹中线 | 行高（点击区） | label 左边界 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
const body = rows.map(r => `| ${r.case} | ${r.panel} | ${r.dom} | ${r.box} | ${r.slot} | ${r.inkHeight} | ${r.deltaRow} | ${r.deltaSlot} | ${r.deltaLabel} | ${r.rowHeight} | ${r.labelLeft} |`).join('\n')
process.stdout.write(`${header}\n${body}\n`)
