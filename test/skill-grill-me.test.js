// A（t-48e8ce06）：grill-me 技能。两层断言：
//   1. `skills/grill-me/SKILL.md` 本身格式合规、协议要点齐全（拷问式澄清的九条硬口径）；
//   2. `skill-grill-me.js` 把正文注册成**预设作用域**的运行时技能，失败只 warn、不让预设挂载崩。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GRILL_SKILL_NAME, apply, inject, name, parseSkillMarkdown, readGrillSkill,
} from '../skill-grill-me.js'

/** 替身：预设作用域上下文（真宿主会注入 skills 服务与 logger）。 */
function fakeSkillCtx() {
  const registered = []
  const warnings = []
  return {
    registered,
    warnings,
    ctx: {
      logger: { warn: message => warnings.push(message) },
      skills: { register(skill) { registered.push(skill); return () => {} } },
    },
  }
}

test('SKILL.md 格式合规：frontmatter name=kebab / description 必填 / 含 whenToUse', () => {
  const skill = readGrillSkill()
  assert.equal(skill.name, 'grill-me')
  assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(skill.description.length > 10, 'description 要能当路由摘要（不是一句话占位）')
  assert.ok(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 10, 'whenToUse 必填')
  // 正文是 frontmatter 之后的正文：标题打头，frontmatter 键不泄进技能内容。
  assert.match(skill.content, /^# grill-me/)
  assert.equal(skill.content.includes('whenToUse:'), false)
  assert.ok(skill.path.endsWith('skills/grill-me/SKILL.md') || skill.path.endsWith('skills\\grill-me\\SKILL.md'), skill.path)
})

test('SKILL.md 协议要点齐全：前沿提问 / 每问带推荐 / 事实自己查 / 决策归用户 / 2 轮 8 问 / 三栏 / T2-T3 / grill≠批准', () => {
  const { content } = readGrillSkill()
  const required = [
    ['一次只问一个决定性问题', /一次只问一个决定性问题/],
    ['每问带我的推荐', /每问必须带我的推荐/],
    ['事实我自己查', /事实我自己查/],
    ['决策归用户', /决策归用户/],
    ['前沿提问', /前沿提问/],
    ['2 轮 / 8 问上限', /2 轮 \/ 8 问/],
    ['决策记录三栏', /决策点\s*\|\s*你定的\s*\|\s*影响/],
    ['与 T2 衔接', /T2/],
    ['与 T3 衔接', /T3/],
    ['grill ≠ 批准', /grill ≠ 批准/],
    ['不替代计划批准', /不替代计划批准|计划批准仍然/],
    ['停止条件', /停止条件/],
  ]
  for (const [label, pattern] of required) assert.match(content, pattern, `技能正文缺「${label}」`)
  // 归属：灵感来自 Matt Pocock 的 grilling（MIT），措辞重写；不能把 GPL 版本抄进来。
  assert.match(content, /Matt Pocock/)
  assert.match(content, /MIT/)
})

test('apply 注册运行时技能：预设作用域、source=bundled、正文不带 frontmatter', () => {
  assert.deepEqual(inject, ['skills'], '要声明 skills 服务依赖，否则预设里拿不到注册表')
  const { ctx, registered, warnings } = fakeSkillCtx()
  apply(ctx)
  assert.deepEqual(warnings, [])
  assert.equal(registered.length, 1)
  const skill = registered[0]
  assert.equal(skill.name, GRILL_SKILL_NAME)
  assert.equal(skill.source, 'bundled')
  assert.ok(skill.description.length > 0)
  assert.ok(skill.whenToUse !== undefined)
  assert.match(skill.content, /^# grill-me/)
  assert.ok(skill.path.endsWith('SKILL.md'), '注册里带绝对路径，排障时能定位到真文件')
  assert.equal(name, 'dsh-orchestrator-skill-grill-me')
})

test('SKILL.md 缺失只 warn、不抛、不注册：技能是增强项，不能让预设挂载失败', () => {
  const { ctx, registered, warnings } = fakeSkillCtx()
  apply(ctx, { skillPath: join(mkdtempSync(join(tmpdir(), 'orch-skill-')), 'missing.md') })
  assert.equal(registered.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /grill-me 技能加载失败/)
  assert.match(warnings[0], /ENOENT|no such file/i)
})

test('parseSkillMarkdown 对坏 frontmatter 给可读报错（而不是静默注册空技能）', () => {
  assert.throws(() => parseSkillMarkdown('# 没有 frontmatter\n'), /缺少 YAML frontmatter/)
  assert.throws(() => parseSkillMarkdown('---\nname: grill-me\ndescription: d\n'), /没有结束的 ---/)
  assert.throws(() => parseSkillMarkdown('---\ndescription: d\n---\nbody'), /缺少 name/)
  assert.throws(() => parseSkillMarkdown('---\nname: Grill-Me\ndescription: d\n---\nbody'), /kebab-case/)
  assert.throws(() => parseSkillMarkdown('---\nname: grill-me\n---\nbody'), /缺少 description/)
  assert.throws(() => parseSkillMarkdown('---\nname: grill-me\ndescription: d\n---\n\n'), /没有正文/)
  // 引号与注释按 YAML 习惯处理，顶层标量以外的行给可读报错。
  const quoted = parseSkillMarkdown('---\n# 注释\nname: "grill-me"\ndescription: \'带引号的描述\'\nwhenToUse: 用时\n---\n正文')
  assert.deepEqual(quoted, { name: 'grill-me', description: '带引号的描述', whenToUse: '用时', content: '正文' })
  assert.throws(() => parseSkillMarkdown('---\nname: grill-me\ndescription: d\nnested:\n  key: v\n---\nbody'), /不支持嵌套|无法解析 frontmatter 行/)
})

test('apply 在注册失败时也只 warn（平台校验拒绝不影响协调者启动）', () => {
  const { warnings } = fakeSkillCtx()
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    skills: { register() { throw new Error('invalid skill name') } },
  }
  apply(ctx)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /grill-me 技能注册失败/)
})

test('技能正文随文件走：改 SKILL.md（临时副本）就能换正文，模块不内嵌副本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-skill-'))
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, '---\nname: grill-me\ndescription: 临时描述\nwhenToUse: 临时\n---\n# grill-me\n临时正文', 'utf8')
  const { ctx, registered } = fakeSkillCtx()
  apply(ctx, { skillPath: file })
  assert.equal(registered[0].description, '临时描述')
  assert.match(registered[0].content, /临时正文/)
  // name 与技能身份不一致时拒绝注册（避免把别的技能挂在 grill-me 名下）。
  writeFileSync(file, '---\nname: other-skill\ndescription: d\n---\nbody', 'utf8')
  const second = fakeSkillCtx()
  apply(second.ctx, { skillPath: file })
  assert.equal(second.registered.length, 0)
  assert.match(second.warnings[0], /应为「grill-me」/)
})
