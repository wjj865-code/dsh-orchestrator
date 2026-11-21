// 能力包生成器（工厂 P3）：对话需求 → manifest + 文件树。
//
// 范围（计划 §3.1）：只生成「声明与文本」——`pack.json`、`skills/*/SKILL.md`、`references/*.md`。
// **不生成可执行脚本**：需要外部能力一律在 `cli` 里声明、由安装器装现成 CLI。
//
// 拒绝清单（任一命中直接返回 errors，不做「尽力而为」）：
//   - id / 技能名 / env 名不合法（交给 manifest 校验）；
//   - 幂等键重复（同 clientRequestId 不同内容）；
//   - publisher 不是 factory（内置包只读，工厂不能造「内置」包）；
//   - 任何绝对路径 / `..`（相对路径校验）。

import { normalizeRelativePath, relativePathProblem, skillRelPath, validateManifest } from './manifest.js'

/** 工厂生成的包默认版本（升级由用户改 draft.version）。 */
export const FACTORY_DEFAULT_VERSION = '0.1.0'

const text = value => (typeof value === 'string' ? value.trim() : '')
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 单条技能的默认骨架：draft 只给 name/description 时也能产出可用技能。 */
export function defaultSkillBody({ name, description }) {
  return [
    `# ${description || name}`,
    '',
    '## 什么时候用',
    '- 用户的需求与本技能描述匹配时使用。',
    '',
    '## 做法',
    '1. 先确认目标与验收（问清产出物、格式、放在哪里）。',
    '2. 在目标目录里完成工作；需要外部命令时先确认已安装（不要自己装依赖）。',
    '3. 交付前自检，并把结果与限制如实告诉用户。',
    '',
    '## 边界',
    '- 不处理与本技能无关的请求；不要伪造结果。',
    '- 不读取/打印任何凭据；凭据只认环境变量。',
  ].join('\n')
}

/** 组装一份 SKILL.md 文本（frontmatter + 正文）。 */
export function renderSkillMarkdown({ name, description, whenToUse, content }) {
  const body = text(content) === '' ? defaultSkillBody({ name, description }) : text(content)
  const lines = ['---', `name: ${name}`, `description: ${description}`]
  if (text(whenToUse) !== '') lines.push(`whenToUse: ${whenToUse}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

/**
 * draft → `{ ok, manifest, files, errors }`。
 * draft 形状（`capability_pack({action:'create', draft})`）：
 * ```jsonc
 * {
 *   "id": "my-pack", "name": "我的包", "description": "……",
 *   "preset": { "id": "dsh-orchestrator-pack-my-pack", "name": "我的包" },
 *   "skills": [{ "name": "my-skill", "description": "……", "content": "Markdown 正文", "whenToUse": "……" }],
 *   "references": [{ "path": "references/notes.md", "content": "……" }],
 *   "cli": [...], "env": [...], "research": [...]
 * }
 * ```
 * @param {object} draft
 * @param {{ now?: () => number }} [options]
 */
export function buildPackFromDraft(draft, { now = Date.now } = {}) {
  const errors = []
  if (!isObject(draft)) return { ok: false, errors: ['draft 必须是对象'] }
  if (draft.publisher !== undefined && draft.publisher !== 'factory') {
    errors.push('工厂只能生成 publisher=factory 的用户包（内置包只读，随插件发布）')
  }
  const id = text(draft.id)
  if (id === '') errors.push('draft.id 不能为空')
  const name = text(draft.name)
  if (name === '') errors.push('draft.name 不能为空')
  const description = text(draft.description)
  if (description === '') errors.push('draft.description 不能为空（面板与预设都要显示它）')
  const skills = Array.isArray(draft.skills) ? draft.skills : []
  if (skills.length === 0) errors.push('draft.skills 至少一个技能')
  const createdAt = new Date(now()).toISOString()

  const manifestRaw = {
    schemaVersion: 2,
    id,
    name,
    description,
    publisher: 'factory',
    version: text(draft.version) === '' ? FACTORY_DEFAULT_VERSION : text(draft.version),
    platforms: ['desktop'],
    ...(text(draft.hostBaseline) === '' ? {} : { hostBaseline: text(draft.hostBaseline) }),
    preset: {
      id: text(draft.preset?.id) === '' ? `dsh-orchestrator-pack-${id}` : text(draft.preset.id),
      name: text(draft.preset?.name) === '' ? name : text(draft.preset.name),
      description: text(draft.preset?.description) === '' ? `${description}（能力包会话）` : text(draft.preset.description),
      order: Number.isInteger(draft.preset?.order) ? draft.preset.order : 210,
    },
    skillsDir: text(draft.skillsDir) === '' ? 'skills' : draft.skillsDir,
    skills: skills.map(item => ({ name: text(item?.name), description: text(item?.description) })),
    cli: Array.isArray(draft.cli) ? draft.cli : [],
    env: Array.isArray(draft.env) ? draft.env : [],
    health: Array.isArray(draft.health) ? draft.health : undefined,
    research: Array.isArray(draft.research) ? draft.research : [],
    createdAt,
    updatedAt: createdAt,
  }
  const checked = validateManifest(manifestRaw)
  if (checked.ok !== true) return { ok: false, errors: [...errors, ...checked.errors] }
  if (errors.length > 0) return { ok: false, errors }

  const files = {}
  for (const [index, skill] of checked.manifest.skills.entries()) {
    const source = skills[index] ?? {}
    files[skillRelPath(checked.manifest, skill.name)] = renderSkillMarkdown({
      name: skill.name,
      description: skill.description,
      whenToUse: text(source.whenToUse),
      content: text(source.content),
    })
  }
  const references = Array.isArray(draft.references) ? draft.references : []
  for (const [index, ref] of references.entries()) {
    if (!isObject(ref)) { errors.push(`references[${index}] 必须是对象`); continue }
    const rawPath = text(ref.path)
    const problem = relativePathProblem(rawPath)
    if (problem !== undefined) { errors.push(`references[${index}].path：${problem}`); continue }
    const rel = normalizeRelativePath(rawPath)
    if (!rel.startsWith('references/')) { errors.push(`references[${index}].path 必须以 references/ 开头：${rawPath}`); continue }
    if (typeof ref.content !== 'string' || ref.content.trim() === '') { errors.push(`references[${index}].content 不能为空`); continue }
    if (Object.prototype.hasOwnProperty.call(files, rel)) { errors.push(`文件路径重复：${rel}`); continue }
    files[rel] = ref.content.endsWith('\n') ? ref.content : `${ref.content}\n`
  }
  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, errors: [], manifest: checked.manifest, files }
}

/** dry-run 的可读计划（工具与面板共用；不含任何凭据值）。 */
export function renderDryRun({ manifest, files }) {
  const fileLines = Object.keys(files).sort().map(path => `- ${path}（${files[path].length} 字）`)
  const cliLines = manifest.cli.length === 0
    ? ['- （无）']
    : manifest.cli.map(cli => `- ${cli.install.package}@${cli.install.version} → pnpm 装到 tools/${manifest.id}（需用户确认）`)
  const envLines = manifest.env.length === 0
    ? ['- （无）']
    : manifest.env.map(item => `- ${item.ref}（${item.kind}${item.required ? '，必填' : ''}）：${item.purpose}`)
  return [
    `将创建能力包「${manifest.name}」（${manifest.id} @ ${manifest.version}，publisher=${manifest.publisher}）：`,
    '【文件】',
    ...fileLines,
    '【预设】',
    `- ${manifest.preset.id}（order ${manifest.preset.order}）：包会话，工具面与任务执行者一致，但禁用 task_* / plan_save / capability_pack`,
    '【CLI（安装前会再给一张确认卡）】',
    ...cliLines,
    '【环境变量（只声明，不含值）】',
    ...envLines,
    '【不会做的事】不生成可执行脚本、不装任何东西、不写 PATH、不碰 ~/.dsh 凭据。',
    '确认后调用 capability_pack({ action: "create", confirm: true, clientRequestId, draft }) 才会写盘并注册预设。',
  ].join('\n')
}
