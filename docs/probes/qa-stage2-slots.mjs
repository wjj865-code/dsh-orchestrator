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
  useEffect: (fn) => { pendingEffects.push(fn) },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
const pendingEffects = []
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
// 阶段 4：删掉侧栏底部的「任务」入口（用户要求）；侧栏入口改到「插件」下方的启动器面板（Task 3），
// 任务面板保留在 conversation.header.leading 会话头按钮。
const ALLOWED = new Set(['sidebar.panellist', 'main', 'conversation.header.leading', 'conversation.chat.turnTail', 'shell.overlay'])
const FORBIDDEN = ['sidebar.workspaces', 'sidebar.brand.mark', 'sidebar.brand.name',
  'conversation.session.header', 'conversation.session.header.actions',
  'conversation.session.header.views.actions']
for (const name of FORBIDDEN) check(`不注册 ds-bot 的 ${name}`, byName(name).length === 0)
for (const r of regs) {
  const name = r.spec?.name
  if (!ALLOWED.has(name)) check(`未登记的槽位 ${name}`, false)
  else if (name === 'shell.overlay') warn('注册了 shell.overlay（阶段 2 范围外，需另立条目）', String(r.spec?.id))
}

const footer = byName('sidebar.footer.action')
check('不再注册 sidebar.footer.action（底部「任务」入口已删）', footer.length === 0, `实际 ${footer.length}`)

const main = byName('main')
check('main 恰 2 次（任务面板 + 侧栏启动器）', main.length === 2, `实际 ${main.length}`)
const panelReg = main.find((r) => r.spec?.key === 'orchestrator')
const launcherReg = main.find((r) => r.spec?.key === 'orchestrator-launcher')
check("任务面板 key === 'orchestrator'", panelReg !== undefined, JSON.stringify(main.map((r) => r.spec?.key)))
check("启动器 key === 'orchestrator-launcher'", launcherReg !== undefined, JSON.stringify(main.map((r) => r.spec?.key)))
for (const row of main) {
  if (row.spec?.locale) warn('main 带 locale，需同时注册字典（否则去掉）', String(row.spec.locale))
  check(`main(${row.spec?.key}) 经 slots.inject 包装`, row.via === 'main', String(row.via))
}

// 侧栏「插件」下方入口：panellist 条目 id 对应启动器 main 面板，order 5（plugins 0 / schedules 10）。
const panellist = byName('sidebar.panellist')
check('sidebar.panellist 恰 1 条', panellist.length === 1, `实际 ${panellist.length}`)
if (panellist[0]) {
  const s = panellist[0].spec
  check("启动器条目 id === 'orchestrator-launcher'", s.id === 'orchestrator-launcher', String(s.id))
  check('启动器条目 order === 5（插件 0 / 自动化任务 10 之间）', s.order === 5, String(s.order))
  check('启动器条目不设 priority', !('priority' in s))
  check('启动器条目 label() === 主会话', typeof s.label === 'function' && s.label() === '主会话', String(s.label?.()))
  check('启动器条目经 slots.inject 包装', panellist[0].via === 'sidebar.panellist', String(panellist[0].via))
}

// 启动器挂载即打开主会话，再清面板回到对话。
if (launcherReg) {
  let props = {}
  try { props = typeof launcherReg.spec?.inject === 'function' ? launcherReg.spec.inject() ?? {} : {} } catch (e) { warn('启动器 inject 异常', e.message) }
  fetchCalls.length = 0
  openedSessions.length = 0
  selectPanelCalls.length = 0
  pendingEffects.length = 0
  let tree
  try { tree = launcherReg.component(props) } catch (e) { check('启动器组件可渲染', false, e.message) }
  check('启动器组件渲染「正在打开主会话…」', JSON.stringify(tree ?? {}).includes('正在打开主会话'))
  for (const fn of pendingEffects.splice(0)) {
    try { fn() } catch (e) { check('启动器 effect 不抛异常', false, e.message) }
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sent = fetchCalls.find((call) => typeof call.init?.body === 'string')
  let payload
  try { payload = sent ? JSON.parse(sent.init.body) : undefined } catch { payload = undefined }
  check('启动器挂载即 POST open-main', payload?.endpoint === 'open-main', JSON.stringify(payload))
  check('启动器打开后跳到返回的 sessionId', openedSessions.includes('session-main'), JSON.stringify(openedSessions))
  check('启动器打开后清空面板（selectPanel(null)）', selectPanelCalls.includes(null), JSON.stringify(selectPanelCalls))
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
  // U1：任务入口闸门由 inject 的 hooks.mainView 提供；探针直接喂 useMainView 模拟「主会话 / 非主会话」。
  check('leading inject 暴露 hooks.mainView（任务入口闸门）',
    typeof props?.hooks?.mainView?.getSnapshot === 'function', Object.keys(props?.hooks ?? {}).join(','))
  let tree
  try { tree = leading[0].component({ ...props, useMainView: selector => selector(true) }) } catch (e) { warn('组件无法直接调用（可能用了 hooks），跳过点击验证', e.message) }
  const clicks = []
  walk(tree, (n) => { if (n.props && typeof n.props.onClick === 'function') clicks.push(n.props.onClick) })
  if (tree) {
    check('头部按钮可渲染出 onClick', clicks.length > 0, `找到 ${clicks.length} 个`)
    for (const fn of clicks) {
      try { fn({ preventDefault() {}, stopPropagation() {}, currentTarget: null }) } catch (e) { check('onClick 不抛异常', false, e.message) }
    }
    check("点击触发 ctx.layout.selectPanel('orchestrator')", selectPanelCalls.includes('orchestrator'), JSON.stringify(selectPanelCalls))
  }
  // 非主会话：任务入口必须隐藏（组件返回 null），不能只是视觉禁用。
  let hiddenTree = 'skip'
  try { hiddenTree = leading[0].component({ ...props, useMainView: selector => selector(false) }) } catch (e) { warn('隐藏态组件调用异常', e.message) }
  if (hiddenTree !== 'skip') check('非主会话时任务入口隐藏（组件返回 null）', hiddenTree === null, JSON.stringify(hiddenTree))
}

// ---------- 面板渲染（假 React，状态筛选/空态/打开协调者） ----------
if (panelReg?.component) {
  let panelProps = {}
  if (typeof panelReg.spec?.inject === 'function') {
    try { panelProps = panelReg.spec.inject({}) ?? {} } catch (e) { warn('面板 inject 调用异常', e.message) }
  }
  let tree
  try { tree = panelReg.component(panelProps) } catch (e) { warn('面板无法直接调用（可能用了 hooks），跳过渲染验证', e.message) }
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
    check('任务行显示产物条数（源码）', /产物 \$\{artifacts\.length\}|产物.*artifacts\.length/.test(src), '产物 N')
    check('产物列表可展开并显示路径（源码）', /toggleArtifacts/.test(src) && /item\.path/.test(src), 'toggleArtifacts + item.path')
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
