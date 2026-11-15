// K1 keep-alive probe plugin (throwaway, not product code).
// Runs in a disposable headless profile with a mock model provider, spawns one
// child subagent, and injects one user message from `agent/turn-stopping`:
//   followup       -> agent.inbox.nextTurn, new turn, no idle in between
//   steer          -> agent.inbox.nextStep, same turn, no turn/end in between
//   followup-async -> same as followup after a 50ms await (proves serial awaits)
//   none           -> control: settle immediately after the first turn
// Every event is appended as JSONL to $K1_LOG.
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'keepalive-probe'
export const inject = ['tools', 'subagents', 'llm', 'agents']

const LOG = process.env.K1_LOG ?? 'k1-events.jsonl'
const log = (type, data = {}) => {
  try { appendFileSync(LOG, JSON.stringify({ at: Date.now(), type, ...data }) + '\n') } catch { /* probe only */ }
}
const blocks = value => [{ type: 'text', text: String(value) }]
const lastText = messages => {
  const last = [...(messages ?? [])].reverse().find(m => m?.role === 'user')
  return (last?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
}
const hasToolResult = messages => (messages ?? []).some(m => m?.role === 'tool')

export function apply(ctx) {
  const calls = new Map() // sessionId -> model request count
  const stopCount = new Map() // agentId -> turn-stopping count
  const modeOf = new Map() // agentId -> probe mode
  const childIds = new Set()

  // A minimal LlmAdapter: headless sends its task to the top-level agent, the
  // top-level mock calls probe_run once, then answers; child agents answer text.
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'K1 mock' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: () => Promise.resolve([{ id: 'mock', name: 'mock' }]),
    resolveModel: (provider, model) => Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 100000 },
      defaultMaxTokens: 4096,
    }),
    prepareCall(provider, model) {
      return Promise.resolve({
        model: { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 4096 },
        stream: options => this.stream(options),
      })
    },
    async *stream(options) {
      const sid = String(options.sessionId ?? '')
      const n = (calls.get(sid) ?? 0) + 1
      calls.set(sid, n)
      log('llm.request', { sid, n, tail: lastText(options.messages).slice(0, 80), tool: hasToolResult(options.messages), child: childIds.has(sid) })
      if (childIds.has(sid)) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        const text = `child turn ${n}`
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (hasToolResult(options.messages)) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'K1 top-level done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'K1 top-level done' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'call-k1', name: 'probe_run', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-k1', name: 'probe_run', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
  const unregister = ctx.llm.registerAdapter(['probe'], adapter)
  ctx.effect(() => unregister, 'k1.probe.adapter')

  // Force every agent (top-level and child) onto the mock route. Child agents
  // inherit a model selection, but selecting here keeps the probe independent
  // of the profile's default route.
  const selectMock = agent => {
    try { agent.model.select({ provider: 'probe', model: 'mock' }) } catch (error) {
      log('select.error', { agent: agent?.id, error: String(error?.message ?? error) })
    }
  }
  ctx.on('agent/created', ({ agent }) => {
    log('agent.created', { agent: agent.id, parent: agent.session?.header?.parentSession ?? null })
    selectMock(agent)
  })
  for (const agent of ctx.agents.list()) selectMock(agent)

  // Observation only.
  ctx.on('agent/status', ({ agent, status }) => log('agent.status', { agent: agent.id, status }))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      log('session.event', { sid: session.id, eventType: event.type, data: event.data })
    }
  })
  ctx.on('subagent/end', info => log('subagent.end', info))

  // The probe itself: a plugin-level listener, exactly how product code would
  // subscribe. Async on purpose for followup-async; serial dispatch awaits it.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const n = (stopCount.get(agent.id) ?? 0) + 1
    stopCount.set(agent.id, n)
    const mode = modeOf.get(agent.id) ?? 'none'
    log('turn-stopping', {
      agent: agent.id, turn, n, mode, aborted: signal?.aborted === true,
      inbox: { next: agent.inbox?.nextStep?.length ?? null, turn: agent.inbox?.nextTurn?.length ?? null },
    })
    if (n !== 1 || mode === 'none') return
    if (mode === 'followup-async') await new Promise(resolve => setTimeout(resolve, 50))
    const message = {
      id: randomUUID(),
      role: 'user',
      content: blocks('K1 keep-alive followup'),
      source: { kind: 'user' },
    }
    try {
      if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
      log('keepalive.injected', {
        agent: agent.id, mode,
        inbox: { next: agent.inbox.nextStep.length, turn: agent.inbox.nextTurn.length },
      })
    } catch (error) {
      log('keepalive.error', { agent: agent.id, mode, error: String(error?.message ?? error) })
    }
  })

  // Tool exposed to the top-level mock: spawn one child and wait for settlement.
  const tool = {
    name: 'probe_run',
    description: 'K1 probe: spawn one child, inject at its first turn-stopping, await settlement, report events.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => blocks(value ?? ''),
    },
    async execute(_args, exec) {
      const parent = exec?.agent
      if (parent === undefined) throw new Error('no caller agent')
      const childId = randomUUID()
      childIds.add(childId)
      modeOf.set(childId, process.env.K1_MODE ?? 'followup')
      log('child.spawn', { childId, mode: modeOf.get(childId) })
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: 'k1-child',
        delivery: 'caller',
        signal: exec?.signal ?? new AbortController().signal,
        childId,
        parent,
        prompt: blocks('PROBE_CHILD: answer with one short line, then stop.'),
      })
      log('child.activation', { childId: activation.childId, messageId: activation.messageId })
      let result
      let error
      try {
        result = await activation.result
      } catch (failure) {
        error = `${failure?.code ?? 'ERROR'}: ${failure?.message ?? failure}`
      }
      log('child.result', {
        childId,
        result: result === undefined ? null : { stopReason: result.stopReason, output: result.output },
        error,
      })
      return JSON.stringify({
        childId,
        mode: modeOf.get(childId),
        result: result === undefined ? null : { stopReason: result.stopReason, output: result.output },
        error: error ?? null,
        turns: [...stopCount.entries()],
        calls: [...calls.entries()],
      }, null, 2)
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'k1.probe.tool')
}
