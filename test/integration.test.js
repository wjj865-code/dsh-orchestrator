import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { taskCard } from '../src/card.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('集成冒烟：建任务 → 子会话 → 回报 → 卡片 → done 通知', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-smoke-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const coordinator = {
    id: 's-1',
    session: { id: 's-1', header: {} },
    injected: [],
    steer(message) { this.injected.push(message) },
    ctx: { tools: { view: () => ({ knownNames: new Set() }), restrict: () => () => {} } },
  }
  const teammate = { id: 'm-1' }
  const spawned = []
  const sent = []
  const tools = []
  const ctx = {
    logger: { warn() {} },
    get: () => ({ get: id => (id === coordinator.id ? coordinator : undefined) }),
    tools: { register(tool) { tools.push(tool); return () => {} } },
    on: () => () => {},
    effect: () => () => {},
    agentTeams: {
      async spawnTeammate(agent, input) {
        spawned.push({ team: input })
        return { member: { id: teammate.id, name: 'w-1' } }
      },
      async sendMessage(sender, input) { sent.push({ sender, input }) },
      async interrupt() {},
      listMembers() { return [] },
    },
    subagents: {
      async startActivation(spec) {
        spawned.push(spec)
        return {
          childId: teammate.id,
          messageId: 'msg-1',
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
      async sendMessage(sender, target, content, options) { sent.push({ sender, target, content, options }) },
      async interruptByParent() {},
      async listChildren() { return [] },
    },
  }
  try {
    await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 5 })
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    const created = await byName.task_create.execute({
      title: '修复空数据文案',
      goal: '空窗口时报表给出明确说明',
      constraints: ['只改 src/report.js'],
      acceptance: ['空窗口输出明确说明', 'npm test 全绿'],
      user_verbatim: '返回 {"a":1} 不是数组',
    }, { agent: coordinator })
    const taskId = created.match(/任务 (t-[0-9a-f]+)/)[1]
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].team, undefined)
    assert.equal(spawned[0].provider, 'spawn')
    assert.equal(spawned[0].delivery, 'caller')
    assert.equal(spawned[0].request.parent, coordinator)
    assert.match(spawned[0].request.prompt[0].text, /【验收标准】/)
    assert.throws(() => JSON.parse(spawned[0].request.prompt[0].text))
    assert.equal(spawned[0].request.prompt[0].text.includes('"title"'), false)

    await byName.task_report.execute({ task_id: taskId, status: 'progress', summary: '已定位分支' }, { agent: teammate })
    assert.equal(sent.length, 0)

    await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '改完，测试全绿' }, { agent: teammate })
    await wait(30)
    assert.equal(sent.length, 0)
    assert.equal(coordinator.injected.length, 1)
    assert.match(coordinator.injected[0].content[0].text, /任务「修复空数据文案」完成/)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
    const stored = db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId)
    db.close()
    assert.equal(stored.status, 'done')
    const card = taskCard({ id: taskId, title: stored.title, status: stored.status, session_id: teammate.id }, { summary: '改完，测试全绿' })
    assert.deepEqual(card, {
      taskId,
      title: '修复空数据文案',
      status: 'done',
      label: '已完成',
      tone: 'good',
      summary: '改完，测试全绿',
      childSessionId: teammate.id,
      queued: false,
      openVia: 'subagent-catalog',
      artifactCount: 0,
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
