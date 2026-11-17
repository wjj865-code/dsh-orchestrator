// 协调者读工作区产物（read_workspace）：受控读的边界与降级。
//
// 这一组用例锁的是**安全边界**：允许路径可读、越界被拒、符号链接逃逸被拒、路径穿越被拒、
// 超大文件截断/拒绝。边界判定在 src/read-workspace.js（纯函数 + 一次有界读），
// 主会话身份校验与审计日志在 src/tools.js。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LINES, MAX_ENTRIES, MAX_FILE_BYTES, MAX_READ_CHARS,
  isInside, readWorkspaceFile, renderWorkspaceRead, resolveWorkspaceTarget,
} from '../src/read-workspace.js'
import { createTools } from '../src/tools.js'
import { openLedger } from '../src/ledger.js'
import { createQueue } from '../src/queue.js'
import { tempDir } from './helpers.js'

/** 搭一个「主会话工作区 + 工作区外的敏感文件」的临时布局。 */
function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'orch-outside-'))
  mkdirSync(join(root, 'reports'), { recursive: true })
  mkdirSync(join(root, 'diag'), { recursive: true })
  writeFileSync(join(root, 'reports', 'plan.md'), '# 计划\n\n第一步\n第二步\n', 'utf8')
  writeFileSync(join(root, 'diag', 'snap.json'), '{"ok":true}\n', 'utf8')
  writeFileSync(join(outside, 'secret.yaml'), 'token: should-never-be-read\n', 'utf8')
  return { root, outside }
}

test('允许路径可读：工作区内相对路径与绝对路径都给正文', () => {
  const { root } = workspaceFixture()
  const relative = readWorkspaceFile({ root, path: 'reports/plan.md' })
  assert.equal(relative.ok, true)
  assert.equal(relative.kind, 'text')
  assert.match(relative.text, /# 计划/)
  // 结尾换行会切出一个空行：按 '\n' 切分是 5 段（最后一段为空）。
  assert.equal(relative.totalLines, 5)
  assert.equal(relative.start, 1)
  assert.equal(relative.more, false)

  const absolute = readWorkspaceFile({ root, path: join(root, 'diag', 'snap.json') })
  assert.equal(absolute.ok, true)
  assert.match(absolute.text, /"ok":true/)
})

test('目录只列一层条目，不递归', () => {
  const { root } = workspaceFixture()
  const listed = readWorkspaceFile({ root, path: 'reports' })
  assert.equal(listed.ok, true)
  assert.equal(listed.kind, 'directory')
  assert.deepEqual(listed.items.map(item => item.name), ['plan.md'])
  assert.equal(listed.items[0].kind, 'file')
  assert.equal(listed.items[0].readable, true)
})

test('目录里指向工作区外的符号链接被标为不可读', () => {
  const { root, outside } = workspaceFixture()
  symlinkSync(join(outside, 'secret.yaml'), join(root, 'reports', 'link-out.yaml'))
  symlinkSync(join(root, 'reports', 'plan.md'), join(root, 'reports', 'link-in.md'))
  const listed = readWorkspaceFile({ root, path: 'reports' })
  assert.equal(listed.ok, true)
  const byName = Object.fromEntries(listed.items.map(item => [item.name, item]))
  assert.equal(byName['link-out.yaml'].readable, false)
  assert.equal(byName['link-in.md'].readable, true)
  assert.match(renderWorkspaceRead(listed), /link-out\.yaml.*不可读/)
  // 标了不可读的条目再读一次仍然是越界拒绝（标记与真实判定一致）。
  const denied = readWorkspaceFile({ root, path: 'reports/link-out.yaml' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /越界被拒绝/)
})

test('越界被拒：工作区外的绝对路径', () => {
  const { root, outside } = workspaceFixture()
  const denied = readWorkspaceFile({ root, path: join(outside, 'secret.yaml') })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /越界被拒绝/)
  assert.doesNotMatch(denied.error, /token/)
})

test('路径穿越被拒：../ 与多级 ../', () => {
  const { root } = workspaceFixture()
  for (const path of ['../secret.yaml', 'reports/../../etc/passwd', 'reports/../diag/../../x']) {
    const denied = readWorkspaceFile({ root, path })
    assert.equal(denied.ok, false, `${path} 应被拒`)
    assert.match(denied.error, /越界被拒绝/, path)
  }
  // 工作区内的「先出再回」归一后仍在里面：允许（词法归一后不越界）。
  const inside = resolveWorkspaceTarget(root, 'reports/../diag/snap.json')
  assert.equal(inside.ok, true)
})

test('符号链接逃逸被拒：指向工作区外的文件链接与目录链接', () => {
  const { root, outside } = workspaceFixture()
  symlinkSync(join(outside, 'secret.yaml'), join(root, 'reports', 'link-file.yaml'))
  symlinkSync(outside, join(root, 'reports', 'link-dir'))
  for (const path of ['reports/link-file.yaml', 'reports/link-dir/secret.yaml']) {
    const denied = readWorkspaceFile({ root, path })
    assert.equal(denied.ok, false, `${path} 应被拒`)
    assert.match(denied.error, /越界被拒绝/)
    assert.match(denied.error, /符号链接/)
  }
  // 工作区内的符号链接（指向里面）仍然可读：逃逸判定看的是真实路径，不是「是不是链接」。
  symlinkSync(join(root, 'reports', 'plan.md'), join(root, 'reports', 'link-inside.md'))
  const allowed = readWorkspaceFile({ root, path: 'reports/link-inside.md' })
  assert.equal(allowed.ok, true)
  assert.match(allowed.text, /# 计划/)
})

test('形状闸：空路径、~ 开头、含 NUL 一律拒绝', () => {
  const { root } = workspaceFixture()
  for (const path of ['', '   ', '~/secret', '.dsh/secret\0.yaml']) {
    const denied = readWorkspaceFile({ root, path })
    assert.equal(denied.ok, false, `${JSON.stringify(path)} 应被拒`)
  }
  assert.match(readWorkspaceFile({ root, path: '' }).error, /缺少 path/)
  assert.match(readWorkspaceFile({ root, path: '~/x' }).error, /不支持 ~ 展开/)
  assert.match(readWorkspaceFile({ root, path: 'a\0b' }).error, /NUL/)
})

test('主会话工作区为空时拒绝（不静默回落到 cwd）', () => {
  const denied = readWorkspaceFile({ root: '', path: 'reports/plan.md' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /没有主会话工作区/)
})

test('超大文件：超过上限直接拒绝，不整块读入', () => {
  const { root } = workspaceFixture()
  const big = join(root, 'reports', 'big.bin')
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const denied = readWorkspaceFile({ root, path: 'reports/big.bin' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /文件过大/)
  assert.match(denied.error, /摘要/)
})

test('大文件截断：按行窗口返回并给续读 offset，截断不是失败', () => {
  const { root } = workspaceFixture()
  const body = Array.from({ length: DEFAULT_LINES + 50 }, (_, index) => `line-${index + 1}`).join('\n')
  writeFileSync(join(root, 'reports', 'long.md'), body, 'utf8')
  const first = readWorkspaceFile({ root, path: 'reports/long.md' })
  assert.equal(first.ok, true)
  assert.equal(first.more, true)
  assert.equal(first.start, 1)
  assert.equal(first.end, DEFAULT_LINES)
  assert.equal(first.nextOffset, DEFAULT_LINES + 1)
  assert.match(renderWorkspaceRead(first), new RegExp(`offset=${DEFAULT_LINES + 1}`))

  const rest = readWorkspaceFile({ root, path: 'reports/long.md', offset: first.nextOffset })
  assert.equal(rest.ok, true)
  assert.equal(rest.more, false)
  assert.equal(rest.end, DEFAULT_LINES + 50)
  assert.match(rest.text, new RegExp(`line-${DEFAULT_LINES + 50}`))
})

test('单行超字符上限：截断该行但仍给下一行 offset，两个信号不互相矛盾', () => {
  const { root } = workspaceFixture()
  writeFileSync(join(root, 'reports', 'wide.md'), `${'x'.repeat(MAX_READ_CHARS + 500)}\n尾行`, 'utf8')
  const result = readWorkspaceFile({ root, path: 'reports/wide.md' })
  assert.equal(result.ok, true)
  assert.equal(result.byteCapped, true)
  assert.equal(result.truncatedLine, true)
  assert.equal(result.text.length, MAX_READ_CHARS)
  // 截断的是这一行，不是「读不下去」：offset 指向下一行，不是 null/false。
  assert.equal(result.nextOffset, 2)
  assert.equal(result.more, true)
  const rendered = renderWorkspaceRead(result)
  assert.match(rendered, /本行已截断/)
  assert.match(rendered, /offset=2/)
  assert.doesNotMatch(rendered, /无法按行续读/)

  // 续读真的能读到后面：不是原地打转（同一行不会再返回一次）。
  const rest = readWorkspaceFile({ root, path: 'reports/wide.md', offset: result.nextOffset })
  assert.equal(rest.ok, true)
  assert.equal(rest.truncatedLine, false)
  assert.equal(rest.text, '尾行')
})

test('单行超上限且只有一行：仍给 nextOffset，但标为已到末尾', () => {
  const { root } = workspaceFixture()
  writeFileSync(join(root, 'reports', 'wide-only.md'), 'y'.repeat(MAX_READ_CHARS + 500), 'utf8')
  const result = readWorkspaceFile({ root, path: 'reports/wide-only.md' })
  assert.equal(result.ok, true)
  assert.equal(result.truncatedLine, true)
  assert.equal(result.nextOffset, 2)
  assert.equal(result.more, false)
  const rendered = renderWorkspaceRead(result)
  assert.match(rendered, /本行已截断/)
  assert.match(rendered, /已到末尾/)
})

test('字符串形式 offset/limit 生效，不被静默忽略', () => {
  const { root } = workspaceFixture()
  const body = Array.from({ length: 20 }, (_, index) => `s${index + 1}`).join('\n')
  writeFileSync(join(root, 'reports', 'str.md'), body, 'utf8')

  const windowed = readWorkspaceFile({ root, path: 'reports/str.md', offset: '5', limit: '3' })
  assert.equal(windowed.ok, true)
  assert.equal(windowed.start, 5)
  assert.equal(windowed.end, 7)
  assert.equal(windowed.text, 's5\ns6\ns7')

  // 只给字符串 offset：limit 回落默认，不是把 offset 当没给。
  const onlyOffset = readWorkspaceFile({ root, path: 'reports/str.md', offset: '18' })
  assert.equal(onlyOffset.start, 18)
  assert.equal(onlyOffset.end, 20)

  // 非法字符串仍回落默认，不报错也不当成 0。
  const invalid = readWorkspaceFile({ root, path: 'reports/str.md', offset: 'abc', limit: '' })
  assert.equal(invalid.start, 1)
  assert.equal(invalid.end, 20)
})

test('offset 越界给可读错误；limit 夹紧到上限', () => {
  const { root } = workspaceFixture()
  const denied = readWorkspaceFile({ root, path: 'reports/plan.md', offset: 999 })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /超出文件行数/)

  const body = Array.from({ length: 20 }, (_, index) => `r${index + 1}`).join('\n')
  writeFileSync(join(root, 'reports', 'twenty.md'), body, 'utf8')
  const clamped = readWorkspaceFile({ root, path: 'reports/twenty.md', limit: 99_999 })
  assert.equal(clamped.ok, true)
  assert.equal(clamped.end, 20)
})

test('二进制文件只报类型，不返回内容', () => {
  const { root } = workspaceFixture()
  writeFileSync(join(root, 'reports', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  const result = readWorkspaceFile({ root, path: 'reports/blob.bin' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'binary')
  assert.equal(result.text, '')
  assert.match(renderWorkspaceRead(result), /二进制/)
})

test('不存在的路径给「不存在」，不猜也不回落', () => {
  const { root } = workspaceFixture()
  const denied = readWorkspaceFile({ root, path: 'reports/nope.md' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /不存在/)
})

test('目录条目超过上限时截断并报 omitted', () => {
  const { root } = workspaceFixture()
  mkdirSync(join(root, 'diag', 'many'), { recursive: true })
  for (let index = 0; index < MAX_ENTRIES + 10; index += 1) {
    writeFileSync(join(root, 'diag', 'many', `f-${index}.txt`), 'x', 'utf8')
  }
  const listed = readWorkspaceFile({ root, path: 'diag/many' })
  assert.equal(listed.ok, true)
  assert.equal(listed.items.length, MAX_ENTRIES)
  assert.equal(listed.omitted, 10)
  assert.match(renderWorkspaceRead(listed), /只列前/)
})

test('isInside：等值算在内，父目录/前缀相似目录不算', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

// ---- 工具层：主会话身份、审计日志、文案 ----

async function toolFixture() {
  const { root, outside } = workspaceFixture()
  const db = await openLedger(tempDir())
  const events = []
  const queue = createQueue({ db, dispatcher: { async spawn() { throw new Error('不应派发') } }, config: {} })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: {},
    queue,
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => root,
    logger: { log: (event, fields) => events.push([event, fields]) },
  }).map(tool => [tool.name, tool]))
  return { root, outside, db, tools, events }
}

test('read_workspace 只对主会话开放：子会话与未绑定都拿不到内容', async () => {
  const { db, tools } = await toolFixture()
  const asChild = await tools.read_workspace.execute({ path: 'reports/plan.md' }, { agent: { id: 'child-1' } })
  assert.match(asChild, /请从主会话操作/)
  assert.doesNotMatch(asChild, /# 计划/)
  const unbound = await tools.read_workspace.execute({ path: 'reports/plan.md' }, { agent: { id: 's-1' } })
  assert.match(unbound, /# 计划/) // 已绑定主会话：正常读到
  db.close()
})

test('read_workspace 越界时给拒绝文案并写 workspace.read.rejected 审计日志', async () => {
  const { db, tools, outside, events } = await toolFixture()
  const denied = await tools.read_workspace.execute({ path: join(outside, 'secret.yaml') }, { agent: { id: 's-1' } })
  assert.match(denied, /读取失败/)
  assert.match(denied, /越界被拒绝/)
  assert.doesNotMatch(denied, /should-never-be-read/)
  const rejected = events.filter(([event]) => event === 'workspace.read.rejected')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0][1].detail.error, /越界被拒绝/)
  db.close()
})

test('read_workspace 正常读取写 workspace.read 审计日志（只记路径与体积，不记正文）', async () => {
  const { db, tools, events } = await toolFixture()
  const text = await tools.read_workspace.execute({ path: 'reports/plan.md' }, { agent: { id: 's-1' } })
  assert.match(text, /【工作区文件】/)
  assert.match(text, /# 计划/)
  const read = events.filter(([event]) => event === 'workspace.read')
  assert.equal(read.length, 1)
  assert.equal(read[0][1].detail.kind, 'text')
  assert.equal(JSON.stringify(read[0][1].detail).includes('# 计划'), false, '审计日志不得含正文')
  db.close()
})

test('read_workspace 没有主会话工作区时给可操作提示', async () => {
  const db = await openLedger(tempDir())
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: {},
    queue: createQueue({ db, dispatcher: {}, config: {} }),
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => undefined,
  }).map(tool => [tool.name, tool]))
  const text = await tools.read_workspace.execute({ path: 'reports/plan.md' }, { agent: { id: 's-1' } })
  assert.match(text, /没有主会话工作区/)
  db.close()
})
