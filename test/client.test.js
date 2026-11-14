import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const load = () => {
  const registrations = []
  const selected = []
  const opened = []
  const loadedIds = []
  let loaded
  const ctx = {
    slots: {
      inject: (_name, factory) => { factory(); return () => {} },
      register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
    },
    layout: { selectPanel: id => selected.push(id) },
    uiWorkspace: { openSession: id => opened.push(id) },
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
  vm.runInNewContext(source, sandbox)
  return { loaded, ctx, registrations, selected, opened, loadedIds }
}

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
