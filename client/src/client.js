/**
 * 客户端工厂（P7 / T7.2）：把常量 / 样式 / 纯逻辑 / API / 视图装配成平台认识的 { inject, apply }。
 *
 * React 只能从 factory 的 req 参数拿（源码不许 import react，否则平台与产物各一份 React，
 * hooks 全废）；参数名故意用 req 而不是 require，绕开 rollup/esbuild 的 commonjs 启发式。
 * apply(ctx) 负责：注入样式 → 起任务入口闸门 → 注册 main 面板 / 启动器 / 侧栏入口 / 会话头按钮。
 */
import {
  PANEL_ID, LAUNCHER_ID, ROUTE, TONE_COLOR, CHIP_ID,
  FILTERS, METRICS, POLL_MS, POLL_BACKOFF_MS,
  STATUS_LABEL, STATUS_TONE, MESSAGE_KIND_LABEL, DELIVERY_LABEL, DELIVERY_TONE,
  GOAL_PHASE_LABEL, GOAL_ACTIVATION_LABEL, PLAN_STATE_LABEL,
  WORKTREE_STATE_LABEL, WORKTREE_SOURCE_LABEL,
} from './constants.js'
import {
  countTasks, matchesFilter, matchesQuery, groupArtifacts, artifactDate, artifactProject,
  displayNameOf, textOf, listOf, timeLabel, shortPath, fileAddressOf, fileAddressProblem,
  createFocusRequest, selectTaskChips, chipStateOf, chipViewOf, chipTooltipOf, chipVisibleTitle,
  isLatestTurn,
} from './logic.js'
import {
  readSnapshot, readArtifacts, readDetail, readPreview, panelAction, openMainOnce,
} from './api.js'
import { createTaskFeed } from './feed.js'
import { createMainViewGate } from './gate.js'
import { ensureStyles, STYLE_TEXT } from './styles.js'
import { createUi } from './ui.js'
import { createViews } from './views.js'

export const createClient = (req) => {
  const React = req('react')
  // 经典运行时的工厂别名：用解构而不是 `React.createElement`，产物里就不会出现那个字面量
  // （test/client.test.js 的 JSX 守卫把它当「有人退回手写 createElement」的红线）。
  const { createElement: h } = React
  // sidebarRight 不进 inject：它是可选能力，缺了也要能加载面板（预览回退行内）。
  // 与 uiSession / sessions 同一口径——用 serviceOf 现取，服务晚就绪也能拿到。
  const inject = ['slots', 'layout', 'uiWorkspace']

  const { Icon, Badge, Chip, EmptyState, Banner, SkeletonList } = createUi(h)
  // chip 的「打开并定位」请求：chip 只记任务 id，真正开抽屉的是面板自己（面板挂载时 take 一次）。
  const focusRequest = createFocusRequest()
  const {
    HeaderButton, LauncherIcon, LauncherPanel, TasksPanel, TaskChipRow,
  } = createViews({
    React,
    h,
    Icon,
    Badge,
    Chip,
    EmptyState,
    Banner,
    SkeletonList,
    FILTERS,
    METRICS,
    POLL_MS,
    POLL_BACKOFF_MS,
    STATUS_LABEL,
    STATUS_TONE,
    MESSAGE_KIND_LABEL,
    DELIVERY_LABEL,
    DELIVERY_TONE,
    GOAL_PHASE_LABEL,
    GOAL_ACTIVATION_LABEL,
    PLAN_STATE_LABEL,
    WORKTREE_STATE_LABEL,
    WORKTREE_SOURCE_LABEL,
    TONE_COLOR,
    displayNameOf,
    textOf,
    listOf,
    timeLabel,
    shortPath,
    countTasks,
    matchesFilter,
    matchesQuery,
    groupArtifacts,
    readSnapshot,
    readArtifacts,
    readDetail,
    readPreview,
    panelAction,
    openMainOnce,
    selectTaskChips,
    chipViewOf,
    chipTooltipOf,
    chipVisibleTitle,
    isLatestTurn,
  })

  function apply(ctx) {
    // 样式表先注入：面板/抽屉/启动器都靠这套 class。
    ensureStyles()
    // 任务入口闸门：当前会话 id 取 UI 的「主视图会话」，是不是主会话由宿主按台账回答。
    // 服务可能比插件晚就绪，所以每次判定都现取，不缓存服务对象。
    const serviceOf = name => {
      try { return ctx.get?.(name) } catch { return undefined }
    }
    const readSessionId = () => {
      try {
        const current = serviceOf('uiSession')?.adapter?.current?.getSnapshot?.()
        if (current && typeof current.key === 'string' && current.key !== '') return current.key
      } catch { /* 服务形状变化按信号不可用降级 */ }
      try {
        const list = serviceOf('sessions')?.list?.getSnapshot?.()
        const rows = list && list.byId ? Object.values(list.byId) : []
        const found = rows.find(row => row && (row.retainedBy?.mainView ?? 0) > 0)
        if (found && typeof found.id === 'string' && found.id !== '') return found.id
      } catch { /* 同上 */ }
      return undefined
    }
    const subscribeSession = listener => {
      const disposers = []
      try {
        const off = serviceOf('uiSession')?.adapter?.current?.subscribe?.(listener)
        if (typeof off === 'function') disposers.push(off)
      } catch { /* 订阅不可用时靠兜底轮询 */ }
      try {
        const off = serviceOf('sessions')?.list?.subscribe?.(listener)
        if (typeof off === 'function') disposers.push(off)
      } catch { /* 同上 */ }
      // 两个来源都还没就绪时返回 undefined，让闸门在兜底轮询里继续补订。
      if (disposers.length === 0) return undefined
      return () => {
        for (const off of disposers) {
          try { off() } catch { /* 卸载期清理失败不阻断 */ }
        }
      }
    }
    const fetchRole = async sessionId => {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'session-role', sessionId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error('bad-response')
      return body.isMain === true
    }
    const mainView = createMainViewGate({
      readSessionId,
      subscribeSession,
      fetchRole,
      timer: typeof setTimeout === 'function'
        ? (run, ms) => {
          // 自排程 setTimeout（仓库口径：不用 setInterval，便于卸载时立刻停）。
          let cancelled = false
          let handle
          const tick = () => {
            if (cancelled) return
            run()
            if (!cancelled) handle = setTimeout(tick, ms)
          }
          handle = setTimeout(tick, ms)
          return () => {
            cancelled = true
            try { clearTimeout(handle) } catch { /* 卸载期清理失败不阻断 */ }
          }
        }
        : undefined,
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const stop = mainView.start()
        return () => { stop() }
      }, 'dsh-orchestrator: main-view gate')
    } else {
      void mainView.refresh()
    }

    // 关联任务 chip 的共享数据源：只在 chip 行订阅时轮询（见 feed.js）。
    // 卸载时停表，避免插件热替换后还留着一个自排程定时器。
    const chipFeed = createTaskFeed({ readSnapshot: () => readSnapshot() })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => chipFeed.stop(), 'dsh-orchestrator: task chip feed')
    }

    // 产物预览：复用宿主的会话右侧栏（ui-sidebar-right 的 file Tab，Markdown/代码/图片/PDF/Office 都有渲染器）。
    // 两个硬约束：
    // 1) 侧栏只在会话视图里挂载 —— 面板占主栏时 ctx.sidebarRight.mounted 是 undefined，openResource 会抛；
    //    所以要先 selectPanel(null) 切回会话。
    // 2) 侧栏 Tab 只认领 `dsh-resource://file/session/<id>/<path>` 作用域（absolute 不被文件预览类型认领），
    //    所以地址必须带会话 id，由 fileAddressOf 拼。
    //
    // 返回 { ok, reason, message }，不只给 false：四条失败路径（未装插件 / 没会话 id / 路径非法 /
    // 宿主拒绝）要能分辨，否则真机排查只能看到同一句提示。
    //
    // 失败收场不依赖面板存活：切过面板就一定切回 PANEL_ID，让提示落在用户看得见的地方。
    // 时序不靠猜（不轮询 mounted 的宏任务轮数）：宿主侧栏座位没就绪就让 openResource 抛，
    // 抛了就把面板切回来如实报「尚未就绪」，而不是静默吞掉。
    //
    // 无条件切面板：这个函数只由面板内的按钮调用，此刻主栏一定就是 PANEL_ID，
    // 不必再去问 layout.panelInfo（少一条可选链，也少一条「探测不到就不切」的分支）。
    const openArtifactPreview = path => {
      const sidebar = serviceOf('sidebarRight')
      // 可用性探测全部前置：任何一条不满足都在切换面板之前返回，面板与提示都还在原位。
      if (typeof sidebar?.openResource !== 'function') return { ok: false, reason: 'sidebar-missing' }
      // 成因分开报：路径为空不是「拿不到会话」，混成一句会把排查引到错的地方。
      // 会话 id 只取一次，探测与拼地址用同一个值（避免两次读取之间切了会话）。
      const sessionId = readSessionId()
      const problem = fileAddressProblem(sessionId, path)
      if (problem !== null) return { ok: false, reason: problem }
      const address = fileAddressOf(sessionId, path)
      if (address === '') return { ok: false, reason: 'bad-path' }
      ctx.layout.selectPanel(null)
      try {
        sidebar.openResource(address)
        return { ok: true }
      } catch (error) {
        ctx.layout.selectPanel(PANEL_ID)
        return { ok: false, reason: 'host-refused', message: String(error?.message ?? error) }
      }
    }

    // 侧栏底部不再注册入口（用户要求删掉）；任务面板从会话头按钮进入。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID,
      inject: () => ({
        openSession: id => ctx.uiWorkspace.openSession(id),
        openArtifactPreview,
        // chip 的「打开并定位」请求交给面板自己消费（挂载时 take 一次，取走即清空）。
        focus: focusRequest,
      }),
    }, TasksPanel))

    // 侧栏「插件」下方（plugins order 0 / schedules order 10）的启动器入口；main 面板与条目同 id。
    // 这是「◈ 主会话」跳转入口，始终注册/可见（不做主会话判定，避免没建主会话时无从引导）。
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

    // 会话头「任务」入口：hooks.mainView 是任务入口闸门；false/未判定时组件返回 null。
    ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
      name: 'conversation.header.leading',
      inject: () => ({
        openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        hooks: { mainView },
      }),
    }, HeaderButton))

    // 回复底部「关联任务」chip：官方 chat 槽位 conversation.chat.turnTail（每轮已完成回复的尾部、
    // 动作行之上），只追加一个带新 id 的 list 条目 —— 不碰宿主时钟、不注入 DOM、不抢别人的条目。
    // 组件只在「主会话 + 最新一轮」时订阅共享 feed；点击 = 记下任务 id + 打开面板，
    // 面板挂载时 take() 到 id 就直接开该任务的详情抽屉（定位）。
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: CHIP_ID,
      order: 20,
      inject: () => ({
        openTask: id => {
          if (focusRequest.request(id)) ctx.layout.selectPanel(PANEL_ID)
        },
        openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        hooks: { mainView },
        chips: chipFeed,
      }),
    }, TaskChipRow))
  }

  return {
    inject,
    apply,
    __test: {
      createMainViewGate,
      countTasks,
      matchesFilter,
      matchesQuery,
      groupArtifacts,
      artifactDate,
      artifactProject,
      fileAddressOf,
      fileAddressProblem,
      selectTaskChips,
      chipStateOf,
      chipViewOf,
      chipTooltipOf,
      chipVisibleTitle,
      isLatestTurn,
      createFocusRequest,
      createTaskFeed,
      TONE_COLOR,
      STYLE_TEXT,
    },
  }
}
