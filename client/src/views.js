/**
 * 面板视图（P7 / T7.2 迁入）：三段式任务面板、启动器面板、会话头按钮、侧栏图标。
 *
 * 依赖（React/h、常量、纯逻辑、API、展示组件）全部由 client.js 在 factory 里一次性注入，
 * 本模块不直接 import react，也不读全局 window（除了已有的 window.addEventListener 行为）。
 *
 * P2-5（S9′）：渲染收敛——标签兜底、确认条、圆点行、键值对四处重复片段各抽一次；
 * 新增「官方 Team（只读）」分区与「交接」区块（数据只读下发，前端不算结论）。
 */
// 打开「刚创建出来的会话」的等待/重试（与开包会话同一条路；宿主 retain 只认已进会话目录的 id）。
import { openSessionWhenReady } from './open-session.js'

// 标签单源：表里没有就退化原始值，空值兜底成 fallback。替掉各处 `X_LABEL[v] || v || '未知'`。
const labelOf = (table, value, fallback = '未知') => (
  value === null || value === undefined || value === '' ? fallback : (table[value] ?? value)
)
// 语义色单源：契约/口径表里没有的 tone 一律走 muted，不猜。
const toneOf = (table, value, fallback = 'muted') => (
  value !== null && value !== undefined && Object.hasOwn(table, value) ? table[value] : fallback
)
// 官方 Team 板状态 → 徽标 tone（只读展示用；插件不改官方状态）。
const BOARD_TONE = { completed: 'good', in_progress: 'info', pending: 'muted', deleted: 'muted' }
// 交接「确认方式」文案：与 src/handoff.js 的 acceptedByLabel 同源（客户端不能 import 服务端模块，
// 改一处要改两处）；快照里的 handoff 自带 acceptedByLabel，详情里的只有 acceptedBy。
const ACCEPTED_BY_LABEL = { coordinator: '协调者确认', panel: '面板确认', timeout: '超时自动完成', chain: '链式自动放行' }
// 主区「官方 Team（只读）」折叠区的状态键（与抽屉区块共用 collapsedSections）。
const BOARD_SECTION = 'board'

export function createViews({
  React, h,
  Icon, Badge, Chip, EmptyState, Banner, SkeletonList,
  FILTERS, METRICS, POLL_MS, POLL_BACKOFF_MS,
  STATUS_LABEL, STATUS_TONE, MESSAGE_KIND_LABEL, DELIVERY_LABEL, DELIVERY_TONE,
  GOAL_PHASE_LABEL, GOAL_ACTIVATION_LABEL, PLAN_STATE_LABEL, WORKTREE_STATE_LABEL, WORKTREE_SOURCE_LABEL, TONE_COLOR,
  displayNameOf, textOf, listOf, timeLabel, shortPath,
  countTasks, matchesFilter, matchesQuery, groupArtifacts,
  readSnapshot, readArtifacts, readDetail, readPreview, panelAction, openMainOnce,
  selectTaskChips, chipViewOf, chipTooltipOf, chipVisibleTitle, chipOpenTargetOf, isLatestTurn,
  // R3：正文里的任务引用切段 + 查表（logic.js 的纯函数，视图只渲染）。
  refSegmentsOf,
  // 工作台 v1（P11）：页面组件 + 数据源 + 纯逻辑。
  createWorkbench, WORKBENCH_PAGES, WORKBENCH_STORAGE_KEY, WORKBENCH_POLL_MS,
  workbenchApi, startOfMonth, plannedOnDay, planStampOnDay, groupTasksOf, nextPlannedTask, automationStateLabel,
  monthGrid, dateKeyOf, AUTOMATION_CREATE_PROMPT,
}) {
  // 工作台页面组件（只吃 props，自己不发请求；数据与节流在下面的 TasksPanel 里统一管）。
  const Wb = createWorkbench({ React, h, Icon, Badge, Chip, EmptyState, Banner, SkeletonList, STATUS_LABEL })
  // P0-4 计划四态：批准前的三态（运行期只读）才占视觉；approved 正常执行、rejected 已结束都不加小标。
  const PLAN_OPEN_STATES = ['planning', 'waiting_user', 'revising']
  const PLAN_OPEN_BADGE = { planning: '计划中', waiting_user: '计划待批', revising: '修订中' }
  const planOpen = task => task?.planFirst === true && PLAN_OPEN_STATES.includes(task.planState)
  // 日历窗口：当前可见的 42 格（周一起始、固定 6 行）→ 服务端 calendar 端点的时间窗。
  const monthGridRange = anchorMs => {
    const grid = monthGrid(anchorMs)
    const first = grid.cells[0]
    const last = grid.cells[grid.cells.length - 1]
    return { from: first.ms, to: last.ms + 24 * 60 * 60 * 1000 }
  }
  // 状态徽标（卡片 / 抽屉 / 依赖行共用一处口径：文案与 tone 都不在各处抄状态表）。
  const statusBadge = status => (
    <Badge tone={toneOf(STATUS_TONE, status)} title={labelOf(STATUS_LABEL, status)}>
      {labelOf(STATUS_LABEL, status)}
    </Badge>
  )
  // R3：正文里的任务引用（tk-xxxxxx）渲染成「任务名」chip，其余文字原样。
  // 没有引用时直接返回原字符串（零额外节点、不改既有快照的 DOM 形状）。
  // 查表来源：面板快照 tasks（现名 + 同名判定）+ 详情 refs（含已删除的墓碑引用）；
  // 查不到/已删除的引用**原样显示**（logic.js 的 refDisplayOf 负责五种兜底）。
  const RefText = ({ text, tasks, refs }) => {
    const value = typeof text === 'string' ? text : String(text ?? '')
    if (value === '') return value
    const segments = refSegmentsOf(value, { tasks, refs })
    if (!segments.some(segment => segment.type === 'ref')) return value
    return segments.map((segment, index) => {
      if (segment.type !== 'ref') return <span key={`t${index}`}>{segment.text}</span>
      const display = segment.display
      return (
        <Chip
          key={`r${index}`}
          tone={display === null ? 'muted' : display.tone}
          title={display === null ? segment.ref : display.tooltip}
        >{display === null ? segment.ref : display.label}</Chip>
      )
    })
  }
  // 只读圆点行：产物 / 验收检查 / 依赖 / 官方板共用（行内没有动作，按钮由调用方补）。
  const DotRow = ({ tone, children }) => (
    <div className="orch-artifact">
      <span
        className="orch-dot"
        style={{ background: TONE_COLOR[tone] || TONE_COLOR.muted, color: TONE_COLOR[tone] || TONE_COLOR.muted }}
      />
      {children}
    </div>
  )
  // 键值对网格：概览 / 目标状态 / 交接三处共用（键序稳定，值一律字符串化）。
  const KvRows = ({ rows }) => rows.flatMap(([key, value]) => [
    <span key={`${key}:k`} className="orch-kv-key">{key}</span>,
    <span key={`${key}:v`} className="orch-kv-val">{String(value ?? '')}</span>,
  ])
  // 破坏性动作的二次确认条（停止 / 确认交付 / 删除共用）：danger 时按钮走危险色。
  const ConfirmBar = ({ question, label, disabled, danger, onConfirm, onCancel }) => (
    <span className="orch-confirm">
      <span>{question}</span>
      <button
        type="button"
        className={`orch-btn orch-btn--sm${danger === true ? ' orch-btn--danger' : ''}`}
        disabled={disabled}
        onClick={onConfirm}
      >{label}</button>
      <button type="button" className="orch-btn orch-btn--sm" onClick={onCancel}>{'取消'}</button>
    </span>
  )

  // 会话头入口（0.25.0，2026-11-22 收敛为三种角色）：
  //   - 主会话 → 「任务」按钮（打开任务面板）；
  //   - 普通根会话（官方新建会话 / 能力包会话 / schedule 新建会话…）→ 「设为协调者」按钮
  //     （把**当前会话**设为协调者；只切指针，旧会话保留可回看）；
  //   - 子智能体会话（origin=subagent）→ **两个入口都不渲染**（闸门给 'hidden'，组件返回 null）。
  // 三个形态共用一个槽位（conversation.header.leading 是 single），按 hooks.mainView 的角色切换。
  const AdoptButton = ({ adopt, readSessionId, refreshRole }) => {
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    const run = async () => {
      if (busy) return
      let sessionId
      try { sessionId = typeof readSessionId === 'function' ? readSessionId() : undefined } catch { sessionId = undefined }
      if (typeof sessionId !== 'string' || sessionId === '') {
        setError('拿不到当前会话')
        return
      }
      if (typeof adopt !== 'function') {
        setError('缺少 adopt 实现')
        return
      }
      setBusy(true)
      setError(null)
      try {
        await adopt(sessionId)
        if (typeof refreshRole === 'function') await refreshRole()
      } catch (failure) {
        setError(String((failure && failure.message) || failure))
      } finally {
        setBusy(false)
      }
    }
    const label = busy ? '切换中…' : (error === null ? '设为协调者' : '设为协调者失败')
    return (
      <button
        type="button"
        title={error === null ? '把当前会话设为协调者（台账/任务/偏好都不搬；旧会话保留可回看）' : error}
        aria-label="设为协调者"
        className={`orch-btn orch-btn--entry${error === null ? '' : ' orch-btn--danger'}`}
        onClick={run}
        disabled={busy}
        data-orch-adopt={error === null ? (busy ? 'busy' : 'idle') : 'error'}
      >
        <span className="orch-entry-mark"><Icon name="sparkle" size={12} /></span>
        <span className="orch-entry-label">{label}</span>
      </button>
    )
  }

  // 会话头「任务」入口：仅主会话显示。useMainView 由下面 conversation.header.leading 的 inject
  // 以 hooks.mainView 提供，快照是角色（'main' | 'adopt' | 'hidden'）：
  //   - 'main'   → 「任务」按钮；
  //   - 'adopt'  → 有 adopt 能力才给「设为协调者」，没有就保持历史行为（不渲染）；
  //   - 'hidden' → 一律不渲染（子智能体会话、判定不出来、信号失败）。这是「未渲染」，不是 CSS 隐藏。
  // 视觉按面板顶栏 .orch-brand 的语言：品牌色方块装内联 SVG 图标 + 半粗文字（不再用裸字符 ☰）。
  const HeaderButton = ({ openPanel, useMainView, adopt, readSessionId, refreshRole }) => {
    const role = typeof useMainView === 'function' ? useMainView(value => value) : 'hidden'
    if (role === 'adopt') {
      if (typeof adopt !== 'function') return null
      return h(AdoptButton, { adopt, readSessionId, refreshRole })
    }
    if (role !== 'main') return null
    // props 键序/键名与迁移前一致（快照按 props 序列化顺序比对）。
    return (
      <button
        type="button" title="任务面板" aria-label="打开任务面板"
        className="orch-btn orch-btn--entry" onClick={openPanel}
      >
        <span className="orch-entry-mark"><Icon name="menu" size={12} /></span>
        <span className="orch-entry-label">{'任务'}</span>
      </button>
    )
  }

  // 侧栏「插件」下方的入口图标（面板行渲染的是这个组件）。
  //
  // 对齐约定（与宿主侧栏项同规格）：宿主把这里注册的组件当成本行的**直接图标子元素**塞进
  // `.panelGlyph`（inline-flex 居中、不带尺寸），并按行状态传 `size`（展开 16 / 收起 18）；
  // 官方项在这一格放的是 `size × size` 的内联 SVG（见 dsh-client-ui-schedule 的
  // TaskManagerIcon 注释：图标必须是行的直接图标子，包一层行内 wrapper 会让它落到行盒基线上、
  // 比文字「抬高」）。我们原来放的是裸字符 `◈`：盒子是 13×16 的行盒、墨迹中线比文字中线低
  // 0.5px、收起态边长还是 16（官方 18）——三样叠加就是肉眼看到的「图标没跟文字对齐」。
  // 现在按官方约定画成 SVG：盒子 = size 的正方形、墨迹在 viewBox 居中，展开/收起两态都与
  // 官方项同规格（中线差按 computed style 实测为 0）。
  const LauncherIcon = ({ size = 16 }) => (
    <Icon name="navMain" size={size} className="orch-nav-glyph" />
  )

  // 回复底部「关联任务」chip 行：挂在 ui-chat 官方 conversation.chat.turnTail 列表槽位里，
  // 只在「主会话 + 最新一轮已完成回复」尾部渲染（历史回复不带 chip，子会话一个也收不到）。
  // 数据来自共享 feed（client.js 注入的 chips 可观测源），这里只在需要时订阅：
  // 非最新轮次 / 非主会话不订阅 → 没有 chip 的会话开着一个轮询都没有。
  // 关联规则、状态映射与截断都是 logic.js 的纯函数，组件只做装配（单测直接断言纯函数 + 首帧结构）。
  // 点击：有子会话 → 交给 injected.openTask 跳该子会话；没有 → 同一个 openTask 负责降级打开任务详情，
  // tooltip 与 cursor 都按 chipOpenTargetOf 的结果区分（不假装能跳会话）。
  const TaskChipRow = ({ turn, sessionId, useMainView, useChat, chips, openTask, openPanel }) => {
    // 闸门快照是角色（'main' | 'adopt' | 'hidden'），只有 'main' 才出 chip：普通根会话（含能力包会话）
    // 是 'adopt'、子智能体是 'hidden'，两者都不该看到主会话的任务 chip。旧实现按布尔 `=== true` 判断，
    // 角色化后会恒假（主会话也不出 chip），这里显式锁 'main' 并写了单测。
    const isMain = typeof useMainView === 'function' ? useMainView(value => value === 'main') : false
    const latest = typeof useChat === 'function' ? useChat(snapshot => isLatestTurn(snapshot, turn)) : false
    const enabled = isMain === true && latest === true
    // 订阅只为「数据变了要重渲染」这一个信号；值本身不参与渲染（渲染直接读 getSnapshot）。
    const [, setRevision] = React.useState(0)
    React.useEffect(() => {
      if (!enabled || chips === undefined || chips === null || typeof chips.subscribe !== 'function') return undefined
      return chips.subscribe(() => setRevision(value => value + 1))
    }, [enabled, chips])
    if (!enabled) return null
    const snapshot = chips !== undefined && chips !== null && typeof chips.getSnapshot === 'function'
      ? chips.getSnapshot()
      : null
    // 空状态：没有关联任务就整行不渲染（不占位、不出骨架、不报错）。
    const view = snapshot === null ? null : selectTaskChips(snapshot.tasks, { sessionId, now: Date.now() })
    if (view === null) return null
    const chipNode = task => {
      const visual = chipViewOf(task.status)
      const tooltip = chipTooltipOf(task)
      // 点击目标由快照字段决定（logic.js 的 R5）：有子会话 → 跳子会话；没有 → 降级任务详情。
      // data-orch-chip-open 同时给 CSS（cursor 不误导）和测试一个稳定的观察点。
      const target = chipOpenTargetOf(task)
      const clickable = typeof openTask === 'function' && typeof task.id === 'string' && task.id !== ''
      return (
        <button
          key={`chip-${task.id}`}
          type="button"
          className="orch-taskchip"
          data-state={visual.state}
          data-task-id={task.id}
          data-orch-chip-open={target.kind}
          title={tooltip}
          aria-label={tooltip}
          onClick={clickable ? () => openTask(task) : undefined}
        >
          <span
            className="orch-taskchip-mark"
            style={{ color: TONE_COLOR[visual.tone] || TONE_COLOR.muted }}
            aria-hidden="true"
          >
            <Icon
              name={visual.icon}
              size={12}
              className={visual.className === '' ? undefined : visual.className}
            />
          </span>
          <span className="orch-taskchip-title">{chipVisibleTitle(task.title)}</span>
        </button>
      )
    }
    const more = view.rest > 0
      ? (
          <button
            key="chip-more"
            type="button"
            className="orch-taskchip orch-taskchip--more"
            title={`还有 ${view.rest} 个关联任务`}
            aria-label={`还有 ${view.rest} 个关联任务`}
            onClick={typeof openPanel === 'function' ? openPanel : undefined}
          >{`+${view.rest}`}
          </button>
        )
      : null
    return (
      <div
        className="orch-chips"
        data-orch-chip-row="true"
        data-orch-chip-total={String(view.total)}
      >{[...view.chips.map(chipNode), more]}
      </div>
    )
  }

  // 启动器面板：侧栏条目点击 → 选到这个面板 → 挂载即跑现有 open-main → 跳到主会话 → 清空面板回对话。
  const LauncherPanel = ({ openMain, openSession, clearPanel }) => {
    const [error, setError] = React.useState(null)
    const started = React.useRef(false)
    const run = React.useCallback(async () => {
      setError(null)
      try {
        const body = await openMain()
        openSession(body.sessionId)
        clearPanel()
      } catch (failure) {
        setError(`打开主会话失败：${String((failure && failure.message) || failure)}`)
      }
    }, [openMain, openSession, clearPanel])
    React.useEffect(() => {
      if (started.current) return
      started.current = true
      void run()
    }, [run])
    return (
      <div className="orch-shell orch-launcher">
        <div className="orch-launcher-card">
          <span className="orch-brand-mark"><Icon name="sparkle" size={14} /></span>
          <div className="orch-title">{error === null ? '正在打开主会话…' : '打开主会话失败'}</div>
          {error === null ? <div className="orch-skeleton" style={{ width: 120 }} /> : null}
          {error === null ? null : (
            <button type="button" className="orch-btn orch-btn--primary" onClick={run}>{'重试'}</button>
          )}
        </div>
        {error === null ? null : (
          <div style={{ width: 'min(420px, 100%)' }}><Banner tone="error">{error}</Banner></div>
        )}
      </div>
    )
  }

  const TasksPanel = ({ openSession, openArtifactPreview, focus, notice, prefillDraft, openSchedules }) => {
    // ---- 数据与状态（A3/A4/B1/G1 全部保留）----
    const [snapshot, setSnapshot] = React.useState(null)
    // 快照（轮询/刷新）和动作（打开主会话/打开会话）分开记，避免把动作错误显示成「台账暂不可用」。
    const [snapshotError, setSnapshotError] = React.useState(null)
    const [actionError, setActionError] = React.useState(null)
    const [actionNotice, setActionNotice] = React.useState(null)
    const [refreshing, setRefreshing] = React.useState(false)
    const [openingMain, setOpeningMain] = React.useState(false)
    const [openedMain, setOpenedMain] = React.useState(false)
    const [expanded, setExpanded] = React.useState([])
    const [filter, setFilter] = React.useState('all')
    const [query, setQuery] = React.useState('')
    // 右侧抽屉：detail 是数据；detailLoading/detailError 是抽屉自己的加载/错误态；
    // detailTaskId 让「已点开、正文还在路上」的抽屉也有标题。
    const [detail, setDetail] = React.useState(null)
    const [detailError, setDetailError] = React.useState(null)
    const [detailLoading, setDetailLoading] = React.useState(false)
    const [detailTaskId, setDetailTaskId] = React.useState(null)
    const [collapsedSections, setCollapsedSections] = React.useState([])
    // 破坏性动作二次确认：null 或待确认的任务 id（不再用 window.confirm，样式与宿主一致）。
    const [confirmStop, setConfirmStop] = React.useState(null)
    // 确认交付（delivered → done，done 不可逆）同样要二次确认。
    const [confirmClose, setConfirmClose] = React.useState(null)
    // 删除同样要二次确认：停止还能救回来，删除是台账级联清理（不可恢复）。
    const [confirmDelete, setConfirmDelete] = React.useState(null)
    const [artifactData, setArtifactData] = React.useState(null)
    const [artifactError, setArtifactError] = React.useState(null)
    const [artifactLoading, setArtifactLoading] = React.useState(false)
    const [artifactGroup, setArtifactGroup] = React.useState('project')
    const [preview, setPreview] = React.useState(null)
    const [copyNotice, setCopyNotice] = React.useState(null)
    const [busy, setBusy] = React.useState(null)
    // 同一 (动作, 任务) 只允许一个请求在途：双击不会发两条 stop/retry/message。
    const inFlight = React.useRef(new Set())
    // 详情请求序号：慢响应不能覆盖后点开的另一个任务。
    const detailSeq = React.useRef(0)

    // ---- 工作台 v1（P11）：页面状态 + 三份独立数据源（组 / 组详情 / 日历 / 自动化）----
    // 页面与选中的组记在 sessionStorage：产物预览会 `selectPanel(null)` 卸载面板，回来要复原。
    const storage = React.useMemo(() => {
      try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
    }, [])
    const storedWorkbench = React.useMemo(() => {
      try {
        const raw = storage === null ? null : storage.getItem(WORKBENCH_STORAGE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }, [storage])
    const [page, setPage] = React.useState(() => (
      WORKBENCH_PAGES.some(([key]) => key === storedWorkbench?.page) ? storedWorkbench.page : 'overview'
    ))
    const [groupId, setGroupId] = React.useState(() => (typeof storedWorkbench?.groupId === 'string' ? storedWorkbench.groupId : null))
    const [groupsState, setGroupsState] = React.useState({ data: null, error: null })
    const [groupState, setGroupState] = React.useState({ data: null, error: null })
    const [calendarState, setCalendarState] = React.useState({ data: null, error: null })
    const [automationState, setAutomationState] = React.useState({ data: null, error: null })
    // 复盘页（P11 阶段 3）：窗口天数与统计投影各自独立，切页才拉，页面不可见时停表。
    const [reviewState, setReviewState] = React.useState({ data: null, error: null })
    const [reviewDays, setReviewDays] = React.useState(7)
    const [monthAnchor, setMonthAnchor] = React.useState(() => startOfMonth(Date.now()))
    const [wbBusy, setWbBusy] = React.useState(false)

    React.useEffect(() => {
      try {
        if (storage !== null) storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ page, groupId }))
      } catch { /* 隐私模式/配额满：记忆失败不影响使用 */ }
    }, [storage, page, groupId])

    const load = React.useCallback(async (signal) => {
      try {
        const next = await readSnapshot(signal)
        setSnapshot(next)
        setSnapshotError(null)
        return true
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setSnapshotError(String((failure && failure.message) || failure))
        return false
      }
    }, [])

    const loadArtifacts = React.useCallback(async signal => {
      setArtifactLoading(true)
      try {
        const next = await readArtifacts(200, signal)
        setArtifactData(next)
        setArtifactError(null)
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setArtifactError(String((failure && failure.message) || failure))
      } finally {
        if (signal === undefined || !signal.aborted) setArtifactLoading(false)
      }
    }, [])

    // 切到「产物」筛选时调用 artifacts 端点；不跟着 2s 快照轮询重复拉取。
    React.useEffect(() => {
      if (filter !== 'artifacts') return undefined
      const controller = new AbortController()
      void loadArtifacts(controller.signal)
      return () => controller.abort()
    }, [filter, loadArtifacts])

    React.useEffect(() => {
      const controller = new AbortController()
      let stopped = false
      let timer
      // 正常 2s 轮询（POLL_MS）；连续失败退避到 30s（POLL_BACKOFF_MS），成功一次就恢复。
      const tick = async () => {
        const ok = await load(controller.signal)
        if (stopped || controller.signal.aborted) return
        timer = setTimeout(tick, ok ? POLL_MS : POLL_BACKOFF_MS)
      }
      void tick()
      return () => { stopped = true; controller.abort(); clearTimeout(timer) }
    }, [load])

    // ---- 工作台数据源：组 / 组详情 / 日历 / 自动化 ----
    // 与 snapshot 的 2s 轮询分开：这些端点 15s 一次（或动作后立即），页面不可见时停表。
    const loadGroups = React.useCallback(async signal => {
      try {
        const data = await workbenchApi.readGroups(signal)
        setGroupsState({ data, error: null })
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setGroupsState(current => ({ data: current.data, error: String((failure && failure.message) || failure) }))
      }
    }, [])
    const loadGroup = React.useCallback(async (id, signal) => {
      if (typeof id !== 'string' || id === '') return
      try {
        const data = await workbenchApi.readGroup(id, signal)
        setGroupState({ data, error: null })
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setGroupState(current => ({ data: current.data, error: String((failure && failure.message) || failure) }))
      }
    }, [])
    const loadCalendar = React.useCallback(async (anchor, signal) => {
      const grid = monthGridRange(anchor)
      try {
        const data = await workbenchApi.readCalendar(grid.from, grid.to, signal)
        setCalendarState({ data, error: null })
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setCalendarState(current => ({ data: current.data, error: String((failure && failure.message) || failure) }))
      }
    }, [])
    const loadAutomations = React.useCallback(async signal => {
      try {
        const data = await workbenchApi.readAutomations(signal)
        setAutomationState({ data, error: null })
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setAutomationState(current => ({ data: current.data, error: String((failure && failure.message) || failure) }))
      }
    }, [])
    const loadReview = React.useCallback(async (days, signal) => {
      try {
        const data = await workbenchApi.readStats(days, signal)
        setReviewState({ data, error: null })
      } catch (failure) {
        if (signal === undefined || !signal.aborted) setReviewState(current => ({ data: current.data, error: String((failure && failure.message) || failure) }))
      }
    }, [])

    // 轮询壳：页面不可见时只续排程、不打请求（宿主没有 visibility 事件 API，靠 document 判断）。
    const pollWhileVisible = React.useCallback((run, intervalMs) => {
      let stopped = false
      let timer
      const tick = async () => {
        if (stopped) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        if (!hidden) await run()
        if (!stopped) timer = setTimeout(tick, intervalMs)
      }
      void tick()
      return () => { stopped = true; clearTimeout(timer) }
    }, [])

    React.useEffect(() => {
      if (page !== 'groups') return undefined
      const controller = new AbortController()
      const stop = pollWhileVisible(() => loadGroups(controller.signal), WORKBENCH_POLL_MS)
      return () => { stop(); controller.abort() }
    }, [page, loadGroups, pollWhileVisible])

    React.useEffect(() => {
      if (page !== 'group') return undefined
      const controller = new AbortController()
      const stop = pollWhileVisible(() => loadGroup(groupId, controller.signal), WORKBENCH_POLL_MS)
      return () => { stop(); controller.abort() }
    }, [page, groupId, loadGroup, pollWhileVisible])

    React.useEffect(() => {
      if (page !== 'schedule') return undefined
      const controller = new AbortController()
      const stop = pollWhileVisible(() => loadCalendar(monthAnchor, controller.signal), WORKBENCH_POLL_MS)
      return () => { stop(); controller.abort() }
    }, [page, monthAnchor, loadCalendar, pollWhileVisible])

    React.useEffect(() => {
      // 总览要看「下一条自动化」，所以挂载即拉一次；自动化页再按 15s 轮询。
      const controller = new AbortController()
      void loadAutomations(controller.signal)
      if (page !== 'automations') return () => controller.abort()
      const stop = pollWhileVisible(() => loadAutomations(controller.signal), WORKBENCH_POLL_MS)
      return () => { stop(); controller.abort() }
    }, [page, loadAutomations, pollWhileVisible])

    React.useEffect(() => {
      if (page !== 'review') return undefined
      const controller = new AbortController()
      const stop = pollWhileVisible(() => loadReview(reviewDays, controller.signal), WORKBENCH_POLL_MS)
      return () => { stop(); controller.abort() }
    }, [page, reviewDays, loadReview, pollWhileVisible])
    // 工作台写动作：统一 busy / 错误通道，成功后按影响面刷新对应数据源。
    const runWorkbench = async (work, after) => {
      setWbBusy(true)
      setActionError(null)
      setActionNotice(null)
      try {
        const result = await work()
        if (after !== undefined) await after(result)
        return result
      } catch (failure) {
        setActionError(String((failure && failure.message) || failure))
        return null
      } finally {
        setWbBusy(false)
      }
    }

    const renameGroup = (id, name) => runWorkbench(
      () => workbenchApi.saveGroup({ id, name }),
      async () => {
        await loadGroups()
        if (groupId === id) await loadGroup(id)
        setActionNotice('组名已更新（组键不变，任务与 worktree 复用不受影响）')
      },
    )
    const setGroupArchived = (id, archived) => runWorkbench(
      () => workbenchApi.archiveGroup(id, archived),
      async () => {
        await loadGroups()
        if (groupId === id) await loadGroup(id)
        setActionNotice(archived ? '组已归档（任务与产物都没动）' : '组已取消归档')
      },
    )
    const planTask = (taskId, plannedAt) => runWorkbench(
      () => workbenchApi.setPlan(taskId, plannedAt),
      async () => {
        await load()
        if (page === 'schedule') await loadCalendar(monthAnchor)
        if (page === 'group') await loadGroup(groupId)
        setActionNotice(plannedAt === null ? '已清除排期' : '已排期（只改计划日，不改任务状态）')
      },
    )
    // 自动化创建（0.33.0）：对齐 DSH 官方「在会话中创建」——面板不再自己建任务。
    // 流程：open-main（已存在且 live 就复用）→ 打开唯一主会话 → 把提示词写进该会话的输入框
    // （conversation.input.requestDraftInitialization，官方会话创建用的同一入口）→ 用户补一句后发送，
    // 由主会话里的协调者调官方 schedule_create 创建，默认绑定主会话。
    // prefillDraft 由 client.js 注入（返回是否写入成功）；注入缺失时只打开会话并如实提示。
    const createAutomationEntry = async () => {
      if (wbBusy) return
      setWbBusy(true)
      try {
        const body = await openMainOnce()
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') throw new Error('宿主没返回主会话编号')
        // 刚建出来的主会话可能还没进客户端会话目录 → 宿主 retain 会同步抛 unknown session。
        // 与开包会话同一条等待/重试（open-session.js），不在这里另写一套。
        const opened = await openSessionWhenReady(openSession, sessionId)
        if (opened.ok !== true) throw new Error(opened.reason === '' ? '宿主不接受这个会话' : opened.reason)
        setActionError(null)
        let prefilled = false
        try {
          prefilled = typeof prefillDraft === 'function' ? prefillDraft(sessionId, AUTOMATION_CREATE_PROMPT) === true : false
        } catch { prefilled = false }
        setActionNotice(prefilled
          ? '已打开主会话并预填提示词：补一句「做什么、什么时候」后发送，协调者会用官方 schedule_create 创建（默认绑定本会话）'
          : '主会话已打开。提示词没能自动预填，请直接说明要创建什么自动化（到期只投本会话）')
      } catch (failure) {
        setActionNotice(null)
        setActionError(`打开主会话失败：${String((failure && failure.message) || failure)}`)
      } finally {
        setWbBusy(false)
      }
    }
    const switchAutomation = (id, active) => runWorkbench(
      () => workbenchApi.toggleAutomation(id, active),
      async () => {
        await loadAutomations()
        setActionNotice(active ? '自动化已恢复' : '自动化已暂停')
      },
    )
    const removeAutomation = id => runWorkbench(
      () => workbenchApi.deleteAutomation(id),
      async result => {
        await loadAutomations()
        setActionNotice(result?.note ?? '自动化已删除')
      },
    )

    const openGroup = id => {
      setGroupId(id)
      setGroupState({ data: null, error: null })
      setPage('group')
    }

    const refresh = async () => {
      setRefreshing(true)
      await load(undefined)
      if (filter === 'artifacts') await loadArtifacts(undefined)
      setRefreshing(false)
    }

    const open = id => {
      if (typeof id !== 'string' || id === '') return
      try {
        openSession(id)
        setActionError(null)
      } catch (failure) {
        setActionError(`打开会话失败：${String((failure && failure.message) || failure)}`)
      }
    }

    const handleOpenMain = async () => {
      // 双击会并发两次 open-main；主会话创建没有互斥，客户端先自己挡一层。
      if (openingMain) return
      setOpeningMain(true)
      setOpenedMain(false)
      try {
        const body = await openMainOnce()
        setActionError(null)
        open(body.sessionId)
        // 静态提示（不做 mainView 检测）：Bot 模式下主视图其实已切，错位的是 ds-bot 的皮肤/输入框。
        setOpenedMain(true)
      } catch (failure) {
        setActionError(`打开主会话失败：${String((failure && failure.message) || failure)}`)
      } finally {
        setOpeningMain(false)
      }
    }

    const toggleArtifacts = id => {
      setExpanded(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
    }

    // 抽屉打开：先清旧内容再拉详情（骨架屏），并按时序丢弃过期响应。
    const openDetail = async id => {
      if (typeof id !== 'string' || id === '') return
      const turn = ++detailSeq.current
      setDetailTaskId(id)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      setCopyNotice(null)
      setConfirmStop(null)
      setConfirmClose(null)
      setConfirmDelete(null)
      try {
        const body = await readDetail(id)
        if (turn !== detailSeq.current) return
        setDetail(body)
      } catch (failure) {
        if (turn !== detailSeq.current) return
        setDetailError(`详情加载失败：${String((failure && failure.message) || failure)}`)
      } finally {
        if (turn === detailSeq.current) setDetailLoading(false)
      }
    }

    const closeDetail = () => {
      detailSeq.current += 1
      setDetail(null)
      setDetailError(null)
      setDetailLoading(false)
      setDetailTaskId(null)
      setCopyNotice(null)
      setConfirmStop(null)
      setConfirmClose(null)
      setConfirmDelete(null)
      // 降级提示只属于这一次「chip 点击 → 抽屉」，关掉抽屉就该收走（见下面的 focusNotice）。
      setFocusNotice(null)
    }

    // 抽屉打开时按 Esc 关闭（与平台菜单一致的习惯）。
    const drawerOpen = detailLoading || detail !== null || detailError !== null
    React.useEffect(() => {
      if (!drawerOpen) return undefined
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
      const onKeyDown = event => {
        if (event !== null && typeof event === 'object' && event.key === 'Escape') closeDetail()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => {
        try { window.removeEventListener('keydown', onKeyDown) } catch { /* 卸载期清理失败不阻断 */ }
      }
    }, [drawerOpen])

    // 关联任务 chip 的「打开并定位」：chip 点击时记下一次任务 id，面板挂载时取走并直接开详情抽屉。
    // 只在挂载时消费一次（take 语义即清空），所以之后用户手动打开面板不会被旧请求弹抽屉。
    // notice 是降级原因（点了「跳子会话」但宿主不认那个会话 id）：跟着同一次请求显示在抽屉顶部，
    // 关掉抽屉即清空，不残留到下一次打开面板。
    const [focusNotice, setFocusNotice] = React.useState(null)
    const focusConsumed = React.useRef(false)
    React.useEffect(() => {
      if (focusConsumed.current || focus === undefined || focus === null || typeof focus.take !== 'function') return
      focusConsumed.current = true
      const id = focus.take()
      const notice = typeof focus.takeNotice === 'function' ? focus.takeNotice() : null
      if (typeof notice === 'string' && notice !== '') setFocusNotice(notice)
      // 工作台 v1：chip 只带任务 id，有 groupId 上下文时直接落到组工作台（而不是总览列表）。
      const context = typeof focus.takeContext === 'function' ? focus.takeContext() : null
      if (context !== null && typeof context === 'object' && typeof context.groupId === 'string' && context.groupId !== '') {
        setGroupId(context.groupId)
        setGroupState({ data: null, error: null })
        setPage('group')
      }
      if (typeof id === 'string' && id !== '') void openDetail(id)
    }, [focus])

    // t-a79e12d8：「新建协调者会话」后客户端没跳过去（宿主拒绝/没有 openSession）时的可读提示。
    // 面板已挂载 → 订阅即时收到；刚被切过来（未挂载）→ 挂载时 take 一次。两者都落到同一条 banner。
    React.useEffect(() => {
      if (notice === undefined || notice === null) return undefined
      const pending = typeof notice.take === 'function' ? notice.take() : null
      if (typeof pending === 'string' && pending !== '') setActionNotice(pending)
      if (typeof notice.subscribe !== 'function') return undefined
      return notice.subscribe(value => {
        if (typeof value === 'string' && value !== '') setActionNotice(value)
      })
    }, [notice])

    // 产物路径复制：优先 Clipboard API，老宿主退回 textarea + execCommand；都不行就报可读错误。
    const copyPath = async path => {
      const value = String(path ?? '')
      if (value === '') return
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
        } else if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const copied = document.execCommand('copy')
          document.body.removeChild(area)
          if (!copied) throw new Error('浏览器拒绝写入剪贴板')
        } else {
          throw new Error('当前环境不支持剪贴板')
        }
        setActionError(null)
        setCopyNotice(`已复制路径：${value}`)
      } catch (failure) {
        setCopyNotice(null)
        setActionError(`复制路径失败：${String((failure && failure.message) || failure)}`)
      }
    }

    // 预览：同一行再点一次收起；请求带 key，避免慢响应覆盖后来点的另一行。
    const togglePreview = async (taskId, path) => {
      const key = `${taskId}:${path}`
      if (preview !== null && preview.key === key && preview.loading !== true) {
        setPreview(null)
        return
      }
      setPreview({ key, loading: true, data: null, error: null })
      try {
        const data = await readPreview(taskId, path)
        setPreview(current => current !== null && current.key === key ? { key, loading: false, data, error: null } : current)
      } catch (failure) {
        const message = String((failure && failure.message) || failure)
        setPreview(current => current !== null && current.key === key ? { key, loading: false, data: null, error: message } : current)
      }
    }

    // 服务端 preview 端点只读「本任务已登记产物」（panel-actions.js 先查 task.artifacts 再读盘）。
    // 右侧栏链路是宿主直接读文件、不过这道校验，所以等价校验挪到前端：只允许预览台账下发给面板的产物路径。
    // 三个来源都是服务端下发的（快照卡片 / 产物库 / 详情抽屉），并起来就是「已登记」的等价集合。
    const isRegisteredArtifact = path => typeof path === 'string' && path !== '' && [
      ...tasks.flatMap(task => Array.isArray(task.artifacts) ? task.artifacts : []),
      ...(Array.isArray(artifactData?.items) ? artifactData.items : []),
      ...(Array.isArray(detail?.task?.artifacts) ? detail.task.artifacts : []),
    ].some(item => item?.path === path)

    // 预览：优先在会话右侧栏打开（宿主 dockkit 的 file Tab，Markdown/代码/图片/PDF/Office 都有渲染器）。
    // 只有「产物库」那一行有就地渲染的位置（inlineFallback=true），能退回旧 preview 端点；
    // 卡片/抽屉里没有可渲染的位置，只提示并给出手动路径，不假装成功。
    //
    // 提示的落点跟着失败路径走（P1-1）：openArtifactPreview 已在返回前把面板切回来（若是它切的），
    // 所以这里的 setActionNotice 一定落在还活着的面板上；它没切过面板就说明失败发生在切换之前，面板本来就在。
    const previewInSidebar = async (taskId, path, inlineFallback = false) => {
      if (!isRegisteredArtifact(path)) {
        setActionNotice('这个路径不是本任务的已登记产物，不能预览；先「复制路径」再本地打开')
        return
      }
      const opened = openArtifactPreview(path)
      if (opened.ok === true) {
        setPreview(null)
        setActionError(null)
        return
      }
      // 失败原因分四档，提示要能区分：缺侧栏服务 / 没会话 id / 路径非法 / 宿主拒绝（含原始 message）。
      const why = opened.reason === 'sidebar-missing'
        ? '当前宿主没有右侧栏预览能力'
        : opened.reason === 'no-session'
          ? '拿不到当前会话，无法定位预览作用域'
          : opened.reason === 'bad-path'
            ? '这条产物路径不可用'
            : `宿主拒绝打开${opened.message === undefined ? '' : `：${opened.message}`}`
      if (inlineFallback === true) {
        setActionNotice(`右侧栏不可用（${why}），已改为行内预览`)
        await togglePreview(taskId, path)
        return
      }
      setActionNotice(`右侧栏不可用（${why}）：到「产物」页可看行内预览，或先「复制路径」再本地打开`)
    }

    const runPanel = async (endpoint, id, extra = {}) => {
      const key = `${endpoint}:${id}`
      if (inFlight.current.has(key)) return
      inFlight.current.add(key)
      setBusy(key)
      setActionError(null)
      setActionNotice(null)
      setConfirmStop(null)
      setConfirmClose(null)
      setConfirmDelete(null)
      try {
        const result = await panelAction(endpoint, id, extra)
        // 幂等命中：stop 已结束 / retry 已有活跃重派 / message 重复投递 / close 已完成，都按提示处理而不是报错。
        if (result && result.already === true) {
          if (endpoint === 'message') setActionNotice('这条消息已发送过，未重复投递')
          else if (endpoint === 'retry') {
            setActionNotice(`已有活跃重派任务（${labelOf(STATUS_LABEL, result.status, '处理中')}），未重复创建`)
          } else if (endpoint === 'close') {
            setActionNotice('任务已完成，无需重复确认')
          } else {
            setActionNotice(`任务已是该状态（${labelOf(STATUS_LABEL, result.status, '已结束')}），无需重复停止`)
          }
        }
        if (endpoint === 'close' && result && result.ok === true && result.already !== true) {
          setActionNotice('已确认交付，任务完成')
        }
        if (endpoint === 'delete' && result && result.ok === true) {
          // 删除成功：台账记录没了，抽屉里的详情也失效，直接收起。
          setActionNotice('已删除这条任务记录（消息/通知已级联清理）')
        }
        await load(undefined)
        if (filter === 'artifacts') await loadArtifacts(undefined)
        // 抽屉正开着同一个任务：动作后刷新详情（状态/消息都变了）；已删除则直接关闭。
        if (detailTaskId === id) {
          if (endpoint === 'delete') closeDetail()
          else await openDetail(id)
        }
      } catch (failure) {
        const code = failure && typeof failure.code === 'string' && failure.code !== '' ? `（${failure.code}）` : ''
        setActionError(`${endpoint} 失败${code}：${String((failure && failure.message) || failure)}`)
      } finally {
        inFlight.current.delete(key)
        setBusy(null)
      }
    }

    const mainSession = (snapshot && snapshot.mainSession) || { id: null, live: false }
    const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : []
    const counts = countTasks(tasks)
    const visible = tasks.filter(task => matchesFilter(task, filter) && matchesQuery(task, query))
    const mainState = mainSession.id === null ? '主会话未创建' : mainSession.live ? '主会话在线' : '主会话已失效'
    const inboxCount = Number(snapshot && snapshot.inboxCount) || 0
    const detailTask = detail !== null && detail !== undefined && detail.task !== null && typeof detail.task === 'object'
      ? detail.task
      : null
    const drawerTitle = detailTask === null
      ? (detailTaskId === null ? '任务详情' : `任务 ${detailTaskId}`)
      : displayNameOf(detailTask, tasks)

    // 事件处理器：卡内按钮先 stopPropagation，避免点按钮又触发卡片「打开详情」。
    const act = handler => event => {
      if (event !== null && typeof event === 'object' && typeof event.stopPropagation === 'function') event.stopPropagation()
      handler(event)
    }

    // 折叠区开关：键出现在 collapsedSections 里就是收起。抽屉区块与官方板分区共用一份状态。
    const toggleSection = key => setCollapsedSections(current => (
      current.includes(key) ? current.filter(item => item !== key) : [...current, key]
    ))

    // props 键序/键名与迁移前一致（快照按 props 序列化顺序比对）。
    // 停止：先转成「确认停止 / 取消」，二次确认后才发请求。
    const stopControl = task => {
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'orphaned') return null
      if (confirmStop === task.id) {
        return (
          <ConfirmBar
            key="stop-confirm"
            question={'确认停止？'}
            label={'确认停止'} danger
            disabled={busy === `stop:${task.id}`}
            onConfirm={act(() => void runPanel('stop', task.id))}
            onCancel={act(() => setConfirmStop(null))}
          />
        )
      }
      return (
        <button
          key="stop" type="button" className="orch-btn orch-btn--sm orch-btn--danger"
          title="停止子会话（需要二次确认）"
          disabled={busy === `stop:${task.id}`}
          onClick={act(() => setConfirmStop(task.id))}
        >
          <Icon name="stop" />
          {busy === `stop:${task.id}` ? '停止中…' : '停止'}
        </button>
      )
    }

    const retryControl = task => (task.status === 'failed' || task.status === 'orphaned')
      ? (
        <button
          key="retry" type="button" className="orch-btn orch-btn--sm"
          title="用同一份 brief 重派"
          disabled={busy === `retry:${task.id}`}
          onClick={act(() => void runPanel('retry', task.id))}
        >
          <Icon name="retry" className={busy === `retry:${task.id}` ? 'orch-spin' : undefined} />
          {busy === `retry:${task.id}` ? '重派中…' : '重派'}
        </button>
      )
      : null

    // 确认交付（delivered → done）：与工具 task_message action:close 同源，服务端 closeGate 下发 canClose。
    // done 不可逆，所以与停止/删除同一套两步确认。
    const closeControl = task => {
      if (task === null || task === undefined || task.canClose !== true) return null
      if (task.status === 'done') return null
      if (confirmClose === task.id) {
        return (
          <ConfirmBar
            key="close-confirm"
            question={'确认交付完成？'}
            label={busy === `close:${task.id}` ? '确认中…' : '确认'}
            disabled={busy === `close:${task.id}`}
            onConfirm={act(() => void runPanel('close', task.id))}
            onCancel={act(() => setConfirmClose(null))}
          />
        )
      }
      return (
        <button
          key="close" type="button" className="orch-btn orch-btn--sm"
          title="确认这条已交付任务完成（done，不可逆）"
          disabled={busy === `close:${task.id}`}
          onClick={act(() => setConfirmClose(task.id))}
        >
          <Icon name="check" />
          {'确认交付'}
        </button>
      )
    }

    // 删除任务（连同 messages/notifications 级联清理）：只有终态任务显示（canDelete 由服务端判定）。
    // 两步：先点「删除」→ 内联「确认删除？/ 取消」，与停止同一套确认条，避免误删。
    const deleteControl = task => {
      const deletable = task !== null && task !== undefined && task.canDelete === true
      if (!deletable) return null
      if (confirmDelete === task.id) {
        return (
          <ConfirmBar
            key="delete-confirm"
            question={'确认删除？'}
            label={busy === `delete:${task.id}` ? '删除中…' : '确认删除'} danger
            disabled={busy === `delete:${task.id}`}
            onConfirm={act(() => void runPanel('delete', task.id))}
            onCancel={act(() => setConfirmDelete(null))}
          />
        )
      }
      return (
        <button
          key="delete" type="button" className="orch-btn orch-btn--sm orch-btn--danger"
          title="从台账删除这条任务与它的消息/通知（需要二次确认）"
          disabled={busy === `delete:${task.id}`}
          onClick={act(() => setConfirmDelete(task.id))}
        >
          <Icon name="trash" />
          {'删除'}
        </button>
      )
    }

    const openControl = (sessionId, label) => (
      <button
        key={`open:${label || 'child'}`} type="button" className="orch-btn orch-btn--sm"
        disabled={sessionId === null || sessionId === undefined}
        onClick={act(() => open(sessionId))}
      >
        <Icon name="external" />
        {label || '打开子会话'}
      </button>
    )

    // ---- 第一段：顶部命令栏 + 概览卡 ----
    const topbar = () => (
      <header className="orch-topbar">
        <div className="orch-brand">
          <span className="orch-brand-mark"><Icon name="sparkle" size={14} /></span>
          <span className="orch-title">{inboxCount > 0 ? `任务 · 待你决定 ${inboxCount}` : '任务'}</span>
          <span
            className="orch-status"
            data-live={mainSession.live === true ? 'true' : 'false'}
            title={mainSession.id === null ? '还没有主会话' : `主会话编号 ${mainSession.id}`}
          ><span className="orch-status-dot" />{mainState}</span>
        </div>
        <div className="orch-topbar-actions">
          <label className="orch-search" title="按标题 / 引用 / 目录搜索">
            <Icon name="search" size={13} />
            <input
              type="search"
              value={query}
              placeholder="搜索任务"
              aria-label="搜索任务"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="orch-btn orch-btn--ghost"
            title="重新拉取台账快照"
            onClick={refresh}
            disabled={refreshing}
          >
            <Icon name="refresh" className={refreshing ? 'orch-spin' : undefined} />
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="orch-btn orch-btn--primary"
            onClick={handleOpenMain}
            disabled={openingMain}
          >
            <Icon name="plus" />
            {openingMain ? '打开中…' : '打开主会话'}
          </button>
        </div>
      </header>
    )

    const metrics = () => (
      <div className="orch-metrics">
        {METRICS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="orch-metric"
            data-active={filter === value ? 'true' : 'false'}
            data-tone={value === 'failed' ? 'bad' : value === 'done' ? 'good' : value === 'waiting' ? 'warn' : 'info'}
            onClick={() => setFilter(value)}
          >
            <span className="orch-metric-value">{String(counts[value] || 0)}</span>
            <span className="orch-metric-label">{label}</span>
          </button>
        ))}
      </div>
    )

    // ---- 第二段：筛选轨 + 列表 ----
    const rail = () => (
      <nav className="orch-rail" aria-label="任务筛选">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="orch-rail-item"
            data-active={filter === value ? 'true' : 'false'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            <Icon
              name={value === 'artifacts' ? 'folder'
                : value === 'waiting' ? 'inbox'
                  : value === 'failed' ? 'alert'
                    : value === 'done' ? 'check' : 'clock'}
              size={13}
            />
            <span className="orch-rail-label">{label}</span>
            <span className="orch-rail-count">{String(value === 'all' ? counts.all : counts[value] || 0)}</span>
          </button>
        ))}
      </nav>
    )

    const alerts = () => (
      <div className="orch-stack orch-stack--sm">
        {snapshotError !== null
          ? (
              <Banner
                tone="error"
                icon="alert"
                action={<button type="button" className="orch-btn orch-btn--sm" onClick={refresh}>{'重试'}</button>}
              >{`台账暂不可用：${snapshotError}`}</Banner>
            )
          : null}
        {actionError !== null
          ? (
              <Banner
                tone="error"
                icon="alert"
                action={(
                  <button
                    type="button"
                    className="orch-btn orch-btn--sm"
                    onClick={() => setActionError(null)}
                  >{'关闭'}</button>
                )}
              >{actionError}</Banner>
            )
          : null}
        {actionNotice !== null
          ? <Banner tone="notice" icon="check">{actionNotice}</Banner>
          : null}
        {copyNotice !== null
          ? <Banner tone="info" icon="copy">{copyNotice}</Banner>
          : null}
        {inboxCount > 0
          ? (
              <Banner
                tone="notice"
                icon="inbox"
                action={(
                  <button
                    type="button"
                    className="orch-btn orch-btn--sm"
                    onClick={() => setFilter('waiting')}
                  >{'查看'}</button>
                )}
              >{`有 ${inboxCount} 个任务等你决定，切到「待你决定」查看。`}</Banner>
            )
          : null}
        {openedMain
          ? <Banner tone="info" icon="check">{'主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」。'}</Banner>
          : null}
        {snapshot !== null && mainSession.id === null
          ? <Banner tone="notice" icon="alert">{'尚未打开主会话：点右上角「打开主会话」，在指挥舱里创建。'}</Banner>
          : null}
      </div>
    )

    // 卡片小标：一个清单（顺序/文案与迁移前一致），数组化后比原来的十来个三元嵌套好读。
    // 数据全部来自快照下发的只读字段；P2-1 验收小标与 P2-3 交接徽标按字段出现，没有就整块不渲染。
    const metaChips = (task, artifactCount, isExpanded) => [
      task.targetDir !== null && task.targetDir !== undefined
        ? <Chip title={task.targetDir}><Icon name="folder" size={11} />{shortPath(task.targetDir)}</Chip>
        : null,
      task.groupId ? <Chip title="分组">{`组 ${task.groupId}`}</Chip> : null,
      task.priority ? <Chip title="优先级">{`P${task.priority}`}</Chip> : null,
      task.dependsOn && task.dependsOn.length > 0 ? <Chip title={task.dependsOn.join('、')}>{`依赖 ${task.dependsOn.length}`}</Chip> : null,
      task.queued ? <Chip>{'排队中'}</Chip> : null,
      task.stale ? <Chip tone="warn" title="超过 30 分钟没有新事件">{'⚠ 可能卡住'}</Chip> : null,
      task.goalState
        ? <Chip title="平台目标状态（只读）"><Icon name="goal" size={11} />{`目标·${labelOf(GOAL_PHASE_LABEL, task.goalState.phase)}`}</Chip>
        : null,
      task.readOnly === true ? <Chip tone="warn" title="只读任务：写文件/写 shell 会被沙箱拒绝">{'只读'}</Chip> : null,
      task.planFirst === true
        ? <Chip tone={planOpen(task) ? 'info' : 'muted'} title="计划模式：plan_state 由台账下发（只读展示）；批准只用协调者 task_message({action:'approve'})">{`计划·${labelOf(PLAN_STATE_LABEL, task.planState, '无计划状态')}`}</Chip>
        : null,
      task.worktreeState && task.worktreeState !== 'none'
        ? (
            <Chip
              tone={task.worktreeState === 'failed' ? 'bad' : (['created', 'reused'].includes(task.worktreeState) ? 'info' : 'muted')}
              title={task.worktreePath ? `检出 ${task.worktreePath}` : '未建检出'}
            >{`隔离·${labelOf(WORKTREE_STATE_LABEL, task.worktreeState)}`}</Chip>
          )
        : null,
      // P2-1 A1：交付前机器验收的结论（通过/总数）；没配检查、还没交付就没有这个字段。
      task.acceptance
        ? (
            <Chip
              tone={task.acceptance.ok === true ? 'good' : 'bad'}
              title={`交付前机器验收：${task.acceptance.passed ?? 0}/${task.acceptance.total ?? 0} 通过${task.acceptance.ok === true ? '' : '（不通过不交付）'}`}
            >{`验收 ${task.acceptance.passed ?? 0}/${task.acceptance.total ?? 0}`}</Chip>
          )
        : null,
      // P2-3 交接：已确认的写清「谁确认」；待确认靠状态徽标「待确认」，这里不重复。
      task.handoff && task.handoff.acceptedByLabel
        ? (
            <Chip title={`交接已确认：${task.handoff.acceptedByLabel}（${timeLabel(task.handoff.acceptedAt)}）`}>
              <Icon name="check" size={11} />
              {task.handoff.acceptedByLabel}
            </Chip>
          )
        : null,
      artifactCount > 0
        ? (
            <button
              type="button" className="orch-btn orch-btn--sm"
              aria-expanded={isExpanded}
              onClick={act(() => toggleArtifacts(task.id))}
            >
              <Icon name="chevron" className="orch-chevron" data-open={isExpanded ? 'true' : 'false'} />
              {`产物 ${artifactCount}`}
            </button>
          )
        : null,
    ].filter(node => node !== null && node !== undefined)

    const renderTask = (task, all) => {
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
      const isExpanded = expanded.includes(task.id)
      const displayName = displayNameOf(task, all)
      const tone = TONE_COLOR[task.tone] || TONE_COLOR.muted
      return (
        <article
          key={task.id}
          className="orch-card"
          data-open={detailTaskId === task.id ? 'true' : 'false'}
          data-status={task.status}
          onClick={event => {
            // 卡片整体可点开详情；卡内按钮用 act() 先止住冒泡。
            if (event !== null && typeof event === 'object') void openDetail(task.id)
          }}
        >
          <div className="orch-card-top">
            <span className="orch-dot" style={{ background: tone, color: tone }} />
            <span className="orch-card-title" title={displayName}>{displayName}</span>
            {statusBadge(task.status)}
            {/* P8/P0-4：计划阶段小标（只在批准前的三态出现；批准后正常执行、不占视觉）。 */}
            {planOpen(task)
              ? (
                  <Badge tone="info" title="计划模式：仓库只读探索/改计划（可写 $TMPDIR 临时文件），用 task_report blocked 上报计划；批准只在协调者侧 task_message({action:'approve'})（面板不代批）">
                    {PLAN_OPEN_BADGE[task.planState] ?? '计划中'}
                  </Badge>
                )
              : null}
            {/* P9：真的隔离了才给小标（产物在检出目录里，合并由用户决定）。 */}
            {['created', 'reused'].includes(task.worktreeState)
              ? (
                  <Badge tone="info" title={`worktree 隔离：产物在分支 ${task.worktreeBranch || '(未知)'} 的检出目录 ${task.worktreePath || '(未知)'}，合并由你决定`}>
                    {'隔离'}
                  </Badge>
                )
              : null}
            <span className="orch-card-time" title="最近事件">{timeLabel(task.lastEventAt)}</span>
          </div>
          <div className="orch-card-meta">
            {metaChips(task, artifacts.length, isExpanded)}
          </div>
          <div className="orch-card-actions">
            <button
              key="detail"
              type="button"
              className="orch-btn orch-btn--sm"
              onClick={act(() => void openDetail(task.id))}
            ><Icon name="chevron" />{'详情'}</button>
            {stopControl(task)}
            {closeControl(task)}
            {retryControl(task)}
            {openControl(task.childSessionId)}
            {deleteControl(task)}
          </div>
          {artifacts.length > 0
            ? (
                <div className="orch-expand" data-open={isExpanded ? 'true' : 'false'}>
                  <div>
                    <div className="orch-artifact-list">
                      {artifacts.map((item, index) => {
                        const itemTone = item.exists === false ? 'bad' : 'good'
                        return (
                          <DotRow key={`${item.path}:${index}`} tone={itemTone}>
                            {/* 点路径 = 在会话右侧栏打开预览（与产物库同一个入口）；缺失的文件不给点。 */}
                            <button
                              type="button"
                              className="orch-artifact-path orch-artifact-open"
                              title={item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`}
                              disabled={item.exists === false}
                              onClick={act(() => void previewInSidebar(task.id, item.path))}
                            >{`${item.path}${item.exists === false ? '（未找到）' : ''}`}</button>
                            {item.label ? <span className="orch-muted">{item.label}</span> : null}
                          </DotRow>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            : null}
          {task.question
            ? (
                <div className="orch-question">
                  <Icon name="alert" size={13} />
                  <span>{`需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(' / ')}）` : ''}`}</span>
                </div>
              )
            : null}
        </article>
      )
    }

    // ---- 产物库（A4）：按项目/日期分组 + 预览 + 复制路径 + 打开子会话 ----
    const artifactItems = Array.isArray(artifactData && artifactData.items) ? artifactData.items : []
    // 预览体只算内容，外壳统一包一次（原来 5 个分支各包一层 .orch-preview）。
    const previewBody = () => {
      if (preview.loading === true) {
        return [
          <div key="loading" className="orch-muted">{'加载预览…'}</div>,
          <div key="skeleton" className="orch-skeleton" style={{ width: '72%' }} />,
        ]
      }
      if (preview.error !== null) return <Banner tone="error">{`预览失败：${preview.error}`}</Banner>
      const data = preview.data || {}
      if (data.kind === 'text') {
        return [
          <div key="size" className="orch-muted">{`${data.size ?? 0} 字节${data.truncated === true ? '（仅显示前 64 KiB）' : ''}`}</div>,
          <pre key="text" className="orch-pre">{data.text === '' ? '（空文件）' : data.text}</pre>,
        ]
      }
      if (data.kind === 'directory') {
        return <Banner tone="notice" icon="folder">{'这是目录，不能预览内容；复制路径后在文件管理器打开。'}</Banner>
      }
      if (data.kind === 'binary') {
        return <Banner tone="notice" icon="alert">{'二进制文件，不能按文本预览；复制路径后在本地打开。'}</Banner>
      }
      return <div className="orch-muted">{'没有可预览的内容。'}</div>
    }
    const previewBlock = () => preview === null ? null : <div className="orch-preview">{previewBody()}</div>

    const artifactRow = item => {
      const key = `${item.taskId}:${item.path}`
      return (
        <DotRow key={key} tone={item.exists === false ? 'bad' : 'good'}>
          <span className="orch-artifact-path" title={item.path}>{item.path}</span>
          {item.label ? <span className="orch-muted">{item.label}</span> : null}
          {item.exists === false ? <Chip tone="bad">{'（未找到）'}</Chip> : null}
          <Chip title="来源任务">{`${item.title || item.taskId}${item.status ? ` · ${labelOf(STATUS_LABEL, item.status)}` : ''}`}</Chip>
          <span className="orch-msg-at">{timeLabel(item.at)}</span>
          {/* 产物库这一行本身能渲染行内预览，所以右侧栏不可用时退到这里（inlineFallback）。 */}
          <button
            type="button" className="orch-btn orch-btn--sm"
            disabled={item.exists === false}
            onClick={() => void previewInSidebar(item.taskId, item.path, true)}
          >{'预览'}</button>
          <button
            type="button" className="orch-btn orch-btn--sm"
            onClick={() => void copyPath(item.path)}
          >{'复制路径'}</button>
          {item.childSessionId
            ? (
                <button
                  type="button" className="orch-btn orch-btn--sm"
                  onClick={() => open(item.childSessionId)}
                >{'打开子会话'}</button>
              )
            : null}
          <button
            type="button" className="orch-btn orch-btn--sm"
            onClick={() => void openDetail(item.taskId)}
          >{'详情'}</button>
          {/* 回退：右侧栏不可用时 previewInSidebar 会退到行内预览，这里渲染它的内容。 */}
          {preview !== null && preview.key === key ? previewBlock() : null}
        </DotRow>
      )
    }

    const artifactView = () => {
      if (artifactData === null) {
        if (artifactError !== null) {
          return (
            <Banner
              tone="error" icon="alert"
              action={
                <button
                  type="button" className="orch-btn orch-btn--sm"
                  onClick={() => void loadArtifacts(undefined)}
                >{'重新加载'}</button>
              }
            >{`产物加载失败：${artifactError}`}</Banner>
          )
        }
        return artifactLoading
          ? <SkeletonList rows={3} />
          : <EmptyState icon="folder" title="产物库还没加载" hint="点「刷新」重新拉取产物库。" />
      }
      return (
        <div className="orch-stack orch-stack--md">
          <div className="orch-card-meta">
            <span className="orch-muted">{`共 ${artifactItems.length} 个产物${artifactError !== null ? '（刷新失败，显示上次结果）' : ''}`}</span>
            <div className="orch-seg">
              <button
                type="button" className="orch-seg-item"
                data-active={artifactGroup === 'project' ? 'true' : 'false'}
                onClick={() => setArtifactGroup('project')}
              >{'按项目'}</button>
              <button
                type="button" className="orch-seg-item"
                data-active={artifactGroup === 'date' ? 'true' : 'false'}
                onClick={() => setArtifactGroup('date')}
              >{'按日期'}</button>
            </div>
          </div>
          {artifactError !== null ? <Banner tone="error" icon="alert">{`产物加载失败：${artifactError}`}</Banner> : null}
          {artifactItems.length === 0
            ? (
                <EmptyState
                  icon="folder"
                  title="还没有产物"
                  hint="还没有产物。任务 done 时会自动收集改动文件；也可以显式传 task_report.artifacts。"
                />
              )
            : (
                <div className="orch-stack orch-stack--lg">
                  {groupArtifacts(artifactItems, artifactGroup).map(([name, rows]) => (
                    <section key={`${artifactGroup}:${name}`} className="orch-group">
                      <div className="orch-group-head">
                        <span className="orch-group-title">{name}</span>
                        <span className="orch-muted">{`${rows.length} 个`}</span>
                      </div>
                      <div className="orch-stack orch-stack--xs">{rows.map(artifactRow)}</div>
                    </section>
                  ))}
                </div>
              )}
        </div>
      )
    }

    // ---- P2-5（S9′）：官方 Team（只读）分区 ----
    // 数据来自 snapshot.teamBoard（P2-4 的只读投影）：`enabled !== true` 时**整区不渲染**——
    // 服务缺失/形状变了/Team 未开启都不该在面板上刷存在感（与 docs/compat.md「面板隐藏该分区」同口径）。
    // 只有 `enabled === true`（Team 真的开着）但 `degraded` 有值（这次 listTasks 没读成）才给一条只读提示，
    // 不假装没有。行内**没有任何按钮**：认领/完成只能在官方 Team 里做，插件绝不越权。
    // 折叠壳复用抽屉的 detailSection（同一份 collapsedSections 状态），不另写一套可折叠 DOM。
    const boardView = () => {
      const board = snapshot === null ? null : snapshot.teamBoard
      if (board === null || board === undefined) return null
      if (board.enabled !== true) return null
      const degraded = board.degraded ?? null
      if (degraded !== null) {
        return <Banner tone="notice" icon="alert">{`官方 Team 板暂时读不到：${degraded.message || degraded.code}`}</Banner>
      }
      const rows = Array.isArray(board.rows) ? board.rows : []
      const body = rows.length === 0
        ? <div className="orch-muted">{'官方板上还没有任务。'}</div>
        : [
            ...rows.map(row => (
              <DotRow key={`board:${row.id}`} tone={toneOf(BOARD_TONE, row.status)}>
                <span className="orch-board-subject" title={row.subject || row.id}>{row.subject || row.id}</span>
                <Badge tone={toneOf(BOARD_TONE, row.status)}>{row.statusLabel || row.status || '未知'}</Badge>
                {row.owner ? <Chip title="官方板负责人">{`负责人 ${row.owner}`}</Chip> : null}
                {Array.isArray(row.blockedBy) && row.blockedBy.length > 0
                  ? <Chip tone="warn" title={`被 ${row.blockedBy.join('、')} 挡住`}>{`等 ${row.blockedBy.length}`}</Chip>
                  : null}
                <span className="orch-msg-at">{`rev ${row.revision ?? '-'}`}</span>
              </DotRow>
            )),
            <div key="board-note" className="orch-muted">{'官方板只读：任务由官方 Team 的成员认领与完成，插件不改官方状态。'}</div>,
          ]
      return detailSection(BOARD_SECTION, '官方 Team（只读）', `${rows.length} 条 · 只读`, body, { 'data-orch-board': 'true' })
    }

    // 列表区：骨架（首帧）→ 空态 → 任务卡。
    const listView = () => {
      if (snapshot === null) {
        if (snapshotError === null) return <SkeletonList rows={5} />
        return (
          <EmptyState
            icon="alert"
            title="台账还没就绪"
            hint="快照请求失败，点上面的「重试」重新拉取；也可以直接「打开主会话」进去看看。"
          />
        )
      }
      if (visible.length === 0) {
        return tasks.length === 0
          ? (
              <EmptyState
                icon="inbox"
                title="还没有任务"
                hint="在主会话里用 task_create 建第一个任务；面板会实时同步状态、依赖和产物。"
              />
            )
          : (
              <EmptyState
                icon="search"
                title="没有匹配的任务"
                hint="换个筛选项，或清空搜索框再试。"
                action={
                  <button
                    type="button" className="orch-btn orch-btn--ghost orch-btn--sm"
                    onClick={() => { setFilter('all'); setQuery('') }}
                  >{'清空筛选'}</button>
                }
              />
            )
      }
      return <div className="orch-list">{visible.map(task => renderTask(task, tasks))}</div>
    }

    // ---- 第三段：右侧抽屉详情 ----
    const drawerLoading = () => (
      <div className="orch-drawer-sections">
        <div className="orch-skeleton-card">
          <div className="orch-skeleton-row">
            <div className="orch-skeleton" style={{ width: '40%' }} />
            <div className="orch-skeleton" style={{ width: 60, marginLeft: 'auto' }} />
          </div>
          <div className="orch-skeleton" style={{ width: '86%' }} />
          <div className="orch-skeleton" style={{ width: '72%' }} />
        </div>
        <SkeletonList rows={2} />
      </div>
    )

    const drawerError = () => (
      <div className="orch-stack orch-stack--sm">
        <Banner tone="error" icon="alert">{detailError}</Banner>
        <div className="orch-card-actions">
          <button
            type="button" className="orch-btn orch-btn--ghost"
            onClick={() => { if (detailTaskId !== null) void openDetail(detailTaskId) }}
          >{'重新加载'}</button>
          <button type="button" className="orch-btn" onClick={closeDetail}>{'关闭'}</button>
        </div>
      </div>
    )

    // 抽屉里的可折叠区块：标题是 button，带 aria-expanded；0fr↔1fr 过渡。
    // 官方板只读分区也用这个壳（多传 attrs 挂 data-orch-board），折叠状态同源。
    const detailSection = (key, title, hint, body, attrs = {}) => {
      const isCollapsed = collapsedSections.includes(key)
      return (
        <section key={key} {...attrs} className="orch-section" data-collapsed={isCollapsed ? 'true' : 'false'}>
          <button
            type="button" className="orch-section-head"
            aria-expanded={!isCollapsed}
            onClick={() => toggleSection(key)}
          >
            <Icon name="chevron" className="orch-chevron" />
            <span className="orch-section-title">{title}</span>
            {hint ? <span className="orch-section-hint">{hint}</span> : null}
          </button>
          <div className="orch-section-body-wrap">
            <div className="orch-section-body">
              <div className="orch-section-inner">{body}</div>
            </div>
          </div>
        </section>
      )
    }

    const detailBody = () => {
      const task = detail.task || {}
      // R3：详情下发的「消息里提到的引用 → 台账现名/墓碑状态」索引（老服务端没有这个字段时按空表）。
      const detailRefs = Array.isArray(detail.refs) ? detail.refs : []
      // 1) 概览：引用/状态/目录/分组/优先级/写域/时间。
      const overviewBody = (
        <div className="orch-kv">
          <KvRows rows={[
            // 版本 B：抽屉概览显示**任务引用**（tk-xxxxxx），不显示台账内部编号。
            ['引用', task.ref || '（未生成）'],
            ['状态', labelOf(STATUS_LABEL, task.status)],
            // delivered 两段式：交付时间与关闭原因（协调者确认 / 超时自动完成）。
            ...(task.deliveredAt ? [['交付', `${timeLabel(task.deliveredAt)}（待确认：确认交付收成已完成；追问由协调者 task_message 续派原会话）`]] : []),
            ...(task.closeReason ? [['关闭', task.closeReasonLabel || task.closeReason]] : []),
            ['目标目录', task.targetDir || '（未设置）'],
            ['分组', task.group || '（未分组）'],
            ['优先级', `P${task.priority ?? 0}`],
            ['计划', task.planFirst === true ? labelOf(PLAN_STATE_LABEL, task.planState, '无计划状态') : '（不是计划任务）'],
            ['隔离', task.worktreeState && task.worktreeState !== 'none'
              ? `${labelOf(WORKTREE_STATE_LABEL, task.worktreeState)}｜分支 ${task.worktreeBranch || '-'}｜检出 ${task.worktreePath || '-'}｜决定 ${labelOf(WORKTREE_SOURCE_LABEL, task.worktreeSource)}`
              : '（未隔离）'],
            ['写域', Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join('、') : '（未声明）'],
            ['创建', timeLabel(task.createdAt)],
            ['更新', timeLabel(task.updatedAt)],
          ]} />
        </div>
      )

      // 2) B1 最新回复：台账只存借条（P1 正文去重），正文由服务端 `detail.body` 说明来源：
      //    host = 刚从宿主会话日志冷读；inline/file = 旧行自带正文；summary = 读不到（只剩摘要）。
      const bodyInfo = detail !== null && typeof detail.body === 'object' && detail.body !== null ? detail.body : null
      const bodyMissing = bodyInfo !== null && bodyInfo.source === 'summary'
      const lastMessage = task.lastMessage !== null && typeof task.lastMessage === 'object' ? task.lastMessage : null
      const lastMessageBadge = lastMessage === null
        ? ''
        : lastMessage.stored === 'host'
          ? (bodyMissing ? '正文不可读（摘要）' : '正文来自子会话')
          : (lastMessage.stored === 'file' ? '全文在报告文件' : '内联正文')
      const lastMessageBody = lastMessage === null
        ? <div className="orch-muted">{'还没有返回消息（子会话结算后自动记录最后一条回复）。'}</div>
        : (
          <div className="orch-stack">
            <div className="orch-card-meta">
              <Badge tone={bodyMissing ? 'warn' : 'info'}>{lastMessageBadge}</Badge>
              {lastMessage.stopReason ? <Chip title="结束原因">{lastMessage.stopReason}</Chip> : null}
              <span className="orch-msg-at">{timeLabel(lastMessage.at)}</span>
              {typeof lastMessage.chars === 'number' ? <span className="orch-msg-at">{`${lastMessage.chars} 字`}</span> : null}
            </div>
            {bodyMissing
              ? (
                <div className="orch-muted">
                  {`正文不可读：${bodyInfo.unavailable || 'host-log-missing'}；以下只是台账里的摘要。`}
                </div>
              )
              : null}
            <pre className="orch-pre">{lastMessage.stored === 'file'
              ? `${lastMessage.summary || ''}\n\n全文：${lastMessage.path || '（路径缺失）'}`
              : <RefText text={String(lastMessage.text || lastMessage.summary || '（空）')} tasks={tasks} refs={detailRefs} />}</pre>
          </div>
        )

      // 3) brief：结构化 brief 原样渲染（目标 / 验收 / 约束 / 背景 / 原话）。
      const brief = task.brief !== null && typeof task.brief === 'object' && !Array.isArray(task.brief) ? task.brief : {}
      const briefGoal = textOf(brief.goal) || textOf(task.goal)
      const acceptance = listOf(brief.acceptance)
      const constraints = listOf(brief.constraints)
      const refs = listOf(brief.refs)
      const verbatim = textOf(brief.user_verbatim)
      const briefEmpty = briefGoal === '' && acceptance.length === 0 && constraints.length === 0
        && refs.length === 0 && verbatim === ''
      const briefLists = (label, items) => (
        <div>
          <div className="orch-kv-key">{label}</div>
          <ul className="orch-ul">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )
      const briefBody = briefEmpty
        ? <div className="orch-muted">{'这条任务没有 brief 信息。'}</div>
        : (
          <div className="orch-stack orch-stack--sm">
            {briefGoal !== '' ? <div className="orch-text">{briefGoal}</div> : null}
            {acceptance.length > 0 ? briefLists('验收标准：', acceptance) : null}
            {constraints.length > 0 ? briefLists('约束：', constraints) : null}
            {refs.length > 0 ? briefLists('背景资料：', refs) : null}
            {verbatim !== '' ? (
              <div>
                <div className="orch-kv-key">{'用户原话：'}</div>
                <blockquote className="orch-quote">{verbatim}</blockquote>
              </div>
            ) : null}
          </div>
        )

      // 3.5) P2-1 A1：交付前机器验收（task_create.checks）。记录由插件在 task_report done 前写入；
      // 没配检查的任务显示空态，配了但没交付过的任务显示「待执行」清单。
      const acceptanceRecord = task.acceptance !== null && typeof task.acceptance === 'object' && !Array.isArray(task.acceptance)
        ? task.acceptance
        : null
      const checkSpec = Array.isArray(acceptanceRecord?.spec) && acceptanceRecord.spec.length > 0
        ? acceptanceRecord.spec
        : (Array.isArray(brief.checks) ? brief.checks : [])
      const checkResults = Array.isArray(acceptanceRecord?.results) ? acceptanceRecord.results : []
      const commandOf = argv => (Array.isArray(argv) ? argv : [])
        .map(arg => /\s/.test(String(arg)) ? `"${arg}"` : String(arg))
        .join(' ')
      const acceptanceHint = acceptanceRecord === null
        ? (checkSpec.length > 0 ? `${checkSpec.length} 条待执行` : '')
        : `${acceptanceRecord.passed || 0}/${acceptanceRecord.total || 0} 通过`
      const acceptanceBody = checkSpec.length === 0 && acceptanceRecord === null
        ? <div className="orch-muted">{'这条任务没有配置可执行检查（task_create.checks）：交付只凭子会话自述。'}</div>
        : (
          <div className="orch-stack">
            <div className="orch-card-meta">
              {acceptanceRecord === null
                ? <Badge tone="muted">{'未执行（交付前自动跑）'}</Badge>
                : <Badge tone={acceptanceRecord.ok === true ? 'good' : 'bad'}>{acceptanceRecord.ok === true ? '验收通过' : '验收未通过'}</Badge>}
              {acceptanceRecord?.ranAt ? <span className="orch-msg-at">{timeLabel(acceptanceRecord.ranAt)}</span> : null}
              {typeof acceptanceRecord?.cwd === 'string' && acceptanceRecord.cwd !== ''
                ? <span className="orch-msg-at">{`目录 ${acceptanceRecord.cwd}`}</span>
                : null}
            </div>
            {checkSpec.length === 0 ? null : (
              <div className="orch-stack orch-stack--xs">
                {checkSpec.map((check, index) => {
                  const result = checkResults.find(item => item && item.name === check.name) ?? checkResults[index] ?? null
                  const tone = result === null
                    ? 'muted'
                    : (result.ok === true ? 'good' : (result.skipped === true ? 'muted' : 'bad'))
                  const state = result === null
                    ? '未执行'
                    : (result.ok === true
                      ? '通过'
                      : (result.skipped === true
                        ? '已跳过'
                        : (result.timedOut === true
                          ? '超时'
                          : `失败（退出码 ${result.exitCode === null || result.exitCode === undefined ? '?' : result.exitCode}）`)))
                  const details = result === null ? [] : [`${result.durationMs}ms`]
                  if (result?.error === 'ENOENT') details.push('命令不存在')
                  if (result?.truncated === true) details.push('输出已截断')
                  return (
                    <DotRow key={`${check.name}:${index}`} tone={tone}>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} title={commandOf(check.command)}>
                        {`${check.name}：${commandOf(check.command)}`}
                      </span>
                      {details.length > 0 ? <span className="orch-muted">{details.join('｜')}</span> : null}
                      <Badge tone={tone}>{state}</Badge>
                    </DotRow>
                  )
                })}
              </div>
            )}
            {checkResults.filter(item => item?.outputTail && (item.ok !== true || item.truncated === true)).map(item => (
              <div key={`output:${item.name}`}>
                <div className="orch-kv-key">{`${item.name} 输出尾部：`}</div>
                <pre className="orch-pre">{String(item.outputTail)}</pre>
              </div>
            ))}
            <div className="orch-muted">
              {'未通过时任务不会交付（状态不变），修复后重报 done；需要拍板就报 blocked。检查在插件宿主进程里执行（不是子会话沙箱），cwd 固定为任务目录。'}
            </div>
          </div>
        )

      // 4) 平台 goal（只读）：phase/activation/轮次，插件自动维护；面板没有改目标的按钮。
      const goalState = task.goalState !== null && typeof task.goalState === 'object' ? task.goalState : null
      const goalBody = goalState === null
        ? <div className="orch-muted">{'没有平台目标状态（goal 服务不可用，或任务尚未派发/已收口）。'}</div>
        : (
          <div className="orch-kv">
            <KvRows rows={[
              ['目标', textOf(goalState.objective) || '（未记录）'],
              ['阶段', labelOf(GOAL_PHASE_LABEL, goalState.phase)],
              ['续轮', `${labelOf(GOAL_ACTIVATION_LABEL, goalState.activation)}（默认不续轮；续轮由宿主 goal 轮次驱动，面板不改）`],
              ['轮次', goalState.roundsStarted === null || goalState.roundsStarted === undefined
                ? '-'
                : `${goalState.roundsStarted}/${goalState.maxGoalRounds ?? '?'}`],
              ['修订', goalState.revision ?? '-'],
            ]} />
          </div>
        )
      const goalNote = (
        <div className="orch-muted">
          {'只读展示：由插件在派发、续派与终态时自动维护；面板不提供暂停/恢复/清除操作。'}
        </div>
      )

      // 5) 消息：最近 20 条；followup 带投递状态（待发/已投递/投递失败）。
      const messages = Array.isArray(detail.messages) ? detail.messages : []
      const shownMessages = messages.slice(-20)
      const messageBody = messages.length === 0
        ? <div className="orch-muted">{'还没有消息。'}</div>
        : (
          <div className="orch-stack orch-stack--xs">
            {shownMessages.map((row, index) => (
              <div key={row.seq === undefined ? index : row.seq} className="orch-msg" data-kind={row.kind}>
                <div className="orch-msg-head">
                  <Badge tone="muted">{labelOf(MESSAGE_KIND_LABEL, row.kind)}</Badge>
                  {row.delivery
                    ? (
                      <Badge
                        tone={toneOf(DELIVERY_TONE, row.delivery)}
                        title={`投递状态：${labelOf(DELIVERY_LABEL, row.delivery)}`}
                      >{labelOf(DELIVERY_LABEL, row.delivery)}</Badge>
                    )
                    : null}
                  <span className="orch-msg-at">{timeLabel(row.at)}</span>
                </div>
                {/* R3：消息正文里的 tk- 引用显示成任务名（查不到就原样显示）。 */}
                <div className="orch-msg-text"><RefText text={row.text} tasks={tasks} refs={detailRefs} /></div>
              </div>
            ))}
            {messages.length > shownMessages.length
              ? <div className="orch-muted">{`仅显示最近 ${shownMessages.length} 条（共 ${messages.length} 条）。`}</div>
              : null}
          </div>
        )

      // 6) 依赖：上游前置 + 下游依赖本任务，各自带状态和错误提示。
      const dependencies = Array.isArray(detail.dependencies) ? detail.dependencies : []
      const dependents = Array.isArray(detail.dependents) ? detail.dependents : []
      // R1：前置/下游行只显示「名称 + 引用」；已删除的前置不回落内部编号（显示占位 + 墓碑引用）。
      const depRow = row => (
        <DotRow key={`${row.status}:${row.id}`} tone={toneOf(STATUS_TONE, row.status)}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} title={row.error || row.ref || row.title}>
            {(row.title === '' || row.title === undefined || row.title === null) ? '（任务已删除）' : row.title}
          </span>
          {row.ref ? <Chip tone="muted" title={`引用 ${row.ref}`}>{row.ref}</Chip> : null}
          {statusBadge(row.status)}
          {row.error ? <Chip tone="bad" title={row.error}>{'有错误'}</Chip> : null}
        </DotRow>
      )
      const depBody = (
        <div className="orch-stack orch-stack--xs">
          <div className="orch-kv-key">{'上游（前置任务）'}</div>
          {dependencies.length === 0
            ? <div className="orch-muted">{'没有前置任务。'}</div>
            : <div className="orch-stack orch-stack--xs">{dependencies.map(depRow)}</div>}
          <div className="orch-kv-key">{'下游（依赖本任务）'}</div>
          {dependents.length === 0
            ? <div className="orch-muted">{'没有下游任务。'}</div>
            : <div className="orch-stack orch-stack--xs">{dependents.map(depRow)}</div>}
        </div>
      )

      // 7) 产物：路径/标签/存在性；路径可点开（会话右侧栏预览）也可一键复制。
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
      const artifactBody = (
          <div className="orch-stack orch-stack--xs">
            <div>{task.artifactStoreDir}</div>
            {task.artifactStage ? <div>{`${task.artifactStage.mode} · ${task.artifactStage.complete ? '已保存' : '不完整'}${task.artifactStage.git?.unarchived ? ' · 未归档' : ''}`}</div> : null}
            {artifacts.length === 0 ? <div className="orch-muted">{'还没有产物。'}</div> : null}
            {artifacts.map((item, index) => (
              <DotRow key={`${item.path}:${index}`} tone={item.exists === false ? 'bad' : 'good'}>
                <button
                  type="button"
                  className="orch-artifact-path orch-artifact-open"
                  title={item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`}
                  disabled={item.exists === false}
                  onClick={act(() => void previewInSidebar(task.id, item.path))}
                >{item.path}</button>
                {item.label ? <span className="orch-muted">{item.label}</span> : null}
                {item.exists === false ? <Chip tone="bad">{'（未找到）'}</Chip> : null}
                <button type="button" className="orch-btn orch-btn--sm" onClick={() => void copyPath(item.path)}>{'复制路径'}</button>
              </DotRow>
            ))}
          </div>
        )

      // 8) P2-3 交接契约：谁/何时确认 + 轮次 + 验收证据 + 官方板关联（P2-4）。
      // 没交付过就没有交接（服务端返回 null），这里显示空态而不是编一个空壳。
      const handoff = task.handoff !== null && typeof task.handoff === 'object' ? task.handoff : null
      const teamTask = task.teamTask !== null && typeof task.teamTask === 'object' ? task.teamTask : null
      const acceptedLabel = handoff === null ? null : labelOf(ACCEPTED_BY_LABEL, handoff.acceptedBy, '未知方式')
      const handoffHint = handoff === null
        ? ''
        : (handoff.acceptedAt === null || handoff.acceptedAt === undefined ? '待确认' : acceptedLabel)
      const handoffBody = handoff === null
        ? <div className="orch-muted">{'这条任务还没交付，没有交接记录；交付后这里显示「谁、何时、怎么确认」。'}</div>
        : (
          <div className="orch-kv">
            <KvRows rows={[
              ['契约', `v${handoff.contract ?? '?'}`],
              ['交付', timeLabel(handoff.deliveredAt)],
              ['确认', handoff.acceptedAt === null || handoff.acceptedAt === undefined
                ? '未确认（等你或协调者确认，或超时自动完成）'
                : `${acceptedLabel}（${timeLabel(handoff.acceptedAt)}）`],
              ['轮次', `派发 ${handoff.rounds?.turns ?? 0} 次｜追问 ${handoff.rounds?.followups ?? 0} 次`],
              ['验收', handoff.evidence?.acceptance
                ? `${handoff.evidence.acceptance.passed ?? 0}/${handoff.evidence.acceptance.total ?? 0} 通过`
                : '未执行'],
              ['官方板', teamTask === null
                ? '未关联'
                : `${teamTask.id}（revision ${teamTask.revision ?? '未知'}｜${teamTask.row?.statusLabel || '读不到当前状态'}）`],
              ['证据', `${Array.isArray(handoff.evidence?.artifacts) ? handoff.evidence.artifacts.length : 0} 个产物`],
            ]} />
          </div>
        )
      // 官方板读不到时把原因写清楚（只读，不影响本地交付结论）。
      const teamNote = teamTask !== null && teamTask.degraded
        ? <div className="orch-muted">{`官方 Team 板读取降级：${teamTask.degraded.message || teamTask.degraded.code}`}</div>
        : null

      return (
        <div className="orch-drawer-sections">
          {task.question
            ? (
              <Banner
                tone="notice" icon="alert"
              >{`需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(' / ')}）` : ''}`}</Banner>
            )
            : null}
          {task.error ? <Banner tone="error" icon="alert">{`错误：${task.error}`}</Banner> : null}
          {detailSection('概览', '概览', '', overviewBody)}
          {detailSection('最新回复', '最新回复', lastMessage === null ? '' : timeLabel(lastMessage.at), lastMessageBody)}
          {detailSection('Brief', 'Brief', acceptance.length > 0 ? `验收 ${acceptance.length} 条` : '', briefBody)}
          {detailSection('验收', '验收', acceptanceHint, acceptanceBody)}
          {detailSection('交接', '交接', handoffHint, handoffBody)}
          {detailSection('目标状态', '目标状态', goalState === null ? '' : labelOf(GOAL_PHASE_LABEL, goalState.phase, ''), goalBody)}
          {detailSection('消息', '消息', messages.length > 0 ? `${messages.length} 条` : '', messageBody)}
          {detailSection('依赖', '依赖', `上游 ${dependencies.length} · 下游 ${dependents.length}`, depBody)}
          {detailSection('产物', '产物', artifacts.length > 0 ? `${artifacts.length} 个` : '', artifactBody)}
          {teamNote}
          {goalNote}
        </div>
      )
    }

    const drawerFoot = () => {
      const buttons = [
        stopControl(detailTask),
        closeControl(detailTask),
        retryControl(detailTask),
        detailTask.target ? openControl(detailTask.target, '打开子会话') : null,
        deleteControl(detailTask),
        // 不能删就说清原因：活跃任务先「停止」；终态但还有活跃下游先处理下游。
        detailTask.canDelete !== true
          ? <span key="delete-hint" className="orch-muted">{'当前不能删除：活跃任务先「停止」；有活跃下游依赖则先处理下游。'}</span>
          : null,
      ].filter(Boolean)
      return buttons.length === 0 ? null : <footer className="orch-drawer-foot">{buttons}</footer>
    }

    const drawerContent = () => (
      <div className="orch-drawer-content">
        <header className="orch-drawer-head">
          <div className="orch-drawer-title-row">
            <span className="orch-drawer-title" title={drawerTitle}>{drawerTitle}</span>
            {detailTask === null ? null : statusBadge(detailTask.status)}
            <button
              type="button" className="orch-icon-btn" title="关闭（Esc）" onClick={closeDetail}
            ><Icon name="close" /></button>
          </div>
          <div className="orch-drawer-sub">
            {/* 版本 B：抽屉副标题显示任务引用（tk-），不显示台账内部编号。 */}
            {detailTask === null ? null : <span>{`引用 ${detailTask.ref || '—'}`}</span>}
            {detailTask === null ? null : <span>{`更新 ${timeLabel(detailTask.updatedAt)}`}</span>}
            {detailTask !== null && detailTask.readOnly === true ? <span>{'只读任务'}</span> : null}
            {detailTask !== null && detailTask.planFirst === true
              ? <span>{`计划：${labelOf(PLAN_STATE_LABEL, detailTask.planState, '无计划状态')}`}</span>
              : null}
          </div>
        </header>
        <div className="orch-drawer-body">
          {/* chip 点击降级提示（子会话打不开）：只在这一次抽屉里显示，见 focusNotice。 */}
          {focusNotice === null ? null : <Banner tone="notice" icon="alert">{focusNotice}</Banner>}
          {detailLoading ? drawerLoading() : null}
          {detailError !== null ? drawerError() : null}
          {detailTask === null ? null : detailBody()}
        </div>
        {detailTask === null ? null : drawerFoot()}
      </div>
    )

    // ---- 工作台 v1（P11）：五页渲染 ----
    // 总览沿用旧的「指标卡 + 筛选轨 + 列表 / 产物库」，把它们收进一页，行为与改版前一致。
    const workbenchGroups = groupsState.data?.groups ?? []
    const overviewPage = () => {
      const todayPlanned = plannedOnDay(tasks, dateKeyOf(Date.now()))
      const rows = automationState.data?.rows ?? []
      const nextAutomation = rows.find(row => row.active === true && Number.isFinite(row.nextFireAt)) ?? rows[0] ?? null
      return (
        <div className="orch-wb" data-page="overview">
          {metrics()}
          <Wb.OverviewPage
            tasks={tasks}
            planned={todayPlanned}
            nextAutomation={nextAutomation}
            onOpenDetail={openDetail}
            onPage={setPage}
            list={(
              <div className="orch-wb-overviewlist">
                <div className="orch-wb-filters">{rail()}</div>
                {boardView()}
                {filter === 'artifacts' ? artifactView() : listView()}
              </div>
            )}
          />
        </div>
      )
    }

    const groupsPage = () => (
      <div className="orch-wb" data-page="groups">
        <Wb.GroupsPage
          state={groupsState}
          onReload={() => { void loadGroups() }}
          onOpen={openGroup}
          onRename={renameGroup}
          onArchive={setGroupArchived}
          ungrouped={groupsState.data?.ungrouped ?? null}
        />
      </div>
    )

    const dock = () => (
      <Wb.Dock
        detail={detail}
        group={groupState.data?.group ?? null}
        notices={[]}
        onOpenSession={open}
        onJumpMain={handleOpenMain}
      />
    )

    const groupPageView = () => (
      <div className="orch-wb" data-page="group">
        <Wb.GroupPage
          state={groupState}
          groupId={groupId}
          onBack={() => setPage('groups')}
          onReload={() => { void loadGroup(groupId) }}
          onOpenDetail={openDetail}
          onPlan={planTask}
          onPreview={(taskId, path, inline) => { void previewInSidebar(taskId, path, inline === true) }}
          onCopy={path => { void copyPath(path) }}
          dock={dock()}
          onOpenMain={handleOpenMain}
          onRename={renameGroup}
          onArchive={setGroupArchived}
        />
      </div>
    )

    const schedulePage = () => (
      <div className="orch-wb" data-page="schedule">
        <Wb.SchedulePage
          state={calendarState}
          tasks={tasks}
          anchor={monthAnchor}
          onAnchor={setMonthAnchor}
          onPlan={planTask}
          onClearPlan={taskId => planTask(taskId, null)}
          onOpenDetail={openDetail}
          onReload={() => { void loadCalendar(monthAnchor) }}
        />
      </div>
    )

    const automationsPage = () => (
      <div className="orch-wb" data-page="automations">
        <Wb.AutomationsPage
          state={automationState}
          busy={wbBusy}
          onReload={() => { void loadAutomations() }}
          onCreate={createAutomationEntry}
          onOpenSchedules={openSchedules}
          onToggle={switchAutomation}
          onDelete={removeAutomation}
        />
      </div>
    )

    const reviewPage = () => (
      <div className="orch-wb" data-page="review">
        <Wb.ReviewPage
          state={reviewState}
          days={reviewDays}
          onDays={setReviewDays}
          onReload={() => { void loadReview(reviewDays) }}
        />
      </div>
    )

    const pageNav = () => (
      <Wb.PageNav
        page={page === 'group' ? 'groups' : page}
        onPage={next => {
          if (next === 'groups') {
            setGroupId(null)
            setGroupState({ data: null, error: null })
          }
          setPage(next)
        }}
        inboxCount={inboxCount}
        groupCount={workbenchGroups.length}
        automationCount={automationState.data?.rows?.length ?? 0}
      />
    )

    return (
      <div className="orch-shell">
        {topbar()}
        <div className="orch-body orch-body--workbench">
          <main className="orch-main orch-wb-shell">
            {alerts()}
            {pageNav()}
            {page === 'overview' ? overviewPage() : null}
            {page === 'groups' ? groupsPage() : null}
            {page === 'group' ? groupPageView() : null}
            {page === 'schedule' ? schedulePage() : null}
            {page === 'automations' ? automationsPage() : null}
            {page === 'review' ? reviewPage() : null}
          </main>
        </div>
        {/* 第三段：抽屉常驻挂载，靠 data-open 触发 transform 过渡（关闭时滑出而不是瞬移）。 */}
        <div className="orch-layer">
          <div
            className="orch-scrim"
            data-open={drawerOpen ? 'true' : 'false'}
            aria-hidden="true"
            onClick={closeDetail}
          />
          <aside
            className="orch-drawer"
            data-open={drawerOpen ? 'true' : 'false'}
            aria-hidden={drawerOpen ? 'false' : 'true'}
            aria-label="任务详情"
          >{drawerOpen ? drawerContent() : null}</aside>
        </div>
      </div>
    )
  }
  return { HeaderButton, LauncherIcon, LauncherPanel, TasksPanel, TaskChipRow }
}
