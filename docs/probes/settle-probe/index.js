// 真机探针插件：子会话 settle 的 stopReason 取值与时序。
// 只装进临时 profile（见同目录 README），不随包发布、不装 desktop profile。
// 结果写到 docs/probes/out/settle-probe.json（同时把一行 JSON 摘要打到 stdout）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'settle-probe'
export const inject = ['subagents']

const OUT_DIR = 'C:/Users/72489/Documents/dsh-orchestrator/docs/probes/out'
const OUT_FILE = `${OUT_DIR}/settle-probe.json`
const T0 = Date.now()
const record = []
const scenarios = []
const lifecycleEnds = new Map()
const turnEnds = new Map()

const elapsed = () => Date.now() - T0
const textOf = output => (Array.isArray(output) ? output : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text)
  .join('\n')
  .slice(0, 400)

const push = (type, data = {}) => {
  record.push({ t: Date.now(), rel: elapsed(), type, data })
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(OUT_FILE, JSON.stringify({ startedAt: new Date(T0).toISOString(), events: record, scenarios }, null, 2))
  } catch { /* 写盘失败不影响探针行为 */ }
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ timeout: label }), ms)),
])

const runScenario = async (id, fn) => {
  const entry = { id, steps: [], outcome: undefined }
  scenarios.push(entry)
  const step = (name, data = {}) => {
    entry.steps.push({ rel: elapsed(), name, data })
    push(`scenario/${id}/${name}`, data)
  }
  push('scenario/start', { id })
  try {
    entry.outcome = await fn(step)
  } catch (error) {
    entry.outcome = { thrown: `${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}` }
  }
  push('scenario/end', { id, outcome: entry.outcome })
  return entry.outcome
}

export function apply(ctx) {
  // 服务必须在 apply 期捕获：延迟回调里的 ctx 已是不活跃上下文，ctx.subagents 取不到。
  const subagents = ctx.subagents ?? ctx.get?.('subagents')
  const listen = (event, handler) => {
    try {
      ctx.on(event, handler)
      push('subscribed', { event, ok: true })
    } catch (error) {
      push('subscribed', { event, ok: false, error: error?.message ?? String(error) })
    }
  }

  listen('subagent/start', info => push('lifecycle/subagent-start', { ...info }))
  listen('subagent/end', info => {
    push('lifecycle/subagent-end', { ...info })
    const key = String(info?.id ?? '')
    const list = lifecycleEnds.get(key) ?? []
    list.push({ rel: elapsed(), stopReason: info?.stopReason, local: info?.local })
    lifecycleEnds.set(key, list)
  })
  listen('session/event', (session, event) => {
    if (event?.type !== 'turn/end' && event?.type !== 'turn/start') return
    const id = String(session?.id ?? '')
    const list = turnEnds.get(id) ?? []
    list.push({ rel: elapsed(), type: event.type, seq: event.seq, reason: event.data?.reason?.kind })
    turnEnds.set(id, list)
  })

  let started = false
  ctx.on('agent/created', ({ agent } = {}) => {
    if (started) return
    const origin = agent?.session?.header?.origin
    if (agent === undefined || origin === 'subagent') return
    started = true
    push('root/created', { id: agent.id, origin: origin ?? null })
    // 等根会话首回合起步，避免探针与它的工具表/模型请求抢时序。
    setTimeout(() => {
      void runAll(agent).catch(error => push('probe/failed', { error: error?.message ?? String(error) }))
    }, 1500)
  })

  async function runAll(root) {
    const spawn = async (label, { prompt, agentOptions, signal } = {}) => {
      const controller = signal ?? new AbortController()
      const childId = randomUUID()
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label,
        delivery: 'caller',
        signal: controller.signal,
        childId,
        parent: root,
        prompt: [{ type: 'text', text: prompt }],
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      return { activation, childId, controller }
    }
    const settle = async (activation, ms = 180_000) => {
      const result = await withTimeout(activation.result.then(
        value => ({ resolved: { stopReason: value?.stopReason ?? null, output: textOf(value?.output), structured: value?.structured ?? null } }),
        error => ({ rejected: `${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}` }),
      ), ms, 'settle-timeout')
      if (result?.timeout !== undefined) return result
      return { ...result, at: elapsed() }
    }
    const quickPrompt = '只回复 OK 两个字母，不要调用任何工具。'

    // S1：正常完成
    await runScenario('completed', async step => {
      const { activation, childId } = await spawn('probe-completed', { prompt: quickPrompt })
      step('spawned', { childId, messageId: activation.messageId ?? null })
      const result = await settle(activation)
      step('settled', { ...result, turns: turnEnds.get(String(childId)) ?? [] })
      await activation.dispose().catch(error => step('dispose-error', { error: error?.message ?? String(error) }))
      return { childId, ...result }
    })

    // S2：派发后立刻 dispose（task_stop 派发窗口）
    await runScenario('dispose-immediately', async step => {
      const { activation, childId } = await spawn('probe-dispose-now', { prompt: quickPrompt })
      step('spawned', { childId })
      const disposing = activation.dispose().then(() => ({ ok: true }), error => ({ ok: false, error: error?.message ?? String(error) }))
      const result = await settle(activation)
      step('settled', { ...result, dispose: await withTimeout(disposing, 60_000, 'dispose-timeout') })
      return { childId, ...result }
    })

    // S3：跑到一半 dispose（task_stop 运行中）
    await runScenario('dispose-mid-run', async step => {
      const { activation, childId } = await spawn('probe-dispose-mid', {
        prompt: '请把下面这段代码逐行解释，每行一句，不要调用工具：' + 'const a = 1;\n'.repeat(30),
      })
      step('spawned', { childId })
      await new Promise(resolve => setTimeout(resolve, 1500))
      const disposing = activation.dispose().then(() => ({ ok: true }), error => ({ ok: false, error: error?.message ?? String(error) }))
      const result = await settle(activation)
      step('settled', { ...result, dispose: await withTimeout(disposing, 60_000, 'dispose-timeout') })
      return { childId, ...result }
    })

    // S4：caller signal 在发布后 abort（文档：只取消未发布的工作）
    await runScenario('signal-after-publish', async step => {
      const controller = new AbortController()
      const { activation, childId } = await spawn('probe-signal', { prompt: quickPrompt, signal: controller })
      step('spawned', { childId })
      controller.abort(new Error('probe: abort after publish'))
      step('aborted-signal')
      const result = await settle(activation, 120_000)
      step('settled', { ...result, turns: turnEnds.get(String(childId)) ?? [] })
      await activation.dispose().catch(() => {})
      return { childId, ...result }
    })

    // S5：max-tokens（maxTokens 很小）
    await runScenario('max-tokens', async step => {
      const { activation, childId } = await spawn('probe-maxtokens', {
        prompt: '请写一段 200 字的自我介绍，不要调用工具。',
        agentOptions: { maxTokens: 8 },
      })
      step('spawned', { childId })
      const result = await settle(activation, 180_000)
      step('settled', { ...result, turns: turnEnds.get(String(childId)) ?? [] })
      await activation.dispose().catch(() => {})
      return { childId, ...result }
    })

    // S6：模型不可用（error）
    await runScenario('bad-model', async step => {
      try {
        const { activation, childId } = await spawn('probe-bad-model', {
          prompt: quickPrompt,
          agentOptions: { model: 'probe-not-a-real-model' },
        })
        step('spawned', { childId })
        const result = await settle(activation, 120_000)
        step('settled', result)
        await activation.dispose().catch(() => {})
        return { childId, ...result }
      } catch (error) {
        step('start-rejected', { error: `${error?.code === undefined ? '' : `[${error.code}] `}${error?.message ?? error}` })
        return { startRejected: true }
      }
    })

    // S7：冷链续派（task_message 场景）：settle 之后 sendMessage 再起一轮，看 lifecycle 是否再发一次 end。
    await runScenario('resume-after-settle', async step => {
      const { activation, childId } = await spawn('probe-resume', { prompt: quickPrompt })
      step('spawned', { childId })
      const first = await settle(activation, 120_000)
      step('first-settled', first)
      const before = (lifecycleEnds.get(String(childId)) ?? []).length
      const controller = new AbortController()
      try {
        const receipt = await subagents.sendMessage(root, childId, [{ type: 'text', text: '再回复 OK 两个字母。' }], { signal: controller.signal })
        step('resumed', { messageId: receipt?.messageId ?? null })
      } catch (error) {
        step('resume-rejected', { error: error?.message ?? String(error) })
        return { childId, first, resumed: false }
      }
      for (let wait = 0; wait < 120; wait += 1) {
        const list = lifecycleEnds.get(String(childId)) ?? []
        if (list.length > before) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const second = (lifecycleEnds.get(String(childId)) ?? []).slice(before)
      step('second-lifecycle', { ends: second, turns: turnEnds.get(String(childId)) ?? [] })
      await activation.dispose().catch(() => {})
      return { childId, first, second }
    })

    push('probe/done', {
      lifecycleEnds: Object.fromEntries(lifecycleEnds),
      turnEnds: Object.fromEntries(turnEnds),
    })
    const summary = scenarios.map(item => ({ id: item.id, outcome: item.outcome }))
    console.log(`SETTLE_PROBE_RESULT ${JSON.stringify(summary)}`)
  }
}
