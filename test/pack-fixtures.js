// 能力包测试夹具（P1–P5 共用）：一份合法 manifest + 一份合法技能文件。
// 单独成文件而不是从 *.test.js 里 import：node --test 会执行被 import 的测试文件顶层用例，
// 复用夹具会把对方的用例重复跑一遍（报告里同一用例出现两次，误导排障）。

export const validManifest = (overrides = {}) => ({
  schemaVersion: 2,
  id: 'demo-pack',
  name: '演示包',
  description: '演示用能力包',
  publisher: 'factory',
  version: '0.1.0',
  platforms: ['desktop'],
  preset: { id: 'dsh-orchestrator-pack-demo-pack', name: '演示包', description: '演示', order: 210 },
  skillsDir: 'skills',
  skills: [{ name: 'demo-skill', description: '演示技能' }],
  cli: [],
  env: [],
  health: [],
  ...overrides,
})

export const skillFiles = (name = 'demo-skill') => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: 演示技能\n---\n\n正文内容\n`,
})
