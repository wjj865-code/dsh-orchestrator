/**
 * 客户端工厂（P7 / T7.2）：把常量 / 样式 / 纯逻辑 / API / 视图装配成平台认识的 { inject, apply }。
 *
 * React 只能从 factory 的 req 参数拿（源码不许 import react，否则平台与产物各一份 React，
 * hooks 全废）；参数名故意用 req 而不是 require，绕开 rollup/esbuild 的 commonjs 启发式。
 * apply(ctx) 负责：注入样式 → 起任务入口闸门 → 注册 main 面板 / 启动器 / 侧栏入口 / 会话头按钮。
 */
import {
  PANEL_ID, LAUNCHER_ID, ROUTE, TONE_COLOR,
  FILTERS, METRICS, POLL_MS, POLL_BACKOFF_MS,
  STATUS_LABEL, STATUS_TONE, MESSAGE_KIND_LABEL, DELIVERY_LABEL, DELIVERY_TONE,
  GOAL_PHASE_LABEL, GOAL_ACTIVATION_LABEL,
} from './constants.js'
import {
  countTasks, matchesFilter, matchesQuery, groupArtifacts, artifactDate, artifactProject,
  displayNameOf, textOf, listOf, timeLabel, shortPath,
} from './logic.js'
import {
  readSnapshot, readArtifacts, readDetail, readPreview, panelAction, openMainOnce,
} from './api.js'
import { createMainViewGate } from './gate.js'
import { ensureStyles, STYLE_TEXT } from './styles.js'
import { createUi } from './ui.js'
import { createViews } from './views.js'

export const createClient = (req) => {
  const React = req('react')
  const h = React.createElement
  const inject = ['slots', 'layout', 'uiWorkspace']

  const { Icon, Badge, Chip, EmptyState, Banner, SkeletonList } = createUi(h)
  const {
    HeaderButton, LauncherIcon, LauncherPanel, TasksPanel,
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

    // 侧栏底部不再注册入口（用户要求删掉）；任务面板从会话头按钮进入。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID,
      inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) }),
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

    // 会话头「☰ 任务」：hooks.mainView 是任务入口闸门；false/未判定时组件返回 null。
    ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
      name: 'conversation.header.leading',
      inject: () => ({
        openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        hooks: { mainView },
      }),
    }, HeaderButton))
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
      TONE_COLOR,
      STYLE_TEXT,
    },
  }
}
