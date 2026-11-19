import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  Config,
  configSchemaAvailable,
  configSchemaDiagnostics,
  loadSchemastery,
  schemaAnchors,
} from '../src/config-schema.js'

// 宿主侧 schemastery 解析：三条路径各自有独立后果，逐条锁死。
// - 主路径命中：一切照旧（source='plugin'，不试兜底、不告警）。
// - 主路径失败 + 宿主安装目录命中：配置卡片还在（source='host'，记下锚点）。
// - 全失败：Config=undefined，但**必须**有 warn——静默降级正是 2026-11-20 二诊里
//   「插件 active + 没卡片 + 零报错」那个查不动的 bug，不能靠再犯一次来找回。

/** 最小 schemastery 工厂替身：只要 `object()` 能通过 pickFactory 的形状检查即可。 */
const fakeFactory = { object: () => ({}) }

/** 按 spec 决定「返回什么 / 抛什么」的 requireFor 替身；calls 记录每次解析用的 spec。 */
const requireForStub = handler => {
  const calls = []
  const requireFor = spec => name => {
    calls.push({ spec, name })
    return handler(spec, name)
  }
  return { calls, requireFor }
}

test('主路径命中：source=plugin，不试兜底、不告警', () => {
  const warned = []
  const { calls, requireFor } = requireForStub(() => fakeFactory)
  const result = loadSchemastery({
    primary: 'C:/plugin/index.js',
    anchors: ['C:/host/dsh', 'C:/profile'],
    requireFor,
    warn: message => warned.push(message),
  })

  assert.equal(result.source, 'plugin')
  assert.equal(result.z, fakeFactory)
  assert.equal(result.anchor, undefined)
  assert.deepEqual(result.attempts, [])
  assert.deepEqual(warned, [])
  // 主路径命中就别再碰宿主目录：兜底是失败后的补救，不是每次都试。
  assert.deepEqual(calls, [{ spec: 'C:/plugin/index.js', name: '@deepseek-ai/schemastery' }])
})

test('主路径失败 + 宿主目录兜底成功：source=host，记下命中锚点并保留失败证据', () => {
  const warned = []
  const { calls, requireFor } = requireForStub(spec => {
    if (spec === 'C:/plugin/index.js') throw new Error('ERR_MODULE_NOT_FOUND: 插件自身找不到 schemastery')
    if (spec === join('C:/host/dsh', '__host-module-resolve__.cjs')) throw new Error('ERR_MODULE_NOT_FOUND: 这份目录也没有')
    return fakeFactory
  })

  const result = loadSchemastery({
    primary: 'C:/plugin/index.js',
    anchors: ['C:/host/dsh', 'C:/profile'],
    requireFor,
    warn: message => warned.push(message),
  })

  assert.equal(result.source, 'host')
  assert.equal(result.z, fakeFactory)
  assert.equal(result.anchor, 'C:/profile')
  // 目录锚点要补假文件名再交给 createRequire，否则它会把目录当文件解析。
  assert.equal(calls.length, 3)
  assert.equal(calls[2].spec, join('C:/profile', '__host-module-resolve__.cjs'))
  assert.equal(result.attempts.length, 2)
  assert.match(result.attempts[0].reason, /插件自身找不到 schemastery/)
  assert.match(result.attempts[1].reason, /这份目录也没有/)
  // 兜底成功 = 卡片还在，不该吓用户。
  assert.deepEqual(warned, [])
})

test('全失败：Config 降级为 undefined 语义 + 只告警一次且信息够排查', () => {
  const warned = []
  const { requireFor } = requireForStub(() => {
    throw new Error('ERR_MODULE_NOT_FOUND: Cannot find package')
  })
  const result = loadSchemastery({
    primary: 'C:/plugin/index.js',
    anchors: ['C:/host/dsh', 'C:/profile'],
    requireFor,
    warn: message => warned.push(message),
  })

  assert.equal(result.z, undefined)
  assert.equal(result.source, 'unavailable')
  assert.equal(result.anchor, undefined)
  assert.equal(result.attempts.length, 3, '主路径 + 两个兜底锚点各记一条失败证据')

  // 告警必须恰好一次（模块加载期只解析一次，重复告警只会刷屏）。
  assert.equal(warned.length, 1)
  const message = warned[0]
  assert.match(message, /^\[dsh-orchestrator\]/)
  assert.match(message, /配置卡片将不显示/) // 用户能看到的后果
  assert.match(message, /插件照常工作/) // 别让人以为插件坏了
  assert.match(message, /@deepseek-ai\/schemastery/) // 缺的是哪个包
  assert.match(message, /已尝试 3 个位置/) // 试过几个位置
  assert.match(message, /插件自身/) // 试过哪些位置
  assert.match(message, /C:\/host\/dsh/) // 包含兜底锚点
  assert.match(message, /ERR_MODULE_NOT_FOUND/) // 首个错误原因
})

test('坏包形状按失败处理：没有 object() 工厂不算命中，default 互操作算命中', () => {
  const warned = []
  // 包能加载但导出形状不对 → 不能当成功（否则后面 z.object() 直接 TypeError）。
  const broken = loadSchemastery({
    primary: 'C:/plugin/index.js',
    anchors: [],
    requireFor: requireForStub(() => ({ default: { object: 1 } })).requireFor,
    warn: message => warned.push(message),
  })
  assert.equal(broken.z, undefined)
  assert.equal(broken.source, 'unavailable')
  assert.match(warned[0], /取不到 schemastery 工厂/)

  // ESM 互操作：工厂挂在 default 上（require 拿到的 module.exports 形状）→ 命中。
  const interop = loadSchemastery({
    primary: 'C:/plugin/index.js',
    anchors: [],
    requireFor: requireForStub(() => ({ default: fakeFactory })).requireFor,
    warn: () => assert.fail('互操作命中时不该告警'),
  })
  assert.equal(interop.z, fakeFactory)
  assert.equal(interop.source, 'plugin')
})

test('schemaAnchors：只留真实存在候选、按来源保序、去重（DSH_* / argv / Electron 布局）', () => {
  // 夹具路径一律用 `join` 造：源码里 Electron 布局是 `join(dirname(execPath), 'resources', …)` 推出来的，
  // 硬写 `C:\\…\\app.asar\\dsh` 这种反斜杠字面量在 POSIX（Linux CI）上会被 `dirname` 当成没有分隔符的名字，
  // 派生结果变成 `resources/app.asar/dsh`，断言就随平台漂移（2026-11-20 CI 首跑 1 fail 即此）。
  const base = join(process.cwd(), 'schema-anchors-fixture')
  const profile = join(base, 'profile')
  const appDir = join(base, 'app')
  const hostDsh = join(appDir, 'dsh')
  const exe = join(appDir, 'DeepSeek Harness.exe')
  const resources = join(appDir, 'resources')
  const asarDsh = join(resources, 'app.asar', 'dsh')
  const existing = new Set([profile, hostDsh, resources, asarDsh])
  const anchors = schemaAnchors({
    env: {
      DSH_PROFILE_DIR: profile,
      DSH_HOME: profile, // 与上面重复 → 只能出现一次
      DSH_INSTALL_DIR: join(base, 'missing-install'),
      DSH_NODE_EXECUTABLE: '',
    },
    argv: [hostDsh, '--flag', 'value'],
    execPath: exe,
    resourcesPath: resources,
    exists: path => existing.has(path),
  })

  assert.deepEqual(anchors, [
    profile, // env（去重后一份）
    hostDsh, // argv 里的 dsh 目录
    resources, // resourcesPath
    asarDsh, // Electron 打包布局
  ])
  // 不存在的候选（missing / 空值 / 无斜杠参数）不进告警列表。
  assert.ok(!anchors.some(anchor => anchor.includes('missing')))
  // argv 不是数组也不能炸（测试/嵌入环境里 argv 可能被裁）。
  assert.doesNotThrow(() => schemaAnchors({ argv: undefined, env: {}, exists: () => false }))
})

test('本环境正常安装：Config 非空，诊断快照与运行时一致且冻结', () => {
  // devDependencies 里有 schemastery，正常 pnpm install 的检出目录必须走到主路径。
  assert.equal(configSchemaAvailable, true, '正常安装环境下 Config 不该为空')
  assert.equal(Config !== undefined, true)
  assert.equal(configSchemaDiagnostics.available, true)
  assert.equal(configSchemaDiagnostics.packageName, '@deepseek-ai/schemastery')
  assert.equal(configSchemaDiagnostics.source, 'plugin')
  assert.equal(configSchemaDiagnostics.anchor, undefined)
  assert.deepEqual(configSchemaDiagnostics.attempts, [])
  // 冻结：日志/测试不该能改掉这份证据。
  assert.ok(Object.isFrozen(configSchemaDiagnostics))
  assert.ok(Object.isFrozen(configSchemaDiagnostics.attempts))
  // 非空且可校验（这里只验「有内容」，字段表/volatile 由 config-fields.test.js 逐项锁）。
  const validated = Config['~standard'].validate({ staleMinutes: 10 })
  assert.equal(validated.issues, undefined)
  assert.ok(Object.keys(validated.value).length >= 20)
})

test('真实模块加载：无 schemastery、无可用锚点 → Config=undefined 且 warn 打到 stderr（不静默）', () => {
  // 子进程 + 临时目录副本：让 createRequire 的插件自身路径与宿主兜底同时失效，
  // 走的是**真实模块加载**代码，不是注入替身——证明 warn 真的会出现在进程输出里。
  const dir = mkdtempSync(join(tmpdir(), 'orch-config-schema-'))
  try {
    copyFileSync(new URL('../src/config-schema.js', import.meta.url), join(dir, 'config-schema.js'))
    copyFileSync(new URL('../src/config-fields.js', import.meta.url), join(dir, 'config-fields.js'))
    const entry = join(dir, 'probe.mjs')
    const moduleUrl = pathToFileURL(join(dir, 'config-schema.js')).href
    writeFileSync(entry, [
      `const mod = await import(${JSON.stringify(moduleUrl)})`,
      "process.stdout.write('CONFIG=' + (mod.Config === undefined ? 'undefined' : 'defined'))",
    ].join('\n'))

    const env = {
      ...process.env,
      DSH_PROFILE_DIR: '',
      DSH_HOME: '',
      DSH_INSTALL_DIR: '',
      DSH_NODE_EXECUTABLE: '',
    }
    const child = spawnSync(process.execPath, [entry], { cwd: dir, env, encoding: 'utf8' })

    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), 'CONFIG=undefined')
    // 关键：降级不能让插件崩，但必须喊出来。
    assert.match(child.stderr, /\[dsh-orchestrator\]/)
    assert.match(child.stderr, /配置卡片将不显示/)
    assert.match(child.stderr, /@deepseek-ai\/schemastery 解析失败/)
    assert.match(child.stderr, /已尝试 \d+ 个位置/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
