import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'

// P7 / T7.2：UI 源码在 `client/src/**`（ESM），平台加载的是 vite 产物 `dist/client.js`（classic script）。
// - 行为断言跑**产物**：`vm.runInNewContext` 按 <script> 解析执行，与平台加载方式一致；
// - 源码断言读**源码树**（含 `styles.css`）：确认「该有的代码/样式还在源码里」，防止只改产物或只改源码。
// T7.3 会把这两类彻底拆成 client.test.js（契约，读产物）+ client-source.test.js（不变量，读源码）。
const artifact = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
const source = (() => {
  const root = new URL('../client/src/', import.meta.url)
  const files = readdirSync(root, { recursive: true })
    .map(file => String(file).replaceAll('\\', '/'))
    .filter(file => file.endsWith('.js') || file.endsWith('.css'))
    .sort()
  return files.map(file => readFileSync(new URL(file, root), 'utf8')).join('\n')
})()
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const load = (options = {}) => {
  const registrations = []
  const selected = []
  const opened = []
  const loadedIds = []
  const cleanups = []
  const sessionListeners = []
  let loaded
  const services = { ...(options.services ?? {}) }
  if (options.uiSession === true) {
    services.uiSession = {
      adapter: {
        current: {
          getSnapshot: () => ({
            key: typeof options.currentSessionId === 'function' ? options.currentSessionId() : options.currentSessionId,
          }),
          subscribe: listener => { sessionListeners.push(listener); return () => {} },
        },
      },
    }
  }
  const ctx = {
    slots: {
      inject: (_name, factory) => { factory(); return () => {} },
      register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
    },
    layout: { selectPanel: id => selected.push(id) },
    uiWorkspace: { openSession: id => opened.push(id) },
    get: name => services[name],
    // gate 在 apply 里通过 effect 启动；测试 fake 只记录清理函数，避免真的开定时器。
    effect: callback => {
      const dispose = callback()
      cleanups.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  // React 垫片：只够「渲染一次」用（面板首帧冒烟）。hook 顺序按调用序号记录，
  // 不重渲染也就没有依赖数组/清理逻辑——真实行为归浏览器，这里只保证首帧不崩、结构正确。
  // effects 收集 useEffect 回调：chip 的「挂载才订阅」这类时序用例需要手动跑一次 effect。
  const hooks = { cursor: 0, slots: [], effects: [] }
  const resetHooks = () => { hooks.cursor = 0; hooks.slots.length = 0; hooks.effects.length = 0 }
  const requireFn = () => ({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = initial
      return [hooks.slots[index], () => {}]
    },
    useRef: initial => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
      return hooks.slots[index]
    },
    useCallback: (fn) => { hooks.cursor += 1; return fn },
    useEffect: effect => { hooks.cursor += 1; hooks.effects.push(effect) },
  })
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => { loadedIds.push(id); loaded = { id, ...factory(requireFn) } },
      },
    },
  }
  // 只有显式给了 fetch 的用例才注入；默认（老用例）走「信号不可用 → 默认隐藏」的降级路径。
  if (options.fetch !== undefined) sandbox.fetch = options.fetch
  // 样式注入用例：假 document 让 ensureStyles 能跑到「已有 <style>」的分支。
  if (options.document !== undefined) sandbox.document = options.document
  vm.runInNewContext(artifact, sandbox)
  return { loaded, ctx, registrations, selected, opened, loadedIds, cleanups, sessionListeners, resetHooks, hooks }
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

// 回归：0.3.0 那次 npm 包名改成 @wjj865-code/dsh-orchestrator 后，client.js 仍注册
// 无 scope 的 'dsh-orchestrator'，DSH client-modules 按包名索引 → 客户端半静默不加载
// （侧栏入口和面板全没了，服务端日志还一切正常）。这条用例把「模块 id == package.json
// name」钉成硬约束：改包名不跟着改 id，npm test 必红。
test('模块 id 回归：__ModuleLoader__.load({ id }) 必须等于 package.json 的 name', () => {
  const { loadedIds } = load()
  assert.equal(loadedIds.length, 1, '客户端应只调用一次 window.__ModuleLoader__.load')
  assert.equal(typeof loadedIds[0], 'string')
  assert.equal(
    loadedIds[0],
    pkg.name,
    `client.js 注册的模块 id 是 ${JSON.stringify(loadedIds[0])}，必须等于 package.json 的 name ${JSON.stringify(pkg.name)}；`
      + '不一致时客户端半会被 DSH 按包名索引时丢弃，且服务端不报错。',
  )
  assert.doesNotMatch(loadedIds[0], /\s/, '模块 id 不应含空白字符')
})

test('经典脚本：能被 <script> 解析，无顶层 import/export，id 等于包名', () => {
  // 产物必须是 classic script（源码是 ESM，由 vite 摊平）；平台用 <script> 直接加载它。
  assert.doesNotMatch(artifact, /^\s*(import|export)\s/m)
  // 源码是 ESM：入口靠 import 拉装配代码，产物才是摊平后的经典脚本。
  assert.match(source, /^import /m)
  const { loaded } = load()
  assert.equal(loaded.id, pkg.name)
  assert.equal(typeof loaded.apply, 'function')
  assert.ok(Array.isArray(loaded.inject))
  for (const service of ['slots', 'layout', 'uiWorkspace']) {
    assert.ok(loaded.inject.includes(service), service)
  }
})

// S0/S1（JSX 迁移）：构建链切到经典运行时 `jsxFactory: 'h'`，`.js` 源码里可以直接写 JSX，
// 编译结果必须是工厂注入的 h(...)。产物里**一个** `React.createElement` 都不许有：
// 那意味着有人退回了手写 createElement，或把 JSX 运行时改成了自动运行时（双 React 会废 hooks）。
// 这条守卫同时钉三件事：构建配置没被改回去、ui.js 真的是 JSX、源码后缀仍是 .js。
test('JSX 迁移：构建链用经典运行时 h，产物不得出现 React.createElement', () => {
  const uiFile = readFileSync(new URL('../client/src/ui.js', import.meta.url), 'utf8')
  // ui.js 全部展示件已写成 JSX（有标签，不再有 h('div') 这种手写调用）。
  assert.match(uiFile, /export function createUi\(h\)/, 'h 仍从工厂参数拿，源码不许 import react')
  assert.match(uiFile, /<svg[\s\S]*?<\/svg>/, 'Icon 应写成 JSX')
  assert.match(uiFile, /<span className="orch-badge"/, 'Badge 应写成 JSX')
  assert.doesNotMatch(uiFile, /\bh\(\s*['"`]/, 'ui.js 不应再有 h(\'div\') 这类手写调用（JSX 已接管）')
  // 构建链：`.js` 按 JSX 解析 + 经典运行时工厂 h；源码后缀保持不变（不引入 .jsx 文件）。
  const viteConfig = readFileSync(new URL('../vite.client.config.mjs', import.meta.url), 'utf8')
  assert.match(viteConfig, /loader: 'jsx'/, 'esbuild 必须把 .js 当 JSX 解析')
  assert.match(viteConfig, /jsxFactory: 'h'/, 'JSX 必须编译成 h(...)，不是 React.createElement')
  const files = readdirSync(new URL('../client/src/', import.meta.url), { recursive: true }).map(String)
  assert.equal(files.some(file => file.endsWith('.jsx')), false, 'JSX 迁移保留 .js 后缀，不新增 .jsx 文件')
  // 产物：JSX 编译结果走 h(...)，整份产物里没有 React.createElement（连别名赋值都不许）。
  assert.doesNotMatch(
    artifact,
    /React\.createElement/,
    'dist/client.js 出现 React.createElement：JSX 运行时配置被改回去了（应走 jsxFactory h）',
  )
  assert.match(artifact, /h\("span", \{ className: "orch-badge"/, 'ui.js 的 Badge 应编译成 h(...) 调用')
})

test('apply 不再注册侧栏底部入口；注册任务面板、启动器面板、侧栏入口与会话回复 chip', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const names = registrations.map(row => row.spec.name)
  assert.deepEqual(names, [
    'main', 'main', 'sidebar.panellist', 'conversation.header.leading', 'conversation.chat.turnTail',
  ])
  assert.equal(names.includes('sidebar.footer.action'), false)
})

test('启动器：side bar 条目 id/order/label 与 main 面板同 id，位于插件(0)与自动化任务(10)之间', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const panels = registrations.filter(row => row.spec.name === 'main').map(row => row.spec)
  assert.deepEqual(panels.map(spec => spec.key).sort(), ['orchestrator', 'orchestrator-launcher'])
  const entry = registrations.find(row => row.spec.name === 'sidebar.panellist').spec
  assert.equal(entry.id, 'orchestrator-launcher')
  assert.equal(entry.order, 5)
  assert.equal(entry.label(), '主会话')
})

test('启动器点击路径：复用 open-main → openSession → selectPanel(null)（源码 + inject）', () => {
  assert.match(source, /正在打开主会话…/)
  assert.match(source, /openMainOnce/)
  assert.match(source, /endpoint: 'open-main'/)
  const { loaded, ctx, registrations, selected, opened } = load()
  loaded.apply(ctx)
  const launcher = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator-launcher')
  const props = launcher.spec.inject()
  assert.equal(typeof props.openMain, 'function')
  props.openSession('s-main')
  props.clearPanel()
  assert.deepEqual(opened, ['s-main'])
  assert.deepEqual(selected, [null])
})

test('槽位选项：主面板带 key，leading 单席位不带 id', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main').spec
  assert.equal(panel.key, 'orchestrator')
  const leading = registrations.find(row => row.spec.name === 'conversation.header.leading').spec
  assert.equal('id' in leading, false)
  assert.equal('locale' in leading, false)
})

test('头部按钮的 inject 回调调用 selectPanel，面板调用 openSession', () => {
  const { loaded, ctx, registrations, selected, opened } = load()
  loaded.apply(ctx)
  const leading = registrations.find(row => row.spec.name === 'conversation.header.leading').spec
  const panel = registrations.find(row => row.spec.name === 'main').spec
  leading.inject().openPanel()
  panel.inject().openSession('c-1')
  assert.deepEqual(selected, ['orchestrator'])
  assert.deepEqual(opened, ['c-1'])
})

test('面板提供「打开主会话」并调用 open-main', () => {
  assert.match(source, /打开主会话/)
  assert.match(source, /open-main/)
  assert.match(source, /snapshot\.mainSession/)
  assert.match(source, /inboxCount/)
  assert.match(source, /待你决定/)
  assert.doesNotMatch(source, /snapshot\.coordinator/)
  assert.match(source, /task\.targetDir/)
  assert.match(source, /task\.readOnly/)
  assert.match(source, /waiting_dep/)
  assert.match(source, /task\.groupId/)
  assert.match(source, /task\.dependsOn/)
  assert.match(source, /task\.question/)
  assert.match(source, /面板动作/)
  assert.match(source, /endpoint: 'detail'/)
  assert.match(source, /runPanel/)
  assert.match(source, /产物/)
  assert.match(source, /只读/)
  assert.match(source, /task\.artifacts/)
  assert.match(source, /toggleArtifacts/)
  assert.match(source, /产物 \$\{artifacts\.length\}/)
  assert.match(source, /（未找到）/)
  assert.match(source, /openingMain/)
  assert.match(source, /打开中…/)
  assert.match(source, /openedMain/)
  assert.match(source, /主会话已就绪；若仍停在 Bot 会话里/)
  // 快照错误与动作错误分开显示：动作失败不能被写成「台账暂不可用」。
  assert.match(source, /snapshotError/)
  assert.match(source, /actionError/)
  assert.match(source, /打开主会话失败：/)
  assert.match(source, /台账暂不可用：\$\{snapshotError\}/)
  // 任务面板不用通用 setError：快照/动作分开记（启动器面板有自己的 setError，这里只约束面板路径）。
  assert.match(source, /setSnapshotError/)
  assert.match(source, /setActionError/)
})

test('面板动作：显示错误码、already 提示、message 带幂等请求 id', () => {
  // 错误对象带 code；面板把 code 拼进动作错误文案。
  assert.match(source, /const actionFailure = \(body, status\)/)
  assert.match(source, /failure\.code = body\.code/)
  assert.match(source, /失败\$\{code\}：/)
  // 幂等命中按提示显示，不报错。
  assert.match(source, /result\.already === true/)
  assert.match(source, /这条消息已发送过，未重复投递/)
  assert.match(source, /已有活跃重派任务/)
  assert.match(source, /无需重复停止/)
  assert.match(source, /actionNotice/)
  // 同动作同任务的在途请求合并。
  assert.match(source, /inFlight\.current\.has\(key\)/)
  // message 请求带 clientRequestId（host-route 按 taskId+id 去重）。
  assert.match(source, /clientRequestId/)
  assert.match(source, /newRequestId/)
  assert.match(source, /randomUUID/)
})

test('会话头按钮文案仍是任务面板', () => {
  assert.match(source, /任务面板/)
})

test('package.json 声明 client 产物与 dsh.client 清单', () => {
  // 生效入口 = 构建产物（P7/T7.2 起）：平台原样 serve exports["./client"] 指向的文件。
  assert.equal(pkg.exports['./client'], './dist/client.js')
  assert.ok(pkg.files.includes('dist/'))
  assert.equal(pkg.files.includes('client.js'), false, '产物入库后根目录不再有手写 client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  const inject = pkg.dsh.client.inject
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(inject.includes('@deepseek-ai/dsh-client-ui-renderer'), false)
  assert.equal(inject.includes('@deepseek-ai/dsh-client-ui-session'), false)
})

test('产物页：调用 artifacts 端点、按项目/日期分组、预览/复制/打开与空态', () => {
  // artifacts 端点真正被前端调用（不再只从 snapshot 拼）。
  assert.match(source, /const readArtifacts = async/)
  assert.match(source, /endpoint: 'artifacts'/)
  assert.match(source, /loadArtifacts/)
  assert.match(source, /filter !== 'artifacts'/)
  // 分组切换：项目 / 日期。
  assert.match(source, /artifactGroup/)
  assert.match(source, /'project'/)
  assert.match(source, /'date'/)
  assert.match(source, /按项目/)
  assert.match(source, /按日期/)
  assert.match(source, /artifactProject/)
  assert.match(source, /artifactDate/)
  // 交互：预览走会话右侧栏（previewInSidebar → openArtifactPreview），旧行内预览作为回退保留。
  assert.match(source, /previewInSidebar/)
  assert.match(source, /openArtifactPreview/)
  assert.match(source, /右侧栏不可用（\$\{why\}），已改为行内预览/)
  // 回退路径仍在：preview 端点 + togglePreview + previewBlock（旧 profile 不回归）。
  assert.match(source, /const readPreview = async/)
  assert.match(source, /endpoint: 'preview'/)
  assert.match(source, /togglePreview/)
  assert.match(source, /const previewBlock = /)
  assert.match(source, /复制路径/)
  assert.match(source, /打开子会话/)
  // 空态和失败态。
  assert.match(source, /共 \$\{artifactItems\.length\} 个产物/)
  assert.match(source, /产物加载失败/)
  assert.match(source, /还没有产物。任务 done 时会自动收集改动文件/)
  assert.match(source, /kind === 'text'/)
  assert.match(source, /kind === 'binary'/)
  assert.match(source, /kind === 'directory'/)
})

test('详情抽屉四区块：brief/消息/依赖/产物、空态与投递状态', () => {
  // 四区块都在同一详情视图里渲染。
  assert.match(source, /detailSection\('Brief'/)
  assert.match(source, /detailSection\('消息'/)
  assert.match(source, /detailSection\('依赖'/)
  assert.match(source, /detailSection\('产物'/)
  // brief 区块读 detail.task.brief，渲染验收/约束/背景/原话。
  assert.match(source, /const brief = task\.brief/)
  assert.match(source, /验收标准：/)
  assert.match(source, /背景资料：/)
  assert.match(source, /用户原话：/)
  assert.match(source, /这条任务没有 brief 信息/)
  // 依赖链上下游都展示状态。
  assert.match(source, /detail\.dependencies/)
  assert.match(source, /detail\.dependents/)
  assert.match(source, /没有前置任务/)
  assert.match(source, /没有下游任务/)
  // followup 投递状态三态。
  assert.match(source, /DELIVERY_LABEL/)
  assert.match(source, /待发/)
  assert.match(source, /已投递/)
  assert.match(source, /投递失败/)
  // 产物可复制路径（Clipboard API + execCommand 兜底）。
  assert.match(source, /复制路径/)
  assert.match(source, /navigator\.clipboard/)
  assert.match(source, /execCommand/)
  assert.match(source, /还没有产物/)
  assert.match(source, /还没有消息/)
})

// U1：任务入口（会话头「任务」按钮）只在主会话显示；侧栏「◈ 主会话」跳转入口始终可见。
test('任务入口闸门：默认隐藏；当前会话=主会话才显示；无会话/子会话/请求失败都隐藏', async () => {
  const { loaded } = load()
  const { createMainViewGate } = loaded.__test
  let sessionId
  let mode = 'ok'
  const calls = []
  const gate = createMainViewGate({
    readSessionId: () => sessionId,
    subscribeSession: () => () => {},
    fetchRole: async id => {
      calls.push(id)
      if (mode === 'throw') throw new Error('offline')
      if (mode === 'bad') return undefined
      return id === 's-main'
    },
    timer: () => () => {},
  })
  assert.equal(gate.getSnapshot(), false, '未判定前默认隐藏')
  await gate.refresh()
  assert.equal(gate.getSnapshot(), false, '没有当前会话时隐藏')
  assert.deepEqual(calls, [], '没有会话 id 就不该请求宿主')
  sessionId = 'c-child'
  await gate.refresh()
  assert.equal(gate.getSnapshot(), false, '其他会话（子会话）隐藏')
  assert.deepEqual(calls, ['c-child'])
  sessionId = 's-main'
  await gate.refresh()
  assert.equal(gate.getSnapshot(), true, '主会话显示')
  mode = 'throw'
  await gate.refresh()
  assert.equal(gate.getSnapshot(), false, '信号不可用（请求失败）→ 默认隐藏')
  mode = 'bad'
  await gate.refresh()
  assert.equal(gate.getSnapshot(), false, '响应不是 ok:true → 默认隐藏')
})

test('任务入口闸门：start 订阅会话变化 + 5 秒兜底轮询，失败后能重试恢复', async () => {
  const { loaded } = load()
  const { createMainViewGate } = loaded.__test
  let sessionId = 'c-child'
  let online = true
  const listeners = []
  const timers = []
  const gate = createMainViewGate({
    readSessionId: () => sessionId,
    subscribeSession: listener => { listeners.push(listener); return () => {} },
    fetchRole: async id => {
      if (!online) throw new Error('offline')
      return id === 's-main'
    },
    timer: (run, ms) => { timers.push({ run, ms }); return () => {} },
  })
  const stop = gate.start()
  await flush()
  assert.equal(gate.getSnapshot(), false)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5000, '兜底轮询间隔 5 秒')
  // 会话切换到主会话：订阅立即重判，不等轮询。
  sessionId = 's-main'
  for (const listener of listeners) listener()
  await flush()
  assert.equal(gate.getSnapshot(), true)
  // 信号失败 → 隐藏；恢复后轮询重试能重新显示。
  online = false
  await gate.refresh()
  assert.equal(gate.getSnapshot(), false)
  online = true
  await gate.refresh()
  assert.equal(gate.getSnapshot(), true)
  stop()
})

test('任务入口渲染：主会话显示「任务」入口（品牌块 + 图标 + 文字），切子会话/信号失败隐藏；侧栏「主会话」入口始终注册', async () => {
  let currentId = 's-main'
  let offline = false
  const fetchCalls = []
  const { loaded, ctx, registrations, sessionListeners } = load({
    uiSession: true,
    currentSessionId: () => currentId,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      fetchCalls.push(body)
      if (offline) throw new Error('offline')
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, isMain: body.sessionId === 's-main' }),
      }
    },
  })
  loaded.apply(ctx)
  await flush()
  const header = registrations.find(row => row.spec.name === 'conversation.header.leading')
  assert.ok(header, '会话头槽位仍注册（隐藏只是组件返回 null）')
  const injected = header.spec.inject()
  assert.equal(typeof injected.hooks.mainView.getSnapshot, 'function')
  assert.equal(injected.hooks.mainView.getSnapshot(), true)
  assert.deepEqual(fetchCalls, [{ endpoint: 'session-role', sessionId: 's-main' }])
  const render = value => header.component({
    openPanel: () => {},
    useMainView: selector => selector(value),
  })
  const shown = render(injected.hooks.mainView.getSnapshot())
  assert.equal(shown.type, 'button')
  // 入口重做后不再是裸字符「☰ 任务」：品牌色方块装内联 SVG 图标 + 半粗文字。
  assert.match(shown.props.className, /orch-btn--entry/)
  assert.equal(shown.props['aria-label'], '打开任务面板')
  assert.equal(shown.children.length, 2, '入口 = 图标块 + 文字，两段')
  assert.equal(shown.children[0].props.className, 'orch-entry-mark')
  // 图标块里是 ui.js 的 Icon 组件（React 垫片把 children 收成数组，不展开函数组件）。
  const mark = shown.children[0].children[0]
  assert.equal(typeof mark.type, 'function', '图标块里装的是 Icon 组件，不是字符')
  assert.equal(mark.props.name, 'menu', '入口图标取 ICON_PATHS.menu（三条横线）')
  assert.equal(mark.props.size, 12)
  assert.equal(shown.children[1].props.className, 'orch-entry-label')
  assert.equal(flattenText(shown.children[1]), '任务')
  assert.doesNotMatch(flattenText(shown), /\u2630/, '不再用裸字符 ☰')
  // 图标取自 ui.js 的 ICON_PATHS.menu（三条横线）。
  assert.match(source, /menu: \['M4 7h16', 'M4 12h16', 'M4 17h16'\]/)
  // 切到子会话：任务入口隐藏（组件返回 null），槽位本身不消失。
  currentId = 'c-child'
  for (const listener of sessionListeners) listener()
  await flush()
  assert.equal(injected.hooks.mainView.getSnapshot(), false)
  assert.equal(render(injected.hooks.mainView.getSnapshot()), null)
  assert.ok(registrations.some(row => row.spec.name === 'conversation.header.leading'))
  // 侧栏「◈ 主会话」跳转入口不受闸门影响：始终注册、id/order/label 不变。
  const launcher = registrations.find(row => row.spec.name === 'sidebar.panellist')
  assert.ok(launcher, '侧栏「主会话」入口始终注册')
  assert.equal(launcher.spec.id, 'orchestrator-launcher')
  assert.equal(launcher.spec.order, 5)
  assert.equal(launcher.spec.label(), '主会话')
  // 信号不可用（网络失败）→ 任务入口默认隐藏。
  currentId = 's-main'
  offline = true
  await injected.hooks.mainView.refresh()
  assert.equal(injected.hooks.mainView.getSnapshot(), false)
  assert.equal(render(injected.hooks.mainView.getSnapshot()), null)
})

// 实机回归（0.17.0 升级后）：桌面端升级插件包时，客户端插件会被热替换，页面不重载，
// 上一代构建注入的 <style id="dsh-orchestrator-styles"> 还留在 head 里。旧实现按 id 去重直接
// return，于是「新 JS + 旧 CSS」并存：新标记 .orch-entry-mark / .orch-entry-label 一条规则都匹配
// 不到，会话头「任务」入口的 12px 内联 SVG 便裸坐在 18px 行盒的基线上，比文字高约 2px——
// 同排其他宿主 chip 有自己的样式，所以只有它偏。文本不一致时就地覆盖，热替换后立即自愈。
test('样式注入：旧 <style> 与当前构建不一致时就地刷新，一致时不重复写（热替换混合态回归）', () => {
  let writes = 0
  const stale = {
    id: 'dsh-orchestrator-styles',
    _text: '/* 0.14.1 时代的旧样式：没有 .orch-entry-* 规则 */',
    get textContent() { return this._text },
    set textContent(value) { writes += 1; this._text = value },
  }
  const appended = []
  const fakeDocument = {
    head: { appendChild: node => appended.push(node) },
    getElementById: id => (id === 'dsh-orchestrator-styles' ? stale : null),
    createElement: () => ({ id: '', textContent: '' }),
  }
  const { loaded, ctx } = load({ document: fakeDocument })
  loaded.apply(ctx)
  assert.equal(appended.length, 0, '同 id 的 <style> 已存在时不重复插入')
  assert.equal(stale.textContent, loaded.__test.STYLE_TEXT, '旧样式应被当前构建的 CSS 整段覆盖')
  assert.match(stale.textContent, /\.orch-entry-mark/, '刷新后的样式必须带上入口图标块规则')
  assert.match(stale.textContent, /\.orch-entry-label/, '刷新后的样式必须带上入口文字规则')
  // 第二次 apply（同一构建）：内容一致，不再白写一遍 DOM。
  loaded.apply(ctx)
  assert.equal(writes, 1, '内容一致的重复 apply 不应重写样式')
})

// 对齐验收：入口的图标块与文字各自固定盒，按钮/图标块都走 flex 居中，字号与间距钉死；
// 断样式表而不是只断 JSX —— 这条链路正是上面混合态里丢掉的那一半。
test('任务入口对齐：按钮与图标块 flex 居中、字号/间距固定（.orch-entry-* 规则不丢）', () => {
  const { loaded } = load()
  const css = loaded.__test.STYLE_TEXT
  const block = selector => {
    const index = css.indexOf(selector)
    assert.ok(index !== -1, `样式表缺少 ${selector}`)
    const end = css.indexOf('}', index)
    return css.slice(index, end === -1 ? css.length : end)
  }
  const entry = block('.orch-btn--entry {')
  assert.match(entry, /gap: 6px/, '图标与文字间距固定 6px')
  assert.match(entry, /height: 26px/, '入口高度与宿主头部紧凑控件一致')
  assert.match(block('.orch-btn {'), /align-items: center/, '按钮基线：flex 纵向居中')
  const mark = block('.orch-entry-mark {')
  assert.match(mark, /display: inline-flex/)
  assert.match(mark, /align-items: center/, '图标块自身纵向居中')
  assert.match(mark, /justify-content: center/)
  assert.match(mark, /width: 18px/)
  assert.match(mark, /height: 18px/)
  assert.match(block('.orch-entry-label {'), /font-size: 12px/, '文字字号与 12px 图标同级')
})

test('任务入口闸门源码：session-role 端点 + uiSession/sessions 信号 + 默认隐藏', () => {
  assert.match(source, /endpoint: 'session-role'/)
  assert.match(source, /adapter\?\.current\?\.getSnapshot/)
  assert.match(source, /retainedBy\?\.mainView/)
  assert.match(source, /createMainViewGate/)
  assert.match(source, /hooks: \{ mainView \}/)
  assert.match(source, /useMainView/)
  assert.match(source, /if \(visible !== true\) return null/)
})

// 面板首帧冒烟：client/src/views.js 里的 TasksPanel 是整个 UI 的主体，之前只有源码正则断言。
// 这条用例真的把组件渲染一次（React 垫片），确保三段式结构与加载态能出来，不会一挂载就抛。
test('U2 面板首帧渲染：三段式结构 + 骨架加载态 + 抽屉默认关闭', () => {
  const { loaded, ctx, registrations, resetHooks } = load()
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  assert.equal(typeof panel.component, 'function')
  resetHooks()
  const tree = panel.component({ openSession: () => {} })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'orch-shell')

  const classes = []
  const nodes = []
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    // 函数组件（Icon/Badge/Chip/Banner/SkeletonList…）垫片不会自动展开，这里手动调一次。
    if (typeof node.type === 'function') { walk(node.type(node.props ?? {})); return }
    nodes.push(node)
    if (node.props !== null && node.props !== undefined && typeof node.props.className === 'string') {
      classes.push(...node.props.className.split(' '))
    }
    walk(node.children)
  }
  walk(tree)
  // 三段式：顶部命令栏 / 中部（筛选轨 + 列表）/ 右侧抽屉层。
  for (const cls of [
    'orch-topbar', 'orch-metrics', 'orch-body', 'orch-rail', 'orch-main',
    'orch-layer', 'orch-scrim', 'orch-drawer',
  ]) {
    assert.ok(classes.includes(cls), `首帧缺少布局节点 ${cls}`)
  }
  // 首帧还没有快照 → 骨架卡（不是空白，也不是错误态）。
  assert.ok(classes.includes('orch-skeleton-card'), '首帧应显示加载骨架')
  // 概览卡 4 个、筛选项 7 个。
  assert.equal(classes.filter(name => name === 'orch-metric').length, 4)
  assert.equal(classes.filter(name => name === 'orch-rail-item').length, 7)
  // 抽屉默认关闭，且关闭时不渲染内容（只挂壳，靠 data-open 过渡滑出）。
  const drawer = nodes.find(node => node.type === 'aside' && node.props?.className === 'orch-drawer')
  assert.ok(drawer, '抽屉壳应常驻挂载')
  assert.equal(drawer.props['data-open'], 'false')
  assert.equal(drawer.props['aria-hidden'], 'true')
  assert.deepEqual(drawer.children, [null])
  const scrim = nodes.find(node => node.props?.className === 'orch-scrim')
  assert.equal(scrim.props['data-open'], 'false')
})

// ---------------------------------------------------------------------------
// U2：DeepSeek 风格 + 三段式布局 + 右侧抽屉详情。
// 面板样式写在 client/src/styles.css，构建期以 ?inline 内联成 STYLE_TEXT，运行时注入
// <style id="dsh-orchestrator-styles">：客户端插件是经典脚本、不能 import CSS，
// hover/过渡/关键帧也只能靠样式表表达。
// ---------------------------------------------------------------------------

test('U2 三段式布局：顶部命令栏 / 中部列表（筛选轨+任务卡）/ 右侧抽屉', () => {
  for (const cls of [
    'orch-shell', 'orch-topbar', 'orch-metrics', 'orch-body', 'orch-rail',
    'orch-main', 'orch-drawer', 'orch-scrim', 'orch-layer',
  ]) {
    assert.ok(source.includes(cls), `缺少布局 class ${cls}`)
  }
  // 抽屉用 data-open 驱动 transform 过渡（关闭时仍挂载，才能滑出而不是瞬移）。
  // 形态跟随源码（S7 尾部迁 JSX）：属性名仍是 data-open、取值仍是字符串三元 'true' / 'false'。
  assert.match(source, /data-open=\{drawerOpen \? 'true' : 'false'\}/)
  assert.match(source, /const STYLE_ID = 'dsh-orchestrator-styles'/)
  assert.match(source, /const ensureStyles = \(\) =>/)
  assert.match(source, /style\.id = STYLE_ID/)
  assert.match(source, /style\.textContent = STYLE_TEXT/)
  assert.match(source, /ensureStyles\(\)/)
})

test('U2 DeepSeek 风格：颜色/圆角/层次全部走宿主 --dsw-* 设计平台 token', () => {
  const tokens = [
    // 表面与层次
    '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-card-fill', '--dsw-alias-card-fill-hover', '--dsw-alias-bg-base',
    '--dsw-alias-bg-mask-1',
    // 文字三档
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    // 描边
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-selected',
    // 状态语义色
    '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary',
    '--dsw-alias-state-warn-primary', '--dsw-alias-state-business-primary',
    // 交互层
    '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
    '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-button-primary-fill',
    // 圆角 / 阴影 / 焦点 / 动效 / 骨架
    '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg',
    '--dsw-shadow-lv1', '--dsw-elevation-prominent',
    '--dsw-focus-ring-color', '--dsw-alias-bg-skeleton',
    '--ds-transition-duration', '--ds-ease-in-out',
  ]
  for (const token of tokens) assert.ok(source.includes(token), `缺少设计平台 token ${token}`)
  // 旧代码里的 --dsw-alias-color-* 在宿主 token 表里并不存在（一直是失效的 fallback）。
  assert.doesNotMatch(source, /--dsw-alias-color-/)
})

test('U2 交互：hover / 过渡动画 / 骨架加载态 / 空态 / 错误态 / 二次确认 / 折叠', () => {
  // 样式层
  assert.match(source, /@keyframes orch-shimmer/)
  assert.match(source, /@keyframes orch-rotate/)
  assert.match(source, /@keyframes orch-slide-in/)
  assert.match(source, /\.orch-card:hover/)
  assert.match(source, /\.orch-btn:hover/)
  assert.match(source, /\.orch-section-body-wrap/)
  assert.match(source, /prefers-reduced-motion/)
  // 加载态 / 空态 / 错误态
  assert.match(source, /orch-skeleton/)
  assert.match(source, /orch-empty/)
  assert.match(source, /orch-banner--error/)
  assert.match(source, /重新加载/)
  // 破坏性动作二次确认（停止 → 确认停止 / 取消）
  assert.match(source, /confirmStop/)
  assert.match(source, /确认停止/)
  assert.match(source, /取消/)
  // 折叠展开：区块标题是 button，带 aria-expanded（S6：detailSection 迁成 JSX，断言跟着源码形态走；
  // 仍然是布尔 `!isCollapsed`，只是属性写法从对象键变成 JSX attribute——形状跟随，不是放宽）。
  assert.match(source, /aria-expanded=\{!isCollapsed\}/)
  // 抽屉按 Esc 关闭
  assert.match(source, /event\.key === 'Escape'/)
  // 右抽屉里的四区块与 B1 最新回复、G1 目标状态都还在
  assert.match(source, /detailSection\('最新回复'/)
  // 区块签名是 (key, title, hint, body)：标题必须显式传，少传一个参数会把提示文案当标题
  // （U2 实现时踩过：标题丢了、hint 渲染成区块体）。
  for (const title of ['概览', '最新回复', 'Brief', '目标状态', '消息', '依赖', '产物']) {
    assert.match(source, new RegExp(`detailSection\\('${title}', '${title}'`), `${title} 必须同时作为 key 与标题传入`)
  }
})

test('U2 样式表自检：括号成对 + 组件用到的 class 都有样式规则', () => {
  const { STYLE_TEXT } = load().loaded.__test
  const count = (text, char) => text.split(char).length - 1
  assert.equal(count(STYLE_TEXT, '{'), count(STYLE_TEXT, '}'), '样式表花括号必须成对')
  assert.equal(count(STYLE_TEXT, '('), count(STYLE_TEXT, ')'), '样式表圆括号必须成对')
  assert.doesNotMatch(STYLE_TEXT, /\$\{/, '样式表里不应残留模板占位符')
  // 组件里出现的 orch-* class 名必须在样式表里有对应规则：防止改名只改一半。
  // 前缀 `--orch-*` 是 CSS 自定义属性（如 --orch-tone），不是 class，用 [^\w-] 排除掉。
  const keyframes = new Set(['orch-rotate', 'orch-shimmer', 'orch-slide-in', 'orch-chip-pulse'])
  const used = new Set()
  for (const match of source.matchAll(/(?:^|[^\w-])(orch-[a-z0-9-]+)/g)) used.add(match[1])
  const missing = [...used].filter(name => !keyframes.has(name) && !STYLE_TEXT.includes(`.${name}`))
  assert.deepEqual(missing, [], `这些 class 没有对应样式规则：${missing.join(', ')}`)
})

test('U2 纯函数：筛选/计数与产物分组（按项目/日期）', () => {
  const { loaded } = load()
  const {
    countTasks, matchesFilter, matchesQuery, groupArtifacts, artifactDate, artifactProject, TONE_COLOR,
  } = loaded.__test
  const tasks = [
    { id: 't-1', title: '跑测试', status: 'running', artifacts: [{ path: 'a.md' }] },
    { id: 't-2', title: '等你决定', status: 'waiting_user', artifacts: [] },
    { id: 't-3', title: '已完成', status: 'done', artifacts: [{ path: 'b.md' }, { path: 'c.md' }] },
    { id: 't-4', title: '失败', status: 'failed', artifacts: [] },
    { id: 't-5', title: '取消', status: 'cancelled', artifacts: [] },
    { id: 't-6', title: '等前置', status: 'waiting_dep', artifacts: [] },
  ]
  // 注意：产物跑在 vm 沙箱里，返回的数组/对象来自另一个 realm，
  // deepStrictEqual 会因原型不同判不等 —— 统一用 Array.from / Object.assign 搬回本 realm 再比。
  const plain = value => Object.assign({}, value)
  assert.deepEqual(plain(countTasks(tasks)), {
    all: 6, active: 2, waiting: 1, done: 1, failed: 1, closed: 1, artifacts: 2,
  })
  assert.equal(tasks.filter(task => matchesFilter(task, 'all')).length, 6)
  assert.equal(tasks.filter(task => matchesFilter(task, 'active')).length, 2)
  assert.equal(tasks.filter(task => matchesFilter(task, 'waiting')).length, 1)
  assert.equal(tasks.filter(task => matchesFilter(task, 'done')).length, 1)
  assert.equal(tasks.filter(task => matchesFilter(task, 'failed')).length, 1)
  assert.equal(tasks.filter(task => matchesFilter(task, 'closed')).length, 1)
  assert.equal(tasks.filter(task => matchesFilter(task, 'artifacts')).length, 2)
  assert.equal(matchesFilter({ status: 'unknown-status' }, 'all'), true)
  assert.equal(matchesFilter({}, 'weird-filter'), true)
  // 搜索：标题/id/目录都能命中，空查询放行。
  assert.equal(matchesQuery(tasks[0], '跑'), true)
  assert.equal(matchesQuery({ id: 't-abc', title: 'x' }, 'ABC'), true)
  assert.equal(matchesQuery({ targetDir: 'C:/work/demo' }, 'demo'), true)
  assert.equal(matchesQuery(tasks[0], '   '), true)
  assert.equal(matchesQuery(tasks[0], '不存在'), false)
  // 产物分组：按项目名升序、按日期降序；同组内按时间倒序。
  const at = new Date(2026, 4, 7, 9, 0, 0).getTime()
  assert.equal(artifactDate(at), '2026-05-07')
  assert.equal(artifactDate(undefined), '日期未知')
  assert.equal(artifactProject({ project: '项目A' }), '项目A')
  assert.equal(artifactProject({ targetDir: 'C:\\work\\proj\\' }), 'proj')
  assert.equal(artifactProject({}), '未关联项目')
  const rows = [
    { path: 'a.md', at: new Date(2026, 4, 7).getTime(), project: 'p2', targetDir: null },
    { path: 'b.md', at: new Date(2026, 4, 8).getTime(), project: 'p1', targetDir: null },
    { path: 'c.md', at: new Date(2026, 4, 7, 12).getTime(), project: 'p2', targetDir: null },
  ]
  const groupsOf = (items, mode) => Array.from(
    groupArtifacts(items, mode),
    ([name, list]) => [name, Array.from(list, item => item.path)],
  )
  assert.deepEqual(groupsOf(rows, 'project'), [['p1', ['b.md']], ['p2', ['c.md', 'a.md']]])
  assert.deepEqual(groupsOf(rows, 'date'), [['2026-05-08', ['b.md']], ['2026-05-07', ['c.md', 'a.md']]])
  // 脏数据（null / 非对象 / 空路径）不进分组。
  const dirty = Array.from(groupArtifacts([null, {}, { path: '' }, { path: 'ok.md' }], 'project'),
    ([name, list]) => [name, Array.from(list, item => item.path)])
  assert.deepEqual(dirty, [['未关联项目', ['ok.md']]])
  // 状态色也走设计平台 token（不再是宿主里不存在的 --dsw-alias-color-*）。
  for (const tone of ['good', 'bad', 'warn', 'info', 'muted']) {
    assert.match(TONE_COLOR[tone], /^var\(--dsw-alias-(state|label)-/, tone)
  }
})

test('fileAddressOf：拼出宿主右侧栏认领的 dsh-resource://file/session 地址', () => {
  const { loaded } = load()
  const { fileAddressOf } = loaded.__test
  // 与 @deepseek-ai/dsh-util-workspace-path 的 sessionFileAddress 逐条对齐：
  // 前缀 + 编码后的 sessionId + 逐段编码的 path，`:` 保持字面（Windows 盘符）。
  assert.equal(fileAddressOf('s-main', '/a/b.md'), 'dsh-resource://file/session/s-main//a/b.md')
  assert.equal(fileAddressOf('s-main', 'C:\\ws\\a.md'), 'dsh-resource://file/session/s-main/C:/ws/a.md')
  assert.equal(fileAddressOf('s-main', './rel/a.md'), 'dsh-resource://file/session/s-main/rel/a.md')
  // 逐段编码：空格、`#`、`?` 都要转义，否则地址被截断或读错文件。
  assert.equal(fileAddressOf('s-main', '/a b/x#1.md'), 'dsh-resource://file/session/s-main//a%20b/x%231.md')
  assert.equal(fileAddressOf('s 1', 'a.md'), 'dsh-resource://file/session/s%201/a.md')
  // 不 trim：POSIX 允许路径首尾带空格，`/tmp/report .md` 与 `/tmp/report.md` 是两个文件。
  // 宿主 sessionFileAddress 也不 trim，两边必须同口径（否则面板指向的文件与宿主读到的不同）。
  assert.equal(fileAddressOf('s-main', '/a b/ report.md'), 'dsh-resource://file/session/s-main//a%20b/%20report.md')
  assert.equal(fileAddressOf(' s-main', 'a.md'), 'dsh-resource://file/session/%20s-main/a.md')
  // 缺会话 id 或路径 → 空串（调用方据此回退行内预览，不拼半个地址）。
  assert.equal(fileAddressOf('', 'a.md'), '')
  assert.equal(fileAddressOf('s-main', ''), '')
  assert.equal(fileAddressOf(undefined, undefined), '')
  // 孤立代理项会让 encodeURIComponent 抛 URIError；必须收敛成空串，不能让异常冒到事件处理器。
  assert.equal(fileAddressOf('s-main', 'a\uD800b.md'), '')
  // 成因判定：空路径与没会话必须分得开，否则提示会把排查引到错的地方。
  const { fileAddressProblem } = loaded.__test
  assert.equal(fileAddressProblem('s-main', '/a.md'), null)
  assert.equal(fileAddressProblem('', '/a.md'), 'no-session')
  assert.equal(fileAddressProblem('s-main', ''), 'bad-path')
  assert.equal(fileAddressProblem(undefined, undefined), 'no-session')
})

test('产物预览走右侧栏：探测前置、先切回会话再 openResource、失败把面板切回来', () => {
  // 面板占主栏时 ctx.sidebarRight.mounted 是 undefined，openResource 会抛；
  // 所以顺序必须是 selectPanel(null) → openResource，且地址带会话 id。
  const order = []
  const opened = []
  const { loaded, ctx, registrations } = load({
    uiSession: true,
    currentSessionId: () => 's-main',
    services: {
      sidebarRight: {
        mounted: { getSnapshot: () => undefined },
        openResource: address => { order.push('open'); opened.push(address) },
      },
    },
  })
  ctx.layout.selectPanel = id => { order.push(`panel:${String(id)}`) }
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const props = panel.spec.inject()
  assert.equal(typeof props.openArtifactPreview, 'function')
  const result = props.openArtifactPreview('/w/reports/a.md')
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['panel:null', 'open'], '先切回会话再开右侧栏 Tab')
  assert.deepEqual(opened, ['dsh-resource://file/session/s-main//w/reports/a.md'])

  // 侧栏服务缺失（旧 profile）→ sidebar-missing，且**不切面板**（探测前置）。
  const bare = load({ uiSession: true, currentSessionId: () => 's-main' })
  bare.loaded.apply(bare.ctx)
  const barePanel = bare.registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const bareResult = barePanel.spec.inject().openArtifactPreview('/w/a.md')
  assert.equal(bareResult.ok, false)
  assert.equal(bareResult.reason, 'sidebar-missing')
  assert.deepEqual(bare.selected, [], '探测失败时不得切走面板（否则提示落在已卸载组件上）')

  // 没有当前会话 id → 拼不出地址，同样在切面板之前返回。
  const noSession = load({
    services: { sidebarRight: { mounted: { getSnapshot: () => undefined }, openResource: () => {} } },
  })
  noSession.loaded.apply(noSession.ctx)
  const noSessionPanel = noSession.registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const noSessionResult = noSessionPanel.spec.inject().openArtifactPreview('/w/a.md')
  assert.equal(noSessionResult.ok, false)
  assert.equal(noSessionResult.reason, 'no-session')
  assert.deepEqual(noSession.selected, [], '拼不出地址时不得切走面板')

  // 有会话但路径为空 → bad-path（不能误报成 no-session），同样不切面板。
  const withSession = load({
    uiSession: true,
    currentSessionId: () => 's-main',
    services: { sidebarRight: { mounted: { getSnapshot: () => undefined }, openResource: () => {} } },
  })
  withSession.loaded.apply(withSession.ctx)
  const withSessionPanel = withSession.registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const badPathResult = withSessionPanel.spec.inject().openArtifactPreview('')
  assert.equal(badPathResult.ok, false)
  assert.equal(badPathResult.reason, 'bad-path')
  assert.deepEqual(withSession.selected, [], '路径非法时不得切走面板')

  // 宿主抛错（座位未就绪 / 地址无类型认领）→ 面板必须切回来，且原始原因要带出去。
  const throwing = load({
    uiSession: true,
    currentSessionId: () => 's-main',
    services: {
      sidebarRight: {
        mounted: { getSnapshot: () => undefined },
        openResource: () => { throw new Error('sidebarRight: no session surface is mounted') },
      },
    },
  })
  throwing.loaded.apply(throwing.ctx)
  const throwingPanel = throwing.registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const throwingResult = throwingPanel.spec.inject().openArtifactPreview('/w/a.md')
  assert.equal(throwingResult.ok, false)
  assert.equal(throwingResult.reason, 'host-refused')
  assert.match(throwingResult.message, /no session surface is mounted/, '原始失败原因不能丢')
  assert.deepEqual(throwing.selected, [null, 'orchestrator'],
    '切走了就必须切回面板，否则提示落在已卸载组件上永远看不到')

  // 源码层：三处产物入口都走同一个 previewInSidebar，不再各自 togglePreview。
  assert.match(source, /const previewInSidebar = async/)
  assert.match(source, /openArtifactPreview\(path\)/)
  assert.match(source, /orch-artifact-open/)
  // 只有产物库那一行能就地渲染行内预览，卡片/抽屉只给提示（不假装打开成功）。
  assert.match(source, /previewInSidebar\(item\.taskId, item\.path, true\)/)
  // 提示要按失败原因分档，不能三种失败共用一句话。
  assert.match(source, /sidebar-missing/)
  assert.match(source, /no-session/)
  assert.match(source, /bad-path/)
  assert.match(source, /host-refused/)
  // 孤立代理项不能让 encodeURIComponent 的 URIError 冒出去。
  assert.match(source, /catch \{\s*\n\s*\/\/ 孤立代理项/)
  // 时序不再靠轮询宏任务猜 mounted 落定（旧的 4 轮 setTimeout(0) 已删）。
  assert.doesNotMatch(source, /attempt < 4/)
  assert.doesNotMatch(source, /mounted\?\.getSnapshot/)
  // 产物登记校验：右侧栏链路不过服务端 preview 的「已登记产物」检查，前端补等价校验。
  assert.match(source, /const isRegisteredArtifact = /)
  assert.match(source, /isRegisteredArtifact\(path\)/)
})

// ---------------------------------------------------------------------------
// 面板优化：追加消息入口已移除；删除任务（仅终态、二次确认、台账级联清理）。
// 按钮可见性只读快照/detail 下发的 canDelete（服务端门控同源），
// 前端不再抄一份状态表——这条用例把「前端只看下发字段」渲染出来验证。
// ---------------------------------------------------------------------------
const flattenText = node => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') return flattenText(node.type(node.props ?? {}))
  return flattenText(node.children)
}

const collect = (tree, predicate, out = []) => {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) {
    for (const child of tree) collect(child, predicate, out)
    return out
  }
  if (typeof tree !== 'object') return out
  if (typeof tree.type === 'function') {
    collect(tree.type(tree.props ?? {}), predicate, out)
    return out
  }
  if (predicate(tree)) out.push(tree)
  collect(tree.children, predicate, out)
  return out
}

const taskRow = (id, status, extra = {}) => ({
  id, title: id, status, label: status, tone: 'info', childSessionId: null, targetDir: null,
  readOnly: false, retryOf: null, groupId: null, dependsOn: [], writeScopes: [], priority: 0,
  question: null, options: [], artifacts: [], queued: false, stale: false,
  updatedAt: 0, lastEventAt: 0, error: null, goalState: null,
  canFollowup: false, canDelete: false, ...extra,
})

const snapshotOf = tasks => ({
  ok: true, at: 0, mainSession: { id: 's-main', live: true }, inboxCount: 0, tasks,
})

test('按钮门控：「追加」已移除；删除只给终态任务（读快照 canDelete）', () => {
  const { loaded, ctx, registrations, resetHooks, hooks } = load()
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  resetHooks()
  hooks.slots[0] = snapshotOf([
    taskRow('t-run', 'running', { childSessionId: 'c-run', canFollowup: true }),
    taskRow('t-pending', 'pending'),
    taskRow('t-done', 'done', { childSessionId: 'c-done', canDelete: true }),
    taskRow('t-done-blocked', 'done', { canDelete: false }),
    taskRow('t-failed', 'failed', { childSessionId: 'c-fail', canDelete: true }),
  ])
  const tree = panel.component({ openSession: () => {} })
  const cards = collect(tree, node => node.type === 'article')
  assert.equal(cards.length, 5, '5 条任务各一张卡')
  const labelsOfCard = (status, title) => {
    const card = cards.find(node => node.props['data-status'] === status && flattenText(node).includes(title))
    assert.ok(card, `找不到卡片 ${status}/${title}`)
    return collect(card, node => node.type === 'button').map(flattenText)
  }
  const running = labelsOfCard('running', 't-run')
  const pending = labelsOfCard('pending', 't-pending')
  const done = labelsOfCard('done', 't-done')
  const doneBlocked = labelsOfCard('done', 't-done-blocked')
  const failed = labelsOfCard('failed', 't-failed')
  // 「追加」按钮整体移除：点击走 window.prompt，而 Electron 渲染进程把它替换成抛错桩
  // （prompt() is not supported.），从来发不出请求。卡片上不该再出现这个文案。
  for (const [name, labels] of [['进行中', running], ['待派发', pending], ['已完成', done], ['失败', failed]]) {
    assert.equal(labels.includes('追加'), false, `${name}任务不再有「追加」按钮`)
  }
  assert.equal(running.includes('删除'), false, '进行中任务不能删除（先停止）')
  assert.ok(pending.includes('停止'))
  assert.equal(pending.includes('删除'), false)
  assert.ok(done.includes('删除'), '终态任务应能删除')
  assert.equal(doneBlocked.includes('删除'), false, '还有活跃下游依赖的终态任务也不能删（服务端 canDelete=false）')
  assert.ok(failed.includes('重派'))
  assert.ok(failed.includes('删除'))
  // 源码层：显示条件只认下发字段，且复用 stop 的内联二次确认样式。
  assert.match(source, /task\.canDelete === true/)
  assert.match(source, /confirmDelete/)
  assert.match(source, /确认删除/)
  // 追加消息的 UI 路径已删除（window.prompt / messageControl / sendMessage 都不在了）。
  assert.doesNotMatch(source, /messageControl/)
  assert.doesNotMatch(source, /const sendMessage/)
  assert.doesNotMatch(source, /window\.prompt/)
  // 消息类型文案（服务端数据标签）保留，不受按钮移除影响。
  assert.match(source, /followup: '追加消息'/)
})

test('抽屉动作条同源门控：「追加消息」已移除；进行中不给删除，终态给删除并提示先停止才可删', () => {
  const { loaded, ctx, registrations, resetHooks, hooks } = load()
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  const detailOf = (id, extra) => ({
    ok: true,
    task: {
      id, title: id, status: extra.status, goal: '', targetDir: null, target: 'c-1', readOnly: false,
      group: null, priority: 0, dependsOn: [], writeScopes: [], question: null, options: [], error: null,
      createdAt: 0, updatedAt: 0, artifacts: [], brief: {}, goalState: null, lastMessage: null,
      canFollowup: extra.canFollowup, canDelete: extra.canDelete,
    },
    dependencies: [], dependents: [], messages: [],
  })
  // 抽屉打开：detail 槽位 + detailTaskId 槽位；任务卡列表给空，避免背景卡干扰断言。
  const footLabels = detail => {
    resetHooks()
    hooks.slots[0] = snapshotOf([])
    hooks.slots[10] = detail
    hooks.slots[13] = detail.task.id
    const tree = panel.component({ openSession: () => {} })
    const foot = collect(tree, node => node.type === 'footer' && node.props?.className === 'orch-drawer-foot')[0]
    assert.ok(foot, '抽屉应渲染底部动作条')
    return collect(foot, node => node.type === 'button').map(flattenText)
  }
  const running = footLabels(detailOf('t-run', { status: 'running', canFollowup: true, canDelete: false }))
  // 抽屉底部同样不再有「追加消息」（canFollowup 仍由服务端下发，但面板不再提供该入口）。
  assert.equal(running.includes('追加消息'), false)
  assert.equal(running.includes('删除'), false)
  assert.ok(running.includes('打开子会话'), '进行中任务仍能跳到子会话')
  const done = footLabels(detailOf('t-done', { status: 'done', canFollowup: false, canDelete: true }))
  assert.equal(done.includes('追加消息'), false)
  assert.ok(done.includes('删除'))
  // 活跃任务不显示删除，但给一句「先停止」的提示（验收允许「不显示或提示先 stop」）。
  const drawerText = (() => {
    resetHooks()
    hooks.slots[0] = snapshotOf([])
    hooks.slots[10] = detailOf('t-run2', { status: 'running', canFollowup: true, canDelete: false })
    hooks.slots[13] = 't-run2'
    return flattenText(panel.component({ openSession: () => {} }))
  })()
  assert.match(drawerText, /先「停止」/)
})

// F4 回归（0.13.0 冒烟发现）：面板「隔离」小标未接线 —— views.js 从 createViews 的参数里
// 解构 WORKTREE_STATE_LABEL / WORKTREE_SOURCE_LABEL，client.js 却没传，值恒为 undefined。
// 只要台账里有一条 worktree_state != 'none' 的任务，renderTask 就抛 TypeError，整个 main 槽位
// 被错误边界清空（面板全白）。这条用例把「接线 + 未知状态兜底」钉在产物上：喂快照渲染一次，
// 断言不抛错、卡片出现「隔离·已隔离」，未知状态退化成原始值而不是崩面板。
test('F4 回归：worktree 任务渲染「隔离」小标，状态表缺失/未知值不抛错', () => {
  const { loaded, ctx, registrations, resetHooks, hooks } = load()
  loaded.apply(ctx)
  const panel = registrations.find(row => row.spec.name === 'main' && row.spec.key === 'orchestrator')
  // 这个文件里的 flattenText 调函数组件时只传 props、不传 children（React 垫片的 children 在
  // 第三个参数里），所以 Badge/Chip 的文案拿不到。这里补一个按 React 语义展开的函数，
  // 让「隔离·…」这种由 Chip 渲染的文案能被断言到。
  const textOf = node => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (typeof node !== 'object') return ''
    if (typeof node.type === 'function') {
      return textOf(node.type({ ...(node.props ?? {}), children: node.children }))
    }
    return textOf(node.children)
  }
  resetHooks()
  hooks.slots[0] = snapshotOf([
    taskRow('t-wt', 'running', {
      worktreeState: 'created',
      worktreeBranch: 'task/t9-demo',
      worktreePath: 'C:/repo/.agents/worktrees/t-demo',
      worktreeSource: 'task',
    }),
    // 文案表里没有的状态（脏数据 / 服务端新增枚举）：小标退化成原始值，不能打死面板。
    taskRow('t-wt-weird', 'done', { worktreeState: 'weird-state', worktreeSource: 'nope' }),
    // 未隔离任务：零「隔离」字样，不受影响。
    taskRow('t-plain', 'done', { worktreeState: 'none' }),
  ])
  const tree = panel.component({ openSession: () => {} })
  assert.equal(tree.props.className, 'orch-shell')
  const cards = collect(tree, node => node.type === 'article')
  assert.equal(cards.length, 3, '3 条任务各一张卡（worktree 任务不能崩渲染）')
  const createdCard = cards.find(node => textOf(node).includes('t-wt'))
  assert.match(textOf(createdCard), /隔离·已隔离/)
  const weirdCard = cards.find(node => textOf(node).includes('t-wt-weird'))
  assert.match(textOf(weirdCard), /隔离·weird-state/)
  const plainCard = cards.find(node => textOf(node).includes('t-plain'))
  assert.doesNotMatch(textOf(plainCard), /隔离/)

  // 抽屉「隔离」行同样接线：状态/分支/检出/决定者四段都能读出来。
  resetHooks()
  hooks.slots[0] = snapshotOf([])
  hooks.slots[10] = {
    ok: true,
    task: {
      id: 't-wt', title: 't-wt', status: 'running', goal: '', targetDir: null, target: 'c-1',
      readOnly: false, group: null, priority: 0, dependsOn: [], writeScopes: [], question: null,
      options: [], error: null, createdAt: 0, updatedAt: 0, artifacts: [], brief: {}, goalState: null,
      lastMessage: null, canFollowup: false, canDelete: false,
      worktreeState: 'created', worktreeBranch: 'task/t9-demo',
      worktreePath: 'C:/repo/.agents/worktrees/t-demo', worktreeSource: 'task',
    },
    dependencies: [], dependents: [], messages: [],
  }
  hooks.slots[13] = 't-wt'
  const drawerText = flattenText(panel.component({ openSession: () => {} }))
  assert.match(drawerText, /已隔离｜分支 task\/t9-demo｜检出 C:\/repo\/\.agents\/worktrees\/t-demo｜决定 协调者传字段/)
})

// ---------------------------------------------------------------------------
// 回复底部「关联任务」chip（官方 conversation.chat.turnTail 列表槽位）
//
// 关联规则（与 client/src/logic.js 的注释一一对应）：
//   R1 会话绑定：只收 coordinatorSession === 当前会话 id 的任务；
//   R2 轮次：只挂最新一轮已完成回复的尾部；
//   R3 入选：活跃状态全收，终态只收最近 30 分钟内有动静的；
//   R4 排序：lastEventAt ↓ → updatedAt ↓ → id ↑，最多 2 个 + 「+N」。
// ---------------------------------------------------------------------------
const chipTask = (id, status, extra = {}) => ({
  id,
  title: id,
  status,
  coordinatorSession: 's-main',
  lastEventAt: 1_000,
  updatedAt: 1_000,
  ...extra,
})
const chipIds = rows => Array.from(rows, task => task.id)

// 真实 TurnLocation 形状（@deepseek-ai/dsh-client-ui-conversation 的 contract/conversation.d.ts）：
// { turn: number, start, end, status, steps, data }。conversation.chat.turnTail 槽位的 owner.turn
// 就是这个对象，不是裸数字 —— 旧用例统一传数字，正是「对象 === 数字恒假」的 bug 测不出来的原因。
const turnLocationOf = (turn, extra = {}) => ({
  turn,
  start: { type: 'turn/start', seq: turn * 100 },
  end: { type: 'turn/end', seq: turn * 100 + 1 },
  status: 'closed',
  steps: [],
  // ConversationLocationDataStore：get(key) / source(key)（不是 getSnapshot/subscribe）。
  data: {
    get: () => undefined,
    source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
  },
  ...extra,
})

// ChatSnapshot 的最小真实形状：timeline.turnOrder 是 number[]，timeline.turns 是 Map<number, TurnLocation>。
const chatSnapshotOf = turnOrder => ({
  order: [],
  nodes: {},
  locations: {},
  navigation: {},
  legacy: {},
  timeline: {
    turnOrder,
    turns: new Map(turnOrder.map(turn => [turn, turnLocationOf(turn)])),
  },
})

test('chip 关联规则：只收本会话派出的任务；活跃全收、终态只看最近 30 分钟', () => {
  const { loaded } = load()
  const { selectTaskChips } = loaded.__test
  const now = 1_000_000_000
  const recent = at => ({ lastEventAt: now - at, updatedAt: now - at })

  // 无关联一律 null（不渲染）：别的会话 / 没会话 id / 没有任务 / 数据缺失。
  assert.equal(selectTaskChips([chipTask('t-other', 'running', { coordinatorSession: 's-other' })], { sessionId: 's-main', now }), null)
  assert.equal(selectTaskChips([chipTask('t-1', 'running')], { sessionId: '', now }), null)
  assert.equal(selectTaskChips([], { sessionId: 's-main', now }), null)
  assert.equal(selectTaskChips(undefined, { sessionId: 's-main', now }), null)

  // 活跃状态全收（等前置不是取消，是活跃），按最近动静倒序。
  const active = selectTaskChips([
    chipTask('t-old', 'running', recent(5000)),
    chipTask('t-dep', 'waiting_dep', recent(1000)),
  ], { sessionId: 's-main', now })
  assert.deepEqual(chipIds(active.chips), ['t-dep', 't-old'])
  assert.equal(active.rest, 0)
  assert.equal(active.total, 2)

  // 终态：30 分钟内刚结束的收（给「刚跑完」一个交代），更早的不翻旧账。
  assert.deepEqual(
    chipIds(selectTaskChips([chipTask('t-done', 'done', recent(60_000))], { sessionId: 's-main', now }).chips),
    ['t-done'],
  )
  assert.equal(selectTaskChips([chipTask('t-done', 'done', recent(31 * 60_000))], { sessionId: 's-main', now }), null)

  // 多个：最多 2 个出 chip，其余折成「+N」。
  const many = selectTaskChips([
    chipTask('t-1', 'running', recent(100)),
    chipTask('t-2', 'waiting_user', recent(200)),
    chipTask('t-3', 'delivered', recent(300)),
    chipTask('t-4', 'waiting_dep', recent(400)),
  ], { sessionId: 's-main', now })
  assert.deepEqual(chipIds(many.chips), ['t-1', 't-2'])
  assert.equal(many.rest, 2)
  assert.equal(many.total, 4)

  // 同刻按 updatedAt、再按 id 兜底，排序确定（不吃实现细节）。
  const tie = selectTaskChips([
    chipTask('t-b', 'running', { lastEventAt: now - 100, updatedAt: now - 100 }),
    chipTask('t-a', 'running', { lastEventAt: now - 100, updatedAt: now - 100 }),
  ], { sessionId: 's-main', now })
  assert.deepEqual(chipIds(tie.chips), ['t-a', 't-b'])
})

test('chip 状态映射：旋转圆环 / 虚线静圈 / 脉冲半色 / ✓ / ✗ / —；悬浮写任务名+状态', () => {
  const { loaded } = load()
  const { chipStateOf, chipViewOf, chipTooltipOf, chipVisibleTitle } = loaded.__test
  const mapping = [
    ['running', 'running'], ['pending', 'waiting'], ['waiting_dep', 'waiting'],
    ['waiting_user', 'confirming'], ['waiting_auth', 'confirming'], ['delivered', 'confirming'],
    ['done', 'done'], ['failed', 'failed'], ['orphaned', 'failed'], ['missing', 'failed'],
    ['cancelled', 'cancelled'],
  ]
  for (const [status, state] of mapping) assert.equal(chipStateOf(status), state, status)
  assert.equal(chipStateOf('weird-status'), 'waiting', '未知状态不许谎报成功/失败')

  assert.deepEqual(
    { icon: chipViewOf('running').icon, className: chipViewOf('running').className, tone: chipViewOf('running').tone },
    { icon: 'ring', className: 'orch-taskchip-spin', tone: 'info' },
  )
  assert.equal(chipViewOf('waiting_dep').state, 'waiting')
  assert.equal(chipViewOf('waiting_dep').className, 'orch-taskchip-dashed')
  assert.deepEqual(
    { state: chipViewOf('delivered').state, className: chipViewOf('delivered').className, tone: chipViewOf('delivered').tone },
    { state: 'confirming', className: 'orch-taskchip-dashed', tone: 'warn' },
  )
  assert.equal(chipViewOf('done').icon, 'check')
  assert.equal(chipViewOf('failed').icon, 'close')
  assert.equal(chipViewOf('cancelled').icon, 'dash')

  // 悬浮提示 = 任务名 + 状态；没有标题时退化成「任务 t-xxx」。
  assert.equal(chipTooltipOf(chipTask('t-1', 'waiting_dep', { title: '修发版' })), '修发版｜等前置')
  assert.equal(chipTooltipOf({ id: 't-2', status: 'done' }), '任务 t-2｜已完成')
  // 长标题按码点截断（emoji 不被切成半个），像素级省略交给 CSS。
  const cut = chipVisibleTitle('很长的任务标题'.repeat(6))
  assert.ok(Array.from(cut).length <= 24, `截断后长度 ${Array.from(cut).length}`)
  assert.ok(cut.endsWith('…'))
  assert.equal(chipVisibleTitle('短标题'), '短标题')
  assert.equal(chipVisibleTitle('😀'.repeat(40)).length > 0, true)
})

// 渲染 chip 行：走真实注册项（turnTail），只喂假 props。
const renderChipRow = (options = {}) => {
  const env = load()
  const { loaded, ctx, registrations, resetHooks, hooks } = env
  loaded.apply(ctx)
  const row = registrations.find(item => item.spec.name === 'conversation.chat.turnTail')
  const panel = registrations.find(item => item.spec.name === 'main' && item.spec.key === 'orchestrator')
  const baseChips = options.chips === undefined
    ? { getSnapshot: () => null, subscribe: () => () => {} }
    : options.chips
  // 包一层计数：断言「什么时候订阅、退订了没有」，不依赖组件内部实现。
  const counts = { subscribe: 0, unsubscribe: 0 }
  const chips = {
    getSnapshot: baseChips.getSnapshot,
    subscribe: listener => {
      counts.subscribe += 1
      const off = baseChips.subscribe(listener)
      return () => {
        counts.unsubscribe += 1
        if (typeof off === 'function') off()
      }
    },
  }
  const injected = row.spec.inject()
  resetHooks()
  // 默认传真实形状（TurnLocation 对象）；要测裸数字/别的显式形状时用 options.turn 覆盖。
  const turn = options.turn === undefined ? turnLocationOf(7) : options.turn
  const tree = row.component({
    turn,
    sessionId: options.sessionId === undefined ? 's-main' : options.sessionId,
    useMainView: options.useMainView === undefined ? selector => selector(true) : options.useMainView,
    useChat: options.useChat === undefined
      ? selector => selector(chatSnapshotOf(options.turnOrder === undefined ? [5, 6, 7] : options.turnOrder))
      : options.useChat,
    chips,
    openTask: injected.openTask,
    openPanel: injected.openPanel,
  })
  return { ...env, row, panel, injected, tree, turn, counts }
}

test('回归：isLatestTurn 按 TurnLocation 的真实形状比较（对象 === 数字恒假的旧 bug）', () => {
  // 根因：turnOrder 是 number[]，而 turnTail 的 owner.turn 是 TurnLocation 对象；
  // 旧实现直接 `order[order.length - 1] === turn`，永远 false → chip 在真实宿主里永不渲染。
  // 这条用例用真实形状构造，防止有人把比较改回「整对象比较」。
  const { loaded } = load()
  const { isLatestTurn } = loaded.__test
  const snapshot = chatSnapshotOf([5, 6, 7])

  assert.equal(isLatestTurn(snapshot, turnLocationOf(7)), true, '最新一轮（TurnLocation 对象）必须判为 true')
  assert.equal(isLatestTurn(snapshot, turnLocationOf(6)), false, '历史轮次必须判为 false')
  // 多一层字段也不影响：比较只看 TurnLocation.turn。
  assert.equal(isLatestTurn(snapshot, turnLocationOf(7, { status: 'open', steps: [{}] })), true)

  // 坏入参/空时间线：不抛、不误判成最新。
  assert.equal(isLatestTurn(null, turnLocationOf(7)), false)
  assert.equal(isLatestTurn({}, turnLocationOf(7)), false)
  assert.equal(isLatestTurn(chatSnapshotOf([]), turnLocationOf(7)), false)
  assert.equal(isLatestTurn(snapshot, null), false)
  assert.equal(isLatestTurn(snapshot, { turn: '7' }), false)

  // 历史兼容：裸 number 入参（**非真实形状**，真实宿主永远传 TurnLocation 对象）。
  assert.equal(isLatestTurn(snapshot, 7), true)
})

test('chip 渲染与空状态：无关联/非主会话/非最新一轮都不渲染；有关联才出行', () => {
  // 快照还没到（null）→ 不渲染，也不出骨架。
  assert.equal(renderChipRow().tree, null)
  // 快照有任务但都不属于本会话 → 不渲染。
  const foreign = { ok: true, tasks: [chipTask('t-other', 'running', { coordinatorSession: 's-other' })] }
  assert.equal(renderChipRow({ chips: { getSnapshot: () => foreign, subscribe: () => () => {} } }).tree, null)
  // 子会话（mainView 闸门 false）不渲染。
  assert.equal(renderChipRow({
    useMainView: selector => selector(false),
    chips: { getSnapshot: () => ({ tasks: [chipTask('t-1', 'running')] }), subscribe: () => () => {} },
  }).tree, null)
  // 历史轮次（不是最新一轮）不渲染：chip 只说明「这一轮回复之后任务在干什么」。
  assert.equal(renderChipRow({
    turnOrder: [5, 6, 7, 8],
    chips: { getSnapshot: () => ({ tasks: [chipTask('t-1', 'running')] }), subscribe: () => () => {} },
  }).tree, null)
  // 真实形状（TurnLocation 对象）+ 最新一轮：必须出行。旧 bug 在这里返回 null（chip 永不渲染）。
  const realShape = renderChipRow({
    turn: turnLocationOf(7),
    turnOrder: [5, 6, 7],
    chips: { getSnapshot: () => ({ tasks: [chipTask('t-1', 'running')] }), subscribe: () => () => {} },
  }).tree
  assert.equal(realShape.type, 'div')
  assert.equal(realShape.props.className, 'orch-chips')
  assert.equal(realShape.props['data-orch-chip-row'], 'true')
  // 历史兼容：裸数字入参（**非真实形状**，真实宿主传的是上面的 TurnLocation 对象）。
  assert.equal(renderChipRow({
    turn: 7,
    chips: { getSnapshot: () => ({ tasks: [chipTask('t-1', 'running')] }), subscribe: () => () => {} },
  }).tree.props.className, 'orch-chips')

  // 有关联：2 个 chip + 「+2」，结构与宿主动作行的 chip 语言一致。
  const now = Date.now()
  const snapshot = {
    tasks: [
      chipTask('t-run', 'running', { title: '修发版 0.17.1', lastEventAt: now - 100, updatedAt: now - 100 }),
      chipTask('t-dep', 'waiting_dep', { title: '回复底部 chip', lastEventAt: now - 200, updatedAt: now - 200 }),
      chipTask('t-wait', 'waiting_user', { title: '等你确认', lastEventAt: now - 300, updatedAt: now - 300 }),
      chipTask('t-done', 'done', { title: '刚跑完', lastEventAt: now - 400, updatedAt: now - 400 }),
    ],
  }
  const { tree } = renderChipRow({ chips: { getSnapshot: () => snapshot, subscribe: () => () => {} } })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'orch-chips')
  assert.equal(tree.props['data-orch-chip-row'], 'true')
  assert.equal(tree.props['data-orch-chip-total'], '4')
  const buttons = collect(tree, node => node.type === 'button')
  assert.equal(buttons.length, 3, '2 个 chip + 1 个「+N」')
  const [running, waiting, more] = buttons
  assert.equal(running.props['data-task-id'], 't-run')
  assert.equal(running.props['data-state'], 'running')
  assert.equal(running.props.title, '修发版 0.17.1｜进行中')
  assert.equal(running.props['aria-label'], running.props.title)
  assert.equal(waiting.props['data-state'], 'waiting')
  assert.equal(waiting.props.title, '回复底部 chip｜等前置')
  // 运行中的 SVG 挂着旋转 class（虚线静圈只给等前置/待确认）。
  assert.match(collect(running, node => node.type === 'svg')[0].props.className, /orch-taskchip-spin/)
  assert.match(collect(waiting, node => node.type === 'svg')[0].props.className, /orch-taskchip-dashed/)
  // 图标颜色走语义 token（TONE_COLOR），不是硬编码色值。
  const mark = collect(running, node => node.type === 'span' && node.props.className === 'orch-taskchip-mark')[0]
  assert.equal(mark.props.style.color, 'var(--dsw-alias-state-business-primary, #4d6bfe)')
  const titleSpan = collect(running, node => node.type === 'span' && node.props.className === 'orch-taskchip-title')[0]
  assert.equal(flattenText(titleSpan), '修发版 0.17.1')
  // 「+N」说明还有几个任务。
  assert.equal(flattenText(more), '+2')
  assert.equal(more.props['aria-label'], '还有 2 个关联任务')
})

test('chip 交互：点击打开面板并定位到该任务（一次性 focus 请求），不点就不吞', () => {
  const now = Date.now()
  const snapshot = { tasks: [chipTask('t-run', 'running', { title: '跑测试', lastEventAt: now, updatedAt: now })] }
  const env = renderChipRow({ chips: { getSnapshot: () => snapshot, subscribe: () => () => {} } })
  const buttons = collect(env.tree, node => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(typeof buttons[0].props.onClick, 'function')
  buttons[0].props.onClick()
  assert.deepEqual(env.selected, ['orchestrator'], '点击 chip 先切到任务面板')
  // 面板拿到的是同一份 focus 请求：取走即清空（第二次 take 为 null，用户自己再开面板不会弹旧抽屉）。
  const focus = env.panel.spec.inject().focus
  assert.equal(focus.take(), 't-run')
  assert.equal(focus.take(), null)
  // 「+N」也能打开面板（第二个 chip 行带 rest 的情况）。
  const many = renderChipRow({
    chips: {
      getSnapshot: () => ({ tasks: [
        chipTask('t-1', 'running', { lastEventAt: now, updatedAt: now }),
        chipTask('t-2', 'running', { lastEventAt: now - 1, updatedAt: now - 1 }),
        chipTask('t-3', 'running', { lastEventAt: now - 2, updatedAt: now - 2 }),
      ] }),
      subscribe: () => () => {},
    },
  })
  const more = collect(many.tree, node => node.type === 'button').at(-1)
  assert.equal(flattenText(more), '+1')
  more.props.onClick()
  assert.deepEqual(many.selected, ['orchestrator'])
})

test('chip 订阅时序：只有「主会话 + 最新一轮」才订阅共享 feed，退订即停', () => {
  const snapshot = { tasks: [chipTask('t-1', 'running')] }
  // 非最新轮次：effect 跑了也不订阅（没有 chip 的会话一个轮询都没有）。
  const history = renderChipRow({
    turnOrder: [5, 6, 7, 8],
    chips: { getSnapshot: () => snapshot, subscribe: () => { throw new Error('不该订阅') } },
  })
  for (const effect of history.hooks.effects) effect()
  assert.equal(history.counts.subscribe, 0)

  // 子会话同样不订阅。
  const child = renderChipRow({
    useMainView: selector => selector(false),
    chips: { getSnapshot: () => snapshot, subscribe: () => { throw new Error('不该订阅') } },
  })
  for (const effect of child.hooks.effects) effect()
  assert.equal(child.counts.subscribe, 0)

  // 最新一轮 + 主会话：订阅一次；组件卸载（effect cleanup）退订一次。
  const live = renderChipRow({ chips: { getSnapshot: () => snapshot, subscribe: () => () => {} } })
  const cleanups = []
  for (const effect of live.hooks.effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  assert.equal(live.counts.subscribe, 1, '挂载时订阅共享 feed')
  for (const cleanup of cleanups) cleanup()
  assert.equal(live.counts.unsubscribe, 1, '卸载时退订，feed 停表')
})

test('chip feed：没订阅者不建表；内容不变复用快照；节奏 3s/15s，失败退避 30s', async () => {
  const { loaded } = load()
  const { createTaskFeed } = loaded.__test
  const makeTimers = () => {
    const list = []
    const setTimer = (run, ms) => { const timer = { run, ms, cleared: false }; list.push(timer); return timer }
    const clearTimer = timer => { timer.cleared = true }
    return { list, setTimer, clearTimer }
  }
  const clock = makeTimers()
  let calls = 0
  let payload = {
    ok: true,
    tasks: [{
      id: 't-1', title: '跑测试', status: 'running', coordinatorSession: 's-main', lastEventAt: 5, updatedAt: 5,
    }],
  }
  let notified = 0
  const feed = createTaskFeed({
    readSnapshot: async () => { calls += 1; return payload },
    now: () => 500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  // 没订阅者：一份快照都不拉、一个定时器都不建。
  assert.equal(feed.getSnapshot(), null)
  assert.equal(clock.list.length, 0)

  const off = feed.subscribe(() => { notified += 1 })
  assert.equal(clock.list.length, 1)
  assert.equal(clock.list[0].ms, 0, '首个订阅者立即拉一次')

  await clock.list[0].run()
  assert.equal(calls, 1)
  assert.equal(notified, 1)
  const first = feed.getSnapshot()
  assert.equal(first.tasks.length, 1)
  assert.equal(first.at, 500)
  assert.equal(clock.list[1].ms, 3000, '有活跃任务 → 3s')

  // 内容没变（新响应但同签名）：不通知、快照身份不变（React 不白重渲染）。
  await clock.list[1].run()
  assert.equal(calls, 2)
  assert.equal(notified, 1)
  assert.equal(feed.getSnapshot(), first)
  assert.equal(clock.list[2].ms, 3000)

  // 全部终态：降到 15s。
  payload = { ok: true, tasks: [{ ...payload.tasks[0], status: 'done', lastEventAt: 6, updatedAt: 6 }] }
  await clock.list[2].run()
  assert.equal(notified, 2)
  assert.equal(clock.list[3].ms, 15000)

  // 退订：最后一个订阅者走了就停表（已排的定时器被清掉，迟到的 run 也不再拉）。
  off()
  assert.equal(clock.list[3].cleared, true)
  const before = calls
  await clock.list[3].run()
  assert.equal(calls, before, '退订后不再请求')

  // 失败：退避 30s，且保留上一份快照（chip 不闪没）。
  const failing = makeTimers()
  const broken = createTaskFeed({
    readSnapshot: async () => { throw new Error('boom') },
    setTimer: failing.setTimer,
    clearTimer: failing.clearTimer,
  })
  const offBroken = broken.subscribe(() => {})
  await failing.list[0].run()
  assert.equal(broken.getSnapshot(), null)
  assert.equal(failing.list[1].ms, 30000, '失败退避 30s')
  offBroken()
})

test('chip feed：终态跨过 30 分钟线时签名变一次（chip 自己消失），活跃任务不因时钟发通知', async () => {
  const { loaded } = load()
  const { createTaskFeed } = loaded.__test
  const makeTimers = () => {
    const list = []
    const setTimer = (run, ms) => { const timer = { run, ms, cleared: false }; list.push(timer); return timer }
    const clearTimer = timer => { timer.cleared = true }
    return { list, setTimer, clearTimer }
  }
  const clock = makeTimers()
  // 可推进的假时钟：一个 done 任务 + 一个 running 任务。
  let at = 1_000_000_000
  let notified = 0
  const payload = {
    ok: true,
    tasks: [
      { id: 't-done', title: '刚跑完', status: 'done', coordinatorSession: 's-main', lastEventAt: at - 1000, updatedAt: at - 1000 },
      { id: 't-run', title: '在跑', status: 'running', coordinatorSession: 's-main', lastEventAt: at - 999_000, updatedAt: at - 999_000 },
    ],
  }
  const feed = createTaskFeed({
    readSnapshot: async () => payload,
    now: () => at,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const off = feed.subscribe(() => { notified += 1 })
  await clock.list[0].run()
  assert.equal(notified, 1)
  const first = feed.getSnapshot()

  // 同一时刻再拉一次：没有变化，不通知、快照身份不变。
  await clock.list[1].run()
  assert.equal(notified, 1)
  assert.equal(feed.getSnapshot(), first)

  // 时钟走过 30 分钟线（done 任务的 lastEventAt 掉出窗口）：签名变化 → 发一次通知。
  at += 31 * 60 * 1000
  await clock.list[2].run()
  assert.equal(notified, 2, '终态过期要通知一次，chip 才能自己消失')
  assert.equal(feed.getSnapshot().at, at)

  // 再过一会儿：活跃任务即使 lastEventAt 很老也不会反复触发（活跃 = 恒在窗口内）。
  at += 60 * 60 * 1000
  await clock.list[3].run()
  assert.equal(notified, 2, '活跃任务不因时钟变化重复通知')
  off()
})

test('chip 只走官方 turnTail 槽位：不注入 DOM、不抢动作行/时钟，样式自带动效降级', () => {
  // 官方槽位 + 项目自己的 id/order：list 槽位按新 id 追加，不覆盖宿主条目。
  assert.match(source, /name: 'conversation\.chat\.turnTail'/)
  assert.match(source, /id: CHIP_ID/)
  assert.match(source, /order: 20/)
  // 没有 DOM 注入/查询，也不往宿主动作行或时钟位置塞节点。
  assert.doesNotMatch(source, /querySelector|insertAdjacentHTML|createPortal/)
  assert.doesNotMatch(source, /conversation\.chat\.assistant-actions/)

  const { STYLE_TEXT } = load().loaded.__test
  assert.match(STYLE_TEXT, /\.orch-chips \{[\s\S]*?display: flex/)
  assert.match(STYLE_TEXT, /\.orch-taskchip-spin \{\s*animation: orch-rotate 1s linear infinite/)
  assert.match(STYLE_TEXT, /\.orch-taskchip-dashed \{ stroke-dasharray: 3 2\.4; \}/)
  assert.match(STYLE_TEXT, /\.orch-taskchip\[data-state='confirming'\] \{\s*opacity: 0\.72;\s*animation: orch-chip-pulse/)
  assert.match(STYLE_TEXT, /\.orch-taskchip-title \{[\s\S]*?text-overflow: ellipsis/)
  // 宿主的 reduced-motion 规则只作用在 .orch-shell 内，chip 在会话流里，必须自带一份。
  assert.match(
    STYLE_TEXT,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.orch-taskchip-spin \{ animation: none; \}[\s\S]*?\.orch-taskchip\[data-state='confirming'\] \{ animation: none; opacity: 0\.6; \}/,
  )
})
