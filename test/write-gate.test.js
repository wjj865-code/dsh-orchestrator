// 写域门面（write-gate）静态断言 + 派发层判定行为（S1–S12，v6 §5.7.3 / v7 §1.1 §3）。
//
// 为什么既有静态断言也有行为用例：
// - 静态断言锁的是**结构性事实**（唯一 register 点、动作层不许直接 import 判定入口、post-send 全段保护、
//   无 token 释放只允许终态、已删符号零出现）——这些靠 review 会漏，靠测试才不漂；
// - 行为用例锁的是 `decideDispatchGrant` 的派发口径（isolated 只看检出、无 target 归一父 cwd、
//   hold 并列视图不误拦）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedger, createTask, setTaskWorktree, transition } from '../src/ledger.js'
import { decideCreate, decideDispatchGrant, WRITE_GRANT_ACTIONS } from '../src/write-gate.js'
import { acquireWriteHold, __resetHolds } from '../src/write-hold.js'
import { tempDir, sampleBrief } from './helpers.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = relative => readFileSync(join(root, relative), 'utf8')
const sourceFiles = () => readdirSync(join(root, 'src'), { recursive: true })
  .filter(name => String(name).endsWith('.js'))
  .map(name => String(name).replace(/\\/g, '/'))

/** 从声明起点做括号匹配，取出函数体（只用于静态断言，注释里的花括号可能让它偏一点，断言仍可判）。 */
const fnBody = (source, anchor, { arrow = false, params = false } = {}) => {
  const start = source.indexOf(anchor)
  assert.notEqual(start, -1, `源码里找不到锚点：${anchor}`)
  let open
  if (arrow === true) {
    const at = source.indexOf('=>', start)
    assert.notEqual(at, -1, `锚点后没有箭头函数：${anchor}`)
    open = source.indexOf('{', at)
  } else if (params === true) {
    const at = source.indexOf(') {', start)
    assert.notEqual(at, -1, `锚点后没有函数体：${anchor}`)
    open = at + 2
  } else {
    open = source.indexOf('{', start)
  }
  assert.notEqual(open, -1, `锚点后没有函数体：${anchor}`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return source.slice(start)
}

// —— 静态断言 ——

test("S1：`registerWritableRoot(` 在 src/** 只出现 1 次，且在 dispatch.js 的 grantWritableRoot 里", () => {
  const hits = sourceFiles().filter(file => read(`src/${file}`).includes('registerWritableRoot('))
  assert.deepEqual(hits, ['dispatch.js'])
  const dispatch = read('src/dispatch.js')
  assert.equal((dispatch.match(/registerWritableRoot\(/g) ?? []).length, 1)
  const grant = fnBody(dispatch, 'const grantWritableRoot = ')
  assert.equal(grant.includes('registerWritableRoot('), true)
  // ensureWritableRoot 只调 grantWritableRoot（不再自己 register）。
  const ensure = fnBody(dispatch, 'const ensureWritableRoot = async ', { arrow: true })
  assert.equal(ensure.includes('registerWritableRoot('), false)
  assert.equal(ensure.includes('grantWritableRoot('), true)
})

test('S2/S5：WRITE_GRANT_ACTIONS 覆盖六个写权限动作、approve 不登记、每个函数体命中判定调用', () => {
  const expected = [
    'src/panel-actions.js:message',
    'src/panel-actions.js:retry',
    'src/tools.js:messageTask',
    'src/tools.js:resumeTask',
    'src/tools.js:retryTask',
    'src/tools.js:task_create',
  ]
  const actual = WRITE_GRANT_ACTIONS.map(entry => `${entry.file}:${entry.fn}`)
  assert.deepEqual(actual.sort(), expected.sort())
  // 批准只记账：登记表里不能有 approve 类动作（写权限在 post-send 的 grantWritableRoot chokepoint）。
  assert.equal(WRITE_GRANT_ACTIONS.some(entry => entry.kind === 'approve'), false)
  const anchors = {
    messageTask: 'const messageTask = async ',
    resumeTask: 'const resumeTask = async ',
    retryTask: 'const retryTask = async ',
    message: 'const message = async (taskId',
    retry: 'const retry = async taskId',
    task_create: "wrap('task_create'",
  }
  for (const entry of WRITE_GRANT_ACTIONS) {
    const source = read(entry.file)
    const anchor = anchors[entry.fn]
    const body = fnBody(source, anchor, entry.fn === 'task_create' ? { arrow: true } : {})
    for (const call of entry.calls) {
      assert.equal(body.includes(`${call}(`), true, `${entry.file} 的 ${entry.fn} 必须命中 ${call}`)
    }
    // 占位原语可以收在同一个文件的 helper 里（`holdWriteDomain`），但它必须真的 acquire（不许只判不占）。
    if (entry.calls.includes('holdWriteDomain')) {
      assert.equal(fnBody(source, 'const holdWriteDomain = ', { arrow: true }).includes('acquireWriteHold('), true, `${entry.file} 的 holdWriteDomain 必须 acquireWriteHold`)
    }
  }
})

test("S3'：动作层不直接 import 判定入口（decideWriteGuard/decideFollowupGuard/decideRegrantGuard）", () => {
  const banned = ['decideWriteGuard', 'decideFollowupGuard', 'decideRegrantGuard']
  for (const file of ['src/tools.js', 'src/panel-actions.js']) {
    const source = read(file)
    const imports = [...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/write-guard\.js'/g)]
      .map(match => match[1])
      .join(',')
    for (const name of banned) {
      assert.equal(imports.includes(name), false, `${file} 不能从 write-guard import ${name}（判定入口只走 write-gate）`)
    }
    // 纯谓词/文案是允许的（S3' 的 allowlist，别把门面收口做成「什么都不能用」）。
    assert.equal(imports.includes('taskTargetDir') || imports.includes('checkoutRejection'), true)
  }
})

test('S4：`activeWriteHolds(` 只在 write-gate 里被调用（动作层只问 isWriteHeld）', () => {
  const hits = sourceFiles().filter(file => read(`src/${file}`).includes('activeWriteHolds('))
  assert.deepEqual(hits.sort(), ['write-gate.js', 'write-hold.js'])
  const hold = read('src/write-hold.js')
  assert.equal(hold.includes('export function activeWriteHolds('), true)
  for (const file of ['src/tools.js', 'src/panel-actions.js', 'src/queue.js', 'index.js']) {
    assert.equal(read(file).includes('activeWriteHolds('), false, `${file} 不该直接取 holds 数组`)
  }
})

test('S6：stop/close/终态命中 releaseWriteHold；approve 不在登记表', () => {
  assert.equal(fnBody(read('src/tools.js'), 'const stopTask = async ').includes('releaseWriteHold('), true)
  assert.equal(fnBody(read('src/delivered.js'), 'export function closeDelivered(', { params: true }).includes('releaseWriteHold('), true)
  const index = read('index.js')
  const onTerminal = index.slice(index.indexOf('onTerminal: ('), index.indexOf('onTerminal: (') + 1200)
  assert.equal(onTerminal.includes('releaseWriteHold('), true)
  assert.equal(WRITE_GRANT_ACTIONS.some(entry => entry.kind === 'approve'), false)
})

test("S8'：已删符号零出现（src/** 与 test/**，含注释）", () => {
  // 用拼接构造，避免本文件自己成为命中项（扫描范围包含 test/**）。
  const banned = ['approve', 'Plan'].join('')
  const offenders = []
  const scan = (base, entries) => {
    for (const name of entries) {
      const file = String(name).replace(/\\/g, '/')
      if (!file.endsWith('.js')) continue
      if (read(`${base}/${file}`).includes(banned)) offenders.push(`${base}/${file}`)
    }
  }
  scan('src', sourceFiles())
  scan('test', readdirSync(join(root, 'test'), { recursive: true }).filter(name => String(name).endsWith('.js')))
  assert.deepEqual(offenders, [], `这些文件还引用已删除的批准运行期入口：${offenders.join('、')}`)
})

test("S10'：无 token 的 releaseWriteHold 只允许 stop/close/终态；finally 一律带 token", () => {
  const singleArg = source => [...source.matchAll(/releaseWriteHold\(\s*([^,)]*)\)/g)]
  for (const file of ['src/tools.js', 'src/panel-actions.js', 'src/delivered.js', 'index.js']) {
    const source = read(file)
    const lines = source.split('\n')
    for (const match of singleArg(source)) {
      const line = source.slice(0, match.index).split('\n').length
      // 强制释放必须显式标注 S10'（stop/close/终态），标注在本行或上一行都算（长行会折到上一行注释）。
      const context = `${lines[line - 2] ?? ''}\n${lines[line - 1] ?? ''}`
      assert.equal(context.includes("S10'"), true, `${file}:${line} 的无 token 释放缺少 S10' 标注：${context.trim()}`)
    }
  }
  // 工具/面板的投递 finally 必须是双参数（带自己的 owner token）。
  const tools = read('src/tools.js')
  assert.equal(tools.includes('releaseWriteHold(task.id, ownerToken)'), true)
  const panel = read('src/panel-actions.js')
  assert.equal(panel.includes('releaseWriteHold(task.id, holdToken)'), true)
})

test('S12：send 在 sendMessage 成功后到 return 之间整段 try/catch、无裸 throw；sendReliable 有已投递标记', () => {
  const dispatch = read('src/dispatch.js')
  const sendStart = dispatch.indexOf('async send(target, message, signal')
  const reliableStart = dispatch.indexOf('async sendReliable(')
  assert.equal(sendStart > 0 && reliableStart > sendStart, true, '找不到 send/sendReliable 的锚点')
  const send = dispatch.slice(sendStart, reliableStart)
  const reliable = dispatch.slice(reliableStart, dispatch.indexOf('retryPlanGrant(target, input', reliableStart))
  const marker = send.indexOf('await subagents.sendMessage')
  assert.notEqual(marker, -1)
  const postSend = send.slice(marker)
  assert.equal(postSend.includes('投递后记账/授予失败'), true, 'post-send 必须有自己的 catch（option ①）')
  assert.equal(/^\s*throw\b/m.test(postSend), false, 'post-send 段不许有裸 throw（否则已投递会被当失败）')
  assert.equal(postSend.includes('return messageId ?? raw'), true)
  assert.equal(reliable.includes('delivered = true'), true)
  assert.equal(reliable.includes('if (delivered) throw error'), true, '已投递绝不重试')
})

// —— 行为：派发 chokepoint ——

const runningTask = async (db, { title, targetDir }) => {
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1', targetDir })
  return transition(db, task.id, 'running', { sessionId: `c-${title}`, target: `c-${title}` })
}

test('decideDispatchGrant：台账外/只读/allowConcurrent 放行', async () => {
  const db = await openLedger(tempDir())
  assert.deepEqual(decideDispatchGrant({ db, taskId: 'missing', directory: 'C:/ws' }), { ok: true })
  const readOnly = createTask(db, { brief: sampleBrief({ title: '只读', readOnly: true }), coordinatorSession: 's-1', targetDir: 'C:/ws', readOnly: true })
  transition(db, readOnly.id, 'running', { sessionId: 'c-ro', target: 'c-ro' })
  await runningTask(db, { title: '普通', targetDir: 'C:/ws' })
  assert.deepEqual(decideDispatchGrant({ db, taskId: readOnly.id, directory: 'C:/ws' }), { ok: true })
  const concurrent = createTask(db, { brief: sampleBrief({ title: '并发', allowConcurrent: true }), coordinatorSession: 's-1', targetDir: 'C:/ws' })
  transition(db, concurrent.id, 'running', { sessionId: 'c-cc', target: 'c-cc' })
  assert.deepEqual(decideDispatchGrant({ db, taskId: concurrent.id, directory: 'C:/ws' }), { ok: true })
  db.close()
})

test('decideDispatchGrant：isolated 只看 worktree_path（原 target 被占也放行）', async () => {
  const db = await openLedger(tempDir())
  await runningTask(db, { title: '占目录', targetDir: 'C:/ws' })
  // requested/created/reused = 在独立检出里跑：原 target 相同也不算并发写。
  const isolated = createTask(db, { brief: sampleBrief({ title: '隔离' }), coordinatorSession: 's-1', targetDir: 'C:/ws' })
  setTaskWorktree(db, isolated.id, { state: 'requested', branch: 'orch/x', path: 'C:/wt/x' })
  assert.deepEqual(decideDispatchGrant({ db, taskId: isolated.id, directory: 'C:/ws' }), { ok: true })
  db.close()
})

test('decideDispatchGrant：复用检出被活跃任务占着 → 拒绝（带检出拒绝文案）', async () => {
  const db = await openLedger(tempDir())
  const holder = await runningTask(db, { title: 'holder', targetDir: 'C:/ws' })
  setTaskWorktree(db, holder.id, { state: 'requested' })
  setTaskWorktree(db, holder.id, { state: 'created', branch: 'orch/a', path: 'C:/wt/shared' })
  const reuse = createTask(db, { brief: sampleBrief({ title: '复用' }), coordinatorSession: 's-1' })
  setTaskWorktree(db, reuse.id, { state: 'requested' })
  setTaskWorktree(db, reuse.id, { state: 'reused', branch: 'orch/a', path: 'C:/wt/shared' })
  const verdict = decideDispatchGrant({ db, taskId: reuse.id, directory: 'C:/ws' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'WRITE_DOMAIN_DENIED')
  assert.match(verdict.text, /检出/)
  db.close()
})

test('decideDispatchGrant：dependsOn 串行共享检出 → 放行（serializedIds）', async () => {
  const db = await openLedger(tempDir())
  const holder = await runningTask(db, { title: 'holder', targetDir: 'C:/ws' })
  setTaskWorktree(db, holder.id, { state: 'requested' })
  setTaskWorktree(db, holder.id, { state: 'created', branch: 'orch/a', path: 'C:/wt/shared' })
  const reuse = createTask(db, { brief: sampleBrief({ title: '复用' }), coordinatorSession: 's-1', dependsOn: [holder.id] })
  setTaskWorktree(db, reuse.id, { state: 'requested' })
  setTaskWorktree(db, reuse.id, { state: 'reused', branch: 'orch/a', path: 'C:/wt/shared' })
  assert.deepEqual(decideDispatchGrant({ db, taskId: reuse.id, directory: 'C:/ws' }), { ok: true })
  db.close()
})

test('decideDispatchGrant：无 target 的任务按 directory（父 cwd）归一，同一父 cwd 被占就拒', async () => {
  const db = await openLedger(tempDir())
  await runningTask(db, { title: '占目录', targetDir: 'C:/ws' })
  const noTarget = createTask(db, { brief: sampleBrief({ title: '无目标' }), coordinatorSession: 's-1' })
  const verdict = decideDispatchGrant({ db, taskId: noTarget.id, directory: 'C:/ws' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'WRITE_DOMAIN_DENIED')
  // 换一个父 cwd → 不冲突（说明它真的用了 fallback，不是「无 target 一律放行」）。
  assert.deepEqual(decideDispatchGrant({ db, taskId: noTarget.id, directory: 'C:/other' }), { ok: true })
  db.close()
})

test('decideDispatchGrant：内存 hold 参与判定（delivered 追问挂起期间同目录 create 被拒，G3）', async () => {
  __resetHolds()
  const db = await openLedger(tempDir())
  const delivered = createTask(db, { brief: sampleBrief({ title: '已交付' }), coordinatorSession: 's-1', targetDir: 'C:/ws' })
  transition(db, delivered.id, 'running', { sessionId: 'c-d', target: 'c-d' })
  transition(db, delivered.id, 'delivered')
  // 交付态本身不占写域；但追问投递期间的 hold 要占住（否则同目录能新建任务）。
  acquireWriteHold({ taskId: delivered.id, ownerToken: 'tool:c1', targetDir: 'C:/ws' })
  const next = createTask(db, { brief: sampleBrief({ title: '新任务' }), coordinatorSession: 's-1' })
  const verdict = decideDispatchGrant({ db, taskId: next.id, directory: 'C:/ws' })
  assert.equal(verdict.ok, false)
  __resetHolds()
  db.close()
})

test('decideCreate：hold 并列视图不误拦（C:\\a\\b + C:\\a\\c 并行时 C:\\a\\d 仍可建）', async () => {
  __resetHolds()
  const db = await openLedger(tempDir())
  acquireWriteHold({ taskId: 't-held', ownerToken: 'tool:a', targetDir: 'C:/a/b' })
  acquireWriteHold({ taskId: 't-held', ownerToken: 'tool:b', targetDir: 'C:/a/c' })
  assert.equal(decideCreate({ db, target: 'C:/a/d' }).action, 'pass')
  assert.equal(decideCreate({ db, target: 'C:/a/b' }).action, 'reject')
  assert.equal(decideCreate({ db, target: 'C:/a/c' }).action, 'reject')
  __resetHolds()
  db.close()
})
