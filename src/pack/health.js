// 能力包健康检查（计划 §7.2）：三组 soft/硬检查，结果写 `.state/health.json` 并给面板/工具。
//
// - files：技能与 references 真在磁盘上（硬检查；缺了就是包坏了）；
// - env：只查存在性（soft：未设置不判包失败，包会话仍可写文章）；
// - command：CLI 是否 installed（soft：未装不下判包失败，只显示 cli: unavailable）。
//
// 不执行任何 CLI（`--version` 在安装校验时已跑过）：面板轮询要便宜、可预期，
// 也不该在「只打开面板」时起子进程。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { envPresence } from './env.js'
import { defaultHealth } from './manifest.js'

/**
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.packRoot
 * @param {string} options.id
 * @param {{ statusOf: (manifest: object, cliId: string) => object }} [options.installer]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(ref: string) => boolean} [options.persistedEnv]
 * @param {(path: string) => boolean} [options.exists]
 * @param {() => number} [options.now]
 */
export function checkPackHealth({
  manifest, packRoot, id, installer, env = process.env, persistedEnv, exists = existsSync, now = Date.now,
}) {
  const declared = Array.isArray(manifest.health) && manifest.health.length > 0 ? manifest.health : defaultHealth(manifest)
  const checks = []
  for (const item of declared) {
    const spec = item.spec ?? {}
    if (item.kind === 'files') {
      const paths = Array.isArray(spec.paths) ? spec.paths : []
      const missing = paths.filter(path => !exists(join(packRoot, path)))
      checks.push({ id: item.id, kind: item.kind, soft: item.soft === true, ok: missing.length === 0, ...(missing.length === 0 ? {} : { missing }) })
    } else if (item.kind === 'env') {
      const refs = Array.isArray(spec.refs) ? spec.refs : []
      const missing = refs.filter(ref => !envPresence(ref, env, { persistedEnv }).set)
      checks.push({ id: item.id, kind: item.kind, soft: item.soft !== false, ok: missing.length === 0, ...(missing.length === 0 ? {} : { missing }) })
    } else if (item.kind === 'command') {
      const cli = manifest.cli[0]
      const status = cli === undefined || installer === undefined
        ? (cli === undefined ? 'installed' : 'unknown')
        : (installer.statusOf(manifest, cli.id).status ?? 'unknown')
      checks.push({ id: item.id, kind: item.kind, soft: item.soft !== false, ok: status === 'installed', status })
    }
  }
  return {
    id,
    at: now(),
    ok: checks.every(check => check.ok === true || check.soft === true),
    checks,
  }
}

/** 健康结果压成一行（工具/面板文案共用）。 */
export function healthLine(health) {
  if (health === undefined || health === null) return '健康：未检查'
  const bad = health.checks.filter(check => check.ok !== true && check.soft !== true)
  const warn = health.checks.filter(check => check.ok !== true && check.soft === true)
  const parts = []
  if (bad.length > 0) parts.push(`失败 ${bad.map(check => check.id).join('、')}`)
  if (warn.length > 0) parts.push(`待处理 ${warn.map(check => `${check.id}${check.missing ? `（缺 ${check.missing.join('/')}）` : ''}`).join('、')}`)
  if (parts.length === 0) return '健康：全部通过'
  return `健康：${parts.join('；')}`
}
