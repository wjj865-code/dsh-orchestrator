// 探测已安装 DSH 里 agentTeams 的真实契约（源码级，可复跑）。
// 用法: node docs/probes/api-probe.mjs [app.asar 路径]
// 说明: 这里只读取安装包内的实现文本，验证调用链确实存在；
// 真正跑一轮模型回合的唤醒时序由 Task 10 真机冒烟（R8）验证。
import { readFileSync, existsSync, statSync } from 'node:fs'

const ASAR = process.argv[2] ?? process.env.DSH_ASAR
  ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

if (!existsSync(ASAR)) {
  console.error(`找不到安装包：${ASAR}（可用参数或 DSH_ASAR 覆盖）`)
  process.exit(1)
}

const source = readFileSync(ASAR, 'utf8')
const checks = []

function check(name, pattern, excerpt = 120) {
  const match = typeof pattern === 'string'
    ? (source.includes(pattern) ? { index: source.indexOf(pattern) } : undefined)
    : pattern.exec(source)
  const ok = match !== undefined && match !== null
  const at = ok ? match.index : -1
  const snippet = ok ? source.slice(at, at + excerpt).replace(/\s+/g, ' ') : ''
  checks.push({ name, ok, at, snippet })
}

check('agentTeams 服务注册', /super\(ctx, ["']agentTeams["']\)/)
check('agents 服务注册', /super\(ctx, ["']agents["']\)/)
check('真实工具插件 inject 声明', /const inject = \[\s*["']agents["'],\s*["']agentTeams["'],\s*["']tools["'],\s*["']systemPrompt["']\s*\]/)
check('agent 查找：shared agent/session id', 'the shared agent/session id to look up')
check('agent 查找：ctx.agents.get(id) 返回 agent', /get\(id\) \{\s*return this\.store\.get\(id\)\?\.agent;/)
check('工具执行拿到调用方 agent', 'callingAgent(exec.agent, "send_message")')
check('teammate 记录 id 就是子会话 id', /const childId = brandString\(randomUUID\(\)\);\s*const member = \{\s*id: childId,/)
check('spawnTeammate provider 必填', 'requiredText(request.provider, "provider", 200)')
check('spawnTeammate signal 必填', 'const signal = AbortSignal.any([request.signal, this.lifecycle.signal]);')
check('sendMessage signal 必填', 'signal: AbortSignal.any([request.signal, this.lifecycle.signal])')
check('fresh provider 默认 spawn', 'provider: context === "fork" ? config.forkProvider : config.freshProvider')
check('向 lead 投递走 root.steer', /if \(target\.id === root\.id\) \{[\s\S]{0,300}?root\.steer\(input\);/)
check('sendMessage 发送方必须在 roster 内', 'resolveActiveMember(root, this.journal.state(root), request.target)')
check('createMessage 只补 id', /deepFreeze\(structuredClone\(\{\s*\.\.\.input,\s*id: brandString\(randomUUID\(\)\)\s*\}\)\)/)
check('createUserMessage 只加 role', /function createUserMessage\(input\) \{\s*return createMessage\(\{\s*\.\.\.input,\s*role: "user"\s*\}\);/)
check('agent-message source 形状', /kind: ['"]agent-message['"];[\s\S]{0,120}?form: ['"]relay['"];[\s\S]{0,120}?senderSessionId: SessionId/)
check('steer 走 next-step 且 wakeup=true', /steer\(input\) \{\s*this\.send\(input, "next-step", true\);/)
check('wakeup 会唤醒驱动器', /if \(wakeup\) this\.wakeDriver\(wakingAfterAbort\)/)
check('wakeDriver 在 initiator 作用域内启动', /this\.loopCtx\.agents\.withInitiator\(this, \(\) => this\.kick\(\)\)/)
check('initiator disposed 时拒绝新边界', /if \(this\.initiatorState !== ["']active["']\) throw new Error\(DISPOSED_INITIATOR_MESSAGE\);/)
check('服务收尾把 initiator 置 disposed', 'this.initiatorState = "disposed";')
check('忙时在下一步边界排队（不丢）', /this\.inbox\.splice\(resolvedTarget, Infinity, 0, \[message\]\);/)
check('自己不能给自己发消息', 'a Team member cannot message itself')
check('白名单 API：restrict(filter)', /restrict\(filter\) \{/)
check('白名单必须挂在 agent.ctx 上', 'tools.restrict() requires a scoped context (agent.ctx)')
check('白名单形状：allow/deny', /readonly allow\?: readonly string\[\];[\s\S]{0,120}?readonly deny\?: readonly string\[\];/)
check('wait_agent 按 agent scope 注册', /register\(scoped\.tools\.register\(defineTool\(\{\s*name: "wait_agent"/)
check('scope 内注册只进 knownNames', /for \(const \[name, registration\] of own\.tools\.entries\(\)\) \{\s*knownNames\.add\(name\);/)
check('restrictableNames 只收继承的全局工具', /for \(const \[name, registration\] of inherited\) \{\s*knownNames\.add\(name\);\s*restrictableNames\.add\(name\);/)
check('systemPrompt.context 注册 API', /context\(context\) \{[\s\S]{0,160}?layers\.effect\(this\.ctx, \(layer\) => layer\.contexts\.insert/)
check('tools.guard 注册 API', /guard\(guard\) \{[\s\S]{0,160}?this\.guards\.effect\(this\.ctx/)
check('ToolGuard 返回原因即拒绝', /export type ToolGuard = \(execution: Readonly<ToolExecution>\) => string \| undefined;/)

const versionMatch = /"@deepseek-ai\/dsh-experimental-agent-team"[\s\S]{0,300}?"version": "([^"]+)"/.exec(source)
console.log(`探测对象：${ASAR}`)
console.log(`安装包大小：${statSync(ASAR).size} bytes`)
console.log(`agent-team 包版本：${versionMatch?.[1] ?? '未匹配到'}`)
console.log(`日期：${new Date().toISOString()}`)
checks.push({ name: 'agent-team 包版本可读', ok: versionMatch !== undefined, at: versionMatch?.index ?? -1, snippet: versionMatch?.[0] ?? '' })
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? ` @${item.at}` : ''}`)
  if (item.ok) console.log(`     ${item.snippet.slice(0, 240)}`)
}
const failed = checks.filter(item => !item.ok)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length === 0 ? 0 : 1)
