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
  BOARD_COLUMNS, WEEKDAY_LABELS, AUTOMATION_KINDS, AUTOMATION_WEEKDAYS, DEFAULT_PLAN_HOUR, TONE_COLOR,
} from './constants.js'
import {
  groupBoard, groupTasksOf, trayTasks, plannedOnDay, nextPlannedTask, planStampOnDay, planWhenLabel,
  clockOf, dateKeyOf, startOfMonth, monthGrid, automationStateLabel, displayNameOf,
} from './logic.js'

/** 拖拽载荷类型（只在本页/本面板内流转，不写剪贴板；不含 orch- 前缀，免得被样式自检当成 class）。 */
export const DND_TYPE = 'application/x-dsh-task'

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

export function createWorkbench({ React, h, Icon, Badge, Chip, EmptyState, Banner, SkeletonList, STATUS_LABEL }) {
  const { useState } = React

  const statusTone = status => (status === 'done' ? 'good'
    : status === 'failed' || status === 'orphaned' ? 'bad'
      : status === 'running' ? 'info'
        : status === 'delivered' || status === 'waiting_user' || status === 'waiting_auth' ? 'warn' : 'muted')

  const statusBadge = status => <Badge tone={statusTone(status)}>{STATUS_LABEL[status] || status || '未知'}</Badge>

  // ---- 一级导航（工作台内部五页；不新开 main 面板）----
  const PageNav = ({ page, onPage, inboxCount, groupCount, automationCount }) => (
    <nav className="orch-wb-nav" aria-label="工作台页面">
      {[['overview', '总览', null], ['groups', '任务组', groupCount], ['schedule', '排期', null], ['automations', '自动化', automationCount]].map(([key, label, count]) => (
        <button
          key={key}
          type="button"
          className="orch-wb-navitem"
          data-active={page === key ? 'true' : 'false'}
          aria-pressed={page === key}
          onClick={() => onPage(key)}
        >
          <Icon name={key === 'overview' ? 'inbox' : key === 'groups' ? 'folder' : key === 'schedule' ? 'calendar' : 'bolt'} size={13} />
          <span>{label}</span>
          {key === 'overview' && inboxCount > 0 ? <span className="orch-wb-navcount" data-tone="warn">{String(inboxCount)}</span> : null}
          {key !== 'overview' && Number.isFinite(count) && count > 0 ? <span className="orch-wb-navcount">{String(count)}</span> : null}
        </button>
      ))}
    </nav>
  )

  // ---- 总览：今日排期 + 下一条自动化 + 由 views.js 传入的列表/产物库 ----
  const OverviewPage = ({ tasks, planned, nextAutomation, onOpenDetail, onPage, list }) => (
    <div className="orch-wb-page orch-wb-overview">
      <div className="orch-wb-cols">
        <section className="orch-wb-card">
          <header className="orch-wb-cardhead">
            <span className="orch-wb-cardtitle"><Icon name="calendar" size={13} />{'今日排期'}</span>
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('schedule')}>{'打开排期'}</button>
          </header>
          {planned.length === 0
            ? <div className="orch-muted">{'今天还没有排期。到「排期」把任务拖到日历上，或点任务卡里的「排期」选日期。'}</div>
            : (
                <ul className="orch-wb-today">
                  {planned.map(task => (
                    <li key={task.id}>
                      <button type="button" className="orch-wb-todayrow" onClick={() => onOpenDetail(task.id)}>
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
            <span className="orch-wb-cardtitle"><Icon name="bolt" size={13} />{'自动化'}</span>
            <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPage('automations')}>{'打开'}</button>
          </header>
          {nextAutomation === null
            ? <div className="orch-muted">{'还没有到点自动派单。到「自动化」建一条：到点由协调者按话术 task_list 核对后 task_create。'}</div>
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
  const GroupCard = ({ group, onOpen, onRename, onArchive }) => {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(group.name)
    const [confirming, setConfirming] = useState(false)
    const counts = group.counts || {}
    const donePercent = percent(counts.done || 0, counts.total || 0)
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
            type="button" className="orch-btn orch-btn--ghost orch-btn--sm"
            title="重命名 / 归档"
            onClick={event => { event.stopPropagation(); setEditing(!editing); setConfirming(false) }}
          >{'⋯'}</button>
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
        {editing
          ? (
              <form
                className="orch-wb-gform"
                onClick={event => event.stopPropagation()}
                onSubmit={event => { event.preventDefault(); onRename(group.id, draft); setEditing(false) }}
              >
                <input
                  className="orch-input" value={draft} maxLength={40} aria-label="组名"
                  onChange={event => setDraft(event.target.value)}
                />
                <button type="submit" className="orch-btn orch-btn--primary orch-btn--sm">{'保存'}</button>
                <button type="button" className="orch-btn orch-btn--sm" onClick={() => setEditing(false)}>{'取消'}</button>
                {confirming
                  ? (
                      <button type="button" className="orch-btn orch-btn--sm" onClick={() => { onArchive(group.id, !group.archived); setConfirming(false) }}>
                        {group.archived ? '确认取消归档' : '确认归档'}
                      </button>
                    )
                  : (
                      <button type="button" className="orch-btn orch-btn--sm" onClick={() => setConfirming(true)}>
                        {group.archived ? '取消归档…' : '归档…'}
                      </button>
                    )}
              </form>
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
          hint="组来自 task_create({ group: '公众号文章组' })。工作台不代你直接建任务——把需求告诉协调者，它会按组派单。"
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
  const PlanControl = ({ task, onPlan, compact }) => {
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState(() => toLocalInput(task.plannedAt ?? Date.now()))
    const submit = () => {
      const ms = fromLocalInput(value)
      if (ms === null) return
      onPlan(task.id, ms)
      setOpen(false)
    }
    return (
      <span className="orch-wb-plan">
        <button
          type="button" className={compact ? 'orch-btn orch-btn--ghost orch-btn--sm' : 'orch-btn orch-btn--ghost'}
          onClick={() => { setValue(toLocalInput(task.plannedAt ?? Date.now())); setOpen(!open) }}
          title={task.plannedAt ? '修改排期' : '排到某天'}
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
                <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={submit}>{'保存'}</button>
                {task.plannedAt
                  ? <button type="button" className="orch-btn orch-btn--sm" onClick={() => { onPlan(task.id, null); setOpen(false) }}>{'清除'}</button>
                  : null}
                <button type="button" className="orch-btn orch-btn--sm" onClick={() => setOpen(false)}>{'取消'}</button>
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
        {task.planFirst === true && task.planState === 'planning' ? <Chip tone="warn">{'计划待批'}</Chip> : null}
        {task.worktreeState && task.worktreeState !== 'none' ? <Chip title={task.worktreeBranch || ''}>{'隔离'}</Chip> : null}
      </div>
      <div className="orch-wb-tfoot">
        <span className="orch-msg-at">{`更新 ${task.updatedAt ? planWhenLabel(task.updatedAt) : '-'}`}</span>
        <span className="orch-wb-grow" />
        {task.canPlan === false ? null : <PlanControl task={task} onPlan={onPlan} compact />}
      </div>
    </div>
  )

  const Dock = ({ detail, group, notices, onOpenSession, onJumpMain }) => {
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
                    <span className="orch-msg-at">{`编号 ${task.id}`}</span>
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
          {Array.isArray(notices) && notices.length > 0
            ? <div className="orch-wb-docknote">{notices.map((notice, index) => <div key={index} className="orch-muted">{notice}</div>)}</div>
            : null}
        </div>
        <footer className="orch-wb-dockfoot">
          <div className="orch-muted">{'dock 是只读镜像：不代发消息、不代批计划；派单与追问问协调者。'}</div>
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
    return (
      <div className="orch-wb-page orch-wb-grouppage">
        <header className="orch-wb-grouphead">
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onBack}>{'← 返回任务组'}</button>
          <span className="orch-wb-gname orch-wb-gname--big">{group.name}</span>
          {group.archived ? <Chip>{'已归档'}</Chip> : null}
          <span className="orch-wb-grow" />
          <span className="orch-muted">{group.goal || `组键 ${group.id}`}</span>
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
                      <button type="button" className="orch-btn orch-btn--sm" onClick={() => setRenaming(false)}>{'取消'}</button>
                    </span>
                  )
                : (
                    <button type="button" className="orch-btn orch-btn--sm" onClick={() => { setDraftName(group.name); setRenaming(true); setArchiveStep(0) }}>{'重命名'}</button>
                  ))
            : null}
          {group.canArchive
            ? (archiveStep === 1
                ? (
                    <span className="orch-wb-inline">
                      <span className="orch-muted">{group.archived ? '确认取消归档？任务与产物都不动。' : '确认归档？任务与产物都不动，只是默认视图隐藏。'}</span>
                      <button type="button" className="orch-btn orch-btn--primary orch-btn--sm" onClick={() => { onArchive(group.id, !group.archived); setArchiveStep(0) }}>{'确认'}</button>
                      <button type="button" className="orch-btn orch-btn--sm" onClick={() => setArchiveStep(0)}>{'取消'}</button>
                    </span>
                  )
                : (
                    <button type="button" className="orch-btn orch-btn--sm" onClick={() => { setArchiveStep(1); setRenaming(false) }}>{group.archived ? '取消归档' : '归档'}</button>
                  ))
            : null}
          <button type="button" className="orch-btn orch-btn--sm" onClick={onOpenMain}>{'打开主会话'}</button>
        </header>
        <div className="orch-wb-split">
          <div className="orch-wb-main">
            <div className="orch-wb-tabs" role="tablist" aria-label="组视图">
              <button type="button" role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'orch-wb-tab is-on' : 'orch-wb-tab'} onClick={() => setTab('board')}>{'看板'}</button>
              <button type="button" role="tab" aria-selected={tab === 'artifacts'} className={tab === 'artifacts' ? 'orch-wb-tab is-on' : 'orch-wb-tab'} onClick={() => setTab('artifacts')}>{`产物 ${artifacts.length}`}</button>
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
                          {column.count === 0 ? <div className="orch-muted orch-wb-colempty">{'—'}</div> : null}
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
                  ? <EmptyState icon="folder" title="这个组还没有产物" hint="子会话 task_report 时带的产物（或 done 时自动收集的改动文件）会出现在这里。" />
                  : (
                      <div className="orch-wb-agrid">
                        {artifacts.map(artifact => (
                          <div key={`${artifact.taskId}:${artifact.path}`} className="orch-wb-acell">
                            <div className="orch-wb-aname" title={artifact.path}>{artifact.path.split(/[\\/]/).pop()}</div>
                            <div className="orch-wb-ameta">{artifact.taskTitle}</div>
                            <div className="orch-wb-aactions">
                              <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPreview(artifact.taskId, artifact.path, true)}>{'预览'}</button>
                              <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onPreview(artifact.taskId, artifact.path, false)}>{'右侧栏'}</button>
                              <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onCopy(artifact.path)}>{'复制路径'}</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))
              : null}
          </div>
          {dock}
        </div>
      </div>
    )
  }

  const SchedulePage = ({ state, tasks, anchor, onAnchor, onPlan, onClearPlan, onOpenDetail, onReload }) => {
    const [dragOver, setDragOver] = useState(null)
    const grid = monthGrid(anchor, Date.now())
    const taskById = new Map(tasks.map(task => [task.id, task]))
    const byDay = new Map()
    for (const day of (state.data?.days ?? [])) byDay.set(day.date, day)
    const tray = trayTasks(tasks, Date.now())
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
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onAnchor(startOfMonth(new Date(grid.year, grid.month - 1, 1).getTime()))} aria-label="上个月">{'‹'}</button>
          <span className="orch-wb-calmonth">{grid.label}</span>
          <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={() => onAnchor(startOfMonth(new Date(grid.year, grid.month + 1, 1).getTime()))} aria-label="下个月">{'›'}</button>
          <button type="button" className="orch-btn orch-btn--sm" onClick={() => onAnchor(startOfMonth(Date.now()))}>{'今天'}</button>
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
                              <button key={item.id} type="button" className="orch-wb-chip" onClick={() => onOpenDetail(item.id)} title={item.title}>
                                <span className="orch-wb-chiptime">{clockOf(item.plannedAt)}</span>
                                <span className="orch-wb-chiptitle">{item.title}</span>
                              </button>
                            ))}
                            {items.length > 2 ? <span className="orch-muted">{`还有 ${items.length - 2} 条`}</span> : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
          </div>
          <aside className="orch-wb-rail">
            <section className="orch-wb-card">
              <header className="orch-wb-cardhead"><span className="orch-wb-cardtitle">{'下一条'}</span></header>
              {next === null
                ? <div className="orch-muted">{'没有未来排期。'}</div>
                : (
                    <button type="button" className="orch-wb-next" onClick={() => onOpenDetail(next.id)}>
                      <span className="orch-wb-nexttime">{planWhenLabel(next.plannedAt)}</span>
                      <span className="orch-wb-nexttitle">{next.title}</span>
                      {statusBadge(next.status)}
                    </button>
                  )}
            </section>
            <section
              className="orch-wb-card orch-wb-tray"
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                event.preventDefault()
                const id = event.dataTransfer.getData(DND_TYPE)
                if (id !== '') onClearPlan(id)
              }}
              aria-label="待排期"
            >
              <header className="orch-wb-cardhead">
                <span className="orch-wb-cardtitle">{'待排期'}</span>
                <span className="orch-muted">{`${tray.length} 条`}</span>
              </header>
              {tray.length === 0
                ? <div className="orch-muted">{'没有待排期的任务。'}</div>
                : (
                    <div className="orch-wb-traylist">
                      {tray.map(task => (
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
              <div className="orch-muted">{'把卡片拖到日历某天即排期；拖回这里或点「清除」取消。'}</div>
            </section>
          </aside>
        </div>
      </div>
    )
  }

  const AutomationForm = ({ groups, onSave, busy }) => {
    const [kind, setKind] = useState('group')
    const [refId, setRefId] = useState('')
    const [timingKind, setTimingKind] = useState('daily')
    const [time, setTime] = useState('09:00')
    const [weekdays, setWeekdays] = useState([1])
    const [expression, setExpression] = useState('0 9 * * 1-5')
    const [rrule, setRrule] = useState('FREQ=DAILY;BYHOUR=9')
    const [title, setTitle] = useState('')
    const [what, setWhat] = useState('')
    const [authorized, setAuthorized] = useState(false)
    const submit = event => {
      event.preventDefault()
      if (!authorized) return
      const timing = timingKind === 'daily' ? { kind: 'daily', time }
        : timingKind === 'weekly' ? { kind: 'weekly', time, weekdays }
          : timingKind === 'cron' ? { kind: 'cron', expression }
            : { kind: 'rrule', rrule }
      onSave({ kind, refId: kind === 'global' ? undefined : refId, timing, title, what, confirm: true })
    }
    return (
      <form className="orch-wb-card orch-wb-form" onSubmit={submit}>
        <header className="orch-wb-cardhead"><span className="orch-wb-cardtitle"><Icon name="bolt" size={13} />{'新建自动化'}</span></header>
        <label className="orch-wb-field">
          <span>{'绑定对象'}</span>
          <span className="orch-wb-inline">
            <select className="orch-input" value={kind} onChange={event => setKind(event.target.value)} aria-label="自动化绑定对象">
              <option value="group">{'一个任务组'}</option>
              <option value="global">{'全部任务（收件箱巡检）'}</option>
            </select>
            {kind === 'group'
              ? (
                  <select className="orch-input" value={refId} onChange={event => setRefId(event.target.value)} aria-label="选择组">
                    <option value="">{'选择组…'}</option>
                    {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                )
              : null}
          </span>
        </label>
        <label className="orch-wb-field">
          <span>{'触发方式'}</span>
          <span className="orch-wb-inline">
            <select className="orch-input" value={timingKind} onChange={event => setTimingKind(event.target.value)} aria-label="触发方式">
              {AUTOMATION_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {timingKind === 'daily' || timingKind === 'weekly'
              ? <input type="time" className="orch-input" value={time} onChange={event => setTime(event.target.value)} aria-label="触发时刻" />
              : null}
            {timingKind === 'cron'
              ? <input className="orch-input" value={expression} onChange={event => setExpression(event.target.value)} aria-label="cron 表达式" placeholder="0 9 * * 1-5" />
              : null}
            {timingKind === 'rrule'
              ? <input className="orch-input" value={rrule} onChange={event => setRrule(event.target.value)} aria-label="rrule" placeholder="FREQ=DAILY" />
              : null}
          </span>
        </label>
        {timingKind === 'weekly'
          ? (
              <div className="orch-wb-field">
                <span>{'星期'}</span>
                <span className="orch-wb-inline">
                  {AUTOMATION_WEEKDAYS.map((label, index) => {
                    const day = index + 1
                    const on = weekdays.includes(day)
                    return (
                      <button
                        key={label} type="button" className="orch-wb-daychip" data-on={on ? 'true' : 'false'}
                        aria-pressed={on}
                        onClick={() => setWeekdays(on ? weekdays.filter(item => item !== day) : [...weekdays, day].sort((a, b) => a - b))}
                      >{label}</button>
                    )
                  })}
                </span>
              </div>
            )
          : null}
        <label className="orch-wb-field">
          <span>{'标题（可选）'}</span>
          <input className="orch-input" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="默认用绑定对象生成" />
        </label>
        <label className="orch-wb-field">
          <span>{'到点做什么（可选）'}</span>
          <textarea className="orch-input" rows={2} value={what} onChange={event => setWhat(event.target.value)} placeholder="例如：把上周没写完的初稿推进到待确认" />
        </label>
        <label className="orch-wb-check">
          <input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} />
          <span>{'我授权在到期时由协调者用这条话术核对并派单（只投递到唯一主会话，不新建会话）'}</span>
        </label>
        <div className="orch-wb-formfoot">
          <span className="orch-muted">{'投递成功 ≠ 任务完成；平台崩溃可能重复投递，不承诺 exactly-once。'}</span>
          <button type="submit" className="orch-btn orch-btn--primary" disabled={busy || !authorized || (kind === 'group' && refId === '')}>{'保存并启用'}</button>
        </div>
      </form>
    )
  }

  const AutomationsPage = ({ state, groups, onReload, onSave, onToggle, onDelete, busy }) => {
    if (state.data === null) {
      return <SkeletonList rows={3} />
    }
    const data = state.data
    const rows = data.rows || []
    return (
      <div className="orch-wb-page orch-wb-automations">
        {data.available !== true
          ? <Banner tone="notice" icon="alert">{'当前宿主没有可用的自动化服务（@deepseek-ai/dsh-tool-schedule）：本页只读，已记录的自动化不会触发。装好并彻底重启 DSH 后再来。'}</Banner>
          : (data.canCreate === false
              ? <Banner tone="notice" icon="alert">{'还没有主会话：自动化只能投递到唯一主会话。先「打开主会话」再建。'}</Banner>
              : null)}
        {state.error !== null
          ? <Banner tone="error" icon="alert" action={<button type="button" className="orch-btn orch-btn--sm" onClick={onReload}>{'重试'}</button>}>{`自动化读取失败：${state.error}`}</Banner>
          : null}
        <div className="orch-wb-cols">
          <div className="orch-wb-main">
            <section className="orch-wb-card">
              <header className="orch-wb-cardhead">
                <span className="orch-wb-cardtitle">{'已配置'}</span>
                <span className="orch-muted">{`${rows.length} 条`}</span>
                <span className="orch-wb-grow" />
                <button type="button" className="orch-btn orch-btn--ghost orch-btn--sm" onClick={onReload}>{'刷新'}</button>
              </header>
              {rows.length === 0
                ? <EmptyState icon="bolt" title="还没有自动化" hint="到点由协调者按话术 task_list 核对后 task_create——不是定时器直接建任务。" />
                : (
                    <ul className="orch-wb-autolist">
                      {rows.map(row => (
                        <li key={row.id} className="orch-wb-autorow">
                          <div className="orch-wb-automain">
                            <div className="orch-wb-autotitle">
                              {row.title}
                              <Badge tone={row.active ? 'info' : 'muted'}>{row.active ? '启用' : '已暂停'}</Badge>
                              {row.hostMissing ? <Badge tone="bad">{'宿主侧已不存在'}</Badge> : null}
                            </div>
                            <div className="orch-wb-autometa">
                              <span>{row.kind === 'group' ? `组 ${row.refId ?? ''}` : row.kind === 'task' ? `任务 ${row.refId ?? ''}` : '全部任务'}</span>
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
                              type="button" className="orch-btn orch-btn--sm"
                              disabled={data.available !== true || busy}
                              onClick={() => onToggle(row.id, !row.active)}
                            >{row.active ? '暂停' : '恢复'}</button>
                            <button
                              type="button" className="orch-btn orch-btn--sm"
                              disabled={data.available !== true || busy}
                              onClick={() => onDelete(row.id)}
                            >{'删除'}</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
            </section>
          </div>
          <div className="orch-wb-rail">
            {data.available === true && data.canCreate === true
              ? <AutomationForm groups={groups} onSave={onSave} busy={busy} />
              : null}
          </div>
        </div>
      </div>
    )
  }

  return { PageNav, OverviewPage, GroupsPage, GroupPage, SchedulePage, AutomationsPage, Dock }
}
