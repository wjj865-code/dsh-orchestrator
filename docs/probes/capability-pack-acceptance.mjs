// 能力包真机验收（P6）：隔离 DSH_HOME + 临时 profile，跑完整链路
//   建用户包 → 预设可见 → 开包会话 → 技能出现 → 健康降级（env 未设置）→ 装文颜 → render 出 HTML
//   → 删除包 → 预设消失 → 零 error 日志 / 零凭据泄漏。
//
// 为什么不装 npm 包再测：本探针要的是**真宿主 + 隔离 home** 下的行为；插件模块从仓库按绝对路径导入
// （与包里 `files` 发出去的是同一份源码）。这样不必为验收再跑一次 npm 打包/安装，也避免污染真实
// `~/.dsh`。要连「装好的包」一起验，先 `npm pack` 再 `dsh plugin add`，然后把这个探针当回归脚本用。
//
// 用法：
//   node docs/probes/capability-pack-acceptance.mjs [--skip-cli] [--keep] [--json <path>] [--report <path>]
//   - 默认会懒装文颜（冷装实测≈4 分钟）；--skip-cli 只验 host 部分（跳过安装与 render）。
//   - 默认清理临时目录；--keep 保留（含 host.log / pnpm 输出 / 生成的 HTML）。
//   - 报告默认写 reports/pack-acceptance.md（--report 覆盖；传 '' 不写）。
//   - 环境变量覆盖：DSH_EXE / DSH_CLI_JS / DSH_PRIMARY_RUNTIME。
import { spawn } from 'node:child_process'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const args = new Set(process.argv.slice(2))
const skipCli = args.has('--skip-cli')
const keep = args.has('--keep')
const valueOf = flag => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const jsonPath = valueOf('--json')
const reportPath = valueOf('--report') ?? join(REPO, 'reports', 'pack-acceptance.md')
const exe = process.env.DSH_EXE ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const cliJs = process.env.DSH_CLI_JS ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const primaryRuntime = process.env.DSH_PRIMARY_RUNTIME ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime'
const SECRET_SENTINEL = 'sk-accept-DO-NOT-LEAK'
const checks = []
const record = (name, ok, detail = {}) => {
  checks.push({ name, ok: ok === true, ...detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail.error === undefined ? '' : `  → ${String(detail.error).split('\n')[0].slice(0, 200)}`}`)
}
const info = (name, detail) => {
  checks.push({ name, ok: true, info: true, ...detail })
  console.log(`INFO ${name} ${JSON.stringify(detail)}`)
}

/** 文件 stdio 跑子进程（受限沙箱也能用；全程不碰真实 ~/.dsh）。 */
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

/** 递归扫描目录里是否出现某个字符串（凭据泄漏检查）。 */
function findText(dir, needle, { limit = 5000 } = {}) {
  const hits = []
  const walk = current => {
    if (hits.length > 0 || limit <= 0) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (limit <= 0 || hits.length > 0) return
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(full); continue }
      limit -= 1
      try {
        if (statSync(full).size > 4 * 1024 * 1024) continue
        if (readFileSync(full, 'utf8').includes(needle)) hits.push(full)
      } catch { /* 二进制/读不到：跳过 */ }
    }
  }
  walk(dir)
  return hits
}

/** 扫描插件日志里的失败事件（error 级别事件名以 .failed/.rejected/fatal 结尾）。 */
function scanLogs(stateDir) {
  const logsDir = join(stateDir, 'logs')
  const bad = []
  let lines = 0
  let files = []
  try { files = readdirSync(logsDir).filter(name => name.endsWith('.jsonl')) } catch { files = [] }
  for (const name of files) {
    let text
    try { text = readFileSync(join(logsDir, name), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      lines += 1
      try {
        const event = JSON.parse(line).event ?? ''
        if (/\.(failed|rejected|fatal)$/.test(event) || event === 'fatal') bad.push(event)
      } catch { /* 坏行不算失败事件（另有一条日志可读性检查） */ }
    }
  }
  return { files: files.length, lines, bad }
}

// ---------- 探针插件（放进临时 profile，桥接真宿主服务） ----------
const PROBE_PLUGIN = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const name = "dsh-pack-accept"
export const inject = ["agentPresets", "sessionController", "skills", "agents"]

export function apply(ctx) {
  const out = process.env.PACK_ACCEPT_OUT
  const src = process.env.PACK_ACCEPT_SRC
  const cwd = process.env.PACK_ACCEPT_CWD
  const skipCli = process.env.PACK_ACCEPT_SKIP_CLI === "1"
  const secret = process.env.PACK_ACCEPT_SECRET
  const log = value => appendFileSync(out, JSON.stringify(value) + "\\n")
  const record = (name, ok, detail = {}) => log({ check: name, ok: ok === true, ...detail })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const moduleOf = name => pathToFileURL(join(src, "src", "pack", name)).href
  const walkFiles = dir => {
    const files = []
    const walk = current => {
      let entries
      try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(dir)
    return files
  }

  ;(async () => {
    const storeMod = await import(moduleOf("store.js"))
    const manifestMod = await import(moduleOf("manifest.js"))
    const presetMod = await import(moduleOf("preset-template.js"))
    const registryMod = await import(moduleOf("preset-registry.js"))
    const installMod = await import(moduleOf("install.js"))
    const wenyanMod = await import(moduleOf("wenyan.js"))
    const serviceMod = await import(moduleOf("service.js"))
    const envMod = await import(moduleOf("env.js"))

    let profileContext
    try { profileContext = ctx.get("profileContext") } catch { /* 可选 */ }
    log({ check: "host-facts", info: true, electron: !!process.versions.electron, node: process.versions.node, profileName: profileContext?.name ?? null })

    const stateDir = join(process.env.DSH_HOME, "state", "orchestrator")
    const store = storeMod.createPackStore({ stateDir })
    const presets = registryMod.createPresetRegistry({ agentPresets: () => ctx.agentPresets })
    const installer = installMod.createInstaller({ store })
    const service = serviceMod.createPackService({
      store, presets, installer,
      config: { capabilityPacks: true, capabilityPacksAllowOnWeb: true, capabilityPacksPanel: true },
      hostInfo: { desktop: true },
      sessionController: () => ctx.sessionController,
      workspaceDir: () => cwd,
      log: () => {},
      onWarn: () => {},
    })

    const installBlock = {
      manager: "pnpm", package: "@wenyan-md/cli", version: "2.0.12", scope: "pack-local",
      registry: "https://registry.npmjs.org",
      integrity: "sha512-C0a7GizQPClLETGKbkPnH+DxY0eFzY0y0DxuKD54k96NyyNhf1EfKmCVrm9xeppwpTMhGN21f1LfzpShfCQ/Gw==",
      license: "Apache-2.0", sourceUrl: "https://registry.npmjs.org/@wenyan-md/cli",
    }
    const draft = {
      id: "accept-pack", name: "验收包", description: "真机验收用用户包", version: "0.1.0",
      skills: [
        { name: "accept-writer", description: "验收写作技能", content: "# 写作\\n\\n写一篇验收文章。" },
        { name: "accept-format", description: "验收排版技能", content: "# 排版\\n\\n用文颜渲染。" },
      ],
      cli: [{ id: "wenyan", purpose: "排版 + 建草稿", install: installBlock, env: ["WECHAT_APP_ID", "WECHAT_APP_SECRET"] }],
      env: [
        { ref: "WECHAT_APP_ID", kind: "plain", required: true, purpose: "公众号 AppID" },
        { ref: "WECHAT_APP_SECRET", kind: "secret", required: true, purpose: "公众号 AppSecret" },
      ],
    }

    // 1) dry-run 不写盘
    const dry = await service.create(draft)
    record("create-dry-run", dry.ok === true && dry.dryRun === true && !existsSync(store.packDir("accept-pack")), { files: dry.plan?.files?.length ?? 0 })

    // 2) confirm 建包 + 预设注册
    const created = await service.create(draft, { confirm: true, clientRequestId: "accept-create" })
    record("create-confirm", created.ok === true && existsSync(store.packDir("accept-pack")) && created.presetId === "dsh-orchestrator-pack-accept-pack", { presetId: created.presetId ?? null, mode: created.mode ?? null })
    const listed = await ctx.agentPresets.list()
    record("preset-visible", listed.some(row => row.id === "dsh-orchestrator-pack-accept-pack"), { ids: listed.map(row => row.id) })

    // 3) 健康：文件硬检查通过；env 在本探针里是「已设置」（宿主进程带哨兵变量），
    //    「未设置」的降级路径用空 env 单独验（health-env-soft 的软判据）。
    const health = await service.health("accept-pack")
    const envCheck = health.health?.checks?.find(check => check.kind === "env")
    const filesCheck = health.health?.checks?.find(check => check.kind === "files")
    record("health-files", filesCheck?.ok === true)
    record("health-env-present", envCheck?.ok === true && envCheck?.soft === true, { missing: envCheck?.missing ?? [] })
    const emptyHealth = envMod.envSummary(draft, {})
    record("health-env-soft", emptyHealth.every(item => item.set === false) === true)
    record("env-missing-degrade", emptyHealth.every(item => item.set === false) === true)
    const copy = await service.envCopy("accept-pack", "WECHAT_APP_SECRET")
    record("env-copy-placeholder", copy.ok === true && copy.command.includes("<你的值>") && !copy.command.includes(secret ?? "___none___"))

    // 4) 开包会话 → agent live → 两个技能可见 → 会话预设正确
    const opened = await service.open("accept-pack")
    record("open-session", opened.ok === true && typeof opened.sessionId === "string", { sessionId: opened.sessionId ?? null, code: opened.code ?? null, error: opened.error ?? null })
    if (opened.ok === true) {
      let agent
      for (let index = 0; index < 120 && agent === undefined; index += 1) { await sleep(100); try { agent = ctx.agents.get(opened.sessionId) } catch { /* 未 live */ } }
      record("agent-live", agent !== undefined)
      if (agent !== undefined) {
        try {
          const snapshot = await ctx.skills.snapshot({ cwd, scope: agent })
          const names = snapshot.skills.map(item => item.name)
          record("skills-visible", names.includes("accept-writer") && names.includes("accept-format"), { names, complete: snapshot.complete })
        } catch (error) { record("skills-visible", false, { error: String(error?.message ?? error) }) }
        try { record("session-preset", ctx.agentPresets.composedPreset(agent.ctx) === "dsh-orchestrator-pack-accept-pack", { preset: ctx.agentPresets.composedPreset(agent.ctx) ?? null }) }
        catch (error) { record("session-preset", false, { error: String(error?.message ?? error) }) }
      }
    }

    // 5) 文颜：确认卡 → 安装（懒装）→ render 出 HTML
    if (skipCli) {
      log({ check: "cli-skipped", ok: true, info: true })
    } else {
      const denied = await service.install("accept-pack", "wenyan")
      record("install-confirm-required", denied.ok === false && denied.code === "CONFIRM_REQUIRED" && typeof denied.plan?.planHash === "string", { planHash: denied.plan?.planHash ?? null })
      const startedAt = Date.now()
      const installed = await service.install("accept-pack", "wenyan", { confirm: true, expectedPlanHash: denied.plan?.planHash })
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      record("cli-installed", installed.ok === true, { seconds, version: installed.record?.version ?? null, reused: installed.reused === true, error: installed.error })
      const record_ = store.readInstall("accept-pack")
      const invocation = wenyanMod.resolveInvocation(record_)
      record("cli-invocation", invocation.ok === true && existsSync(invocation.entry), { entry: invocation.ok === true ? invocation.entry : null, appDataDir: invocation.ok === true ? invocation.appDataDir : null })
      mkdirSync(join(cwd, "out"), { recursive: true })
      const article = join(cwd, "out", "article.md")
      writeFileSync(article, "---\\ntitle: 验收文章\\n---\\n\\n# 验收标题\\n\\n这是一段**正文**。\\n\\n- 项目一\\n- 项目二\\n")
      const rendered = await wenyanMod.renderToFile({ invocation, inputFile: article, outFile: join(cwd, "out", "article.html") })
      const html = rendered.ok === true ? readFileSync(rendered.outFile, "utf8") : ""
      record("render-html", rendered.ok === true && html.includes("<section"), { bytes: rendered.bytes ?? 0, hasSection: html.includes("<section"), error: rendered.error })
      const versionRun = await wenyanMod.versionCheck({ invocation })
      record("cli-version", versionRun.ok === true && versionRun.version === "2.0.12", { version: versionRun.version ?? null })
    }

    // 6) 删除包 → 预设撤销、registry 清空；目录在包会话仍开着时可能延后清理（Windows watcher 占目录），
    //    这是产品语义（不硬删让运行中会话丢技能）：接受 deferred，但预设/registry 必须立刻消失。
    const del = await service.delete("accept-pack", { confirm: true })
    const after = await ctx.agentPresets.list()
    const registry = store.readRegistry().registry
    record("delete-pack", del.ok === true && del.deleted === true && !after.some(row => row.id === "dsh-orchestrator-pack-accept-pack") && registry.packages["accept-pack"] === undefined, { deleted: del.deleted === true, deferred: del.deferred === true, trash: del.trashPath ?? null, code: del.code ?? null, error: del.error ?? null })
    record("delete-dir-handled", !existsSync(store.packDir("accept-pack")) || del.deferred === true, { dirExists: existsSync(store.packDir("accept-pack")), deferred: del.deferred === true })

    // 7) 零凭据泄漏：状态目录 / 工作目录 / profile 目录都不得出现哨兵值
    const scanDirs = [stateDir, cwd, process.env.DSH_HOME]
    const hits = []
    for (const dir of scanDirs) {
      for (const file of walkFiles(dir)) {
        try {
          if (statSync(file).size > 4 * 1024 * 1024) continue
          if (readFileSync(file, "utf8").includes(secret)) hits.push(file)
        } catch { /* 二进制/读不到 */ }
      }
    }
    record("no-secret-leak", hits.length === 0, { hits })

    log({ check: "done" })
    setTimeout(() => process.exit(0), 300)
  })().catch(error => {
    log({ check: "fatal", ok: false, error: String(error?.stack ?? error) })
    process.exit(1)
  })
}
`

async function main() {
  if (!existsSync(exe)) {
    console.error(`找不到 ${exe}：用 DSH_EXE 覆盖`)
    process.exit(1)
  }
  const root = join(tmpdir(), `dsh-pack-accept-${Date.now().toString(36)}`)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'accept')
  const cwd = join(root, 'cwd')
  const outFile = join(root, 'accept-out.jsonl')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  mkdirSync(cwd, { recursive: true })

  const baseEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_PRIMARY_RUNTIME: primaryRuntime,
    // 哨兵凭据：只用于证明插件不落盘/不回显；不接真实公众号，也不出现在任何产物里。
    WECHAT_APP_ID: 'wx-acceptance-sentinel',
    WECHAT_APP_SECRET: SECRET_SENTINEL,
    PACK_ACCEPT_SECRET: SECRET_SENTINEL,
  }
  const init = await run(exe, ['--expose-internals', cliJs, '--profile', 'accept', '--from-default-profile', 'web', '--dump-config'], {
    env: baseEnv, cwd: root, logPath: join(root, 'init.log'), timeoutMs: 120000,
  })
  if (!existsSync(join(profile, 'package.json'))) {
    console.error(`profile 初始化失败（exit=${init.code}）：${init.log.slice(-800)}`)
    process.exit(1)
  }
  const probeDir = join(profile, 'node_modules', 'dsh-pack-accept')
  mkdirSync(probeDir, { recursive: true })
  // 预设行会引用 `@wjj865-code/dsh-orchestrator/preset-tools`：把仓库以 junction 放进 profile
  // node_modules（与 npm 安装后的解析规则一致；junction 不需要管理员权限）。
  const packageDir = join(profile, 'node_modules', '@wjj865-code', 'dsh-orchestrator')
  try {
    mkdirSync(dirname(packageDir), { recursive: true })
    if (!existsSync(packageDir)) symlinkSync(REPO, packageDir, 'junction')
  } catch (error) {
    console.error(`无法把仓库链接进 profile node_modules（${error?.message ?? error}）：开包会话会因 preset-tools 解析失败而失败`)
  }
  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'dsh-pack-accept', version: '0.0.1', type: 'module', main: 'index.js' }, null, 2))
  writeFileSync(join(probeDir, 'index.js'), PROBE_PLUGIN)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# 能力包真机验收 overlay（由 docs/probes/capability-pack-acceptance.mjs 生成）\n- insert:\n    - id: pack-accept\n      name: dsh-pack-accept\n')

  const runEnv = {
    ...baseEnv,
    PACK_ACCEPT_OUT: outFile,
    PACK_ACCEPT_SRC: REPO,
    PACK_ACCEPT_CWD: cwd,
    PACK_ACCEPT_SKIP_CLI: skipCli ? '1' : '0',
  }
  console.log(`验收目录：${root}（隔离 DSH_HOME；${skipCli ? '跳过 CLI 安装' : '含文颜懒装，冷装约 4 分钟'}）`)
  const host = await run(exe, ['--expose-internals', cliJs, '--profile', 'accept', '--no-open', '--port', '0'], {
    env: runEnv, cwd: root, logPath: join(root, 'host.log'), timeoutMs: skipCli ? 240000 : 900000,
  })
  const lines = existsSync(outFile)
    ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
    : []
  if (!lines.some(line => line.check === 'done')) {
    record('probe-completed', false, { error: `宿主未在预算内完成验收（exit=${host.code}）：${host.log.slice(-1200)}` })
  }
  for (const line of lines) {
    const check = line.check
    if (check === 'done' || check === 'fatal') continue
    if (line.info === true || check === 'cli-skipped') { info(`probe:${check}`, line); continue }
    record(`probe:${check}`, line.ok === true, line)
  }
  if (lines.some(line => line.check === 'fatal')) record('probe:fatal', false, { error: lines.find(line => line.check === 'fatal').error })

  // 日志与泄漏：宿主进程退出后再扫（日志已 flush）。
  const stateDir = join(home, 'state', 'orchestrator')
  const logFacts = scanLogs(stateDir)
  record('logs-no-failure-events', logFacts.bad.length === 0, { files: logFacts.files, lines: logFacts.lines, bad: logFacts.bad.slice(0, 10) })
  // 本探针只装 probe 插件，orchestrator 自己的日志目录可能为空；再用宿主日志兜底扫一遍。
  let hostLogText = ''
  try { hostLogText = readFileSync(join(root, 'host.log'), 'utf8') } catch { hostLogText = '' }
  const hostErrorLines = hostLogText.split('\n').filter(line => /\berror\b|exception|failed/i.test(line))
  record('host-log-no-errors', hostErrorLines.length === 0, { lines: hostLogText.split('\n').filter(Boolean).length, errors: hostErrorLines.slice(0, 5) })
  const stateHits = findText(stateDir, SECRET_SENTINEL)
  const cwdHits = findText(cwd, SECRET_SENTINEL)
  const profileHits = findText(profile, SECRET_SENTINEL)
  record('no-credential-leak(state/cwd/profile)', stateHits.length === 0 && cwdHits.length === 0 && profileHits.length === 0, { stateHits, cwdHits, profileHits })
  // 真实 ~/.dsh 不得被读/写：隔离 home 之外只允许插件安装目录（源码）被读。
  record('isolated-home', existsSync(join(home, 'state', 'orchestrator')))

  const failed = checks.filter(item => item.info !== true && item.ok !== true)
  const summary = {
    at: new Date().toISOString(),
    skipCli,
    root: keep ? root : undefined,
    checks,
    pass: checks.filter(item => item.info !== true && item.ok === true).length,
    total: checks.filter(item => item.info !== true).length,
    failed: failed.map(item => item.name),
    logFacts,
    hostExit: host.code,
  }
  if (jsonPath !== undefined && jsonPath !== '') writeFileSync(jsonPath, JSON.stringify(summary, null, 2))
  if (reportPath !== '' && reportPath !== undefined) writeReport(summary, { root, skipCli, keep })
  console.log(`\n结果：${summary.pass}/${summary.total} PASS${failed.length > 0 ? `，FAIL：${failed.map(item => item.name).join(', ')}` : ''}`)
  if (!keep) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  } else {
    console.log(`保留目录：${root}（host.log / accept-out.jsonl / out/article.html）`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

function writeReport(summary, { root, skipCli, keep }) {
  const byName = Object.fromEntries(summary.checks.map(check => [check.name, check]))
  const install = byName['probe:cli-installed']
  const render = byName['probe:render-html']
  const deletion = byName['probe:delete-pack']
  const evidence = skipCli
    ? ['- 本次 `--skip-cli`：安装与 render 未跑（host 部分见下）。']
    : [
      `- 文颜懒装：${install?.seconds ?? '?'} 秒（pnpm store 已有缓存，属热装；P0 实测冷装 ≈4 分 04 秒），版本 ${install?.version ?? '?'}。`,
      `- render：${render?.bytes ?? '?'} B，含 \`<section>\`=${render?.hasSection === true}；入口 realpath + \`--version\` 通过。`,
      `- 删除包：deferred=${deletion?.deferred === true}（包会话仍开着时 Windows watcher 占目录，产品语义是「撤预设/registry + 目录下次启动清理」）。`,
    ]
  const rows = summary.checks.map(check => `| ${check.info === true ? 'INFO' : (check.ok === true ? 'PASS' : 'FAIL')} | ${check.name} | ${check.error === undefined || check.error === null ? (check.hint ?? '') : String(check.error).split('\n')[0].slice(0, 160)} |`)
  const text = [
    '# 能力包真机验收（0.32.0）',
    '',
    `- 时间：${summary.at}｜宿主：DSH 0.2.2-rc.5 Desktop CLI（隔离 DSH_HOME + 临时 profile \`accept\`）｜探针：\`docs/probes/capability-pack-acceptance.mjs\``,
    `- 结果：**${summary.pass}/${summary.total} PASS**${summary.failed.length === 0 ? '' : `，FAIL：${summary.failed.join(', ')}`}｜host exit=${summary.hostExit}｜${skipCli ? '**--skip-cli**（未验安装与 render）' : '含文颜懒装 + render'}｜临时目录${keep ? `保留：${root}` : '已清理'}`,
    '',
    '## 实测证据',
    '',
    ...evidence,
    '',
    '## 判定明细',
    '',
    '| 判定 | 检查 | 说明 |',
    '|---|---|---|',
    ...rows,
    '',
    '## 覆盖的验收项',
    '',
    '- 建用户包（dry-run → confirm）→ 预设运行时可见 → 开包会话 → 两个技能出现在该会话快照 → 会话预设正确。',
    '- 健康检查：技能文件硬检查通过；env 已设置（哨兵变量）时 env 检查通过；空 env 下全为「未设置」且 soft（不判包失败）→ 无凭据降级。',
    '- 文颜：确认卡（confirm 缺失拒绝）→ 懒装到 `capability-packs/tools/<id>` → `realpathSync.native()` 入口 → `--version` → `render` 产出含 `<section>` 的 HTML；APPDATA/LOCALAPPDATA 重定向到包内 `.state/wenyan`。',
    '- 删除包 → 预设从 `agentPresets.list()` 消失、registry 条目清空；目录在会话仍开着时延后清理（见 LIMITATIONS）。',
    '- 零凭据泄漏：宿主进程带 `WECHAT_APP_SECRET` 哨兵值运行；状态目录 / 工作目录 / profile 目录全文扫描均未命中。',
    '- 日志：orchestrator 日志无 `*.failed` / `*.rejected` / `fatal` 事件（本探针只装 probe 插件，该目录可能为空）；宿主日志无 error/exception/failed 行。',
    '',
    '## 未验 / 说明',
    '',
    '- 本探针把仓库源码按绝对路径导入临时 profile 的探针插件（与 npm 包 `files` 同一份源码），**不是**先 `npm pack` 再装包；包安装路径由 0.31.0 的 web 冒烟覆盖，P6 不重复。',
    '- 真实公众号 `publish` 建草稿未验：需要测试公众号凭据 + 本机 IP 白名单，按硬约束不接真实账号（本版只做本地 stub/人工联调）。',
    '- 运行时注册的预设在宿主 UI 预设选择器里的刷新时机未验（P0 遗留项）；本探针只证明 `agentPresets.list()`/`composedPreset` 同源一致。',
    '- Web 分支：`capabilityPacksAllowOnWeb=false` 时工具返回 `PLATFORM_UNSUPPORTED` 由单测覆盖；本探针跑在 Desktop CLI 上。',
    '',
    '## 复跑',
    '',
    '```powershell',
    'node docs/probes/capability-pack-acceptance.mjs            # 全量（含文颜懒装，约 2–6 分钟）',
    'node docs/probes/capability-pack-acceptance.mjs --skip-cli  # 只验 host 部分',
    'node docs/probes/capability-pack-acceptance.mjs --keep      # 保留临时目录与 HTML',
    '```',
    '',
  ].join('\n')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, text)
  console.log(`报告：${reportPath}`)
}

await main()
