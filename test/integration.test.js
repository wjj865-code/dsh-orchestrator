import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { taskCard } from '../src/card.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('集成冒烟：建任务 → 子会话 → 回报 → 卡片 → 交付通知 → 确认完成', async () => {
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
    const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].team, undefined)
    assert.equal(spawned[0].provider, 'spawn')
    assert.equal(spawned[0].delivery, 'caller')
    assert.equal(spawned[0].parent, coordinator)
    assert.match(spawned[0].prompt[0].text, new RegExp(`【任务编号】${taskId}`))
    assert.match(spawned[0].prompt[0].text, /task_detail/)
    assert.equal(spawned[0].prompt[0].text.includes('空窗口时报表给出明确说明'), false)
    assert.throws(() => JSON.parse(spawned[0].prompt[0].text))
    assert.equal(spawned[0].prompt[0].text.includes('"title"'), false)

    // T1：子会话按指引读详情（验收/约束/原话都在 task_detail 里）。
    const detail = await byName.task_detail.execute({ task_id: taskId }, { agent: teammate })
    assert.match(detail, /【验收标准】/)
    assert.match(detail, /【约束】/)
    assert.match(detail, /【用户原话】/)

    await byName.task_report.execute({ task_id: taskId, status: 'progress', summary: '已定位分支' }, { agent: teammate })
    assert.equal(sent.length, 0)

    await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '改完，测试全绿' }, { agent: teammate })
    await wait(30)
    assert.equal(sent.length, 0)
    assert.equal(coordinator.injected.length, 1)
    assert.match(coordinator.injected[0].content[0].text, /任务「修复空数据文案」已交付待确认/)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
    const delivered = db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId)
    db.close()
    // 两段式终态：回报 done = 交付待确认；协调者确认后才 done。
    assert.equal(delivered.status, 'delivered')
    const deliveredCard = taskCard({ id: taskId, title: delivered.title, status: delivered.status, session_id: teammate.id }, { summary: '改完，测试全绿' })
    assert.equal(deliveredCard.label, '待确认')
    assert.equal(deliveredCard.tone, 'warn')

    const closed = await byName.task_close.execute({ task_id: taskId }, { agent: coordinator })
    assert.match(closed, /已确认完成/)
    const confirmed = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
    const stored = confirmed.prepare('SELECT status, title, close_reason FROM tasks WHERE id = ?').get(taskId)
    confirmed.close()
    assert.equal(stored.status, 'done')
    assert.equal(stored.close_reason, 'coordinator')
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
