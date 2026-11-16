/**
 * 无状态展示组件（P7 / T7.2 迁入）：图标、徽标、Chip、空态、提示条、骨架卡。
 *
 * 都只吃 props，不碰 ctx / fetch；颜色走 constants.TONE_COLOR 的语义 token。
 * 工厂参数 h 来自 factory 里的 req('react').createElement（源码不许 import react）。
 *
 * S1（JSX 迁移）：组件体用 JSX 写，构建期由 esbuild 按经典运行时编译成 `h(type, props, ...children)`
 * （见 vite.client.config.mjs 的 `jsxFactory: 'h'`）；文件后缀仍是 `.js`，`h` 依旧从参数拿。
 */
import { TONE_COLOR } from './constants.js'

export function createUi(h) {
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
    trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
    folder: ['M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    copy: ['M9 9h10v10H9z', 'M15 5H5v10'],
    goal: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    inbox: ['M3 13h4l1.5 2.5h7L17 13h4', 'M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z'],
    sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
    // 会话头「任务」入口：三条横线（面板顶栏同款图标语言，替代原来的裸字符 ☰）。
    menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
    // 回复底部 chip 的状态图标：运行中用一个留缺口的圆环（旋转时看得见在动），
    // 等前置/待确认用整圆（虚线由样式加），取消用一横。
    ring: ['M12 3a9 9 0 1 1-6.36 2.64'],
    dashed: ['M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18'],
    dash: ['M6 12h12'],
    dot: ['M12 12h.01'],
  }
  const Icon = ({ name, size = 14, className }) => (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      className={className === undefined ? 'orch-icon' : `orch-icon ${className}`}
      aria-hidden="true" focusable="false"
    >
      {(ICON_PATHS[name] || ICON_PATHS.dot).map((d, index) => <path key={index} d={d} />)}
    </svg>
  )

  // 状态徽标：颜色走 TONE_COLOR（语义 token），边框/底色用 currentColor 混出来。
  const Badge = ({ tone, children, title }) => (
    <span className="orch-badge" title={title} style={{ color: TONE_COLOR[tone] || TONE_COLOR.muted }}>{children}</span>
  )

  const Chip = ({ tone, title, children }) => (
    <span className={tone === undefined ? 'orch-chip' : `orch-chip orch-chip--${tone}`} title={title}>{children}</span>
  )

  const EmptyState = ({ icon = 'inbox', title, hint, action }) => (
    <div className="orch-empty">
      <span className="orch-empty-icon"><Icon name={icon} size={20} /></span>
      {title ? <div className="orch-empty-title">{title}</div> : null}
      {hint ? <div className="orch-empty-hint">{hint}</div> : null}
      {action === undefined ? null : action}
    </div>
  )

  const Banner = ({ tone = 'info', icon = 'alert', action, children }) => (
    <div className={`orch-banner orch-banner--${tone}`}>
      <span className="orch-banner-icon"><Icon name={icon} size={14} /></span>
      <span className="orch-banner-text">{children}</span>
      {action === undefined ? null : action}
    </div>
  )

  // 加载态：闪动的骨架卡（列表 / 产物库 / 抽屉共用）。
  const SkeletonList = ({ rows = 4 }) => (
    <div className="orch-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="orch-skeleton-card">
          <div className="orch-skeleton-row">
            <div className="orch-skeleton" style={{ width: 10, height: 10, borderRadius: 5 }} />
            <div className="orch-skeleton" style={{ width: index % 2 === 0 ? '46%' : '62%' }} />
            <div className="orch-skeleton" style={{ width: 40, marginLeft: 'auto' }} />
          </div>
          <div className="orch-skeleton-row">
            <div className="orch-skeleton" style={{ width: 68 }} />
            <div className="orch-skeleton" style={{ width: 88 }} />
          </div>
        </div>
      ))}
    </div>
  )
  return { Icon, Badge, Chip, EmptyState, Banner, SkeletonList }
}
