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
        load: ({ id, factory }) => { loaded = { id, ...factory(requireFn) } },
      },
    },
  }
  vm.runInNewContext(source, sandbox)
  return { loaded, ctx, registrations, selected, opened }
}

test('经典脚本：能被 <script> 解析，无顶层 import/export，id 等于包名', () => {
  assert.doesNotMatch(source, /^\s*(import|export)\s/m)
  const { loaded } = load()
  assert.equal(loaded.id, 'dsh-orchestrator')
  assert.equal(typeof loaded.apply, 'function')
  assert.ok(Array.isArray(loaded.inject))
  for (const service of ['slots', 'layout', 'uiWorkspace']) {
    assert.ok(loaded.inject.includes(service), service)
  }
})

test('apply 注册三个槽位：侧栏底部入口、主面板、会话头按钮', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const names = registrations.map(row => row.spec.name)
  assert.deepEqual(names, ['sidebar.footer.action', 'main', 'conversation.header.leading'])
  assert.equal(names.includes('sidebar.panellist'), false)
})

test('槽位选项：入口有 id/order，主面板带 key，leading 单席位不带 id', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const entry = registrations.find(row => row.spec.name === 'sidebar.footer.action').spec
  assert.equal(entry.id, 'orchestrator')
  assert.equal(entry.order, 100)
  const panel = registrations.find(row => row.spec.name === 'main').spec
  assert.equal(panel.key, 'orchestrator')
  const leading = registrations.find(row => row.spec.name === 'conversation.header.leading').spec
  assert.equal('id' in leading, false)
  assert.equal('locale' in leading, false)
})

test('按钮与面板的 inject 回调调用正确的客户端 API', () => {
  const { loaded, ctx, registrations, selected, opened } = load()
  loaded.apply(ctx)
  const entry = registrations.find(row => row.spec.name === 'sidebar.footer.action').spec
  const leading = registrations.find(row => row.spec.name === 'conversation.header.leading').spec
  const panel = registrations.find(row => row.spec.name === 'main').spec
  entry.inject().openPanel()
  leading.inject().openPanel()
  panel.inject().openSession('c-1')
  assert.deepEqual(selected, ['orchestrator', 'orchestrator'])
  assert.deepEqual(opened, ['c-1'])
})

test('侧栏入口：wide 展开显示图标+文字，折叠只图标，带 aria-label/title', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const row = registrations.find(item => item.spec.name === 'sidebar.footer.action')
  const wide = row.component({ openPanel: () => {}, wide: true })
  assert.equal(wide.type, 'button')
  assert.equal(wide.props['aria-label'], '任务')
  assert.equal(wide.props.title, '任务面板')
  assert.ok(wide.children.some(child => child && child.type === 'span' && child.children[0] === '任务'))

  const narrow = row.component({ openPanel: () => {}, wide: false })
  assert.equal(narrow.children.some(child => child && child.type === 'span' && child.children[0] === '任务'), false)
})

test('面板提供「打开主会话」并调用 open-main', () => {
  assert.match(source, /打开主会话/)
  assert.match(source, /open-main/)
  assert.match(source, /snapshot\.mainSession/)
  assert.doesNotMatch(source, /snapshot\.coordinator/)
  assert.match(source, /task\.targetDir/)
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
  assert.doesNotMatch(source, /setError\(/)
})

test('入口/头部按钮的文案仍是任务', () => {
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
