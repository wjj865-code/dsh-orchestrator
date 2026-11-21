// grill-me 技能：把随包发出去的 `skills/grill-me/SKILL.md` 注册成**预设作用域**的运行时技能。
//
// 为什么是独立模块而不是 index.js 里的 apply：`ctx.skills.register()` 把技能登记进**调用方 context 的
// 作用域**（dsh-skill 的 SkillRegistry 分层：预设挂载的插件进该预设层，unscoped 插件进全局层）。
// 这个模块只由协调者预设挂载（cordis.patch.yml），所以协调者会话看得到 grill-me，worker 预设没挂
// 就看不到——不需要靠工具收窄去「遮」。
//
// 为什么注册运行时技能而不是 customSkillDirs 指目录：patch 里的 `!!js` 表达式在磁盘上求值，
// `createRequire(baseUrl)` 在 bundle 里会 MODULE_NOT_FOUND（test/config.test.js 锁了这条）。
// 运行时注册只需要 SKILL.md 文本，路径用 `import.meta.url` 解析，安装目录在哪都成立。
//
// 失败形态：SKILL.md 缺失/格式不合法时只 warn 并跳过注册——技能是增强项，不能因为它让协调者预设挂载失败。
// 技能名的合法性最终由平台校验（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/` + description 非空），这里先自查一遍给出可读报错。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-orchestrator-skill-grill-me'

/** 需要 skills 注册表服务（宿主 plane 提供，与 web-app 的预设开关无关）。 */
export const inject = ['skills']

/** 技能名（kebab-case，与目录名、SKILL.md frontmatter 的 name 一致）。 */
export const GRILL_SKILL_NAME = 'grill-me'

/** 随包发的技能文件（`files` 白名单里有 `skills/`，安装后与 index.js 同目录）。 */
const DEFAULT_SKILL_URL = new URL('./skills/grill-me/SKILL.md', import.meta.url)

/** 平台技能名语法（与 @deepseek-ai/dsh-skill 的 SKILL_NAME 同形）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 解析一份 SKILL.md：取 YAML frontmatter 的 name / description / whenToUse，正文作为技能内容。
 *
 * 只认顶层标量（`key: value`），够本插件自己的技能用；复杂 YAML（嵌套对象、数组、块标量）不解析，
 * 也不该出现在我们自己的技能文件里——有复杂需求时改用 `skill-filesystem` 的 provider 解析。
 * @param {string} text - SKILL.md 原文
 * @param {{ file?: string }} [options] - 报错信息里展示的文件名
 * @returns {{ name: string, description: string, whenToUse?: string, content: string }}
 */
export function parseSkillMarkdown(text, options = {}) {
  const label = options.file ?? 'SKILL.md'
  if (typeof text !== 'string') throw new Error(`${label}：内容不是字符串`)
  const source = text.replaceAll('\r\n', '\n')
  if (!source.startsWith('---\n')) throw new Error(`${label}：缺少 YAML frontmatter（首行必须是 ---）`)
  const end = source.indexOf('\n---\n', 3)
  if (end === -1) throw new Error(`${label}：frontmatter 没有结束的 ---`)
  const front = source.slice(4, end)
  const content = source.slice(end + 5).replace(/^\n+/, '').trimEnd()
  if (content === '') throw new Error(`${label}：frontmatter 之后没有正文`)

  const meta = {}
  for (const line of front.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    // 只支持顶层标量：缩进行（嵌套对象/数组）与块标量一律报错，别把子键悄悄读成顶层键。
    if (/^\s/.test(line)) throw new Error(`${label}：不支持嵌套/缩进的 frontmatter（只认顶层 key: value）：「${line.trim()}」`)
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (match === null) throw new Error(`${label}：无法解析 frontmatter 行「${line.trim()}」（只支持顶层 key: value）`)
    const [, key, rawValue] = match
    const value = stripQuotes(rawValue.trim())
    if (value !== '') meta[key] = value
  }

  const skillName = meta.name
  const description = meta.description
  if (typeof skillName !== 'string' || skillName === '') throw new Error(`${label}：frontmatter 缺少 name`)
  if (!SKILL_NAME.test(skillName)) throw new Error(`${label}：name「${skillName}」不是 kebab-case（小写字母/数字/连字符）`)
  if (typeof description !== 'string' || description === '') throw new Error(`${label}：frontmatter 缺少 description`)
  return {
    name: skillName,
    description,
    ...typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {},
    content,
  }
}

/** 去掉 YAML 单/双引号（只在首尾成对时）。 */
function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 读并解析随包的 grill-me 技能。
 * @param {string} [file] - 覆盖技能文件路径（测试用）
 */
export function readGrillSkill(file = fileURLToPath(DEFAULT_SKILL_URL)) {
  const skill = parseSkillMarkdown(readFileSync(file, 'utf8'), { file })
  if (skill.name !== GRILL_SKILL_NAME) {
    throw new Error(`${file}：frontmatter name 是「${skill.name}」，应为「${GRILL_SKILL_NAME}」`)
  }
  return { ...skill, path: file }
}

/**
 * 注册 grill-me 技能（预设作用域）。
 * @param ctx - 预设作用域上下文（`inject: ['skills']` 已保证 `ctx.skills` 可用）
 * @param {{ skillPath?: string }} [config] - 测试可覆盖技能文件路径
 */
export function apply(ctx, config = {}) {
  const warn = message => ctx.logger?.warn?.(`dsh-orchestrator: ${message}`)
  let skill
  try {
    skill = readGrillSkill(typeof config.skillPath === 'string' && config.skillPath !== ''
      ? config.skillPath
      : fileURLToPath(DEFAULT_SKILL_URL))
  } catch (error) {
    warn(`grill-me 技能加载失败（协调者照常可用，只是没有该技能）：${error?.message ?? error}`)
    return
  }
  try {
    // source: 'bundled' = 随包发的只读技能；provider 省略 → 注册表内置的 runtime provider。
    // path 只用于诊断（技能目录渲染不会把正文塞进系统提示，正文由 skill({name}) 按需加载）。
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      content: skill.content,
      source: 'bundled',
      path: skill.path,
    })
  } catch (error) {
    warn(`grill-me 技能注册失败（协调者照常可用）：${error?.message ?? error}`)
  }
}
