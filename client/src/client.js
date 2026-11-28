/**
 * 客户端工厂（P7 / T7.2）：把常量 / 样式 / 纯逻辑 / API / 视图装配成平台认识的 { inject, apply }。
 *
 * React 只能从 factory 的 req 参数拿（源码不许 import react，否则平台与产物各一份 React，
 * hooks 全废）；参数名故意用 req 而不是 require，绕开 rollup/esbuild 的 commonjs 启发式。
 * apply(ctx) 负责：注入样式 → 起任务入口闸门 → 注册 main 面板 / 启动器 / 侧栏入口 / 会话头按钮。
 */
import {
  PANEL_ID, LAUNCHER_ID, ROUTE, TONE_COLOR, CHIP_ID,
  CAPABILITY_PACKS_PANEL_ID,
  FILTERS, METRICS, POLL_MS, POLL_BACKOFF_MS,
  STATUS_LABEL, STATUS_TONE, MESSAGE_KIND_LABEL, DELIVERY_LABEL, DELIVERY_TONE,
  GOAL_PHASE_LABEL, GOAL_ACTIVATION_LABEL, PLAN_STATE_LABEL,
  WORKTREE_STATE_LABEL, WORKTREE_SOURCE_LABEL,
  WORKBENCH_PAGES, WORKBENCH_STORAGE_KEY, WORKBENCH_POLL_MS, AUTOMATION_CREATE_PROMPT,
} from './constants.js'
import {
  countTasks, matchesFilter, matchesQuery, groupArtifacts, artifactDate, artifactProject,
  displayNameOf, textOf, listOf, timeLabel, shortPath, fileAddressOf, fileAddressProblem,
  createFocusRequest, selectTaskChips, chipStateOf, chipViewOf, chipTooltipOf, chipVisibleTitle,
  chipOpenTargetOf, isLatestTurn,
  splitTaskRefs, refDisplayOf, refSegmentsOf,
  startOfMonth, plannedOnDay, planStampOnDay, groupTasksOf, nextPlannedTask, automationStateLabel,
  monthGrid, dateKeyOf, coordinatorSummaryOf,
} from './logic.js'
import {
  readSnapshot, readArtifacts, readDetail, readPreview, panelAction, openMainOnce, adoptCoordinator, dropCoordinator,
  readGroups, readGroup, readCalendar, readAutomations, readStats,
  saveGroup, archiveGroup, setPlan, toggleAutomation, deleteAutomation,
  readMainNav, ackMainNav,
} from './api.js'
import { createMainNavPoller, createNavNotice } from './nav.js'
import { createTaskFeed } from './feed.js'
import { createMainViewGate } from './gate.js'
import { ensureStyles, STYLE_TEXT } from './styles.js'
import { createUi } from './ui.js'
import { createViews } from './views.js'
import { createWorkbench } from './workbench.js'
import { createConfigCard, CONFIG_ENTRY_ID, CONFIG_SLOT_KEY } from './config-form.js'
// 0.32.0 能力包面板（P4）：独立 main panel + 侧栏入口；数据/写口见 client/src/api.js。
import { createCapabilityPacksPanel } from './capability-packs.js'

export const createClient = (req) => {
  const React = req('react')
  // 经典运行时的工厂别名：用解构而不是 `React.createElement`，产物里就不会出现那个字面量
  // （test/client.test.js 的 JSX 守卫把它当「有人退回手写 createElement」的红线）。
  const { createElement: h } = React
  // sidebarRight 不进 inject：它是可选能力，缺了也要能加载面板（预览回退行内）。
  // 与 uiSession / sessions 同一口径——用 serviceOf 现取，服务晚就绪也能拿到。
  const inject = ['slots', 'layout', 'uiWorkspace']

  const { Icon, Badge, Chip, EmptyState, Banner, SkeletonList } = createUi(h)
  // 插件页配置卡片组件（P10）：只吃 props，自己订阅 ConfigForm。
  const OrchestratorConfigCard = createConfigCard({ React, h, Icon })
  const { CapabilityPacksPanel, CapabilityPacksIcon } = createCapabilityPacksPanel({
    React, h, Icon, Badge, Chip, EmptyState, Banner, SkeletonList,
  })
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
    // 0.36.0：面板「主会话」行的协调者摘要（名单/主协调者/本会话是否在名单里）。
    coordinatorSummaryOf,
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
    chipOpenTargetOf,
    isLatestTurn,
    // R3：抽屉正文里的任务引用 → 名字 chip（纯函数在 logic.js，视图只装配）。
    refSegmentsOf,
    // 工作台 v1（P11）：页面组件 + 数据源 + 纯逻辑。
    createWorkbench,
    WORKBENCH_PAGES,
    WORKBENCH_STORAGE_KEY,
    WORKBENCH_POLL_MS,
    workbenchApi: {
      readGroups, readGroup, readCalendar, readAutomations, readStats,
      saveGroup, archiveGroup, setPlan, toggleAutomation, deleteAutomation,
    },
    startOfMonth,
    plannedOnDay,
    planStampOnDay,
    groupTasksOf,
    nextPlannedTask,
    automationStateLabel,
    monthGrid,
    dateKeyOf,
    AUTOMATION_CREATE_PROMPT,
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
    // 子智能体判定（2026-11-22）：客户端会话行透出宿主 header.origin（'subagent'）。
    // 子会话头不该出现「任务 / 设为协调者」两个入口，所以闸门先问宿主“是不是主会话”，
    // 回答 false 时再问这里：命中 subagent → hidden（不渲染），其余 → adopt（设为协调者）。
    const isSubagentSession = sessionId => {
      try {
        const list = serviceOf('sessions')?.list?.getSnapshot?.()
        const row = list !== undefined && list !== null && list.byId !== undefined ? list.byId[sessionId] : undefined
        return row !== undefined && row !== null && row.origin === 'subagent'
      } catch { return false }
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
    // 把提示词写进**已有会话**的输入框（0.33.0，自动化面板「创建自动化」用）：
    // 官方「在会话中创建」走 uiWorkspace.startSession + 同一份草稿初始化；我们不需要新会话，
    // 所以先 openSession(主会话) 让宿主保留它，再取 binding 调 conversation.input 的公开入口。
    // 返回是否真的写进去了（'applied'）；宿主形状变化 / 正在提交 → false，由调用方如实提示。
    const prefillMainDraft = (sessionId, text) => {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string' || text === '') return false
      try {
        const binding = serviceOf('sessions')?.binding?.(sessionId)
        const input = serviceOf('conversation')?.input
        if (binding === undefined || binding === null || input === undefined || input === null) return false
        if (typeof input.requestDraftInitialization !== 'function') return false
        return input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' }) === 'applied'
      } catch { return false }
    }
    // 自排程定时器（仓库口径：不用 setInterval，便于卸载时立刻停）。
    const schedule = typeof setTimeout === 'function'
      ? (run, ms) => {
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
      : undefined
    const mainView = createMainViewGate({
      readSessionId,
      subscribeSession,
      fetchRole,
      isSubagent: isSubagentSession,
      timer: schedule,
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

    // t-a79e12d8：「新建协调者会话」确认后的跳转/提示待办（服务端只切指针，跳转只能客户端做）。
    // 面板顶部显示可读失败原因；同时切到面板——失败提示必须落在用户看得见的地方（与产物预览失败同口径）。
    const navNotice = createNavNotice()
    const navPoller = createMainNavPoller({
      readNav: readMainNav,
      ackNav: ackMainNav,
      openSession: sessionId => ctx.uiWorkspace.openSession(sessionId),
      onNotice: text => {
        navNotice.set(text)
        ctx.layout.selectPanel(PANEL_ID)
      },
      warn: message => {
        try { console.warn(message) } catch { /* 控制台不可用不阻断 */ }
      },
      timer: schedule,
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const stop = navPoller.start()
        return () => { try { stop?.() } catch { /* 卸载期清理失败不阻断 */ } }
      }, 'dsh-orchestrator: main nav poller')
    } else {
      void navPoller.run()
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

    // 宿主「跳到某个会话」的唯一官方入口：UiWorkspace.openSession(target: SessionTarget)
    // （@deepseek-ai/dsh-client-ui-workspace 的 navigation.ts：target 既可以是 sessionId，
    //  也可以是 { parentSessionId, childSessionId } 形式的子会话地址；内部 retain → replaceMain →
    //  selectPanel(null) 切过去。不是路由、不是 DOM）。
    // 面板行的「打开子会话」、详情抽屉的「打开子会话」、主会话启动器与回复底部 chip 都走这一个函数：
    // 一处实现，参数同形（会话 id），行为就不会各写一份而分叉。
    // 宿主对不认识/已清理的 id 是同步抛错（`sessions.retain: unknown session <id>`），调用方负责兜。
    const openChildSession = sessionId => ctx.uiWorkspace.openSession(sessionId)

    // 侧栏底部不再注册入口（用户要求删掉）；任务面板从会话头按钮进入。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID,
      inject: () => ({
        openSession: openChildSession,
        openArtifactPreview,
        // chip 的「打开并定位」请求交给面板自己消费（挂载时 take 一次，取走即清空）。
        focus: focusRequest,
        // t-a79e12d8：主会话跳转失败的可读提示（面板顶部 banner；已挂载即时推送，未挂载挂载时取走）。
        notice: navNotice,
        // 0.33.0 自动化创建：写进主会话输入框 + 跳官方「自动化任务」页（main 面板 key 'schedules'）。
        prefillDraft: prefillMainDraft,
        // 0.37.0：不再静默吞掉失败——返回 { ok, reason }，面板据此给一条可读 Banner（控件审计 F1）。
        openSchedules: () => {
          try { ctx.layout.selectPanel('schedules'); return { ok: true } } catch (failure) {
            return { ok: false, reason: String((failure && failure.message) || failure) }
          }
        },
        // 0.36.0：面板「主会话」行的协调者名单需要知道「当前是哪个会话」（本会话退出）与退出动作。
        readSessionId,
        dropCoordinator,
      }),
    }, TasksPanel))

    // 侧栏「插件」下方（plugins order 0 / schedules order 10）的启动器入口；main 面板与条目同 id。
    // 这是「◈ 主会话」跳转入口，始终注册/可见（不做主会话判定，避免没建主会话时无从引导）。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: LAUNCHER_ID,
      inject: () => ({
        openMain: openMainOnce,
        openSession: openChildSession,
        clearPanel: () => ctx.layout.selectPanel(null),
      }),
    }, LauncherPanel))

    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: LAUNCHER_ID, order: 5, label: () => '主会话',
    }, LauncherIcon))

    // 0.32.0 能力包：独立 main panel（不塞进工作台，边界一眼可见）+ 侧栏入口。
    // 侧栏 order 15：插件 0 / 主会话 5 / 能力包 15 / 排期 10（宿主自带）之后仍不抢位。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: CAPABILITY_PACKS_PANEL_ID,
      inject: () => ({ openSession: openChildSession }),
    }, CapabilityPacksPanel))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: CAPABILITY_PACKS_PANEL_ID, order: 15, label: () => '能力包',
    }, CapabilityPacksIcon))

    // 会话头「任务」入口：hooks.mainView 是任务入口闸门（角色 'main' | 'adopt' | 'hidden'）；
    // 非 'main' 时组件按角色渲染「设为协调者」或不渲染（子智能体/token 判定不出来）。
    // 0.25.0：非主会话给「设为协调者」（adopt 当前会话；服务端只切指针，旧会话保留）。
    ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
      name: 'conversation.header.leading',
      inject: () => ({
        openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        hooks: { mainView },
        adopt: adoptCoordinator,
        readSessionId,
        refreshRole: () => mainView.refresh(),
      }),
    }, HeaderButton))

    // 回复底部「关联任务」chip：官方 chat 槽位 conversation.chat.turnTail（每轮已完成回复的尾部、
    // 动作行之上），只追加一个带新 id 的 list 条目 —— 不碰宿主时钟、不注入 DOM、不抢别人的条目。
    // 组件只在「主会话 + 最新一轮」时订阅共享 feed。
    // 点击（用户预期「点 chip 就跳到那个子会话」）：
    // - 有子会话 id → openChildSession(该 id)，与面板行「打开子会话」同一个宿主调用；
    // - 没子会话 / 宿主不认这个 id（归档、目录已清理、宿主版本无 openSession）→ 降级为老行为：
    //   记一次性 focus 请求 + 开面板，面板挂载后直接开该任务详情，并把降级原因当提示显示在抽屉里。
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: CHIP_ID,
      order: 20,
      inject: () => ({
        openTask: task => {
          const target = chipOpenTargetOf(task)
          if (target.kind === 'session') {
            try {
              openChildSession(target.sessionId)
              return
            } catch (error) {
              const reason = String((error && error.message) || error)
              // 会话打不开也要让用户落到看得见的地方：面板 + 该任务详情 + 一句为什么。
              if (focusRequest.request(task.id, { notice: `子会话已打不开（${reason}），已改为展示任务详情` })) {
                ctx.layout.selectPanel(PANEL_ID)
              }
              return
            }
          }
          if (focusRequest.request(task.id)) ctx.layout.selectPanel(PANEL_ID)
        },
        openPanel: () => ctx.layout.selectPanel(PANEL_ID),
        hooks: { mainView },
        chips: chipFeed,
      }),
    }, TaskChipRow))

    // 插件页配置卡片（P10）：注册进 plugin-manager 页面声明的 keyed slot。
    //
    // 三个 key 各不相同，写错任一处都是**静默不渲染**（不报错、不留痕）：
    //   - slot 名：'plugins.bundle.config'
    //   - slot key：bundle 的**包名**（CONFIG_SLOT_KEY）
    //   - configForms.get() / whileServed() 的参数：Loader **entry id**（CONFIG_ENTRY_ID）
    //
    // `whileServed` 保证：插件没加载 / 被禁用时页面完全无痕；namespace 消失时自动撤下。
    // `configForms` 服务缺失（老宿主）时整段跳过，不影响任务面板。
    ctx.inject?.(['configForms'], child => {
      const forms = child.get?.('configForms')
      if (forms === undefined || forms === null) return
      if (typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
      child.effect?.(() => forms.whileServed([CONFIG_ENTRY_ID], () => child.slots.inject('plugins.bundle.config', () =>
        child.slots.register({
          name: 'plugins.bundle.config',
          key: CONFIG_SLOT_KEY,
        }, props => {
          // 宿主把「值 + 写操作」放在 props.form 上；卡片自己管草稿与校验。
          const form = forms.get(CONFIG_ENTRY_ID)
          return h(OrchestratorConfigCard, {
            ...props,
            form: {
              getSnapshot: () => form.getSnapshot(),
              subscribe: listener => form.subscribe(listener),
              mutate: (ops, revision) => form.mutate(ops, revision),
            },
          })
        }))), 'dsh-orchestrator: plugins-page config card')
    })
  }

  return {
    inject,
    apply,
    __test: {
      createMainViewGate,
      createMainNavPoller,
      createNavNotice,
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
      chipOpenTargetOf,
      coordinatorSummaryOf,
      // R3：正文里的引用切段/查表（五种兜底的纯函数，test/client.test.js 直接断言）。
      splitTaskRefs,
      refDisplayOf,
      refSegmentsOf,
      isLatestTurn,
      createFocusRequest,
      createTaskFeed,
      // 工作台 v1（P11）：纯逻辑与页面组件都从这里暴露，供 test/client-workbench.test.js 直接断言。
      createWorkbench,
      monthGrid,
      dateKeyOf,
      plannedOnDay,
      planStampOnDay,
      groupTasksOf,
      nextPlannedTask,
      automationStateLabel,
      WORKBENCH_PAGES,
      TONE_COLOR,
      STYLE_TEXT,
    },
  }
}
