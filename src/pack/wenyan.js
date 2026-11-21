// 文颜 CLI 封装（P5）：命令解析 / render 冒烟 / publish 结果解析 / 错误码映射 / 草稿记账。
//
// 设计边界（计划 §5）：
//   - 只封装 `render`（HTML 到文件）与 `publish`（**建草稿**，不是群发）；不做发布/群发接口；
//   - **不猜成功**：只有「exit 0 + 可解析的 Media ID」才算成功；否则把 stdout/stderr 尾部给用户，标 unknown；
//   - **不自动重试**：publish 无幂等，每次都会新建一条草稿；重复执行前必须问用户（`duplicateDraftPrompt`）；
//   - **凭据只走环境变量**：这里不读、不写、不打印 WECHAT_APP_ID/SECRET；环境原样透传；
//   - **APPDATA/LOCALAPPDATA 重定向**到包内 `.state/wenyan`（文颜会写 token 存储，P0 实测）；
//   - 入口必须是 realpath 真路径（pnpm junction 直接执行会 ERR_MODULE_NOT_FOUND，P0 实测）。

import { spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cliEnvironment } from './install.js'

/** 文颜默认主题/高亮（技能与确认卡文案共用）。 */
export const DEFAULT_THEME = 'default'
export const DEFAULT_HIGHLIGHT = 'solarized-light'

/** 草稿记录文件名（相对工作目录）。 */
export const DRAFT_RECORD = join('out', 'draft.json')

const TAIL = 8 * 1024
const text = value => (typeof value === 'string' ? value.trim() : '')

/**
 * 从 install.json 解析可执行调用。
 * @param {object | undefined} record - store.readInstall(id)
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {{ ok: true, node: string, entry: string, version: string, appDataDir?: string } | { ok: false, code: string, error: string }}
 */
export function resolveInvocation(record, { exists = existsSync } = {}) {
  if (record === undefined || record === null) {
    return { ok: false, code: 'CLI_NOT_INSTALLED', error: '文颜未安装：先到面板「能力包 → 公众号文章 → 安装 CLI」' }
  }
  if (record.status !== 'installed') {
    return { ok: false, code: 'CLI_NOT_INSTALLED', error: `文颜状态是 ${record.status ?? 'unknown'}：${record.error ?? '先安装/重装 CLI'}` }
  }
  const node = text(record.resolved?.node)
  const entry = text(record.resolved?.entry)
  if (node === '' || entry === '') return { ok: false, code: 'CLI_BROKEN', error: 'install.json 缺少 resolved.node / resolved.entry：重装 CLI' }
  if (!exists(node) || !exists(entry)) return { ok: false, code: 'CLI_BROKEN', error: `CLI 入口或解释器已不存在（${exists(node) ? entry : node}）：重装 CLI` }
  return { ok: true, node, entry, version: text(record.version), ...(text(record.appDataDir) === '' ? {} : { appDataDir: record.appDataDir }) }
}

/** 组装文颜 argv（数组，shell:false）。只允许本封装支持的子命令。 */
export function buildWenyanArgs({ command, file, theme = DEFAULT_THEME, extra = [] } = {}) {
  const allowed = new Set(['render', 'publish', 'theme', '--version'])
  if (!allowed.has(command)) throw new Error(`不支持的文颜命令：${command}`)
  if (command === '--version') return ['--version']
  const args = [command]
  if (command === 'theme') return [...args, ...(Array.isArray(extra) ? extra : [])]
  if (text(file) === '') throw new Error(`${command} 需要 -f <markdown 文件>`)
  args.push('-f', file)
  if (command === 'publish') {
    // 只用 env 凭据：不传 --app-id / --env-file（避免凭据落盘或写进命令行）。
    args.push('-t', text(theme) === '' ? DEFAULT_THEME : theme)
  } else {
    args.push('-t', text(theme) === '' ? DEFAULT_THEME : theme)
  }
  return args
}

/** 从 publish 输出里取 Media ID（`发布成功，Media ID: <id>`）；解析不到返回 undefined。 */
export function parseMediaId(stdout) {
  const match = /Media ID[:：]\s*([A-Za-z0-9_-]+)/i.exec(String(stdout ?? ''))
  return match === null ? undefined : match[1]
}

/** 文颜常见错误的可操作映射（不重试、不猜）。 */
export function classifyWenyanFailure({ stdout = '', stderr = '', exitCode } = {}) {
  const output = `${stdout}\n${stderr}`.toLowerCase()
  if (/invalid ip|ip.*白名单|not in the whitelist/.test(output)) {
    return {
      code: 'WECHAT_IP_NOT_ALLOWED',
      error: '本机出口 IP 不在公众号 IP 白名单（invalid ip）',
      hint: '到公众号后台「开发 → 基本配置 → IP 白名单」加上本机出口 IP；或换网络。插件不会自动重试。',
    }
  }
  if (/invalid appid|invalid secret|invalid appsecret|40013|40125|40001/.test(output)) {
    return {
      code: 'WECHAT_CREDENTIALS_INVALID',
      error: '公众号凭据无效（AppID/AppSecret 不匹配或已重置）',
      hint: '只核对环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET 是否设置正确（不打印值）；修改后彻底重启 DSH。',
    }
  }
  if (/image|图片|media.*(?:not exist|invalid)|40007|40009|40005|40006/.test(output)) {
    return { code: 'IMAGE_INVALID', error: '图片上传失败（路径不存在/格式不支持/过大）', hint: '按报错里的图片路径修正后重跑；不要循环重试。' }
  }
  if (/timeout|timed out|etimedout|econnreset/.test(output)) {
    return { code: 'NETWORK_FAILED', error: '网络/超时（建草稿可能已部分完成）', hint: '先确认草稿箱里有没有半成品；不要自动重试（会重复建草稿）。' }
  }
  if (/title.*(required|missing)|frontmatter/.test(output)) {
    return { code: 'FRONTMATTER_INVALID', error: 'Markdown frontmatter 不合法（title 必填）', hint: '在 out/article.md 顶部补 frontmatter（title 必填）。' }
  }
  return {
    code: 'WENYAN_FAILED',
    error: `文颜退出码 ${exitCode ?? '未知'}（未识别的错误）`,
    hint: '把 stdout/stderr 尾部给用户；不要改参数反复重试。',
  }
}

/**
 * 解析 publish 结果：只有 exit 0 + Media ID 才算成功。
 * @returns {{ ok: boolean, mediaId?: string, code?: string, error?: string, hint?: string }}
 */
export function parsePublishResult({ exitCode, stdout = '', stderr = '' } = {}) {
  if (exitCode === 0) {
    const mediaId = parseMediaId(stdout)
    if (mediaId !== undefined) return { ok: true, mediaId }
    return {
      ok: false,
      code: 'PUBLISH_UNKNOWN',
      error: 'publish 退出码 0，但输出里没有 Media ID',
      hint: '不猜成功：把 stdout/stderr 尾部给用户，标「结果未知」；重复执行前先问用户。',
    }
  }
  return { ok: false, ...classifyWenyanFailure({ stdout, stderr, exitCode }) }
}

/**
 * 默认执行器：stdout 可直接落文件（render），也可捕获为文本（publish/version）。
 * 返回 `{ code, timedOut, stdout, stderrTail, bytes, error }`；不抛。
 */
export function createWenyanRunner({ timeoutMs = 5 * 60 * 1000, tmpRoot = tmpdir() } = {}) {
  return async ({ command, args, env, cwd, stdoutFile }) => {
    const dir = join(tmpRoot, `dsh-wenyan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    const capture = stdoutFile === undefined
    const outFile = capture ? join(dir, 'stdout.log') : stdoutFile
    const errFile = join(dir, 'stderr.log')
    if (!capture) mkdirSync(dirname(outFile), { recursive: true })
    let outFd
    let errFd
    try {
      outFd = openSync(outFile, capture ? 'w' : 'w')
      errFd = openSync(errFile, 'w')
    } catch (error) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖原错 */ }
      return { code: undefined, timedOut: false, stdout: '', stderrTail: '', bytes: 0, error: String(error?.message ?? error) }
    }
    return await new Promise(resolve => {
      let settled = false
      const finish = (code, timedOut, error) => {
        if (settled) return
        settled = true
        try { closeSync(outFd) } catch { /* 已关 */ }
        try { closeSync(errFd) } catch { /* 已关 */ }
        const stderrText = readTail(errFile)
        let stdoutText = ''
        let bytes = 0
        try {
          bytes = statSync(outFile).size
          if (capture) stdoutText = readText(outFile).slice(-TAIL)
        } catch { /* 输出文件不存在：按空处理 */ }
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 同上 */ }
        resolve({ code, timedOut, stdout: stdoutText, stderrTail: stderrText, bytes, error: error === undefined ? undefined : String(error?.message ?? error) })
      }
      let child
      try {
        child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', outFd, errFd] })
      } catch (error) {
        finish(undefined, false, error)
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(undefined, true, new Error(`timeout ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('error', error => {
        clearTimeout(timer)
        finish(undefined, false, error)
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (signal !== null && code === null) finish(undefined, false, new Error(`signal ${signal}`))
        else finish(code, false, undefined)
      })
    })
  }
}

const readText = file => readFileSync(file, 'utf8')
const readTail = file => {
  try {
    return readText(file).slice(-TAIL)
  } catch {
    return ''
  }
}

/** 组装子进程环境：APPDATA/LOCALAPPDATA 固定到包内 `.state/wenyan`（不设时退回调用方 env）。 */
export function invocationEnv(invocation, env = process.env) {
  return cliEnvironment({ toolsDir: dirname(invocation.entry), appDataDir: invocation.appDataDir, env })
}

/** 一次 CLI 调用的通用外壳（runner 可注入；测试不需要真装文颜）。 */
async function runClip({ invocation, args, env, cwd, runner, timeoutMs, stdoutFile }) {
  if (invocation === undefined || invocation === null || invocation.ok !== true) {
    return { ok: false, code: invocation?.code ?? 'CLI_UNAVAILABLE', error: invocation?.error ?? '文颜调用未解析（先 resolveInvocation）' }
  }
  const execute = runner ?? createWenyanRunner({ timeoutMs })
  const result = await execute({
    command: invocation.node,
    args: [invocation.entry, ...args],
    env: invocationEnv(invocation, env),
    cwd,
    stdoutFile,
    timeoutMs,
  })
  return { ...result, ok: result.code === 0 && result.error === undefined }
}

/** `--version` 自检：成功时返回版本字符串。 */
export async function versionCheck({ invocation, env = process.env, runner, cwd } = {}) {
  const result = await runClip({ invocation, args: ['--version'], env, cwd, runner, timeoutMs: 60_000 })
  if (result.ok !== true) return { ok: false, code: result.code ?? 'VERSION_FAILED', error: result.error ?? '--version 失败', stdout: result.stdout ?? '' }
  return { ok: true, version: String(result.stdout ?? '').trim().slice(0, 64) }
}

/**
 * render → 文件（不联网、不需凭据）。
 * @returns {{ ok: boolean, outFile?: string, bytes?: number, code?: string, error?: string }}
 */
export async function renderToFile({ invocation, inputFile, outFile, theme = DEFAULT_THEME, env = process.env, runner, cwd, timeoutMs = 120_000 } = {}) {
  if (text(inputFile) === '' || text(outFile) === '') return { ok: false, code: 'ARGUMENT_MISSING', error: 'render 需要 inputFile 与 outFile' }
  if (!existsSync(inputFile)) return { ok: false, code: 'INPUT_MISSING', error: `Markdown 文件不存在：${inputFile}` }
  const args = buildWenyanArgs({ command: 'render', file: inputFile, theme })
  const result = await runClip({ invocation, args, env, cwd, runner, timeoutMs, stdoutFile: outFile })
  if (result.ok !== true) {
    const classified = result.error === undefined && result.code !== 0
      ? classifyWenyanFailure({ stdout: result.stdout, stderr: result.stderrTail, exitCode: result.code })
      : { code: result.code ?? 'RENDER_FAILED', error: result.error ?? 'render 失败' }
    return { ok: false, ...classified, stderrTail: result.stderrTail ?? '' }
  }
  let bytes = 0
  try { bytes = statSync(outFile).size } catch { bytes = 0 }
  if (bytes === 0) return { ok: false, code: 'RENDER_EMPTY', error: `render 退出码 0 但输出为空：${outFile}` }
  return { ok: true, outFile, bytes }
}

/** render 冒烟：包内 references/smoke.md → 临时文件 → 检查公众号 HTML 结构。 */
export async function renderSmoke({ invocation, smokeFile, env = process.env, runner, cwd, timeoutMs = 120_000 } = {}) {
  if (!existsSync(smokeFile)) return { ok: false, code: 'SMOKE_MISSING', error: `冒烟文件不存在：${smokeFile}` }
  const tmp = join(tmpdir(), `dsh-pack-smoke-${Date.now().toString(36)}.html`)
  try {
    const rendered = await renderToFile({ invocation, inputFile: smokeFile, outFile: tmp, env, runner, cwd, timeoutMs })
    if (rendered.ok !== true) return rendered
    const html = readFileSync(tmp, 'utf8')
    if (!/<section/i.test(html)) return { ok: false, code: 'SMOKE_INVALID', error: 'render 输出不像公众号 HTML（没有 <section>）' }
    return { ok: true, bytes: rendered.bytes }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不影响结果 */ }
  }
}

/** publish → 建草稿（**不做群发**）；成功时返回 Media ID 与 std，失败按错误码映射。 */
export async function publishDraft({ invocation, inputFile, theme = DEFAULT_THEME, env = process.env, runner, cwd, timeoutMs = 5 * 60 * 1000 } = {}) {
  if (text(inputFile) === '') return { ok: false, code: 'ARGUMENT_MISSING', error: 'publish 需要 inputFile' }
  if (!existsSync(inputFile)) return { ok: false, code: 'INPUT_MISSING', error: `Markdown 文件不存在：${inputFile}` }
  const args = buildWenyanArgs({ command: 'publish', file: inputFile, theme })
  const result = await runClip({ invocation, args, env, cwd, runner, timeoutMs })
  const parsed = parsePublishResult({ exitCode: result.code ?? null, stdout: result.stdout ?? '', stderr: result.stderrTail ?? '' })
  return {
    ...parsed,
    ...(parsed.ok === true ? { mediaId: parsed.mediaId } : {}),
    stdoutTail: String(result.stdout ?? '').slice(-TAIL),
    stderrTail: String(result.stderrTail ?? '').slice(-TAIL),
    timedOut: result.timedOut === true,
  }
}

/** 草稿记录路径（工作目录下 out/draft.json）。 */
export function draftRecordPath(workDir) {
  if (text(workDir) === '') throw new Error('draftRecordPath 需要 workDir')
  return join(workDir, DRAFT_RECORD)
}

/** 读已有草稿记录（不存在返回 undefined；坏 JSON 返回 error，不猜）。 */
export function readDraftRecord(workDir) {
  const file = draftRecordPath(workDir)
  try {
    return { record: JSON.parse(readFileSync(file, 'utf8')), path: file }
  } catch (error) {
    if (error?.code === 'ENOENT') return { record: undefined, path: file }
    return { record: undefined, path: file, error: `读取 ${file} 失败：${error?.message ?? error}` }
  }
}

/** 写草稿记录（含 mediaId/标题/时间；不含凭据）。 */
export function writeDraftRecord({ workDir, mediaId, title = '', theme = DEFAULT_THEME, now = Date.now } = {}) {
  if (text(mediaId) === '') throw new Error('writeDraftRecord 需要 mediaId')
  const file = draftRecordPath(workDir)
  mkdirSync(dirname(file), { recursive: true })
  const record = { mediaId, title, theme, at: new Date(now()).toISOString() }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { record, path: file }
}

/** 重复建草稿前的确认文案（publish 无幂等，每次都会新建一条）。 */
export function duplicateDraftPrompt(record) {
  if (record === undefined || record === null) return undefined
  const at = text(record.at) === '' ? '未知时间' : new Date(record.at).toISOString()
  return `已有草稿：Media ID ${record.mediaId}（${at}，标题「${record.title}」）。文颜没有幂等，再执行会新建一条草稿——确定要再建吗？`
}
