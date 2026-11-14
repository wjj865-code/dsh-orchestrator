// dsh-orchestrator 客户端薄插件（经典脚本，模块加载器用 <script> 加载，顶层不能有 import/export）。
// 槽位：sidebar.panellist 启动器入口（插件下方）、main 任务面板 + 启动器面板、conversation.header.leading 会话头按钮。
window.__ModuleLoader__.load({
  // 客户端工厂 id 必须等于包名（DSH client-modules 按包名索引），scoped 包也一样。
  id: '@wjj865-code/dsh-orchestrator',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const inject = ['slots', 'layout', 'uiWorkspace']
    const PANEL_ID = 'orchestrator'
    const LAUNCHER_ID = 'orchestrator-launcher'
    const ROUTE = 'api/orchestrator'
    const POLL_MS = 2000
    const POLL_BACKOFF_MS = 30000
    const FILTERS = [
      ['all', '全部'], ['active', '进行中'], ['waiting', '待你决定'],
      ['done', '已完成'], ['failed', '失败'], ['closed', '已取消/丢失'], ['artifacts', '产物'],
    ]

    const STATUS_LABEL = {
      waiting_dep: '等前置', pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
      done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失', missing: '缺失',
    }
    const STATUS_TONE = {
      waiting_dep: 'warn', pending: 'muted', running: 'info', waiting_user: 'warn', waiting_auth: 'warn',
      done: 'good', failed: 'bad', cancelled: 'muted', orphaned: 'bad', missing: 'bad',
    }
    // 消息类型与 followup 的投递状态（与 src/panel-actions.js 的 delivery 字段一一对应）。
    const MESSAGE_KIND_LABEL = {
      brief: '任务简报', followup: '追加消息', delivery_failed: '投递失败', report: '回报', progress: '进展',
    }
    const DELIVERY_LABEL = { pending: '待发', delivered: '已投递', failed: '投递失败' }
    const DELIVERY_TONE = { pending: 'warn', delivered: 'good', failed: 'bad' }
    const TONE_COLOR = {
      good: 'var(--dsw-alias-color-success, #2e7d32)',
      bad: 'var(--dsw-alias-color-danger, #c62828)',
      warn: 'var(--dsw-alias-color-warning, #b26a00)',
      info: 'var(--dsw-alias-color-info, #1565c0)',
      muted: 'var(--dsw-alias-color-text-tertiary, #777)',
    }
    // 面板对外只用显示名：重名才附短 id 后缀（与工具层同口径，取 t-xxx 后 4 位）。
    const shortId = id => String(id || '').replace(/^t-/, '').slice(0, 4)
    const displayNameOf = (task, all) => {
      const title = String((task && task.title) || '').trim()
      if (title === '') return task && task.id ? `任务 ${task.id}` : '任务'
      const duplicate = all.some(other => other !== task && other.id !== task.id
        && String((other && other.title) || '').trim() === title)
      return duplicate ? `${title}（${shortId(task.id)}）` : title
    }

    const readSnapshot = async signal => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'snapshot' }),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error((body && body.error) || 'bad-response')
      return body
    }

    // 固定入口：由插件创建/打开唯一主会话，创建后直接跳过去。
    const openMainSession = async () => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'open-main' }),
      })
      const body = await response.json()
      if (body && body.ok === true && typeof body.sessionId === 'string') return body
      throw new Error((body && body.error) || '打开主会话失败')
    }

    // 面板动作统一失败格式是 { ok:false, code, error }；code 稳定可编程，error 是给人看的中文。
    // Error 上同时挂 code/status，runPanel 才能把错误码显示在面板里。
    const actionFailure = (body, status) => {
      const failure = new Error((body && body.error) || `HTTP ${status}`)
      if (body && typeof body.code === 'string' && body.code !== '') failure.code = body.code
      failure.status = status
      return failure
    }

    // 每次 message 点击生成一个请求 id：host-route 按 (taskId, clientRequestId) 去重，
    // 网络重发/重复点击不会把同一条消息投递两次。
    const newRequestId = () => {
      const source = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
      if (source && typeof source.randomUUID === 'function') return source.randomUUID()
      return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    // 面板动作：detail/artifacts 只读，stop/retry/message 是写动作。
    const readDetail = async taskId => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'detail', taskId }),
      })
      const body = await response.json()
      if (body && body.ok === true) return body
      throw actionFailure(body, response.status)
    }

    // 产物库：一次取最多 200 条，前端按项目/日期分组；预览端点只读文件前 64 KiB。
    const readArtifacts = async (limit = 200, signal) => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'artifacts', limit }),
        signal,
      })
      const body = await response.json()
      if (body && body.ok === true) return body
      throw actionFailure(body, response.status)
    }

    const readPreview = async (taskId, path) => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'preview', taskId, path }),
      })
      const body = await response.json()
      if (body && body.ok === true) return body
      throw actionFailure(body, response.status)
    }

    const panelAction = async (endpoint, taskId, extra = {}) => {
      const payload = { endpoint, taskId, ...extra }
      if (endpoint === 'message' && (typeof payload.clientRequestId !== 'string' || payload.clientRequestId === '')) {
        payload.clientRequestId = newRequestId()
      }
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json()
      if (body && body.ok === true) return body
      throw actionFailure(body, response.status)
    }

    // 面板按钮和侧栏启动器共用同一条 open-main；并发点击合并成一次（平台侧创建没有互斥）。
    let openMainInFlight = null
    const openMainOnce = () => {
      if (openMainInFlight !== null) return openMainInFlight
      const run = openMainSession()
      openMainInFlight = run
      const clear = () => { if (openMainInFlight === run) openMainInFlight = null }
      run.then(clear, clear)
      return run
    }

    const timeLabel = ms => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-'
      const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    const shortPath = value => {
      const text = typeof value === 'string' ? value : ''
      return text.length > 60 ? `${text.slice(0, 59)}…` : text
    }

    const styles = {
      button: {
        border: '1px solid var(--dsw-alias-color-border, #d0d0d0)',
        background: 'transparent', color: 'inherit', borderRadius: 6,
        padding: '2px 8px', cursor: 'pointer', fontSize: 12,
      },
      panel: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, height: '100%', overflow: 'auto' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600, marginRight: 'auto' },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        border: '1px solid var(--dsw-alias-color-border, #e0e0e0)', borderRadius: 8,
      },
      dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      taskTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      meta: { fontSize: 12, opacity: 0.7, flex: '0 0 auto' },
      notice: { padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-color-warning-bg, #fff4e5)', fontSize: 12 },
      error: { padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-color-danger-bg, #fdecea)', fontSize: 12 },
      detail: {
        border: '1px solid var(--dsw-alias-color-border, #d0d0d0)', borderRadius: 8,
        padding: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12,
        background: 'var(--dsw-alias-color-bg-secondary, #fafafa)',
      },
      detailLine: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      // 详情四区块：brief / 消息 / 依赖 / 产物。
      section: {
        display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-color-border, #e0e0e0)',
      },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: 6 },
      sectionTitle: { fontSize: 12, fontWeight: 600 },
      empty: { fontSize: 12, opacity: 0.6 },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      messageRow: { display: 'flex', flexDirection: 'column', gap: 2 },
      messageText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 2 },
      badge: {
        display: 'inline-flex', alignItems: 'center', fontSize: 11, lineHeight: '16px',
        padding: '0 6px', borderRadius: 8, border: '1px solid currentColor',
      },
      depLine: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      // 产物库：分组标题 / 行内预览。
      group: {
        display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-color-border, #e0e0e0)',
      },
      preview: {
        flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 4,
        borderTop: '1px dashed var(--dsw-alias-color-border, #d0d0d0)', paddingTop: 6, marginTop: 2,
      },
      pre: {
        margin: 0, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        fontSize: 11, lineHeight: 1.5, padding: 6, borderRadius: 6,
        background: 'var(--dsw-alias-color-bg-tertiary, #f2f2f2)',
      },
    }

    const HeaderButton = ({ openPanel }) => h('button', {
      type: 'button', title: '任务面板', onClick: openPanel, style: styles.button,
    }, '\u2630 任务')

    // 侧栏「插件」下方的入口图标（面板行渲染的是这个组件）。
    const LauncherIcon = () => h('span', { 'aria-hidden': true, style: { fontSize: 16, lineHeight: 1 } }, '\u25C8')

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
      return h('div', { style: styles.panel },
        h('div', { style: styles.meta }, '正在打开主会话…'),
        error === null ? null : h('div', { style: styles.error }, error),
        error === null ? null : h('button', { type: 'button', style: styles.button, onClick: run }, '重试'),
      )
    }

    const TasksPanel = ({ openSession }) => {
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
      const [detail, setDetail] = React.useState(null)
      const [detailError, setDetailError] = React.useState(null)
      const [artifactData, setArtifactData] = React.useState(null)
      const [artifactError, setArtifactError] = React.useState(null)
      const [artifactLoading, setArtifactLoading] = React.useState(false)
      const [artifactGroup, setArtifactGroup] = React.useState('project')
      const [preview, setPreview] = React.useState(null)
      const [copyNotice, setCopyNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      // 同一 (动作, 任务) 只允许一个请求在途：双击不会发两条 stop/retry/message。
      const inFlight = React.useRef(new Set())

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

      const matchFilter = task => filter === 'all' ? true
        : filter === 'active' ? (task.status === 'waiting_dep' || task.status === 'pending' || task.status === 'running')
          : filter === 'waiting' ? (task.status === 'waiting_user' || task.status === 'waiting_auth')
            : filter === 'done' ? task.status === 'done'
              : filter === 'failed' ? task.status === 'failed'
                : filter === 'closed' ? (task.status === 'cancelled' || task.status === 'orphaned')
                  : filter === 'artifacts' ? (Array.isArray(task.artifacts) && task.artifacts.length > 0)
                    : true

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

      const openDetail = async id => {
        setDetailError(null)
        setCopyNotice(null)
        try {
          setDetail(await readDetail(id))
        } catch (failure) {
          setDetailError(`详情加载失败：${String((failure && failure.message) || failure)}`)
        }
      }

      const closeDetail = () => {
        setDetail(null)
        setCopyNotice(null)
      }

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

      const runPanel = async (endpoint, id, extra = {}) => {
        const key = `${endpoint}:${id}`
        if (inFlight.current.has(key)) return
        inFlight.current.add(key)
        setBusy(key)
        setActionError(null)
        setActionNotice(null)
        try {
          const result = await panelAction(endpoint, id, extra)
          // 幂等命中：stop 已结束 / retry 已有活跃重派 / message 重复投递，都按提示处理而不是报错。
          if (result && result.already === true) {
            if (endpoint === 'message') setActionNotice('这条消息已发送过，未重复投递')
            else if (endpoint === 'retry') {
              setActionNotice(`已有活跃重派任务（${STATUS_LABEL[result.status] || result.status || '处理中'}），未重复创建`)
            } else {
              setActionNotice(`任务已是该状态（${STATUS_LABEL[result.status] || result.status || '已结束'}），无需重复停止`)
            }
          }
          await load(undefined)
          if (filter === 'artifacts') await loadArtifacts(undefined)
          if (detail && detail.task && detail.task.id === id) await openDetail(id)
        } catch (failure) {
          const code = failure && typeof failure.code === 'string' && failure.code !== '' ? `（${failure.code}）` : ''
          setActionError(`${endpoint} 失败${code}：${String((failure && failure.message) || failure)}`)
        } finally {
          inFlight.current.delete(key)
          setBusy(null)
        }
      }

      const sendMessage = id => {
        const text = typeof window.prompt === 'function' ? window.prompt('追加一条消息给子会话：') : ''
        if (typeof text === 'string' && text.trim() !== '') void runPanel('message', id, { message: text.trim() })
      }

      const mainSession = (snapshot && snapshot.mainSession) || { id: null, live: false }
      const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : []
      const visible = tasks.filter(matchFilter)
      const mainState = mainSession.id === null ? '主会话未创建' : mainSession.live ? '主会话在线' : '主会话已失效'
      const inboxCount = Number(snapshot && snapshot.inboxCount) || 0
      const textOf = value => typeof value === 'string' ? value.trim() : ''
      const listOf = value => (Array.isArray(value) ? value.map(item => textOf(item)).filter(Boolean) : [])
      const detailSection = (title, hint, body) => h('div', { style: styles.section },
        h('div', { style: styles.sectionHead },
          h('span', { style: styles.sectionTitle }, title),
          hint ? h('span', { style: styles.meta }, hint) : null,
        ),
        body,
      )
      // 依赖行：上游（前置）与下游（依赖本任务）共用；missing 表示前置任务已不在台账里。
      const depRow = row => h('div', { key: `${row.status}:${row.id}`, style: styles.depLine },
        h('span', { style: Object.assign({}, styles.dot, { background: TONE_COLOR[STATUS_TONE[row.status]] || TONE_COLOR.muted }) }),
        h('span', { title: row.error || row.id }, row.title),
        h('span', { style: styles.meta }, STATUS_LABEL[row.status] || row.status || '未知'),
        row.error ? h('span', { style: styles.meta, title: row.error }, '（有错误）') : null,
      )
      const detailBlock = detail === null ? null : (() => {
        const task = detail.task || {}
        // 1) brief：结构化 brief 原样渲染成文字，不再只显示 task.goal。
        const brief = task.brief !== null && typeof task.brief === 'object' && !Array.isArray(task.brief) ? task.brief : {}
        const briefGoal = textOf(brief.goal) || textOf(task.goal)
        const acceptance = listOf(brief.acceptance)
        const constraints = listOf(brief.constraints)
        const refs = listOf(brief.refs)
        const verbatim = textOf(brief.user_verbatim)
        const briefEmpty = briefGoal === '' && acceptance.length === 0 && constraints.length === 0
          && refs.length === 0 && verbatim === ''
        const briefBody = briefEmpty
          ? h('div', { style: styles.empty }, '这条任务没有 brief 信息。')
          : h('div', { style: styles.detailLine }, [
            briefGoal !== '' ? `目标：${briefGoal}` : '',
            acceptance.length > 0 ? `验收标准：\n${acceptance.map(item => `- ${item}`).join('\n')}` : '',
            constraints.length > 0 ? `约束：\n${constraints.map(item => `- ${item}`).join('\n')}` : '',
            refs.length > 0 ? `背景资料：\n${refs.map(item => `- ${item}`).join('\n')}` : '',
            verbatim !== '' ? `用户原话：\n${verbatim.split(/\r?\n/).map(line => `> ${line}`).join('\n')}` : '',
          ].filter(Boolean).join('\n\n'))

        // 2) 消息：最近 20 条；followup 带投递状态（待发/已投递/投递失败）。
        const messages = Array.isArray(detail.messages) ? detail.messages : []
        const shownMessages = messages.slice(-20)
        const messageBody = messages.length === 0
          ? h('div', { style: styles.empty }, '还没有消息。')
          : h('div', { style: styles.list },
            shownMessages.map((row, index) => h('div', { key: row.seq === undefined ? index : row.seq, style: styles.messageRow },
              h('div', { style: styles.bar },
                h('span', { style: Object.assign({}, styles.badge, { color: TONE_COLOR.muted }) }, MESSAGE_KIND_LABEL[row.kind] || row.kind),
                row.delivery
                  ? h('span', {
                    style: Object.assign({}, styles.badge, { color: TONE_COLOR[DELIVERY_TONE[row.delivery]] || TONE_COLOR.muted }),
                    title: `投递状态：${DELIVERY_LABEL[row.delivery] || row.delivery}`,
                  }, DELIVERY_LABEL[row.delivery] || row.delivery)
                  : null,
                h('span', { style: styles.meta }, timeLabel(row.at)),
              ),
              h('div', { style: styles.messageText }, row.text),
            )),
            messages.length > shownMessages.length
              ? h('div', { style: styles.empty }, `仅显示最近 ${shownMessages.length} 条（共 ${messages.length} 条）。`)
              : null,
          )

        // 3) 依赖：上游前置 + 下游依赖本任务，各自带状态和错误提示。
        const dependencies = Array.isArray(detail.dependencies) ? detail.dependencies : []
        const dependents = Array.isArray(detail.dependents) ? detail.dependents : []
        const depBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: styles.meta }, '上游（前置任务）'),
          dependencies.length === 0
            ? h('div', { style: styles.empty }, '没有前置任务。')
            : h('div', { style: styles.list }, dependencies.map(depRow)),
          h('div', { style: styles.meta }, '下游（依赖本任务）'),
          dependents.length === 0
            ? h('div', { style: styles.empty }, '没有下游任务。')
            : h('div', { style: styles.list }, dependents.map(depRow)),
        )

        // 4) 产物：路径/标签/存在性，路径可一键复制（浏览器不允许静默打开本地文件）。
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
        const artifactBody = artifacts.length === 0
          ? h('div', { style: styles.empty }, '还没有产物。')
          : h('div', { style: styles.list },
            artifacts.map((item, index) => h('div', { key: `${item.path}:${index}`, style: styles.depLine },
              h('span', { style: Object.assign({}, styles.dot, { background: item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good }) }),
              h('span', { style: { overflowWrap: 'anywhere', flex: 1 }, title: item.path }, item.path),
              item.label ? h('span', { style: styles.meta }, item.label) : null,
              item.exists === false ? h('span', { style: styles.meta }, '（未找到）') : null,
              h('button', { type: 'button', style: styles.button, onClick: () => void copyPath(item.path) }, '复制路径'),
            )),
          )

        return h('div', { style: styles.detail },
          h('div', { style: styles.bar },
            h('span', { style: styles.title }, task.title || task.id || '任务'),
            h('span', { style: styles.meta }, STATUS_LABEL[task.status] || task.status),
            task.readOnly === true ? h('span', { style: styles.meta }, '只读') : null,
            h('button', { type: 'button', style: styles.button, onClick: closeDetail }, '关闭'),
          ),
          h('div', { style: styles.meta },
            [
              task.group ? `组 ${task.group}` : '',
              task.priority ? `P${task.priority}` : '',
              task.targetDir ? shortPath(task.targetDir) : '',
              task.readOnly ? '只读' : '',
            ].filter(Boolean).join('｜') || '无额外属性'),
          task.question ? h('div', { style: styles.notice }, `需要你：${task.question}${Array.isArray(task.options) && task.options.length ? `（${task.options.join(' / ')}）` : ''}`) : null,
          task.error ? h('div', { style: styles.error }, `错误：${task.error}`) : null,
          detailSection('Brief', acceptance.length > 0 ? `验收 ${acceptance.length} 条` : '', briefBody),
          detailSection('消息', messages.length > 0 ? `${messages.length} 条` : '', messageBody),
          detailSection('依赖', `上游 ${dependencies.length} · 下游 ${dependents.length}`, depBody),
          detailSection('产物', artifacts.length > 0 ? `${artifacts.length} 个` : '', artifactBody),
          h('div', { style: styles.bar },
            task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'orphaned'
              ? h('button', {
                type: 'button', style: styles.button,
                disabled: busy === `stop:${task.id}`,
                onClick: () => runPanel('stop', task.id),
              }, '停止')
              : null,
            task.status === 'failed' || task.status === 'orphaned'
              ? h('button', {
                type: 'button', style: styles.button,
                disabled: busy === `retry:${task.id}`,
                onClick: () => runPanel('retry', task.id),
              }, '重派')
              : null,
            task.target
              ? h('button', {
                type: 'button', style: styles.button,
                disabled: busy === `message:${task.id}`,
                onClick: () => sendMessage(task.id),
              }, '追加消息')
              : null,
            task.target
              ? h('button', {
                type: 'button', style: styles.button,
                onClick: () => open(task.target),
              }, '打开子会话')
              : null,
          ),
        )
      })()
      const detailErrorBlock = detailError === null ? null : h('div', { style: styles.error }, detailError)
      const artifactItems = Array.isArray(artifactData && artifactData.items) ? artifactData.items : []
      const artifactDate = at => {
        if (typeof at !== 'number' || !Number.isFinite(at)) return '日期未知'
        const date = new Date(at)
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      }
      const artifactProject = item => {
        if (typeof item.project === 'string' && item.project !== '') return item.project
        const dir = textOf(item.targetDir)
        if (dir === '') return '未关联项目'
        return dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || dir
      }
      const artifactGroups = mode => {
        const groups = new Map()
        for (const item of artifactItems) {
          if (item === null || typeof item !== 'object' || typeof item.path !== 'string') continue
          const key = mode === 'date' ? artifactDate(item.at) : artifactProject(item)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(item)
        }
        const rows = [...groups.entries()]
        rows.sort((left, right) => mode === 'date'
          ? right[0].localeCompare(left[0])
          : left[0].localeCompare(right[0], 'zh-CN'))
        for (const [, list] of rows) {
          list.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || String(left.path).localeCompare(String(right.path)))
        }
        return rows
      }
      const previewBlock = () => {
        if (preview === null) return null
        if (preview.loading === true) return h('div', { style: styles.preview }, h('div', { style: styles.meta }, '加载预览…'))
        if (preview.error !== null) return h('div', { style: styles.preview }, h('div', { style: styles.error }, `预览失败：${preview.error}`))
        const data = preview.data || {}
        if (data.kind === 'text') {
          return h('div', { style: styles.preview },
            h('div', { style: styles.meta }, `${data.size ?? 0} 字节${data.truncated === true ? '（仅显示前 64 KiB）' : ''}`),
            h('pre', { style: styles.pre }, data.text === '' ? '（空文件）' : data.text),
          )
        }
        if (data.kind === 'directory') return h('div', { style: styles.preview }, h('div', { style: styles.notice }, '这是目录，不能预览内容；复制路径后在文件管理器打开。'))
        if (data.kind === 'binary') return h('div', { style: styles.preview }, h('div', { style: styles.notice }, '二进制文件，不能按文本预览；复制路径后在本地打开。'))
        return h('div', { style: styles.preview }, h('div', { style: styles.meta }, '没有可预览的内容。'))
      }
      const artifactRow = item => {
        const key = `${item.taskId}:${item.path}`
        const isPreview = preview !== null && preview.key === key
        return h('div', { key, style: Object.assign({}, styles.row, { flexWrap: 'wrap' }) },
          h('span', { style: Object.assign({}, styles.dot, { background: item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good }) }),
          h('span', { style: { overflowWrap: 'anywhere', flex: '1 1 260px', minWidth: 0 }, title: item.path }, item.path),
          item.label ? h('span', { style: styles.meta }, item.label) : null,
          item.exists === false ? h('span', { style: styles.meta }, '（未找到）') : null,
          h('span', { style: styles.meta }, `${item.title || item.taskId}${item.status ? ` · ${STATUS_LABEL[item.status] || item.status}` : ''}`),
          h('span', { style: styles.meta }, timeLabel(item.at)),
          h('button', {
            type: 'button', style: styles.button,
            disabled: item.exists === false,
            onClick: () => void togglePreview(item.taskId, item.path),
          }, isPreview ? '收起预览' : '预览'),
          h('button', { type: 'button', style: styles.button, onClick: () => void copyPath(item.path) }, '复制路径'),
          item.childSessionId
            ? h('button', { type: 'button', style: styles.button, onClick: () => open(item.childSessionId) }, '打开子会话')
            : null,
          h('button', { type: 'button', style: styles.button, onClick: () => void openDetail(item.taskId) }, '详情'),
          isPreview ? previewBlock() : null,
        )
      }
      const artifactView = artifactData === null
        ? h('div', { style: styles.meta }, artifactError !== null ? `产物加载失败：${artifactError}` : (artifactLoading ? '产物加载中…' : '还没有产物。'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: styles.bar },
            h('span', { style: styles.meta }, `共 ${artifactItems.length} 个产物${artifactError !== null ? '（刷新失败，显示上次结果）' : ''}`),
            h('button', {
              type: 'button', style: styles.button,
              disabled: artifactGroup === 'project',
              onClick: () => setArtifactGroup('project'),
            }, '按项目'),
            h('button', {
              type: 'button', style: styles.button,
              disabled: artifactGroup === 'date',
              onClick: () => setArtifactGroup('date'),
            }, '按日期'),
          ),
          artifactError !== null ? h('div', { style: styles.error }, `产物加载失败：${artifactError}`) : null,
          artifactItems.length === 0
            ? h('div', { style: styles.empty }, '还没有产物。任务 done 时会自动收集改动文件；也可以显式传 task_report.artifacts。')
            : artifactGroups(artifactGroup).map(([name, rows]) => h('section', { key: `${artifactGroup}:${name}`, style: styles.group },
              h('div', { style: styles.bar },
                h('span', { style: styles.sectionTitle }, name),
                h('span', { style: styles.meta }, `${rows.length} 个`),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, rows.map(artifactRow)),
            )),
        )

      return h('div', { style: styles.panel },
        h('div', { style: styles.bar },
          h('span', { style: styles.title }, inboxCount > 0 ? `任务 · 待你决定 ${inboxCount}` : '任务'),
          h('span', { style: styles.meta }, mainState),
          h('select', {
            value: filter, onChange: event => setFilter(event.target.value),
            style: Object.assign({}, styles.button, { padding: '2px 4px' }),
          }, FILTERS.map(([value, label]) => h('option', { key: value, value }, label))),
          h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'),
          h('button', { type: 'button', style: styles.button, onClick: handleOpenMain, disabled: openingMain }, openingMain ? '打开中…' : '打开主会话'),
        ),
        snapshotError !== null ? h('div', { style: styles.error }, `台账暂不可用：${snapshotError}`) : null,
        actionError !== null ? h('div', { style: styles.error }, actionError) : null,
        actionNotice !== null ? h('div', { style: styles.notice }, actionNotice) : null,
        copyNotice !== null ? h('div', { style: styles.notice }, copyNotice) : null,
        detailErrorBlock,
        detailBlock,
        inboxCount > 0
          ? h('div', { style: styles.notice }, `有 ${inboxCount} 个任务等你决定，切到「待你决定」查看。`)
          : null,
        openedMain
          ? h('div', { style: styles.notice }, '主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」。')
          : null,
        snapshot !== null && mainSession.id === null
          ? h('div', { style: styles.notice }, '尚未打开主会话：点右上角「打开主会话」，在指挥舱里创建。')
          : null,
        filter === 'artifacts'
          ? artifactView
          : visible.length === 0
          ? (snapshot === null
            ? (snapshotError === null ? h('div', { style: styles.meta }, '加载中…') : null)
            : h('div', { style: styles.meta }, tasks.length === 0 ? '还没有任务。' : '没有匹配的任务。'))
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            visible.map(task => {
              const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
              const isExpanded = expanded.includes(task.id)
              const displayName = displayNameOf(task, tasks)
              return h('li', { key: task.id, style: { listStyle: 'none' } },
                h('div', { style: styles.row },
                  h('span', { style: Object.assign({}, styles.dot, { background: TONE_COLOR[task.tone] || TONE_COLOR.muted }) }),
                  h('span', { style: styles.taskTitle, title: displayName }, displayName),
                  task.targetDir !== null && task.targetDir !== undefined
                    ? h('span', { style: styles.meta, title: task.targetDir }, shortPath(task.targetDir))
                    : null,
                  task.groupId ? h('span', { style: styles.meta, title: '分组' }, `组 ${task.groupId}`) : null,
                  task.dependsOn && task.dependsOn.length > 0
                    ? h('span', { style: styles.meta, title: task.dependsOn.join('、') }, `依赖 ${task.dependsOn.length}`)
                    : null,
                  task.queued ? h('span', { style: styles.meta }, '排队中') : null,
                  task.stale ? h('span', { style: styles.meta }, '⚠') : null,
                  h('span', { style: styles.meta }, STATUS_LABEL[task.status] || task.status),
                  task.readOnly === true ? h('span', { style: styles.meta, title: '只读任务：写文件/写 shell 会被沙箱拒绝' }, '只读') : null,
                  h('span', { style: styles.meta }, timeLabel(task.lastEventAt)),
                  artifacts.length > 0
                    ? h('button', { type: 'button', style: styles.button, onClick: () => toggleArtifacts(task.id) }, `产物 ${artifacts.length}`)
                    : null,
                  h('button', { type: 'button', style: styles.button, onClick: () => openDetail(task.id) }, '详情'),
                  task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'orphaned'
                    ? h('button', {
                      type: 'button', style: styles.button,
                      disabled: busy === `stop:${task.id}`,
                      onClick: () => runPanel('stop', task.id),
                    }, '停止')
                    : null,
                  task.status === 'failed' || task.status === 'orphaned'
                    ? h('button', {
                      type: 'button', style: styles.button,
                      disabled: busy === `retry:${task.id}`,
                      onClick: () => runPanel('retry', task.id),
                    }, '重派')
                    : null,
                  task.childSessionId
                    ? h('button', {
                      type: 'button', style: styles.button,
                      disabled: busy === `message:${task.id}`,
                      onClick: () => sendMessage(task.id),
                    }, '追加')
                    : null,
                  h('button', {
                    type: 'button', style: styles.button,
                    disabled: task.childSessionId === null || task.childSessionId === undefined,
                    onClick: () => open(task.childSessionId),
                  }, '打开子会话'),
                ),
                isExpanded && artifacts.length > 0
                  ? h('div', { style: Object.assign({}, styles.meta, { padding: '4px 8px' }) },
                    artifacts.map((item, index) => h('div', { key: index, title: item.path },
                      `${item.exists === false ? '⚠ ' : '• '}${item.path}${item.label ? ` — ${item.label}` : ''}${item.exists === false ? '（未找到）' : ''}`)))
                  : null,
                task.question
                  ? h('div', { style: Object.assign({}, styles.notice, { marginTop: 4 }) },
                    `需要你：${task.question}${Array.isArray(task.options) && task.options.length > 0 ? `（${task.options.join(' / ')}）` : ''}`)
                  : null,
              )
            }),
          ),
      )
    }

    function apply(ctx) {
      // 侧栏底部不再注册入口（用户要求删掉）；任务面板从会话头按钮进入。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) }),
      }, TasksPanel))

      // 侧栏「插件」下方（plugins order 0 / schedules order 10）的启动器入口；main 面板与条目同 id。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: LAUNCHER_ID,
        inject: () => ({
          openMain: openMainOnce,
          openSession: id => ctx.uiWorkspace.openSession(id),
          clearPanel: () => ctx.layout.selectPanel(null),
        }),
      }, LauncherPanel))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: LAUNCHER_ID, order: 5, label: () => '主会话',
      }, LauncherIcon))

      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
        name: 'conversation.header.leading',
        inject: () => ({ openPanel: () => ctx.layout.selectPanel(PANEL_ID) }),
      }, HeaderButton))
    }

    return { inject, apply }
  },
})
