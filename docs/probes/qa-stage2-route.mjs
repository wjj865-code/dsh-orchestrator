#!/usr/bin/env node
/**
 * QA 阶段 2 L2：host 只读路由 `/api/orchestrator` 独立探针
 *
 * 用法: node docs/probes/qa-stage2-route.mjs
 * 退出码: 0 全 PASS；1 有 FAIL
 *
 * 做法：临时 DSH_HOME 起真台账（node:sqlite 真库），种任务/消息/通知/设置，
 * 用真 `createHostRoute` 处理假 Request，对「四表行数+时间戳+设置内容+目录文件」做前后指纹。
 * 401/403/重复注册属平台 connection.admit/registerFetchRoute 行为，这里只断言注册形态并引用平台源码行号。
 */
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => import(new URL(`../../src/${name}`, import.meta.url))
const { openLedger, createTask, markQueued, addMessage, addNotification, setSetting } = await src('ledger.js')
const { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } = await src('host-route.js')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 种台账 ----------
const dir = mkdtempSync(join(tmpdir(), 'qa-orch-route-'))
const db = await openLedger(dir)
const NOW = Date.now()
const mk = (title, status, sessionId = null) => {
  const task = createTask(db, { brief: { title, goal: `goal of ${title}` }, coordinatorSession: 'session-qa' })
  db.prepare('UPDATE tasks SET status = ?, session_id = ?, updated_at = ? WHERE id = ?').run(status, sessionId, NOW, task.id)
  return task.id
}
const running = mk('进行中的任务', 'running', 'child-1')
const queued = mk('排队中的任务', 'pending')
markQueued(db, queued)
const done = mk('已完成任务', 'done', 'child-3')
const stale = mk('两小时没动静的待派发', 'pending')
db.prepare('UPDATE tasks SET last_event_at = ? WHERE id = ?').run(NOW - 2 * 60 * 60 * 1000, stale)
db.prepare('UPDATE tasks SET target_dir = ? WHERE id = ?').run('C:/work/project', done)
db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?').run(JSON.stringify([
  { path: 'C:/work/project/out.txt', label: '结果文件', exists: true },
  { path: 'C:/work/project/missing.txt', exists: false },
]), done)
addMessage(db, running, { kind: 'brief', rendered: '派发文本' })
addNotification(db, { taskId: running, level: 'info' })
setSetting(db, 'coordinator_session_id', 'session-qa')

// ---------- 指纹 ----------
const tableFingerprint = () => ({
  tasks: db.prepare('SELECT count(*) AS n, coalesce(sum(updated_at), 0) AS s, max(updated_at) AS m FROM tasks').get(),
  messages: db.prepare('SELECT count(*) AS n, max(at) AS m FROM messages').get(),
  notifications: db.prepare('SELECT count(*) AS n, max(created_at) AS m FROM notifications').get(),
  settings: db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all(),
})
const fileFingerprint = () => readdirSync(dir).sort().map((name) => {
  const stat = statSync(join(dir, name))
  return `${name}:${stat.size}:${Math.round(stat.mtimeMs)}`
})

const before = tableFingerprint()
const filesBefore = fileFingerprint()

// ---------- 假 Request ----------
const route = createHostRoute({
  db,
  coordinatorStatus: () => ({ id: 'session-qa', live: true }),
  staleMinutes: 30,
  now: () => NOW,
})
const request = (body) => ({ json: async () => body })
const call = async (body) => {
  const response = await route(request(body))
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  return { status: response.status, headers: response.headers, text, body: parsed }
}

// ---------- 1. snapshot 正常路径 ----------
const ok = await call({ endpoint: 'snapshot' })
check('snapshot 返回 200', ok.status === 200, String(ok.status))
check('content-type 是 application/json', /application\/json/.test(ok.headers.get('content-type') ?? ''), ok.headers.get('content-type'))
check('body.ok === true', ok.body?.ok === true, JSON.stringify(ok.body?.ok))
check('mainSession 带 id/live', eq(ok.body?.mainSession, { id: 'session-qa', live: true }), JSON.stringify(ok.body?.mainSession))
check('tasks 是数组且含全部 4 个', Array.isArray(ok.body?.tasks) && ok.body.tasks.length === 4, `len=${ok.body?.tasks?.length}`)
const taskById = (id) => ok.body.tasks.find((t) => t.id === id)
check('任务字段齐全', ['id', 'title', 'status', 'label', 'tone', 'childSessionId', 'targetDir', 'queued', 'stale', 'updatedAt', 'lastEventAt', 'error']
  .every((k) => Object.hasOwn(taskById(done), k)), JSON.stringify(Object.keys(taskById(done))))
check('不返回 brief/goal 原文', !Object.hasOwn(taskById(done), 'goal') && !Object.hasOwn(taskById(done), 'brief'))
check('running 任务 childSessionId 正确', taskById(running).childSessionId === 'child-1', String(taskById(running).childSessionId))
check('没有 target 的任务 targetDir 为 null', taskById(running).targetDir === null, String(taskById(running).targetDir))
check('带 target 的任务 targetDir 透出', taskById(done).targetDir === 'C:/work/project', String(taskById(done).targetDir))
check('snapshot.tasks[].artifacts 形状', Array.isArray(taskById(done).artifacts) && taskById(done).artifacts.length === 2
  && taskById(done).artifacts[0].path === 'C:/work/project/out.txt' && taskById(done).artifacts[0].label === '结果文件'
  && taskById(done).artifacts[0].exists === true && taskById(done).artifacts[1].exists === false, JSON.stringify(taskById(done).artifacts))
check('无产物任务 artifacts 按空数组', Array.isArray(taskById(running).artifacts) && taskById(running).artifacts.length === 0)
check('pending 且无子会话 → queued=true', taskById(queued).queued === true)
check('running → queued=false', taskById(running).queued === false)
check('新建未排队的 pending → queued=false（queued_at 精确判定）', taskById(stale).queued === false)
check('2 小时没动静 → stale=true', taskById(stale).stale === true)
check('已完成任务 stale=false', taskById(done).stale === false)
check('label/tone 是字符串', typeof taskById(done).label === 'string' && typeof taskById(done).tone === 'string',
  `${taskById(done).label}/${taskById(done).tone}`)

// ---------- 2. 端点白名单与坏 body ----------
for (const [name, body] of [
  ['未知端点 tasks', { endpoint: 'tasks' }],
  ['写类端点 create', { endpoint: 'create' }],
  ['空 body', {}],
  ['无 endpoint 字符串', { endpoint: 42 }],
  ['缺少 body（json 抛错）', undefined],
]) {
  const result = body === undefined
    ? await (async () => { const r = await route({ json: async () => { throw new Error('bad json') } }); return { status: r.status, body: await r.json() } })()
    : await call(body)
  check(`${name} → 400 unknown-endpoint`, result.status === 400 && result.body?.error === 'unknown-endpoint',
    `${result.status} ${JSON.stringify(result.body)}`)
  check(`${name} 不泄漏绝对路径`, !JSON.stringify(result.body).includes(dir), JSON.stringify(result.body))
}

// ---------- 3. payload 被忽略、不改状态 ----------
const withPayload = await call({ endpoint: 'snapshot', payload: { status: 'cancelled', taskId: running, tasks: [] } })
check('带 payload 的 snapshot 仍 200 且按台账返回', withPayload.status === 200 && withPayload.body.tasks.length === 4)
check('payload 里的 tasks 未覆盖真实数据', withPayload.body.tasks.some((t) => t.id === running))

// ---------- 3b. open-main 动作端点（写主会话是设计行为，不是只读端点） ----------
const openCalls = []
const openRoute = createHostRoute({
  db,
  coordinatorStatus: () => ({ id: 'session-qa', live: true }),
  openMain: async () => { openCalls.push(1); return { ok: true, sessionId: 'session-main', created: true } },
  now: () => NOW,
})
const opened = await (await openRoute(request({ endpoint: 'open-main' }))).json()
check('open-main 成功 200 + sessionId', opened.ok === true && opened.sessionId === 'session-main' && opened.created === true, JSON.stringify(opened))
check('open-main 只调 openMain 一次', openCalls.length === 1, `实际 ${openCalls.length}`)
const failBody = await (await createHostRoute({
  db, coordinatorStatus: () => ({ id: 'session-qa', live: true }), now: () => NOW,
  openMain: async () => ({ ok: false, error: 'boom' }),
})(request({ endpoint: 'open-main' }))).json()
check('open-main 失败 → 500 + 可读 error', failBody.ok === false && failBody.error === 'boom', JSON.stringify(failBody))
const unavailableResponse = await createHostRoute({ db, coordinatorStatus: () => ({ id: 'session-qa', live: true }), now: () => NOW })(request({ endpoint: 'open-main' }))
const unavailableBody = await unavailableResponse.json()
check('无 openMain → 500 open-main-unavailable', unavailableResponse.status === 500 && unavailableBody.error === 'open-main-unavailable', `${unavailableResponse.status} ${JSON.stringify(unavailableBody)}`)

// ---------- 4. 反复调用零写入 ----------
let errors = 0
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await call(i % 2 === 0 ? { endpoint: 'snapshot' } : { endpoint: `bogus-${i}` })
    if (!(r.status === 200 || r.status === 400)) errors += 1
  } catch (error) {
    errors += 1
    console.log(`  调用 ${i} 抛异常：${error.message}`)
  }
}
check('100 次调用无异常且状态码合法', errors === 0, `异常 ${errors}`)
check('调用后四表行数/时间戳/设置完全不变', eq(tableFingerprint(), before),
  `before=${JSON.stringify(before)} after=${JSON.stringify(tableFingerprint())}`)
check('调用后目录文件集合与 mtime 不变', eq(fileFingerprint(), filesBefore),
  `before=${JSON.stringify(filesBefore)} after=${JSON.stringify(fileFingerprint())}`)

// ---------- 4b. 快照截断语义：活跃全量 + 历史 LIMIT ----------
const dir2 = mkdtempSync(join(tmpdir(), 'qa-orch-limit-'))
const db2 = await openLedger(dir2)
const oldRunning = createTask(db2, { brief: { title: '老的活跃任务', goal: 'g' }, coordinatorSession: 'session-qa' })
db2.prepare("UPDATE tasks SET status = 'running', session_id = 'child-old', created_at = ?, updated_at = ? WHERE id = ?")
  .run(NOW - 3000, NOW - 3000, oldRunning.id)
for (let i = 1; i <= 3; i += 1) {
  const doneTask = createTask(db2, { brief: { title: `新完成${i}`, goal: 'g' }, coordinatorSession: 'session-qa' })
  db2.prepare("UPDATE tasks SET status = 'done', session_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
    .run(`child-done-${i}`, NOW - 3000 + i * 1000, NOW - 3000 + i * 1000, doneTask.id)
}
const limited = createHostRoute({ db: db2, coordinatorStatus: () => ({ id: 'session-qa', live: true }), limit: 2 })
const limitedBody = await (await limited(request({ endpoint: 'snapshot' }))).json()
const limitedIds = limitedBody.tasks.map((t) => t.id)
check('小 limit 下活跃任务不被截掉', limitedIds.includes(oldRunning.id), `返回 ${limitedIds.length} 条`)
check('小 limit 下历史只返回 limit 条', limitedBody.tasks.filter((t) => t.status === 'done').length === 2,
  limitedBody.tasks.map((t) => `${t.title}:${t.status}`).join(' | '))
check('活跃任务排在历史之前', limitedBody.tasks[0]?.id === oldRunning.id, limitedBody.tasks[0]?.title)
check('历史按 created_at 倒序（最新在前）', limitedBody.tasks.slice(1).every((t, i, arr) => i === 0 || arr[i - 1].lastEventAt >= t.lastEventAt),
  limitedBody.tasks.slice(1).map((t) => t.title).join(' > '))
const onlyActive = createHostRoute({ db: db2, coordinatorStatus: () => ({ id: 'session-qa', live: true }), limit: 0 })
const onlyActiveBody = await (await onlyActive(request({ endpoint: 'snapshot' }))).json()
check('limit=0 只返回活跃任务', onlyActiveBody.tasks.length === 1 && onlyActiveBody.tasks[0].id === oldRunning.id,
  `len=${onlyActiveBody.tasks.length}`)
db2.close()
try { rmSync(dir2, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

// ---------- 5. 注册形态（平台契约） ----------
check("HOST_ROUTE === '/api/orchestrator'", HOST_ROUTE === '/api/orchestrator', HOST_ROUTE)
check('注册选项 = POST + buffered body', eq(HOST_ROUTE_OPTIONS, { path: '/api/orchestrator', methods: ['POST'], requestBody: 'buffered' }),
  JSON.stringify(HOST_ROUTE_OPTIONS))
const platformPath = process.env.QA_CONNECTION_SRC ?? join(here, '..', '..', '..', '..', 'review', 'client-connection-index.js')
let platform = ''
try { platform = readFileSync(platformPath, 'utf8') } catch { platform = '' }
if (platform === '') {
  console.log('WARN 未找到平台 connection 源码，跳过平台契约断言（设 QA_CONNECTION_SRC 指向 client-connection-index.js）')
} else {
  check('平台 admit：跨站 → 403', /if \(!this\.isTrusted\(request\)\) return \{ rejection: 403 \}/.test(platform))
  check('平台 admit：无凭据 → 401', /return record === void 0 \? \{ rejection: 401 \}/.test(platform))
  check('平台 exact 路由：非 owner → 403', /peer\.principal\.kind !== "owner"\) return Promise\.resolve\(new Response\("forbidden", \{ status: 403 \}\)/.test(platform))
  check('平台 exact 路由：重复 path 抛错', /is already registered/.test(platform))
}
const fakeRoutes = new Map()
const fakeRegister = (spec) => {
  if (fakeRoutes.has(spec.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(spec.path)} is already registered`)
  fakeRoutes.set(spec.path, spec)
  return () => fakeRoutes.delete(spec.path)
}
fakeRegister(HOST_ROUTE_OPTIONS)
check('同 path 二次注册会抛（与平台一致）', (() => {
  try { fakeRegister(HOST_ROUTE_OPTIONS); return false } catch (error) { return /already registered/.test(error.message) }
})())

// ---------- 6. 静态：只 import 查询函数 ----------
const source = readFileSync(join(here, '..', '..', 'src', 'host-route.js'), 'utf8')
const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)].map((m) => ({ names: m[1].split(',').map((s) => s.trim()).filter(Boolean), from: m[2] }))
check('只 import 两个模块', imports.length === 2 && imports.every((i) => i.from === './ledger.js' || i.from === './card.js'),
  JSON.stringify(imports.map((i) => i.from)))
const ledgerNames = (imports.find((i) => i.from === './ledger.js')?.names ?? []).sort()
check('ledger 只取查询函数 listTasks/listHistoryTasks',
  eq(ledgerNames, ['listHistoryTasks', 'listTasks']), ledgerNames.join(','))
const ledgerSource = readFileSync(join(here, '..', '..', 'src', 'ledger.js'), 'utf8')
check('listHistoryTasks 用 SQL LIMIT 取历史（不先全量再 slice）',
  /export function listHistoryTasks[\s\S]{0,400}LIMIT \?/.test(ledgerSource))
check('listHistoryTasks 只取终态（NOT IN 活跃态）',
  /NOT IN \('pending','running','waiting_user','waiting_auth'\)/.test(ledgerSource))
const writeNames = ['createTask', 'transition', 'touchTask', 'setTaskError', 'markQueued', 'clearQueued', 'addMessage',
  'addNotification', 'setSetting', 'bindSettingOnce', 'rebindSetting', 'failStalePending', 'incrementAttempts']
check('不 import 任何写函数', writeNames.every((name) => !new RegExp(`\\b${name}\\b`).test(source)), writeNames.filter((n) => new RegExp(`\\b${n}\\b`).test(source)).join(','))

// ---------- 7. 数据库不可用时的行为（最后做，会关库） ----------
db.close()
let rejection
try { await route(request({ endpoint: 'snapshot' })); rejection = null } catch (error) { rejection = error }
check('库关闭后 handler 以 rejection 结束（不吞错）', rejection !== null, rejection?.message)
check('库关闭后错误信息不带绝对路径', rejection !== null && !String(rejection.message).includes(dir), String(rejection?.message))
console.log('NOTE 平台 host-webserver 对 handler rejection 的处理：warn + 400 空体（host-webserver.js:475-483），客户端显示「台账暂不可用：HTTP 400」')

// ---------- 收尾 ----------
for (const name of readdirSync(dir)) { try { rmSync(join(dir, name), { force: true }) } catch { /* 清理失败不影响结论 */ } }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 同上 */ }

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
