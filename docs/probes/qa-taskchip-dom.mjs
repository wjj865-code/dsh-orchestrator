#!/usr/bin/env node
/**
 * L1 证据：回复底部「关联任务」chip 的 DOM 快照 + 可截图页面。
 *
 * 做法：把 **构建产物** `dist/client.js` 当经典脚本在 vm 里跑（与平台加载方式一致），
 * 用假 ctx 注册槽位，再拿真实的 conversation.chat.turnTail 注册项渲染一次 —— 得到的 HTML
 * 就是组件真正产出的标记（不是手抄的样例）。样式用产物内联的 STYLE_TEXT（与运行时注入的
 * <style> 逐字一致）。
 *
 * 用法: node docs/probes/qa-taskchip-dom.mjs [dist/client.js] [outDir]
 * 产物: <outDir>/taskchip-dom.html（可截图） + <outDir>/taskchip-dom.fragment.html（裸片段）
 * 退出码: 0 全 PASS，1 有 FAIL
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import vm from 'node:vm'

const target = process.argv[2] ?? 'dist/client.js'
const outDir = process.argv[3] ?? 'workspace/reports'

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---------- 经典脚本加载 ----------
let loaded
const registered = []
// 组件用的 h 必须产出“可序列化的 vnode”，否则后面拿不到真实标记（这是本探针的关键一步）。
const createNode = (type, props, ...children) => ({ type, props, children })
const requireFn = () => ({
  createElement: createNode,
  useState: initial => [initial, () => {}],
  useRef: initial => ({ current: initial }),
  useCallback: fn => fn,
  useEffect: () => {},
})
const ctx = {
  slots: {
    inject: (_name, factory) => { factory(); return () => {} },
    register: (spec, component) => { registered.push({ spec, component }); return () => {} },
  },
  layout: { selectPanel: () => {} },
  uiWorkspace: { openSession: () => {} },
  get: () => undefined,
  effect: callback => {
    const dispose = callback()
    if (typeof dispose === 'function') dispose()
    return () => {}
  },
}
const sandbox = {
  window: { __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, ...factory(requireFn) } } } },
  fetch: () => Promise.reject(new Error('probe: offline')),
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
}
vm.runInNewContext(readFileSync(target, 'utf8'), sandbox)
check('产物以经典脚本加载并注册 factory', typeof loaded?.apply === 'function', loaded?.id ?? '(none)')
loaded.apply(ctx)

const row = registered.find(item => item.spec.name === 'conversation.chat.turnTail')
check('注册到官方 conversation.chat.turnTail 槽位', row !== undefined)
check('list 槽位用本项目自己的 id/order', row?.spec.id === 'orchestrator-task-chips' && row?.spec.order === 20,
  `id=${row?.spec.id} order=${row?.spec.order}`)
const injected = row.spec.inject()
check('inject 暴露 openTask/openPanel 与 hooks.mainView + chips 可观测源',
  typeof injected.openTask === 'function' && typeof injected.openPanel === 'function'
  && typeof injected.hooks?.mainView?.subscribe === 'function'
  && typeof injected.chips?.subscribe === 'function' && typeof injected.chips?.getSnapshot === 'function')

// ---------- 字符串渲染（假 React：createElement 直接产出 HTML） ----------
// 关键：React 的 prop 名不是 HTML 属性名。className / htmlFor 必须翻译过去，style 的
// camelCase 键必须转 kebab —— 否则产物里留下 className="orch-taskchip" 这种无效属性，
// 页面上的 chip 只会显示浏览器默认按钮样式，截图就变成了「没有证据」的证据。
const escapeHtml = text => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const HTML_ATTR_OF = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex' }
const cssProperty = key => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))
const renderStyle = style => (style === undefined || style === null
  ? ''
  : Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${cssProperty(key)}:${value}`)
    .join(';'))
const html = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node.type === 'function') return html(node.type({ ...(node.props ?? {}), children: node.children }))
  const props = node.props ?? {}
  const attrs = Object.entries(props)
    .filter(([key, value]) => key !== 'children' && value !== undefined && value !== null && value !== false
      && typeof value !== 'function')
    .map(([key, value]) => {
      if (key === 'style') return ` style="${renderStyle(value)}"`
      const name = HTML_ATTR_OF[key] ?? key
      return value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`
    })
    .join('')
  const children = html(node.children)
  return `<${node.type}${attrs}>${children}</${node.type}>`
}
const now = Date.now()
const chipsSource = tasks => ({
  getSnapshot: () => ({ tasks, at: now }),
  subscribe: () => () => {},
})
const renderRow = ({ tasks, turn = 12, turnOrder = [10, 11, 12], main = true }) => html(row.component({
  turn,
  sessionId: 's-main',
  useMainView: selector => selector(main),
  useChat: selector => selector({ timeline: { turnOrder } }),
  chips: chipsSource(tasks),
  openTask: injected.openTask,
  openPanel: injected.openPanel,
}))

const task = (id, status, title, at) => ({
  id, title, status, coordinatorSession: 's-main', lastEventAt: now - at, updatedAt: now - at,
})

// ---------- 可断言的事实 ----------
const live = renderRow({
  tasks: [
    task('t-run', 'running', '发版 0.17.1：会话头图标对齐修复', 1_000),
    task('t-dep', 'waiting_dep', '回复底部 chip：状态图标 + 标题 + 点击打开', 2_000),
    task('t-wait', 'delivered', '等你确认的一单', 3_000),
  ],
})
check('有关联时渲染 chip 行', live.includes('data-orch-chip-row="true"'))
check('运行中 chip 有旋转圆环 class', /orch-taskchip-spin/.test(live))
check('等前置 chip 用虚线静圈', /orch-taskchip-dashed/.test(live))
check('悬浮提示写「任务名｜状态」', live.includes('title="发版 0.17.1：会话头图标对齐修复｜进行中"'))
check('可访问名与提示一致', live.includes('aria-label="发版 0.17.1：会话头图标对齐修复｜进行中"'))
check('截断只发生在超长标题上', live.includes('发版 0.17.1：会话头图标对齐修复'))
check('多个任务折算成「+N」', live.includes('+1') && live.includes('还有 1 个关联任务'))
check('空状态不渲染', renderRow({ tasks: [] }) === '')
check('子会话不渲染', renderRow({ tasks: [task('t-x', 'running', '别的会话', 1)], main: false }) === '')
check('历史轮次不渲染', renderRow({ tasks: [task('t-x', 'running', '上一轮', 1)], turnOrder: [10, 11, 12, 13] }) === '')
// 产物必须是真 HTML 属性：className 留在标记里 = 样式一条都不命中（截图会退化成本地默认按钮）。
check('class 落成 HTML 的 class 属性', live.includes('class="orch-taskchip') && !live.includes('className='),
  (live.match(/class="[^"]*"/g) ?? []).slice(0, 3).join(' | '))
check('style 落成 CSS 合法属性（含 token 变量）', live.includes('style="color:var(--dsw-alias'),
  (live.match(/style="[^"]*"/g) ?? []).slice(0, 2).join(' | '))

const matrix = [
  ['运行中 / 等前置', [task('t-run', 'running', '跑测试中', 500), task('t-dep', 'waiting_dep', '等前置发版', 900)]],
  ['待确认 / 已完成', [task('t-del', 'delivered', '待你确认', 400), task('t-done', 'done', '刚跑完', 800)]],
  ['失败 / 已取消', [task('t-fail', 'failed', '构建失败', 300), task('t-cancel', 'cancelled', '已取消', 700)]],
]
check('五个视觉态都能渲染出来', matrix.every(([, tasks]) => renderRow({ tasks }).includes('data-state=')))

// ---------- 生成可截图页面 ----------
const STYLE_TEXT = loaded.__test.STYLE_TEXT
const fragment = live
const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>orchestrator — 回复底部关联任务 chip</title>
<style>
${STYLE_TEXT}
/* ---- 仅本证据页需要的宿主替身：会话流底色 + 回复正文 + 动作行（复制/分支） ---- */
html, body { margin: 0; padding: 0; background: var(--dsw-alias-bg-base, #fff); }
body {
  font-family: var(--dsw-font-family, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.page { width: 860px; padding: 28px 32px 34px; }
.hint { margin: 0 0 18px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.turn { max-width: 720px; margin-left: 38px; }
.reply { font-size: 15px; line-height: 1.7; }
.reply p { margin: 0 0 10px; }
.mock-actions {
  display: flex; align-items: center; gap: 8px; height: 28px;
  margin-top: 4px; margin-left: -6px;
  color: var(--dsw-alias-label-tertiary, #8a8f99);
}
.mock-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 6px; border: 0; border-radius: 8px; background: transparent; color: inherit;
}
.mock-action svg { width: 17px; height: 17px; }
.mock-clock { margin-left: 8px; font-size: 12px; }
.section { margin: 26px 0 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.stack { display: flex; flex-direction: column; gap: 14px; margin-left: 38px; }
.badge { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); margin-bottom: 4px; }
</style>
</head>
<body>
<div class="page">
  <p class="hint">官方槽位 conversation.chat.turnTail · 组件产物由 dist/client.js 在 vm 中真实渲染</p>

  <div class="turn">
    <div class="reply">
      <p>已把「回复底部 chip」这一单拆好并派出去了，两个在跑、一个等你确认。</p>
    </div>
    ${fragment}
    <div class="mock-actions">
      <span class="mock-action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h10v10H9z"/><path d="M15 5H5v10"/></svg></span>
      <span class="mock-action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v9a3 3 0 0 0 3 3h9"/><path d="M15 12l3 4-3 4"/></svg></span>
      <span class="mock-clock">05:41</span>
    </div>
  </div>

  <div class="section">状态图标矩阵（同一组件的真实输出；每行两条 —— 最多 2 个 + N）</div>
  <div class="stack">
    ${matrix.map(([label, tasks]) => `<div><div class="badge">${escapeHtml(label)}</div>${renderRow({ tasks })}</div>`).join('\n    ')}
  </div>
</div>
</body>
</html>
`
mkdirSync(outDir, { recursive: true })
writeFileSync(`${outDir}/taskchip-dom.html`, page)
writeFileSync(`${outDir}/taskchip-dom.fragment.html`, `${fragment}\n`)
console.log(`wrote ${outDir}/taskchip-dom.html`)
process.exit(failures === 0 ? 0 : 1)
