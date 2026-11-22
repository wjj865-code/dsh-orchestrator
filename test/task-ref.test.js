// 版本 B《ID 出口网关》：任务引用（tk-xxxxxx）的生成 / 迁移回填 / 懒补 / 墓碑 / 统一解析入口。
//
// 断言的落点都是「用户面与工具面的行为」：
//   1. 新建任务同事务就有引用（不留「先无 ref 再补」的窗口）；
//   2. 旧库打开即回填，幂等（二次打开不重复建行）；
//   3. getTask 命中无 token 时懒补；
//   4. 删除任务置墓碑：旧引用报「已失效」，**永不复用**；
//   5. resolveTaskInput：先 t-xxxx 再 tk-，空值/未知值/胡写都是可读错误（不泄表名/SQL/内部列/裸编号）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  TASK_ID_RE, TASK_REF_ALPHABET, TASK_REF_MISSING, TASK_REF_RE, TASK_REF_RETIRED, TASK_REF_UNKNOWN,
  backfillTaskRefs, ensureTaskRef, generateTaskRef, looksLikeTaskRef, resolveTaskInput, retireTaskRef, taskRefOf,
} from '../src/task-ref.js'
import { createTask, deleteTask, getTask, listTasks, openLedger } from '../src/ledger.js'
import { sampleBrief, tempDir } from './helpers.js'

const newTask = (db, title = 'A') => createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-main' })

test('token 形态：tk- + 6 位、字母表去 0/1/l/o/i、与 t-xxxx 无歧义', () => {
  assert.equal(TASK_REF_RE.source, '^tk-[0-9a-z]{6}$')
  assert.equal(TASK_REF_ALPHABET.includes('0'), false)
  assert.equal(TASK_REF_ALPHABET.includes('1'), false)
  assert.equal(TASK_REF_ALPHABET.includes('l'), false)
  assert.equal(TASK_REF_ALPHABET.includes('o'), false)
  assert.equal(TASK_REF_ALPHABET.includes('i'), false)
  assert.equal(TASK_REF_ALPHABET.length, 31)
  for (let index = 0; index < 200; index += 1) {
    const token = generateTaskRef()
    assert.match(token, TASK_REF_RE)
    for (const char of token.slice(3)) assert.ok(TASK_REF_ALPHABET.includes(char), `越界字符：${char}`)
  }
  // `t-` 编号正则不会误吃 tk-：`t` 后面必须紧跟 `-`。
  assert.equal(TASK_ID_RE.test('tk-7f3a2c'), false)
  assert.equal(TASK_ID_RE.test('t-1a2b3c4d'), true)
  assert.equal(looksLikeTaskRef('tk-7f3a2c'), true)
  assert.equal(looksLikeTaskRef('tk-7f3a2'), false)
  assert.equal(looksLikeTaskRef('t-1a2b3c4d'), false)
})

test('生成可注入序列（撞号重试的可测入口），并按字母表取下标', () => {
  const fixed = generateTaskRef(() => 0)
  assert.equal(fixed, `tk-${'2'.repeat(6)}`)
  const last = generateTaskRef(() => TASK_REF_ALPHABET.length - 1)
  assert.equal(last, `tk-${TASK_REF_ALPHABET.at(-1).repeat(6)}`)
  // 越界下标被夹紧（不返回 undefined，不会拼出 `tk-undefined`）。
  assert.match(generateTaskRef(() => 999), /^tk-[0-9a-z]{6}$/)
})

test('新建任务：同事务生成引用，行上带 ref，task_refs 表里查得到', async () => {
  const db = await openLedger(tempDir())
  const task = newTask(db)
  assert.match(task.ref ?? '', TASK_REF_RE)
  assert.equal(taskRefOf(db, task.id), task.ref)
  const row = db.prepare('SELECT token, task_id, retired_at FROM task_refs WHERE task_id = ?').get(task.id)
  assert.equal(row.token, task.ref)
  assert.equal(row.retired_at, null)
  // 引用唯一：两条任务不会撞同一个 token。
  const other = newTask(db, 'B')
  assert.notEqual(other.ref, task.ref)
  db.close()
})

test('迁移回填：旧库（task_refs 空）打开即补，幂等且不改已有引用', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const a = newTask(db, 'A')
  const b = newTask(db, 'B')
  const tokenA = a.ref
  // 模拟旧库：清空映射表（等价于升级前没有 task_refs 行）。
  db.exec('DELETE FROM task_refs')
  assert.equal(taskRefOf(db, a.id), null)
  db.close()

  const reopened = await openLedger(dir)
  const refA = taskRefOf(reopened, a.id)
  const refB = taskRefOf(reopened, b.id)
  assert.match(refA ?? '', TASK_REF_RE)
  assert.match(refB ?? '', TASK_REF_RE)
  // 回填是幂等的：再开一次不会换 token、也不会多建行。
  reopened.close()
  const again = await openLedger(dir)
  assert.equal(taskRefOf(again, a.id), refA)
  assert.equal(Number(again.prepare('SELECT count(*) AS n FROM task_refs').get().n), 2)
  // 直调回填同样幂等（已全有引用时 created=0）。
  assert.deepEqual(backfillTaskRefs(again), { created: 0 })
  assert.notEqual(refA, tokenA)
  again.close()
})

test('懒补：getTask 命中无 token 时补一行（不依赖打开时的回填）', async () => {
  const db = await openLedger(tempDir())
  const task = newTask(db)
  db.exec('DELETE FROM task_refs')
  const before = getTask(db, task.id)
  assert.match(before.ref ?? '', TASK_REF_RE)
  assert.equal(taskRefOf(db, task.id), before.ref)
  db.close()
})

test('墓碑：删除任务置 retired_at，旧引用报「已失效」，且永不复用', async () => {
  const db = await openLedger(tempDir())
  const task = newTask(db)
  const token = task.ref
  deleteTask(db, task.id)
  const row = db.prepare('SELECT retired_at FROM task_refs WHERE task_id = ?').get(task.id)
  assert.equal(typeof row.retired_at, 'number')
  assert.equal(taskRefOf(db, task.id), null)
  const resolved = resolveTaskInput(db, token)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'retired')
  assert.equal(resolved.message, TASK_REF_RETIRED)
  // 永不复用：再给同一 task_id 生成引用不会把墓碑复活。
  assert.equal(ensureTaskRef(db, task.id), null)
  assert.equal(retireTaskRef(db, task.id), false)
  db.close()
})

test('解析矩阵：t-xxxx 与 tk- 都指向同一任务；空值/未知/胡写给可读错误', async () => {
  const db = await openLedger(tempDir())
  const task = newTask(db)
  const byId = resolveTaskInput(db, task.id)
  const byRef = resolveTaskInput(db, task.ref)
  assert.deepEqual(byId, { ok: true, taskId: task.id, via: 'id' })
  assert.deepEqual(byRef, { ok: true, taskId: task.id, via: 'ref' })
  // 首尾空白被 trim（模型抄回执常带空格），不做其它模糊匹配。
  assert.equal(resolveTaskInput(db, `  ${task.ref}  `).taskId, task.id)

  const cases = [
    ['', TASK_REF_MISSING],
    ['   ', TASK_REF_MISSING],
    ['tk-000000', TASK_REF_UNKNOWN],
    ['t-ffffffff', TASK_REF_UNKNOWN],
    ['任务名', TASK_REF_UNKNOWN],
    ['tk-7f3a2', TASK_REF_UNKNOWN],
    ['session-1234abcd', TASK_REF_UNKNOWN],
    ['t-', TASK_REF_UNKNOWN],
  ]
  for (const [input, expected] of cases) {
    const result = resolveTaskInput(db, input)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.equal(result.message, expected, `文案不对：${JSON.stringify(input)}`)
  }
  // 空值/未知值的 reason 区分（调用方要能分别记日志）。
  assert.equal(resolveTaskInput(db, '').reason, 'empty')
  assert.equal(resolveTaskInput(db, 'session-1234abcd').reason, 'invalid')
  assert.equal(resolveTaskInput(db, 'tk-000000').reason, 'not-found')
  // 错误文案不泄内部结构：没有表名/SQL/内部列名，也没有裸编号形态。
  for (const text of [TASK_REF_MISSING, TASK_REF_UNKNOWN, TASK_REF_RETIRED]) {
    assert.doesNotMatch(text, /task_refs|tasks|SELECT|INSERT|retired_at|token/i, text)
    assert.doesNotMatch(text, /\bt-[0-9a-z]{4,}\b/, text)
  }
  db.close()
})

test('解析：不支持 session id 别名、不做空参绑定（无 task_id 必报错）', async () => {
  const db = await openLedger(tempDir())
  const task = newTask(db)
  db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('session-abcdef', task.id)
  for (const value of ['session-abcdef', task.id.slice(0, 8), undefined, null, 0, {}]) {
    const result = resolveTaskInput(db, value)
    assert.equal(result.ok, false, `不该解析：${JSON.stringify(value)}`)
  }
  db.close()
})

test('并发/撞号：主键挡重复 token，重试后仍能拿到唯一引用', async () => {
  const db = await openLedger(tempDir())
  const first = newTask(db, 'A')
  // 让下一条任务第一次抽到已占用的 token（固定序列），ensureTaskRef 必须重试到新号。
  const taken = first.ref
  const seq = [3, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0]
  let cursor = 0
  const second = newTask(db, 'B')
  db.exec(`DELETE FROM task_refs WHERE task_id = '${second.id}'`)
  const regenerated = ensureTaskRef(db, second.id, { nextInt: () => seq[Math.min(cursor++, seq.length - 1)] })
  assert.match(regenerated ?? '', TASK_REF_RE)
  assert.notEqual(regenerated, taken)
  assert.equal(taskRefOf(db, second.id), regenerated)
  db.close()
})

test('列表读出来的任务都带 ref（面板/回执不必各自查映射表）', async () => {
  const db = await openLedger(tempDir())
  newTask(db, 'A')
  newTask(db, 'B')
  for (const task of listTasks(db)) assert.match(task.ref ?? '', TASK_REF_RE)
  db.close()
})

test('老库（连 task_refs 表都没有）打开时建表并回填，不抛', async () => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const task = newTask(db)
  db.close()
  // 手工造一个「升级前」的库：删掉 task_refs 表。
  const raw = new DatabaseSync(join(dir, 'tasks.sqlite'))
  raw.exec('DROP TABLE task_refs')
  raw.close()
  const migrated = await openLedger(dir)
  const tokens = migrated.prepare('SELECT count(*) AS n FROM task_refs').get().n
  assert.equal(Number(tokens), 1)
  assert.match(taskRefOf(migrated, task.id) ?? '', TASK_REF_RE)
  migrated.close()
})
