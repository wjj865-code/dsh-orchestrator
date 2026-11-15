// dsh-orchestrator 客户端薄插件（经典脚本，模块加载器用 <script> 加载，顶层不能有 import/export）。
// 槽位：sidebar.panellist 启动器入口（插件下方）、main 任务面板 + 启动器面板、conversation.header.leading 会话头按钮。
// 面板与详情（U2）走 DeepSeek 设计平台：颜色/圆角/阴影/动效全部取宿主 --dsw-* token（见 src/styles 的
// design-platform.css、base.css、gradient-shadow-text.css），样式表在运行时注入一次；
// 布局是三段式：① 顶部命令栏（标题/主会话状态/搜索/操作）② 中部列表（左侧筛选轨 + 任务卡）③ 右侧抽屉详情。
// 深浅色不需要自己判断：宿主把 alias token 绑到 body[data-ds-dark-theme] 上，面板只读 token。
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
    // 任务入口闸门的兜底轮询：会话切换走订阅即时判定；这里只负责「首帧没判出来 / 请求失败」的重试。
    const MAIN_VIEW_POLL_MS = 5000
    // 注入的 <style> id：HMR/重复 apply 时按 id 去重，避免样式表被插两遍。
    const STYLE_ID = 'dsh-orchestrator-styles'
    const FILTERS = [
      ['all', '全部'], ['active', '进行中'], ['waiting', '待你决定'],
      ['done', '已完成'], ['failed', '失败'], ['closed', '已取消/丢失'], ['artifacts', '产物'],
    ]
    // 概览卡（三段式第一段）：点卡片等价于切筛选项。
    const METRICS = [['active', '进行中'], ['waiting', '待你决定'], ['done', '已完成'], ['failed', '失败']]

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
      settle: '结算',
    }
    const DELIVERY_LABEL = { pending: '待发', delivered: '已投递', failed: '投递失败' }
    const DELIVERY_TONE = { pending: 'warn', delivered: 'good', failed: 'bad' }
    // 平台 goal 只读展示（G1）：phase/activation 来自 ctx.goals，面板不提供任何写操作。
    const GOAL_PHASE_LABEL = {
      active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成', cleared: '已清除',
    }
    const GOAL_ACTIVATION_LABEL = { armed: '自动续轮已启用', disarmed: '不自动续轮' }
    // 语义色只取设计平台 token：旧版用的那组 alias color 变量在宿主 token 表里并不存在，
    // 一直走的是 fallback（深色主题下会脏）。这里换成 state/label 语义 token，深浅色自动跟随。
    const TONE_COLOR = {
      good: 'var(--dsw-alias-state-success-primary, #01a241)',
      bad: 'var(--dsw-alias-state-error-primary, #ec1313)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59f0a)',
      info: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      muted: 'var(--dsw-alias-label-tertiary, #8a8f99)',
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
    const textOf = value => typeof value === 'string' ? value.trim() : ''
    const listOf = value => (Array.isArray(value) ? value.map(item => textOf(item)).filter(Boolean) : [])

    // ---------------------------------------------------------------------
    // 样式表：只消费 --dsw-* / --ds-* token（宿主 ui-theme 提供），不写死颜色。
    // 经典脚本不能 import CSS，所以整张表以字符串注入；hover / 过渡 / 关键帧 / 媒体查询
    // 都只能在这里表达（内联 style 做不到 :hover 和 keyframes）。
    // ---------------------------------------------------------------------
    const STYLE_TEXT = `
.orch-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: var(--dsw-font-family, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif);
  font-size: 13px;
  line-height: 1.5;
}

/* ---------- 第一段：顶部命令栏 ---------- */
.orch-topbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.orch-brand { display: flex; align-items: center; gap: 8px; min-width: 0; margin-right: auto; }
.orch-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-specific-bubble, #eef2ff);
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.orch-title { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
.orch-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  white-space: nowrap;
}
.orch-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #c4c7cc); }
.orch-status[data-live='true'] .orch-status-dot { background: var(--dsw-alias-state-success-primary, #01a241); }
.orch-topbar-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }

/* 搜索框：focus-within 用设计平台的焦点环颜色 */
.orch-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-specific-input-major, #fff);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  transition:
    border-color var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-search:hover { border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)); }
.orch-search:focus-within {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, rgba(77, 107, 254, 0.35));
}
.orch-search input {
  width: 132px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font: inherit;
}
.orch-search input::placeholder { color: var(--dsw-alias-label-tertiary, #8a8f99); }

/* 按钮：hover / active / disabled / focus-visible 四态 */
.orch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-btn:active { background: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1)); transform: scale(0.985); }
.orch-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
.orch-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 1px;
}
.orch-btn--ghost { border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1)); }
.orch-btn--primary {
  background: var(--dsw-alias-button-primary-fill, #1f1f1f);
  color: var(--dsw-alias-label-primary-inverted, #fff);
  border-color: transparent;
}
.orch-btn--primary:hover {
  background: var(--dsw-alias-button-primary-hover, #3a3a3d);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.orch-btn--danger { color: var(--dsw-alias-state-error-primary, #ec1313); }
.orch-btn--danger:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  color: var(--dsw-alias-state-error-primary, #ec1313);
}
.orch-btn--sm { height: 22px; padding: 0 7px; font-size: 11px; }
.orch-btn--header { height: 24px; padding: 0 8px; }
.orch-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  flex: 0 0 auto;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-icon-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.orch-icon { flex: 0 0 auto; }
.orch-spin { animation: orch-rotate 0.9s linear infinite; }
@keyframes orch-rotate { to { transform: rotate(360deg); } }

/* ---------- 概览卡（第一段下半：4 个指标） ---------- */
.orch-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  flex: 0 0 auto;
  padding: 12px 16px 0;
}
.orch-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-metric:hover {
  background: var(--dsw-alias-card-fill-hover, #f1f2f4);
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
  transform: translateY(-1px);
}
.orch-metric[data-active='true'] {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.orch-metric:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
.orch-metric-value {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-metric-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-metric[data-tone='info'] .orch-metric-value { color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.orch-metric[data-tone='warn'] .orch-metric-value { color: var(--dsw-alias-state-warn-primary, #f59f0a); }
.orch-metric[data-tone='good'] .orch-metric-value { color: var(--dsw-alias-state-success-primary, #01a241); }
.orch-metric[data-tone='bad'] .orch-metric-value { color: var(--dsw-alias-state-error-primary, #ec1313); }

/* ---------- 第二段：筛选轨 + 列表 ---------- */
.orch-body { display: flex; flex: 1 1 auto; min-height: 0; }
.orch-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  width: 156px;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
}
.orch-rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-rail-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-rail-item[data-active='true'] {
  background: var(--dsw-specific-sidebar-nav-item-active, #eceff5);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-weight: 600;
}
.orch-rail-item:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.orch-rail-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orch-rail-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  background: var(--dsw-alias-bg-multi-select, #eef0f3);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-rail-item[data-active='true'] .orch-rail-count {
  background: var(--dsw-specific-sidebar-nav-item-active-accent, #dce6ff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 12px 16px 24px;
  overflow: auto;
}

/* 提示条：error / notice / info 共用骨架，颜色取 --orch-tone */
.orch-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--orch-tone) 22%, transparent);
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--orch-tone) 8%, transparent);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 12px;
}
.orch-banner--error { --orch-tone: var(--dsw-alias-state-error-primary, #ec1313); }
.orch-banner--notice { --orch-tone: var(--dsw-alias-state-warn-primary, #f59f0a); }
.orch-banner--info { --orch-tone: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-banner-icon { display: inline-flex; margin-top: 1px; color: var(--orch-tone); }
.orch-banner-text { flex: 1 1 auto; overflow-wrap: anywhere; }

/* 任务卡 */
.orch-list { display: flex; flex-direction: column; gap: 8px; }
.orch-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    box-shadow var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-card:hover {
  background: var(--dsw-alias-card-fill-hover, #f1f2f4);
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
}
.orch-card[data-open='true'] {
  border-color: var(--dsw-alias-border-selected, #9aa4b2);
  background: var(--dsw-alias-bg-layer-2, #fff);
}
.orch-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.orch-card-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.orch-card-time { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.orch-card-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.orch-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
}
.orch-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 240px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
  font-size: 11px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orch-chip--warn { color: var(--dsw-alias-state-warn-label, #b45309); background: var(--dsw-alias-state-warn-tertiary, #fef3c7); }
.orch-chip--bad {
  color: var(--dsw-alias-state-error-primary, #ec1313);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 12%, transparent);
}
.orch-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  border-radius: var(--dsw-radius-xs, 4px);
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.orch-question {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59f0a) 10%, transparent);
  color: var(--dsw-alias-state-warn-label, #b45309);
  font-size: 12px;
}

/* 展开/折叠：grid-template-rows 0fr↔1fr，才能动画到内容真实高度 */
.orch-expand {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-expand[data-open='true'] { grid-template-rows: 1fr; }
.orch-expand > div { min-height: 0; overflow: hidden; }
.orch-artifact-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.orch-chevron { transition: transform var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease); }
.orch-chevron[data-open='true'] { transform: rotate(180deg); }

/* 空态 / 加载骨架 / 错误态 */
.orch-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 36px 16px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--dsw-alias-card-fill, #f2f3f5);
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-empty-title { font-size: 13px; color: var(--dsw-alias-label-secondary, #55585f); }
.orch-empty-hint { max-width: 360px; font-size: 12px; line-height: 1.6; }
.orch-skeleton {
  height: 10px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: linear-gradient(
    90deg,
    var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04)) 25%,
    var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.06)) 37%,
    var(--dsw-alias-bg-skeleton, rgba(0, 0, 0, 0.04)) 63%
  );
  background-size: 400% 100%;
  animation: orch-shimmer 1.4s var(--ds-ease-in-out, ease) infinite;
}
@keyframes orch-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
.orch-skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
}
.orch-skeleton-row { display: flex; align-items: center; gap: 8px; }

/* ---------- 第三段：右侧抽屉详情 ---------- */
.orch-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.orch-scrim {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-scrim[data-open='true'] { opacity: 1; pointer-events: auto; }
.orch-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(460px, 92%);
  pointer-events: none;
  transform: translateX(102%);
  background: var(--dsw-alias-bg-layer-2, #fff);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  box-shadow: var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.04));
  transition: transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
.orch-drawer[data-open='true'] { transform: translateX(0); pointer-events: auto; }
.orch-drawer-content { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
@keyframes orch-slide-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: translateX(0); }
}
.orch-drawer-content { animation: orch-slide-in var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, ease); }
.orch-drawer-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.orch-drawer-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.orch-drawer-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.orch-drawer-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.orch-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 16px 20px;
  overflow: auto;
}
.orch-drawer-sections { display: flex; flex-direction: column; gap: 10px; }
.orch-drawer-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 0 0 auto;
  padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  background: var(--dsw-alias-bg-layer-1, #fff);
}

/* 抽屉里的可折叠区块 */
.orch-section {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
  overflow: hidden;
}
.orch-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-section-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-section-head:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
.orch-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.orch-section-hint { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-section-body-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.orch-section[data-collapsed='true'] .orch-section-body-wrap { grid-template-rows: 0fr; }
.orch-section[data-collapsed='true'] .orch-section-head .orch-chevron { transform: rotate(-90deg); }
.orch-section-body { min-height: 0; overflow: hidden; }
.orch-section-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #55585f);
}

/* 详情内部排版 */
.orch-kv { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 3px 8px; }
.orch-kv-key { color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-kv-val { color: var(--dsw-alias-label-secondary, #55585f); overflow-wrap: anywhere; }
.orch-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.orch-muted { color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
.orch-quote {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 0 var(--dsw-radius-xs, 4px) var(--dsw-radius-xs, 4px) 0;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.orch-pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-markdown-code-block, #f5f6f8);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: var(--ds-font-family-code, 'SF Mono', Consolas, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.orch-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
}
.orch-msg[data-kind='followup'] { background: var(--dsw-specific-bubble, #eef2ff); }
.orch-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.orch-msg-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.orch-msg-at { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.orch-artifact {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-artifact:hover { background: var(--dsw-alias-card-fill-hover, #f1f2f4); }
.orch-artifact-path {
  flex: 1 1 220px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--ds-font-family-code, 'SF Mono', Consolas, monospace);
  font-size: 11px;
}
.orch-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-basis: 100%;
  padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
.orch-group { display: flex; flex-direction: column; gap: 6px; }
.orch-group-head { display: flex; align-items: baseline; gap: 6px; }
.orch-group-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.orch-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-multi-select, #eef0f3);
}
.orch-seg-item {
  padding: 2px 8px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #55585f);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.orch-seg-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.orch-seg-item[data-active='true'] {
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0, 0, 0, 0.05));
}
/* 破坏性动作的二次确认条 */
.orch-confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 2px 4px 2px 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 8%, transparent);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 11px;
}

/* 启动器面板（侧栏「◈ 主会话」选中后一闪而过） */
.orch-launcher { align-items: center; justify-content: center; gap: 10px; padding: 32px; }
.orch-launcher-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-card-fill, #f7f8fa);
}
.orch-launcher-icon { font-size: 16px; line-height: 1; }

/* 窄屏：筛选轨变横向条，指标两列；抽屉铺满 */
@media (max-width: 860px) {
  .orch-body { flex-direction: column; }
  .orch-rail {
    width: 100%;
    flex-direction: row;
    gap: 4px;
    padding: 8px 12px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04));
  }
  .orch-rail-item { width: auto; white-space: nowrap; }
  .orch-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .orch-drawer { width: 100%; }
  .orch-search input { width: 96px; }
}
/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .orch-shell *,
  .orch-shell *::before,
  .orch-shell *::after {
    animation: none !important;
    transition: none !important;
  }
}
`

    // 样式表只注入一次；没有 document（单测/SSR）时静默跳过，不影响面板逻辑。
    const ensureStyles = () => {
      try {
        if (typeof document === 'undefined' || document === null) return false
        if (document.getElementById(STYLE_ID) !== null) return false
        const host = document.head || document.documentElement
        if (host === null || typeof host.appendChild !== 'function') return false
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE_TEXT
        host.appendChild(style)
        return true
      } catch {
        // 注入失败只丢样式，不该让整个面板炸掉。
        return false
      }
    }

    // 内联 SVG 图标：stroke 用 currentColor，颜色由外层 token 决定（深浅色自动跟随）。
    const ICON_PATHS = {
      refresh: ['M20 11a8 8 0 1 0-2.6 6.9', 'M20 4v5h-5'],
      plus: ['M12 5v14', 'M5 12h14'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      chevron: ['M6 9l6 6 6-6'],
      search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4.2-4.2'],
      alert: ['M12 8v5', 'M12 17h.01', 'M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
      check: ['M20 6L9 17l-5-5'],
      clock: ['M12 7v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'],
      stop: ['M8 8h8v8H8z'],
      retry: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
      message: ['M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12z'],
      trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
      folder: ['M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
      copy: ['M9 9h10v10H9z', 'M15 5H5v10'],
      goal: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
      inbox: ['M3 13h4l1.5 2.5h7L17 13h4', 'M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z'],
      sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
      dot: ['M12 12h.01'],
    }
    const Icon = ({ name, size = 14, className }) => h('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      className: className === undefined ? 'orch-icon' : `orch-icon ${className}`,
      'aria-hidden': 'true', focusable: 'false',
    }, (ICON_PATHS[name] || ICON_PATHS.dot).map((d, index) => h('path', { key: index, d })))

    // 状态徽标：颜色走 TONE_COLOR（语义 token），边框/底色用 currentColor 混出来。
    const Badge = ({ tone, children, title }) => h('span', {
      className: 'orch-badge', title, style: { color: TONE_COLOR[tone] || TONE_COLOR.muted },
    }, children)

    const Chip = ({ tone, title, children }) => h('span', {
      className: tone === undefined ? 'orch-chip' : `orch-chip orch-chip--${tone}`, title,
    }, children)

    const EmptyState = ({ icon = 'inbox', title, hint, action }) => h('div', { className: 'orch-empty' },
      h('span', { className: 'orch-empty-icon' }, h(Icon, { name: icon, size: 20 })),
      title ? h('div', { className: 'orch-empty-title' }, title) : null,
      hint ? h('div', { className: 'orch-empty-hint' }, hint) : null,
      action === undefined ? null : action,
    )

    const Banner = ({ tone = 'info', icon = 'alert', action, children }) => h('div', {
      className: `orch-banner orch-banner--${tone}`,
    },
      h('span', { className: 'orch-banner-icon' }, h(Icon, { name: icon, size: 14 })),
      h('span', { className: 'orch-banner-text' }, children),
      action === undefined ? null : action,
    )

    // 加载态：闪动的骨架卡（列表 / 产物库 / 抽屉共用）。
    const SkeletonList = ({ rows = 4 }) => h('div', { className: 'orch-list', 'aria-hidden': 'true' },
      Array.from({ length: rows }, (_, index) => h('div', { key: index, className: 'orch-skeleton-card' },
        h('div', { className: 'orch-skeleton-row' },
          h('div', { className: 'orch-skeleton', style: { width: 10, height: 10, borderRadius: 5 } }),
          h('div', { className: 'orch-skeleton', style: { width: index % 2 === 0 ? '46%' : '62%' } }),
          h('div', { className: 'orch-skeleton', style: { width: 40, marginLeft: 'auto' } }),
        ),
        h('div', { className: 'orch-skeleton-row' },
          h('div', { className: 'orch-skeleton', style: { width: 68 } }),
          h('div', { className: 'orch-skeleton', style: { width: 88 } }),
        ),
      )))

    // 三段式里的纯逻辑：计数 / 筛选 / 搜索 / 产物分组都提到组件外，便于单测直接断言。
    const countTasks = tasks => {
      const counts = { all: 0, active: 0, waiting: 0, done: 0, failed: 0, closed: 0, artifacts: 0 }
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (task === null || typeof task !== 'object') continue
        counts.all += 1
        for (const filter of ['active', 'waiting', 'done', 'failed', 'closed']) {
          if (matchesFilter(task, filter)) counts[filter] += 1
        }
        if (matchesFilter(task, 'artifacts')) counts.artifacts += 1
      }
      return counts
    }

    const matchesFilter = (task, filter) => {
      const status = task === null || task === undefined ? undefined : task.status
      if (filter === 'active') return status === 'waiting_dep' || status === 'pending' || status === 'running'
      if (filter === 'waiting') return status === 'waiting_user' || status === 'waiting_auth'
      if (filter === 'done') return status === 'done'
      if (filter === 'failed') return status === 'failed'
      if (filter === 'closed') return status === 'cancelled' || status === 'orphaned'
      if (filter === 'artifacts') return Array.isArray(task === null || task === undefined ? undefined : task.artifacts)
        && task.artifacts.length > 0
      return true
    }

    const matchesQuery = (task, query) => {
      const needle = String(query ?? '').trim().toLowerCase()
      if (needle === '') return true
      return [task?.title, task?.id, task?.targetDir, task?.groupId]
        .some(value => String(value ?? '').toLowerCase().includes(needle))
    }

    const artifactDate = at => {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '日期未知'
      const date = new Date(at)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const artifactProject = item => {
      const project = typeof item?.project === 'string' ? item.project : ''
      if (project !== '') return project
      const dir = textOf(item?.targetDir)
      if (dir === '') return '未关联项目'
      return dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || dir
    }
    const groupArtifacts = (items, mode) => {
      const groups = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        if (item === null || typeof item !== 'object') continue
        if (typeof item.path !== 'string' || item.path === '') continue
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

    // 任务入口闸门（fail-closed）：只有宿主明确回答「当前会话就是主会话」才显示「☰ 任务」。
    // 当前会话信号：uiSession.adapter.current（优先）→ sessions.list 的 retainedBy.mainView（兜底）；
    // 身份判定：POST session-role，宿主用台账 main_session_id 比较（与 task_* 工具同一信号）。
    // 降级：拿不到当前会话 / 请求失败 / 响应不是 ok:true → 一律隐藏；失败不缓存，靠会话切换或
    // 5 秒兜底轮询重试。侧栏「◈ 主会话」跳转入口不受这个闸门影响（始终可见）。
    const createMainViewGate = ({
      readSessionId, subscribeSession, fetchRole, timer, pollMs = MAIN_VIEW_POLL_MS, now = () => Date.now(),
    }) => {
      let visible = false
      let epoch = 0
      let lastId = null
      let lastVisible = false
      let lastOk = false
      let lastAt = 0
      const listeners = new Set()
      const setVisible = next => {
        const value = next === true
        if (value === visible) return
        visible = value
        for (const listener of [...listeners]) {
          try { listener() } catch { /* 单个入口订阅失败不影响其他入口 */ }
        }
      }
      const evaluate = async (force = false) => {
        let sessionId
        try { sessionId = readSessionId() } catch { sessionId = undefined }
        if (typeof sessionId !== 'string' || sessionId === '') {
          lastId = null
          lastOk = false
          lastAt = now()
          setVisible(false)
          return false
        }
        // 同一个会话已经拿到明确答案就直接复用；换会话（id 变了）立即重判，不等节流。
        if (!force && lastOk && lastId === sessionId) {
          setVisible(lastVisible)
          return lastVisible
        }
        if (!force && lastId === sessionId && now() - lastAt < (lastOk ? 1000 : pollMs)) return visible
        const turn = ++epoch
        lastAt = now()
        let next = false
        let ok = false
        try {
          next = (await fetchRole(sessionId)) === true
          ok = true
        } catch { ok = false }
        if (turn !== epoch) return visible
        lastId = sessionId
        lastOk = ok
        lastVisible = ok && next
        setVisible(lastVisible)
        return lastVisible
      }
      return {
        getSnapshot: () => visible,
        subscribe: listener => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        refresh: () => evaluate(true),
        start: () => {
          const disposers = []
          // uiSession / sessions 可能比本插件晚就绪：订阅失败不阻塞，兜底轮询每次补订一次。
          let sessionBound = false
          const bindSession = () => {
            if (sessionBound || typeof subscribeSession !== 'function') return
            const off = subscribeSession(() => { void evaluate() })
            if (typeof off === 'function') {
              sessionBound = true
              disposers.push(off)
            }
          }
          bindSession()
          if (typeof timer === 'function') {
            const off = timer(() => {
              bindSession()
              void evaluate()
            }, pollMs)
            if (typeof off === 'function') disposers.push(off)
          }
          void evaluate(true)
          return () => {
            for (const off of disposers) {
              try { off() } catch { /* 卸载期清理失败不阻断 */ }
            }
          }
        },
      }
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

    // 会话头「☰ 任务」：仅主会话显示。useMainView 由下面 conversation.header.leading 的 inject
    // 以 hooks.mainView 提供；hook 缺失或未判定（默认 false）时返回 null，入口隐藏。
    const HeaderButton = ({ openPanel, useMainView }) => {
      const visible = typeof useMainView === 'function' ? useMainView(value => value === true) : false
      if (visible !== true) return null
      return h('button', {
        type: 'button', title: '任务面板', className: 'orch-btn orch-btn--ghost orch-btn--header', onClick: openPanel,
      }, '\u2630 任务')
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

    const TasksPanel = ({ openSession }) => {
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

      const runPanel = async (endpoint, id, extra = {}) => {
        const key = `${endpoint}:${id}`
        if (inFlight.current.has(key)) return
        inFlight.current.add(key)
        setBusy(key)
        setActionError(null)
        setActionNotice(null)
        setConfirmStop(null)
        setConfirmDelete(null)
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

      const sendMessage = id => {
        const text = typeof window.prompt === 'function' ? window.prompt('追加一条消息给子会话：') : ''
        if (typeof text === 'string' && text.trim() !== '') void runPanel('message', id, { message: text.trim() })
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

      // 追加消息：只给「支持续派」的任务（进行中/等你确认/要授权，且已有子会话）。
      // 判定在服务端 panel-gates.js，快照/detail 下发 canFollowup；前端只读，不抄状态表。
      const messageControl = (task, label = '追加') => (task !== null && task !== undefined && task.canFollowup === true)
        ? h('button', {
          key: 'message', type: 'button', className: 'orch-btn orch-btn--sm',
          title: '给子会话追加一条消息',
          disabled: busy === `message:${task.id}`,
          onClick: act(() => sendMessage(task.id)),
        }, h(Icon, { name: 'message' }), label)
        : null

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
            retryControl(task),
            messageControl(task),
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
                      h('span', { className: 'orch-artifact-path', title: item.path },
                        `${item.path}${item.exists === false ? '（未找到）' : ''}`),
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
        const isPreview = preview !== null && preview.key === key
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
            'aria-expanded': isPreview,
            disabled: item.exists === false,
            onClick: () => void togglePreview(item.taskId, item.path),
          }, isPreview ? '收起预览' : '预览'),
          h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => void copyPath(item.path) }, '复制路径'),
          item.childSessionId
            ? h('button', { type: 'button', className: 'orch-btn orch-btn--sm', onClick: () => open(item.childSessionId) }, '打开子会话')
            : null,
          h('button', {
            type: 'button', className: 'orch-btn orch-btn--sm',
            onClick: () => void openDetail(item.taskId),
          }, '详情'),
          isPreview ? previewBlock() : null,
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
          ['目标目录', task.targetDir || '（未设置）'],
          ['分组', task.group || '（未分组）'],
          ['优先级', `P${task.priority === undefined || task.priority === null ? 0 : task.priority}`],
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

        // 7) 产物：路径/标签/存在性，路径可一键复制（浏览器不允许静默打开本地文件）。
        const artifacts = Array.isArray(task.artifacts) ? task.artifacts : []
        const artifactBody = artifacts.length === 0
          ? h('div', { className: 'orch-muted' }, '还没有产物。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            artifacts.map((item, index) => {
              const tone = item.exists === false ? TONE_COLOR.bad : TONE_COLOR.good
              return h('div', { key: `${item.path}:${index}`, className: 'orch-artifact' },
                h('span', { className: 'orch-dot', style: { background: tone, color: tone } }),
                h('span', { className: 'orch-artifact-path', title: item.path }, item.path),
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
          retryControl(detailTask),
          messageControl(detailTask, '追加消息'),
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

    // __test 只给单测拿纯函数/闸门工厂，模块加载器只认 inject + apply。
    // U2 新增：三段式的纯逻辑（计数/筛选/搜索/产物分组）与语义色表，供单测直接断言行为。
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
  },
})
