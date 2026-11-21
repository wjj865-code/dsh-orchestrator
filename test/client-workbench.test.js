import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  monthGrid, dateKeyOf, startOfMonth, planStampOnDay, planWhenLabel, clockOf,
  groupBoard, groupTasksOf, trayTasks, plannedOnDay, nextPlannedTask, automationStateLabel,
} from '../client/src/logic.js'
import { BOARD_COLUMNS, WORKBENCH_PAGES, WORKBENCH_POLL_MS, DEFAULT_PLAN_HOUR } from '../client/src/constants.js'

// 工作台 v1（P11）：纯逻辑直接 import 断言；JSX 组件的结构用源码断言
// （源码是 JSX，只有 vite 能编译，测试进程不能 import——与 test/client.test.js 的 dist vm 口径互补）。
const source = name => readFileSync(new URL(`../client/src/${name}`, import.meta.url), 'utf8')

test('工作台页面表：四页 + 组工作台子页；独立数据源 15s 分频（不跟 2s 快照）', () => {
  assert.deepEqual(WORKBENCH_PAGES.map(([key]) => key), ['overview', 'groups', 'schedule', 'automations'])
  assert.equal(WORKBENCH_POLL_MS, 15000)
  assert.ok(WORKBENCH_POLL_MS > 2000)
  assert.equal(DEFAULT_PLAN_HOUR, 20)
  // 看板 6 列覆盖台账全部状态（没有状态会掉在列外）。
  const covered = BOARD_COLUMNS.flatMap(column => column.statuses)
  for (const status of ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered', 'done', 'failed', 'cancelled', 'orphaned']) {
    assert.ok(covered.includes(status), `看板列漏了状态 ${status}`)
  }
  assert.equal(new Set(covered).size, covered.length, '同一状态只能落一列')
})

test('monthGrid：周一起始、固定 42 格、跨月补格、今天标记（翻月不跳高度）', () => {
  const today = new Date(2026, 10, 21, 10, 0, 0).getTime() // 2026-11-21 周六
  const grid = monthGrid(new Date(2026, 10, 1).getTime(), today)
  assert.equal(grid.year, 2026)
  assert.equal(grid.month, 10)
  assert.equal(grid.label, '2026 年 11 月')
  assert.equal(grid.cells.length, 42)
  // 2026-11-01 是周日 → 周一起始时，第一格是 10-26（周一）。
  assert.equal(grid.cells[0].key, '2026-10-26')
  assert.equal(new Date(grid.cells[0].ms).getDay(), 1)
  assert.equal(grid.cells[0].inMonth, false)
  const todayCell = grid.cells.find(cell => cell.key === '2026-11-21')
  assert.equal(todayCell.isToday, true)
  assert.equal(todayCell.inMonth, true)
  assert.equal(grid.cells.filter(cell => cell.inMonth).length, 30)
  // 2 月（非闰年）也只有 42 格。
  const feb = monthGrid(new Date(2026, 1, 1).getTime(), today)
  assert.equal(feb.cells.length, 42)
  assert.equal(feb.cells.filter(cell => cell.inMonth).length, 28)
  assert.equal(startOfMonth(new Date(2026, 10, 21).getTime()), new Date(2026, 10, 1).getTime())
})

test('planStampOnDay：拖到某天保留原时刻，没排过默认 20:00；非法日键返回 null', () => {
  const withHour = planStampOnDay('2026-11-22', new Date(2026, 10, 1, 9, 30, 0).getTime())
  const date = new Date(withHour)
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 10)
  assert.equal(date.getDate(), 22)
  assert.equal(date.getHours(), 9)
  assert.equal(date.getMinutes(), 30)
  const fresh = new Date(planStampOnDay('2026-11-22', null))
  assert.equal(fresh.getHours(), 20)
  assert.equal(fresh.getMinutes(), 0)
  assert.equal(planStampOnDay('nope', Date.now()), null)
  assert.equal(new Date(planStampOnDay('2026-11-22', null, 8)).getHours(), 8)
})

test('dateKeyOf / clockOf / planWhenLabel：本地时区口径一致', () => {
  const ms = new Date(2026, 0, 2, 7, 5, 0).getTime()
  assert.equal(dateKeyOf(ms), '2026-01-02')
  assert.equal(clockOf(ms), '07:05')
  assert.equal(planWhenLabel(ms), '1月2日 07:05')
  assert.equal(planWhenLabel(null), '未排期')
})

test('groupBoard：按列压任务，列内优先级↓ → 最近事件↓；任务状态不因渲染改变', () => {
  const tasks = [
    { id: 't-1', status: 'running', priority: 0, lastEventAt: 100 },
    { id: 't-2', status: 'running', priority: 3, lastEventAt: 50 },
    { id: 't-3', status: 'delivered', priority: 0, lastEventAt: 900 },
    { id: 't-4', status: 'failed', priority: 0, lastEventAt: 10 },
    { id: 't-5', status: 'cancelled', priority: 0, lastEventAt: 20 },
  ]
  const columns = groupBoard(tasks, BOARD_COLUMNS)
  const byKey = Object.fromEntries(columns.map(column => [column.key, column]))
  assert.deepEqual(byKey.running.tasks.map(task => task.id), ['t-2', 't-1'])
  assert.equal(byKey.running.count, 2)
  assert.deepEqual(byKey.delivered.tasks.map(task => task.id), ['t-3'])
  assert.deepEqual(byKey.failed.tasks.map(task => task.id).sort(), ['t-4', 't-5'])
  assert.equal(byKey.queue.count, 0)
  assert.deepEqual(tasks.map(task => task.status), ['running', 'running', 'delivered', 'failed', 'cancelled'], '渲染只读')
})

test('组任务 / 待排 / 今日排期 / 下一条：筛选口径', () => {
  const tasks = [
    { id: 'a', groupId: 'g1', status: 'running', plannedAt: null, canPlan: true, lastEventAt: 9 },
    { id: 'b', groupId: 'g1', status: 'done', plannedAt: null, canPlan: false, lastEventAt: 8 },
    { id: 'c', groupId: 'g2', status: 'pending', plannedAt: null, canPlan: true, lastEventAt: 7 },
    { id: 'd', groupId: null, status: 'delivered', plannedAt: null, canPlan: true, lastEventAt: 6 },
  ]
  assert.deepEqual(groupTasksOf(tasks, 'g1').map(task => task.id), ['a', 'b'])
  assert.deepEqual(groupTasksOf(tasks, null).map(task => task.id), ['d'])
  // 待排：活跃且没排期（终态不进去，排了也永远不会跑）。
  assert.deepEqual(trayTasks(tasks, Date.now()).map(task => task.id), ['a', 'c', 'd'])
  const planned = [
    { id: 'p1', status: 'running', plannedAt: new Date(2026, 10, 21, 20, 0, 0).getTime() },
    { id: 'p2', status: 'running', plannedAt: new Date(2026, 10, 21, 9, 0, 0).getTime() },
    { id: 'p3', status: 'running', plannedAt: new Date(2026, 10, 22, 9, 0, 0).getTime() },
  ]
  assert.deepEqual(plannedOnDay(planned, '2026-11-21').map(task => task.id), ['p2', 'p1'])
  assert.equal(nextPlannedTask(planned, new Date(2026, 10, 21, 10, 0, 0).getTime()).id, 'p1')
  assert.equal(nextPlannedTask([], Date.now()), null)
  assert.equal(automationStateLabel({ active: true, nextFireAt: Date.now() }).startsWith('下次'), true)
  assert.equal(automationStateLabel({ active: false }), '已暂停')
  assert.equal(automationStateLabel({ active: true, hostMissing: true }), '宿主侧已不存在')
})

test('dock 是只读的：源码里不出现输入框 / 发送按钮 / 提交动作（D3）', () => {
  const text = source('workbench.js')
  const start = text.indexOf('const Dock = (')
  assert.ok(start > 0, '找不到 Dock 组件')
  const end = text.indexOf('const GroupPage = (')
  assert.ok(end > start, 'Dock 组件边界不清晰')
  const dock = text.slice(start, end)
  for (const forbidden of ['<input', '<textarea', '<form', 'onSubmit', 'sendMessage', 'endpoint: \'message\'']) {
    assert.equal(dock.includes(forbidden), false, `dock 里不该出现 ${forbidden}`)
  }
  // 显式写清边界（防止后续需求「顺手」把输入框加回来）。
  assert.match(dock, /只读/)
  // 拖拽载荷里不能出现 orch- 前缀（否则会被样式自检当成 class）。
  const dragType = /export const DND_TYPE = '([^']+)'/.exec(text)
  assert.ok(dragType !== null, '缺少 DND_TYPE')
  assert.equal(dragType[1].includes('orch-'), false)
})

test('工作台只有三个写动作族 + 组/排期；客户端不提供派发、计划批准、追加消息（反例清单）', () => {
  const api = source('api.js')
  for (const endpoint of ['groups', 'group', 'calendar', 'automations', 'group-save', 'group-archive', 'plan-set', 'automation-save', 'automation-toggle', 'automation-delete']) {
    assert.ok(api.includes(`'${endpoint}'`), `缺少端点 ${endpoint}`)
  }
  for (const forbidden of ['task-create', 'plan-approve', 'close-all', 'patch-task']) {
    assert.equal(api.includes(`'${forbidden}'`), false, `客户端不该有 ${forbidden} 端点`)
  }
  // 工作台不复用面板的 message 通道（续派/追问仍只走协调者 task_message）。
  assert.equal(/workbenchAction\('message'/.test(api), false)
  assert.equal(api.includes('export const sendDockMessage'), false)
  // 写端点统一补 clientRequestId（幂等）与 confirm（危险动作在 workbenchAction 里显式传）。
  assert.match(api, /clientRequestId: payload\?\.clientRequestId \?\? newRequestId\(\)/)
  assert.match(api, /const workbenchAction = \(endpoint, payload\) => postEndpoint\(\{/)
})

test('面板没有第二个 main 槽位：工作台挂在同一个面板内部导航（不新增 main key）', () => {
  const client = source('client.js')
  const mainRegistrations = [...client.matchAll(/slots\.register\(\{\s*\n\s*name: 'main', key: ([A-Z_]+)/g)].map(match => match[1])
  assert.deepEqual(mainRegistrations, ['PANEL_ID', 'LAUNCHER_ID'], 'main 槽位仍只有面板 + 启动器两个 key')
  // 页面状态持久化用 sessionStorage（产物预览会卸载面板，回来要复原）。
  assert.match(source('views.js'), /WORKBENCH_STORAGE_KEY/)
})
