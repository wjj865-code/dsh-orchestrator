import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
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
  const requireFn = () => ({
    createElement: (type, props, ...children) => ({ type, props, children }),
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
  vm.runInNewContext(source, sandbox)
  return { loaded, ctx, registrations, selected, opened, loadedIds, cleanups, sessionListeners }
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
  assert.doesNotMatch(source, /^\s*(import|export)\s/m)
  const { loaded } = load()
  assert.equal(loaded.id, pkg.name)
  assert.equal(typeof loaded.apply, 'function')
  assert.ok(Array.isArray(loaded.inject))
  for (const service of ['slots', 'layout', 'uiWorkspace']) {
    assert.ok(loaded.inject.includes(service), service)
  }
})

test('apply 不再注册侧栏底部入口；注册任务面板、启动器面板与侧栏入口', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const names = registrations.map(row => row.spec.name)
  assert.deepEqual(names, ['main', 'main', 'sidebar.panellist', 'conversation.header.leading'])
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
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
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
  // 交互：预览（独立 preview 端点）、复制路径、打开子会话。
  assert.match(source, /const readPreview = async/)
  assert.match(source, /endpoint: 'preview'/)
  assert.match(source, /togglePreview/)
  assert.match(source, /收起预览/)
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

// U1：任务入口（会话头「☰ 任务」）只在主会话显示；侧栏「◈ 主会话」跳转入口始终可见。
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

test('任务入口渲染：主会话显示「☰ 任务」，切子会话/信号失败隐藏；侧栏「主会话」入口始终注册', async () => {
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
  assert.equal(shown.children[0], '\u2630 任务')
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

test('任务入口闸门源码：session-role 端点 + uiSession/sessions 信号 + 默认隐藏', () => {
  assert.match(source, /endpoint: 'session-role'/)
  assert.match(source, /adapter\?\.current\?\.getSnapshot/)
  assert.match(source, /retainedBy\?\.mainView/)
  assert.match(source, /createMainViewGate/)
  assert.match(source, /hooks: \{ mainView \}/)
  assert.match(source, /useMainView/)
  assert.match(source, /if \(visible !== true\) return null/)
})
