// 能力包 manifest（schemaVersion 2）：唯一真源是 `pack.json`。
//
// 为什么把校验单独成模块：manifest 有三个写入方（内置包随包发、工厂 `capability_pack` 生成、
// 用户手改），却只有一个消费者（store / 预设 / 安装器 / 面板）。校验散在生成器里，
// 手改出来的包就能绕过「精确版本 / registry 白名单 / 路径不越界」这些硬约束。
//
// 硬约束（与计划 §2.1 / §3.1 / §6.2 一致，测试锁住）：
//   1. 任何路径字段都是**相对包根**的相对路径，拒绝绝对路径 / 盘符 / `..` / NUL；
//   2. CLI 只认 pnpm、精确 semver、registry 白名单（npm 官方）、license/sourceUrl/integrity 必填；
//   3. env 只声明变量名与用途，**不带任何值**（插件不落盘、不读值）；
//   4. 技能名 kebab-case 且不重复；health 只认 files / command / env 三种。
//
// 返回值统一 `{ ok, errors, manifest }`：`ok === false` 时 `manifest` 是 undefined，
// 调用方只需把 `errors` 原样展示（中文、可操作），不要自行猜哪条能忽略。

import { parseSkillMarkdown } from '../../skill-grill-me.js'

export const PACK_SCHEMA_VERSION = 2

/** 包 id / 预设 id / 技能名 / env 名 / 精确版本 / npm 包名（含 scope）的语法。 */
export const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/
export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ENV_REF = /^[A-Z_][A-Z0-9_]*$/
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
export const NPM_PACKAGE = /^(@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/

/** 允许的 registry（供应链白名单）：只有 npm 官方；装包时再以 `--registry` 显式覆盖。 */
export const REGISTRY_ALLOWLIST = Object.freeze(['https://registry.npmjs.org'])

/** 第一版只支持 pnpm + 包内安装 + Desktop。 */
export const CLI_MANAGERS = Object.freeze(['pnpm'])
export const CLI_SCOPES = Object.freeze(['pack-local'])
export const PLATFORMS = Object.freeze(['desktop'])
export const ENV_KINDS = Object.freeze(['secret', 'plain'])
export const HEALTH_KINDS = Object.freeze(['files', 'command', 'env'])
export const PUBLISHERS = Object.freeze(['builtin', 'factory'])

/** 内置公众号包的 CLI 标识（技能正文与安装器共用，避免两处写死字符串）。 */
export const WENYAN_CLI_ID = 'wenyan'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value.trim() : '')

/**
 * 相对路径校验：返回中文问题描述，合法时 undefined。
 * 只接受 `a/b/c` 这种相对包根的路径：绝对路径、盘符、`~`、`..`、NUL 全拒。
 */
export function relativePathProblem(value, { allowEmpty = false } = {}) {
  const raw = text(value)
  if (raw === '') return allowEmpty ? undefined : '路径不能为空'
  if (raw.includes('\u0000')) return `路径含非法字符：${JSON.stringify(raw)}`
  const normalized = raw.replaceAll('\\', '/')
  if (/^[A-Za-z]:/.test(normalized)) return `必须是相对包根的路径，不接受盘符：${raw}`
  if (normalized.startsWith('/') || normalized.startsWith('~')) return `必须是相对包根的路径，不接受绝对路径：${raw}`
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..')) return `路径不允许包含 ..：${raw}`
  if (segments.some(segment => segment === '')) return `路径含空段（//）：${raw}`
  return undefined
}

/** 归一化相对路径：统一 `/`、去掉前导 `./`。调用前先用 {@link relativePathProblem} 校验。 */
export function normalizeRelativePath(value) {
  return text(value).replaceAll('\\', '/').replace(/^\.\//, '')
}

/** 版本必须是精确版本：禁止 `latest` / `^` / `~` / 范围（自动跟随补丁 = 供应链失控）。 */
export function exactVersionProblem(value) {
  const raw = text(value)
  if (raw === '') return '版本不能为空'
  if (raw === 'latest') return '禁止 latest：必须写精确版本（如 2.0.12）'
  if (/^[\^~<>=\s]/.test(raw) || /\s/.test(raw) || /\*/.test(raw) || /^[xX]$/.test(raw)) {
    return `必须是精确版本，禁止范围/latest/tag：${raw}`
  }
  if (!EXACT_VERSION.test(raw)) return `版本格式不合法（应为 x.y.z）：${raw}`
  return undefined
}

/**
 * 校验并归一化一个 manifest。**不读取磁盘**，纯函数（测试与生成器共用）。
 * @param {unknown} raw - `pack.json` 解析后的对象（或工厂 draft 的 manifest 部分）。
 * @returns {{ ok: boolean, errors: string[], manifest?: object }}
 */
export function validateManifest(raw) {
  const errors = []
  const fail = message => errors.push(message)
  if (!isObject(raw)) return { ok: false, errors: ['manifest 必须是对象'] }

  if (raw.schemaVersion !== PACK_SCHEMA_VERSION) {
    fail(`schemaVersion 必须是 ${PACK_SCHEMA_VERSION}（收到 ${JSON.stringify(raw.schemaVersion ?? null)}）`)
  }
  const id = text(raw.id)
  if (!PACK_ID.test(id)) fail(`id 不合法（小写字母/数字/连字符，2–64 位）：${JSON.stringify(raw.id ?? null)}`)
  const name = text(raw.name)
  if (name === '') fail('name 不能为空')
  else if (name.length > 80) fail(`name 太长（≤80 字）：${name.length}`)
  const description = text(raw.description)
  if (description.length > 300) fail(`description 太长（≤300 字）：${description.length}`)
  const publisher = text(raw.publisher)
  if (!PUBLISHERS.includes(publisher)) fail(`publisher 只能是 ${PUBLISHERS.join(' / ')}：${JSON.stringify(raw.publisher ?? null)}`)
  const versionProblem = exactVersionProblem(raw.version)
  if (versionProblem !== undefined) fail(`version ${versionProblem}`)
  const platforms = Array.isArray(raw.platforms) ? raw.platforms.map(text) : []
  if (platforms.length === 0) fail('platforms 不能为空（第一版只支持 desktop）')
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) fail(`不支持的 platform：${platform}（只支持 ${PLATFORMS.join(' / ')}）`)
  }
  const hostBaseline = text(raw.hostBaseline)

  // ── preset ────────────────────────────────────────────────
  let preset
  if (!isObject(raw.preset)) {
    fail('preset 必须是对象（id/name/description/order）')
  } else {
    const presetId = text(raw.preset.id)
    if (!PRESET_ID.test(presetId)) fail(`preset.id 不合法（小写字母/数字/连字符）：${JSON.stringify(raw.preset.id ?? null)}`)
    if (text(raw.preset.name) === '') fail('preset.name 不能为空')
    const order = raw.preset.order
    if (order !== undefined && (!Number.isFinite(order) || !Number.isInteger(order))) fail(`preset.order 必须是整数：${JSON.stringify(order)}`)
    preset = {
      id: presetId,
      name: text(raw.preset.name),
      description: text(raw.preset.description),
      order: Number.isInteger(order) ? order : 200,
    }
  }

  // ── 技能目录与技能清单 ─────────────────────────────────────
  const skillsDirProblem = relativePathProblem(raw.skillsDir ?? 'skills')
  if (skillsDirProblem !== undefined) fail(`skillsDir ${skillsDirProblem}`)
  const skillsDir = normalizeRelativePath(raw.skillsDir ?? 'skills')
  const skills = []
  if (!Array.isArray(raw.skills) || raw.skills.length === 0) {
    fail('skills 必须是非空数组（至少一个技能）')
  } else {
    const seen = new Set()
    for (const [index, item] of raw.skills.entries()) {
      if (!isObject(item)) { fail(`skills[${index}] 必须是对象`); continue }
      const skillName = text(item.name)
      if (!SKILL_NAME.test(skillName)) fail(`skills[${index}].name 不是 kebab-case：${JSON.stringify(item.name ?? null)}`)
      if (seen.has(skillName)) fail(`技能名重复：${skillName}`)
      seen.add(skillName)
      if (text(item.description) === '') fail(`skills[${index}].description 不能为空`)
      skills.push({ name: skillName, description: text(item.description) })
    }
  }

  // ── CLI 声明 ───────────────────────────────────────────────
  const cli = []
  if (raw.cli !== undefined && !Array.isArray(raw.cli)) fail('cli 必须是数组')
  for (const [index, item] of (Array.isArray(raw.cli) ? raw.cli : []).entries()) {
    const label = `cli[${index}]`
    if (!isObject(item)) { fail(`${label} 必须是对象`); continue }
    const cliId = text(item.id)
    if (!SKILL_NAME.test(cliId)) fail(`${label}.id 不合法（kebab-case）：${JSON.stringify(item.id ?? null)}`)
    if (text(item.purpose) === '') fail(`${label}.purpose 不能为空`)
    const install = isObject(item.install) ? item.install : undefined
    if (install === undefined) { fail(`${label}.install 必须是对象`); continue }
    if (!CLI_MANAGERS.includes(text(install.manager))) fail(`${label}.install.manager 只支持 ${CLI_MANAGERS.join(' / ')}`)
    if (!NPM_PACKAGE.test(text(install.package))) fail(`${label}.install.package 不是合法 npm 包名：${JSON.stringify(install.package ?? null)}`)
    const cliVersionProblem = exactVersionProblem(install.version)
    if (cliVersionProblem !== undefined) fail(`${label}.install.version ${cliVersionProblem}`)
    if (!CLI_SCOPES.includes(text(install.scope))) fail(`${label}.install.scope 只支持 ${CLI_SCOPES.join(' / ')}（不写全局、不改 PATH）`)
    if (!REGISTRY_ALLOWLIST.includes(text(install.registry))) {
      fail(`${label}.install.registry 不在白名单（只允许 ${REGISTRY_ALLOWLIST.join(' / ')}）：${JSON.stringify(install.registry ?? null)}`)
    }
    if (text(install.integrity) === '') fail(`${label}.install.integrity 必填（钉死 tarball 摘要）`)
    if (text(install.license) === '') fail(`${label}.install.license 必填（跟随包许可与 NOTICE 要求）`)
    if (text(install.sourceUrl) === '') fail(`${label}.install.sourceUrl 必填（可追溯来源）`)
    const envRefs = Array.isArray(item.env) ? item.env.map(text) : []
    for (const ref of envRefs) {
      if (!ENV_REF.test(ref)) fail(`${label}.env 里的变量名不合法：${JSON.stringify(ref)}`)
    }
    cli.push({
      id: cliId,
      purpose: text(item.purpose),
      optional: item.optional !== false,
      install: {
        manager: text(install.manager),
        package: text(install.package),
        version: text(install.version),
        scope: text(install.scope),
        registry: text(install.registry),
        integrity: text(install.integrity),
        license: text(install.license),
        sourceUrl: text(install.sourceUrl),
        ...(text(install.provenance) === '' ? {} : { provenance: text(install.provenance) }),
      },
      env: envRefs,
      ...(text(item.docs) === '' ? {} : { docs: text(item.docs) }),
      ...(text(item.notes) === '' ? {} : { notes: text(item.notes) }),
    })
  }

  // ── env 声明（只声明引用，不含值） ───────────────────────────
  const env = []
  if (raw.env !== undefined && !Array.isArray(raw.env)) fail('env 必须是数组')
  const envSeen = new Set()
  for (const [index, item] of (Array.isArray(raw.env) ? raw.env : []).entries()) {
    const label = `env[${index}]`
    if (!isObject(item)) { fail(`${label} 必须是对象`); continue }
    const ref = text(item.ref)
    if (!ENV_REF.test(ref)) fail(`${label}.ref 不合法（大写字母/数字/下划线，且不以数字开头）：${JSON.stringify(item.ref ?? null)}`)
    if (envSeen.has(ref)) fail(`env 变量名重复：${ref}`)
    envSeen.add(ref)
    const kind = text(item.kind) || 'secret'
    if (!ENV_KINDS.includes(kind)) fail(`${label}.kind 只能是 ${ENV_KINDS.join(' / ')}：${JSON.stringify(item.kind ?? null)}`)
    if (text(item.purpose) === '') fail(`${label}.purpose 不能为空（UI 要显示用途）`)
    // 值字段绝不允许出现在 manifest 里（插件不落盘凭据）。
    for (const forbidden of ['value', 'default', 'secret', 'token']) {
      if (Object.prototype.hasOwnProperty.call(item, forbidden)) {
        fail(`${label} 不得包含 ${forbidden} 字段：manifest 只声明变量名，不落盘任何值`)
      }
    }
    env.push({
      ref,
      kind,
      required: item.required !== false,
      purpose: text(item.purpose),
      consumers: Array.isArray(item.consumers) ? item.consumers.map(text).filter(Boolean) : [],
      ...(text(item.docs) === '' ? {} : { docs: text(item.docs) }),
    })
  }

  // ── health ────────────────────────────────────────────────
  const health = []
  if (raw.health !== undefined && !Array.isArray(raw.health)) fail('health 必须是数组')
  for (const [index, item] of (Array.isArray(raw.health) ? raw.health : []).entries()) {
    const label = `health[${index}]`
    if (!isObject(item)) { fail(`${label} 必须是对象`); continue }
    const healthId = text(item.id)
    if (!SKILL_NAME.test(healthId)) fail(`${label}.id 不合法：${JSON.stringify(item.id ?? null)}`)
    const kind = text(item.kind)
    if (!HEALTH_KINDS.includes(kind)) { fail(`${label}.kind 只能是 ${HEALTH_KINDS.join(' / ')}：${JSON.stringify(item.kind ?? null)}`); continue }
    const spec = isObject(item.spec) ? item.spec : {}
    if (kind === 'files') {
      const paths = Array.isArray(spec.paths) ? spec.paths : []
      if (paths.length === 0) fail(`${label}.spec.paths 不能为空`)
      for (const file of paths) {
        const problem = relativePathProblem(file)
        if (problem !== undefined) fail(`${label}.spec.paths 里的 ${problem}`)
      }
    } else if (kind === 'env') {
      const refs = Array.isArray(spec.refs) ? spec.refs : []
      if (refs.length === 0) fail(`${label}.spec.refs 不能为空`)
      for (const ref of refs) {
        if (!ENV_REF.test(text(ref))) fail(`${label}.spec.refs 里的变量名不合法：${JSON.stringify(ref)}`)
      }
    }
    health.push({ id: healthId, kind, spec: { ...spec }, soft: item.soft !== false })
  }

  // ── research / 时间戳（可选，原样保留可追溯信息） ─────────────
  const research = (Array.isArray(raw.research) ? raw.research : [])
    .filter(item => isObject(item) && text(item.url) !== '')
    .map(item => ({
      url: text(item.url),
      title: text(item.title),
      ...(text(item.fetchedAt) === '' ? {} : { fetchedAt: text(item.fetchedAt) }),
      ...(text(item.note) === '' ? {} : { note: text(item.note) }),
    }))

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    manifest: {
      schemaVersion: PACK_SCHEMA_VERSION,
      id,
      name,
      description,
      publisher,
      version: text(raw.version),
      platforms,
      ...(hostBaseline === '' ? {} : { hostBaseline }),
      preset,
      skillsDir,
      skills,
      cli,
      env,
      health,
      research,
      ...(text(raw.createdAt) === '' ? {} : { createdAt: text(raw.createdAt) }),
      ...(text(raw.updatedAt) === '' ? {} : { updatedAt: text(raw.updatedAt) }),
    },
  }
}

/**
 * 校验一份技能文件：frontmatter 合法、name 与清单一致、description 非空。
 * @param {string} text - SKILL.md 原文
 * @param {{ file?: string, expectedName?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], skill?: object }}
 */
export function validateSkillMarkdown(text, { file = 'SKILL.md', expectedName } = {}) {
  try {
    const skill = parseSkillMarkdown(text, { file })
    if (expectedName !== undefined && skill.name !== expectedName) {
      return { ok: false, errors: [`${file}：frontmatter name 是「${skill.name}」，与清单里的「${expectedName}」不一致`] }
    }
    return { ok: true, errors: [], skill }
  } catch (error) {
    return { ok: false, errors: [`${file}：${error?.message ?? error}`] }
  }
}

/** 从 manifest 生成健康检查的默认声明（没有 health 时补一份最小集）。 */
export function defaultHealth(manifest) {
  const health = [
    { id: 'skills', kind: 'files', spec: { paths: manifest.skills.map(skill => `${manifest.skillsDir}/${skill.name}/SKILL.md`) }, soft: false },
  ]
  if (manifest.cli.length > 0) {
    health.push({ id: 'cli', kind: 'command', spec: { command: [...manifest.cli.map(item => `cli:${item.id}`), '--version'], expectExit: 0 }, soft: true })
  }
  if (manifest.env.length > 0) {
    health.push({ id: 'env', kind: 'env', spec: { refs: manifest.env.map(item => item.ref) }, soft: true })
  }
  return health
}

/** 包根下技能文件的相对路径（store / 生成器 / 健康检查共用一处拼法）。 */
export function skillRelPath(manifest, skillName) {
  return `${manifest.skillsDir}/${skillName}/SKILL.md`
}
