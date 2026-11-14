#!/usr/bin/env node
/**
 * QA 阶段 2 L1：客户端 bundle 槽位 / 注册捕获探针
 *
 * 用法: node docs/probes/qa-stage2-slots.mjs <client.js 路径>
 * 退出码: 0 全 PASS；1 有 FAIL；2 用法错误
 *
 * 做法：把 client.js 当经典脚本在 vm 里跑，伪造 window.__ModuleLoader__、假 React、假 ctx，
 * 直接断言 register 入参（槽位名 / id / order / priority / 单席位 / 打开面板路径 / inject 清单）。
 * 不需要 DSH，也不需要真台账。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const target = process.argv[2]
if (!target) {
  console.error('用法: node docs/probes/qa-stage2-slots.mjs <client.js>')
  process.exit(2)
}

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const warn = (name, detail = '') => console.log(`WARN ${name}${detail ? ` — ${detail}` : ''}`)

let src
try { src = readFileSync(target, 'utf8') } catch (e) {
  console.error(`读不到 ${target}: ${e.message}`)
  process.exit(2)
}

// ---------- 静态检查（与运行无关的部分） ----------
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('无顶层 import/export（经典脚本）', !/(^|\n)\s*(import|export)[\s{*]/.test(stripped))

const fetchRegisters = (src.match(/fetch\s*\.\s*register/g) ?? []).length
check('client.js 不自己注册 host 路由（注册属 host 侧）', fetchRegisters === 0, `实际 ${fetchRegisters}`)
const fetchTargets = [...src.matchAll(/\bfetch\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
check('client.js 的 fetch 目标只有 /api/orchestrator',
  fetchTargets.every((t) => t === 'api/orchestrator' || t === '/api/orchestrator'),
  fetchTargets.length ? [...new Set(fetchTargets)].join(', ') : '未直接调 fetch（走封装也可，需人工确认目标）')
for (const bad of ['task_create', 'task_stop', 'bindCoordinator', 'rebindSetting']) {
  check(`client.js 不调写接口 ${bad}`, !src.includes(bad))
}
check('轮询不用 setInterval（退避需要可重排的 setTimeout）', !/setInterval\s*\(/.test(src))
check('含 30s 失败退避常量', /30\s*000|30_000/.test(src), (src.match(/POLL_BACKOFF_MS\s*=\s*[^\n]+/) ?? ['无'])[0])
const endpoints = [...src.matchAll(/endpoint\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
if (endpoints.length) warn('客户端用到的 endpoint（人工核对是否只读）', [...new Set(endpoints)].join(', '))

// ---------- 运行 bundle ----------
const loadCalls = []
const fetchCalls = []
const windowObj = {
  __ModuleLoader__: { load(mod) { loadCalls.push(mod) } },
  addEventListener() {},
  removeEventListener() {},
}
const sandbox = {
  window: windowObj,
  __ModuleLoader__: windowObj.__ModuleLoader__,
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  // 面板「打开主会话」会 POST open-main；这里返回成功体，用来验证点击后的跳转。
  fetch: async (url, init) => {
    fetchCalls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-main', created: true }) }
  },
}
vm.createContext(sandbox)
try {
  vm.runInContext(src, sandbox, { filename: target, timeout: 5000 })
} catch (e) {
  check('bundle 执行不抛异常', false, e.message)
  process.exit(1)
}
check('__ModuleLoader__.load 调用 1 次', loadCalls.length === 1, `实际 ${loadCalls.length}`)
const mod = loadCalls[0] ?? {}
check("bundle id === 'dsh-orchestrator'", mod.id === 'dsh-orchestrator', String(mod.id))
check('factory 是函数', typeof mod.factory === 'function')

// ---------- 假 React ----------
const el = (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children })
const reactMock = {
  createElement: el,
  Fragment: Symbol('Fragment'),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
let clientExports
try {
  clientExports = mod.factory((id) => {
    if (id === 'react') return reactMock
    throw new Error(`qa: 未预期的 require('${id}')，请声明 dsh.client.external 或补 mock`)
  })
} catch (e) {
  check('factory 执行不抛异常', false, e.message)
  process.exit(1)
}
const client = clientExports?.default ?? clientExports
check('factory 返回 { apply, inject }', typeof client?.apply === 'function' && Array.isArray(client?.inject), `inject=${JSON.stringify(client?.inject)}`)

// ---------- 假 ctx ----------
const regs = []
const injectNames = []
const selectPanelCalls = []
const openedSessions = []
let currentVia = null
const ctx = {
  slots: {
    inject(name, setup) {
      injectNames.push(name)
      currentVia = name
      let result
      try { result = setup() } finally { currentVia = null }
      const items = Array.isArray(result) ? result : [result]
      for (const it of items) if (it && typeof it === 'object') it.__via = name
      return () => { for (const it of items) { try { it?.dispose?.() } catch {} } }
    },
    register(spec, component) {
      const entry = { spec: spec ?? {}, component, via: currentVia, disposed: false }
      regs.push(entry)
      return { spec, dispose() { entry.disposed = true } }
    },
    entries() { return regs },
  },
  layout: {
    selectPanel(id) { selectPanelCalls.push(id); return Promise.resolve() },
    panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
  },
  uiSession: { current: 'session-qa' },
  uiWorkspace: { openSession(id) { openedSessions.push(id); return Promise.resolve() } },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  effect(fn) { const d = fn(); return () => { try { d?.() } catch {} } },
  get() { return undefined },
}

try {
  await client.apply(ctx)
} catch (e) {
  check('apply 执行不抛异常', false, e.message)
  process.exit(1)
}
check('apply 执行不抛异常', true)

// ---------- 槽位断言 ----------
const byName = (name) => regs.filter((r) => r.spec?.name === name)
// 阶段 3 修正：ds-bot 在 Bot 模式用 `nav[class*="_panelList"]{display:none!important}` 藏了整条侧栏面板列表，
// 所以入口从 sidebar.panellist 改到 sidebar.footer.action（shell 底部 action 列表，ds-bot 只用了 bot-return/bot-account 两个 id）。
const ALLOWED = new Set(['sidebar.footer.action', 'main', 'conversation.header.leading', 'shell.overlay'])
const FORBIDDEN = ['sidebar.workspaces', 'sidebar.brand.mark', 'sidebar.brand.name',
  'conversation.session.header', 'conversation.session.header.actions',
  'conversation.session.header.views.actions']
for (const name of FORBIDDEN) check(`不注册 ds-bot 的 ${name}`, byName(name).length === 0)
check('不再注册 sidebar.panellist（Bot 模式被 ds-bot display:none 藏掉，避免双入口）', byName('sidebar.panellist').length === 0)
for (const r of regs) {
  const name = r.spec?.name
  if (!ALLOWED.has(name)) check(`未登记的槽位 ${name}`, false)
  else if (name === 'shell.overlay') warn('注册了 shell.overlay（阶段 2 范围外，需另立条目）', String(r.spec?.id))
}

const footer = byName('sidebar.footer.action')
check('sidebar.footer.action 恰 1 次', footer.length === 1, `实际 ${footer.length}`)
if (footer[0]) {
  const s = footer[0].spec
  check("入口 id === 'orchestrator'", s.id === 'orchestrator', String(s.id))
  check('入口 id 不与 ds-bot 冲突（bot-account/bot-return）', !['bot-account', 'bot-return'].includes(s.id), String(s.id))
  check('入口 order === 100（ds-bot 是 -300/-200）', s.order === 100, String(s.order))
  check('入口不设 priority', !('priority' in s), s.priority === undefined ? '无' : `priority=${s.priority}`)
  check('入口经 slots.inject 包装（可撤销）', footer[0].via === 'sidebar.footer.action', String(footer[0].via))
  // shell 给 sidebar.footer.action 的 props 是 { wide }；两种形态都要可渲染、有可读标签、点击开面板。
  let base = {}
  try { base = (typeof s.inject === 'function' ? s.inject({}) : {}) ?? {} } catch (e) { warn('footer inject 异常', e.message) }
  for (const wide of [true, false]) {
    let tree
    try { tree = footer[0].component({ ...base, wide }) } catch (e) { warn(`footer 组件 wide=${wide} 渲染异常`, e.message); continue }
    check(`footer 组件（wide=${wide}）可渲染`, tree !== null && tree !== undefined)
    const buttons = []
    walk(tree, (n) => { if (n.type === 'button') buttons.push(n) })
    check(`footer 组件（wide=${wide}）渲染出按钮`, buttons.length > 0, `buttons=${buttons.length}`)
    if (buttons[0]) {
      const props = buttons[0].props ?? {}
      const label = String(props['aria-label'] ?? props.title ?? '')
      check(`footer 组件（wide=${wide}）有 aria-label/title 且含「任务」`, label.includes('任务'), label || '（无）')
      if (typeof props.onClick === 'function') {
        selectPanelCalls.length = 0
        props.onClick({ preventDefault() {}, stopPropagation() {} })
        check(`footer 组件（wide=${wide}）点击打开面板`, selectPanelCalls.includes('orchestrator'), JSON.stringify(selectPanelCalls))
      } else {
        check(`footer 组件（wide=${wide}）有 onClick`, false)
      }
    }
  }
}

const main = byName('main')
check('main 恰 1 次', main.length === 1, `实际 ${main.length}`)
if (main[0]) {
  const s = main[0].spec
  check("面板 key === 'orchestrator'", s.key === 'orchestrator', String(s.key))
  if (s.locale) warn("main 带 locale，需同时注册字典（否则去掉）", String(s.locale))
  check('面板经 slots.inject 包装', main[0].via === 'main', String(main[0].via))
}

const leading = byName('conversation.header.leading')
check('conversation.header.leading 恰 1 次', leading.length === 1, `实际 ${leading.length}`)
if (leading[0]) {
  check('leading 是单席位（不带 id）', !('id' in leading[0].spec), JSON.stringify(leading[0].spec.id))
  check('leading 经 slots.inject 包装', leading[0].via === 'conversation.header.leading', String(leading[0].via))
}

// ---------- 头部按钮点击 → 打开面板 ----------
function walk(node, visit) {
  if (!node) return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (typeof node !== 'object') return
  visit(node)
  for (const c of node.children ?? []) walk(c, visit)
}
if (leading[0]?.component) {
  let props = {}
  if (typeof leading[0].spec?.inject === 'function') {
    try { props = leading[0].spec.inject({}) ?? {} } catch (e) { warn('spec.inject 调用异常', e.message) }
  }
  let tree
  try { tree = leading[0].component(props) } catch (e) { warn('组件无法直接调用（可能用了 hooks），跳过点击验证', e.message) }
  const clicks = []
  walk(tree, (n) => { if (n.props && typeof n.props.onClick === 'function') clicks.push(n.props.onClick) })
  if (tree) {
    check('头部按钮可渲染出 onClick', clicks.length > 0, `找到 ${clicks.length} 个`)
    for (const fn of clicks) {
      try { fn({ preventDefault() {}, stopPropagation() {}, currentTarget: null }) } catch (e) { check('onClick 不抛异常', false, e.message) }
    }
    check("点击触发 ctx.layout.selectPanel('orchestrator')", selectPanelCalls.includes('orchestrator'), JSON.stringify(selectPanelCalls))
  }
}

// ---------- 面板渲染（假 React，状态筛选/空态/打开协调者） ----------
if (main[0]?.component) {
  let panelProps = {}
  if (typeof main[0].spec?.inject === 'function') {
    try { panelProps = main[0].spec.inject({}) ?? {} } catch (e) { warn('面板 inject 调用异常', e.message) }
  }
  let tree
  try { tree = main[0].component(panelProps) } catch (e) { warn('面板无法直接调用（可能用了 hooks），跳过渲染验证', e.message) }
  if (tree) {
    const selects = []
    const options = []
    const texts = []
    walk(tree, (n) => {
      for (const child of n.children ?? []) if (typeof child === 'string') texts.push(child)
      if (n.type === 'select') selects.push(n)
      if (n.type === 'option') options.push(String(n.children?.[0]))
    })
    const optionLabels = options
    check('面板有状态筛选下拉', selects.length === 1, `select=${selects.length}`)
    check('筛选 6 档且含全部/已完成/已取消丢失', optionLabels.length === 6 && ['全部', '进行中', '等待', '已完成', '失败', '已取消/丢失'].every((l) => optionLabels.includes(l)), optionLabels.join(','))
    check('下拉受控（value + onChange）', selects.length === 1 && selects[0].props.value !== undefined && typeof selects[0].props.onChange === 'function')
    check('面板有「打开主会话」按钮', texts.includes('打开主会话'), texts.join('|'))
    check('面板有「刷新」按钮', texts.includes('刷新'))
    check('主会话状态文案（未创建）', texts.includes('主会话未创建'), texts.filter((t) => t.includes('主会话')).join('|'))
    check('未创建主会话时提示从面板打开（源码，snapshot 未到达时不渲染）', /尚未打开主会话/.test(src), '「尚未打开主会话：点右上角…」')
    check('任务行渲染目标目录（源码含 targetDir + 截断）', /targetDir/.test(src) && /shortPath\(/.test(src), 'shortPath(60)')
    const openMainButton = []
    walk(tree, (n) => {
      if (n && n.props && typeof n.props.onClick === 'function' && Array.isArray(n.children) && n.children.includes('打开主会话')) openMainButton.push(n)
    })
    check('「打开主会话」按钮绑定了 onClick', openMainButton.length === 1, `找到 ${openMainButton.length}`)
    if (openMainButton[0]) {
      fetchCalls.length = 0
      openedSessions.length = 0
      try { await openMainButton[0].props.onClick({ preventDefault() {}, stopPropagation() {} }) } catch (e) { check('点击打开主会话不抛异常', false, e.message) }
      await new Promise((resolve) => setTimeout(resolve, 0))
      const sent = fetchCalls.find((call) => typeof call.init?.body === 'string')
      let payload
      try { payload = sent ? JSON.parse(sent.init.body) : undefined } catch { payload = undefined }
      check('点击后 POST open-main', payload?.endpoint === 'open-main', JSON.stringify(payload))
      check('请求路径是 /api/orchestrator', sent !== undefined && /(^|\/)api\/orchestrator$/.test(String(sent.url)), String(sent?.url))
      check('open-main 成功后跳到返回的 sessionId', openedSessions.includes('session-main'), JSON.stringify(openedSessions))
    }
  }
}

// ---------- inject 服务清单 ----------
const usedServices = new Set(['slots', 'layout'])
if (/\bctx\.uiSession\b/.test(src)) usedServices.add('uiSession')
if (/\bctx\.sessions\b/.test(src)) usedServices.add('sessions')
if (/\bctx\.uiWorkspace\b/.test(src)) usedServices.add('uiWorkspace')
if (/\bctx\.uiLayout\b/.test(src)) usedServices.add('uiLayout')
if (/\bctx\.i18n\b/.test(src)) usedServices.add('i18n')
for (const s of usedServices) check(`inject 含实际用到的服务 ${s}`, client.inject.includes(s), JSON.stringify(client.inject))
for (const s of client.inject) if (!usedServices.has(s)) warn(`inject 声明了未使用的服务 ${s}`, '检查是否多余')

// ---------- 生命周期 ----------
try {
  await client.apply(ctx)
} catch (e) {
  check('重复 apply 不抛异常', false, e.message)
}
check('重复 apply 会重复注册（平台侧 effect 负责去重，此处仅记录）', regs.length >= 3, `累计 ${regs.length} 条`)

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
