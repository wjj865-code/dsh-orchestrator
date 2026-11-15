// 探针（源码级）：平台子会话结算（settle）的 stopReason 取值域、赋值路径与时序（可复跑）。
// 用法: node docs/probes/stop-reason-probe.mjs [app.asar 路径]
// 真机时序见 docs/probes/stop-reason-probe.md（settle-probe 插件）。
import { readFileSync, existsSync } from 'node:fs'

const ASAR = process.argv[2] ?? process.env.DSH_ASAR
  ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

if (!existsSync(ASAR)) {
  console.error(`找不到安装包：${ASAR}（可用参数或 DSH_ASAR 覆盖）`)
  process.exit(1)
}

const source = readFileSync(ASAR, 'utf8')
const squash = text => text.replace(/\s+/g, ' ')
const findings = []

function find(pattern) {
  const match = typeof pattern === 'string' ? { index: source.indexOf(pattern) } : pattern.exec(source)
  return match !== null && match !== undefined && match.index >= 0 ? match.index : -1
}

function check(name, pattern, before = 160, after = 320) {
  const at = find(pattern)
  findings.push({
    name,
    ok: at >= 0,
    at,
    snippet: at < 0 ? '' : squash(source.slice(Math.max(0, at - before), at + after)),
  })
  return at
}

/** 断言 A 在 B 之前出现（同一段代码里的时序关系）。 */
function checkBefore(name, first, second) {
  const a = find(first)
  const b = find(second)
  const ok = a >= 0 && b >= 0 && a < b
  findings.push({
    name,
    ok,
    at: a,
    snippet: ok ? `A@${a} < B@${b}` : `A@${a} / B@${b}`,
  })
}

// —— 取值域：类型声明是唯一权威（平台把 .d.ts 也打进 asar）——
check('SubagentStopReasonMap 取值域 = completed/aborted/error/max-tokens/refusal',
  /SubagentStopReasonMap \{\\n?[^}]*completed[^}]*aborted[^}]*error[^}]*max-tokens[^}]*refusal/, 200, 420)
check('SubagentResult.stopReason 必填（结算结果一定带原因）',
  /interface SubagentResult \{\\n?[^}]*stopReason: SubagentStopReason/, 200, 260)

// —— 赋值路径：epochStopReason 把 turn/end 的 reason.kind 翻成 stopReason ——
check('赋值：turn/end completed → stopReason=completed（队列被取消时降级 aborted）',
  /case void 0:\s*case "completed":\s*return droppedUnrun \? "aborted" : "completed"/, 320, 200)
check('赋值：turn/end aborted/interrupted → stopReason=aborted',
  /case "aborted":\s*case "interrupted":\s*return "aborted"/, 220, 160)
check('赋值：turn/end error → stopReason=error',
  /case "error":\s*return "error"/, 160, 120)
check('赋值：turn/end max-tokens → stopReason=max-tokens',
  /case "max-tokens":\s*return "max-tokens"/, 160, 120)
check('赋值：turn/end blocked（pre-step 拒绝）→ stopReason=refusal',
  /case "blocked":\s*return "refusal"/, 260, 160)
check('赋值：未提交 turn/end 的失败（failureAt）直接判 error',
  /failureAt === void 0 \? epochStopReason\(events\) : "error"/, 240, 160)

// —— 结算装配：cleanup → 生命周期事件 → result.resolve 的顺序 ——
check('结算：finishDisposal 发出 subagent/end（带 terminal.stopReason）',
  /emitLifecycle\("subagent\/end", \{\s*\.\.\.this\.runInfo\(activation\),\s*stopReason: terminal\.stopReason/, 200, 320)
checkBefore('时序：subagent/end 先于 activation.result.resolve',
  /emitLifecycle\("subagent\/end"/, /if \(resultFailure === void 0\) activation\.result\.resolve\(result\)/)
check('时序：dispose 走 agent.cancel({kind:"parent"}) + whenIdle 后再取结果',
  /if \(stop\) \{\s*activation\.handle\.agent\.cancel\(\{ kind: "parent" \}\);\s*await activation\.handle\.agent\.whenIdle\(\)/, 120, 260)
check('dispose 幂等：dispose() 最终走 finishDisposal(activation, true)',
  /finishDisposal\(activation, true\)/, 200, 200)
check('caller signal 只取消未发布的工作（发布后必须 dispose）',
  'The caller signal cancels only unpublished work', 120, 300)
check('续派/冷恢复 = 新的 activation（restoreTarget → materialize 新 runId）',
  /restoreTarget\(root, childId, signal\)/, 200, 300)
check('settle 时机：子级 idle 且 inbox 无待处理输入才算 ready（否则 wait/retry）',
  /if \(activation\.failureAt === void 0 && \(inbox\.nextTurn\.length > 0 \|\| inbox\.nextStep\.length > 0\)\) return "wait"/, 320, 160)

const width = Math.max(...findings.map(item => item.name.length))
for (const item of findings) {
  console.log(`${item.ok ? 'PASS' : 'MISS'}  ${item.name.padEnd(width)}  @${item.at}`)
  if (item.snippet !== '') console.log(`      ${item.snippet.slice(0, 460)}`)
}
const failed = findings.filter(item => !item.ok)
console.log(`\n合计 ${findings.length} 项，未命中 ${failed.length} 项${failed.length === 0 ? '（全部命中）' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
