#!/usr/bin/env node
// 名单来自 task_detail：只读扫描已登记目录，stdout JSON 用 task_report.workspace_index 回报。
import { scanWorkspaces } from '../src/workspace-index.js'

const entries = JSON.parse(process.argv[2] ?? '[]')
if (!Array.isArray(entries) || entries.some(entry => typeof entry?.id !== 'string' || typeof entry?.path !== 'string')) {
  throw new Error('参数必须是 task_detail 给出的工作区名单 JSON')
}
process.stdout.write(JSON.stringify(await scanWorkspaces(entries)))
