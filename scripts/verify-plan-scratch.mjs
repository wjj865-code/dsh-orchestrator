#!/usr/bin/env node
// 离线验证「计划阶段放开 scratch」（planFirst = workspace-write + 批准前不注册 target 可写根）。
//
// 为什么不是「真的派一个任务」：脚本跑在子会话里，没有 task_create 权限（requireMain 只放主会话），
// 而真实沙箱注入需要宿主进程里活着的 subagents 服务。所以分三段取证：
//   A) 逐字复刻宿主的 roots.ts / profiles.ts 算法，算出「该给哪些可写根、生成什么 SBPL profile」；
//   B) 用 A 算出的 profile 真的跑 /usr/bin/sandbox-exec，验证 $TMPDIR 可写、仓库与私有目录被拒；
//   C) 用桩替代平台服务跑**插件真实代码路径**（createSubagentDispatcher），验证「模式」与「授权」正交：
//      计划阶段 append workspace-write 但 registrations 为空，批准后才注册 target。
//
// 用法：node scripts/verify-plan-scratch.mjs [--repo <path>]
//   默认 repo = 本仓库根；退出码 0 = 全部通过，1 = 有 FAIL。
import { existsSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createSubagentDispatcher } from '../src/dispatch.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const argRepo = process.argv.indexOf('--repo')
const REPO = (argRepo > 0 && process.argv[argRepo + 1] !== undefined ? process.argv[argRepo + 1] : ROOT).replace(/\/$/, '')
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const TOUCH = '/usr/bin/touch'

const results = []
const pass = (name, detail) => results.push({ name, ok: true, detail })
const fail = (name, detail) => results.push({ name, ok: false, detail })
const skip = (name, detail) => results.push({ name, ok: true, skipped: true, detail })
const line = title => console.log(`\n=== ${title} ===`)

// ── A. 宿主算法复刻（dsh-sandbox/src/roots.ts:62-106 + dsh-sandbox-local/src/profiles.ts:53-60）──
// 复刻而非调用：宿主包在 asar 里、且这里要的是「独立算一遍再和真实执行面对照」。
const canonicalPath = path => {
  try {
    return realpathSync.native(path) // roots.ts:68（/tmp 在 darwin 上是 /private/tmp）
  } catch {
    return path // roots.ts:71：解析失败按原样（缺的根匹配不到任何东西，是保守方向）
  }
}
const workspaceWritableRoots = policy => {
  if (policy.mode !== 'workspace-write') return [] // roots.ts:88 —— read-only 一律空
  return [...new Set([canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(canonicalPath)])]
}
const writableRoots = policy => {
  if (policy.mode !== 'workspace-write') return [] // roots.ts:104
  return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])] // roots.ts:105
}
const sbplString = path => `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
const sbplProfile = policy => {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  return forms.join(' ')
}

// 计划阶段的真实形态：mode=workspace-write、workspaceRoot=指挥舱、**没有** target 可写根。
const COCKPIT = join(homedir(), '.dsh', 'state', 'orchestrator', 'workspace')
const planPolicy = { mode: 'workspace-write', workspaceRoot: COCKPIT, additionalWritableRoots: [] }
const approvedPolicy = { ...planPolicy, additionalWritableRoots: [REPO] }

line('A. profile 算法（复刻宿主 roots.ts / profiles.ts）')
{
  const roots = writableRoots(planPolicy)
  const profile = sbplProfile(planPolicy)
  const hasTmp = roots.includes(canonicalPath('/tmp'))
  const hasTmpdir = roots.includes(canonicalPath(tmpdir()))
  const hasRepo = roots.some(root => canonicalPath(REPO).startsWith(root))
  const ok = hasTmp && hasTmpdir && hasRepo === false && profile.includes('(subpath')
  const detail = `roots=${roots.length}｜/tmp=${hasTmp}｜$TMPDIR=${hasTmpdir}｜repo=${hasRepo}`
  ok ? pass('A2 计划阶段（workspace-write，无额外根）', detail) : fail('A2 计划阶段（workspace-write，无额外根）', detail)
  console.log(`  A2 ${ok ? 'PASS' : 'FAIL'} ${detail}`)
}
{
  const roots = writableRoots(approvedPolicy)
  const hasRepo = roots.includes(canonicalPath(REPO))
  const detail = `roots=${roots.length}｜repo=${hasRepo}`
  hasRepo ? pass('A3 批准后（登记 target 可写根）', detail) : fail('A3 批准后（登记 target 可写根）', detail)
  console.log(`  A3 ${hasRepo ? 'PASS' : 'FAIL'} ${detail}`)
}
{
  // 方案①不可行的固化证据：read-only 下额外的可写根一条都进不了 profile。
  const readOnlyPolicy = { mode: 'read-only', workspaceRoot: COCKPIT, additionalWritableRoots: [join(tmpdir(), 'scratch')] }
  const roots = writableRoots(readOnlyPolicy)
  const profile = sbplProfile(readOnlyPolicy)
  const ok = roots.length === 0 && profile === '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))'
  const detail = `writableRoots=${roots.length}｜profile 只含 /dev/null=${profile.includes('(subpath') === false}`
  ok ? pass('A1 read-only + 额外根（证明宿主 mode 门禁）', detail) : fail('A1 read-only + 额外根（证明宿主 mode 门禁）', detail)
  console.log(`  A1 ${ok ? 'PASS' : 'FAIL'} ${detail}`)
}

// ── B. 真实写入（只有 macOS + sandbox-exec 存在时才跑）──
line('B. 真实写入（macOS Seatbelt）')
const probeOf = (dir, name = '__plan_scratch_probe') => join(dir, name)
/** 在给定 profile 下尝试创建文件；返回 {ok, stderr}。 */
const tryTouch = (profile, target) => {
  const run = spawnSync(SANDBOX_EXEC, ['-p', profile, '--', TOUCH, target], { encoding: 'utf8' })
  return { ok: run.status === 0, stderr: (run.stderr ?? '').trim() }
}
/** 允许写的目标：必须成功，跑完自己清理。 */
const expectWritable = (name, dir) => {
  const target = probeOf(dir)
  const { ok, stderr } = tryTouch(sbplProfile(planPolicy), target)
  try { if (existsSync(target)) unlinkSync(target) } catch { /* 清理失败不影响判定 */ }
  ok ? pass(name, '写入成功') : fail(name, `写入被拒（期望成功）：${stderr}`)
  console.log(`  ${name} ${ok ? 'PASS' : 'FAIL'} ${ok ? '写入成功' : stderr}`)
}
/** 必须被拒的目标：失败才算通过；万一成功立刻删掉并判 FAIL（绝不把探针留在仓库/私有目录）。 */
const expectDenied = (name, dir) => {
  if (!existsSync(dir)) {
    skip(name, `目录不存在，跳过：${dir}`)
    console.log(`  ${name} SKIP 目录不存在：${dir}`)
    return
  }
  const target = probeOf(dir)
  const { ok, stderr } = tryTouch(sbplProfile(planPolicy), target)
  if (ok) {
    try { unlinkSync(target) } catch { /* 尽力清理 */ }
    fail(name, `意外写入成功（沙箱泄漏！已删除探针）：${target}`)
    console.log(`  ${name} FAIL 意外写入成功，已删除探针：${target}`)
    return
  }
  const denied = /Operation not permitted/i.test(stderr)
  denied ? pass(name, 'Operation not permitted') : fail(name, `被拒但不是 EPERM（口径可疑）：${stderr}`)
  console.log(`  ${name} ${denied ? 'PASS' : 'FAIL'} ${stderr}`)
}

if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
  skip('B 段全部', `非 darwin 或没有 ${SANDBOX_EXEC}：本段只在 macOS 实测`)
  console.log(`  SKIP 非 darwin 或没有 ${SANDBOX_EXEC}`)
} else {
  // 先探一次「本进程能不能起 sandbox-exec」：脚本若被跑在**已沙箱化**的会话里（例如 DSH 子会话），
  // 宿主会拒掉嵌套 sandbox_apply —— 那样所有目标都会以同一个理由失败，B 段整体不可判定，
  // 必须显式 SKIP 而不是把「全被拒」当成通过（否则 B3-B7 会假绿）。
  const canary = join(tmpdir(), '__plan_scratch_canary')
  const probe = tryTouch(sbplProfile(planPolicy), canary)
  try { if (existsSync(canary)) unlinkSync(canary) } catch { /* 清理失败不影响判定 */ }
  if (/sandbox_apply/i.test(probe.stderr)) {
    skip('B 段全部', '当前进程已在沙箱内（嵌套 sandbox-exec 被拒：sandbox_apply）；请在未沙箱化的终端重跑本脚本')
    console.log('  SKIP 当前进程已在沙箱内（嵌套 sandbox-exec 被拒），B 段不可判定；请在不带沙箱的终端重跑')
  } else {
    expectWritable('B1 $TMPDIR 探针', tmpdir())
    expectWritable('B2 /tmp 探针', '/tmp')
    expectDenied('B3 仓库写入', REPO)
    expectDenied('B4 ~/.dsh/profiles', join(homedir(), '.dsh', 'profiles'))
    expectDenied('B5 artifact-store', join(homedir(), '.dsh', 'state', 'orchestrator', 'artifact-store'))
    expectDenied('B6 sessions', join(homedir(), '.dsh', 'sessions'))
    expectDenied('B7 台账目录（.dsh/state/orchestrator）', join(homedir(), '.dsh', 'state', 'orchestrator'))
  }
}

// ── C. 插件真实代码路径（桩平台服务）：模式 vs 授权 ──
line('C. dispatcher 桩（模式与授权正交）')
{
  const appends = []
  const sessionsById = new Map()
  const registrations = []
  const parentAgent = { id: 'a-parent', session: { id: 's-parent', header: { cwd: COCKPIT } } }
  const subagents = {
    async startActivation(spec) {
      const session = {
        id: spec.childId,
        // 复刻宿主缺陷（dispatch.js:525-527）：子会话 header.cwd 恒为**父会话** cwd，spec.cwd 只写一条
        // working-directory 事件 —— 所以 target 永远不是 workspace root，批准后必须靠注册可写根。
        header: { cwd: COCKPIT },
        append(event, payload) { appends.push([spec.childId, event, payload]) },
      }
      sessionsById.set(spec.childId, session)
      return { childId: spec.childId, messageId: 'm1', result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
    },
    async sendMessage() { return 'msg' },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  // 平台折叠规则：本会话日志里最后一条 sandbox/mode 就是该会话的有效模式。
  const modeOf = id => [...appends].reverse().find(([childId, event]) => childId === id && event === 'sandbox/mode')?.[2]?.mode
  const sandboxPolicy = {
    overrideOf: session => modeOf(session.id),
    registerWritableRoot(session, dir) { registrations.push([session.id, dir]); return () => {} },
  }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent: parentAgent,
    agents: () => ({ get: id => (sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined) }),
    sessions: () => ({ get: id => sessionsById.get(id) }),
    sandboxPolicy: () => sandboxPolicy,
  })

  const planMember = await dispatcher.spawn({ prompt: 'p', cwd: REPO, planFirst: true })
  const planMode = modeOf(planMember.id)
  const okPlan = planMode === 'workspace-write' && registrations.length === 0
  okPlan ? pass('C1 planFirst spawn', `mode=${planMode}｜registrations=0`) : fail('C1 planFirst spawn', `mode=${planMode}｜registrations=${registrations.length}`)
  console.log(`  C1 ${okPlan ? 'PASS' : 'FAIL'} append mode=${planMode}｜registrations=${registrations.length}`)

  // 未批准续派（dispatchReadOnly=true + planPhase）：只补模式，不注册。
  await dispatcher.send(planMember.id, '继续探索', undefined, REPO, 't-1', true, undefined, undefined, { planPhase: 'workspace-write' })
  const okStill = registrations.length === 0
  okStill ? pass('C2 未批准续派', 'registrations 仍为 0') : fail('C2 未批准续派', `registrations=${registrations.length}`)
  console.log(`  C2 ${okStill ? 'PASS' : 'FAIL'} 未批准续派后 registrations=${registrations.length}`)

  // 批准后（planApproved）：这才注册 target 可写根。
  await dispatcher.send(planMember.id, '执行', undefined, REPO, 't-1', false, undefined, undefined, { planApproved: true })
  const okGrant = registrations.length === 1 && registrations[0][1] === REPO
  okGrant ? pass('C3 批准后注册', `registrations=${JSON.stringify(registrations)}`) : fail('C3 批准后注册', `registrations=${JSON.stringify(registrations)}`)
  console.log(`  C3 ${okGrant ? 'PASS' : 'FAIL'} 批准后 registrations=${JSON.stringify(registrations)}`)

  const readOnlyMember = await dispatcher.spawn({ prompt: 'p', cwd: REPO, readOnly: true })
  const readOnlyMode = modeOf(readOnlyMember.id)
  const okReadOnly = readOnlyMode === 'read-only'
  okReadOnly ? pass('C4 readOnly spawn 语义不变', `mode=${readOnlyMode}`) : fail('C4 readOnly spawn 语义不变', `mode=${readOnlyMode}`)
  console.log(`  C4 ${okReadOnly ? 'PASS' : 'FAIL'} readOnly 任务 append mode=${readOnlyMode}`)
}

// ── 汇总 ──
const failed = results.filter(item => item.ok !== true)
const ran = results.filter(item => item.skipped !== true)
line('结论')
console.log(`  repo=${REPO}`)
console.log(`  通过 ${ran.length - failed.length}/${ran.length}（跳过 ${results.length - ran.length} 项）`)
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail}`)
if (failed.length === 0) console.log('  全部通过：计划阶段可写 $TMPDIR/scratch、仓库与私有目录被拒、批准后才注册 target。')
process.exitCode = failed.length === 0 ? 0 : 1
