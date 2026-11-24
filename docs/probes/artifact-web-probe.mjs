// 临时 web profile 插件：真实宿主 + 本地确定性模型，不读取账号凭据。
// 仅探针，不随 npm files 发布；通过 DSH_HOME/ARTIFACT_PROBE_ROOT 隔离证据。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'artifact-web-probe'
export const inject = ['llm', 'agents', 'tools', 'sandboxPolicy', 'fs', 'shell']
const root = process.env.ARTIFACT_PROBE_ROOT
const log = (type, data = {}) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ type, at: Date.now(), ...data }) + '\n')

export function apply(ctx) {
  mkdirSync(root, { recursive: true })
  const steps = new Map()
  const dispatched = new Set()
  const taskOf = sid => {
    let db
    try {
      db = new DatabaseSync(join(process.env.DSH_HOME, 'state/orchestrator/tasks.sqlite'), { readOnly: true })
      return db.prepare('SELECT * FROM tasks WHERE session_id = ?').get(sid)
    } finally { db?.close() }
  }
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Artifact local probe' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p, _m, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [{ id: 'mock', name: 'mock' }],
    resolveModel: async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }),
    async prepareCall(provider, id) { return { model: await this.resolveModel(provider, id), stream: options => this.stream(options) } },
    async *stream(options) {
      const sid = String(options.sessionId)
      const tools = (options.tools ?? []).map(t => t.name)
      const task = taskOf(sid)
      const text = [...(options.messages ?? [])].reverse().map(m => JSON.stringify(m)).find(m => m.includes('ARTIFACT_WEB_VERIFY')) ?? ''
      const count = steps.get(sid) ?? 0
      steps.set(sid, count + 1)
      let call
      if (task) {
        const docs = task.artifact_dir
        const sequence = [
          ['artifact_save', { task_id: task.id, name: '阶段报告', content: '# 第一版\n原始证据' }],
          ['artifact_save', { task_id: task.id, name: '阶段报告', content: '# 第二版\n新证据' }],
          ['write', { file_path: join(task.target_dir, 'out.txt'), content: 'file-tool-output' }],
          ['bash', { command: `printf shell-output > '${join(task.target_dir, 'shell.txt')}'`, description: '验证工作区 shell 写权限' }],
          ['task_report', { task_id: task.id, status: 'done', summary: '宿主产物验证完成', changedFiles: task.read_only ? [] : ['out.txt', 'shell.txt'] }],
        ]
        call = sequence[count]
        log('worker.request', { sid, count, tools, artifactDir: docs, readOnly: Boolean(task.read_only) })
      } else if (tools.includes('task_create') && /ARTIFACT_WEB_VERIFY/.test(text) && !dispatched.has(`${sid}:${text.includes('READONLY')}`)) {
        const readonly = text.includes('READONLY')
        dispatched.add(`${sid}:${readonly}`)
        call = ['task_create', {
          title: `${readonly ? '只读阶段文档验收' : '非Git阶段快照验收'} ${Date.now()}`,
          goal: `运行本地确定性宿主验证 ${Date.now()}`, acceptance: ['阶段文档可保存，工作权限符合任务类型'],
          target: join(root, readonly ? 'readonly' : 'work-final'), readOnly: readonly,
        }]
      }
      if (call) {
        const [tool, args] = call
        const id = `probe-${sid}-${count}`
        log('tool.request', { sid, name: tool, args })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: JSON.stringify(args) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: JSON.stringify(args) } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '本地验证回合结束。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '本地验证回合结束。' } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }
  const dispose = ctx.llm.registerAdapter(['artifact-probe'], adapter)
  ctx.effect(() => dispose, 'artifact.probe.adapter')
  ctx.on('agent/created', ({ agent }) => {
    agent.model.select({ provider: 'artifact-probe', model: 'mock' })
    log('agent.created', { sid: agent.id, headerCwd: agent.session.header.cwd })
  })
  ctx.on('session/event', (session, event) => {
    if (['workspace/changes', 'tool/result', 'turn/end', 'working-directory/set'].includes(event.type)) {
      log('session.event', { sid: session.id, seq: event.seq, eventType: event.type, data: event.data })
    }
    if (event.type === 'workspace/changes') queueMicrotask(() => {
      const summary = ctx.get('workspaceChanges')?.summary(session.id, event.seq)
      log('summary', { sid: session.id, seq: event.seq, summary: summary ?? null })
    })
  })
  ctx.on('subagent/end', info => log('subagent.end', info))
  // 复核同工作区包含性的硬边界：只写探针 sentinel，不改已保存文档。
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const task = taskOf(agent.id)
    if (!task || task.read_only || !task.artifact_dir) return
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session, mode: 'workspace-write' })
    const path = join(task.artifact_store_dir ?? task.artifact_dir, 'protected-sentinel.txt')
    writeFileSync(path, 'original')
    try {
      const target = await ctx.fs.resolve(path)
      await ctx.fs.writeText(target, 'overwritten', undefined, undefined, policy)
      log('artifact.protection', { protected: readFileSync(path, 'utf8') === 'original', policy })
    } catch (error) {
      log('artifact.protection', { protected: true, code: error.code, policy })
    }
    const execution = await ctx.shell.execute(ctx.shell.resolve({
      command: `printf overwritten > '${path}'`, workdir: task.target_dir,
      sandboxPolicy: policy, timeoutMs: 10000,
    }))
    const result = await execution.result()
    log('artifact.shell-protection', { protected: readFileSync(path, 'utf8') === 'original', result })
  })
}
