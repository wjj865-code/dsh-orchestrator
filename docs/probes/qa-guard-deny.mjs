#!/usr/bin/env node
// QA：guard 全名单注入验收（82f96d3）
// 主会话调用 COORDINATOR_DENY 名单内工具 → 可读拒绝；子会话同名 → 放行；白名单工具放行。
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const { openLedger, setMainSessionId } = await import(new URL('../../src/ledger.js', import.meta.url))
const { apply } = await import(new URL('../../index.js', import.meta.url))

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const home = mkdtempSync(join(tmpdir(), 'qa-guard-'))
process.env.DSH_HOME = home
const db = await openLedger(join(home, 'state', 'orchestrator'))
setMainSessionId(db, 'main-1')

let capturedGuard = null
const services = {
  tools: {
    register: () => () => {},
    guard: (fn) => { capturedGuard = fn; return () => {} },
    view: () => ({ restrictableNames: new Set() }),
    restrict: () => () => {},
  },
  agentTeams: {},
  agents: { get: () => undefined },
  systemPrompt: { context: () => () => {} },
  subagents: {},
}
const ctx = {
  ...services,
  get: (name) => services[name],
  effect: (fn) => fn(),
  on: () => {},
  logger: { info: () => {}, warn: () => {} },
}

await apply(ctx, { autoResumeQueue: false })
check('apply 完成并注册了 guard', typeof capturedGuard === 'function')

const source = readFileSync(join(root, 'index.js'), 'utf8')
const block = source.match(/const COORDINATOR_DENY = \[([\s\S]*?)\]/)
const deny = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
check('解析到 COORDINATOR_DENY 名单', deny.length >= 20, `count=${deny.length}`)

const mainExec = (name) => ({ name, agent: { id: 'main-1' } })
const childExec = (name) => ({ name, agent: { id: 'child-1' } })

let denied = 0
for (const name of deny) {
  const reason = capturedGuard(mainExec(name))
  if (typeof reason === 'string' && reason.length > 0) denied += 1
  else console.log(`FAIL 主会话未被拒：${name} — ${JSON.stringify(reason)}`)
}
check('主会话调用名单内每个工具都被拒', denied === deny.length, `${denied}/${deny.length}`)
check('wait_agent 用禁止阻塞文案', /禁止阻塞等待/.test(String(capturedGuard(mainExec('wait_agent')))), String(capturedGuard(mainExec('wait_agent'))).slice(0, 40))
check('其余工具有统一可读文案', /协调者禁止的工具/.test(String(capturedGuard(mainExec('spawn_teammate')))), String(capturedGuard(mainExec('spawn_teammate'))).slice(0, 40))
let childAllowed = 0
for (const name of deny) if (capturedGuard(childExec(name)) === undefined) childAllowed += 1
check('子会话同名工具全部放行', childAllowed === deny.length, `${childAllowed}/${deny.length}`)
for (const allow of ['ask_user_question', 'task_create', 'task_list', 'task_status', 'task_message', 'task_stop']) {
  check(`白名单工具放行：${allow}`, capturedGuard(mainExec(allow)) === undefined, JSON.stringify(capturedGuard(mainExec(allow))))
}
check('非主会话的 task_report 放行', capturedGuard(childExec('task_report')) === undefined)
check('guard 同步返回（不是 Promise）', !(capturedGuard(mainExec('wait_agent')) instanceof Promise))
db.close()
try { rmSync(home, { recursive: true, force: true }) } catch { /* ok */ }
console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
