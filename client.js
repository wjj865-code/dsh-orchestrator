// dsh-orchestrator 客户端薄插件（经典脚本，模块加载器用 <script> 加载，顶层不能有 import/export）。
// 槽位：sidebar.panellist 入口、main 任务面板、conversation.header.leading 会话头按钮。
window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const inject = ['slots', 'layout', 'uiWorkspace']
    const PANEL_ID = 'orchestrator'
    const ROUTE = 'api/orchestrator'
    const POLL_MS = 5000
    const POLL_BACKOFF_MS = 30000
    const FILTERS = [
      ['all', '全部'], ['active', '进行中'], ['waiting', '等待'],
      ['done', '已完成'], ['failed', '失败'], ['closed', '已取消/丢失'],
    ]

    const STATUS_LABEL = {
      pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
      done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
    }
    const TONE_COLOR = {
      good: 'var(--dsw-alias-color-success, #2e7d32)',
      bad: 'var(--dsw-alias-color-danger, #c62828)',
      warn: 'var(--dsw-alias-color-warning, #b26a00)',
      info: 'var(--dsw-alias-color-info, #1565c0)',
      muted: 'var(--dsw-alias-color-text-tertiary, #777)',
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

    const timeLabel = ms => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-'
      const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
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
    }

    const TaskIcon = () => h('span', { 'aria-hidden': true, style: { fontSize: 14 } }, '\u2630')

    const HeaderButton = ({ openPanel }) => h('button', {
      type: 'button', title: '任务面板', onClick: openPanel, style: styles.button,
    }, '\u2630 任务')

    const TasksPanel = ({ openSession }) => {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [filter, setFilter] = React.useState('all')

      const load = React.useCallback(async (signal) => {
        try {
          const next = await readSnapshot(signal)
          setSnapshot(next)
          setError(null)
          return true
        } catch (failure) {
          if (signal === undefined || !signal.aborted) setError(String((failure && failure.message) || failure))
          return false
        }
      }, [])

      React.useEffect(() => {
        const controller = new AbortController()
        let stopped = false
        let timer
        // 正常 5s 轮询；连续失败退避到 30s，成功一次就恢复。
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
        setRefreshing(false)
      }

      const matchFilter = task => filter === 'all' ? true
        : filter === 'active' ? (task.status === 'pending' || task.status === 'running')
          : filter === 'waiting' ? (task.status === 'waiting_user' || task.status === 'waiting_auth')
            : filter === 'done' ? task.status === 'done'
              : filter === 'failed' ? task.status === 'failed'
                : filter === 'closed' ? (task.status === 'cancelled' || task.status === 'orphaned')
                  : true

      const open = id => {
        if (typeof id !== 'string' || id === '') return
        try { openSession(id) } catch (failure) { setError(String((failure && failure.message) || failure)) }
      }

      const coordinator = (snapshot && snapshot.coordinator) || { id: null, live: false }
      const tasks = Array.isArray(snapshot && snapshot.tasks) ? snapshot.tasks : []
      const visible = tasks.filter(matchFilter)

      return h('div', { style: styles.panel },
        h('div', { style: styles.bar },
          h('span', { style: styles.title }, '任务'),
          h('span', { style: styles.meta }, coordinator.id === null ? '未绑定协调者' : coordinator.live ? '协调者在线' : '协调者未加载'),
          h('select', {
            value: filter, onChange: event => setFilter(event.target.value),
            style: Object.assign({}, styles.button, { padding: '2px 4px' }),
          }, FILTERS.map(([value, label]) => h('option', { key: value, value }, label))),
          h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: refreshing }, refreshing ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button', style: styles.button,
            disabled: coordinator.id === null,
            onClick: () => open(coordinator.id),
          }, '打开协调者会话'),
        ),
        error !== null ? h('div', { style: styles.error }, `台账暂不可用：${error}`) : null,
        snapshot !== null && coordinator.id === null
          ? h('div', { style: styles.notice }, '尚未绑定协调者：先从任意会话派一个任务，会自动绑定。')
          : null,
        visible.length === 0
          ? h('div', { style: styles.meta }, snapshot === null ? '加载中…' : tasks.length === 0 ? '还没有任务。' : '没有匹配的任务。')
          : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            visible.map(task => h('li', { key: task.id, style: styles.row },
              h('span', { style: Object.assign({}, styles.dot, { background: TONE_COLOR[task.tone] || TONE_COLOR.muted }) }),
              h('span', { style: styles.taskTitle, title: task.title }, task.title),
              task.queued ? h('span', { style: styles.meta }, '排队中') : null,
              task.stale ? h('span', { style: styles.meta }, '⚠') : null,
              h('span', { style: styles.meta }, STATUS_LABEL[task.status] || task.status),
              h('span', { style: styles.meta }, timeLabel(task.lastEventAt)),
              h('button', {
                type: 'button', style: styles.button,
                disabled: task.childSessionId === null || task.childSessionId === undefined,
                onClick: () => open(task.childSessionId),
              }, '打开子会话'),
            )),
          ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => '任务',
      }, TaskIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) }),
      }, TasksPanel))

      ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
        name: 'conversation.header.leading',
        inject: () => ({ openPanel: () => ctx.layout.selectPanel(PANEL_ID) }),
      }, HeaderButton))
    }

    return { inject, apply }
  },
})
