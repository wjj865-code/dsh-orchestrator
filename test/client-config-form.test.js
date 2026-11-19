import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { buildOps, isDirty, CONFIG_ENTRY_ID, CONFIG_SLOT_KEY } from '../client/src/config-logic.js'

// 客户端配置卡片：只守「保存什么」与「注册在哪」两个对外契约 + 一次四态渲染冒烟。
// 纯函数直接 import（config-logic.js 不含 JSX）；渲染断言跑构建产物 dist/client.js。

const artifact = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')

/** 最小 React 垫片 + 可控 ConfigForm，跑产物里的卡片组件。 */
const renderCard = snapshot => {
  const registrations = []
  const hooks = { cursor: 0, slots: [] }
  const requireFn = () => ({
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const i = hooks.cursor++
      if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? initial() : initial
      return [hooks.slots[i], v => { hooks.slots[i] = typeof v === 'function' ? v(hooks.slots[i]) : v }]
    },
    useRef: initial => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = { current: initial }; return hooks.slots[i] },
    useMemo: fn => { hooks.cursor++; return fn() },
    useCallback: fn => { hooks.cursor++; return fn },
    useEffect: () => { hooks.cursor++ },
  })
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const ctx = {
    slots: { inject: (_n, f) => { f(); return () => {} }, register: (s, c) => { registrations.push({ s, c }); return () => {} } },
    layout: { selectPanel: () => {} }, uiWorkspace: { openSession: () => {} },
    get: n => n === 'configForms' ? { get: () => form, whileServed: (_ns, r) => { r(new Set([CONFIG_ENTRY_ID])); return () => {} } } : undefined,
    effect: cb => { cb(); return () => {} },
    inject: (_d, cb) => { cb(ctx) },
  }
  let api
  vm.runInNewContext(artifact, { AbortController, window: { __ModuleLoader__: { load: ({ factory }) => { api = factory(requireFn) } } } })
  api.apply(ctx)
  hooks.cursor = 0
  const reg = registrations.find(r => r.s.name === 'plugins.bundle.config')
  return { reg, hooks }
}

/** 递归展开元素树成文本（函数组件要调用，原生标签取 children）。 */
const textOf = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || !('type' in node)) return ''
  const { type, props, children } = node
  return typeof type === 'function' ? textOf(type({ ...(props ?? {}), children })) : textOf(children ?? [])
}

// ── 保存契约：只发改过的可编辑字段 ────────────────────────────────

test('buildOps：只发改过的可编辑字段；清空已覆盖字段发 unset；只读字段永不写入', () => {
  const saved = { maxQueue: 50, autoResumeQueue: false, digestAt: '09:30', mainRotation: 'off' }
  const overridden = new Set(['digestAt'])

  // 无改动 → 无操作
  assert.deepEqual(buildOps(saved, saved, overridden), [])

  // 改两个可编辑字段 + 清空一个已覆盖字段 + 改一个只读字段（必须被忽略）
  const draft = { maxQueue: 60, autoResumeQueue: true, digestAt: '', mainRotation: 'auto' }
  // 顺序按字段表声明（maxQueue 在 autoResumeQueue 之前），不是按草稿对象顺序。
  assert.deepEqual(buildOps(draft, saved, overridden), [
    { op: 'set', path: ['maxQueue'], value: 60 },
    { op: 'set', path: ['autoResumeQueue'], value: true },
    { op: 'unset', path: ['digestAt'] },
  ])
})

test('isDirty：只读字段变化不算未保存改动', () => {
  const saved = { maxQueue: 50, rotateAfterDays: 10 }
  assert.equal(isDirty({ maxQueue: 50, rotateAfterDays: 1 }, saved), false, '只读字段不该点亮保存按钮')
  assert.equal(isDirty({ maxQueue: 60, rotateAfterDays: 10 }, saved), true)
})

// ── 注册契约：三个 key 各不相同，写错就静默不渲染 ────────────────

test('注册 key：slot key 用包名、configForms 用 entry id，且 entry id 与 cordis.patch.yml 一致', () => {
  // 反向验证：把 slot key 写成 entry id → 本条立刻红。
  assert.equal(CONFIG_SLOT_KEY, '@wjj865-code/dsh-orchestrator')
  assert.equal(CONFIG_ENTRY_ID, 'orchestrator')
  assert.notEqual(CONFIG_SLOT_KEY, CONFIG_ENTRY_ID, '两个 key 混用会静默不渲染')
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, new RegExp(`id:\\s*${CONFIG_ENTRY_ID}\\b`))

  // 产物里确实注册了这个 slot（跑产物，不读源码猜）。
  const { reg } = renderCard({ status: 'loading', value: undefined, user: undefined, revision: undefined, writable: false })
  assert.ok(reg !== undefined, 'apply 应注册 plugins.bundle.config')
  assert.equal(reg.s.key, CONFIG_SLOT_KEY)
})

// ── 渲染冒烟：四态都不崩，且该有的提示在 ─────────────────────────

test('渲染四态：loading / unavailable / ready 可写 / ready 只读', () => {
  const loading = renderCard({ status: 'loading', value: undefined, user: undefined, revision: undefined, writable: false })
  assert.ok(textOf(loading.reg.c({ view: 'page' })).includes('正在读取配置'))

  const unavailable = renderCard({ status: 'unavailable', value: undefined, user: undefined, revision: undefined, writable: false })
  assert.ok(textOf(unavailable.reg.c({ view: 'page' })).includes('未加载'))

  const ready = renderCard({ status: 'ready', value: { maxQueue: 50 }, user: {}, revision: 1, writable: true })
  const readyText = textOf(ready.reg.c({ view: 'page' }))
  assert.ok(readyText.includes('配置') && readyText.includes('保存'), '可写态应有标题与保存按钮')

  const readonly = renderCard({ status: 'ready', value: { maxQueue: 50 }, user: {}, revision: 1, writable: false })
  const roText = textOf(readonly.reg.c({ view: 'page' }))
  assert.ok(roText.includes('只读') && !roText.includes('放弃改动'), '只读态应标注且无编辑动作')
})
