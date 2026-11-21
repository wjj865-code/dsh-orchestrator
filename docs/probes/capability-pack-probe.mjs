// P0 门禁探针：能力包（Capability Pack）机制的**真机**核查（Desktop / DSH 0.2.2-rc.5）。
//
// 回答四件事（对应计划 §1.3 的 U1–U4）：
//   U1 运行时注册预设：`agentPresets.register()` 能挂、`list()` 可见、`unregister` 能撤；
//   U2 `customSkillDirs` 生效：注册的预设里挂 skill-filesystem，技能目录能出现在**该会话**的技能快照里；
//   U3 `sessionController.create({ agentPreset })` 能开出跑这个预设的会话；
//   U4 Desktop 判定输入可观测：launcher 提供的 `profileContext`、Electron-as-node 的 `process.versions.electron`。
// 另外核对文颜 CLI 在**宿主同款 Node**（Electron-as-node）上能否运行、安装体量多大（用于安装确认卡）。
//
// 用法：
//   node docs/probes/capability-pack-probe.mjs [--skip-cli] [--keep] [--json <path>]
//   - 默认在系统临时目录建**隔离 DSH_HOME**（不碰真实 ~/.dsh），结束后删除（--keep 保留）。
//   - --skip-cli 跳过文颜安装/运行核对（该项要联网装 259 个包）。
//   - 环境变量覆盖：DSH_EXE（DeepSeek Harness.exe）、DSH_CLI_JS（desktop-host cli.js）、DSH_PNPM_MJS。
//
// 为什么用「文件 stdio」而不是管道：受限沙箱禁止子进程开命名管道（EPERM），spawn 默认 pipe 会失败；
// 文件 fd 在受限与全权两种环境下都成立（docs/testing.md §1「沙箱」）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_EXE = 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const DEFAULT_CLI_JS = 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const DEFAULT_PNPM = 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const WENYAN = { name: '@wenyan-md/cli', version: '2.0.12', registry: 'https://registry.npmjs.org' }

const args = new Set(process.argv.slice(2))
const skipCli = args.has('--skip-cli')
const keep = args.has('--keep')
const jsonIndex = process.argv.indexOf('--json')
const jsonPath = jsonIndex === -1 ? undefined : process.argv[jsonIndex + 1]

const exe = process.env.DSH_EXE ?? DEFAULT_EXE
const cliJs = process.env.DSH_CLI_JS ?? DEFAULT_CLI_JS
const pnpmMjs = process.env.DSH_PNPM_MJS ?? DEFAULT_PNPM

const checks = []
const record = (name, ok, detail = {}) => {
  checks.push({ name, ok, ...detail })
  const extra = detail.error !== undefined ? ` ← ${String(detail.error).split('\n')[0].slice(0, 200)}` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra}`)
}
const info = (name, detail) => {
  checks.push({ name, ok: true, info: true, ...detail })
  console.log(`INFO ${name} ${JSON.stringify(detail)}`)
}

/** 以文件 stdio 跑一个子进程（受限沙箱可用），返回 exitCode 与日志文本。 */
function run(cmd, argv, { env, cwd, logPath, timeoutMs = 120000 } = {}) {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'w')
  return new Promise(resolve => {
    let settled = false
    const finish = (code, error) => {
      if (settled) return
      settled = true
      try { closeSync(fd) } catch { /* 已关 */ }
      resolve({ code, error, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' })
    }
    let child
    try {
      child = spawn(cmd, argv, { env, cwd, windowsHide: true, stdio: ['ignore', fd, fd] })
    } catch (error) {
      finish(undefined, error)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(undefined, new Error(`timeout ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', error => { clearTimeout(timer); finish(undefined, error) })
    child.on('exit', code => { clearTimeout(timer); finish(code ?? undefined, undefined) })
  })
}

function dirBytes(dir) {
  let bytes = 0
  let files = 0
  const walk = current => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else {
        try { bytes += statSync(full).size; files += 1 } catch { /* 读不到跳过 */ }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** 文颜依赖树事实（用于安装确认卡的「预计新增体积」）。 */
function dependencyFacts(root) {
  const virtual = join(root, 'node_modules', '.pnpm')
  const facts = { packages: 0, installHooks: [], browserish: [], bytes: 0, storeBytes: undefined, cli: undefined }
  if (!existsSync(virtual)) return facts
  const v = dirBytes(virtual)
  facts.bytes = v.bytes
  const seen = new Set()
  for (const entry of readdirSync(virtual)) {
    const mods = join(virtual, entry, 'node_modules')
    if (!existsSync(mods)) continue
    for (const name of readdirSync(mods)) {
      if (name.startsWith('@')) {
        for (const sub of readdirSync(join(mods, name))) seen.add(`${name}/${sub}`)
      } else seen.add(name)
    }
  }
  facts.packages = seen.size
  for (const entry of readdirSync(virtual)) {
    const mods = join(virtual, entry, 'node_modules')
    if (!existsSync(mods)) continue
    for (const name of readdirSync(mods)) {
      if (name.startsWith('@')) continue
      if (/puppeteer|playwright|chromium|electron|node-gyp|napi|sharp|canvas/i.test(name)) facts.browserish.push(name)
      let pkg
      try { pkg = JSON.parse(readFileSync(join(mods, name, 'package.json'), 'utf8')) } catch { continue }
      const scripts = pkg.scripts ?? {}
      for (const hook of ['preinstall', 'install', 'postinstall']) {
        if (typeof scripts[hook] === 'string') facts.installHooks.push(`${name}@${pkg.version}:${hook}`)
      }
    }
  }
  const cliDir = join(root, 'node_modules', WENYAN.name)
  try { facts.cli = { ...dirBytes(cliDir), version: JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version } } catch { /* 未装 */ }
  return facts
}

// ---------- A. 运行时预设 / 技能 / 会话（隔离 home + 临时 profile） ----------
const PROBE_PLUGIN = `
import { appendFileSync } from "node:fs"
export const name = "dsh-pack-probe"
export const inject = ["agentPresets", "sessionController", "skills", "agents"]
export function apply(ctx) {
  const out = process.env.PACK_PROBE_OUT
  const line = value => appendFileSync(out, JSON.stringify(value) + "\\n")
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  ;(async () => {
    let profileContext
    try { profileContext = ctx.get("profileContext") } catch { /* 没有就不记 */ }
    line({ check: "host-facts", electron: !!process.versions.electron, node: process.versions.node, profileName: profileContext?.name ?? null })
    const definition = {
      id: "pack-probe-preset", name: "Pack Probe", description: "P0 probe", order: 999,
      plugins: [
        { id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix: "probe" } },
        { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", config: { includeDefaultRoots: false, customSkillDirs: [process.env.PACK_PROBE_SKILLS] } },
        { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
      ],
    }
    let unregister
    try { unregister = await ctx.agentPresets.register(definition); line({ check: "register", ok: true }) }
    catch (error) { line({ check: "register", ok: false, error: String(error?.message ?? error) }) }
    try {
      const rows = await ctx.agentPresets.list()
      const row = rows.find(item => item.id === "pack-probe-preset")
      line({ check: "list", ok: row !== undefined && row.broken === undefined, broken: row?.broken ?? null, ids: rows.map(item => item.id) })
    } catch (error) { line({ check: "list", ok: false, error: String(error?.message ?? error) }) }
    let created
    try {
      created = await ctx.sessionController.create({ cwd: process.env.PACK_PROBE_CWD, agentPreset: "pack-probe-preset" })
      line({ check: "create-session", ok: typeof created?.sessionId === "string", sessionId: created?.sessionId ?? null, agentPreset: created?.agentPreset ?? null })
    } catch (error) { line({ check: "create-session", ok: false, error: String(error?.message ?? error) }) }
    if (created?.sessionId !== undefined) {
      let agent
      for (let index = 0; index < 100 && agent === undefined; index += 1) { await sleep(100); try { agent = ctx.agents.get(created.sessionId) } catch { /* 未 live */ } }
      line({ check: "agent-live", ok: agent !== undefined })
      if (agent !== undefined) {
        try {
          const snapshot = await ctx.skills.snapshot({ cwd: process.env.PACK_PROBE_CWD, scope: agent })
          line({ check: "skill-visible", ok: snapshot.skills.some(item => item.name === "probe-skill"), names: snapshot.skills.map(item => item.name), complete: snapshot.complete })
        } catch (error) { line({ check: "skill-visible", ok: false, error: String(error?.message ?? error) }) }
        try { line({ check: "session-preset", ok: ctx.agentPresets.composedPreset(agent.ctx) === "pack-probe-preset", preset: ctx.agentPresets.composedPreset(agent.ctx) ?? null }) }
        catch (error) { line({ check: "session-preset", ok: false, error: String(error?.message ?? error) }) }
      }
    }
    if (typeof unregister === "function") {
      try {
        await unregister()
        const after = await ctx.agentPresets.list()
        line({ check: "unregister", ok: !after.some(item => item.id === "pack-probe-preset") })
      } catch (error) { line({ check: "unregister", ok: false, error: String(error?.message ?? error) }) }
    }
    line({ check: "done" })
    setTimeout(() => process.exit(0), 500)
  })().catch(error => { line({ check: "fatal", error: String(error?.stack ?? error) }); process.exit(1) })
}
`

async function hostProbe(root) {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'probe')
  const outFile = join(root, 'probe-out.jsonl')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  mkdirSync(join(root, 'cwd'), { recursive: true })
  mkdirSync(join(root, 'skills', 'probe-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: P0 probe skill\n---\n\nprobe body\n')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }
  const init = await run(exe, ['--expose-internals', cliJs, '--profile', 'probe', '--from-default-profile', 'web', '--dump-config'], {
    env, cwd: root, logPath: join(root, 'init.log'), timeoutMs: 120000,
  })
  if (!existsSync(join(profile, 'package.json'))) {
    return { ok: false, error: `profile 初始化失败（exit=${init.code}）：${init.log.slice(-800)}` }
  }
  const probeDir = join(profile, 'node_modules', 'dsh-pack-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-pack-probe', version: '0.0.1', type: 'module', main: 'index.js' }, null, 2))
  writeFileSync(join(probeDir, 'index.js'), PROBE_PLUGIN)
  const patch = join(profile, 'cordis.patch.yml')
  const header = '# P0 probe overlay（由 docs/probes/capability-pack-probe.mjs 生成）\n'
  writeFileSync(patch, `${header}- insert:\n    - id: pack-probe\n      name: dsh-pack-probe\n`)
  const runEnv = {
    ...env,
    PACK_PROBE_OUT: outFile,
    PACK_PROBE_CWD: join(root, 'cwd'),
    PACK_PROBE_SKILLS: join(root, 'skills'),
  }
  const hostLog = join(root, 'host.log')
  const host = await run(exe, ['--expose-internals', cliJs, '--profile', 'probe', '--no-open', '--port', '0'], { env: runEnv, cwd: root, logPath: hostLog, timeoutMs: 150000 })
  const lines = existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean) : []
  const byCheck = Object.fromEntries(lines.filter(line => typeof line.check === 'string').map(line => [line.check, line]))
  if (byCheck.done === undefined) {
    return { ok: false, error: `宿主没有在预算内完成探针（exit=${host.code}）：${host.log.slice(-1200)}`, lines }
  }
  return { ok: true, lines, byCheck }
}

// ---------- B. 文颜 CLI 在宿主同款 Node 上的可用性 ----------
async function cliProbe(root) {
  const toolsDir = join(root, 'wenyan-tools')
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, 'package.json'), JSON.stringify({ name: 'capability-pack-probe-tools', private: true, version: '0.0.0' }, null, 2))
  const startedAt = Date.now()
  const install = await run(process.execPath, [pnpmMjs, 'add', '--ignore-scripts', `--registry=${WENYAN.registry}`, `${WENYAN.name}@${WENYAN.version}`], {
    cwd: toolsDir, logPath: join(root, 'pnpm-add.log'), timeoutMs: 600000,
    env: { ...process.env, npm_config_registry: WENYAN.registry },
  })
  const installedMs = Date.now() - startedAt
  if (install.code !== 0) return { ok: false, error: `pnpm add 失败（exit=${install.code}）`, log: install.log.slice(-1200) }
  const entryLink = join(toolsDir, 'node_modules', ...WENYAN.name.split('/'), 'dist', 'cli.js')
  if (!existsSync(entryLink)) return { ok: false, error: `装完找不到 ${entryLink}` }
  const entry = realpathSync.native(entryLink)
  const tmpHome = join(root, 'wenyan-home')
  mkdirSync(tmpHome, { recursive: true })
  const cliEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', APPDATA: tmpHome, LOCALAPPDATA: tmpHome }
  const versionRun = await run(exe, [entry, '--version'], { env: cliEnv, cwd: root, logPath: join(root, 'wenyan-version.log'), timeoutMs: 120000 })
  const version = versionRun.log.trim()
  mkdirSync(join(root, 'md'), { recursive: true })
  const md = join(root, 'md', 'smoke.md')
  writeFileSync(md, '---\ntitle: P0 冒烟\n---\n\n# 标题\n\n一段**正文**。\n\n- 项目一\n- 项目二\n')
  const renderRun = await run(exe, [entry, 'render', '-f', md], { env: cliEnv, cwd: root, logPath: join(root, 'wenyan-render.log'), timeoutMs: 180000 })
  const html = readFileSync(join(root, 'wenyan-render.log'), 'utf8')
  const facts = dependencyFacts(toolsDir)
  return {
    ok: versionRun.code === 0 && version === WENYAN.version && renderRun.code === 0 && html.includes('<section'),
    version, installedMs, entry, facts,
    installedBytes: dirBytes(join(toolsDir, 'node_modules')).bytes,
    htmlBytes: html.length,
    error: versionRun.code === 0 && version === WENYAN.version ? undefined : `version=${JSON.stringify(version)} exit=${versionRun.code}`,
  }
}

// ---------- 主流程 ----------
const root = join(tmpdir(), `dsh-pack-probe-${Date.now().toString(36)}`)
console.log(`探针目录：${root}（隔离 DSH_HOME，不碰真实 ~/.dsh）`)
// asar 内部路径在纯 node 下 existsSync 为 false（Electron 里才可见），只校验外部可执行文件。
if (!existsSync(exe)) {
  console.error(`找不到 ${exe}：用 DSH_EXE 覆盖`)
  process.exit(1)
}
mkdirSync(root, { recursive: true })

const host = await hostProbe(root)
// host-facts 是环境事实，不判 PASS/FAIL（Electron/profile 名取决于启动方式）。
if (host.byCheck?.['host-facts'] !== undefined) info('host:facts', host.byCheck['host-facts'])
for (const name of ['register', 'list', 'create-session', 'agent-live', 'skill-visible', 'session-preset', 'unregister']) {
  const entry = host.byCheck?.[name]
  record(`host:${name}`, entry !== undefined && entry.ok === true, entry === undefined ? { error: host.error ?? '未产出' } : entry)
}

if (skipCli) {
  info('cli:skipped', { reason: '--skip-cli' })
} else {
  const cli = await cliProbe(root)
  record('cli:install-and-run', cli.ok === true, cli.ok === true ? { version: cli.version, installedMs: cli.installedMs, htmlBytes: cli.htmlBytes } : { error: cli.error ?? '未知' })
  if (cli.facts !== undefined) {
    info('cli:dependency-facts', {
      packages: cli.facts.packages,
      installHooks: cli.facts.installHooks,
      browserish: cli.facts.browserish,
      unpackedMiB: Number((cli.installedBytes / 1048576).toFixed(1)),
      cliBytes: cli.facts.cli?.bytes,
      installMs: cli.installedMs,
      htmlBytes: cli.htmlBytes,
      entryRealpath: cli.entry,
    })
  }
}

const summary = {
  at: new Date().toISOString(),
  host: { electron: true },
  root: keep ? root : undefined,
  checks,
  failed: checks.filter(item => item.info !== true && item.ok !== true).map(item => item.name),
  pass: checks.filter(item => item.info !== true && item.ok === true).length,
  total: checks.filter(item => item.info !== true).length,
}
if (jsonPath !== undefined) writeFileSync(jsonPath, JSON.stringify(summary, null, 2))
console.log(`\n结果：${summary.pass}/${summary.total} PASS${summary.failed.length > 0 ? `，FAIL：${summary.failed.join(', ')}` : ''}`)
if (!keep) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
} else {
  console.log(`保留目录：${root}（含 host.log / pnpm-add.log / wenyan-render.log）`)
}
process.exit(summary.failed.length === 0 ? 0 : 1)
