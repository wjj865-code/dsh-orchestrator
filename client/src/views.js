/**
 * 面板视图（P7 / T7.2 迁入）：三段式任务面板、启动器面板、会话头按钮、侧栏图标。
 *
 * 依赖（React/h、常量、纯逻辑、API、展示组件）全部由 client.js 在 factory 里一次性注入，
 * 本模块不直接 import react，也不读全局 window（除了已有的 window.addEventListener 行为）。
 */
export function createViews({
  React, h,
  Icon, Badge, Chip, EmptyState, Banner, SkeletonList,
  FILTERS, METRICS, POLL_MS, POLL_BACKOFF_MS,
  STATUS_LABEL, STATUS_TONE, MESSAGE_KIND_LABEL, DELIVERY_LABEL, DELIVERY_TONE,
  GOAL_PHASE_LABEL, GOAL_ACTIVATION_LABEL, PLAN_STATE_LABEL, WORKTREE_STATE_LABEL, WORKTREE_SOURCE_LABEL, TONE_COLOR,
  displayNameOf, textOf, listOf, timeLabel, shortPath,
  countTasks, matchesFilter, matchesQuery, groupArtifacts,
  readSnapshot, readArtifacts, readDetail, readPreview, panelAction, openMainOnce,
}) {
  // 会话头「任务」入口：仅主会话显示。useMainView 由下面 conversation.header.leading 的 inject
  // 以 hooks.mainView 提供；hook 缺失或未判定（默认 false）时返回 null，入口隐藏。
  // 视觉按面板顶栏 .orch-brand 的语言：品牌色方块装内联 SVG 图标 + 半粗文字（不再用裸字符 ☰）。
  const HeaderButton = ({ openPanel, useMainView }) => {
    const visible = typeof useMainView === 'function' ? useMainView(value => value === true) : false
    if (visible !== true) return null
    return h('button', {
      type: 'button', title: '任务面板', 'aria-label': '打开任务面板',
      className: 'orch-btn orch-btn--entry', onClick: openPanel,
    },
      h('span', { className: 'orch-entry-mark' }, h(Icon, { name: 'menu', size: 12 })),
      h('span', { className: 'orch-entry-label' }, '任务'))
  }

  // 侧栏「插件」下方的入口图标（面板行渲染的是这个组件）。
  const LauncherIcon = () => h('span', { 'aria-hidden': true, className: 'orch-launcher-icon' }, '\u25C8')

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
    return h('div', { className: 'orch-shell orch-launcher' },
      h('div', { className: 'orch-launcher-card' },
        h('span', { className: 'orch-brand-mark' }, h(Icon, { name: 'sparkle', size: 14 })),
        h('div', { className: 'orch-title' }, error === null ? '正在打开主会话…' : '打开主会话失败'),
        error === null
          ? h('div', { className: 'orch-skeleton', style: { width: 120 } })
          : null,
        error === null
          ? null
          : h('button', { type: 'button', className: 'orch-btn orch-btn--primary', onClick: run }, '重试'),
      ),
      error === null ? null : h('div', { style: { width: 'min(420px, 100%)' } }, h(Banner, { tone: 'error' }, error)),
    )
  }

  const TasksPanel = ({ openSession, openArtifactPreview }) => {
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
            setActionNotice(`已有活跃重派任务（${STATUS_LABEL[result.status] || result.status || '处理中'}），未重复创建`)
          } else if (endpoint === 'close') {
            setActionNotice('任务已完成，无需重复确认')
          } else {
            setActionNotice(`任务已是该状态（${STATUS_LABEL[result.status] || result.status || '已结束'}），无需重复停止`)
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

    const statusBadge = status => h(Badge, {
      tone: STATUS_TONE[status] || 'muted', title: STATUS_LABEL[status] || status,
    }, STATUS_LABEL[status] || status || '未知')

    // 停止：先转成「确认停止 / 取消」，二次确认后才发请求。
    const stopControl = task => {
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'orphaned') return null
      if (confirmStop === task.id) {
        return h('span', { key: 'stop-confirm', className: 'orch-confirm' },
          h('span', null, '确认停止？'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm orch-btn--danger',
            disabled: busy === `stop:${task.id}`,
            onClick: act(() => void runPanel('stop', task.id)),
          }, '确认停止'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: act(() => setConfirmStop(null)),
          }, '取消'),
        )
      }
      return h('button', {
        key: 'stop', type: 'button', className: 'orch-btn orch-btn--sm orch-btn--danger',
        title: '停止子会话（需要二次确认）',
        disabled: busy === `stop:${task.id}`,
        onClick: act(() => setConfirmStop(task.id)),
      }, h(Icon, { name: 'stop' }), busy === `stop:${task.id}` ? '停止中…' : '停止')
    }

    const retryControl = task => (task.status === 'failed' || task.status === 'orphaned')
      ? h('button', {
        key: 'retry', type: 'button', className: 'orch-btn orch-btn--sm',
        title: '用同一份 brief 重派',
        disabled: busy === `retry:${task.id}`,
        onClick: act(() => void runPanel('retry', task.id)),
      }, h(Icon, { name: 'retry', className: busy === `retry:${task.id}` ? 'orch-spin' : undefined }),
      busy === `retry:${task.id}` ? '重派中…' : '重派')
      : null

    // 确认交付（delivered → done）：与工具 task_close 同源，服务端 closeGate 下发 canClose。
    // done 不可逆，所以与停止/删除同一套两步确认。
    const closeControl = task => {
      if (task === null || task === undefined || task.canClose !== true) return null
      if (task.status === 'done') return null
      if (confirmClose === task.id) {
        return h('span', { key: 'close-confirm', className: 'orch-confirm' },
          h('span', null, '确认交付完成？'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            disabled: busy === `close:${task.id}`,
            onClick: act(() => void runPanel('close', task.id)),
          }, busy === `close:${task.id}` ? '确认中…' : '确认'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: act(() => setConfirmClose(null)),
          }, '取消'),
        )
      }
      return h('button', {
        key: 'close', type: 'button', className: 'orch-btn orch-btn--sm',
        title: '确认这条已交付任务完成（done，不可逆）',
        disabled: busy === `close:${task.id}`,
        onClick: act(() => setConfirmClose(task.id)),
      }, h(Icon, { name: 'check' }), '确认交付')
    }

    // 删除任务（连同 messages/notifications 级联清理）：只有终态任务显示（canDelete 由服务端判定）。
    // 两步：先点「删除」→ 内联「确认删除？/ 取消」，与停止同一套确认条，避免误删。
    const deleteControl = task => {
      const deletable = task !== null && task !== undefined && task.canDelete === true
      if (!deletable) return null
      if (confirmDelete === task.id) {
        return h('span', { key: 'delete-confirm', className: 'orch-confirm' },
          h('span', null, '确认删除？'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm orch-btn--danger',
            disabled: busy === `delete:${task.id}`,
            onClick: act(() => void runPanel('delete', task.id)),
          }, busy === `delete:${task.id}` ? '删除中…' : '确认删除'),
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: act(() => setConfirmDelete(null)),
          }, '取消'),
        )
      }
      return h('button', {
        key: 'delete', type: 'button', className: 'orch-btn orch-btn--sm orch-btn--danger',
        title: '从台账删除这条任务与它的消息/通知（需要二次确认）',
        disabled: busy === `delete:${task.id}`,
        onClick: act(() => setConfirmDelete(task.id)),
      }, h(Icon, { name: 'trash' }), '删除')
    }

    const openControl = (sessionId, label) => h('button', {
      key: `open:${label || 'child'}`, type: 'button', className: 'orch-btn orch-btn--sm',
      disabled: sessionId === null || sessionId === undefined,
      onClick: act(() => open(sessionId)),
    }, h(Icon, { name: 'external' }), label || '打开子会话')

    // ---- 第一段：顶部命令栏 + 概览卡 ----
    const topbar = () => h('header', { className: 'orch-topbar' },
      h('div', { className: 'orch-brand' },
        h('span', { className: 'orch-brand-mark' }, h(Icon, { name: 'sparkle', size: 14 })),
        h('span', { className: 'orch-title' }, inboxCount > 0 ? `任务 · 待你决定 ${inboxCount}` : '任务'),
        h('span', {
          className: 'orch-status',
          'data-live': mainSession.live === true ? 'true' : 'false',
          title: mainSession.id === null ? '还没有主会话' : `主会话编号 ${mainSession.id}`,
        }, h('span', { className: 'orch-status-dot' }), mainState),
      ),
      h('div', { className: 'orch-topbar-actions' },
        h('label', { className: 'orch-search', title: '按标题 / 编号 / 目录搜索' },
          h(Icon, { name: 'search', size: 13 }),
          h('input', {
            type: 'search', value: query, placeholder: '搜索任务',
            'aria-label': '搜索任务',
            onChange: event => setQuery(event.target.value),
          }),
        ),
        h('button', {
          type: 'button', className: 'orch-btn orch-btn--ghost', title: '重新拉取台账快照',
          onClick: refresh, disabled: refreshing,
        }, h(Icon, { name: 'refresh', className: refreshing ? 'orch-spin' : undefined }),
        refreshing ? '刷新中…' : '刷新'),
        h('button', {
          type: 'button', className: 'orch-btn orch-btn--primary', onClick: handleOpenMain, disabled: openingMain,
        }, h(Icon, { name: 'plus' }), openingMain ? '打开中…' : '打开主会话'),
      ),
    )

    const metrics = () => h('div', { className: 'orch-metrics' },
      METRICS.map(([value, label]) => h('button', {
        key: value, type: 'button', className: 'orch-metric',
        'data-active': filter === value ? 'true' : 'false',
        'data-tone': value === 'failed' ? 'bad' : value === 'done' ? 'good' : value === 'waiting' ? 'warn' : 'info',
        onClick: () => setFilter(value),
      },
        h('span', { className: 'orch-metric-value' }, String(counts[value] || 0)),
        h('span', { className: 'orch-metric-label' }, label),
      )),
    )

    // ---- 第二段：筛选轨 + 列表 ----
    const rail = () => h('nav', { className: 'orch-rail', 'aria-label': '任务筛选' },
      FILTERS.map(([value, label]) => h('button', {
        key: value, type: 'button', className: 'orch-rail-item',
        'data-active': filter === value ? 'true' : 'false',
        'aria-pressed': filter === value,
        onClick: () => setFilter(value),
      },
        h(Icon, {
          name: value === 'artifacts' ? 'folder'
            : value === 'waiting' ? 'inbox'
              : value === 'failed' ? 'alert'
                : value === 'done' ? 'check' : 'clock',
          size: 13,
        }),
        h('span', { className: 'orch-rail-label' }, label),
        h('span', { className: 'orch-rail-count' }, String(value === 'all' ? counts.all : counts[value] || 0)),
      )),
    )

    const alerts = () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      snapshotError !== null
        ? h(Banner, {
          tone: 'error', icon: 'alert',
          action: h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: refresh }, '重试'),
        }, `台账暂不可用：${snapshotError}`)
        : null,
      actionError !== null
        ? h(Banner, {
          tone: 'error', icon: 'alert',
          action: h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => setActionError(null) }, '关闭'),
        }, actionError)
        : null,
      actionNotice !== null
        ? h(Banner, { tone: 'notice', icon: 'check' }, actionNotice)
        : null,
      copyNotice !== null
        ? h(Banner, { tone: 'info', icon: 'copy' }, copyNotice)
        : null,
      inboxCount > 0
        ? h(Banner, {
          tone: 'notice', icon: 'inbox',
          action: h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: () => setFilter('waiting'),
          }, '查看'),
        }, `有 ${inboxCount} 个任务等你决定，切到「待你决定」查看。`)
        : null,
      openedMain
        ? h(Banner, { tone: 'info', icon: 'check' }, '主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」。')
        : null,
      snapshot !== null && mainSession.id === null
        ? h(Banner, { tone: 'notice', icon: 'alert' }, '尚未打开主会话：点右上角「打开主会话」，在指挥舱里创建。')
        : null,
    )

    const renderTask = (task, all) => {
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
      const isExpanded = expanded.includes(task.id)
      const displayName = displayNameOf(task, all)
      const tone = TONE_COLOR[task.tone] || TONE_COLOR.muted
      return h('article', {
        key: task.id, className: 'orch-card',
        'data-open': detailTaskId === task.id ? 'true' : 'false',
        'data-status': task.status,
        onClick: event => {
          // 卡片整体可点开详情；卡内按钮用 act() 先止住冒泡。
          if (event !== null && typeof event === 'object') void openDetail(task.id)
        },
      },
        h('div', { className: 'orch-card-top' },
          h('span', { className: 'orch-dot', style: { background: tone, color: tone } }),
          h('span', { className: 'orch-card-title', title: displayName }, displayName),
          statusBadge(task.status),
          // P8：计划阶段小标（只在「等批准」时出现；批准后正常执行，不占视觉）。
          task.planState === 'planning'
            ? h(Badge, { tone: 'info', title: '计划模式：子会话只读探索，用 task_report blocked 上报计划，批准后自动切回可写' }, '计划中')
            : null,
          // P9：真的隔离了才给小标（产物在检出目录里，合并由用户决定）。
          ['created', 'reused'].includes(task.worktreeState)
            ? h(Badge, { tone: 'info', title: `worktree 隔离：产物在分支 ${task.worktreeBranch || '(未知)'} 的检出目录 ${task.worktreePath || '(未知)'}，合并由你决定` }, '隔离')
            : null,
          h('span', { className: 'orch-card-time', title: '最近事件' }, timeLabel(task.lastEventAt)),
        ),
        h('div', { className: 'orch-card-meta' },
          task.targetDir !== null && task.targetDir !== undefined
            ? h(Chip, { title: task.targetDir }, h(Icon, { name: 'folder', size: 11 }), shortPath(task.targetDir))
            : null,
          task.groupId ? h(Chip, { title: '分组' }, `组 ${task.groupId}`) : null,
          task.priority ? h(Chip, { title: '优先级' }, `P${task.priority}`) : null,
          task.dependsOn && task.dependsOn.length > 0
            ? h(Chip, { title: task.dependsOn.join('、') }, `依赖 ${task.dependsOn.length}`)
            : null,
          task.queued ? h(Chip, null, '排队中') : null,
          task.stale ? h(Chip, { tone: 'warn', title: '超过 30 分钟没有新事件' }, '⚠ 可能卡住') : null,
          task.goalState
            ? h(Chip, { title: '平台目标状态（只读）' }, h(Icon, { name: 'goal', size: 11 }), `目标·${GOAL_PHASE_LABEL[task.goalState.phase] || task.goalState.phase || '未知'}`)
            : null,
          task.readOnly === true
            ? h(Chip, { tone: 'warn', title: '只读任务：写文件/写 shell 会被沙箱拒绝' }, '只读')
            : null,
          task.planFirst === true
            ? h(Chip, {
              tone: task.planState === 'planning' ? 'info' : 'muted',
              title: '计划模式：plan_state 由台账下发（只读展示）',
            }, `计划·${PLAN_STATE_LABEL[task.planState] || task.planState || '无计划状态'}`)
            : null,
          task.worktreeState && task.worktreeState !== 'none'
            ? h(Chip, {
              tone: task.worktreeState === 'failed' ? 'bad' : (['created', 'reused'].includes(task.worktreeState) ? 'info' : 'muted'),
              title: task.worktreePath ? `检出 ${task.worktreePath}` : '未建检出',
            }, `隔离·${WORKTREE_STATE_LABEL?.[task.worktreeState] || task.worktreeState}`)
            : null,
          artifacts.length > 0
            ? h('button', {
              type: 'button', className: 'orch-btn orch-btn--sm',
              'aria-expanded': isExpanded,
              onClick: act(() => toggleArtifacts(task.id)),
            },
              h(Icon, { name: 'chevron', className: 'orch-chevron', 'data-open': isExpanded ? 'true' : 'false' }),
              `产物 ${artifacts.length}`)
            : null,
        ),
        h('div', { className: 'orch-card-actions' },
          h('button', {
            key: 'detail', type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: act(() => void openDetail(task.id)),
          }, h(Icon, { name: 'chevron' }), '详情'),
          stopControl(task),
          closeControl(task),
          retryControl(task),
          openControl(task.childSessionId),
          deleteControl(task),
        ),
        artifacts.length > 0
          ? h('div', { className: 'orch-expand', 'data-open': isExpanded ? 'true' : 'false' },
            h('div', null,
              h('div', { className: 'orch-artifact-list' },
                artifacts.map((item, index) => {
                  const itemTone = item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good
                  return h('div', { key: `${item.path}:${index}`, className: 'orch-artifact' },
                    h('span', { className: 'orch-dot', style: { background: itemTone, color: itemTone } }),
                    // 点路径 = 在会话右侧栏打开预览（与产物库同一个入口）；缺失的文件不给点。
                    h('button', {
                      type: 'button',
                      className: 'orch-artifact-path orch-artifact-open',
                      title: item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`,
                      disabled: item.exists === false,
                      onClick: act(() => void previewInSidebar(task.id, item.path)),
                    }, `${item.path}${item.exists === false ? '（未找到）' : ''}`),
                    item.label ? h('span', { className: 'orch-muted' }, item.label) : null,
                  )
                }),
              ),
            ),
          )
          : null,
        task.question
          ? h('div', { className: 'orch-question' },
            h(Icon, { name: 'alert', size: 13 }),
            h('span', null, `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(' / ')}）` : ''}`))
          : null,
      )
    }

    // ---- 产物库（A4）：按项目/日期分组 + 预览 + 复制路径 + 打开子会话 ----
    const artifactItems = Array.isArray(artifactData && artifactData.items) ? artifactData.items : []
    const previewBlock = () => {
      if (preview === null) return null
      if (preview.loading === true) {
        return h('div', { className: 'orch-preview' },
          h('div', { className: 'orch-muted' }, '加载预览…'),
          h('div', { className: 'orch-skeleton', style: { width: '72%' } }),
        )
      }
      if (preview.error !== null) {
        return h('div', { className: 'orch-preview' }, h(Banner, { tone: 'error' }, `预览失败：${preview.error}`))
      }
      const data = preview.data || {}
      if (data.kind === 'text') {
        return h('div', { className: 'orch-preview' },
          h('div', { className: 'orch-muted' }, `${data.size ?? 0} 字节${data.truncated === true ? '（仅显示前 64 KiB）' : ''}`),
          h('pre', { className: 'orch-pre' }, data.text === '' ? '（空文件）' : data.text),
        )
      }
      if (data.kind === 'directory') {
        return h('div', { className: 'orch-preview' },
          h(Banner, { tone: 'notice', icon: 'folder' }, '这是目录，不能预览内容；复制路径后在文件管理器打开。'))
      }
      if (data.kind === 'binary') {
        return h('div', { className: 'orch-preview' },
          h(Banner, { tone: 'notice', icon: 'alert' }, '二进制文件，不能按文本预览；复制路径后在本地打开。'))
      }
      return h('div', { className: 'orch-preview' }, h('div', { className: 'orch-muted' }, '没有可预览的内容。'))
    }

    const artifactRow = item => {
      const key = `${item.taskId}:${item.path}`
      const tone = item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good
      return h('div', { key, className: 'orch-artifact' },
        h('span', { className: 'orch-dot', style: { background: tone, color: tone } }),
        h('span', { className: 'orch-artifact-path', title: item.path }, item.path),
        item.label ? h('span', { className: 'orch-muted' }, item.label) : null,
        item.exists === false ? h(Chip, { tone: 'bad' }, '（未找到）') : null,
        h(Chip, { title: '来源任务' }, `${item.title || item.taskId}${item.status ? ` · ${STATUS_LABEL[item.status] || item.status}` : ''}`),
        h('span', { className: 'orch-msg-at' }, timeLabel(item.at)),
        h('button', {
          type: 'button', className: 'orch-btn orch-btn--sm',
          disabled: item.exists === false,
          // 产物库这一行本身能渲染行内预览，所以右侧栏不可用时退到这里（inlineFallback）。
          onClick: () => void previewInSidebar(item.taskId, item.path, true),
        }, '预览'),
        h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => void copyPath(item.path) }, '复制路径'),
        item.childSessionId
          ? h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => open(item.childSessionId) }, '打开子会话')
          : null,
        h('button', {
          type: 'button', className: 'orch-btn orch-btn--sm',
          onClick: () => void openDetail(item.taskId),
        }, '详情'),
        // 回退：右侧栏不可用时 previewInSidebar 会退到行内预览，这里渲染它的内容。
        preview !== null && preview.key === key ? previewBlock() : null,
      )
    }

    const artifactView = () => {
      if (artifactData === null) {
        if (artifactError !== null) {
          return h(Banner, {
            tone: 'error', icon: 'alert',
            action: h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => void loadArtifacts(undefined) }, '重新加载'),
          }, `产物加载失败：${artifactError}`)
        }
        return artifactLoading
          ? h(SkeletonList, { rows: 3 })
          : h(EmptyState, { icon: 'folder', title: '产物库还没加载', hint: '点「刷新」重新拉取产物库。' })
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'orch-card-meta' },
          h('span', { className: 'orch-muted' },
            `共 ${artifactItems.length} 个产物${artifactError !== null ? '（刷新失败，显示上次结果）' : ''}`),
          h('div', { className: 'orch-seg' },
            h('button', {
              type: 'button', className: 'orch-seg-item',
              'data-active': artifactGroup === 'project' ? 'true' : 'false',
              onClick: () => setArtifactGroup('project'),
            }, '按项目'),
            h('button', {
              type: 'button', className: 'orch-seg-item',
              'data-active': artifactGroup === 'date' ? 'true' : 'false',
              onClick: () => setArtifactGroup('date'),
            }, '按日期'),
          ),
        ),
        artifactError !== null ? h(Banner, { tone: 'error', icon: 'alert' }, `产物加载失败：${artifactError}`) : null,
        artifactItems.length === 0
          ? h(EmptyState, {
            icon: 'folder',
            title: '还没有产物',
            hint: '还没有产物。任务 done 时会自动收集改动文件；也可以显式传 task_report.artifacts。',
          })
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
            groupArtifacts(artifactItems, artifactGroup).map(([name, rows]) => h('section', {
              key: `${artifactGroup}:${name}`, className: 'orch-group',
            },
              h('div', { className: 'orch-group-head' },
                h('span', { className: 'orch-group-title' }, name),
                h('span', { className: 'orch-muted' }, `${rows.length} 个`),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, rows.map(artifactRow)),
            ))),
      )
    }

    // 列表区：骨架（首帧）→ 空态 → 任务卡。
    const listView = () => {
      if (snapshot === null) {
        if (snapshotError === null) return h(SkeletonList, { rows: 5 })
        return h(EmptyState, {
          icon: 'alert',
          title: '台账还没就绪',
          hint: '快照请求失败，点上面的「重试」重新拉取；也可以直接「打开主会话」进去看看。',
        })
      }
      if (visible.length === 0) {
        return tasks.length === 0
          ? h(EmptyState, {
            icon: 'inbox',
            title: '还没有任务',
            hint: '在主会话里用 task_create 建第一个任务；面板会实时同步状态、依赖和产物。',
          })
          : h(EmptyState, {
            icon: 'search',
            title: '没有匹配的任务',
            hint: '换个筛选项，或清空搜索框再试。',
            action: h('button', {
              type: 'button', className: 'orch-btn orch-btn--ghost orch-btn--sm',
              onClick: () => { setFilter('all'); setQuery('') },
            }, '清空筛选'),
          })
      }
      return h('div', { className: 'orch-list' }, visible.map(task => renderTask(task, tasks)))
    }

    // ---- 第三段：右侧抽屉详情 ----
    const drawerLoading = () => h('div', { className: 'orch-drawer-sections' },
      h('div', { className: 'orch-skeleton-card' },
        h('div', { className: 'orch-skeleton-row' },
          h('div', { className: 'orch-skeleton', style: { width: '40%' } }),
          h('div', { className: 'orch-skeleton', style: { width: 60, marginLeft: 'auto' } }),
        ),
        h('div', { className: 'orch-skeleton', style: { width: '86%' } }),
        h('div', { className: 'orch-skeleton', style: { width: '72%' } }),
      ),
      h(SkeletonList, { rows: 2 }),
    )

    const drawerError = () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h(Banner, { tone: 'error', icon: 'alert' }, detailError),
      h('div', { className: 'orch-card-actions' },
        h('button', {
          type: 'button', className: 'orch-btn orch-btn--ghost',
          onClick: () => { if (detailTaskId !== null) void openDetail(detailTaskId) },
        }, '重新加载'),
        h('button', { type: 'button', className: 'orch-btn', onClick: closeDetail }, '关闭'),
      ),
    )

    // 抽屉里的可折叠区块：标题是 button，带 aria-expanded；0fr↔1fr 过渡。
    const detailSection = (key, title, hint, body) => {
      const isCollapsed = collapsedSections.includes(key)
      return h('section', { key, className: 'orch-section', 'data-collapsed': isCollapsed ? 'true' : 'false' },
        h('button', {
          type: 'button', className: 'orch-section-head',
          'aria-expanded': !isCollapsed,
          onClick: () => setCollapsedSections(current => current.includes(key)
            ? current.filter(item => item !== key)
            : [...current, key]),
        },
          h(Icon, { name: 'chevron', className: 'orch-chevron' }),
          h('span', { className: 'orch-section-title' }, title),
          hint ? h('span', { className: 'orch-section-hint' }, hint) : null,
        ),
        h('div', { className: 'orch-section-body-wrap' },
          h('div', { className: 'orch-section-body' },
            h('div', { className: 'orch-section-inner' }, body),
          ),
        ),
      )
    }

    const detailBody = () => {
      const task = detail.task || {}
      // 1) 概览：编号/状态/目录/分组/优先级/写域/时间。
      const overviewBody = h('div', { className: 'orch-kv' }, [
        ['编号', task.id],
        ['状态', STATUS_LABEL[task.status] || task.status || '未知'],
        // delivered 两段式：交付时间与关闭原因（协调者确认 / 超时自动完成）。
        ...(task.deliveredAt ? [['交付', `${timeLabel(task.deliveredAt)}（待确认：确认交付收成已完成；追问由协调者 task_message 续派原会话）`]] : []),
        ...(task.closeReason ? [['关闭', task.closeReasonLabel || task.closeReason]] : []),
        ['目标目录', task.targetDir || '（未设置）'],
        ['分组', task.group || '（未分组）'],
        ['优先级', `P${task.priority === undefined || task.priority === null ? 0 : task.priority}`],
        ['计划', task.planFirst === true ? (PLAN_STATE_LABEL[task.planState] || task.planState || '无计划状态') : '（不是计划任务）'],
        ['隔离', task.worktreeState && task.worktreeState !== 'none'
          ? `${WORKTREE_STATE_LABEL?.[task.worktreeState] || task.worktreeState}｜分支 ${task.worktreeBranch || '-'}｜检出 ${task.worktreePath || '-'}｜决定 ${WORKTREE_SOURCE_LABEL?.[task.worktreeSource] || task.worktreeSource || '未知'}`
          : '（未隔离）'],
        ['写域', Array.isArray(task.writeScopes) && task.writeScopes.length > 0 ? task.writeScopes.join('、') : '（未声明）'],
        ['创建', timeLabel(task.createdAt)],
        ['更新', timeLabel(task.updatedAt)],
      ].flatMap(([key, value]) => [
        h('span', { key: `${key}:k`, className: 'orch-kv-key' }, key),
        h('span', { key: `${key}:v`, className: 'orch-kv-val' }, String(value === undefined || value === null ? '' : value)),
      ]))

      // 2) B1 最新回复：结算时落库的最后一条 assistant 消息（内联正文 / 大文件摘要+路径）。
      const lastMessage = task.lastMessage !== null && typeof task.lastMessage === 'object' ? task.lastMessage : null
      const lastMessageBody = lastMessage === null
        ? h('div', { className: 'orch-muted' }, '还没有返回消息（子会话结算后自动记录最后一条回复）。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { className: 'orch-card-meta' },
            h(Badge, { tone: 'info' }, lastMessage.stored === 'file' ? '全文在报告文件' : '内联正文'),
            lastMessage.stopReason ? h(Chip, { title: '结束原因' }, lastMessage.stopReason) : null,
            h('span', { className: 'orch-msg-at' }, timeLabel(lastMessage.at)),
            typeof lastMessage.chars === 'number' ? h('span', { className: 'orch-msg-at' }, `${lastMessage.chars} 字`) : null,
          ),
          h('pre', { className: 'orch-pre' }, lastMessage.stored === 'file'
            ? `${lastMessage.summary || ''}\n\n全文：${lastMessage.path || '（路径缺失）'}`
            : String(lastMessage.text || lastMessage.summary || '（空）')),
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
      const briefLists = (label, items) => h('div', null,
        h('div', { className: 'orch-kv-key' }, label),
        h('ul', { className: 'orch-ul' }, items.map((item, index) => h('li', { key: index }, item))),
      )
      const briefBody = briefEmpty
        ? h('div', { className: 'orch-muted' }, '这条任务没有 brief 信息。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          briefGoal !== '' ? h('div', { className: 'orch-text' }, briefGoal) : null,
          acceptance.length > 0 ? briefLists('验收标准：', acceptance) : null,
          constraints.length > 0 ? briefLists('约束：', constraints) : null,
          refs.length > 0 ? briefLists('背景资料：', refs) : null,
          verbatim !== '' ? h('div', null,
            h('div', { className: 'orch-kv-key' }, '用户原话：'),
            h('blockquote', { className: 'orch-quote' }, verbatim),
          ) : null,
        )

      // 4) 平台 goal（只读）：phase/activation/轮次，插件自动维护；面板没有改目标的按钮。
      const goalState = task.goalState !== null && typeof task.goalState === 'object' ? task.goalState : null
      const goalBody = goalState === null
        ? h('div', { className: 'orch-muted' }, '没有平台目标状态（goal 服务不可用，或任务尚未派发/已收口）。')
        : h('div', { className: 'orch-kv' }, [
          ['目标', textOf(goalState.objective) || '（未记录）'],
          ['阶段', GOAL_PHASE_LABEL[goalState.phase] || goalState.phase || '未知'],
          ['续轮', `${GOAL_ACTIVATION_LABEL[goalState.activation] || goalState.activation || '未知'}（插件声明式接入，恒为不自动续轮）`],
          ['轮次', goalState.roundsStarted === null || goalState.roundsStarted === undefined
            ? '-'
            : `${goalState.roundsStarted}/${goalState.maxGoalRounds === null || goalState.maxGoalRounds === undefined ? '?' : goalState.maxGoalRounds}`],
          ['修订', goalState.revision === null || goalState.revision === undefined ? '-' : String(goalState.revision)],
        ].flatMap(([key, value]) => [
          h('span', { key: `${key}:k`, className: 'orch-kv-key' }, key),
          h('span', { key: `${key}:v`, className: 'orch-kv-val' }, String(value)),
        ]))
      const goalNote = h('div', { className: 'orch-muted' },
        '只读展示：由插件在派发、续派与终态时自动维护；面板不提供暂停/恢复/清除操作。')

      // 5) 消息：最近 20 条；followup 带投递状态（待发/已投递/投递失败）。
      const messages = Array.isArray(detail.messages) ? detail.messages : []
      const shownMessages = messages.slice(-20)
      const messageBody = messages.length === 0
        ? h('div', { className: 'orch-muted' }, '还没有消息。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          shownMessages.map((row, index) => h('div', {
            key: row.seq === undefined ? index : row.seq,
            className: 'orch-msg',
            'data-kind': row.kind,
          },
            h('div', { className: 'orch-msg-head' },
              h(Badge, { tone: 'muted' }, MESSAGE_KIND_LABEL[row.kind] || row.kind),
              row.delivery
                ? h(Badge, {
                  tone: DELIVERY_TONE[row.delivery] || 'muted',
                  title: `投递状态：${DELIVERY_LABEL[row.delivery] || row.delivery}`,
                }, DELIVERY_LABEL[row.delivery] || row.delivery)
                : null,
              h('span', { className: 'orch-msg-at' }, timeLabel(row.at)),
            ),
            h('div', { className: 'orch-msg-text' }, row.text),
          )),
          messages.length > shownMessages.length
            ? h('div', { className: 'orch-muted' }, `仅显示最近 ${shownMessages.length} 条（共 ${messages.length} 条）。`)
            : null,
        )

      // 6) 依赖：上游前置 + 下游依赖本任务，各自带状态和错误提示。
      const dependencies = Array.isArray(detail.dependencies) ? detail.dependencies : []
      const dependents = Array.isArray(detail.dependents) ? detail.dependents : []
      const depRow = row => {
        const tone = TONE_COLOR[STATUS_TONE[row.status]] || TONE_COLOR.muted
        return h('div', { key: `${row.status}:${row.id}`, className: 'orch-artifact' },
          h('span', { className: 'orch-dot', style: { background: tone, color: tone } }),
          h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' }, title: row.error || row.id }, row.title),
          h(Badge, { tone: STATUS_TONE[row.status] || 'muted' }, STATUS_LABEL[row.status] || row.status || '未知'),
          row.error ? h(Chip, { tone: 'bad', title: row.error }, '有错误') : null,
        )
      }
      const depBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { className: 'orch-kv-key' }, '上游（前置任务）'),
        dependencies.length === 0
          ? h('div', { className: 'orch-muted' }, '没有前置任务。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, dependencies.map(depRow)),
        h('div', { className: 'orch-kv-key' }, '下游（依赖本任务）'),
        dependents.length === 0
          ? h('div', { className: 'orch-muted' }, '没有下游任务。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, dependents.map(depRow)),
      )

      // 7) 产物：路径/标签/存在性；路径可点开（会话右侧栏预览）也可一键复制。
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
      const artifactBody = artifacts.length === 0
        ? h('div', { className: 'orch-muted' }, '还没有产物。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          artifacts.map((item, index) => {
            const tone = item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good
            return h('div', { key: `${item.path}:${index}`, className: 'orch-artifact' },
              h('span', { className: 'orch-dot', style: { background: tone, color: tone } }),
              h('button', {
                type: 'button',
                className: 'orch-artifact-path orch-artifact-open',
                title: item.exists === false ? `${item.path}（未找到）` : `在右侧栏预览 ${item.path}`,
                disabled: item.exists === false,
                onClick: act(() => void previewInSidebar(task.id, item.path)),
              }, item.path),
              item.label ? h('span', { className: 'orch-muted' }, item.label) : null,
              item.exists === false ? h(Chip, { tone: 'bad' }, '（未找到）') : null,
              h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => void copyPath(item.path) }, '复制路径'),
            )
          }),
        )

      return h('div', { className: 'orch-drawer-sections' },
        task.question
          ? h(Banner, {
            tone: 'notice', icon: 'alert',
          }, `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(' / ')}）` : ''}`)
          : null,
        task.error ? h(Banner, { tone: 'error', icon: 'alert' }, `错误：${task.error}`) : null,
        detailSection('概览', '概览', '', overviewBody),
        detailSection('最新回复', '最新回复', lastMessage === null ? '' : timeLabel(lastMessage.at), lastMessageBody),
        detailSection('Brief', 'Brief', acceptance.length > 0 ? `验收 ${acceptance.length} 条` : '', briefBody),
        detailSection('目标状态', '目标状态', goalState === null ? '' : (GOAL_PHASE_LABEL[goalState.phase] || goalState.phase || ''), goalBody),
        detailSection('消息', '消息', messages.length > 0 ? `${messages.length} 条` : '', messageBody),
        detailSection('依赖', '依赖', `上游 ${dependencies.length} · 下游 ${dependents.length}`, depBody),
        detailSection('产物', '产物', artifacts.length > 0 ? `${artifacts.length} 个` : '', artifactBody),
        goalNote,
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
          ? h('span', { key: 'delete-hint', className: 'orch-muted' }, '当前不能删除：活跃任务先「停止」；有活跃下游依赖则先处理下游。')
          : null,
      ].filter(Boolean)
      return buttons.length === 0 ? null : h('footer', { className: 'orch-drawer-foot' }, buttons)
    }

    const drawerContent = () => h('div', { className: 'orch-drawer-content' },
      h('header', { className: 'orch-drawer-head' },
        h('div', { className: 'orch-drawer-title-row' },
          h('span', { className: 'orch-drawer-title', title: drawerTitle }, drawerTitle),
          detailTask === null ? null : statusBadge(detailTask.status),
          h('button', {
            type: 'button', className: 'orch-icon-btn', title: '关闭（Esc）', onClick: closeDetail,
          }, h(Icon, { name: 'close' })),
        ),
        h('div', { className: 'orch-drawer-sub' },
          detailTask === null ? null : h('span', null, `编号 ${detailTask.id}`),
          detailTask === null ? null : h('span', null, `更新 ${timeLabel(detailTask.updatedAt)}`),
          detailTask !== null && detailTask.readOnly === true ? h('span', null, '只读任务') : null,
          detailTask !== null && detailTask.planFirst === true
            ? h('span', null, `计划：${PLAN_STATE_LABEL[detailTask.planState] || detailTask.planState || '无计划状态'}`)
            : null,
        ),
      ),
      h('div', { className: 'orch-drawer-body' },
        detailLoading ? drawerLoading() : null,
        detailError !== null ? drawerError() : null,
        detailTask === null ? null : detailBody(),
      ),
      detailTask === null ? null : drawerFoot(),
    )

    return h('div', { className: 'orch-shell' },
      topbar(),
      metrics(),
      h('div', { className: 'orch-body' },
        rail(),
        h('main', { className: 'orch-main' },
          alerts(),
          filter === 'artifacts' ? artifactView() : listView(),
        ),
      ),
      // 第三段：抽屉常驻挂载，靠 data-open 触发 transform 过渡（关闭时滑出而不是瞬移）。
      h('div', { className: 'orch-layer' },
        h('div', {
          className: 'orch-scrim',
          'data-open': drawerOpen ? 'true' : 'false',
          'aria-hidden': 'true',
          onClick: closeDetail,
        }),
        h('aside', {
          className: 'orch-drawer',
          'data-open': drawerOpen ? 'true' : 'false',
          'aria-hidden': drawerOpen ? 'false' : 'true',
          'aria-label': '任务详情',
        }, drawerOpen ? drawerContent() : null),
      ),
    )
  }
  return { HeaderButton, LauncherIcon, LauncherPanel, TasksPanel }
}
