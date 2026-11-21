// 包内 CLI 安装器（计划 §3.3 / §6.1 / §6.2）。
//
// 一句话：**确认卡 → argv 数组（shell:false）→ pnpm 装到 `tools/<id>` → 校验版本 + realpath 入口
// → `--version` / `render` 冒烟 → 回填 install.json**；任何一步失败删掉 tools 目录、记 failed 日志，
// 包与技能照常可用（健康显示 cli: unavailable）。
//
// 为什么这些细节一个都不能省（都有真机证据）：
//   - pnpm 的 `node_modules` 是 junction：直接执行 `dist/cli.js` 会 `ERR_MODULE_NOT_FOUND: commander`，
//     必须 `fs.realpathSync.native()` 解析成 `.pnpm/…` 真路径（P0 实测）；
//   - 文颜 `render` 也会初始化 token 存储并写 `%APPDATA%\wenyan-md`：子进程必须固定
//     `APPDATA`/`LOCALAPPDATA` 到包内 `.state/wenyan`（P0 实测）；
//   - 安装体量实测 259 包 / ≈184 MiB / 冷装 ≈4 分 04 秒 / 0 install 钩子：写进确认卡，默认取消；
//   - `--ignore-scripts` 强制（当前版本无钩子，防未来版本引入）；
//   - registry 显式 `--registry=https://registry.npmjs.org` 覆盖用户 `.npmrc`；
//   - 失败不重试：pnpm 有幂等性但用户看不到为什么慢；把尾部日志与可复制命令给用户。

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 安装确认卡上的实测数据（来源：reports/pack-spike.md §4；改数据必须重测并更新报告）。 */
export const MEASURED_INSTALL = Object.freeze({
  packages: 259,
  unpackedMiB: 184,
  storeMiB: 178,
  coldSeconds: 244,
  warmSeconds: 14,
  installHooks: 0,
  browsers: 0,
})

/** 安装超时（计划：10 分钟；冷装实测 4 分钟，留足网络波动余量）。 */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** 尾部日志上限（`install.json` 里只留这么多，避免把状态文件撑爆）。 */
export const TAIL_BYTES = 8 * 1024

const text = value => (typeof value === 'string' ? value.trim() : '')

/** 取 node 候选：`DSH_NODE_EXECUTABLE` → 宿主 primary runtime → 当前 execPath → PATH。 */
export function resolveNodeCandidates({ env = process.env, exists = existsSync, execPath = process.execPath } = {}) {
  const out = []
  const push = (command, extraEnv, source) => {
    if (text(command) === '') return
    if (out.some(item => item.command === command && item.source === source)) return
    out.push({ command, env: extraEnv, source })
  }
  if (text(env.DSH_NODE_EXECUTABLE) !== '') push(env.DSH_NODE_EXECUTABLE, {}, 'DSH_NODE_EXECUTABLE')
  if (text(env.DSH_PRIMARY_RUNTIME) !== '') {
    const root = env.DSH_PRIMARY_RUNTIME
    for (const candidate of [join(root, 'node', 'node.exe'), join(root, 'node', 'bin', 'node'), join(root, 'dependencies', 'node', 'node.exe')]) {
      if (exists(candidate)) push(candidate, {}, 'primary-runtime')
    }
  }
  // 宿主自己就是 Electron-as-node：直接复用 execPath，但显式带 ELECTRON_RUN_AS_NODE=1。
  if (text(execPath) !== '') push(execPath, { ELECTRON_RUN_AS_NODE: '1' }, 'execPath')
  push('node', {}, 'PATH')
  return out
}

/** 取 pnpm 候选：宿主 primary runtime 的 pnpm.mjs → PATH 的 pnpm。 */
export function resolvePnpm({ env = process.env, exists = existsSync } = {}) {
  if (text(env.DSH_PRIMARY_RUNTIME) !== '') {
    const script = join(env.DSH_PRIMARY_RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    if (exists(script)) return { kind: 'script', path: script, source: 'primary-runtime' }
  }
  return { kind: 'bin', path: 'pnpm', source: 'PATH' }
}

/**
 * 组装安装 argv（数组，交给 spawn shell:false；永不拼字符串）。
 * 返回 `{ command, args, display }`：display 只用于确认卡/日志（含 node/pnpm 路径）。
 */
export function buildInstallCommand({ node, pnpm, cli, toolsDir }) {
  const add = [
    'add',
    '-C', toolsDir,
    '--ignore-workspace',
    '--ignore-scripts',
    `--registry=${cli.install.registry}`,
    '--store-dir', join(toolsDir, '.store'),
    `${cli.install.package}@${cli.install.version}`,
  ]
  if (pnpm.kind === 'script') {
    return {
      command: node.command,
      args: [pnpm.path, ...add],
      env: { ...node.env },
      display: [node.command, pnpm.path, ...add],
    }
  }
  return {
    command: pnpm.path,
    args: add,
    env: { ...node.env },
    display: [pnpm.path, ...add],
  }
}

/** 计划哈希：绑定「包名@版本 + registry + integrity + 完整 argv」；计划变了哈希就变，旧确认失效。 */
export function planHashOf({ cli, command }) {
  const payload = JSON.stringify({
    package: cli.install.package,
    version: cli.install.version,
    registry: cli.install.registry,
    integrity: cli.install.integrity,
    command: command.display,
  })
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * 生成安装确认卡（面板与工具返回**同源**）。
 * 没有运行时也能出卡：`runnable:false` + 手动命令（不假装能装）。
 */
export function planInstall({ manifest, cliId, toolsDir, env = process.env, exists = existsSync }) {
  const cli = manifest.cli.find(item => item.id === cliId)
  if (cli === undefined) return { ok: false, error: `包「${manifest.id}」没有声明 CLI：${cliId}` }
  const node = resolveNodeCandidates({ env, exists })[0]
  const pnpm = resolvePnpm({ env, exists })
  const command = node === undefined
    ? undefined
    : buildInstallCommand({ node, pnpm, cli, toolsDir })
  const manual = `${cli.install.manager} add -C "${toolsDir}" --ignore-workspace --ignore-scripts --registry=${cli.install.registry} --store-dir "${join(toolsDir, '.store')}" ${cli.install.package}@${cli.install.version}`
  return {
    ok: true,
    cliId: cli.id,
    package: cli.install.package,
    version: cli.install.version,
    manager: cli.install.manager,
    scope: cli.install.scope,
    registry: cli.install.registry,
    integrity: cli.install.integrity,
    license: cli.install.license,
    sourceUrl: cli.install.sourceUrl,
    runnable: command !== undefined,
    ...(command === undefined ? {} : { argv: command.display }),
    manualCommand: manual,
    runtime: node === undefined ? null : { node: node.command, nodeSource: node.source, pnpm: pnpm.path, pnpmSource: pnpm.source },
    planHash: command === undefined ? null : planHashOf({ cli, command }),
    size: { ...MEASURED_INSTALL },
    impact: [
      `仅写入 ${toolsDir}（包内隔离目录，删包即删）`,
      'CLI 运行期把 APPDATA / LOCALAPPDATA 重定向到包内 .state/wenyan（文颜 token 不落用户目录）',
      '不改 PATH、不装全局、不碰 profile',
    ],
    uninstall: '面板「卸载 CLI」= 删除 tools/<id> 目录；包与技能不受影响',
    failure: '安装失败会删除 tools/<id>、保留包与技能，健康显示 cli: unavailable，并给出可复制命令',
  }
}

/** 读文件尾部（最多 TAIL_BYTES），失败给空串。 */
export function readTail(file, max = TAIL_BYTES) {
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const start = Math.max(0, size - max)
      const buffer = Buffer.alloc(size - start)
      readFileSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * 生产用 runner：spawn（shell:false）+ 文件 fd 输出（受限期也不依赖命名管道），超时 kill。
 * 返回 `{ code, signal, timedOut, tail }`；不抛（调用方按 code/error 判失败）。
 */
export function createProcessRunner({ timeoutMs = INSTALL_TIMEOUT_MS, tmpRoot = tmpdir() } = {}) {
  return async ({ command, args, env, cwd }) => {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const dir = join(tmpRoot, `dsh-pack-${stamp}`)
    mkdirSync(dir, { recursive: true })
    const outFile = join(dir, 'stdout.log')
    const errFile = join(dir, 'stderr.log')
    const outFd = openSync(outFile, 'w')
    const errFd = openSync(errFile, 'w')
    return await new Promise(resolve => {
      let settled = false
      const finish = (code, signal, error, timedOut = false) => {
        if (settled) return
        settled = true
        try { closeSync(outFd) } catch { /* 已关 */ }
        try { closeSync(errFd) } catch { /* 已关 */ }
        const stdout = readTail(outFile)
        const stderr = readTail(errFile)
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结果 */ }
        resolve({ code, signal, timedOut, error: error === undefined ? undefined : String(error?.message ?? error), stdout, stderr, tail: `${stdout}${stderr}`.slice(-TAIL_BYTES) })
      }
      let child
      try {
        child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', outFd, errFd] })
      } catch (error) {
        finish(undefined, undefined, error)
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(undefined, undefined, new Error(`timeout ${timeoutMs}ms`), true)
      }, timeoutMs)
      child.on('error', error => {
        clearTimeout(timer)
        finish(undefined, undefined, error)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        finish(code, signal, undefined)
      })
    })
  }
}

/**
 * 安装器：探测 → 确认卡 → 执行 → 校验 → 回填；失败清理。
 * @param {object} options
 * @param {object} options.store - createPackStore()
 * @param {(input: object) => Promise<object>} options.runner - 命令执行器（测试注入 fake）
 * @param {() => number} [options.now]
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(path: string) => boolean} [options.exists]
 */
export function createInstaller({ store, runner = createProcessRunner(), now = Date.now, log = () => {}, env = process.env, exists = existsSync } = {}) {
  const plan = (manifest, cliId) => planInstall({
    manifest, cliId, toolsDir: store.toolsDir(manifest.id), env, exists,
  })

  const currentOf = id => {
    const record = store.readInstall(id)
    if (record === undefined) return undefined
    return record
  }

  const statusOf = (manifest, cliId) => {
    const cli = manifest.cli.find(item => item.id === cliId)
    if (cli === undefined) return { status: 'unknown', error: `未声明的 CLI：${cliId}` }
    const record = currentOf(manifest.id)
    if (record === undefined) return { status: 'not-installed' }
    if (record.status === 'failed') return { status: 'failed', tail: record.tail ?? '', at: record.finishedAt ?? null }
    if (record.status !== 'installed') return { status: 'unknown' }
    if (record.cliId !== cliId || record.version !== cli.install.version) return { status: 'outdated', installedVersion: record.version, version: cli.install.version }
    if (!exists(record.resolved?.entry) || !exists(record.resolved?.node)) return { status: 'broken', reason: 'resolved 入口/解释器已不存在' }
    return { status: 'installed', record }
  }

  const appendTail = (previous, next) => `${previous ?? ''}${next ?? ''}`.slice(-TAIL_BYTES)

  const fail = (id, cli, fields) => {
    const tail = (fields.tail ?? '').slice(-TAIL_BYTES)
    const record = {
      status: 'failed',
      cliId: cli.id,
      package: cli.install.package,
      version: cli.install.version,
      manager: cli.install.manager,
      registry: cli.install.registry,
      integrity: cli.install.integrity,
      startedAt: fields.startedAt ?? now(),
      finishedAt: now(),
      exitCode: fields.exitCode ?? null,
      timedOut: fields.timedOut === true,
      error: fields.error ?? null,
      tail,
      manualCommand: fields.manualCommand ?? null,
    }
    try { store.writeInstall(id, record) } catch { /* 状态写失败不掩盖安装失败 */ }
    log('pack.install.failed', { detail: { id, cli: cli.id, exitCode: record.exitCode, timedOut: record.timedOut, error: record.error } })
    return { ok: false, code: fields.code ?? 'INSTALL_FAILED', error: fields.error ?? '安装失败', tail, manualCommand: record.manualCommand, record }
  }

  /**
   * 安装/升级（必须带确认 + planHash）。
   * @param {object} input
   * @param {object} input.manifest
   * @param {string} input.cliId
   * @param {boolean} [input.confirm]
   * @param {string} [input.expectedPlanHash]
   * @param {string} [input.smokeFile] - 可选的 render 冒烟 Markdown（如包内 references/smoke.md）
   * @param {Function} [input.renderSmoke] - 冒烟执行器（service 注入 src/pack/wenyan.js 的 renderSmoke）
   * @returns {{ ok: boolean, code?: string, reused?: boolean, record?: object, plan?: object, error?: string }}
   */
  const install = async ({ manifest, cliId, confirm = false, expectedPlanHash, smokeFile, renderSmoke } = {}) => {
    const cli = manifest.cli.find(item => item.id === cliId)
    if (cli === undefined) return { ok: false, code: 'CLI_UNKNOWN', error: `包「${manifest.id}」没有声明 CLI：${cliId}` }
    const card = plan(manifest, cliId)
    if (card.ok !== true) return { ok: false, code: 'PLAN_FAILED', error: card.error }
    // 已装且版本一致：复用（不重装、不弹第二次确认）。
    const status = statusOf(manifest, cliId)
    if (status.status === 'installed') {
      return { ok: true, reused: true, code: 'ALREADY_INSTALLED', record: status.record, plan: card }
    }
    if (confirm !== true) return { ok: false, code: 'CONFIRM_REQUIRED', plan: card, error: '安装需要用户确认：先看确认卡（体积/耗时/影响面），确认后再调 confirm:true + planHash' }
    if (card.runnable !== true) return { ok: false, code: 'RUNTIME_UNAVAILABLE', plan: card, error: '找不到可用的 node/pnpm：先装 Node，或按 manualCommand 手动安装' }
    if (text(expectedPlanHash) !== '' && expectedPlanHash !== card.planHash) {
      return { ok: false, code: 'PLAN_STALE', plan: card, error: '确认卡内容已变化（版本/registry/argv 变了）：请重新看卡再确认' }
    }

    const id = manifest.id
    const toolsDir = store.toolsDir(id)
    const startedAt = now()
    log('pack.install.start', { detail: { id, cli: cli.id, version: cli.install.version, planHash: card.planHash } })
    try {
      mkdirSync(toolsDir, { recursive: true })
      // 最小 package.json：pnpm 需要一个「根」；private 防止误发布。
      writeFileSync(join(toolsDir, 'package.json'), `${JSON.stringify({ name: `dsh-pack-tools-${id}`, private: true }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return fail(id, cli, { code: 'TOOLS_DIR_FAILED', error: `准备 tools 目录失败：${error?.message ?? error}`, startedAt, manualCommand: card.manualCommand })
    }

    const runtime = resolveNodeCandidates({ env, exists })
    const command = buildInstallCommand({
      node: runtime[0],
      pnpm: resolvePnpm({ env, exists }),
      cli,
      toolsDir,
    })
    const result = await runner({ command: command.command, args: command.args, env: { ...env, ...command.env }, cwd: toolsDir, timeoutMs: INSTALL_TIMEOUT_MS })
    if (result.error !== undefined && result.code === undefined) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖错误 */ }
      return fail(id, cli, { code: 'INSTALL_FAILED', error: `安装进程启动失败：${result.error}`, startedAt, tail: result.tail, manualCommand: card.manualCommand })
    }
    if (result.timedOut === true || result.code !== 0) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, {
        code: result.timedOut === true ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED',
        error: result.timedOut === true ? `安装超时（>${Math.round(INSTALL_TIMEOUT_MS / 60000)} 分钟）` : `pnpm 退出码 ${result.code}`,
        startedAt,
        exitCode: result.code ?? null,
        timedOut: result.timedOut === true,
        tail: result.tail,
        manualCommand: card.manualCommand,
      })
    }

    // 校验 1：实际安装版本必须 == manifest 锁定版本。
    const packageJsonPath = join(toolsDir, 'node_modules', ...cli.install.package.split('/'), 'package.json')
    let installed
    try {
      installed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    } catch (error) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, { code: 'VERIFY_FAILED', error: `装完找不到 ${packageJsonPath}：${error?.message ?? error}`, startedAt, exitCode: 0, tail: result.tail, manualCommand: card.manualCommand })
    }
    if (installed.version !== cli.install.version) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, {
        code: 'VERSION_MISMATCH',
        error: `装到的是 ${installed.version}，清单锁定 ${cli.install.version}（拒绝使用未锁定版本）`,
        startedAt, exitCode: 0, tail: result.tail, manualCommand: card.manualCommand,
      })
    }

    // 校验 2：bin 入口 → realpath（pnpm junction 直接执行会 ERR_MODULE_NOT_FOUND）。
    const binField = installed.bin
    const binPath = typeof binField === 'string' ? binField : (binField !== null && typeof binField === 'object' ? Object.values(binField)[0] : undefined)
    if (typeof binPath !== 'string' || binPath === '') {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, { code: 'VERIFY_FAILED', error: `${cli.install.package} 的 package.json 没有 bin 入口`, startedAt, exitCode: 0 })
    }
    const entryPath = join(toolsDir, 'node_modules', ...cli.install.package.split('/'), binPath)
    let entry
    try {
      entry = realpathSync.native(entryPath)
    } catch (error) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, { code: 'VERIFY_FAILED', error: `realpath 解析入口失败：${error?.message ?? error}`, startedAt, exitCode: 0 })
    }

    // 校验 3：`--version` 冒烟（重定向 APPDATA/LOCALAPPDATA）。
    const cliEnv = cliEnvironment({ toolsDir, appDataDir: join(store.stateDirOf(id), 'wenyan'), env })
    const versionRun = await runner({ command: runtime[0].command, args: [entry, '--version'], env: { ...cliEnv, ...runtime[0].env }, cwd: toolsDir, timeoutMs: 60_000 })
    if (versionRun.code !== 0) {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
      return fail(id, cli, { code: 'VERIFY_FAILED', error: `CLI --version 失败（退出码 ${versionRun.code}）`, startedAt, exitCode: versionRun.code ?? null, tail: versionRun.tail })
    }

    // 校验 4（可选）：render 冒烟。文颜 render 也会初始化 token 存储，必须带 APPDATA 重定向；
    // 冒烟失败说明「装上了但跑不起来」，不能回填 invocation（回填等于交给用户一个坏的 CLI）。
    let smokeOk = false
    if (typeof renderSmoke === 'function' && typeof smokeFile === 'string' && smokeFile !== '' && exists(smokeFile)) {
      const smoke = await renderSmoke({
        invocation: {
          ok: true,
          node: runtime[0].command,
          entry,
          version: cli.install.version,
          appDataDir: join(store.stateDirOf(id), 'wenyan'),
        },
        smokeFile,
        env,
      })
      if (smoke?.ok !== true) {
        try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* 同上 */ }
        return fail(id, cli, { code: 'VERIFY_FAILED', error: `render 冒烟失败：${smoke?.error ?? '未知原因'}`, startedAt, exitCode: 0, tail: result.tail })
      }
      smokeOk = true
    }

    const record = {
      status: 'installed',
      cliId: cli.id,
      package: cli.install.package,
      version: cli.install.version,
      manager: cli.install.manager,
      scope: cli.install.scope,
      registry: cli.install.registry,
      integrity: cli.install.integrity,
      license: cli.install.license,
      startedAt,
      finishedAt: now(),
      exitCode: 0,
      tail: result.tail,
      confirmedAt: now(),
      resolved: { node: runtime[0].command, entry },
      appDataDir: join(store.stateDirOf(id), 'wenyan'),
      versionOutput: (versionRun.stdout ?? '').trim().slice(0, 200),
      smoke: smokeOk ? 'render-passed' : 'skipped',
    }
    store.writeInstall(id, record)
    log('pack.install.installed', { detail: { id, cli: cli.id, version: record.version, seconds: Math.round((record.finishedAt - startedAt) / 1000) } })
    return { ok: true, record, plan: card }
  }

  /** 卸载：删 tools 目录 + 写一条 uninstalled 记录（保留原因，便于排障）。 */
  const uninstall = id => {
    const toolsDir = store.toolsDir(id)
    try {
      rmSync(toolsDir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, error: `删除 tools 目录失败：${error?.message ?? error}` }
    }
    try { store.writeInstall(id, { status: 'uninstalled', at: now() }) } catch { /* 状态写失败不影响卸载 */ }
    log('pack.cli.uninstall', { detail: { id } })
    return { ok: true }
  }

  return { plan, install, uninstall, statusOf, currentOf }
}

/**
 * CLI 子进程环境：固定 APPDATA / LOCALAPPDATA 到包内 `.state/wenyan`（文颜会写 token 存储），
 * 其余环境原样透传（PATH/PROXY 等用户需要）。
 * @param {{ toolsDir: string, appDataDir?: string, env?: object }} options
 */
export function cliEnvironment({ toolsDir, appDataDir, env = process.env }) {
  const dir = text(appDataDir) === '' ? join(toolsDir, '..', '.state', 'wenyan') : appDataDir
  return { ...env, APPDATA: dir, LOCALAPPDATA: dir }
}
