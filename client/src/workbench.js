/**
 * 工作台 v1（P11）的页面组件：总览 / 任务组 / 组工作台 / 排期 / 自动化 + 右侧只读 dock。
 *
 * 边界（设计稿 §3，实施时不得放宽）：
 * - 只渲染数据与派发回调，**自己不发请求**（数据在 views.js 的 TasksPanel 里统一拉，便于一处节流）；
 * - dock **只读**：没有输入框、没有发送按钮，也没有「批准计划」入口——计划批准与追加消息只能走协调者；
 * - 看板列只承载筛选，**不支持拖拽改状态**（状态机是插件的核心，人只能通过既有面板动作改）；
 * - 排期拖拽只写 `planned_at`（L1），与自动化（L2）互不推导；键盘/触屏走 `PlanControl`（非拖拽路径）。
 *
 * 组件都是工厂里定义的闭包（与 views.js 同一套 React 注入，源码不 import react）。
 */
import {
  BOARD_COLUMNS, WEEKDAY_LABELS, DEFAULT_PLAN_HOUR, TONE_COLOR,
  REVIEW_DAYS,
} from './constants.js'
import {
  groupBoard, groupTasksOf, scheduleGroups, plannedOnDay, nextPlannedTask, planStampOnDay, planWhenLabel,
  clockOf, dateKeyOf, startOfMonth, monthGrid, automationStateLabel, displayNameOf, dependencyGraph,
  impactOf, elapsedTextOf, BRANCH_COLORS,
} from './logic.js'

/** 拖拽载荷类型（只在本页/本面板内流转，不写剪贴板；不含 orch- 前缀，免得被样式自检当成 class）。 */
export const DND_TYPE = 'application/x-dsh-task'

/** 看板空列的一句人话（原来只画一个「—」，不说这列为什么空）。 */
const BOARD_EMPTY = {
  queue: '没有等前置或待派发的任务',
  running: '没有在跑的任务',
  delivered: '没有等你确认的交付',
  asking: '没有等你决定的事',
  done: '还没有完成的任务',
  failed: '没有失败或取消的任务',
}

const pad = value => String(value).padStart(2, '0')

/** ms → `<input type="datetime-local">` 的本地值。 */
export function toLocalInput(ms) {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `<input type="datetime-local">` 的本地值 → ms（非法返回 null）。 */
export function fromLocalInput(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : null
}

const percent = (done, total) => (total > 0 ? Math.round((done / total) * 100) : 0)

export function createWorkbench({ React, h, Icon, Badge, Chip, EmptyState, Banner, SkeletonList, ConfirmDialog, confirmCopy, STATUS_LABEL }) {
  const { useState } = React

  const statusTone = status => (status === 'done' ? 'good'
    : status === 'failed' || status === 'orphaned' ? 'bad'
      : status === 'running' ? 'info'
        : status === 'delivered' || status === 'waiting_user' || status === 'waiting_auth' ? 'warn' : 'muted')

  const statusBadge = status => <Badge tone={statusTone(status)}>{STATUS_LABEL[status] || status || '未知'}</Badge>

  // ---- 一级导航（工作台内部六页；不新开 main 面板）----
  const PageNav = ({ page, onPage, inboxCount, groupCount, automationCount }) => (
    <nav className="orch-wb-nav" aria-label="工作台页面">
      {[['overview', '总览', null], ['groups', '任务组', groupCount], ['schedule', '排期', null], ['automations', '自动化', automationCount], ['review', '复盘', null]].map(([key, label, count]) => (
        <button
          key={key}
          type="button"
          className="orch-wb-navitem"
          data-active={page === key ? 'true' : 'false'}
          aria-pressed={page === key}
          onClick={() => onPage(key)}
        >
          <Icon name={key === 'overview' ? 'inbox' : key === 'groups' ? 'folder' : key === 'schedule' ? 'calendar' : key === 'review' ? 'check' : 'bolt'} size={13} />
          <span>{label}</span>
          {key === 'overview' && inboxCount > 0 ? <span className="orch-wb-navcount" data-tone="warn">{String(inboxCount)}</span> : null}
          {key !== 'overview' && Number.isFinite(count) && count > 0 ? <span className="orch-wb-navcount">{String(count)}</span> : null}
        </button>
      ))}
    </nav>
  )

  // ---- 总览：今天要做什么 → 下一条自动化 → 全量列表（列表由 views.js 传入） ----
  // 信息优先级：等你决定（状态条）→ 今日排期 → 在跑 → 全量。空态只留一句人话 + 一个动作，
  // 原来的整句说明书进 title（第一眼不读说明书）。
  const OverviewPage = ({ tasks, planned, nextAutomation, onOpenDetail, onPage, list }) => (
    <div className="orch-wb-page orch-wb-overview">
      <div className="orch-wb-cols">
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle"><Icon name="calendar" size={14} />{'今日排期'}</span>
            <span className="orch-wb-grow" />
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('schedule')}>{'打开排期'}</button>
          </header>
          {planned.length === 0
            ? (
                <EmptyState
                  icon="calendar"
                  title="今天没有排期"
                  hint="到「排期」把任务拖到日历上，或点任务卡的「排期」。"
                  action={<button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('schedule')}>{'去排期'}</button>}
                />
              )
            : (
                <ul className="orch-wb-today">
                  {planned.map(task => (
                    <li key={task.id}>
                      <button type="button" className="orch-wb-todayrow" onClick={() => onOpenDetail(task.id)} title={displayNameOf(task, tasks)}>
                        <span className="orch-wb-todaytime">{clockOf(task.plannedAt)}</span>
                        <span className="orch-wb-todaytitle">{displayNameOf(task, tasks)}</span>
                        {statusBadge(task.status)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </section>
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle"><Icon name="bolt" size={14} />{'自动化'}</span>
            <span className="orch-wb-grow" />
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('automations')}>{'打开'}</button>
          </header>
          {nextAutomation === null
            ? (
                <EmptyState
                  icon="bolt"
                  title="没有到点的自动化"
                  hint="到「自动化」建一条：到点由协调者核对后派单。"
                  action={<button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('automations')}>{'去建一条'}</button>}
                />
              )
            : (
                <div className="orch-wb-nextauto">
                  <div className="orch-wb-nextauto-top">
                    <span>{nextAutomation.title}</span>
                    <Badge tone={nextAutomation.active ? 'info' : 'muted'}>{nextAutomation.active ? '启用' : '已暂停'}</Badge>
                  </div>
                  <div className="orch-wb-nextauto-meta">{nextAutomation.timingText}{nextAutomation.nextFireAt ? ` · 下次 ${planWhenLabel(nextAutomation.nextFireAt)}` : ' · 下次触发未知'}</div>
                </div>
              )}
        </section>
      </div>
      {list}
    </div>
  )

  // ---- 任务组（组卡网格）----
  // 组卡只留「头部 / 目标 / 进度 / 统计 / 下次排期」五行；重命名与归档收进卡底操作条
  // （展开时卡高 +32），不再把表单塞进卡片中间。归档要二次确认（唯一实现 ConfirmDialog）。
  const GroupCard = ({ group, onOpen, onRename, onArchive }) => {
    const [menu, setMenu] = useState(false)
    const [draft, setDraft] = useState(group.name)
    const [archiveConfirm, setArchiveConfirm] = useState(false)
    const counts = group.counts || {}
    const donePercent = percent(counts.done || 0, counts.total || 0)
    const copy = confirmCopy.archive
    return (
      <div
        className="orch-wb-gcard"
        data-archived={group.archived ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        onClick={() => onOpen(group.id)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(group.id) } }}
      >
        <div className="orch-wb-ghead">
          <span className="orch-wb-gdot" style={{ background: group.color ? `var(--dsw-alias-state-business-primary, #4d6bfe)` : TONE_COLOR.info }} />
          <span className="orch-wb-gname" title={group.name}>{group.name}</span>
          {group.archived ? <Chip>{'已归档'}</Chip> : null}
          {group.automationCount > 0
            ? <Chip title="这个组挂了几条自动化"><Icon name="bolt" size={10} />{`${group.automationActiveCount}/${group.automationCount}`}</Chip>
            : null}
          <span className="orch-wb-grow" />
          <button
            type="button" className="orch-btn orch-btn--quiet orch-btn--sm"
            title="重命名 / 归档" aria-label="重命名或归档这个组" aria-expanded={menu}
            onClick={event => { event.stopPropagation(); setMenu(!menu) }}
          ><Icon name="menu" size={14} /></button>
        </div>
        <div className="orch-wb-gmeta">{group.goal || `组键 ${group.id}`}</div>
        <div className="orch-wb-gbar" aria-hidden="true"><span style={{ width: `${donePercent}%` }} /></div>
        <div className="orch-wb-gstats">
          <span>{`${counts.done || 0}/${counts.total || 0} 完成`}</span>
          {counts.delivered > 0 ? <Badge tone="warn">{`待确认 ${counts.delivered}`}</Badge> : null}
          {counts.active > 0 ? <Badge tone="info">{`在跑 ${counts.active}`}</Badge> : null}
          {counts.failed > 0 ? <Badge tone="bad">{`失败 ${counts.failed}`}</Badge> : null}
        </div>
        <div className="orch-wb-gfoot">
          <span>{group.nextPlannedAt ? `下次排期 ${planWhenLabel(group.nextPlannedAt)}` : '未排期'}</span>
          <span>{`产物 ${group.artifactCount || 0}`}</span>
          {group.virtual ? <span className="orch-muted">{'未命名'}</span> : null}
        </div>
        {menu
          ? (
              <form
                className="orch-wb-gactbar"
                onClick={event => event.stopPropagation()}
                onSubmit={event => { event.preventDefault(); onRename(group.id, draft); setMenu(false) }}
              >
                <input
                  className="orch-input" value={draft} maxLength={40} aria-label="组名"
                  onChange={event => setDraft(event.target.value)}
                />
                <button type="submit" className="orch-btn orch-btn--primary orch-btn--sm">{'保存'}</button>
                <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => { setDraft(group.name); setMenu(false) }}>{'取消'}</button>
                <span className="orch-wb-grow" />
                <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => setArchiveConfirm(true)}>
                  {group.archived ? '取消归档…' : '归档…'}
                </button>
              </form>
            )
          : null}
        {archiveConfirm
          ? (
              <ConfirmDialog
                title={group.archived ? '取消归档这个组？' : copy[0]}
                note={copy[1]}
                confirmLabel={group.archived ? '确认取消归档' : '确认归档'}
                onConfirm={() => { setArchiveConfirm(false); setMenu(false); onArchive(group.id, !group.archived) }}
                onCancel={() => setArchiveConfirm(false)}
              />
            )
          : null}
      </div>
    )
  }

  const GroupsPage = ({ state, onReload, onOpen, onRename, onArchive, ungrouped }) => {
    if (state.data === null) {
      return state.error !== null
        ? <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`组读取失败：${state.error}`}</Banner>
        : <SkeletonList rows={4} />
    }
    if (state.error !== null) {
      return <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`组读取失败（显示上一次结果）：${state.error}`}</Banner>
    }
    const groups = state.data.groups || []
    if (groups.length === 0) {
      return (
        <EmptyState
          icon="folder"
          title="还没有任务组"
          hint="组来自 task_create({ group })，让协调者按组派单。"
          action={<button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onReload}>{'刷新'}</button>}
        />
      )
    }
    return (
      <div className="orch-wb-groups">
        {groups.map(group => (
          <GroupCard key={group.id} group={group} onOpen={onOpen} onRename={onRename} onArchive={onArchive} />
        ))}
        {ungrouped !== null && ungrouped.total > 0
          ? (
              <div
                className="orch-wb-gcard" data-virtual="true" role="button" tabIndex={0}
                onClick={() => onOpen(null)}
                onKeyDown={event => { if (event.key === 'Enter') onOpen(null) }}
              >
                <div className="orch-wb-ghead">
                  <span className="orch-wb-gdot" style={{ background: TONE_COLOR.muted }} />
                  <span className="orch-wb-gname">{'未分组'}</span>
                  <span className="orch-wb-grow" />
                </div>
                <div className="orch-wb-gmeta">{'没有 group 的任务（不落库、不可改名）'}</div>
                <div className="orch-wb-gstats">
                  <span>{`共 ${ungrouped.total}`}</span>
                  {ungrouped.delivered > 0 ? <Badge tone="warn">{`待确认 ${ungrouped.delivered}`}</Badge> : null}
                  {ungrouped.active > 0 ? <Badge tone="info">{`在跑 ${ungrouped.active}`}</Badge> : null}
                  {ungrouped.failed > 0 ? <Badge tone="bad">{`失败 ${ungrouped.failed}`}</Badge> : null}
                </div>
              </div>
            )
          : null}
      </div>
    )
  }

  // ---- 排期控件（非拖拽路径：键盘/触屏都能用）----
  // 时间空/非法时「保存」禁用 + title 说明（不再静默 return：点了没反应是最难查的坏交互）。
  const PlanControl = ({ task, onPlan, compact }) => {
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState(() => toLocalInput(task.plannedAt ?? Date.now()))
    const valid = fromLocalInput(value) !== null
    const submit = () => {
      const ms = fromLocalInput(value)
      if (ms === null) return
      onPlan(task.id, ms)
      setOpen(false)
    }
    return (
      <span className="orch-wb-plan">
        <button
          type="button" className={compact ? 'orch-btn orch-btn--quiet orch-btn--sm' : 'orch-btn orch-btn--quiet'}
          onClick={() => { setValue(toLocalInput(task.plannedAt ?? Date.now())); setOpen(!open) }}
          title={task.plannedAt ? '修改排期' : '排到某天'}
          aria-expanded={open}
        >
          <Icon name="calendar" size={12} />{task.plannedAt ? planWhenLabel(task.plannedAt) : '排期'}
        </button>
        {open
          ? (
              <span className="orch-wb-planform">
                <input
                  type="datetime-local" className="orch-input" value={value} aria-label="排期时间"
                  onChange={event => setValue(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
                />
                <button
                  type="button" className="orch-btn orch-btn--primary orch-btn--sm"
                  disabled={!valid}
                  title={valid ? '保存这条排期' : '先选一个时间再保存'}
                  onClick={submit}
                >{'保存'}</button>
                {task.plannedAt
                  ? <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => { onPlan(task.id, null); setOpen(false) }}>{'清除'}</button>
                  : null}
                <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => setOpen(false)}>{'取消'}</button>
              </span>
            )
          : null}
      </span>
    )
  }

  const TaskCard = ({ task, tasks, onOpenDetail, onPlan, draggable }) => (
    <div
      className="orch-wb-tcard"
      data-tone={statusTone(task.status)}
      draggable={draggable === true}
      onDragStart={draggable === true
        ? event => { event.dataTransfer.setData(DND_TYPE, task.id); event.dataTransfer.effectAllowed = 'move' }
        : undefined}
    >
      <button type="button" className="orch-wb-ttitle" onClick={() => onOpenDetail(task.id)} title={task.title}>
        {displayNameOf(task, tasks)}
      </button>
      <div className="orch-wb-tmeta">
        {statusBadge(task.status)}
        {task.plannedAt ? <Chip title="计划日"><Icon name="clock" size={10} />{planWhenLabel(task.plannedAt)}</Chip> : null}
        {task.priority ? <Chip title="优先级">{`P${task.priority}`}</Chip> : null}
        {task.dependencies > 0 ? <Chip title="依赖数">{`依赖 ${task.dependencies}`}</Chip> : null}
        {task.artifactCount > 0 ? <Chip title="产物数">{`产物 ${task.artifactCount}`}</Chip> : null}
        {task.question ? <Chip tone="warn" title={task.question}>{'等你回答'}</Chip> : null}
        {task.planFirst === true && ['planning', 'waiting_user', 'revising'].includes(task.planState) ? <Chip tone="warn">{'计划待批'}</Chip> : null}
        {task.worktreeState && task.worktreeState !== 'none' ? <Chip title={task.worktreeBranch || ''}>{'隔离'}</Chip> : null}
      </div>
      <div className="orch-wb-tfoot">
        <span className="orch-msg-at">{`更新 ${task.updatedAt ? planWhenLabel(task.updatedAt) : '-'}`}</span>
        <span className="orch-wb-grow" />
        {task.canPlan === false ? null : <PlanControl task={task} onPlan={onPlan} compact />}
      </div>
    </div>
  )

  // ---- 关系图（未发布，只读）：竖直分层 + 干道（最长链）+ 影响面高亮 + 分支色 / 单段 S 曲线 ----
  // 布局纯函数在 logic.js（dependencyGraph / impactOf / elapsedTextOf / BRANCH_COLORS）；
  // 这里只把坐标摊成 SVG 边层（一条线 + 两端接点）与绝对定位节点层。
  // 只读：节点是 button（点开详情抽屉），边层 pointer-events:none；没有拖拽、没有写动作、没有按钮。
  const GraphView = ({ tasks, truncated, onOpenDetail }) => {
    // 一个状态（focusId）同时服务「追上游」「拖垮谁」「只看某条链」：hover 与键盘焦点都写它。
    const [focusId, setFocusId] = useState(null)
    const layout = dependencyGraph(tasks)
    const at = new Map(layout.nodes.map(node => [node.id, node]))
    const byId = new Map(tasks.map(task => [task.id, task]))
    const main = new Set(layout.mainIds)
    const impact = focusId === null ? null : impactOf(layout, focusId)
    const lit = impact === null ? null : new Set([focusId, ...impact.up, ...impact.down])
    const colorOf = branch => BRANCH_COLORS[branch % BRANCH_COLORS.length]
    // 说明行（只放「解释」不放术语）：正常情况不出现任何文字，方向与归属靠图自己表达。
    const note = layout.cycleIds.length > 0
      ? `有 ${layout.cycleIds.length} 个任务在循环依赖里，相关连线用红色虚线标出。`
      : layout.missingIds.length > 0
        ? `有 ${layout.missingIds.length} 个前置任务已不存在，连线画不出来。`
        : layout.edges.length === 0
          ? '组内任务还没有互相依赖。'
          : null
    // 层带：每层一条（奇偶交替上底色），纵向取该层节点的包围盒 + 上下半个层距。
    const band = new Map()
    for (const node of layout.nodes) {
      const row = band.get(node.depth)
      band.set(node.depth, row === undefined
        ? { y: node.y, bottom: node.y + node.h }
        : { y: Math.min(row.y, node.y), bottom: Math.max(row.bottom, node.y + node.h) })
    }
    // 边（G2）：直连 = 单段竖直 S 贝塞尔，i = clamp(24, 96, 两接点间距/2)，两端各离卡 6px；
    // 跨层（depth 差 ≥2）/ 夹在同层中间行 / 环的回边 = 右侧通道（x = width - 8，多条 3px 错开），
    // 同样两端离卡 6px。接点用 circle 不用 marker：方向靠「上=前置、下=下游」表达。
    let lane = 0
    const edgeShape = edge => {
      const from = at.get(edge.from)
      const to = at.get(edge.to)
      const x1 = from.x + from.w / 2
      const y1 = from.y - 6
      const x2 = to.x + to.w / 2
      const y2 = to.y + to.h + 6
      const topRow = from.y === band.get(from.depth).y
      const lastRow = to.y + to.h === band.get(to.depth).bottom
      if (from.depth - to.depth === 1 && topRow && lastRow) {
        const i = Math.min(96, Math.max(24, (y1 - y2) / 2))
        return { direct: true, d: `M${x1} ${y1}C${x1} ${y1 - i} ${x2} ${y2 + i} ${x2} ${y2}`, x1, y1, x2, y2 }
      }
      const ch = layout.width - 8 - 3 * (lane++ % 3)
      const exit = y1 - (topRow ? 18 : 0)
      const entry = lastRow ? y2 + 4 : to.y - 9
      const tip = lastRow ? y2 : to.y - 6
      return {
        direct: false,
        d: `M${x1} ${y1}C${x1} ${exit} ${ch} ${exit} ${ch} ${exit}C${ch} ${entry} ${ch} ${entry} ${ch} ${entry}C${ch} ${entry} ${x2} ${entry} ${x2} ${tip}`,
        x1,
        y1,
        x2,
        y2: tip,
      }
    }
    const externalCount = layout.nodes.filter(node => byId.get(node.id)?.external === true).length
    return (
      <div className="orch-wb-graphwrap">
        {truncated
          ? <div className="orch-muted">{`组太大，图只画了一部分任务（最多 300 条任务${externalCount > 0 ? '、最多 60 个其它组的前置' : ''}）。`}</div>
          : null}
        <div className="orch-wb-graph" style={{ width: `${layout.width}px`, height: `${layout.height}px` }} role="group" aria-label="组关系图">
          <svg className="orch-wb-gedges" width={layout.width} height={layout.height} aria-hidden="true">
            {[...band].map(([depth, row]) => (
              <rect
                key={`band${depth}`}
                className="orch-wb-gband"
                data-band={depth % 2 === 0 ? 'even' : 'odd'}
                data-depth={depth}
                x={0}
                y={row.y - 12}
                width={layout.width}
                height={row.bottom - row.y + 24}
              />
            ))}
            {layout.edges.map(edge => {
              const shape = edgeShape(edge)
              const color = edge.cycle ? TONE_COLOR.bad : colorOf(at.get(edge.from).branch)
              const onChain = lit !== null && lit.has(edge.from) && lit.has(edge.to)
              return (
                <g key={`${edge.from}>${edge.to}`}>
                  <path
                    className="orch-wb-gedge"
                    data-route={shape.direct ? 'direct' : 'channel'}
                    data-cycle={edge.cycle ? 'true' : 'false'}
                    data-main={main.has(edge.from) && main.has(edge.to) ? 'true' : 'false'}
                    data-focus={focusId !== null && (edge.from === focusId || edge.to === focusId) ? 'true' : 'false'}
                    data-lit={onChain ? 'true' : 'false'}
                    data-dim={lit !== null && !onChain ? 'true' : 'false'}
                    d={shape.d}
                    style={{ stroke: color }}
                  />
                  <circle className="orch-wb-gjoint" cx={shape.x1} cy={shape.y1} r={edge.from === focusId ? 3 : 2} style={{ fill: color }} />
                  <circle className="orch-wb-gjoint" cx={shape.x2} cy={shape.y2} r={edge.to === focusId ? 3 : 2} style={{ fill: color }} />
                </g>
              )
            })}
          </svg>
          {layout.nodes.map(node => {
            const task = byId.get(node.id)
            const external = task.external === true
            // 第二行只放「卡在哪、多急」= 待前置 N + P{priority}；**状态只由 11px 圆点表达**（不印状态字）。
            // 两者都没有时这一行留空（圆点仍在）：卡高固定 76、行高固定 14，所以层级节奏不跳、不需要第三层补位。
            // 状态的可访问性兜底走卡片 title，不新增可见文案；别组来的前置用一句人话说明它来自哪个组。
            const groupName = task.groupName || '未分组'
            const facts = external
              ? (groupName === '未分组' ? '前置在未分组任务上' : `前置在「${groupName}」组`)
              : [
                ['waiting_dep', 'pending'].includes(task.status) && task.dependencies > 0 ? `待前置 ${task.dependencies}` : '',
                task.priority ? `P${task.priority}` : '',
              ].filter(Boolean).join(' · ')
            const statusLabel = STATUS_LABEL[task.status] || task.status || '未知'
            return (
              <button
                key={node.id}
                type="button"
                className="orch-wb-tcard orch-wb-gnode"
                data-external={external ? 'true' : 'false'}
                data-main={main.has(node.id) ? 'true' : 'false'}
                data-focus={focusId === node.id ? 'true' : 'false'}
                data-dim={lit !== null && !lit.has(node.id) ? 'true' : 'false'}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.w}px`,
                  height: `${node.h}px`,
                  borderTopColor: colorOf(node.branch),
                }}
                title={`${task.title} · ${statusLabel}`}
                onMouseEnter={() => setFocusId(node.id)}
                onMouseLeave={() => setFocusId(null)}
                onFocus={() => setFocusId(node.id)}
                onBlur={() => setFocusId(null)}
                onClick={() => onOpenDetail(task.id)}
              >
                <span className="orch-wb-ttitle">{displayNameOf(task, tasks)}</span>
                <span className="orch-wb-gfactline">
                  <span
                    className="orch-wb-gdot"
                    role="img"
                    aria-label={statusLabel}
                    style={{ background: TONE_COLOR[statusTone(task.status)] }}
                  />
                  <span className="orch-wb-gfact">{facts}</span>
                </span>
                <span className="orch-wb-gmeta">
                  <span>{external ? '' : `${elapsedTextOf(task)} · ${task.progressCount ?? 0} 步`}</span>
                  <span>{external || !task.updatedAt ? '' : `更新 ${planWhenLabel(task.updatedAt)}`}</span>
                </span>
              </button>
            )
          })}
        </div>
        {note === null ? null : <div className="orch-muted">{note}</div>}
      </div>
    )
  }


  // 只读 dock：没有输入框、没有发送按钮、也没有「批准计划」入口——派单与追问问协调者。
  // 正文固定顺序：身份 → 状态 → 问题 → 最近 3 条；页脚压成一行（「只读」两字保留）。
  const Dock = ({ detail, group, onOpenSession, onJumpMain }) => {
    const task = detail?.task ?? null
    const messages = Array.isArray(detail?.messages) ? detail.messages.slice(-3) : []
    return (
      <aside className="orch-wb-dock" aria-label="任务上下文（只读）">
        <header className="orch-wb-dockhead">
          <span className="orch-wb-cardtitle">{'上下文'}</span>
          <span className="orch-muted">{'只读'}</span>
        </header>
        <div className="orch-wb-dockbody">
          {task === null && group === null ? <div className="orch-muted">{'点任务卡或组卡看这里的上下文。'}</div> : null}
          {task !== null
            ? (
                <div className="orch-stack orch-stack--sm">
                  <div className="orch-wb-docktitle">{task.title}</div>
                  <div className="orch-card-meta">
                    {statusBadge(task.status)}
                    <span className="orch-msg-at">{`引用 ${task.ref || '—'}`}</span>
                  </div>
                  {task.question
                    ? (
                        <div className="orch-wb-question">
                          <div className="orch-kv-key">{'它在等你决定'}</div>
                          <div className="orch-text">{task.question}</div>
                          {Array.isArray(task.options) && task.options.length > 0
                            ? <ul className="orch-ul">{task.options.map((option, index) => <li key={index}>{option}</li>)}</ul>
                            : null}
                          <div className="orch-muted">{'回答走协调者的提问卡，这里不能代答。'}</div>
                        </div>
                      )
                    : null}
                  {messages.length === 0
                    ? <div className="orch-muted">{'还没有消息记录。'}</div>
                    : (
                        <ul className="orch-wb-msgs">
                          {messages.map(message => (
                            <li key={message.seq} className="orch-msg">
                              <div className="orch-card-meta">
                                <span className="orch-msg-at">{planWhenLabel(message.at)}</span>
                                <span>{message.kind}</span>
                              </div>
                              <div className="orch-msg-text">{message.text}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                  {task.target ? <button type="button" className="orch-btn orch-btn--sm" onClick={() => onOpenSession(task.target)}>{'打开子会话'}</button> : null}
                </div>
              )
            : null}
          {task === null && group !== null
            ? (
                <div className="orch-stack orch-stack--sm">
                  <div className="orch-wb-docktitle">{group.name}</div>
                  <div className="orch-muted">{group.goal || `组键 ${group.id}`}</div>
                  <div className="orch-card-meta">
                    <Badge tone="good">{`完成 ${group.counts.done}`}</Badge>
                    <Badge tone="info">{`在跑 ${group.counts.active}`}</Badge>
                    <Badge tone="warn">{`待确认 ${group.counts.delivered}`}</Badge>
                  </div>
                </div>
              )
            : null}
        </div>
        <footer className="orch-wb-dockfoot">
          <div className="orch-muted">{'只读 · 派单与追问问协调者。'}</div>
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onJumpMain}>{'到主会话说'}</button>
        </footer>
      </aside>
    )
  }

  const GroupPage = ({ state, groupId, onBack, onReload, onOpenDetail, onPlan, onPreview, onCopy, dock, onOpenMain, onRename, onArchive }) => {
    const [tab, setTab] = useState('board')
    const [renaming, setRenaming] = useState(false)
    const [draftName, setDraftName] = useState('')
    const [archiveStep, setArchiveStep] = useState(0)
    if (state.data === null) {
      return (
        <div className="orch-wb-page">
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onBack}>{'← 返回任务组'}</button>
          {state.error !== null
            ? <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`组读取失败：${state.error}`}</Banner>
            : <SkeletonList rows={4} />}
        </div>
      )
    }
    const group = state.data.group
    const tasks = state.data.tasks || []
    const columns = groupBoard(tasks, BOARD_COLUMNS)
    const artifacts = state.data.artifacts || []
    // 关系图节点 = 本组任务（补组名）+ 服务端解析的一层组外前置（虚线幽灵节点）。
    const graphNodes = tab !== 'graph' ? [] : [
      ...tasks.map(task => ({ ...task, groupName: group.name })),
      ...(Array.isArray(state.data.graph?.external) ? state.data.graph.external : [])
        .filter(row => !tasks.some(task => task.id === row.id))
        .map(row => ({ ...row, external: true, groupName: row.groupName || row.groupId || '未分组' })),
    ]
    return (
      <div className="orch-wb-page orch-wb-grouppage">
        <header className="orch-wb-grouphead">
          <div className="orch-wb-grouphead-main">
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onBack}>{'← 返回任务组'}</button>
            <span className="orch-wb-gname orch-wb-gname--big">{group.name}</span>
            {group.archived ? <Chip>{'已归档'}</Chip> : null}
            <span className="orch-wb-grow" />
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onOpenMain}>{'打开主会话'}</button>
          </div>
          <div className="orch-wb-grouphead-sub">
            <span className="orch-muted">{group.goal || `组键 ${group.id}`}</span>
            <span className="orch-muted">{`${tasks.length} 个任务 · ${artifacts.length} 个产物`}</span>
            <span className="orch-wb-grow" />
            {group.canRename
              ? (renaming
                  ? (
                      <span className="orch-wb-inline">
                        <input
                          className="orch-input" value={draftName} maxLength={40} aria-label="组名"
                          onChange={event => setDraftName(event.target.value)}
                          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onRename(group.id, draftName); setRenaming(false) } }}
                        />
                        <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={() => { onRename(group.id, draftName); setRenaming(false) }}>{'保存'}</button>
                        <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => setRenaming(false)}>{'取消'}</button>
                      </span>
                    )
                  : (
                      <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => { setDraftName(group.name); setRenaming(true) }}>{'重命名'}</button>
                    ))
              : null}
            {group.canArchive
              ? <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => setArchiveStep(1)}>{group.archived ? '取消归档' : '归档'}</button>
              : null}
          </div>
          {group.canArchive && archiveStep === 1
            ? (
                <ConfirmDialog
                  title={group.archived ? '取消归档这个组？' : confirmCopy.archive[0]}
                  note={confirmCopy.archive[1]}
                  confirmLabel={group.archived ? '确认取消归档' : '确认归档'}
                  onConfirm={() => { setArchiveStep(0); onArchive(group.id, !group.archived) }}
                  onCancel={() => setArchiveStep(0)}
                />
              )
            : null}
        </header>
        <div className="orch-wb-split">
          <div className="orch-wb-main">
            <div className="orch-wb-tabs" role="tablist" aria-label="组视图">
              <button type="button" role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'orch-wb-tab is-on' : 'orch-wb-tab'} onClick={() => setTab('board')}>{'看板'}</button>
              <button type="button" role="tab" aria-selected={tab === 'artifacts'} className={tab === 'artifacts' ? 'orch-wb-tab is-on' : 'orch-wb-tab'} onClick={() => setTab('artifacts')}>{`产物 ${artifacts.length}`}</button>
              <button type="button" role="tab" aria-selected={tab === 'graph'} className={tab === 'graph' ? 'orch-wb-tab is-on' : 'orch-wb-tab'} onClick={() => setTab('graph')}>{'关系图'}</button>
            </div>
            {tasks.length === 0
              ? <EmptyState icon="inbox" title="这个组还没有任务" hint="让协调者按这个组派单：task_create({ group: '…' })。" />
              : null}
            {tab === 'board' && tasks.length > 0
              ? (
                  <div className="orch-wb-board">
                    {columns.map(column => (
                      <section key={column.key} className="orch-wb-column" data-tone={column.tone} aria-label={column.label}>
                        <header className="orch-wb-colidx">
                          <span>{column.label}</span>
                          <span className="orch-wb-navcount">{String(column.count)}</span>
                        </header>
                        <div className="orch-wb-colbody">
                          {column.count === 0 ? <div className="orch-muted orch-wb-colempty">{BOARD_EMPTY[column.key] || '这一列是空的'}</div> : null}
                          {column.tasks.map(task => (
                            <TaskCard key={task.id} task={task} tasks={tasks} onOpenDetail={onOpenDetail} onPlan={onPlan} />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )
              : null}
            {tab === 'artifacts'
              ? (artifacts.length === 0
                  ? <EmptyState icon="folder" title="这个组还没有产物" hint="子会话回报时带的产物会出现在这里。" />
                  : (
                      <div className="orch-wb-main">
                        {artifacts.map(artifact => (
                          <div key={`${artifact.taskId}:${artifact.path}`} className="orch-wb-arow">
                            <Icon name="folder" size={14} />
                            <span className="orch-wb-aname" title={artifact.path}>{artifact.path.split(/[\\/]/).pop()}</span>
                            <span className="orch-wb-ameta" title={artifact.path}>{artifact.taskTitle}</span>
                            <span className="orch-wb-aactions">
                              {/* 合并入口：「预览」在会话右侧栏打开（与「右侧栏」同能力，取 inline=false 那一路：
                                  组页没有行内预览落点，不能假装打开成功）。 */}
                              <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" title="在会话右侧栏打开（离开当前页；返回面板回到看板）" onClick={() => onPreview(artifact.taskId, artifact.path)}>{'预览'}</button>
                              <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => onCopy(artifact.path)}>{'复制路径'}</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    ))
              : null}
            {tab === 'graph' && graphNodes.length > 0
              ? <GraphView tasks={graphNodes} truncated={state.data.graph?.truncated === true} onOpenDetail={onOpenDetail} />
              : null}
          </div>
          {dock}
        </div>
      </div>
    )
  }

  // 排期页右栏是**派生分组**（待排期 / 进行中 / 待确认），不属于状态机：「待排期」只吃
  // waiting_dep/pending 且没有计划日的任务；有计划日的只在月历与「下一条」出现。
  // 拖拽语义不变：任一组的卡片都能拖到日历某天排期，拖回「待排期」或点「清除」取消（落点不按状态过滤）。
  const SchedulePage = ({ state, tasks, anchor, onAnchor, onPlan, onClearPlan, onOpenDetail, onReload }) => {
    const [dragOver, setDragOver] = useState(null)
    const grid = monthGrid(anchor, Date.now())
    const taskById = new Map(tasks.map(task => [task.id, task]))
    const byDay = new Map()
    for (const day of (state.data?.days ?? [])) byDay.set(day.date, day)
    const groups = scheduleGroups(tasks)
    const next = nextPlannedTask(tasks, Date.now())
    const monthDays = [...byDay.keys()].filter(key => key.startsWith(`${grid.year}-${pad(grid.month + 1)}`))
    const monthTaskCount = monthDays.reduce((sum, key) => sum + (byDay.get(key)?.tasks.length ?? 0), 0)
    const monthAutomationCount = monthDays.reduce((sum, key) => sum + (byDay.get(key)?.automations.length ?? 0), 0)
    const dropOn = (key, event) => {
      event.preventDefault()
      setDragOver(null)
      const id = event.dataTransfer.getData(DND_TYPE)
      if (id === '') return
      const task = taskById.get(id)
      const stamp = planStampOnDay(key, task?.plannedAt, DEFAULT_PLAN_HOUR)
      if (stamp !== null && task !== undefined && task.canPlan !== false) onPlan(id, stamp)
    }
    return (
      <div className="orch-wb-page orch-wb-schedule">
        <header className="orch-wb-calhead">
          <button
            type="button" className="orch-btn orch-btn--quiet orch-btn--sm"
            onClick={() => onAnchor(startOfMonth(new Date(grid.year, grid.month - 1, 1).getTime()))}
            aria-label="上个月"
          ><Icon name="chevron" size={14} style={{ transform: 'rotate(90deg)' }} /></button>
          <span className="orch-wb-calmonth">{grid.label}</span>
          <button
            type="button" className="orch-btn orch-btn--quiet orch-btn--sm"
            onClick={() => onAnchor(startOfMonth(new Date(grid.year, grid.month + 1, 1).getTime()))}
            aria-label="下个月"
          ><Icon name="chevron" size={14} style={{ transform: 'rotate(-90deg)' }} /></button>
          <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={() => onAnchor(startOfMonth(Date.now()))}>{'今天'}</button>
          <span className="orch-wb-grow" />
          <span className="orch-muted">{`本月排期 ${monthTaskCount} 条 · 自动化触发 ${monthAutomationCount} 次`}</span>
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onReload}>{'刷新'}</button>
        </header>
        {state.error !== null
          ? <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`排期读取失败：${state.error}`}</Banner>
          : null}
        <div className="orch-wb-split">
          <div className="orch-wb-main">
            <div className="orch-wb-weekhead" aria-hidden="true">
              {WEEKDAY_LABELS.map(label => <span key={label}>{`周${label}`}</span>)}
            </div>
            {state.data === null
              ? <SkeletonList rows={4} />
              : (
                  <div className="orch-wb-grid" role="grid" aria-label="排期月历">
                    {grid.cells.map(cell => {
                      const day = byDay.get(cell.key)
                      const items = day?.tasks ?? []
                      const automations = day?.automations ?? []
                      return (
                        <div
                          key={cell.key}
                          role="gridcell"
                          aria-label={`${cell.key}${items.length > 0 ? `，${items.length} 条排期` : '，没有排期'}`}
                          className="orch-wb-day"
                          data-outside={cell.inMonth ? 'false' : 'true'}
                          data-today={cell.isToday ? 'true' : 'false'}
                          data-over={dragOver === cell.key ? 'true' : 'false'}
                          onDragOver={event => { event.preventDefault(); setDragOver(cell.key) }}
                          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(current => (current === cell.key ? null : current)) }}
                          onDrop={event => dropOn(cell.key, event)}
                        >
                          <div className="orch-wb-dayhead">
                            <span className="orch-wb-daynum">{cell.day}</span>
                            <span className="orch-wb-grow" />
                            {automations.length > 0
                              ? <span className="orch-wb-dayauto" title={automations.map(row => `${row.title}（${row.timingText}）`).join('\n')}><Icon name="bolt" size={10} />{String(automations.length)}</span>
                              : null}
                          </div>
                          <div className="orch-wb-dayitems">
                            {items.slice(0, 2).map(item => (
                              <button
                                key={item.id} type="button" className="orch-wb-chip"
                                onClick={() => onOpenDetail(item.id)}
                                title={item.title}
                                aria-label={`${clockOf(item.plannedAt)}，打开任务 ${item.title}`}
                              >
                                <span className="orch-wb-chiptime">{clockOf(item.plannedAt)}</span>
                                <span className="orch-wb-chiptitle">{item.title}</span>
                              </button>
                            ))}
                            {items.length > 2 ? <span className="orch-muted orch-wb-more">{`还有 ${items.length - 2} 条`}</span> : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
          </div>
          <aside className="orch-wb-rail">
            {/* 右栏合成一张卡：下一条 + 三个派生分组，段间 1px 分隔（原来四张同权重卡各带卡头）。 */}
            <section className="orch-wb-card">
              <header className="orch-wb-cardhead"><span className="orch-wb-cardtitle">{'下一条'}</span></header>
              {next === null
                ? <div className="orch-muted">{'没有未来排期'}</div>
                : (
                    <button type="button" className="orch-wb-next" onClick={() => onOpenDetail(next.id)}>
                      <span className="orch-wb-nexttime">{planWhenLabel(next.plannedAt)}</span>
                      <span className="orch-wb-nexttitle">{next.title}</span>
                      {statusBadge(next.status)}
                    </button>
                  )}
              {groups.map(group => (
                <div
                  key={group.key}
                  className={group.key === 'tray' ? 'orch-wb-trayseg orch-wb-tray' : 'orch-wb-trayseg'}
                  aria-label={group.label}
                  {...(group.key === 'tray'
                    ? {
                        onDragOver: event => event.preventDefault(),
                        onDrop: event => {
                          event.preventDefault()
                          const id = event.dataTransfer.getData(DND_TYPE)
                          if (id !== '') onClearPlan(id)
                        },
                      }
                    : {})}
                >
                  <header className="orch-wb-cardhead">
                    <span className="orch-wb-cardtitle">{group.label}</span>
                    <span className="orch-muted">{group.count > group.tasks.length ? `${group.tasks.length} / ${group.count} 条` : `${group.count} 条`}</span>
                  </header>
                  {group.tasks.length === 0
                    ? <div className="orch-muted">{group.empty}</div>
                    : (
                        <div className="orch-wb-traylist">
                          {group.tasks.map(task => (
                            <div
                              key={task.id}
                              className="orch-wb-traycard"
                              draggable
                              onDragStart={event => { event.dataTransfer.setData(DND_TYPE, task.id); event.dataTransfer.effectAllowed = 'move' }}
                            >
                              <button type="button" className="orch-wb-ttitle" onClick={() => onOpenDetail(task.id)}>{task.title}</button>
                              <div className="orch-wb-tmeta">{statusBadge(task.status)}{task.groupId ? <Chip>{task.groupId}</Chip> : <Chip tone="muted">{'未分组'}</Chip>}</div>
                            </div>
                          ))}
                        </div>
                      )}
                  {group.hint === null ? null : <div className="orch-muted">{group.hint}</div>}
                </div>
              ))}
            </section>
          </aside>
        </div>
      </div>
    )
  }

  // 自动化（0.33.0）：创建入口收敛为**一个按钮**，对齐 DSH 官方「在会话中创建」。
  // 面板不再自己调 schedule 接口建任务：点按钮 → 打开唯一主会话 + 预填提示词 → 由协调者在该会话里
  // 用官方 schedule_create 创建（默认绑定主会话）。右侧自定义表单（绑定对象/触发方式/星期/标题/
  // 到点做什么/授权勾选）整块删除：现在只有「全部任务（收件箱巡检）」一种范围语义，写在提示词里。
  // 列表仍只读本插件的镜像表（宿主任务请去官方「自动化任务」页看，入口在卡尾）。
  // 0.37.0：卡头只留主操作（创建）；行压到 56 高两段；删除走 ConfirmDialog（不再一点就删）。
  const AutomationsPage = ({ state, busy, onReload, onCreate, onOpenSchedules, onToggle, onDelete }) => {
    const [deleteId, setDeleteId] = useState(null)
    if (state.data === null) {
      return <SkeletonList rows={3} />
    }
    const data = state.data
    const rows = data.rows || []
    const creatable = data.available === true && typeof onCreate === 'function'
    const disabledReason = '当前宿主没有自动化服务：装 @deepseek-ai/dsh-tool-schedule 并彻底重启 DSH'
    return (
      <div className="orch-wb-page orch-wb-automations">
        {data.available !== true
          ? (
              <Banner tone="notice" icon="alert" title="本页只读：已记录的自动化不会触发">
                {'当前宿主没有自动化服务：本页只读，已记录的自动化不会触发。'}
              </Banner>
            )
          : null}
        {state.error !== null
          ? <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`自动化读取失败：${state.error}`}</Banner>
          : null}
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle">{'已配置'}</span>
            <span className="orch-muted">{`${rows.length} 条`}</span>
            <span className="orch-wb-grow" />
            <button
              type="button" className="orch-btn orch-btn--primary orch-btn--lg"
              data-orch-create-automation=""
              disabled={!creatable || busy}
              onClick={onCreate}
              title={creatable ? '打开协调者会话（优先当前会话）并预填提示词：由协调者用官方 schedule_create 创建，到期投给该会话' : disabledReason}
            >
              <Icon name="plus" size={14} />
              {'创建自动化'}
            </button>
          </header>
          {rows.length === 0
            ? <EmptyState icon="bolt" title="还没有自动化" hint="在协调者会话里写清要做什么、什么时候。" />
            : (
                <ul className="orch-wb-autolist">
                  {rows.map(row => (
                    <li key={row.id} className="orch-wb-autorow">
                      <div className="orch-wb-automain">
                        <div className="orch-wb-autotitle">
                          {row.title}
                          <Badge tone={row.active ? 'info' : 'muted'}>{row.active ? '启用' : '已暂停'}</Badge>
                          {row.hostMissing ? <Badge tone="bad">{'宿主侧已不存在'}</Badge> : null}
                          {row.targetMissing ? <Badge tone="warn" title="绑定的会话已不是协调者：到期不会处理，请改指或删除">{'目标会话已不是协调者'}</Badge> : null}
                        </div>
                        <div className="orch-wb-autometa">
                          <span>{row.kind === 'group' ? `组 ${row.refId ?? ''}` : row.kind === 'task' ? `任务 ${row.refLabel || row.refId || ''}` : '全部任务'}</span>
                          <span>{row.timingText}</span>
                          <span>{automationStateLabel(row)}</span>
                          {row.lastDeliveryAt ? <span>{`最近投递 ${planWhenLabel(row.lastDeliveryAt)}`}</span> : null}
                        </div>
                        <details className="orch-wb-details">
                          <summary>{'看到期话术'}</summary>
                          <pre className="orch-pre">{row.prompt}</pre>
                        </details>
                      </div>
                      <div className="orch-wb-autoactions">
                        <button
                          type="button" className="orch-btn orch-btn--quiet orch-btn--sm"
                          disabled={data.available !== true || busy}
                          title={data.available !== true ? disabledReason : (row.active ? '暂停这条自动化' : '恢复这条自动化')}
                          onClick={() => onToggle(row.id, !row.active)}
                        >{row.active ? '暂停' : '恢复'}</button>
                        <button
                          type="button" className="orch-btn orch-btn--quiet orch-btn--sm orch-btn--danger"
                          disabled={data.available !== true || busy}
                          title={data.available !== true ? disabledReason : '删除这条自动化（需要二次确认）'}
                          onClick={() => setDeleteId(row.id)}
                        >{'删除'}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          <footer className="orch-wb-cardfoot">
            {typeof onOpenSchedules === 'function'
              ? <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={onOpenSchedules} title="官方「自动化任务」页：会话里创建的自动化都在这里（可手动创建、暂停、删除）">{'官方自动化任务页'}</button>
              : null}
            <span className="orch-wb-grow" />
            <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={onReload}>{'刷新'}</button>
          </footer>
        </section>
        {deleteId === null
          ? null
          : (
              <ConfirmDialog
                title={confirmCopy.automation[0]}
                note={confirmCopy.automation[1]}
                confirmLabel="确认删除"
                danger
                busy={busy}
                onConfirm={() => { const id = deleteId; setDeleteId(null); onDelete(id) }}
                onCancel={() => setDeleteId(null)}
              />
            )}
      </div>
    )
  }

  // ---- 复盘（P11 阶段 3）：只用既有时间戳 + 产物路径 + messages 条数，不新增埋点、不读产物内容 ----
  // 0.37.0：同一个数字只印一遍（原「窗口 7 天：交付 0 · 确认 0 · 失败 0 · 消息 0 条」与下面三个数字卡重复）；
  // 数字排不套卡（去掉卡里套卡），空窗口只给一张卡 + 一个空态。
  const durationLabel = ms => {
    if (!Number.isFinite(ms) || ms <= 0) return '—'
    const minutes = Math.round(ms / 60000)
    if (minutes < 60) return `${minutes} 分钟`
    return minutes < 1440 ? `${(minutes / 60).toFixed(1)} 小时` : `${(minutes / 1440).toFixed(1)} 天`
  }
  const ReviewPage = ({ state, days, onDays, onReload }) => {
    const data = state.data
    const retry = <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onReload}>{'重试'}</button>
    const head = (
      <header className="orch-wb-cardhead">
        <span className="orch-wb-cardtitle"><Icon name="check" size={14} />{'复盘'}</span>
        <span className="orch-wb-grow" />
        {REVIEW_DAYS.map(value => (
          <button
            key={value} type="button"
            className={days === value ? 'orch-btn orch-btn--primary orch-btn--sm' : 'orch-btn orch-btn--ghost orch-btn--sm'}
            aria-pressed={days === value} onClick={() => onDays(value)}
          >{`最近 ${value} 天`}</button>
        ))}
        <button type="button" className="orch-btn orch-btn--quiet orch-btn--sm" onClick={onReload}>{'刷新'}</button>
      </header>
    )
    if (data === null) {
      return (
        <div className="orch-wb-page" data-page="review">
          <section className="orch-wb-card">
            {head}
            {state.error !== null
              ? <Banner tone="error" icon="alert" action={retry}>{`复盘读取失败：${state.error}`}</Banner>
              : <SkeletonList rows={2} />}
          </section>
        </div>
      )
    }
    const empty = data.delivered === 0 && data.failed === 0 && data.groups.length === 0
    const top = data.failures.length === 0 ? 1 : data.failures[0].count
    return (
      <div className="orch-wb-page" data-page="review">
        <section className="orch-wb-card">
          {head}
          {state.error !== null
            ? <Banner tone="error" icon="alert" action={retry}>{`复盘读取失败（显示上一次结果）：${state.error}`}</Banner>
            : null}
          {empty
            ? (
                <EmptyState
                  icon="check"
                  title="这段时间没有交付或失败"
                  hint="窗口内创建或交付的任务才会进入复盘。"
                  action={retry}
                />
              )
            : (
                <div className="orch-wb-rstats">
                  <div className="orch-wb-rstat"><b>{String(data.delivered)}</b><span>{'交付'}</span></div>
                  <div className="orch-wb-rstat"><b>{String(data.accepted)}</b><span>{'确认'}</span></div>
                  <div className="orch-wb-rstat"><b>{durationLabel(data.avgDeliverMs)}</b><span>{'平均创建 → 交付'}</span></div>
                </div>
              )}
          <div className="orch-wb-details">{`最近 ${data.days} 天 · 按创建与交付时间统计`}</div>
        </section>
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle">{`失败归因 · ${data.failed} 条`}</span>
            <span className="orch-wb-grow" />
            <span className="orch-wb-details">{'按错误首行归类'}</span>
          </header>
          {data.failures.length === 0
            ? <div className="orch-muted">{'这段时间没有失败任务'}</div>
            : data.failures.map(row => (
                <div key={row.reason} className="orch-wb-bar">
                  <span className="orch-wb-barlabel" title={row.reason}>{row.reason}</span>
                  <span className="orch-wb-barline">
                    <span className="orch-wb-bartrack">
                      <span style={{ width: `${Math.max(4, Math.round((row.count / top) * 100))}%` }} />
                    </span>
                    <span className="orch-wb-details">{String(row.count)}</span>
                  </span>
                </div>
              ))}
        </section>
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle">{`产物类型 · ${data.artifacts.length} 类`}</span>
            <span className="orch-wb-grow" />
            <span className="orch-wb-details">{'按扩展名，不读文件内容'}</span>
          </header>
          {data.artifacts.length === 0
            ? <div className="orch-muted">{'这段时间没有登记产物'}</div>
            : (
                <div className="orch-wb-chips">
                  {data.artifacts.map(row => <Chip key={row.ext}>{`${row.ext} ×${row.count}`}</Chip>)}
                </div>
              )}
        </section>
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle">{'组维度排行'}</span>
            <span className="orch-wb-grow" />
            <span className="orch-wb-details">{'这段时间有活动的组'}</span>
          </header>
          {data.groups.length === 0
            ? <div className="orch-muted">{'这段时间没有组活动'}</div>
            : data.groups.map((row, index) => (
                <div key={row.id || 'ungrouped'} className="orch-wb-autorow orch-wb-rankrow">
                  <span className="orch-wb-details">{String(index + 1)}</span>
                  <span className="orch-wb-automain">{row.name}</span>
                  <span className="orch-wb-gstats">{`交付 ${row.delivered} · 失败 ${row.failed} · 共 ${row.total}`}</span>
                </div>
              ))}
        </section>
      </div>
    )
  }

  return { PageNav, OverviewPage, GroupsPage, GroupPage, SchedulePage, AutomationsPage, ReviewPage, Dock }
}
