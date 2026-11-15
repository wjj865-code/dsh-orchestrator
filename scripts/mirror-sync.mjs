#!/usr/bin/env node
// 发版后把新版本推给 npmmirror（registry.npmmirror.com）镜像。
//
// 为什么需要它：`npm publish` 只落在 registry.npmjs.org。npmmirror 是另一套库，
// 新版本靠它自己的后台按需/定时回源，常常几十分钟到几小时才出现——这段时间国内
// 用户 `npm i @wjj865-code/dsh-orchestrator@latest`（默认走镜像）拿到的还是旧版。
// 主动 PUT 一次同步请求，能把等待从「小时级」压到「分钟级」。
//
// 用法：
//   node scripts/mirror-sync.mjs                  # 触发同步并等镜像出现（默认最多 180s）
//   node scripts/mirror-sync.mjs --check          # 只查镜像现在有没有这个版本（不触发）
//   node scripts/mirror-sync.mjs --no-wait        # 只触发，不等
//   node scripts/mirror-sync.mjs --timeout 600    # 改等待上限（秒，默认 180）
//   node scripts/mirror-sync.mjs --interval 5     # 改轮询间隔（秒，默认 10）
//   node scripts/mirror-sync.mjs --version 0.11.0 # 查/同步指定版本（默认取 package.json）
//   node scripts/mirror-sync.mjs --package @scope/name
//
// 退出码：0 = 镜像已有该版本（或 --no-wait 触发成功）；1 = 上游没有该版本 /
// 触发失败 / 等到超时仍未出现。所有失败都打印可读原因，不抛栈。
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ENDPOINT = 'https://registry.npmmirror.com'
export const UPSTREAM = 'https://registry.npmjs.org'
const USAGE =
  '用法：node scripts/mirror-sync.mjs [--check] [--no-wait] [--timeout <秒>] [--interval <秒>] [--version <x.y.z>] [--package <name>]'

// 同步触发接口：PUT /-/package/:name/syncs（名字要 URL 编码，@scope%2Fname）。
export function syncUrl(name, endpoint = ENDPOINT) {
  return `${endpoint}/-/package/${encodeURIComponent(name)}/syncs`
}

// 读 packument 用简写格式（体积小、带 dist-tags）；scoped 包的 / 必须编码。
export function packumentUrl(name, endpoint = ENDPOINT) {
  return `${endpoint}/${name.replace('/', '%2F')}`
}

// 从 packument 摘出「镜像我关心的状态」，字段缺失一律当空，绝不上抛。
export function readMirrorState(packument) {
  const distTags = packument?.['dist-tags'] ?? {}
  const versions = packument?.versions !== null && typeof packument?.versions === 'object' ? Object.keys(packument.versions) : []
  return { latest: typeof distTags.latest === 'string' ? distTags.latest : undefined, versions }
}

// 镜像算「已同步」的判定：latest 指向它，或版本列表里已经有它。
export function isSynced(state, version) {
  return state.latest === version || state.versions.includes(version)
}

function describe(state) {
  return state.latest === undefined ? '镜像暂无 dist-tags' : `镜像 latest = ${state.latest}`
}

async function fetchPackument(name, endpoint = ENDPOINT) {
  const response = await fetch(packumentUrl(name, endpoint), {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (response.status === 404) return { ok: true, state: { latest: undefined, versions: [] } }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, hint: packumentUrl(name, endpoint) }
  try {
    return { ok: true, state: readMirrorState(await response.json()) }
  } catch {
    return { ok: false, reason: '响应不是 JSON', hint: packumentUrl(name, endpoint) }
  }
}

async function triggerSync(name, endpoint = ENDPOINT) {
  const url = syncUrl(name, endpoint)
  let response
  try {
    response = await fetch(url, { method: 'PUT' })
  } catch (error) {
    return { ok: false, reason: `请求失败（${error.message}）`, hint: url }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status} ${text.slice(0, 200)}`, hint: url }
  return { ok: true, url, body: text.slice(0, 400) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseArgs(argv) {
  const args = { check: false, wait: true, timeout: 180, interval: 10, version: undefined, packageName: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') args.check = true
    else if (arg === '--no-wait') args.wait = false
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--timeout') args.timeout = Number(argv[++index])
    else if (arg === '--interval') args.interval = Number(argv[++index])
    else if (arg === '--version') args.version = argv[++index]
    else if (arg === '--package') args.packageName = argv[++index]
    else throw new Error(`未知参数：${arg}\n${USAGE}`)
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error(`--timeout 要是正数秒\n${USAGE}`)
  if (!Number.isFinite(args.interval) || args.interval <= 0) throw new Error(`--interval 要是正数秒\n${USAGE}`)
  return args
}

async function readPackageManifest() {
  const here = dirname(fileURLToPath(import.meta.url))
  const text = await readFile(join(here, '..', 'package.json'), 'utf8')
  const manifest = JSON.parse(text)
  return { name: manifest.name, version: manifest.version }
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    return 1
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  let name = args.packageName
  let version = args.version
  if (name === undefined || version === undefined) {
    const manifest = await readPackageManifest()
    name ??= manifest.name
    version ??= manifest.version
  }
  console.log(`包：${name}@${version}`)

  const mirrorBefore = await fetchPackument(name)
  if (!mirrorBefore.ok) {
    console.error(`读镜像失败：${mirrorBefore.reason}（${mirrorBefore.hint}）`)
    return 1
  }
  if (isSynced(mirrorBefore.state, version)) {
    console.log(`镜像已有 ${version}（${describe(mirrorBefore.state)}）：无需同步`)
    return 0
  }
  console.log(`镜像缺 ${version}（${describe(mirrorBefore.state)}）`)

  // 上游没有就同步不到：先拦住，别让人对着超时瞎等。
  const upstream = await fetchPackument(name, UPSTREAM)
  if (!upstream.ok) {
    console.error(`读上游 registry.npmjs.org 失败：${upstream.reason}（${upstream.hint}）`)
    return 1
  }
  if (!isSynced(upstream.state, version)) {
    console.error(`上游 npm 还没有 ${version}（registry.npmjs.org latest = ${upstream.state.latest ?? '—'}）：先让 release.yml 发布成功再同步镜像`)
    return 1
  }
  console.log(`上游 npm 已有 ${version}，可以触发镜像同步`)

  if (args.check) {
    console.error('--check 只查询不触发：镜像还没有这个版本（去掉 --check 才会 PUT 同步请求）')
    return 1
  }

  const triggered = await triggerSync(name)
  if (!triggered.ok) {
    console.error(`触发同步失败：${triggered.reason}（${triggered.hint}）`)
    return 1
  }
  console.log(`已提交同步请求：PUT ${triggered.url}`)
  console.log(`  响应：${triggered.body === '' ? '（空）' : triggered.body}`)
  if (!args.wait) {
    console.log('未等待（--no-wait）：npmmirror 后台会继续同步，稍后用 --check 复查')
    return 0
  }

  const deadline = Date.now() + args.timeout * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    await sleep(args.interval * 1000)
    attempt += 1
    const state = await fetchPackument(name)
    if (state.ok && isSynced(state.state, version)) {
      console.log(`镜像已就绪（第 ${attempt} 次轮询，约 ${attempt * args.interval}s）：${describe(state.state)}`)
      return 0
    }
    console.log(`  第 ${attempt} 次轮询：还没出现（${state.ok ? describe(state.state) : `读镜像失败：${state.reason}`}）`)
  }
  console.error(`等满 ${args.timeout}s 镜像仍没有 ${version}：npmmirror 后台可能还在排队，稍后重跑 --check 复查`)
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
