// Collect and normalize the 0.26.0 e2e evidence into evidence/*.json for the report.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'C:/Users/72489/AppData/Local/Temp/orch-e2e-026'
const ART = `${BASE}/artifacts`
const HOME = `${BASE}/home`
const OUT = process.env.REPORT_OUT ?? 'C:/Users/72489/Documents/dsh-orchestrator/reports/skill-and-readonly-tools-verify'
mkdirSync(`${OUT}/evidence`, { recursive: true })
mkdirSync(`${OUT}/screenshots`, { recursive: true })

const readJsonl = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const summary = readJsonl(`${ART}/mock/summary.jsonl`)
const decisions = readJsonl(`${ART}/mock/decisions.jsonl`)
const requests = readJsonl(`${ART}/mock/requests.jsonl`)
const drive = JSON.parse(readFileSync(`${ART}/drive-results.json`, 'utf8'))
const stepOf = name => drive.steps.find(entry => entry.name === name)
const write = (name, value) => writeFileSync(`${OUT}/evidence/${name}`, JSON.stringify(value, null, 2) + '\n', 'utf8')

const workerRequests = requests.filter(request => request.kind === 'worker')
const coordinatorRequests = requests.filter(request => request.kind === 'coordinator')
const toolResultsOf = (request, { kind, scn } = {}) => {
  const out = []
  for (const message of request.body?.messages ?? []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== 'tool_result') continue
      out.push(Array.isArray(block.content) ? block.content.map(item => item?.text ?? '').join('\n') : String(block.content ?? ''))
    }
  }
  return out
}
const workerOf = scn => workerRequests.filter(request => request.scn === scn)
const reportRequest = (scn, summaryTextPart) => {
  // The request whose body carries the task_report tool_use with that summary is the one that decided it.
  const hit = workerRequests.filter(request => request.scn === scn).find(request => JSON.stringify(request.body).includes(summaryTextPart))
  return hit?.at ?? null
}
const nextWorkerAt = (scn, afterAt) => workerRequests.filter(request => request.scn === scn && String(request.at) > String(afterAt)).map(request => request.at)[0] ?? null
const notificationAt = needle => summary.filter(item => item.kind === 'coordinator' && String(item.trigger).includes(needle)).map(item => item.at)[0] ?? null

// —— tool tables + catalogs ——
const firstCoordinator = summary.find(item => item.kind === 'coordinator' && item.trigger.includes('CHECK_TOOLS'))
const afterSwitch = summary.find(item => item.kind === 'coordinator' && item.trigger.includes('AFTER_SWITCH'))
const readonlyWorker = summary.find(item => item.kind === 'worker' && item.scn === 'readonly-deny')
write('tool-tables.json', {
  coordinatorBeforeSwitch: { at: firstCoordinator?.at, tools: firstCoordinator?.toolNames, catalogSkills: firstCoordinator?.catalogSkills, catalogHasGrillMe: firstCoordinator?.catalogHasGrillMe },
  coordinatorAfterSwitch: { at: afterSwitch?.at, tools: afterSwitch?.toolNames },
  identicalAfterSwitch: JSON.stringify(firstCoordinator?.toolNames) === JSON.stringify(afterSwitch?.toolNames),
  worker: { at: readonlyWorker?.at, tools: readonlyWorker?.toolNames, catalogSkills: readonlyWorker?.catalogSkills, catalogHasGrillMe: readonlyWorker?.catalogHasGrillMe },
  coordinatorHasWriteTools: (firstCoordinator?.toolNames ?? []).filter(name => ['write', 'edit', 'pwsh', 'bash', 'apply_patch'].includes(name)),
  coordinatorHasReadTools: (firstCoordinator?.toolNames ?? []).filter(name => ['read', 'glob', 'grep', 'skill'].includes(name)),
  coordinatorDeniedTaskTools: (firstCoordinator?.toolNames ?? []).filter(name => ['task_report', 'task_detail', 'plan_save'].includes(name)),
})

// —— read tool evidence ——
const readTexts = coordinatorRequests.flatMap(request => request.trigger.includes('READ_TESTS') ? toolResultsOf(request) : [])
write('read-and-skill.json', {
  artifactRead: readTexts.find(text => text.includes('artifact-from-target-main'))?.slice(0, 500) ?? null,
  skillFileRead: readTexts.find(text => text.includes('name: grill-me'))?.slice(0, 700) ?? null,
  skillLoaded: readTexts.find(text => text.includes('<skill_content name="grill-me">'))?.slice(0, 900) ?? null,
})

// —— read-only denials ——
const roTexts = workerOf('readonly-deny').flatMap(request => toolResultsOf(request))
write('readonly-denials.json', {
  skillDenial: roTexts.find(text => /is unknown or no longer available/i.test(text)) ?? null,
  writeDenial: roTexts.find(text => text.includes('sandbox: file access denied')) ?? null,
  readonlyTargetFileExists: existsSync(`${BASE}/targets/target-ro/ro-blocked.txt`),
  workerCatalogSkills: readonlyWorker?.catalogSkills ?? [],
  workerCatalogHasGrillMe: readonlyWorker?.catalogHasGrillMe === true,
})

// —— normal task ——
write('normal-task.json', {
  targetFile: `${BASE}/targets/target-normal/worker-ok.txt`,
  exists: existsSync(`${BASE}/targets/target-normal/worker-ok.txt`),
  content: existsSync(`${BASE}/targets/target-normal/worker-ok.txt`) ? readFileSync(`${BASE}/targets/target-normal/worker-ok.txt`, 'utf8') : null,
})

// —— progress notifications + timings ——
const db = new DatabaseSync(`${HOME}/state/orchestrator/tasks.sqlite`, { readOnly: true })
const notificationRows = db.prepare('SELECT rowid AS id, task_id, level, status, reason, created_at, delivered_at, merged_into FROM notifications ORDER BY rowid').all()
const taskRows = db.prepare('SELECT id, title, status, read_only, access FROM tasks ORDER BY created_at').all()
const progressNotifications = summary.filter(item => item.kind === 'coordinator' && String(item.trigger).includes('E2E 进度通知') && /有新进展|需要你|已交付|可能卡住/.test(String(item.trigger)))
const progressDecisions = decisions.filter(item => item.scn === 'progress' && item.decision?.status === 'progress')
const progressRequests = workerOf('progress')
const p1Decision = progressDecisions.find(item => String(item.decision.summary).includes('进度 1/2'))
const p2Decision = progressDecisions.find(item => String(item.decision.summary).includes('进度 2/2'))
const answeredDecision = progressDecisions.find(item => String(item.decision.summary).includes('追问答复'))
const p1ResultAt = nextWorkerAt('progress', p1Decision?.at)
const p2ResultAt = nextWorkerAt('progress', p2Decision?.at)
const answeredResultAt = nextWorkerAt('progress', answeredDecision?.at)
const ms = (a, b) => (a && b) ? Date.parse(a) - Date.parse(b) : null
write('progress.json', {
  notifications: progressNotifications.map(item => ({ at: item.at, trigger: item.trigger })),
  decisions: progressDecisions.map(item => ({ at: item.at, summary: item.decision.summary })),
  timings: {
    p1DeliveredAt: notificationAt('进度 1/2'),
    p1ReportRequestAt: p1Decision?.at ?? null,
    p1ToolResultAt: p1ResultAt,
    p1LatencyMsFromToolResult: ms(notificationAt('进度 1/2'), p1ResultAt),
    p2DeliveredAt: notificationAt('进度 2/2'),
    p2ReportRequestAt: p2Decision?.at ?? null,
    p2ToolResultAt: p2ResultAt,
    p2LatencyMsFromToolResult: ms(notificationAt('进度 2/2'), p2ResultAt),
    answeredDeliveredAt: notificationAt('回答你的追问'),
    answeredReportRequestAt: answeredDecision?.at ?? null,
    answeredToolResultAt: answeredResultAt,
    answeredLatencyMsFromToolResult: ms(notificationAt('回答你的追问'), answeredResultAt),
  },
  notificationRows: notificationRows.map(row => ({ ...row })),
  tasks: taskRows.map(row => ({ ...row })),
})

// —— status grading ——
const grading = []
for (const [scn, needle, kindNeedle] of [['done', 'E2E done 分级', '已交付待确认'], ['blocked', 'E2E blocked 分级', '需要你'], ['needs-auth', 'E2E needs_auth 分级', '需要你']]) {
  const decision = decisions.find(item => item.scn === scn && item.decision?.status !== null && item.decision?.status !== undefined)
  const resultAt = decision ? nextWorkerAt(scn, decision.at) : null
  const notifyAt = notificationAt(needle) && summary.find(item => item.kind === 'coordinator' && String(item.trigger).includes(needle) && String(item.trigger).includes(kindNeedle))?.at
  grading.push({ scn, reportAt: decision?.at ?? null, reportStatus: decision?.decision?.status ?? null, toolResultAt: resultAt, notificationAt: notifyAt ?? null, latencyMsFromToolResult: ms(notifyAt, resultAt) })
}
write('status-grading.json', { items: grading })

// —— full-access sandbox control ——
write('full-access.json', {
  outsidePath: `${BASE}/outside-full/out.txt`,
  exists: existsSync(`${BASE}/outside-full/out.txt`),
  content: existsSync(`${BASE}/outside-full/out.txt`) ? readFileSync(`${BASE}/outside-full/out.txt`, 'utf8') : null,
})

// —— plugin audit log ——
const auditDir = `${HOME}/state/orchestrator/logs`
const audit = readdirSync(auditDir).filter(file => file.endsWith('.jsonl')).flatMap(file => readJsonl(join(auditDir, file)))
write('plugin-audit-picks.json', {
  permission: audit.filter(item => /permission/.test(item.event)),
  sandbox: audit.filter(item => /^subagent\.(read-only|workspace-write|full-access|writable-root)$/.test(item.event)),
  reports: audit.filter(item => item.event === 'task.report'),
  notify: audit.filter(item => /^notify\./.test(item.event)),
  transitions: audit.filter(item => item.event === 'task.transition'),
})

// —— session logs: permission / sandbox / approval events per session ——
const sessionDirs = []
const walk = dir => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name))
    else if (entry.name === 'session.v4.jsonl.zstd') sessionDirs.push(join(dir, entry.name))
  }
}
walk(`${HOME}/sessions`)
const decodeZstd = path => {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) starts.push(index)
  }
  const chunks = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try { chunks.push(zstdDecompressSync(buffer.subarray(starts[index], end))) } catch {}
  }
  return Buffer.concat(chunks).toString('utf8')
}
const sessions = []
for (const file of sessionDirs) {
  const lines = decodeZstd(file).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const events = []
  let cwd = null
  let preset = null
  let label = null
  let sessionId = null
  for (const event of lines) {
    if (event.type === 'session') {
      sessionId = event.id ?? event.data?.id ?? null
      cwd = event.data?.cwd ?? cwd
    }
    if (event.type === 'working-directory/change') cwd = event.data?.cwd ?? cwd
    if (event.type === 'agent-preset/selected') preset = event.data?.agentPreset ?? preset
    if (event.type === 'subagent/descriptor') label = event.data?.label ?? label
    if (['permission/preset', 'sandbox/mode', 'approval/policy', 'agent-preset/selected', 'working-directory/change'].includes(event.type)) {
      events.push({ type: event.type, seq: event.seq, data: event.data })
    }
  }
  sessions.push({ file, sessionId, label, preset, cwd, events })
}
write('session-events.json', sessions.map(session => ({
  sessionId: session.sessionId,
  label: session.label,
  preset: session.preset,
  cwd: session.cwd,
  sandboxEvents: session.events.filter(event => event.type === 'sandbox/mode'),
  permissionEvents: session.events.filter(event => event.type === 'permission/preset' || event.type === 'approval/policy'),
  events: session.events,
})))
write('session-events-flat.json', sessions.flatMap(session => session.events.map(event => ({ sessionId: session.sessionId, preset: session.preset, cwd: session.cwd, ...event }))))

// —— copy screenshots + drive results ——
for (const file of readdirSync(ART)) {
  if (file.endsWith('.png')) copyFileSync(`${ART}/${file}`, `${OUT}/screenshots/${file}`)
}
writeFileSync(`${OUT}/evidence/drive-results.json`, JSON.stringify(drive, null, 2) + '\n', 'utf8')

console.log(JSON.stringify({
  coordinatorTools: firstCoordinator?.toolNames?.length,
  identicalAfterSwitch: JSON.stringify(firstCoordinator?.toolNames) === JSON.stringify(afterSwitch?.toolNames),
  sessions: sessions.length,
  notifications: notificationRows.length,
  progress: progressNotifications.length,
  statusGrading: grading,
}, null, 2))
