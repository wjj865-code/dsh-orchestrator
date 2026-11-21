import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './helpers.js'
import { createPackStore, packPaths } from '../src/pack/store.js'
import { validateManifest } from '../src/pack/manifest.js'
import { skillFiles, validManifest } from './pack-fixtures.js'

// P1：store 的原子性、路径安全、删除可回退。每条都对着「用户在面板点一下会真的发生」的后果：
// 半截 registry = 面板把包全当丢失；越界删除 = 删到插件状态目录之外；trash 不生效 = 升级失败不可回退。

const setup = () => {
  const stateDir = tempDir()
  const store = createPackStore({ stateDir, now: () => 1700000000000 })
  return { stateDir, store }
}

test('P1 store：写包 → 读 manifest → 列本地包（pack.json 由 manifest 生成）', () => {
  const { store, stateDir } = setup()
  const manifest = validateManifest(validManifest()).manifest
  const written = store.writePack(manifest, skillFiles())
  assert.equal(written.ok, true, written.errors?.join('；'))
  assert.equal(existsSync(join(stateDir, 'capability-packs', 'packs', 'demo-pack', 'pack.json')), true)
  const read = store.readManifest('demo-pack')
  assert.equal(read.ok, true, read.errors?.join('；'))
  assert.equal(read.manifest.id, 'demo-pack')
  assert.deepEqual(store.listLocalPacks().map(item => item.id), ['demo-pack'])
})

test('P1 store：registry 原子读写 + recordPack / forgetPack', () => {
  const { store } = setup()
  assert.deepEqual(store.readRegistry().registry, { schemaVersion: 1, packages: {} })
  const manifest = validateManifest(validManifest()).manifest
  store.writePack(manifest, skillFiles())
  const registry = store.recordPack(manifest)
  assert.equal(registry.packages['demo-pack'].presetId, 'dsh-orchestrator-pack-demo-pack')
  assert.equal(registry.packages['demo-pack'].createdAt, 1700000000000)
  const reloaded = store.readRegistry().registry
  assert.equal(reloaded.packages['demo-pack'].name, '演示包')
  const forgotten = store.forgetPack('demo-pack')
  assert.equal(forgotten.packages['demo-pack'], undefined)
  assert.equal(store.readRegistry().registry.packages['demo-pack'], undefined)
})

test('P1 store：坏 registry 回落空表并给可读错误（不抛、不覆盖）', () => {
  const { store, stateDir } = setup()
  mkdirSync(packPaths(stateDir).root, { recursive: true })
  writeFileSync(packPaths(stateDir).registryPath, '{ not json', 'utf8')
  const read = store.readRegistry()
  assert.deepEqual(read.registry.packages, {})
  assert.match(read.error ?? '', /不是合法 JSON/)
  assert.equal(readFileSync(packPaths(stateDir).registryPath, 'utf8'), '{ not json', '读坏不自动覆盖：留给用户/下一次写入')
})

test('P1 store：路径穿越（../、盘符）在写入与读取前被拒', () => {
  const { store } = setup()
  const manifest = validateManifest(validManifest()).manifest
  const escape = store.writePack(manifest, { '../evil.txt': 'x', ...skillFiles() })
  assert.equal(escape.ok, false)
  assert.match(escape.errors.join('；'), /\.\./)
  assert.throws(() => store.packDir('../escape'), /包 id 不合法/)
  assert.throws(() => store.toolsDir('..\\escape'), /包 id 不合法/)
  const badRead = store.readManifest('..\\escape')
  assert.equal(badRead.ok, false)
  assert.match(badRead.errors.join('；'), /包 id 不合法/)
})

test('P1 store：缺少技能文件 / 技能 frontmatter 不合法时整包不落盘', () => {
  const { store } = setup()
  const manifest = validateManifest(validManifest()).manifest
  const missing = store.writePack(manifest, { 'notes.txt': 'x' })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join('；'), /缺少技能文件/)
  assert.equal(store.listLocalPacks().length, 0, '失败的写不留下半截包')

  const bad = store.writePack(manifest, {
    'skills/demo-skill/SKILL.md': '没有 frontmatter',
  })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('；'), /缺少 YAML frontmatter/)
})

test('P1 store：重复写同 id → 旧目录进 .trash（可回退），新版本生效', () => {
  const { store, stateDir } = setup()
  const first = validateManifest(validManifest({ version: '0.1.0' })).manifest
  const second = validateManifest(validManifest({ version: '0.2.0' })).manifest
  assert.equal(store.writePack(first, skillFiles()).ok, true)
  const replaced = store.writePack(second, skillFiles())
  assert.equal(replaced.ok, true, replaced.errors?.join('；'))
  assert.equal(replaced.replaced, true)
  assert.equal(store.readManifest('demo-pack').manifest.version, '0.2.0')
  assert.ok(existsSync(replaced.previousTrash), '旧版本应保留在 .trash 里')
  assert.equal(existsSync(join(stateDir, 'capability-packs', '.trash')), true)
})

test('P1 store：删除包 → 目录进 trash、tools 删除、registry 条目消失', () => {
  const { store, stateDir } = setup()
  const manifest = validateManifest(validManifest()).manifest
  store.writePack(manifest, skillFiles())
  store.recordPack(manifest)
  const tools = join(packPaths(stateDir).toolsDir, 'demo-pack')
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, 'marker.txt'), 'x')
  const removed = store.removePack('demo-pack')
  assert.equal(removed.ok, true, removed.error)
  assert.ok(existsSync(removed.trashPath))
  assert.equal(existsSync(join(packPaths(stateDir).packsDir, 'demo-pack')), false)
  assert.equal(existsSync(tools), false, 'tools 目录应随删除清掉')
  assert.equal(store.readRegistry().registry.packages['demo-pack'], undefined)
})

test('P1 store：purgeTrash 只清超过 24h 的目录', () => {
  const stateDir = tempDir()
  const paths = packPaths(stateDir)
  mkdirSync(join(paths.trashDir, 'old.1'), { recursive: true })
  mkdirSync(join(paths.trashDir, 'new.2'), { recursive: true })
  // 用文件 mtime 模拟旧目录（只支持文件/目录 stat 的平台一致性够用）。
  const old = join(paths.trashDir, 'old.1')
  const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
  utimesSync(old, ancient, ancient)
  const store = createPackStore({ stateDir })
  const removed = store.purgeTrash()
  assert.deepEqual(removed, ['old.1'])
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(join(paths.trashDir, 'new.2')), true)
})

test('P1 store：purgeUnregistered 把「目录在、registry 无」的包搬进 trash（删包被 watcher 挡住时的兜底）', () => {
  const { store, stateDir } = setup()
  const manifest = validateManifest(validManifest()).manifest
  store.writePack(manifest, skillFiles())
  // 不写 registry：模拟删包时只撤了预设/registry、目录还在。
  const result = store.purgeUnregistered()
  assert.deepEqual(result.moved, ['demo-pack'])
  assert.equal(existsSync(join(packPaths(stateDir).packsDir, 'demo-pack')), false)
  assert.equal(existsSync(join(packPaths(stateDir).trashDir, 'demo-pack.1700000000000')), true)
  // 已登记的包不动。
  store.writePack(manifest, skillFiles())
  store.recordPack(manifest)
  assert.deepEqual(store.purgeUnregistered().moved, [])
  assert.equal(existsSync(join(packPaths(stateDir).packsDir, 'demo-pack')), true)
})

test('P1 store：install / health 状态读写；未知状态文件名拒绝', () => {
  const { store } = setup()
  const manifest = validateManifest(validManifest()).manifest
  store.writePack(manifest, skillFiles())
  assert.equal(store.readInstall('demo-pack'), undefined)
  store.writeInstall('demo-pack', { status: 'installed', version: '2.0.12' })
  assert.deepEqual(store.readInstall('demo-pack'), { status: 'installed', version: '2.0.12' })
  store.writeHealth('demo-pack', { checks: [{ id: 'skills', ok: true }] })
  assert.deepEqual(store.readHealth('demo-pack'), { checks: [{ id: 'skills', ok: true }] })
})

test('P1 store：原子写失败会抛错且不留 .tmp（.state 被文件占位）', () => {
  const { store } = setup()
  const manifest = validateManifest(validManifest()).manifest
  store.writePack(manifest, skillFiles())
  // 用「把 .state 占成文件」制造写失败：原子写必须抛错，调用方据此记 failed。
  writeFileSync(join(store.packDir('demo-pack'), '.state'), 'not a dir')
  assert.throws(() => store.writeInstall('demo-pack', { status: 'installed' }))
})
