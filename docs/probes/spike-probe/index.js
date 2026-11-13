// spike-probe：直连 subagent（ctx.subagents.startActivation）的技术验证插件。
// 只装在 smoke profile 里跑，不属于 dsh-orchestrator 产品代码，验证完删掉。
//
// 回答 5 个问题：
//   1. 子级能否真调用全局 task_report（工具可见 + exec.agent.id 与任务 session_id 对得上）
//   2. 追加消息能否进同一个 childId 并被消费
//   3. 第 9 个 activation 是否 ACTIVATION_LIMIT_REACHED，dispose 后槽位是否真释放
//   4. 子级能否被父会话发现（listChildren），是否需要从 catalog 打开
//   5. 父会话关闭释放后代（只在 README 里记风险，不主动杀父会话）
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'spike-probe'
export const inject = ['tools', 'subagents']

const sleep = ms => ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms))
const blocks = value => [{ type: 'text', text: String(value) }]
const json = value => JSON.stringify(value, null, 2)
const short = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
const blockText = output => (output ?? [])
  .filter(block => block?.type === 'text')
  .map(block => block.text)
  .join('\n')

const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')
const ledgerPath = () => join(stateDir(), 'tasks.sqlite')

const withLedger = fn => {
  const db = new DatabaseSync(ledgerPath())
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return fn(db)
  } finally {
    try { db.close() } catch { /* 探针只读失败不阻断结论 */ }
  }
}

// 探针自己往（smoke profile 的）台账里种一条 running 任务，session_id 就是子会话 id。
// 这样 task_report 的「回报方必须等于任务 session_id」校验才可能通过。
function seedTask({ sessionId, coordinatorSession, title, goal }) {
  const id = `t-spike-${randomUUID().slice(0, 6)}`
  const now = Date.now()
  withLedger(db => {
    db.prepare(`INSERT INTO tasks
      (id, title, goal, brief_json, status, session_id, target, coordinator_session,
       attempts, created_at, updated_at, last_event_at, error)
      VALUES (?, ?, ?, ?, 'running', ?, 'spike-child', ?, 0, ?, ?, ?, NULL)`)
      .run(id, title, goal, JSON.stringify({ title, goal }), String(sessionId), String(coordinatorSession), now, now, now)
  })
  return id
}

function markTaskFailed(id, reason) {
  try {
    withLedger(db => db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(reason, Date.now(), id))
  } catch { /* 收尾失败不影响探针结论 */ }
}

function readTask(id) {
  return withLedger(db => ({
    task: db.prepare('SELECT id, title, status, session_id, target, error FROM tasks WHERE id = ?').get(id),
    messages: db.prepare('SELECT seq, kind, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(id),
  }))
}

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
const str = description => ({ type: 'string', description })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })

export function apply(ctx) {
  const activations = new Map()
  const notes = []
  const holds = new Map()

  const parentOf = exec => exec?.agent
  const parentSessionId = exec => exec?.agent?.session?.id ?? exec?.agent?.id

  // 子级 dispose 时把它挂起的 probe_hold 放开，避免 dispose 等一个永不结算的工具调用。
  const releaseHoldsFor = childId => {
    for (const [name, hold] of holds) {
      if (hold.childId === childId) hold.resolve(`hold ${name} released by dispose`)
    }
  }

  async function startChild(exec, { prompt, label, childId }) {
    const parent = parentOf(exec)
    if (parent === undefined) throw new Error('缺少调用方 agent，无法起子会话')
    const signal = exec?.signal ?? new AbortController().signal
    const cwd = parent?.session?.header?.cwd
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label,
      delivery: 'caller',
      signal,
      childId: childId ?? randomUUID(),
      request: {
        parent,
        prompt: blocks(prompt),
        ...(cwd === undefined ? {} : { cwd }),
      },
    })
    const entry = {
      childId: activation.childId,
      messageId: activation.messageId,
      activation,
      parent,
      label,
      settled: false,
      result: undefined,
      error: undefined,
      done: undefined,
    }
    // delivery: 'caller' 时没人 await 会未处理拒绝，这里必须挂上。
    entry.done = activation.result.then(
      result => {
        entry.settled = true
        entry.result = result
        return { ok: true, result }
      },
      error => {
        entry.settled = true
        entry.error = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`
        return { ok: false, error: entry.error }
      },
    )
    activations.set(activation.childId, entry)
    return entry
  }

  const timeout = async (promise, ms) => {
    let timer
    const guard = new Promise(resolve => { timer = setTimeout(() => resolve({ __timeout: true }), ms) })
    try {
      return await Promise.race([promise, guard])
    } finally {
      clearTimeout(timer)
    }
  }

  const wrap = (name, description, properties, execute) => ({
    name,
    description,
    parameters: objectSchema(properties),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value === undefined ? '' : String(value) }],
    },
    async execute(args = {}, exec = {}) {
      try {
        return await execute(args ?? {}, exec ?? {})
      } catch (error) {
        const code = error?.code === undefined ? '' : `[${error.code}] `
        return `probe 调用失败：${code}${error?.message ?? error}`
      }
    },
  })

  const tools = [
    wrap('probe_whoami', '探针：报告当前会话身份、header、可见工具（子级调用它证明全局工具可见）。', {}, async (_args, exec) => {
      const agent = exec?.agent
      const header = agent?.session?.header
      let known = []
      let toolsError
      try {
        const view = agent?.ctx?.tools?.view?.(agent)
        known = [...(view?.knownNames ?? [])]
      } catch (error) {
        toolsError = String(error?.message ?? error)
      }
      const taskTools = known.filter(tool => tool.startsWith('task_'))
      return json({
        agentId: agent?.id,
        sessionId: agent?.session?.id,
        origin: header?.origin,
        parentSession: header?.parentSession,
        delegationDepth: header?.delegationDepth,
        agentPreset: header?.agentPreset,
        cwd: header?.cwd,
        toolCount: known.length,
        toolsError,
        taskTools,
        hasTaskReport: taskTools.includes('task_report'),
        probeTools: known.filter(tool => tool.startsWith('probe_')),
      })
    }),

    wrap('probe_providers', '探针：列出已注册的 subagent provider 名称。', {}, async () => {
      let providerNames
      try {
        providerNames = typeof ctx.subagents?.list === 'function' ? ctx.subagents.list() : 'list() 不可用'
      } catch (error) {
        providerNames = `list() 失败：${error?.message ?? error}`
      }
      return json({ providerNames })
    }),

    wrap('probe_spawn', '探针：起一个真实子会话（不等待结算），返回 childId。', {
      prompt: str('发给子代理的完整指令'),
      label: str('子会话标签，可空'),
    }, async (args, exec) => {
      const entry = await startChild(exec, {
        prompt: args.prompt,
        label: args.label ?? 'spike-child',
      })
      return json({ childId: entry.childId, messageId: entry.messageId, label: entry.label })
    }),

    wrap('probe_followup', '探针：给已有 childId 追加一条消息（验证同一子会话可继续）。', {
      childId: str('probe_spawn / probe_report_e2e 返回的 childId'),
      prompt: str('追加内容'),
    }, async (args, exec) => {
      const entry = activations.get(args.childId)
      const parent = entry?.parent ?? parentOf(exec)
      const signal = exec?.signal ?? new AbortController().signal
      const messageId = await ctx.subagents.sendMessage(parent, args.childId, blocks(args.prompt), { signal })
      return json({ childId: args.childId, messageId })
    }),

    wrap('probe_poll', '探针：查看一个子会话是否结算、输出/错误、以及它留下的 probe_note。', {
      childId: str('子会话 id'),
    }, async args => {
      const entry = activations.get(args.childId)
      return json({
        childId: args.childId,
        known: entry !== undefined,
        settled: entry?.settled ?? false,
        stopReason: entry?.result?.stopReason,
        outputText: entry?.result === undefined ? undefined : short(blockText(entry.result.output), 4000),
        error: entry?.error,
        notes: notes.filter(note => note.childId === args.childId),
      })
    }),

    wrap('probe_dispose', '探针：dispose 一个 activation（验证取消与槽位释放）。', {
      childId: str('子会话 id'),
    }, async args => {
      const entry = activations.get(args.childId)
      if (entry === undefined) return json({ childId: args.childId, disposed: false, reason: 'unknown childId' })
      let error
      const outcome = await timeout(entry.activation.dispose().then(() => 'disposed'), 30000)
      if (outcome?.__timeout === true) error = 'dispose 30s 未返回'
      releaseHoldsFor(args.childId)
      activations.delete(args.childId)
      return json({ childId: args.childId, disposed: error === undefined, outcome, error })
    }),

    wrap('probe_catalog', '探针：父会话能否发现自己的子会话（subagent catalog / listChildren）。', {
      parentSessionId: str('父会话 id，默认当前协调者会话'),
    }, async (args, exec) => {
      const signal = exec?.signal ?? new AbortController().signal
      const id = args.parentSessionId ?? parentSessionId(exec)
      const children = await ctx.subagents.listChildren(id, signal)
      let descendants
      try {
        descendants = await ctx.subagents.listDescendants(id, signal)
      } catch (error) {
        descendants = `listDescendants 失败：${error?.message ?? error}`
      }
      return json({ parentSessionId: id, children, descendants })
    }),

    wrap('probe_note', '子级专用：把一条证据记进探针内存，父级用 probe_poll/probe_notes 读。', {
      text: str('证据文本'),
    }, async (args, exec) => {
      const note = {
        at: new Date().toISOString(),
        childId: exec?.agent?.id,
        sessionId: exec?.agent?.session?.id,
        text: String(args.text ?? ''),
      }
      notes.push(note)
      return `recorded: ${short(note.text)}`
    }),

    wrap('probe_notes', '探针：读所有子级留下的 probe_note。', {}, async () => json(notes)),

    wrap('probe_hold', '子级专用：阻塞住不让本轮结束，父级用 probe_release 放行。用于并发上限验证。', {
      name: str('hold 名称'),
    }, async (args, exec) => {
      const name = args.name
      return await new Promise(resolve => {
        const entry = { resolve: value => { holds.delete(name); resolve(value) }, childId: exec?.agent?.id }
        holds.set(name, entry)
        exec?.signal?.addEventListener('abort', () => entry.resolve(`hold ${name} aborted`), { once: true })
      })
    }),

    wrap('probe_release', '探针：放行一个 probe_hold。', {
      name: str('hold 名称'),
    }, async args => {
      const entry = holds.get(args.name)
      if (entry === undefined) return json({ name: args.name, released: false, reason: 'unknown hold' })
      entry.resolve(`hold ${args.name} released`)
      return json({ name: args.name, released: true })
    }),

    wrap('probe_report_e2e', '探针：种一条任务 → 起子会话 → 子级调 task_report → 回读台账，验证任务=子会话闭环。', {
      title: str('任务标题，可空'),
      goal: str('任务目标，可空'),
      waitMs: num('等待子级结算的毫秒数，默认 120000', { minimum: 1000, maximum: 600000 }),
    }, async (args, exec) => {
      const parent = parentOf(exec)
      if (parent === undefined) throw new Error('缺少调用方 agent')
      const childId = randomUUID()
      const title = args.title ?? `spike report e2e ${new Date().toISOString()}`
      const goal = args.goal ?? '验证子代理能调用全局 task_report，且 exec.agent.id 与任务 session_id 一致'
      const taskId = seedTask({
        sessionId: childId,
        coordinatorSession: parent.session?.id ?? parent.id,
        title,
        goal,
      })
      let entry
      try {
        entry = await startChild(exec, {
          childId,
          label: 'spike-report',
          prompt: [
            '你是一个子代理，正在做技术验证，只做下面两件事，不要做别的。',
            `第一步：调用工具 task_report，参数 task_id="${taskId}"、status="progress"、summary="spike progress"。把你收到的工具返回原文写进回复。`,
            `第二步：再调用 task_report，参数 task_id="${taskId}"、status="done"、summary="spike done"。同样把返回原文写进回复。`,
            '如果 task_report 不在你的工具列表里，直接回复 NO_TASK_REPORT 并停止。',
            '最后单独一行回复 DONE。',
          ].join('\n'),
        })
      } catch (error) {
        markTaskFailed(taskId, `子会话创建失败：${error?.message ?? error}`)
        return json({ taskId, childId, spawned: false, error: `${error?.code ?? ''} ${error?.message ?? error}` })
      }
      const settled = await timeout(entry.done, args.waitMs ?? 120000)
      const { task, messages } = readTask(taskId)
      return json({
        taskId,
        childId,
        seededSessionId: childId,
        spawned: true,
        messageId: entry.messageId,
        settled: settled?.__timeout === true ? 'timeout' : entry.settled,
        stopReason: entry.result?.stopReason,
        error: entry.error,
        childOutputText: entry.result === undefined ? undefined : short(blockText(entry.result.output), 4000),
        taskStatus: task?.status,
        taskSessionId: task?.session_id,
        taskError: task?.error,
        messages,
      })
    }),

    wrap('probe_capacity', '探针：占满并发槽位 → 第 N+1 个应 ACTIVATION_LIMIT_REACHED → dispose 后能否再起。', {
      count: num('先占用的子会话数，默认 8（测试不要超过 8）', { minimum: 1, maximum: 8 }),
      waitMs: num('等待子级进入 hold 的毫秒数，默认 90000', { minimum: 1000, maximum: 300000 }),
    }, async (args, exec) => {
      const count = args.count ?? 8
      const waitMs = args.waitMs ?? 90000
      const started = []
      const names = []
      const extraIds = []
      const result = { requested: count, held: 0, ninth: undefined, retryAfterDispose: undefined, errors: [] }

      for (let index = 0; index < count; index += 1) {
        const name = `cap-${index}-${randomUUID().slice(0, 4)}`
        try {
          const entry = await startChild(exec, {
            label: `cap-${index}`,
            prompt: [
              '你是一个子代理，正在做并发容量验证。',
              `调用一次工具 probe_hold，参数 name="${name}"；它会阻塞，返回后只回复 OK。`,
              '不要调用其他工具。',
            ].join('\n'),
          })
          started.push(entry)
          names.push(name)
        } catch (error) {
          result.errors.push(`spawn #${index + 1} 失败：${error?.code ?? ''} ${error?.message ?? error}`)
          break
        }
      }

      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !names.every(name => holds.has(name))) await sleep(500)
      result.held = names.filter(name => holds.has(name)).length
      result.started = started.length

      if (started.length === count && result.held === count) {
        try {
          const extra = await startChild(exec, { label: 'cap-overflow', prompt: '只回复 OK' })
          extraIds.push(extra.childId)
          result.ninth = { outcome: 'spawned', childId: extra.childId, note: '未观察到 ACTIVATION_LIMIT_REACHED' }
        } catch (error) {
          result.ninth = { outcome: 'rejected', code: error?.code, message: error?.message }
        }

        if (result.ninth.outcome === 'rejected') {
          const first = started[0]
          const disposed = await timeout(first.activation.dispose().then(() => 'disposed'), 30000)
          releaseHoldsFor(first.childId)
          activations.delete(first.childId)
          try {
            const again = await startChild(exec, { label: 'cap-retry', prompt: '只回复 OK' })
            extraIds.push(again.childId)
            result.retryAfterDispose = { outcome: 'spawned', childId: again.childId }
          } catch (error) {
            result.retryAfterDispose = { outcome: 'rejected', code: error?.code, message: error?.message }
          }
          result.disposeOutcome = disposed?.__timeout === true ? 'timeout' : 'disposed'
        }
      }

      for (const name of names) {
        const hold = holds.get(name)
        if (hold !== undefined) hold.resolve(`cleanup ${name}`)
      }
      for (const entry of [...started, ...[...activations.values()].filter(item => extraIds.includes(item.childId))]) {
        if (activations.has(entry.childId)) {
          try { await timeout(entry.activation.dispose().then(() => 'disposed'), 20000) } catch { /* 清理失败不阻断 */ }
          activations.delete(entry.childId)
        }
      }
      return json(result)
    }),
  ]

  const disposers = tools.map(tool => ctx.tools.register(tool))
  ctx.effect?.(() => async () => {
    for (const name of [...holds.keys()]) holds.get(name)?.resolve(`unload ${name}`)
    for (const name of [...activations.keys()]) {
      try { await activations.get(name).activation.dispose() } catch { /* 卸载期失败不阻断 */ }
    }
    activations.clear()
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch { /* 单个失败不阻断其余清理 */ }
    }
  })
}
