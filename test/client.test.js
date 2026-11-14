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

test('apply 不再注册侧栏底部入口；保留主面板与会话头按钮', () => {
  const { loaded, ctx, registrations } = load()
  loaded.apply(ctx)
  const names = registrations.map(row => row.spec.name)
  assert.deepEqual(names, ['main', 'conversation.header.leading'])
  assert.equal(names.includes('sidebar.footer.action'), false)
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
