import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { buildOps, isDirty, CONFIG_ENTRY_ID, CONFIG_SLOT_KEY } from '../client/src/config-logic.js'
import { CONFIG_FIELDS, EDITABLE_KEYS, FIELD_BY_KEY } from '../src/config-fields.js'
import { loadConfig } from '../src/config.js'

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

/** 递归展开元素树成原生节点（函数组件就地调用，方便断言控件属性）。 */
const expandTree = node => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expandTree)
  if (!('type' in node)) return node
  if (typeof node.type === 'function') {
    return expandTree(node.type({ ...(node.props ?? {}), children: node.children }))
  }
  return { ...node, children: (node.children ?? []).map(expandTree) }
}

/** 递归收集展开后的原生节点。 */
const collectNodes = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out)
    return out
  }
  if (!('type' in node)) return out
  out.push(node)
  collectNodes(node.children ?? [], out)
  return out
}

// ── 保存契约：只发改过的可编辑字段 ────────────────────────────────

test('buildOps：只发改过的可编辑字段；清空已覆盖字段发 unset；只读与字段表外的键永不写入', () => {
  const saved = { maxQueue: 50, autoResumeQueue: false, digestAt: '09:30', contextPressureThreshold: 0.4, coordinatorSession: '' }
  const overridden = new Set(['digestAt'])

  // 无改动 → 无操作
  assert.deepEqual(buildOps(saved, saved, overridden), [])

  // 改两个可编辑字段 + 清空一个已覆盖字段 + 改压力提醒阈值（可编辑，必须发出去）；
  // coordinatorSession 是只读（运维兜底通道，手改 YAML），草稿里变了也不下发。
  const draft = {
    maxQueue: 60, autoResumeQueue: true, digestAt: '', contextPressureThreshold: 0.6, coordinatorSession: 's-manual',
    // 字段表里没有的键（已删键的残留）不得写回 profile。
    mergeWindowMs: 9000,
  }
  // 顺序按字段表声明（maxQueue 在 autoResumeQueue 之前、contextPressureThreshold 在末尾），不是按草稿对象顺序。
  assert.deepEqual(buildOps(draft, saved, overridden), [
    { op: 'set', path: ['maxQueue'], value: 60 },
    { op: 'set', path: ['autoResumeQueue'], value: true },
    { op: 'unset', path: ['digestAt'] },
    { op: 'set', path: ['contextPressureThreshold'], value: 0.6 },
  ])
})

test('isDirty：可编辑字段（含压力提醒阈值）变化算未保存改动；只读与字段表外的键不算', () => {
  const saved = { maxQueue: 50, contextPressureThreshold: 0.4, coordinatorSession: '' }
  assert.equal(isDirty({ maxQueue: 60, contextPressureThreshold: 0.4 }, saved), true)
  // 提醒阈值可编辑 → 改了就要点亮「保存」。
  assert.equal(isDirty({ maxQueue: 50, contextPressureThreshold: 0.9 }, saved), true)
  // 只读字段变化不点亮保存按钮（改了也写不进去，别让用户白点一次）。
  assert.equal(isDirty({ maxQueue: 50, contextPressureThreshold: 0.4, coordinatorSession: 's-manual' }, saved), false)
  // 字段表外的键（已删键残留）不算；已下线的轮换键也不再点亮保存。
  assert.equal(isDirty({ maxQueue: 50, contextPressureThreshold: 0.4, mergeWindowMs: 9000 }, saved), false)
  assert.equal(isDirty({ maxQueue: 50, contextPressureThreshold: 0.4, mainRotation: 'off' }, saved), false)
})

test('保存路径：提醒阈值 buildOps 发 set、写回后 loadConfig 读到新值；coordinatorSession 不下发', () => {
  const contextFields = CONFIG_FIELDS.filter(field => field.group === 'context').map(field => field.key)
  assert.deepEqual(contextFields, ['contextPressureThreshold', 'coordinatorSession'])
  assert.ok(EDITABLE_KEYS.includes('contextPressureThreshold'), '提醒阈值必须可编辑')
  assert.equal(EDITABLE_KEYS.includes('coordinatorSession'), false, 'coordinatorSession 只读，不得下发')

  // 卡片上把阈值改掉；coordinatorSession 即使草稿变了也不该进 ops。
  const saved = { coordinatorSession: '', contextPressureThreshold: 0.4 }
  const draft = { coordinatorSession: 's-manual', contextPressureThreshold: 0.75 }
  const ops = buildOps(draft, saved, new Set())
  assert.deepEqual(ops, [{ op: 'set', path: ['contextPressureThreshold'], value: 0.75 }])

  // 保存 = 宿主把 ops 写进 profile 配置 → 插件重载 → loadConfig 归一化。这里用同一份输入验「真读到新值」。
  const persisted = { ...saved }
  for (const op of ops) persisted[op.path[0]] = op.value
  const config = loadConfig(persisted)
  assert.equal(config.contextPressureThreshold, 0.75)
  // 只读键没被卡片写进去：仍然是空的（= 读台账指针）。
  assert.equal(config.coordinatorSession, undefined)
})

// ── 保存回执口径：保存只写 profile，需重载插件 / 重启 DSH 后生效 ──

/**
 * 跑一次真实交互：改一个可编辑字段 → 点「保存」→ 再渲染，返回最终卡片文本。
 * 渲染垫片不会自动重渲染（宿主才订阅），所以每次重新调用组件前把 hook 游标归零。
 */
const saveThenRender = async snapshot => {
  const { reg, hooks } = renderCard(snapshot)
  const render = () => { hooks.cursor = 0; return reg.c({ view: 'page' }) }
  const input = collectNodes(expandTree(render()))
    .find(node => node.type === 'input' && node.props?.['aria-label'] === '队列安全阀')
  assert.ok(input !== undefined, '可写态应渲染「队列安全阀」输入框')
  input.props.onChange({ target: { value: '60' } })
  const save = collectNodes(expandTree(render()))
    .find(node => node.type === 'button' && textOf(node) === '保存')
  assert.ok(save !== undefined, '可写态应有「保存」按钮')
  await save.props.onClick()
  return textOf(render())
}

test('保存回执：写明「重载插件或重启 DSH 后生效」，不再承诺保存后立刻生效', async () => {
  // 0.23.0 冒烟 §6.1：保存只落 profile，运行中的插件不重新 apply。回执若写「已生效」，用户会以为轮换已经关掉。
  const text = await saveThenRender({
    status: 'ready', value: { maxQueue: 50 }, user: {}, revision: 1, writable: true,
  })
  assert.match(text, /已保存到当前 profile 的 cordis\.patch\.yml/, '回执要写明保存位置')
  assert.match(text, /需重载插件或重启 DSH 后生效/, '回执要写明需重载/重启后生效')
  assert.doesNotMatch(text, /即时生效/, '回执不得再承诺保存后立刻生效（实测运行中的插件不重载）')
  // 简介（静置在卡片顶部）与回执同口径：没点保存前就能读到「不热重载」。
  const intro = textOf(renderCard({
    status: 'ready', value: { maxQueue: 50 }, user: {}, revision: 1, writable: true,
  }).reg.c({ view: 'page' }))
  assert.match(intro, /运行中的插件不热重载，需重载插件或重启 DSH 后生效/)
})

test('配置保存口径同源：回执 / README / ARCHITECTURE / LIMITATIONS / CHANGELOG 一致', () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md', 'CHANGELOG.md']) {
    assert.match(read(file), /重载插件或重启 DSH 后生效/, `${file} 没写「重载插件或重启 DSH 后生效」`)
    assert.doesNotMatch(read(file), /即时生效/, `${file} 仍写着「即时生效」`)
  }
  // README 的「生效方式」一行必须直说，不能只在别处提一句。
  assert.match(read('README.md'), /^\| 生效方式 \|.*重载插件或重启 DSH 后生效/m)
  // 产物里也带同一句（dist 是用户实际拿到的东西，源码改了没构建等于没改）。
  assert.match(artifact, /需重载插件或重启 DSH 后生效/)
  assert.doesNotMatch(artifact, /即时生效/)
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

test('可写态渲染：22 行都在，压力提醒阈值可编辑、coordinatorSession 单行只读（带「只读」标记且控件禁用）', () => {
  const snapshot = {
    status: 'ready',
    value: { coordinatorSession: '', contextPressureThreshold: 0.4 },
    user: {},
    revision: 1,
    writable: true,
  }
  const tree = expandTree(renderCard(snapshot).reg.c({ view: 'page' }))
  const nodes = collectNodes(tree)
  const rows = nodes.filter(node => node.props?.className === 'orch-cfg-row')
  assert.equal(rows.length, CONFIG_FIELDS.length, '每个字段都应渲染一行（主会话分组默认展开）')

  const contextFields = CONFIG_FIELDS.filter(field => field.group === 'context')
  assert.equal(contextFields.length, 2)
  // 控件按 aria-label = 字段 label 定位（数值/字符串是 input，枚举是 select，布尔是 button[role=switch]）。
  const controlOf = field => nodes.find(node => node.props?.['aria-label'] === field.label
    && (node.type === 'input' || node.type === 'select' || node.type === 'button'))

  const threshold = FIELD_BY_KEY.contextPressureThreshold
  assert.equal(threshold.readonly, undefined, '提醒阈值不该只读')
  const thresholdControl = controlOf(threshold)
  assert.ok(thresholdControl !== undefined, '提醒阈值应有输入控件')
  assert.notEqual(thresholdControl.props.disabled, true, '提醒阈值在可写态不该禁用')

  const override = FIELD_BY_KEY.coordinatorSession
  const overrideControl = controlOf(override)
  assert.ok(overrideControl !== undefined, 'coordinatorSession 应仍渲染一行（只读展示生效值）')
  assert.equal(overrideControl.props.disabled, true, 'coordinatorSession 的控件必须是禁用态（不能手滑改）')
  const overrideRow = rows.find(row => collectNodes(row)
    .some(node => node.props?.['aria-label'] === override.label))
  assert.ok(overrideRow !== undefined, 'coordinatorSession 应仍渲染一行')
  assert.ok(collectNodes(overrideRow).some(node => typeof node.props?.className === 'string'
    && node.props.className.includes('orch-cfg-tag--readonly')), 'coordinatorSession 那一行应有「只读」标记')

  // 「只读」标记只挂在 coordinatorSession 那一行（分组标题不带「只读」）。
  const readonlyTaggedRows = rows.filter(row => collectNodes(row)
    .some(node => typeof node.props?.className === 'string' && node.props.className.includes('orch-cfg-tag--readonly')))
  assert.equal(readonlyTaggedRows.length, 1, '整张卡片只有 coordinatorSession 一行带「只读」标记')
  // 分组标题沿用「主会话」，且 help 里点明与宿主 compaction-basic 的阈值无关。
  assert.match(textOf(tree), /主会话/)
  assert.match(textOf(tree), /compaction-basic/)
})
