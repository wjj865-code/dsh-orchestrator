import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PACK_SCHEMA_VERSION, defaultHealth, relativePathProblem, validateManifest, validateSkillMarkdown, exactVersionProblem,
} from '../src/pack/manifest.js'
import { validManifest } from './pack-fixtures.js'

// P1：manifest 校验的边界用例。每条都对应「手改/工厂生成的包真的能被带坏」的一种方式，
// 不是 schema 自我欣赏：越界路径、latest、非白名单 registry、凭据值落盘、技能名重复
// 都是凭一条就能把「包内隔离 / 供应链可追溯 / 不托管凭据」破坏掉的项。

const errorText = result => result.errors.join('；')

test('P1 manifest：合法包通过并补默认值（publisher/order/health 归一化）', () => {
  const result = validateManifest(validManifest())
  assert.equal(result.ok, true, errorText(result))
  assert.equal(result.manifest.schemaVersion, PACK_SCHEMA_VERSION)
  assert.equal(result.manifest.preset.order, 210)
  assert.equal(result.manifest.skillsDir, 'skills')
  assert.deepEqual(result.manifest.platforms, ['desktop'])
  // 没给 skillsDir 时默认 skills；没给 health 时由 defaultHealth 生成最小集。
  const bare = validateManifest({ ...validManifest(), skillsDir: undefined })
  assert.equal(bare.ok, true, errorText(bare))
  assert.equal(bare.manifest.skillsDir, 'skills')
  assert.deepEqual(defaultHealth(bare.manifest).map(item => item.kind), ['files'])
})

test('P1 manifest：schemaVersion / id / name / publisher 的非法值都被拒', () => {
  assert.match(errorText(validateManifest(validManifest({ schemaVersion: 1 }))), /schemaVersion/)
  assert.match(errorText(validateManifest(validManifest({ id: 'Demo Pack' }))), /id 不合法/)
  assert.match(errorText(validateManifest(validManifest({ id: '../escape' }))), /id 不合法/)
  assert.match(errorText(validateManifest(validManifest({ name: '' }))), /name 不能为空/)
  assert.match(errorText(validateManifest(validManifest({ publisher: 'third-party' }))), /publisher/)
  assert.match(errorText(validateManifest(validManifest({ platforms: ['web'] }))), /不支持的 platform/)
  assert.match(errorText(validateManifest(validManifest({ platforms: [] }))), /platforms 不能为空/)
})

test('P1 manifest：版本必须精确（latest / ^ / ~ / 范围一律拒绝）', () => {
  for (const bad of ['latest', '^2.0.12', '~2.0.12', '>=2.0.12', '2.x', '2.0']) {
    assert.match(errorText(validateManifest(validManifest({ version: bad }))), /version/)
  }
  assert.equal(exactVersionProblem('2.0.12'), undefined)
  assert.equal(exactVersionProblem('0.1.0-rc.1'), undefined)
})

test('P1 manifest：preset.id 与 order 的类型约束', () => {
  assert.match(errorText(validateManifest(validManifest({ preset: { id: 'Bad Id', name: 'x' } }))), /preset\.id/)
  assert.match(errorText(validateManifest(validManifest({ preset: undefined }))), /preset 必须是对象/)
  const result = validateManifest(validManifest({ preset: { id: 'demo-preset', name: 'x', order: 1.5 } }))
  assert.equal(result.ok, false)
  assert.match(errorText(result), /preset\.order/)
})

test('P1 manifest：技能名 kebab-case、不重复、每个都要 description', () => {
  assert.match(errorText(validateManifest(validManifest({ skills: [] }))), /skills 必须是非空数组/)
  assert.match(errorText(validateManifest(validManifest({ skills: [{ name: 'Bad_Name', description: 'x' }] }))), /kebab-case/)
  assert.match(errorText(validateManifest(validManifest({
    skills: [{ name: 'a-skill', description: 'x' }, { name: 'a-skill', description: 'y' }],
  }))), /技能名重复/)
  assert.match(errorText(validateManifest(validManifest({ skills: [{ name: 'a-skill', description: '' }] }))), /description 不能为空/)
})

test('P1 manifest：skillsDir / health 路径不允许越界', () => {
  for (const bad of ['../outside', 'C:\\packs', '/abs/path', 'a/../../b', 'a//b']) {
    assert.notEqual(relativePathProblem(bad), undefined, `应拒绝：${bad}`)
  }
  assert.equal(relativePathProblem('skills/sub'), undefined)
  assert.match(errorText(validateManifest(validManifest({ skillsDir: '../escape' }))), /skillsDir/)
  assert.match(errorText(validateManifest(validManifest({
    health: [{ id: 'files', kind: 'files', spec: { paths: ['../x.md'] } }],
  }))), /health\[0\]\.spec\.paths/)
})

test('P1 manifest：CLI 只认 pnpm + 白名单 registry + integrity/license/sourceUrl', () => {
  const cli = [{
    id: 'demo-cli', purpose: '演示 CLI',
    install: {
      manager: 'npm', package: 'demo-cli', version: '1.0.0', scope: 'pack-local',
      registry: 'https://registry.npmjs.org', integrity: 'sha512-x', license: 'MIT', sourceUrl: 'https://example.com',
    },
  }]
  assert.match(errorText(validateManifest(validManifest({ cli }))), /manager 只支持/)
  const evil = JSON.parse(JSON.stringify(cli))
  evil[0].install.manager = 'pnpm'
  evil[0].install.registry = 'https://evil.example.com'
  assert.match(errorText(validateManifest(validManifest({ cli: evil }))), /registry 不在白名单/)
  const open = JSON.parse(JSON.stringify(cli))
  open[0].install.manager = 'pnpm'
  open[0].install.version = 'latest'
  assert.match(errorText(validateManifest(validManifest({ cli: open }))), /install\.version/)
  const ok = validateManifest(validManifest({ cli: [{
    id: 'demo-cli', purpose: '演示', install: {
      manager: 'pnpm', package: '@scope/demo', version: '1.0.0', scope: 'pack-local',
      registry: 'https://registry.npmjs.org', integrity: 'sha512-x', license: 'Apache-2.0', sourceUrl: 'https://example.com',
    },
  }] }))
  assert.equal(ok.ok, true, errorText(ok))
  assert.equal(ok.manifest.cli[0].optional, true)
})

test('P1 manifest：env 只声明变量名/用途，值字段出现即拒', () => {
  const base = { ref: 'DEMO_TOKEN', kind: 'secret', required: true, purpose: '演示凭据' }
  const ok = validateManifest(validManifest({ env: [base] }))
  assert.equal(ok.ok, true, errorText(ok))
  assert.match(errorText(validateManifest(validManifest({ env: [{ ...base, ref: 'demo' }] }))), /env\[0\]\.ref/)
  assert.match(errorText(validateManifest(validManifest({ env: [base, base] }))), /env 变量名重复/)
  assert.match(errorText(validateManifest(validManifest({ env: [{ ...base, kind: 'text' }] }))), /kind 只能是/)
  for (const field of ['value', 'default', 'secret', 'token']) {
    assert.match(
      errorText(validateManifest(validManifest({ env: [{ ...base, [field]: 'x' }] }))),
      /不得包含/,
      `${field} 字段必须被拒（manifest 不落盘任何值）`,
    )
  }
})

test('P1 manifest：health 只认 files / command / env', () => {
  assert.match(errorText(validateManifest(validManifest({
    health: [{ id: 'bad', kind: 'network', spec: {} }],
  }))), /kind 只能是/)
  const ok = validateManifest(validManifest({
    health: [
      { id: 'skills', kind: 'files', spec: { paths: ['skills/demo-skill/SKILL.md'] } },
      { id: 'env', kind: 'env', spec: { refs: ['DEMO_TOKEN'] }, soft: true },
    ],
  }))
  assert.equal(ok.ok, true, errorText(ok))
  assert.equal(ok.manifest.health[1].soft, true)
})

test('P1 技能文件：frontmatter 合法、name 与清单一致、正文非空', () => {
  const text = '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文内容\n'
  assert.equal(validateSkillMarkdown(text, { expectedName: 'demo-skill' }).ok, true)
  assert.match(validateSkillMarkdown(text, { expectedName: 'other-skill' }).errors.join(''), /不一致/)
  assert.match(validateSkillMarkdown('没有 frontmatter', { file: 'a.md' }).errors.join(''), /缺少 YAML frontmatter/)
  assert.match(validateSkillMarkdown('---\nname: demo-skill\n---\n\n正文\n', { file: 'b.md' }).errors.join(''), /缺少 description/)
})

test('P1 manifest：env 声明里 required 缺省为 true（面板按 required 分级）', () => {
  const result = validateManifest(validManifest({
    env: [{ ref: 'DEMO_ID', kind: 'plain', purpose: '演示 id' }],
  }))
  assert.equal(result.ok, true)
  assert.equal(result.manifest.env[0].required, true)
})

test('P1 manifest：非对象输入不抛，返回可读错误', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const result = validateManifest(bad)
    assert.equal(result.ok, false)
    assert.match(result.errors.join(''), /manifest 必须是对象/)
  }
})
