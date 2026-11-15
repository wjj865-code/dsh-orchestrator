import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, setTaskGoalState } from '../src/ledger.js'
import {
  GOAL_CAPABILITY_METHODS, createGoalBridge, goalStateOf, missingGoalMethods, objectiveForMessage,
} from '../src/goal.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeGoals() {
  const calls = []
  const state = { view: undefined }
  const goals = {
    calls,
    state,
    get(agent) {
      calls.push(['get', agent.id])
      return state.view
    },
    create(agent, request) {
      calls.push(['create', agent.id, request.objective])
      state.view = {
        id: 'goal-1', revision: 1, objective: request.objective, phase: 'active',
        activation: 'armed', maxGoalRounds: 256, roundsStarted: 0, createdAt: 1, updatedAt: 1,
      }
      return state.view
    },
    disarm(agent) {
      calls.push(['disarm', agent.id])
      state.view = { ...state.view, activation: 'disarmed' }
      return state.view
    },
    edit(agent, ref, request) {
      calls.push(['edit', agent.id, ref, request.objective])
      if (ref.revision !== state.view.revision) {
        const error = new Error('stale goal ref')
        error.code = 'GOAL_STALE_REVISION'
        throw error
      }
      state.view = { ...state.view, revision: state.view.revision + 1, objective: request.objective }
      return state.view
    },
    complete(agent, ref) {
      calls.push(['complete', agent.id, ref])
      state.view = { ...state.view, phase: 'complete', activation: 'disarmed', revision: state.view.revision + 1 }
      return state.view
    },
    clear(agent, ref) {
      calls.push(['clear', agent.id, ref])
      state.view = undefined
      return { id: ref.id, revision: ref.revision + 1 }
    },
  }
  return goals
}

function fakeAgents(initial = []) {
  const live = new Map(initial.map(id => [id, { id }]))
  return {
    live,
    get: id => live.get(id),
    add(id) {
      const agent = { id }
      live.set(id, agent)
      return agent
    },
  }
}

async function setup({ goals = fakeGoals(), agents = fakeAgents(['s-1']), onAgentCreated, onWarn } = {}) {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '目标任务', goal: '完成目标' }), coordinatorSession: 'c-1' })
  const bridge = createGoalBridge({
    db,
    goals: () => goals,
    agents: () => agents,
    onAgentCreated,
    onWarn,
    waitMs: 20,
  })
  return { db, task, bridge, goals, agents }
}

test('能力探测：缺方法即视为不可用（服务缺失返回全部）', () => {
  assert.deepEqual(missingGoalMethods(undefined), GOAL_CAPABILITY_METHODS)
  assert.deepEqual(missingGoalMethods({ get() {}, create() {}, disarm() {}, edit() {}, complete() {} }), ['clear'])
  const goals = fakeGoals()
  assert.deepEqual(missingGoalMethods(goals), [])
})

test('objectiveForMessage：把续派消息并成「最新指示」，重复消息文本稳定', () => {
  assert.equal(objectiveForMessage('原目标', '继续'), '原目标\n\n最新指示：继续')
  assert.equal(objectiveForMessage('原目标', '  继续  '), objectiveForMessage('原目标', '继续'))
  assert.equal(objectiveForMessage('原目标', '  '), '原目标')
  assert.equal(objectiveForMessage('', '只给消息'), '只给消息')
  const long = objectiveForMessage('g', 'x'.repeat(5000), 100)
  assert.equal(long.length, 100)
  assert.equal(long.endsWith('…'), true)
})

test('attach：create 后立刻 disarm（顺序固定），并把只读镜像写进台账', async () => {
  const { db, task, bridge, goals } = await setup()
  const state = await bridge.attach(task.id, 's-1', '完成目标')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create', 'disarm'])
  assert.equal(state.phase, 'active')
  assert.equal(state.activation, 'disarmed')
  const stored = getTask(db, task.id).goal_state
  assert.equal(stored.phase, 'active')
  assert.equal(stored.activation, 'disarmed')
  assert.equal(stored.objective, '完成目标')
  db.close()
})

test('attach：目标已存在时只 edit（文本变化）+ 保持 disarmed，不重复 create', async () => {
  const { db, task, bridge, goals, agents } = await setup()
  goals.state.view = {
    id: 'goal-old', revision: 3, objective: '旧目标', phase: 'active',
    activation: 'armed', maxGoalRounds: 256, roundsStarted: 1, createdAt: 1, updatedAt: 2,
  }
  await bridge.attach(task.id, 's-1', '新目标')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'edit', 'disarm'])
  assert.equal(goals.state.view.objective, '新目标')
  assert.equal(goals.state.view.activation, 'disarmed')
  assert.equal(agents.live.size, 1)
  db.close()
})

test('attach：子 agent 晚于派发出现时等 agent/created，再 create+disarm', async () => {
  let notify
  const agents = fakeAgents([])
  const { db, task, bridge, goals } = await setup({
    goals: fakeGoals(),
    agents,
    onAgentCreated: handler => { notify = handler },
  })
  const pending = bridge.attach(task.id, 's-9', '晚到的目标')
  await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(goals.calls.length, 0)
  notify(agents.add('s-9'))
  const state = await pending
  assert.equal(state.activation, 'disarmed')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create', 'disarm'])
  db.close()
})

test('update：目标文本变了才 edit；同一文本只确保 disarmed', async () => {
  const { db, task, bridge, goals } = await setup()
  await bridge.attach(task.id, 's-1', '原目标')
  // 模拟外部把 goal 重新 arm（例如宿主 /goal resume）：桥必须把它压回 disarmed。
  goals.state.view = { ...goals.state.view, activation: 'armed' }
  goals.calls.length = 0
  await bridge.update(task.id, 's-1', '原目标')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'disarm'])
  goals.state.view = { ...goals.state.view, activation: 'armed' }
  goals.calls.length = 0
  const state = await bridge.update(task.id, 's-1', '原目标\n\n最新指示：换方向')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'edit', 'disarm'])
  assert.match(state.objective, /换方向/)
  assert.equal(state.activation, 'disarmed')
  db.close()
})

test('update：目标缺失时补 create+disarm（能力晚挂载/旧任务）', async () => {
  const { db, task, bridge, goals } = await setup()
  const state = await bridge.update(task.id, 's-1', '补建目标')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create', 'disarm'])
  assert.equal(state.phase, 'active')
  assert.equal(getTask(db, task.id).goal_state.activation, 'disarmed')
  db.close()
})

test('complete：done 收敛为 complete；已 complete 不重复调用', async () => {
  const { db, task, bridge, goals } = await setup()
  await bridge.attach(task.id, 's-1', '完成目标')
  goals.calls.length = 0
  await bridge.complete(task.id, 's-1')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'complete'])
  assert.equal(getTask(db, task.id).goal_state.phase, 'complete')
  goals.calls.length = 0
  await bridge.complete(task.id, 's-1')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get'])
  db.close()
})

test('clear：stop/retry/orphaned 收敛为 cleared；无 live agent 时只收口台账镜像', async () => {
  const { db, task, bridge, goals, agents } = await setup()
  await bridge.attach(task.id, 's-1', '完成目标')
  goals.calls.length = 0
  await bridge.clear(task.id, 's-1')
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'clear'])
  assert.equal(getTask(db, task.id).goal_state.phase, 'cleared')
  // 孤儿场景：agent 已经不在注册表，镜像直接收口、不再调平台。
  agents.live.delete('s-1')
  goals.calls.length = 0
  const state = await bridge.clear(task.id, 's-1')
  assert.equal(state.phase, 'cleared')
  assert.deepEqual(goals.calls, [])
  db.close()
})

test('能力缺失：所有钩子静默 no-op（不抛、不写镜像、不 warn）', async () => {
  const warnings = []
  const goals = {} // 没有 GoalService
  const { db, task, bridge } = await setup({ goals, onWarn: message => warnings.push(message) })
  assert.equal(bridge.available(), false)
  assert.equal(await bridge.attach(task.id, 's-1', '目标'), undefined)
  assert.equal(await bridge.update(task.id, 's-1', '目标2'), undefined)
  assert.equal(await bridge.complete(task.id, 's-1'), undefined)
  assert.equal(await bridge.clear(task.id, 's-1'), undefined)
  assert.equal(getTask(db, task.id).goal_state, null)
  assert.deepEqual(warnings, [])
  db.close()
})

test('平台调用抛错：不冒泡，同类错误只 warn 一次', async () => {
  const warnings = []
  const goals = fakeGoals()
  goals.create = agent => {
    goals.calls.push(['create', agent.id])
    const error = new Error('goal service exploded')
    error.code = 'GOAL_UPSTREAM'
    throw error
  }
  const { db, task, bridge } = await setup({ goals, onWarn: message => warnings.push(message) })
  assert.equal(await bridge.attach(task.id, 's-1', '目标'), undefined)
  assert.equal(await bridge.attach(task.id, 's-1', '目标'), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /GOAL_UPSTREAM/)
  db.close()
})

test('stateOf：live 视图优先；无 live 时读台账镜像', async () => {
  const { db, task, bridge, goals, agents } = await setup()
  await bridge.attach(task.id, 's-1', '目标')
  assert.equal(bridge.stateOf(task.id, 's-1').objective, '目标')
  agents.live.delete('s-1')
  assert.equal(bridge.stateOf(task.id, 's-1').objective, '目标')
  goals.state.view = undefined
  agents.live.set('s-1', { id: 's-1' })
  assert.equal(bridge.stateOf(task.id, 's-1').phase, 'active')
  db.close()
})

test('goalStateOf：字段裁剪且不携带内部结构', () => {
  const state = goalStateOf({
    id: 'goal-1', revision: 2, objective: 'o', phase: 'active', activation: 'disarmed',
    roundsStarted: 1, maxGoalRounds: 256, updatedAt: 3, createdAt: 1, secret: 'x',
  })
  assert.deepEqual(state, {
    id: 'goal-1', revision: 2, objective: 'o', phase: 'active', activation: 'disarmed',
    roundsStarted: 1, maxGoalRounds: 256, updatedAt: 3,
  })
})

test('setTaskGoalState：坏 JSON 在读取时按无镜像处理', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 'c-1' })
  db.prepare('UPDATE tasks SET goal_state_json = ? WHERE id = ?').run('{bad', task.id)
  assert.equal(getTask(db, task.id).goal_state, null)
  setTaskGoalState(db, task.id, { phase: 'active' })
  assert.equal(getTask(db, task.id).goal_state.phase, 'active')
  db.close()
})
