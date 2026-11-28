import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  monthGrid, dateKeyOf, startOfMonth, planStampOnDay, planWhenLabel, clockOf,
  groupBoard, groupTasksOf, scheduleBucketOf, scheduleGroups, SCHEDULE_GROUP_LIMIT,
  plannedOnDay, nextPlannedTask, automationStateLabel, dependencyGraph, impactOf, GRAPH_METRICS,
  BRANCH_COLORS, elapsedTextOf,
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

// 关系图（未发布，issue #2）：布局是纯函数，单测直接断言几何与降级，不依赖浏览器。
test('dependencyGraph：DFS 长路径分层、边朝前置、层内换行、只读（不改入参）', () => {
  // 三点链：B 等 A、C 等 B（输入顺序故意打乱，验证按依赖分层而不是按入参顺序）。
  const chain = dependencyGraph([
    { id: 'A' },
    { id: 'C', dependsOn: ['B'] },
    { id: 'B', dependsOn: ['A'] },
  ])
  assert.deepEqual(Object.fromEntries(chain.nodes.map(node => [node.id, node.depth])), { A: 0, C: 2, B: 1 })
  // 边方向：from=下游、to=前置（箭头画在 to 端），按任务输入顺序产出。
  assert.deepEqual(chain.edges, [
    { from: 'C', to: 'B', cycle: false },
    { from: 'B', to: 'A', cycle: false },
  ])
  // 单列：宽 = nodeW + 2*pad；高 = pad*2 + 3*nodeH + 2*layerGap（G5 起 nodeH 76、layerGap 48）。
  assert.equal(chain.width, GRAPH_METRICS.nodeW + 2 * GRAPH_METRICS.pad)
  assert.equal(chain.height, 3 * GRAPH_METRICS.nodeH + 2 * GRAPH_METRICS.layerGap + 2 * GRAPH_METRICS.pad)
  assert.deepEqual([GRAPH_METRICS.nodeH, GRAPH_METRICS.layerGap], [76, 48], '卡高 76 + 层距 48：5 层单行 = 604px，仍在一屏')
  assert.ok(GRAPH_METRICS.nodeW >= 240, '卡宽至少 240：meta 行要同时放下耗时与更新时间')
  assert.ok(GRAPH_METRICS.maxWidth >= 4 * GRAPH_METRICS.nodeW + 3 * GRAPH_METRICS.gapX + 2 * GRAPH_METRICS.pad,
    '画布上限至少要容得下 4 张新宽度卡，别一加宽就退化成 3 列')
  const at = Object.fromEntries(chain.nodes.map(node => [node.id, node]))
  assert.deepEqual([at.A.x, at.A.y], [16, 16])
  assert.deepEqual([at.B.x, at.B.y], [16, 140])
  assert.deepEqual([at.C.x, at.C.y], [16, 264])
  // 森林多根 + 孤立节点：三个根都在第 0 层；孤立 = 无前置也无下游。
  const forest = dependencyGraph([
    { id: 'a1' }, { id: 'a2', dependsOn: ['a1'] }, { id: 'b1' }, { id: 'solo' },
  ])
  assert.deepEqual(Object.fromEntries(forest.nodes.map(node => [node.id, node.depth])), { a1: 0, a2: 1, b1: 0, solo: 0 })
  assert.deepEqual(forest.orphanIds.sort(), ['b1', 'solo'])
  assert.equal(forest.edges.length, 1)
  // 只读：布局不往入参写坐标/层级。
  const input = [{ id: 'r1' }, { id: 'r2', dependsOn: ['r1'] }]
  const before = JSON.stringify(input)
  dependencyGraph(input)
  assert.equal(JSON.stringify(input), before)
})

test('dependencyGraph 降级：环 / 自环 / 缺前置 / 组外节点 / 层内换行都不崩', () => {
  // 环：X↔Y，回边忽略但保留成 cycle 边，层级有限。
  const cycle = dependencyGraph([{ id: 'X', dependsOn: ['Y'] }, { id: 'Y', dependsOn: ['X'] }])
  assert.deepEqual(cycle.cycleIds.sort(), ['X', 'Y'])
  assert.ok(cycle.layerCount <= 2)
  assert.equal(cycle.edges.filter(edge => edge.cycle === true).length, 1)
  assert.equal(cycle.edges.length, 2)
  // 自环 + 重复 id：不画自环线，计入循环。
  const self = dependencyGraph([{ id: 'S', dependsOn: ['S', 'S'] }])
  assert.deepEqual(self.cycleIds, ['S'])
  assert.deepEqual(self.edges, [])
  assert.equal(self.nodes[0].depth, 0)
  // 缺失前置：不画边、不进节点，落第 0 层。
  const missing = dependencyGraph([{ id: 'M', dependsOn: ['t-gone'] }])
  assert.deepEqual(missing.missingIds, ['t-gone'])
  assert.deepEqual(missing.edges, [])
  assert.equal(missing.nodes[0].depth, 0)
  // 组外前置（一层）：照常参与分层与连线，有下游就不算孤立。
  const outside = dependencyGraph([{ id: 'in', dependsOn: ['out'] }, { id: 'out', external: true }])
  assert.deepEqual(outside.edges, [{ from: 'in', to: 'out', cycle: false }])
  assert.equal(outside.nodes.find(node => node.id === 'in').depth, 1)
  assert.equal(outside.orphanIds.includes('out'), false)
  // 层内换行：25 个孤立节点 → 画布不超上限、行数 = ceil(25/cols)、坐标互不重叠。
  const many = dependencyGraph(Array.from({ length: 25 }, (_, index) => ({ id: `p${index}` })))
  assert.equal(many.layerCount, 1)
  assert.ok(many.width <= GRAPH_METRICS.maxWidth, `画布宽 ${many.width} 超上限`)
  assert.ok(GRAPH_METRICS.maxWidth - many.width < GRAPH_METRICS.nodeW + GRAPH_METRICS.gapX, '换行后的画布应该贴住上限而不是被拉宽')
  const rows = new Set(many.nodes.map(node => node.y)).size
  assert.equal(rows, Math.ceil(25 / many.cols))
  assert.equal(new Set(many.nodes.map(node => `${node.x}:${node.y}`)).size, 25)
  // 脏数据：null / 无 id / dependsOn 非数组都当空处理。
  assert.equal(dependencyGraph(null).nodes.length, 0)
  assert.equal(dependencyGraph([null, { id: '' }, { id: 'ok', dependsOn: 'nope' }]).nodes.length, 1)
})

// 关系图 v2（未发布）：干道 = 最长链（`mainIds`），影响面 = 上游闭包 + 下游闭包（`impactOf`）。
// 两条纯函数各 5 条：三点链 / 分叉取最长 / 环 / 孤立点 / 扇入——都是这张图读法的必要事实。
test('mainIds · 三点链：干道按层序给（前置在前），不是入参顺序', () => {
  const chain = dependencyGraph([{ id: 'A' }, { id: 'C', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }])
  assert.deepEqual(chain.mainIds, ['A', 'B', 'C'])
})

test('mainIds · 分叉取最长：干道走最长路径，同长取入参先出现者', () => {
  // A→C 只有 2 层，A→B→D→E 有 4 层：干道必须选长的那条。
  const fork = dependencyGraph([
    { id: 'A' }, { id: 'C', dependsOn: ['A'] }, { id: 'B', dependsOn: ['A'] },
    { id: 'D', dependsOn: ['B'] }, { id: 'E', dependsOn: ['D'] },
  ])
  assert.deepEqual(fork.mainIds, ['A', 'B', 'D', 'E'])
  // 两条等长链：取入参里先出现的那条（a 链在 b 链前面）。
  const tie = dependencyGraph([{ id: 'a1' }, { id: 'a2', dependsOn: ['a1'] }, { id: 'b1' }, { id: 'b2', dependsOn: ['b1'] }])
  assert.deepEqual(tie.mainIds, ['a1', 'a2'])
})

test('mainIds · 环：回边不参与取链，不死循环（自环只留自己）', () => {
  assert.deepEqual(dependencyGraph([{ id: 'X', dependsOn: ['Y'] }, { id: 'Y', dependsOn: ['X'] }]).mainIds, ['Y', 'X'])
  assert.deepEqual(dependencyGraph([{ id: 'S', dependsOn: ['S'] }]).mainIds, ['S'])
})

test('mainIds · 孤立点：取入参第一个；没有节点就是空', () => {
  assert.deepEqual(dependencyGraph([{ id: 'i1' }, { id: 'i2' }]).mainIds, ['i1'])
  assert.deepEqual(dependencyGraph(null).mainIds, [])
})

test('mainIds · 扇入：三个等长前置按 dependsOn 顺序取第一个', () => {
  const fan = dependencyGraph([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4', dependsOn: ['f1', 'f2', 'f3'] }])
  assert.deepEqual(fan.mainIds, ['f1', 'f4'])
  assert.equal(new Set(fan.mainIds).size, fan.mainIds.length)
})

test('impactOf · 三点链：中段的上游 1 个、下游 1 个', () => {
  const chain = dependencyGraph([{ id: 'A' }, { id: 'B', dependsOn: ['A'] }, { id: 'C', dependsOn: ['B'] }])
  const mid = impactOf(chain, 'B')
  assert.deepEqual([...mid.up], ['A'])
  assert.deepEqual([...mid.down], ['C'])
  // 端点只亮一个方向。
  assert.deepEqual([...impactOf(chain, 'A').up], [])
  assert.deepEqual([...impactOf(chain, 'A').down].sort(), ['B', 'C'])
  assert.deepEqual([...impactOf(chain, 'C').down], [])
})

test('impactOf · 分叉：下游是整个分支合集，上游是整条祖先链', () => {
  const layout = dependencyGraph([
    { id: 'A' }, { id: 'B', dependsOn: ['A'] }, { id: 'C', dependsOn: ['A'] }, { id: 'D', dependsOn: ['B'] },
  ])
  assert.deepEqual([...impactOf(layout, 'A').down].sort(), ['B', 'C', 'D'])
  assert.deepEqual([...impactOf(layout, 'D').up].sort(), ['A', 'B'])
})

test('impactOf · 环：两个方向都只走一圈，自己不在集合里', () => {
  const cycle = dependencyGraph([{ id: 'X', dependsOn: ['Y'] }, { id: 'Y', dependsOn: ['X'] }])
  const spot = impactOf(cycle, 'X')
  assert.deepEqual([...spot.up], ['Y'])
  assert.deepEqual([...spot.down], ['Y'])
  assert.equal(spot.up.has('X'), false)
  assert.equal(spot.down.has('X'), false)
})

test('impactOf · 孤立点：两边都空；不存在的 id / 没有 edges 也不崩', () => {
  const solo = dependencyGraph([{ id: 'solo' }])
  assert.deepEqual([...impactOf(solo, 'solo').up], [])
  assert.deepEqual([...impactOf(solo, 'solo').down], [])
  assert.deepEqual([...impactOf(solo, 't-none').up], [])
  assert.deepEqual([...impactOf({}, 'x').down], [])
})

test('impactOf · 扇入：前置看全部分支，分支只看自己那条', () => {
  const fan = dependencyGraph([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4', dependsOn: ['f1', 'f2', 'f3'] }])
  assert.deepEqual([...impactOf(fan, 'f4').up].sort(), ['f1', 'f2', 'f3'])
  assert.deepEqual([...impactOf(fan, 'f1').down], ['f4'])
  assert.deepEqual([...impactOf(fan, 'f1').up], [])
})

// G3（未发布）：父卡悬于子卡群中点 —— 扇出对称、扇入落在父群中点、链仍是一列。
test('G3 布局：扇出父卡落在三个子卡的中点列', () => {
  const fan = dependencyGraph([{ id: 'p' }, { id: 'c1', dependsOn: ['p'] }, { id: 'c2', dependsOn: ['p'] }, { id: 'c3', dependsOn: ['p'] }])
  const x = Object.fromEntries(fan.nodes.map(node => [node.id, node.x]))
  const col = GRAPH_METRICS.nodeW + GRAPH_METRICS.gapX
  assert.deepEqual([x.p, x.c1, x.c2, x.c3], [GRAPH_METRICS.pad + col, GRAPH_METRICS.pad, GRAPH_METRICS.pad + col, GRAPH_METRICS.pad + 2 * col], '父 = 子群中间那列，子三等分')
  assert.equal(x.p + GRAPH_METRICS.nodeW / 2, (x.c1 + x.c3 + GRAPH_METRICS.nodeW) / 2, '父中心 = 首子与末子的中点')
})

test('G3 布局：扇入子卡落在父群中点（多父取均值）', () => {
  const fanIn = dependencyGraph([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', dependsOn: ['a', 'b', 'c'] }])
  const x = Object.fromEntries(fanIn.nodes.map(node => [node.id, node.x]))
  const col = GRAPH_METRICS.nodeW + GRAPH_METRICS.gapX
  assert.deepEqual([x.a, x.b, x.c], [GRAPH_METRICS.pad, GRAPH_METRICS.pad + col, GRAPH_METRICS.pad + 2 * col])
  assert.equal(x.d, GRAPH_METRICS.pad + col, '唯一子卡落在三个父卡的中点列')
})

test('G3 布局：三点链仍是一列（干道不散开）', () => {
  const chain = dependencyGraph([{ id: 'A' }, { id: 'B', dependsOn: ['A'] }, { id: 'C', dependsOn: ['B'] }])
  assert.deepEqual([...new Set(chain.nodes.map(node => node.x))], [16])
})

test('分支（连通分量）：同一条链同色、互不相连的节点不同组、色板 4 色且只用宿主状态色（色板 A）', () => {
  // 0.37.0 色板 A：6 → 4 色，去紫、删黄金角硬编码 hsl，只用宿主 4 个语义色（引用 --dsw-* token）。
  assert.equal(BRANCH_COLORS.length, 4)
  for (const color of BRANCH_COLORS) assert.match(color, /^var\(--dsw-alias-(state-business-primary|state-success-primary|state-warn-primary|label-tertiary), #[0-9a-f]{6}\)$/)
  // 去紫：色板里不能再出现 hsl 硬编码（黄金角散布那套已删）。
  for (const color of BRANCH_COLORS) assert.doesNotMatch(color, /hsl\(/)
  const layout = dependencyGraph([
    { id: 'a1' }, { id: 'a2', dependsOn: ['a1'] }, { id: 'b1' }, { id: 'b2', dependsOn: ['b1'] }, { id: 'solo' },
  ])
  const branch = Object.fromEntries(layout.nodes.map(node => [node.id, node.branch]))
  assert.equal(branch.a1, branch.a2, '链上的节点属于同一分支')
  assert.equal(branch.b1, branch.b2)
  assert.notEqual(branch.a1, branch.b1, '两条互不相连的链是两个分支')
  assert.notEqual(branch.solo, branch.a1, '孤立点自成分支')
  assert.ok(Object.values(branch).every(index => Number.isInteger(index) && index >= 0))
  // 超过 4 条分支时按 4 轮转（>4 复用前 4 色，信息损失可接受；与补丁 §2「>4 轮转」同口径）。
  const many = dependencyGraph(Array.from({ length: 6 }, (_, index) => ({ id: `n${index}` })))
  assert.ok(many.nodes.every(node => node.branch >= 0 && node.branch < 6))
  assert.equal(BRANCH_COLORS[many.nodes[4].branch % BRANCH_COLORS.length], BRANCH_COLORS[0], '第 5 条分支回到第 1 色')
})

test('elapsedTextOf：耗时按 创建→交付/终态更新时间/当下 取，缺 createdAt 不猜', () => {
  assert.equal(elapsedTextOf({ createdAt: 0, updatedAt: 30 * 60000, status: 'done' }), '耗时 30m')
  assert.equal(elapsedTextOf({ createdAt: 0, updatedAt: 90 * 60000, status: 'running' }, 90 * 60000), '耗时 2h')
  assert.equal(elapsedTextOf({ createdAt: 0, deliveredAt: 3 * 1440 * 60000, status: 'delivered' }, 9e12), '耗时 3d')
  assert.equal(elapsedTextOf({ status: 'running' }), '耗时 —', '组外前置没有 createdAt，不猜')
})

test('服务端字段口径：关系图耗时用 createdAt(ms)，不再把 progressCount 当交互步数', () => {
  const server = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8')
  assert.match(server, /createdAt: Number\.isFinite\(task\.created_at\)/)
  assert.match(server, /progressCount: Number\.isFinite\(task\.progress_count\)/)
  const wb = source('workbench.js')
  const start = wb.indexOf('const GraphView = (')
  const view = wb.slice(start, wb.indexOf('const GroupPage = (', start))
  assert.equal(view.includes('progressCount'), false, '关系图不应再展示 progressCount')
  assert.equal(view.includes(' 步'), false, '关系图不应再展示步数')
  assert.match(view, /\{external \? '' : elapsedTextOf\(task\)\}/, '关系图 meta 只保留耗时')
})

// 组件层：第三个只读 tab（源码是 JSX，测试进程不能 import，用源码断言 + 纯函数断言互补）。
test('关系图 tab（未发布）：第三个只读视图，节点/边只用 dependencyGraph，不引图表库、不发写请求', () => {
  const wb = source('workbench.js')
  for (const marker of ["'看板'", '产物 ${artifacts.length}', "'关系图'", 'dependencyGraph(', 'aria-label="组关系图"', '<svg']) {
    assert.ok(wb.includes(marker), `关系图缺少 ${marker}`)
  }
  // 关系图组件边界：从 GraphView 到 GroupPage，必须只读（不拖拽、不写动作、无输入框）。
  const start = wb.indexOf('const GraphView = (')
  assert.ok(start > 0, '找不到 GraphView 组件')
  const view = wb.slice(start, wb.indexOf('const GroupPage = (', start))
  for (const forbidden of ['draggable', 'onDragStart', 'workbenchAction', 'clientRequestId', 'confirm: true', '<input', '<form', 'onSubmit']) {
    assert.equal(view.includes(forbidden), false, `关系图里不该出现 ${forbidden}`)
  }
  // G2：不再用箭头 marker，改两端 circle 接点（方向靠「上=前置、下=下游」）。
  for (const marker of ['markerEnd', 'marker-end', '<marker']) {
    assert.equal(view.includes(marker), false, `关系图不应用 ${marker}（已改圆点接点）`)
  }
  assert.ok(view.includes('orch-wb-gjoint'), '关系图应有接点 circle')
  // 点击节点只打开详情（既有只读通道），不做别的。
  assert.match(view, /onClick=\{\(\) => onOpenDetail\(task\.id\)\}/)
  // 不引第三方图表库（纯 SVG + React）。
  for (const file of ['workbench.js', 'logic.js', 'views.js']) {
    assert.doesNotMatch(source(file), /echarts|recharts|\bd3\b/i, `${file} 不该引图表库`)
  }
  // 数据来自 group 投影的只读字段（客户端不合并快照、不加端点）。
  assert.match(wb, /state\.data\.graph\?\.external/)
  assert.equal(source('api.js').includes("endpoint: 'graph'"), false, '不新增 graph 端点')
})
