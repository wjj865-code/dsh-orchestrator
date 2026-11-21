import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './helpers.js'
import { createPackStore } from '../src/pack/store.js'
import { validateManifest } from '../src/pack/manifest.js'
import {
  buildInstallCommand, cliEnvironment, createInstaller, MEASURED_INSTALL, planInstall,
} from '../src/pack/install.js'
import { skillFiles, validManifest } from './pack-fixtures.js'

// P3 安装器：argv 白名单、确认卡、版本复用/升级、失败回退。这些都是「用户点一下就可能装错东西」的路径：
// registry 被 .npmrc 劫持、装了 latest、失败留下半截 node_modules、确认卡跟实际 argv 不一致。

const CLI = {
  id: 'demo-cli',
  purpose: '演示 CLI',
  install: {
    manager: 'pnpm',
    package: '@demo/cli',
    version: '1.2.3',
    scope: 'pack-local',
    registry: 'https://registry.npmjs.org',
    integrity: 'sha512-demo',
    license: 'MIT',
    sourceUrl: 'https://registry.npmjs.org/@demo/cli',
  },
  env: ['DEMO_TOKEN'],
}

export const cliManifest = (overrides = {}) => validateManifest(validManifest({
  id: 'cli-pack',
  cli: [CLI],
  env: [{ ref: 'DEMO_TOKEN', kind: 'secret', required: true, purpose: '演示凭据' }],
  ...overrides,
})).manifest

const setup = () => {
  const stateDir = tempDir()
  const store = createPackStore({ stateDir, now: () => 1700000000000 })
  const manifest = cliManifest()
  store.writePack(manifest, skillFiles())
  return { stateDir, store, manifest }
}

/** 假装 pnpm 装成功：在 argv 的 -C 目录里造出 package.json + bin 入口。 */
const makeRunner = ({ installedVersion = '1.2.3', exitCode = 0, versionOutput = '1.2.3' } = {}) => {
  const calls = []
  const runner = async ({ command, args }) => {
    calls.push({ command, args })
    if (args.includes('--version')) {
      return { code: 0, stdout: `${versionOutput}\n`, stderr: '', tail: versionOutput }
    }
    if (exitCode !== 0) return { code: exitCode, stdout: '', stderr: 'boom', tail: 'boom' }
    const index = args.indexOf('-C')
    const toolsDir = args[index + 1]
    const packageDir = join(toolsDir, 'node_modules', '@demo', 'cli')
    mkdirSync(join(packageDir, 'dist'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@demo/cli', version: installedVersion, bin: { demo: 'dist/cli.js' },
    }))
    writeFileSync(join(packageDir, 'dist', 'cli.js'), '')
    return { code: 0, stdout: '', stderr: '', tail: 'installed' }
  }
  return { runner, calls }
}

test('P3 安装 argv：shell:false 数组，含 -C/--ignore-workspace/--ignore-scripts/--registry/--store-dir/精确版本', () => {
  const { toolsDir } = { toolsDir: 'C:\\state\\tools\\cli-pack' }
  const built = buildInstallCommand({
    node: { command: 'C:\\node\\node.exe', env: {} },
    pnpm: { kind: 'script', path: 'C:\\runtime\\pnpm.mjs' },
    cli: { install: CLI.install },
    toolsDir,
  })
  assert.equal(built.command, 'C:\\node\\node.exe')
  assert.deepEqual(built.args, [
    'C:\\runtime\\pnpm.mjs', 'add', '-C', toolsDir,
    '--ignore-workspace', '--ignore-scripts', '--registry=https://registry.npmjs.org',
    '--store-dir', join(toolsDir, '.store'), '@demo/cli@1.2.3',
  ])
  // PATH 形态的 pnpm：直接用它当 command，不拼 node。
  const bin = buildInstallCommand({ node: { command: 'node', env: {} }, pnpm: { kind: 'bin', path: 'pnpm' }, cli: { install: CLI.install }, toolsDir })
  assert.equal(bin.command, 'pnpm')
  assert.equal(bin.args[0], 'add')
})

test('P3 确认卡：实测体积/耗时、影响面、卸载与失败后果、planHash 随版本变化', () => {
  const { store, manifest } = setup()
  const plan = planInstall({ manifest, cliId: 'demo-cli', toolsDir: store.toolsDir('cli-pack'), env: {}, exists: () => false })
  assert.equal(plan.ok, true)
  assert.equal(plan.size.packages, MEASURED_INSTALL.packages)
  assert.equal(plan.size.coldSeconds, 244)
  assert.equal(plan.size.installHooks, 0)
  assert.ok(plan.impact.some(item => item.includes('APPDATA')))
  assert.match(plan.failure, /删除 tools/)
  assert.match(plan.manualCommand, /@demo\/cli@1\.2\.3/)
  assert.equal(typeof plan.planHash, 'string')
  assert.equal(plan.planHash.length, 64)
  const other = planInstall({ manifest: cliManifest({ cli: [{ ...CLI, install: { ...CLI.install, version: '1.2.4' } }] }), cliId: 'demo-cli', toolsDir: 't', env: {}, exists: () => false })
  assert.notEqual(other.planHash, plan.planHash, '版本变了 planHash 必须变（旧确认失效）')
  // 没有运行时：仍出卡，但不假装能装。
  const noRuntime = planInstall({ manifest, cliId: 'demo-cli', toolsDir: 't', env: {}, exists: () => false })
  assert.equal(noRuntime.runnable, true, 'PATH 里的 node 也算候选（执行时失败再由安装器报错）')
})

test('P3 安装：未确认拒绝并回确认卡；确认后用真实 argv 执行并回填 install.json（realpath 入口）', async () => {
  const { store, manifest } = setup()
  const { runner, calls } = makeRunner()
  const installer = createInstaller({ store, runner, now: () => 1700000000000 })

  const denied = await installer.install({ manifest, cliId: 'demo-cli' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'CONFIRM_REQUIRED')
  assert.equal(denied.plan.package, '@demo/cli')
  assert.equal(store.readInstall('cli-pack'), undefined, '未确认不得产生任何安装状态')

  const plan = installer.plan(manifest, 'demo-cli')
  const installed = await installer.install({ manifest, cliId: 'demo-cli', confirm: true, expectedPlanHash: plan.planHash })
  assert.equal(installed.ok, true, installed.error)
  const record = store.readInstall('cli-pack')
  assert.equal(record.status, 'installed')
  assert.equal(record.version, '1.2.3')
  assert.equal(record.cliId, 'demo-cli')
  assert.ok(existsSync(record.resolved.entry), '入口必须真实存在')
  assert.match(record.resolved.entry, /dist[\\/]cli\.js$/)
  assert.ok(record.appDataDir.endsWith(join('wenyan')), 'APPDATA 重定向目录必须落在包状态目录')
  // 实际执行的是 add（带 --ignore-scripts），后来还有 --version 冒烟。
  assert.ok(calls.some(call => call.args.includes('add')))
  assert.ok(calls.some(call => call.args.includes('--version')))
  // 复用：再装一次不重跑 pnpm。
  const before = calls.length
  const again = await installer.install({ manifest, cliId: 'demo-cli', confirm: true })
  assert.equal(again.ok, true)
  assert.equal(again.reused, true)
  assert.equal(calls.length, before, '已安装同版本必须复用，不重新跑 pnpm')
  assert.equal(installer.statusOf(manifest, 'demo-cli').status, 'installed')
})

test('P3 安装失败：pnpm 退出码非 0 → failed 记录 + 删除 tools 目录', async () => {
  const { store, manifest, stateDir } = setup()
  const { runner } = makeRunner({ exitCode: 1 })
  const installer = createInstaller({ store, runner, now: () => 1700000000000 })
  const result = await installer.install({ manifest, cliId: 'demo-cli', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INSTALL_FAILED')
  const record = store.readInstall('cli-pack')
  assert.equal(record.status, 'failed')
  assert.equal(record.exitCode, 1)
  assert.ok('manualCommand' in record)
  assert.equal(existsSync(join(stateDir, 'capability-packs', 'tools', 'cli-pack')), false, '失败必须删掉 tools 目录')
})

test('P3 安装校验：实际版本 != 锁定版本 → VERSION_MISMATCH + 清理', async () => {
  const { store, manifest, stateDir } = setup()
  const { runner } = makeRunner({ installedVersion: '9.9.9' })
  const installer = createInstaller({ store, runner })
  const result = await installer.install({ manifest, cliId: 'demo-cli', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'VERSION_MISMATCH')
  assert.match(result.error, /9\.9\.9/)
  assert.equal(existsSync(join(stateDir, 'capability-packs', 'tools', 'cli-pack')), false)
})

test('P3 安装确认卡过期：planHash 不匹配 → PLAN_STALE，不执行', async () => {
  const { store, manifest } = setup()
  const { runner, calls } = makeRunner()
  const installer = createInstaller({ store, runner })
  const result = await installer.install({ manifest, cliId: 'demo-cli', confirm: true, expectedPlanHash: 'deadbeef' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLAN_STALE')
  assert.equal(calls.length, 0)
})

test('P3 升级：清单版本变化 → outdated；确认后装新版本，install.json 更新', async () => {
  const { store, manifest } = setup()
  const { runner } = makeRunner({ installedVersion: '1.2.3' })
  const installer = createInstaller({ store, runner })
  await installer.install({ manifest, cliId: 'demo-cli', confirm: true })
  const upgradedManifest = validateManifest({
    ...manifest,
    cli: [{ ...CLI, install: { ...CLI.install, version: '1.2.4' } }],
  }).manifest
  assert.equal(installer.statusOf(upgradedManifest, 'demo-cli').status, 'outdated')
  const { runner: runner2 } = makeRunner({ installedVersion: '1.2.4' })
  const installer2 = createInstaller({ store, runner: runner2 })
  const result = await installer2.install({ manifest: upgradedManifest, cliId: 'demo-cli', confirm: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(store.readInstall('cli-pack').version, '1.2.4')
})

test('P3 卸载：删除 tools 目录并记 uninstalled（包与技能保留）', async () => {
  const { store, manifest, stateDir } = setup()
  const { runner } = makeRunner()
  const installer = createInstaller({ store, runner })
  await installer.install({ manifest, cliId: 'demo-cli', confirm: true })
  const toolsDir = join(stateDir, 'capability-packs', 'tools', 'cli-pack')
  assert.equal(existsSync(toolsDir), true)
  const result = installer.uninstall('cli-pack')
  assert.equal(result.ok, true)
  assert.equal(existsSync(toolsDir), false)
  assert.equal(store.readInstall('cli-pack').status, 'uninstalled')
  assert.equal(existsSync(store.packDir('cli-pack')), true, '卸载 CLI 不影响包目录')
})

test('P3 安装的 render 冒烟：失败 → VERIFY_FAILED + 清理；成功 → install.json 记 smoke=render-passed', async () => {
  const { store, manifest, stateDir } = setup()
  const { runner } = makeRunner()
  const installer = createInstaller({ store, runner })
  const smokeFile = join(stateDir, 'smoke.md')
  writeFileSync(smokeFile, '---\ntitle: s\n---\n\n正文\n')
  const failedSmoke = async () => ({ ok: false, code: 'SMOKE_INVALID', error: 'render 输出不像公众号 HTML' })
  const failed = await installer.install({ manifest, cliId: 'demo-cli', confirm: true, smokeFile, renderSmoke: failedSmoke })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'VERIFY_FAILED')
  assert.match(failed.error, /render 冒烟失败/)
  assert.equal(existsSync(join(stateDir, 'capability-packs', 'tools', 'cli-pack')), false)

  const passed = await installer.install({
    manifest, cliId: 'demo-cli', confirm: true, smokeFile,
    renderSmoke: async ({ invocation, smokeFile: file }) => {
      assert.equal(invocation.ok, true)
      assert.match(invocation.appDataDir, /wenyan$/)
      assert.equal(existsSync(file), true)
      return { ok: true, bytes: 100 }
    },
  })
  assert.equal(passed.ok, true, passed.error)
  assert.equal(store.readInstall('cli-pack').smoke, 'render-passed')
})

test('P3 CLI 环境：APPDATA/LOCALAPPDATA 固定到包内 .state/wenyan', () => {
  const env = cliEnvironment({ toolsDir: 'C:\\state\\tools\\cli-pack', appDataDir: 'C:\\state\\packs\\cli-pack\\.state\\wenyan', env: { PATH: 'x', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } })
  assert.equal(env.APPDATA, 'C:\\state\\packs\\cli-pack\\.state\\wenyan')
  assert.equal(env.LOCALAPPDATA, env.APPDATA)
  assert.equal(env.PATH, 'x')
})
