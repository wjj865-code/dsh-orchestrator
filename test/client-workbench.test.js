import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  monthGrid, dateKeyOf, startOfMonth, planStampOnDay, planWhenLabel, clockOf,
  groupBoard, groupTasksOf, scheduleBucketOf, scheduleGroups, SCHEDULE_GROUP_LIMIT,
  plannedOnDay, nextPlannedTask, automationStateLabel,
} from '../client/src/logic.js'
import { BOARD_COLUMNS, WORKBENCH_PAGES, WORKBENCH_POLL_MS, DEFAULT_PLAN_HOUR, REVIEW_DAYS } from '../client/src/constants.js'

// 工作台 v1（P11）：纯逻辑直接 import 断言；JSX 组件的结构用源码断言
// （源码是 JSX，只有 vite 能编译，测试进程不能 import——与 test/client.test.js 的 dist vm 口径互补）。
const source = name => readFileSync(new URL(`../client/src/${name}`, import.meta.url), 'utf8')

test('工作台页面表：五页 + 组工作台子页；独立数据源 15s 分频（不跟 2s 快照）', () => {
  assert.deepEqual(WORKBENCH_PAGES.map(([key]) => key), ['overview', 'groups', 'schedule', 'automations', 'review'])
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

test('组任务 / 今日排期 / 下一条：筛选口径', () => {
  const tasks = [
    { id: 'a', groupId: 'g1', status: 'running', plannedAt: null, canPlan: true, lastEventAt: 9 },
    { id: 'b', groupId: 'g1', status: 'done', plannedAt: null, canPlan: false, lastEventAt: 8 },
    { id: 'c', groupId: 'g2', status: 'pending', plannedAt: null, canPlan: true, lastEventAt: 7 },
    { id: 'd', groupId: null, status: 'delivered', plannedAt: null, canPlan: true, lastEventAt: 6 },
  ]
  assert.deepEqual(groupTasksOf(tasks, 'g1').map(task => task.id), ['a', 'b'])
  assert.deepEqual(groupTasksOf(tasks, null).map(task => task.id), ['d'])
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

// 排期页「待排期」是派生分组（方案 C），不是任务状态：状态机与 planned_at 语义都不动，
// 收窄的只是右栏怎么分组——running/delivered 不再被当成「还没排期」。
test('排期页派生分组（方案 C）：待排期只认 waiting_dep/pending 且没排期；进行中/待确认分开；已排期只留日历与下一条', () => {
  const planned = new Date(2026, 10, 22, 20, 0, 0).getTime()
  const tasks = [
    { id: 'dep', status: 'waiting_dep', plannedAt: null, lastEventAt: 1 },
    { id: 'pend', status: 'pending', plannedAt: null, lastEventAt: 9 },
    { id: 'run', status: 'running', plannedAt: null, lastEventAt: 8 },
    { id: 'user', status: 'waiting_user', plannedAt: null, lastEventAt: 7 },
    { id: 'auth', status: 'waiting_auth', plannedAt: null, lastEventAt: 6 },
    { id: 'deliv', status: 'delivered', plannedAt: null, lastEventAt: 5 },
    { id: 'planned-pend', status: 'pending', plannedAt: planned, lastEventAt: 4 },
    { id: 'planned-run', status: 'running', plannedAt: planned, lastEventAt: 3 },
    { id: 'done', status: 'done', plannedAt: null, lastEventAt: 2 },
    { id: 'failed', status: 'failed', plannedAt: null, lastEventAt: 1 },
  ]
  const groups = Object.fromEntries(scheduleGroups(tasks).map(group => [group.key, group]))
  assert.deepEqual(Object.keys(groups), ['tray', 'active', 'confirm'], '右栏固定三段')
  // 待排期只吃 waiting_dep/pending 且没排期的；running/delivered 不再混进来。
  assert.deepEqual(groups.tray.tasks.map(task => task.id), ['pend', 'dep'])
  assert.deepEqual(groups.active.tasks.map(task => task.id), ['run', 'user', 'auth'])
  assert.deepEqual(groups.confirm.tasks.map(task => task.id), ['deliv'])
  assert.deepEqual(groups.tray.tasks.map(task => task.id).includes('run'), false)
  // 已排期 → 只在月历与「下一条」；终态哪组都不进。
  assert.equal(scheduleBucketOf({ status: 'pending', plannedAt: planned }), 'scheduled')
  assert.equal(scheduleBucketOf({ status: 'running', plannedAt: planned }), 'scheduled')
  for (const status of ['done', 'failed', 'cancelled', 'orphaned', 'missing']) {
    assert.equal(scheduleBucketOf({ status }), null, `${status} 不该进右栏任何分组`)
  }
  assert.equal(scheduleBucketOf(null), null)
  // 组内最近事件↓；每组封顶 20 条（count 仍报真实命中数）。
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `p-${index}`, status: 'pending', plannedAt: null, lastEventAt: index }))
  const tray = scheduleGroups(many)[0]
  assert.equal(tray.tasks.length, SCHEDULE_GROUP_LIMIT)
  assert.equal(tray.count, 25)
  assert.equal(tray.tasks[0].id, 'p-24')
  // 渲染只读：分组不改状态、不动 plannedAt。
  assert.deepEqual(tasks.map(task => task.status), ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered', 'pending', 'running', 'done', 'failed'])
  assert.equal(tasks[6].plannedAt, planned)
  // 组件层：右栏按派生分组分段，只有「待排期」是拖回清除的落点（清除落点不按状态过滤）。
  const wb = source('workbench.js')
  assert.match(wb, /scheduleGroups\(tasks\)/)
  assert.match(wb, /group\.key === 'tray'/)
  assert.match(wb, /onClearPlan\(id\)/)
  assert.equal(wb.includes('trayTasks'), false, '旧的 tray 过滤已由派生分组取代')
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
  for (const endpoint of ['groups', 'group', 'calendar', 'automations', 'group-save', 'group-archive', 'plan-set', 'automation-toggle', 'automation-delete']) {
    assert.ok(api.includes(`'${endpoint}'`), `缺少端点 ${endpoint}`)
  }
  // 0.33.0：客户端不再有 `automation-save`——创建改走主会话里的官方 schedule_create
  // （面板只写草稿，不建任务）。服务端端点保留给兼容/脚本，但面板不动它。
  assert.equal(api.includes("'automation-save'"), false, '客户端不该再直连 automation-save')
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

test('复盘页（P11 阶段 3）：导航第 6 项、7/30 天窗口、三态齐全、只读（不引图表库/不加写口）', () => {
  const wb = source('workbench.js')
  // 导航与页面表同源：第 6 项是复盘，接在四个既有页之后（原 5 页不变）。
  assert.match(wb, /\['review', '复盘', null\]/, '一级导航要有复盘')
  assert.deepEqual(REVIEW_DAYS, [7, 30])
  const start = wb.indexOf('const ReviewPage = (')
  assert.ok(start > 0, '找不到 ReviewPage')
  const page = wb.slice(start, wb.indexOf('return { PageNav', start))
  // 三态：加载骨架 / 错误 Banner + 重试按钮 / 空态；数据来自 stats（只读）。
  for (const marker of ['SkeletonList', '<Banner', 'EmptyState', '重试', 'orch-wb-rstat', 'orch-wb-bartrack', 'orch-wb-autorow']) {
    assert.ok(page.includes(marker), `复盘页缺少 ${marker}`)
  }
  // 图表只用数字卡 + 横向条 + 排行行：不引图表库、不写 SVG 图表。
  assert.doesNotMatch(page, /echarts|chart\.js|d3|recharts/i)
  // 只读：复盘页不发写请求（写动作仍只有 group-save / plan-set / automation-*）。
  for (const forbidden of ['workbenchAction', 'clientRequestId', 'confirm: true']) {
    assert.equal(page.includes(forbidden), false, `复盘页不该出现 ${forbidden}`)
  }
  // 数据源与渲染都接上了 stats 端点，且窗口天数可切（7/30）。
  assert.match(source('api.js'), /endpoint: 'stats'/)
  assert.match(source('views.js'), /readStats\(/)
  assert.match(source('views.js'), /page === 'review' \? reviewPage\(\)/)
  assert.match(source('views.js'), /WORKBENCH_POLL_MS/)
})

test('面板没有第二个 main 槽位：工作台挂在同一个面板内部导航（不新增 main key）', () => {
  const client = source('client.js')
  const mainRegistrations = [...client.matchAll(/slots\.register\(\{\s*\n\s*name: 'main', key: ([A-Z_]+)/g)].map(match => match[1])
  // 0.32.0：能力包是独立 main panel（CAPABILITY_PACKS_PANEL_ID）；工作台仍在 orchestrator 面板内部导航。
  assert.deepEqual(mainRegistrations, ['PANEL_ID', 'LAUNCHER_ID', 'CAPABILITY_PACKS_PANEL_ID'], 'main 槽位：任务面板 + 启动器 + 能力包')
  // 页面状态持久化用 sessionStorage（产物预览会卸载面板，回来要复原）。
  assert.match(source('views.js'), /WORKBENCH_STORAGE_KEY/)
})

// 0.33.0：自动化创建对齐官方「会话创建」。
// 用户反馈的两个问题在这里钉死：
//   ① 自定义表单里「任务组」实际不可选（groups 数据源只在任务组页加载）→ 整块表单删除，只剩「全部任务」语义；
//   ② 「保存并启用」直接建任务 → 改为「创建自动化」按钮：打开主会话 + 预填提示词，由官方 schedule_create 建。
test('自动化创建入口（0.33.0）：面板只剩一个按钮，提示词写死本会话/全部任务/先核对三条决策', () => {
  const wb = source('workbench.js')
  const views = source('views.js')
  const constants = source('constants.js')
  // 自定义表单与「保存并启用」整块删除，不再有绑定对象/触发方式选择器。
  assert.equal(wb.includes('保存并启用'), false, '不再有「保存并启用」按钮')
  assert.equal(wb.includes('AutomationForm'), false, '不再有自定义创建表单')
  assert.equal(wb.includes('自动化绑定对象'), false, '不再有「任务组/全部任务」绑定对象选择器')
  assert.equal(constants.includes('AUTOMATION_KINDS'), false, '触发方式常量随表单删除')
  // 只剩一个创建按钮（官方 primary/small 样式 + plus 图标）+ 官方页入口。
  assert.match(wb, /data-orch-create-automation/)
  assert.match(wb, /orch-btn--primary/)
  assert.match(wb, /'创建自动化'/)
  assert.match(wb, /官方自动化任务页/)
  // 创建动作 = open-main → 打开主会话 → 预填（不再调 workbenchApi 的写端点）。
  assert.match(views, /const createAutomationEntry = async/)
  assert.match(views, /await openMainOnce\(\)/)
  assert.match(views, /openSessionWhenReady\(openSession, sessionId\)/, '刚建的主会话要等它进会话目录（retain 竞态）')
  assert.match(views, /prefillDraft\(sessionId, AUTOMATION_CREATE_PROMPT\)/)
  assert.equal(views.includes('workbenchApi.saveAutomation'), false, '面板不再调 saveAutomation')
  // 提示词三条既有决策：只投本会话 / 范围全部任务 / 先 task_list 核对再 task_create。
  assert.match(constants, /export const AUTOMATION_CREATE_PROMPT/)
  assert.match(constants, /target 用本会话，不要新建会话/)
  assert.match(constants, /全部任务（收件箱巡检）/)
  assert.match(constants, /先 task_list 核对再决定是否 task_create/)
  // 预填走官方草稿入口（client.js 注入），不是伪造 DOM / 不改 sessionStorage。
  const client = source('client.js')
  assert.match(client, /requestDraftInitialization/)
  assert.match(client, /whenDraftExists: 'append'/)
  assert.match(client, /prefillDraft: prefillMainDraft/)
  assert.match(client, /openSchedules: \(\) =>/)
})
