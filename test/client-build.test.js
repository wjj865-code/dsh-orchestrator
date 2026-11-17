import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// P7 构建契约：只断言「vite 产出的 dist/client.js 符合平台契约」。
// T7.1 立契约（空壳产物）；T7.2 搬完源码后同一批断言继续成立，另加「产物里真有 UI」与
// 「apply 注册 4 个槽位」「__test 出口保留」三条，防止搬完只留下空壳。
// UI 行为的不变量仍由 test/client.test.js 覆盖（T7.3 才拆成 client-source.test.js）。
const root = new URL('../', import.meta.url)
const distPath = new URL('../dist/client.js', import.meta.url)
const mapPath = new URL('../dist/client.js.map', import.meta.url)
const entryPath = new URL('../client/src/index.js', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const artifact = readFileSync(distPath, 'utf8')

// 与 test/client.test.js 同款的 loader 垫片：只够让产物在 vm 里注册一次 factory。
const loadArtifact = () => {
  const loadedIds = []
  let loaded
  const requireFn = () => ({
    createElement: () => ({}),
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useCallback: fn => fn,
    useEffect: () => {},
  })
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => { loadedIds.push(id); loaded = { id, ...factory(requireFn) } },
      },
    },
  }
  vm.runInNewContext(artifact, sandbox)
  return { loadedIds, loaded }
}

test('构建脚本：vite 是 pin 住的 devDependency，build/pretest/check:client 都指向产物', () => {
  assert.match(pkg.devDependencies?.vite ?? '', /^\d+\.\d+\.\d+$/, 'vite 必须 pin 精确版本（不用 ^ / ~），避免产物漂移')
  assert.equal(pkg.scripts.build, 'vite build --config vite.client.config.mjs')
  assert.equal(pkg.scripts.pretest, 'pnpm run build', 'pnpm test 前必须自动构建（否则契约测试读的是旧产物）')
  assert.equal(pkg.scripts['check:client'], 'node --check dist/client.js')
})

test('包管理器：固定 pnpm 版本，提交 pnpm 锁文件且不再有 package-lock.json', () => {
  // 迁移 npm → pnpm 的契约：packageManager 是唯一真源（corepack / pnpm/action-setup 都读它），
  // 必须 pin 精确版本，否则不同机器装出不同依赖树。
  assert.match(pkg.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/, 'packageManager 必须是 pnpm@<精确版本>')
  assert.ok(existsSync(new URL('../pnpm-lock.yaml', import.meta.url)), 'pnpm-lock.yaml 必须入库（CI 用 --frozen-lockfile）')
  assert.ok(!existsSync(new URL('../package-lock.json', import.meta.url)), 'package-lock.json 已废弃，不要再提交')
})

test('产物落盘：dist/client.js 与 dist/client.js.map 都存在且非空', () => {
  assert.ok(existsSync(distPath), 'dist/client.js 不存在：先跑 pnpm run build')
  assert.ok(existsSync(mapPath), 'dist/client.js.map 不存在：sourcemap 必须成对产出')
  assert.ok(statSync(distPath).size > 0)
  assert.ok(statSync(mapPath).size > 0)
  assert.match(artifact, /\/\/# sourceMappingURL=client\.js\.map\s*$/, '产物末尾应指向同名 sourcemap')
})

test('产物是 classic script：顶层没有 import/export（平台用 <script> 直接加载）', () => {
  assert.doesNotMatch(artifact, /^\s*(?:import|export)\s/m)
  // vm.runInNewContext 按 script 解析；产物若有顶层 import/export 会在这里直接抛 SyntaxError。
  assert.doesNotThrow(() => new vm.Script(artifact))
})

test('产物语法：node --check 通过', () => {
  execFileSync(process.execPath, ['--check', fileURLToPath(distPath)], { stdio: 'pipe' })
})

test('产物注册 factory：__ModuleLoader__.load 恰好一次，id 等于 package.json 的 name', () => {
  assert.match(artifact, /__ModuleLoader__\.load\(/)
  const { loadedIds } = loadArtifact()
  assert.equal(loadedIds.length, 1, '客户端应只调用一次 window.__ModuleLoader__.load')
  assert.equal(loadedIds[0], pkg.name, '模块 id 必须等于包名（平台 client-modules 按包名索引）')
})

test('产物工厂形状：factory 返回 { inject, apply }，inject 覆盖三个客户端服务', () => {
  const { loaded } = loadArtifact()
  assert.ok(Array.isArray(loaded.inject))
  for (const service of ['slots', 'layout', 'uiWorkspace']) {
    assert.ok(loaded.inject.includes(service), `inject 缺 ${service}`)
  }
  assert.equal(typeof loaded.apply, 'function')
  // T7.2 起 apply 会注册真实 UI：给最小 ctx 应能跑完，且四个槽位都注册上。
  const registered = []
  const ctx = {
    slots: {
      inject: (_name, factory) => { factory(); return () => {} },
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
    layout: { selectPanel: () => {} },
    uiWorkspace: { openSession: () => {} },
    get: () => undefined,
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') dispose() },
  }
  assert.doesNotThrow(() => loaded.apply(ctx))
  const slots = registered.map(row => row.spec.name)
  assert.deepEqual(slots, [
    'main', 'main', 'sidebar.panellist', 'conversation.header.leading', 'conversation.chat.turnTail',
  ])
  assert.deepEqual(registered.filter(row => row.spec.name === 'main').map(row => row.spec.key).sort(),
    ['orchestrator', 'orchestrator-launcher'])
})

test('产物不是空壳：UI、样式表与 __test 出口都真的打进了 dist/client.js', () => {
  // 空壳产物 341 B；搬完源码后接近 100 KB。这条阈值只是「别把 UI 弄丢」的粗护栏。
  assert.ok(statSync(distPath).size > 50_000, `产物只有 ${statSync(distPath).size} B，像是空壳`)
  for (const marker of ['orch-shell', 'orch-drawer', 'orch-skeleton', 'createMainViewGate', 'open-main']) {
    assert.ok(artifact.includes(marker), `产物缺少 UI 标记 ${marker}`)
  }
  // CSS 走 ?inline 内联：构建后整张表以字符串形式出现在产物里。
  assert.ok(artifact.includes('.orch-shell {'), '样式表未内联进产物（?inline 失效？）')
  assert.ok(artifact.includes('@keyframes orch-shimmer'))
  // __test 出口保留（T7.2 验收点：单测经它验纯逻辑与闸门）。
  const { loaded } = loadArtifact()
  assert.deepEqual(Object.keys(loaded.__test).sort(), [
    'STYLE_TEXT', 'TONE_COLOR', 'artifactDate', 'artifactProject', 'chipOpenTargetOf', 'chipStateOf',
    'chipTooltipOf', 'chipViewOf', 'chipVisibleTitle', 'countTasks', 'createFocusRequest',
    'createMainViewGate', 'createTaskFeed', 'fileAddressOf', 'fileAddressProblem', 'groupArtifacts',
    'isLatestTurn', 'matchesFilter', 'matchesQuery', 'selectTaskChips',
  ])
})

test('源码守约束 1：client/src/** 不出现打包 react 的写法（React 只能 req("react")）', () => {
  const files = readdirSync(new URL('../client/src/', import.meta.url), { recursive: true })
    .filter(file => String(file).endsWith('.js'))
  assert.ok(files.length > 0, 'client/src/** 里应有 ESM 源码')
  // T7.2 的模块边界：入口 / 装配 / 视图 / 展示件 / 样式 / 纯逻辑 / API / 闸门 / 常量。
  for (const expected of [
    'index.js', 'client.js', 'views.js', 'ui.js', 'styles.js', 'styles.css',
    'logic.js', 'api.js', 'gate.js', 'constants.js',
  ]) {
    assert.ok(existsSync(new URL(`../client/src/${expected}`, import.meta.url)), `缺少源码文件 client/src/${expected}`)
  }
  for (const file of files) {
    const text = readFileSync(new URL(`../client/src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /from\s*['"]react['"]/, `${file} 不得 import react（会导致双 React）`)
    assert.doesNotMatch(text, /require\(\s*['"]react['"]\s*\)/, `${file} 不得直接 require react（只能从 factory 的 req 参数拿）`)
  }
  // 入口只负责注册 factory：UI 装配在 client.js，产物才是摊平后的 classic script。
  const entry = readFileSync(entryPath, 'utf8')
  assert.match(entry, /window\.__ModuleLoader__\.load\(/)
  assert.match(entry, /import \{ createClient \} from '\.\/client\.js'/)
  assert.match(entry, /factory: req => createClient\(req\)/)
})

test('生效路径不悬空：exports["./client"] 指向的文件必须真实存在于仓库', () => {
  const entry = pkg.exports['./client']
  assert.equal(typeof entry, 'string')
  const relative = entry.replace(/^\.\//, '')
  assert.ok(existsSync(new URL(relative, root)), `package.json exports["./client"] = ${entry}，但该文件不存在`)
  // 产物必须随包发布（产物入库的意义就在这里）：条目切到 dist 后 files 必须包含它。
  if (relative.startsWith('dist/')) {
    assert.ok(pkg.files.includes('dist/'), 'exports 指向 dist 后，files 必须包含 "dist/"')
  }
})
