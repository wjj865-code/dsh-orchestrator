import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'

function fakeTeams({ failTimes = 0 } = {}) {
  const calls = []
  let failures = 0
  return {
    calls,
    async spawnTeammate(agent, input) {
      calls.push(['spawn', input])
      return { member: { id: 'm1', name: input.name } }
    },
    async sendMessage(agent, input) {
      calls.push(['send', input])
      if (failures < failTimes) {
        failures += 1
        throw new Error('网络抖动')
      }
      return { messageId: 'msg-1' }
    },
    async interrupt(agent, target) { calls.push(['interrupt', target]) },
    listMembers(agent) { calls.push(['members', agent]); return [{ id: 'm1', name: 'worker-1', status: 'inactive' }] },
  }
}

const agent = { id: 'a1' }

test('spawn 透传合法名字与渲染文本 prompt', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const member = await dispatcher.spawn({ name: 'worker-1', description: 'd', prompt: '【任务】x' })
  assert.equal(member.name, 'worker-1')
  const input = teams.calls[0][1]
  assert.deepEqual(input.prompt, [{ type: 'text', text: '【任务】x' }])
  assert.equal(input.description, 'd')
  assert.equal(input.context, 'fresh')
  assert.equal('provider' in input, false)
})

test('spawn 未给名字时生成 kebab 名', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  await dispatcher.spawn({ prompt: '【任务】😀' })
  assert.match(teams.calls[0][1].name, /^task-\d+-\d+$/)
})

test('显式 provider 才透传', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent, provider: 'spawn' })
  await dispatcher.spawn({ name: 'w-1', prompt: 'x' })
  assert.equal(teams.calls[0][1].provider, 'spawn')
})

test('send 与 stop 透传四方法之一', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  await dispatcher.send('worker-1', '继续')
  await dispatcher.stop('worker-1')
  assert.deepEqual(teams.calls.map(call => call[0]), ['send', 'interrupt'])
  assert.deepEqual(teams.calls[0][1], { target: 'worker-1', content: [{ type: 'text', text: '继续' }] })
  assert.equal(teams.calls[1][1], 'worker-1')
})

test('members 透传 listMembers', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const members = dispatcher.members()
  assert.equal(members[0].name, 'worker-1')
  assert.deepEqual(teams.calls[0], ['members', agent])
})

test('slug 化：中文、空格、标点、emoji 只留 kebab', () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const name = dispatcher.slug('修复 空数据 文案！😀')
  assert.match(name, /^[a-z0-9-]+$/)
  assert.match(name, /^task-\d+-\d+$/)
})

test('slug 连续调用不重名，且不超过 32 字符前缀', () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const a = dispatcher.slug('Fix the empty data message in report')
  const b = dispatcher.slug('Fix the empty data message in report')
  assert.notEqual(a, b)
  assert.match(a, /^[a-z0-9-]+$/)
  assert.ok(a.length <= 32 + 1 + String(Number.MAX_SAFE_INTEGER).length)
})

test('sendReliable 失败重试 3 次后成功', async () => {
  const teams = fakeTeams({ failTimes: 3 })
  const dispatcher = createDispatcher({ agentTeams: teams, agent, retryDelaysMs: [0, 0, 0] })
  const result = await dispatcher.sendReliable('worker-1', '继续')
  assert.deepEqual(result, { messageId: 'msg-1' })
  assert.equal(teams.calls.length, 4)
})

test('sendReliable 四次都失败后抛出可读错误', async () => {
  const teams = fakeTeams({ failTimes: 99 })
  const dispatcher = createDispatcher({ agentTeams: teams, agent, retryDelaysMs: [0, 0, 0] })
  await assert.rejects(() => dispatcher.sendReliable('worker-1', '继续'), /网络抖动/)
  assert.equal(teams.calls.length, 4)
})

test('未配置协调者时派活给出可读错误', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent: undefined })
  await assert.rejects(() => dispatcher.spawn({ name: 'w', prompt: 'x' }), /协调者会话/)
  await assert.rejects(() => dispatcher.send('w', 'x'), /协调者会话/)
  assert.equal(teams.calls.length, 0)
})

test('协调者会话后加载：getAgent 惰性解析', async () => {
  const teams = fakeTeams()
  let live
  const dispatcher = createDispatcher({ agentTeams: teams, getAgent: () => live })
  await assert.rejects(() => dispatcher.spawn({ name: 'w', prompt: 'x' }), /协调者会话/)
  live = agent
  const member = await dispatcher.spawn({ name: 'w', prompt: 'x' })
  assert.equal(member.name, 'w')
})
