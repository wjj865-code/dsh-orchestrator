// 编排指引技能：把随包发的三段 policy（worktree / 任务链 / 并行）注册成**预设作用域**的运行时技能。
//
// 为什么是独立模块而不是 index.js 里的 apply：`ctx.skills.register()` 把技能登记进**调用方 context 的
// 作用域**（dsh-skill 的 SkillRegistry 分层：预设挂载的插件进该预设层，unscoped 插件进全局层）。
// 这个模块只由协调者预设挂载（cordis.patch.yml），所以协调者会话看得到这三段指引，worker 预设没挂
// 就看不到——不需要靠工具收窄去「遮」。
//
// 为什么和 skill-grill-me 分两个模块：grill-me 是「怎么澄清需求」，这三段是「怎么派活」——触发时机、
// 维护节奏都不同，分开注册/分开失败，也方便下一步单独改写判据（本模块只做注册，不含任何判据文本）。
//
// 失败形态：某个 SKILL.md 缺失/格式不合法时只 warn 并跳过该技能——技能是增强项，不能因为它让协调者
// 预设挂载失败；三段里坏一段，另外两段照常注册（单文件失败不互相拖累）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseSkillMarkdown } from '../skill-grill-me.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-orchestrator-skill-orch-guides'

/** 需要 skills 注册表服务（宿主 plane 提供，与 web-app 的预设开关无关）。 */
export const inject = ['skills']

/**
 * 随包发的三段编排指引（技能名 = `skills/<name>/SKILL.md` 的目录名）。
 *
 * 顺序只影响注册顺序（目录按名字排序，与这里无关）；判据正文全部在各自的 SKILL.md 里。
 */
export const ORCH_SKILL_NAMES = Object.freeze(['orch-worktree', 'orch-task-chain', 'orch-parallel'])

/**
 * 读并解析一个随包编排技能。
 * @param {string} skillName - 技能名（也是目录名）
 * @param {string} [file] - 覆盖技能文件路径（测试用）
 */
export function readOrchSkill(skillName, file = fileURLToPath(skillUrl(skillName))) {
  const skill = parseSkillMarkdown(readFileSync(file, 'utf8'), { file })
  if (skill.name !== skillName) {
    throw new Error(`${file}：frontmatter name 是「${skill.name}」，应为「${skillName}」`)
  }
  return { ...skill, path: file }
}

/** 技能文件位置（`files` 白名单里有 `skills/`，安装后与 index.js 同目录）。 */
function skillUrl(skillName) {
  return new URL(`../skills/${skillName}/SKILL.md`, import.meta.url)
}

/**
 * 注册三段编排指引（预设作用域）。
 *
 * @param ctx - 预设作用域上下文（`inject: ['skills']` 已保证 `ctx.skills` 可用）
 * @param {{ skillPaths?: Record<string, string> }} [config] - 测试可覆盖技能文件路径
 * @returns {{ registered: string[], failed: string[] }} 注册/失败清单（测试与诊断用）
 */
export function apply(ctx, config = {}) {
  const warn = message => ctx.logger?.warn?.(`dsh-orchestrator: ${message}`)
  const overrides = config?.skillPaths ?? {}
  const registered = []
  const failed = []
  for (const skillName of ORCH_SKILL_NAMES) {
    let skill
    try {
      const override = overrides[skillName]
      skill = readOrchSkill(skillName, typeof override === 'string' && override !== '' ? override : undefined)
    } catch (error) {
      failed.push(skillName)
      warn(`${skillName} 技能加载失败（协调者照常可用，只是没有该技能）：${error?.message ?? error}`)
      continue
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
      registered.push(skill.name)
    } catch (error) {
      failed.push(skillName)
      warn(`${skillName} 技能注册失败（协调者照常可用）：${error?.message ?? error}`)
    }
  }
  return { registered, failed }
}
