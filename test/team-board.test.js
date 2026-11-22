// P2-4（D6）：官方 Team 板只读互通 + 确认反写（CAS）的单测。
//
// 重点不在「正常能读」，而在**边界**：服务缺失/形状变了/Team 未开启/读板抛错都要降级不抛；
// 反写必须带 `expectedRevision`，冲突只重读一次、只再试一次（不重试轰炸），失败绝不回滚本地交付。
// 全部用 fake `agentTeams`（宿主契约是 rc 级私有 API，不在测试里连真宿主）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeDelivered, CLOSE_REASONS } from '../src/delivered.js'
import { createTask, getTask, openLedger, transition } from '../src/ledger.js'
import {
  TEAM_BOARD_DISABLED, TEAM_BOARD_STALE, TEAM_BOARD_UNAVAILABLE, boardRowOf, confirmOnBoard,
  emitTeamBoardConfirm, linkBoardTask, readTeamBoard, setTeamBoardSink, shouldReverseConfirm, teamLinkStatusLine, teamLinkView,
} from '../src/team-board.js'
import { tempDir, sampleBrief } from './helpers.js'

const AGENT = { id: 's-1' }

/** 官方任务视图（rc.5 `TeamTaskView` 的形状；多给一个 description 验证只读投影会把它丢掉）。 */
const boardTask = (overrides = {}) => ({
  id: 'task-3',
  revision: 2,
  subject: '接线官方板',
  description: '16 KiB 正文不该进快照',
  status: 'in_progress',
  ownerId: 's-child',
  ownerName: 'w-1',
  blockedBy: ['task-1'],
  writeScopes: ['src/'],
  ready: false,
  writeScopeWarnings: [],
  ...overrides,
})

/** fake agentTeams：记录每一次调用，并按「启用/禁用/抛错/更新冲突」组合出行为。 */
function fakeTeams({ enabled = true, tasks = [boardTask()], failEnabled = false, failList = false, failUpdate } = {}) {
  const calls = []
  const state = tasks.map(task => ({ ...task }))
  return {
    calls,
    state,
    isEnabled(agent) {
      calls.push(['isEnabled', agent?.id ?? null])
      if (failEnabled) throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' })
      return enabled
    },
    listTasks() {
      calls.push(['listTasks'])
      if (failList) throw new Error('projection unavailable')
      return state.map(task => ({ ...task }))
    },
    async updateTask(agent, request) {
      calls.push(['updateTask', request])
      if (failUpdate !== undefined) throw failUpdate
      const current = state.find(task => task.id === request.taskId)
      if (current === undefined) throw Object.assign(new Error('not found'), { code: 'TEAM_TASK_NOT_FOUND' })
      if (current.revision !== request.expectedRevision) {
        throw Object.assign(new Error(`stale revision ${request.expectedRevision}`), { code: TEAM_BOARD_STALE })
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        status: request.action === 'complete' ? 'completed' : current.status,
      }
      const index = state.findIndex(task => task.id === request.taskId)
      state[index] = next
      return { ...next }
    },
  }
}

const teamsCalls = teams => teams.calls.filter(([kind]) => ['createTask', 'updateTask', 'claim', 'reassign'].includes(kind))

test('readTeamBoard：只读投影透传 id/revision/状态/负责人，丢掉 description 与冗余字段', () => {
  const teams = fakeTeams()
  const board = readTeamBoard({ agentTeams: teams, agent: AGENT })
  assert.deepEqual(board.degraded, null)
  assert.equal(board.enabled, true)
  assert.deepEqual(board.rows, [{
    id: 'task-3',
    revision: 2,
    subject: '接线官方板',
    status: 'in_progress',
    statusLabel: '进行中',
    owner: 'w-1',
    blockedBy: ['task-1'],
    writeScopes: ['src/'],
    ready: false,
  }])
  assert.equal('description' in board.rows[0], false, '快照不下发官方正文（每帧都发会把快照撑大）')
  assert.deepEqual(teams.calls, [['isEnabled', 's-1'], ['listTasks']])
  // 只读：全程没有任何写调用，更没有派发。
  assert.deepEqual(teamsCalls(teams), [])
})

test('readTeamBoard：limit 截断、坏行丢弃、ready/owner 缺省归一', () => {
  const rows = [boardTask({ id: 'task-1' }), boardTask({ id: 'task-2' }), boardTask({ id: '' }), boardTask({ id: 'task-4', ownerName: undefined, ownerId: undefined, ready: undefined })]
  const board = readTeamBoard({ agentTeams: fakeTeams({ tasks: rows }), agent: AGENT, limit: 2 })
  assert.deepEqual(board.rows.map(row => row.id), ['task-1', 'task-2'])
  const loose = readTeamBoard({ agentTeams: fakeTeams({ tasks: rows }), agent: AGENT })
  assert.deepEqual(loose.rows.map(row => row.id), ['task-1', 'task-2', 'task-4'], '空 id 的坏行被丢弃')
  assert.equal(loose.rows[2].owner, null)
  assert.equal(loose.rows[2].ready, false)
})

test('readTeamBoard：Team 未开启 → enabled:false 且**不读板**（别去撞官方 TEAM_DISABLED）', () => {
  const teams = fakeTeams({ enabled: false })
  const board = readTeamBoard({ agentTeams: teams, agent: AGENT })
  assert.deepEqual(board, { enabled: false, rows: [], degraded: null })
  assert.deepEqual(teams.calls, [['isEnabled', 's-1']])
})

test('readTeamBoard：服务缺失 / 形状不是板 API / agent 未加载 一律降级不抛', () => {
  const missing = readTeamBoard({ agentTeams: undefined, agent: AGENT })
  assert.equal(missing.enabled, false)
  assert.equal(missing.degraded.code, TEAM_BOARD_UNAVAILABLE)
  assert.match(missing.degraded.message, /agentTeams/)

  const legacy = readTeamBoard({ agentTeams: { spawnTeammate() {} }, agent: AGENT })
  assert.equal(legacy.degraded.code, TEAM_BOARD_UNAVAILABLE)
  assert.match(legacy.degraded.message, /isEnabled\/listTasks/)

  const noAgent = readTeamBoard({ agentTeams: fakeTeams(), agent: undefined })
  assert.equal(noAgent.enabled, false)
  assert.match(noAgent.degraded.message, /协调者会话未加载/)
})

test('readTeamBoard：isEnabled / listTasks 抛错都变 degraded（快照不能因为只读分区 500）', () => {
  const throwingEnabled = readTeamBoard({ agentTeams: fakeTeams({ failEnabled: true }), agent: AGENT })
  assert.equal(throwingEnabled.enabled, false)
  assert.equal(throwingEnabled.degraded.code, TEAM_BOARD_UNAVAILABLE)
  assert.match(throwingEnabled.degraded.message, /UNAUTHORIZED/)

  const throwingList = readTeamBoard({ agentTeams: fakeTeams({ failList: true }), agent: AGENT })
  assert.equal(throwingList.enabled, true)
  assert.deepEqual(throwingList.rows, [])
  assert.equal(throwingList.degraded.code, 'TEAM_BOARD_READ_FAILED')
})

test('linkBoardTask：只读校验存在并给出 revision；不 claim、不改官方任务', () => {
  const teams = fakeTeams()
  const linked = linkBoardTask({ agentTeams: teams, agent: AGENT, teamTaskId: 'task-3' })
  assert.deepEqual(linked, {
    ok: true,
    task: { id: 'task-3', revision: 2, status: 'in_progress', subject: '接线官方板' },
    note: '',
  })
  assert.deepEqual(teamsCalls(teams), [], '关联是只读的：不写官方板')

  // 待认领也能关联，但提前说清「确认时会被官方拒绝」。
  const pending = linkBoardTask({ agentTeams: fakeTeams({ tasks: [boardTask({ status: 'pending' })] }), agent: AGENT, teamTaskId: 'task-3' })
  assert.equal(pending.ok, true)
  assert.match(pending.note, /不是「进行中」/)
})

test('linkBoardTask：不存在 / 已完成 / Team 未开启 / 空 id 都明确拒绝（不静默忽略参数）', () => {
  const notFound = linkBoardTask({ agentTeams: fakeTeams(), agent: AGENT, teamTaskId: 'task-9' })
  assert.equal(notFound.ok, false)
  assert.equal(notFound.code, 'TEAM_TASK_NOT_FOUND')
  assert.match(notFound.reason, /现有：task-3/)

  const completed = linkBoardTask({ agentTeams: fakeTeams({ tasks: [boardTask({ status: 'completed' })] }), agent: AGENT, teamTaskId: 'task-3' })
  assert.equal(completed.ok, false)
  assert.equal(completed.code, 'TEAM_TASK_INVALID_TRANSITION')

  const disabled = linkBoardTask({ agentTeams: fakeTeams({ enabled: false }), agent: AGENT, teamTaskId: 'task-3' })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.code, TEAM_BOARD_DISABLED)
  assert.match(disabled.reason, /未开启/)

  const empty = linkBoardTask({ agentTeams: fakeTeams(), agent: AGENT, teamTaskId: '  ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'TEAM_TASK_ID_REQUIRED')
})

test('confirmOnBoard：成功路径带 action:complete 与台账记录的 expectedRevision（CAS）', async () => {
  const teams = fakeTeams()
  const result = await confirmOnBoard({
    agentTeams: teams,
    agent: AGENT,
    task: { id: 't-1', team_task_id: 'task-3', team_task_revision: 2 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.taskId, 'task-3')
  assert.equal(result.revision, 3)
  assert.equal(result.fromRevision, 2)
  assert.deepEqual(teams.calls.at(-1), ['updateTask', { taskId: 'task-3', expectedRevision: 2, action: 'complete' }])
})

test('confirmOnBoard：revision 冲突 → 只重读一次、只再试一次（不重试轰炸）', async () => {
  // 官方任务已被别人推进到 revision 3：第一次 CAS 冲突，重读后带着 3 再试一次。
  const teams = fakeTeams({ tasks: [boardTask({ revision: 3 })] })
  const result = await confirmOnBoard({ agentTeams: teams, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 2 } })
  assert.equal(result.ok, true)
  assert.equal(result.reRead, true)
  assert.equal(result.fromRevision, 3)
  const updates = teams.calls.filter(([kind]) => kind === 'updateTask').map(([, request]) => request.expectedRevision)
  assert.deepEqual(updates, [2, 3], '恰好两次：原基线 + 重读后的新值')
  assert.equal(teams.calls.filter(([kind]) => kind === 'listTasks').length, 1, '只重读一次')
})

test('confirmOnBoard：两次都冲突（并发写入）→ 停手报冲突，本地交付不受影响', async () => {
  // fake 每次 CAS 都失败：模拟「重读之后又被人抢先改了一次」。
  let reads = 0
  const teams = {
    calls: [],
    isEnabled: () => true,
    listTasks() {
      this.calls.push(['listTasks'])
      reads += 1
      return [boardTask({ revision: 10 + reads })]
    },
    async updateTask(agent, request) {
      this.calls.push(['updateTask', request])
      throw Object.assign(new Error(`stale ${request.expectedRevision}`), { code: TEAM_BOARD_STALE })
    },
  }
  const result = await confirmOnBoard({ agentTeams: teams, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 2 } })
  assert.equal(result.ok, false)
  assert.equal(result.code, TEAM_BOARD_STALE)
  assert.match(result.reason, /已停手/)
  assert.equal(teams.calls.filter(([kind]) => kind === 'updateTask').length, 2, '最多两次写尝试')
  assert.equal(teams.calls.filter(([kind]) => kind === 'listTasks').length, 1, '最多一次重读')
})

test('confirmOnBoard：未关联 / 服务缺失 / Team 未开启 → skipped（不打扰用户、不写板）', async () => {
  const unlinked = await confirmOnBoard({ agentTeams: fakeTeams(), agent: AGENT, task: { team_task_id: null } })
  assert.equal(unlinked.skipped, true)
  assert.equal(unlinked.code, 'TEAM_BOARD_UNLINKED')

  const teams = fakeTeams({ enabled: false })
  const disabled = await confirmOnBoard({ agentTeams: teams, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 1 } })
  assert.equal(disabled.skipped, true)
  assert.equal(disabled.code, TEAM_BOARD_DISABLED)
  assert.deepEqual(teamsCalls(teams), [])

  const missing = await confirmOnBoard({ agentTeams: undefined, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 1 } })
  assert.equal(missing.skipped, true)
  assert.equal(missing.code, TEAM_BOARD_UNAVAILABLE)

  const noRevision = await confirmOnBoard({ agentTeams: fakeTeams(), agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: null } })
  assert.equal(noRevision.ok, false)
  assert.equal(noRevision.warn, true)
  assert.equal(noRevision.code, 'TEAM_TASK_REVISION_UNKNOWN')
})

test('confirmOnBoard：官方拒绝（不在进行中）不重试，只报可读原因', async () => {
  const teams = fakeTeams({ failUpdate: Object.assign(new Error('only an in-progress task can complete'), { code: 'TEAM_TASK_INVALID_TRANSITION' }) })
  const result = await confirmOnBoard({ agentTeams: teams, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 2 } })
  assert.equal(result.ok, false)
  assert.equal(result.warn, true)
  assert.equal(result.code, 'TEAM_TASK_INVALID_TRANSITION')
  assert.match(result.reason, /in-progress/)
  assert.equal(teams.calls.filter(([kind]) => kind === 'updateTask').length, 1, '不是冲突就不重试')
})

test('teamLinkView / teamLinkStatusLine：没关联返回 null / 空串，有关联带官方当前行', () => {
  assert.equal(teamLinkView({ agentTeams: fakeTeams(), agent: AGENT, task: { team_task_id: null } }), null)
  assert.equal(teamLinkStatusLine({ team_task_id: null }), '')
  const view = teamLinkView({ agentTeams: fakeTeams(), agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 2 } })
  assert.equal(view.id, 'task-3')
  assert.equal(view.revision, 2)
  assert.equal(view.enabled, true)
  assert.equal(view.row.status, 'in_progress')
  const line = teamLinkStatusLine({ team_task_id: 'task-3', team_task_revision: 2 })
  assert.match(line, /task-3/)
  assert.match(line, /revision 2/)
  assert.match(line, /CAS/)
  // 官方不可读时：关联视图仍给台账那一半，row 为 null、degraded 有原因。
  const degraded = teamLinkView({ agentTeams: undefined, agent: AGENT, task: { team_task_id: 'task-3', team_task_revision: 2 } })
  assert.equal(degraded.row, null)
  assert.equal(degraded.degraded.code, TEAM_BOARD_UNAVAILABLE)
})

test('boardRowOf：坏值归一（不抛、不让快照出现 undefined）', () => {
  assert.deepEqual(boardRowOf({}), {
    id: '', revision: 0, subject: '', status: 'pending', statusLabel: '待认领',
    owner: null, blockedBy: [], writeScopes: [], ready: false,
  })
  assert.deepEqual(boardRowOf({ id: 'task-9', revision: 'x', status: 'weird', blockedBy: [1, 'task-1'], ownerId: 'c-1' }), {
    id: 'task-9', revision: 0, subject: '', status: 'weird', statusLabel: 'weird',
    owner: 'c-1', blockedBy: ['task-1'], writeScopes: [], ready: false,
  })
})

test('确认交付触发反写：closeDelivered 成功 → sink 收到任务与 acceptedBy；sink 抛错也不挡 done', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, {
    brief: sampleBrief({ title: '反写' }), coordinatorSession: 's-1',
  })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, task.id, 'delivered')
  db.prepare('UPDATE tasks SET team_task_id = ?, team_task_revision = ? WHERE id = ?').run('task-3', 2, task.id)

  const seen = []
  const dispose = setTeamBoardSink((closed, context) => { seen.push([closed.team_task_id, context?.acceptedBy ?? null]) })
  try {
    const outcome = closeDelivered({ db, taskId: task.id, reason: CLOSE_REASONS.coordinator, by: 'coordinator' })
    assert.equal(outcome.ok, true)
    assert.deepEqual(seen, [['task-3', 'coordinator']], 'sink 要拿到确认方式（超时路径由 sink 决定不反写）')
    assert.equal(getTask(db, task.id).status, 'done')
    // 幂等：重复确认不会再触发一次反写。
    closeDelivered({ db, taskId: task.id })
    assert.deepEqual(seen, [['task-3', 'coordinator']])
  } finally {
    dispose()
  }

  // 超时路径：closeDelivered 仍把 acceptedBy 交出去（sink 才可能记 skipped），但**不**在这里判断是否反写。
  const timeoutTask = createTask(db, { brief: sampleBrief({ title: '超时' }), coordinatorSession: 's-1' })
  transition(db, timeoutTask.id, 'running', { sessionId: 'c-t', target: 'c-t' })
  transition(db, timeoutTask.id, 'delivered')
  const timeoutSeen = []
  const timeoutDispose = setTeamBoardSink((closed, context) => { timeoutSeen.push(context?.acceptedBy ?? null) })
  try {
    assert.equal(closeDelivered({ db, taskId: timeoutTask.id, reason: CLOSE_REASONS.timeout, by: 'timeout' }).ok, true)
    assert.deepEqual(timeoutSeen, ['timeout'])
  } finally {
    timeoutDispose()
  }

  // 链式自动放行（chain:'auto'）也不是人的确认：sink 会拿到 acceptedBy='chain'，由 shouldReverseConfirm 决定不反写。
  const chainTask = createTask(db, { brief: sampleBrief({ title: '链式' }), coordinatorSession: 's-1' })
  transition(db, chainTask.id, 'running', { sessionId: 'c-c', target: 'c-c' })
  transition(db, chainTask.id, 'delivered')
  const chainSeen = []
  const chainDispose = setTeamBoardSink((closed, context) => { chainSeen.push(context?.acceptedBy ?? null) })
  try {
    assert.equal(closeDelivered({ db, taskId: chainTask.id, reason: CLOSE_REASONS.chain, by: 'chain' }).ok, true)
    assert.deepEqual(chainSeen, ['chain'])
    assert.equal(shouldReverseConfirm(chainSeen[0]), false, '链式自动放行不反写官方板')
  } finally {
    chainDispose()
  }

  // sink 同步抛错 / 异步拒绝都只是旁路：本地 done 必须已经落库。
  const task2 = createTask(db, { brief: sampleBrief({ title: '抛错' }), coordinatorSession: 's-1' })
  transition(db, task2.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  transition(db, task2.id, 'delivered')
  const dispose2 = setTeamBoardSink(() => { throw new Error('boom') })
  try {
    assert.equal(closeDelivered({ db, taskId: task2.id }).ok, true)
    assert.equal(getTask(db, task2.id).status, 'done')
  } finally {
    dispose2()
  }
  const rejectDispose = setTeamBoardSink(async () => { throw new Error('async boom') })
  const task3 = createTask(db, { brief: sampleBrief({ title: '异步抛错' }), coordinatorSession: 's-1' })
  transition(db, task3.id, 'running', { sessionId: 'c-3', target: 'c-3' })
  transition(db, task3.id, 'delivered')
  try {
    assert.equal(closeDelivered({ db, taskId: task3.id }).ok, true)
    assert.equal(getTask(db, task3.id).status, 'done')
  } finally {
    rejectDispose()
  }
  // 没接 sink 时是静默 no-op（`--experimental-test-isolation=none` 下别的用例可能留过 sink，
  // 所以这里显式清空一次，而不是假设进程级 sink 一定为空）。
  const clear = setTeamBoardSink(null)
  try {
    assert.equal(emitTeamBoardConfirm({ id: 't-none' }), null)
  } finally {
    clear()
  }
  db.close()
})
