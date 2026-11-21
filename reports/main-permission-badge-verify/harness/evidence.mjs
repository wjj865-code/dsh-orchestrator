import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'C:/Users/72489/AppData/Local/Temp/orch-e2e-artifacts'
const HOME = 'C:/Users/72489/AppData/Local/Temp/orch-e2e-home'
const files = ['phase1-requests.jsonl', 'requests.jsonl']
const requests = []
for (const file of files) {
  const path = join(OUT, 'mock', file)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { requests.push(JSON.parse(line)) } catch {}
  }
}
const policyOf = request => {
  const text = JSON.stringify(request.body)
  const match = /Current DSH file policy: ([a-z-]+)/.exec(text)
  return match?.[1]
}
const toolsOf = request => (Array.isArray(request.body?.tools) ? request.body.tools.map(t => t.name) : [])
const summary = requests.filter(r => Array.isArray(r.body?.tools)).map(r => {
  const tools = toolsOf(r)
  const hasCoordinator = tools.includes('schedule_create') && tools.includes('task_create')
  const kind = hasCoordinator ? 'coordinator' : tools.includes('write') && tools.includes('task_report') ? 'worker' : 'other'
  return {
    at: r.at,
    kind,
    policy: policyOf(r),
    tools,
    hasRead: tools.includes('read'),
    hasWrite: tools.includes('write'),
    hasBash: tools.includes('pwsh') || tools.includes('bash'),
    firstUserText: (() => {
      const msgs = r.body?.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const c = msgs[i]?.content
        if (!Array.isArray(c)) continue
        const text = c.find(b => b.type === 'text')?.text
        if (typeof text === 'string' && text.trim()) return text.slice(0, 120)
      }
      return ''
    })(),
  }
})
writeFileSync(join(OUT, 'tool-table-evidence.json'), JSON.stringify(summary, null, 2) + '\n')

// Plugin audit lines
const logDir = join(HOME, 'state', 'orchestrator', 'logs')
const audit = []
for (const file of readdirSync(logDir)) {
  if (!file.endsWith('.jsonl')) continue
  for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { audit.push(JSON.parse(line)) } catch {}
  }
}
writeFileSync(join(OUT, 'plugin-audit.json'), JSON.stringify(audit, null, 2) + '\n')
const picks = {
  permission: audit.filter(e => /permission/.test(e.event)),
  sandbox: audit.filter(e => /subagent\.(workspace-write|read-only|full-access)/.test(e.event)),
  tasks: audit.filter(e => /^task\.(create|transition|spawn|settle)/.test(e.event)),
}
writeFileSync(join(OUT, 'plugin-audit-picks.json'), JSON.stringify(picks, null, 2) + '\n')
console.log(JSON.stringify({ requests: requests.length, summary: summary.map(s => ({ at: s.at, kind: s.kind, policy: s.policy, tools: s.tools.length, write: s.hasWrite, bash: s.hasBash })), permissionEvents: picks.permission.length, sandboxEvents: picks.sandbox.length }, null, 2))
