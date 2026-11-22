// 版本 B《ID 出口网关》§7：计划文档文件名 = **任务名**。
//
// 这一组用例就是计划 §7.4 的 11 条（非法字符 / 空白与控制符 / 空名兜底 / Windows 保留名 / 长度预算 /
// 同名 -2 / 幂等覆写 / 大小写不敏感 / 前导点与尾部符号 / 路径逃逸 / 极深目录）。
// 纯函数（`sanitizePlanStem` / `planFileName` / `planDocPath`）与真落盘（`writePlanDocument`）都断。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLedger, createTask, getTask, setTaskPlanPath } from '../src/ledger.js'
import {
  PLAN_FALLBACK_NAME, PLAN_PATH_MAX, PLAN_STEM_MAX, PLAN_SUBDIR,
  planDocPath, planFileName, sanitizePlanStem, writePlanDocument,
} from '../src/plan-doc.js'
import { sampleBrief, tempDir } from './helpers.js'

/** 只断言「安全不变量」：没有分隔符/控制符、不是保留名、路径仍在 plans/ 下。 */
const assertSafeName = (name, mainDir) => {
  assert.match(name, /\.md$/, `应以 .md 结尾：${name}`)
  assert.equal(/[\\/:*?"<>|\u0000-\u001F\u007F]/.test(name), false, `含非法字符：${name}`)
  assert.equal(name.startsWith('.'), false, `不应以点开头：${name}`)
  assert.equal(name, name.trim())
  const target = planDocPath(mainDir, name)
  assert.equal(target.ok, true, `路径应合法：${name}`)
  assert.equal(target.path.startsWith(join(resolve(mainDir), PLAN_SUBDIR)), true, `路径应仍在 plans/ 下：${target.path}`)
  assert.ok(target.path.length <= PLAN_PATH_MAX, `路径超预算：${target.path.length}`)
}

test('用例 1：ASCII 非法字符全部换成 -（A/B:C*D?E"F<G>H|I）', () => {
  assert.equal(sanitizePlanStem('A/B:C*D?E"F<G>H|I'), 'A-B-C-D-E-F-G-H-I.md')
  assertSafeName(sanitizePlanStem('A/B:C*D?E"F<G>H|I'), tempDir())
})

test('用例 2：全角空格/制表/换行 → -；换行被删不伪造小节（任务　网关\\ttest\\n）', () => {
  assert.equal(sanitizePlanStem('任务　网关\ttest\n'), '任务-网关-test.md')
  // 换行不是空白而是「行边界」：直接删，避免 `-` 把标题读断成两段。
  assert.equal(sanitizePlanStem('甲\n乙'), '甲乙.md')
})

test('用例 3：清洗后为空 → 未命名任务（***）', () => {
  assert.equal(sanitizePlanStem('***'), `${PLAN_FALLBACK_NAME}.md`)
  assert.equal(sanitizePlanStem('   '), `${PLAN_FALLBACK_NAME}.md`)
  assert.equal(sanitizePlanStem(''), `${PLAN_FALLBACK_NAME}.md`)
  assert.equal(sanitizePlanStem('-_-'), `${PLAN_FALLBACK_NAME}.md`)
})

test('用例 4：Windows 保留名加前缀（CON / con.md / NUL）', () => {
  assert.equal(sanitizePlanStem('CON'), '任务-CON.md')
  assert.equal(sanitizePlanStem('con.md'), '任务-con.md')
  assert.equal(sanitizePlanStem('NUL'), '任务-NUL.md')
  assert.equal(sanitizePlanStem('LPT1'), '任务-LPT1.md')
  assert.equal(sanitizePlanStem('COM9'), '任务-COM9.md')
  // 只是前缀相同、不是保留名的不动。
  assert.equal(sanitizePlanStem('CONSOLE'), 'CONSOLE.md')
})

test('用例 5：200 字标题 → stem ≤ 60 code unit、路径 ≤ 240、可创建', async () => {
  const mainDir = join(tempDir(), 'main')
  const title = '长'.repeat(200)
  const name = planFileName(title)
  assert.ok(name.length <= PLAN_STEM_MAX + '.md'.length, `stem 超长：${name.length}`)
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1', planFirst: true })
  const written = await writePlanDocument({ db, mainDir, task, content: '正文' })
  assert.equal(written.ok, true)
  assert.ok(written.path.length <= PLAN_PATH_MAX, `路径超预算：${written.path.length}`)
  assert.equal(existsSync(written.path), true)
  // 文件名就是截断后的任务名（不是编号、不是 token）。
  assert.equal(written.path.endsWith(name), true)
  assert.doesNotMatch(written.path, /\bt-[0-9a-z]{8}\b/)
  db.close()
})

test('用例 6：两个同名任务「周报」→ 周报.md + 周报-2.md，正文头都是 # 计划：周报，plan_path 各自正确', async () => {
  const mainDir = join(tempDir(), 'main')
  const db = await openLedger(tempDir())
  const a = createTask(db, { brief: sampleBrief({ title: '周报' }), coordinatorSession: 's-1', planFirst: true })
  const b = createTask(db, { brief: sampleBrief({ title: '周报' }), coordinatorSession: 's-1', planFirst: true })
  const first = await writePlanDocument({ db, mainDir, task: a, content: '甲的计划' })
  setTaskPlanPath(db, a.id, first.path)
  const second = await writePlanDocument({ db, mainDir, task: b, content: '乙的计划' })
  setTaskPlanPath(db, b.id, second.path)
  assert.equal(first.path.endsWith('周报.md'), true)
  assert.equal(second.path.endsWith('周报-2.md'), true)
  // 后缀只出现在文件名，不进正文（用户面只看任务名）。
  assert.match(readFileSync(first.path, 'utf8'), /^# 计划：周报\n/)
  assert.match(readFileSync(second.path, 'utf8'), /^# 计划：周报\n/)
  assert.equal(getTask(db, a.id).plan_path, first.path)
  assert.equal(getTask(db, b.id).plan_path, second.path)
  assert.deepEqual(readdirSync(join(mainDir, 'reports', 'plans')).sort(), ['周报-2.md', '周报.md'])
  db.close()
})

test('用例 7：同一任务连续 plan_save 两次 → 路径不变、内容覆盖、不生成 -2', async () => {
  const mainDir = join(tempDir(), 'main')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '幂等' }), coordinatorSession: 's-1', planFirst: true })
  const first = await writePlanDocument({ db, mainDir, task, content: '第一版' })
  setTaskPlanPath(db, task.id, first.path)
  // 第二次：任务行已带 plan_path（幂等优先）→ 原路径覆写。
  const againTask = getTask(db, task.id)
  const second = await writePlanDocument({ db, mainDir, task: againTask, content: '第二版' })
  assert.equal(second.path, first.path)
  assert.equal(second.reused, true)
  const body = readFileSync(first.path, 'utf8')
  assert.ok(body.includes('第二版'))
  assert.equal(body.includes('第一版'), false)
  assert.deepEqual(readdirSync(join(mainDir, 'reports', 'plans')), ['幂等.md'])
  db.close()
})

test('用例 8：大小写不敏感——Report 与 report 视为同名 → report-2.md', async () => {
  const mainDir = join(tempDir(), 'main')
  const db = await openLedger(tempDir())
  const upper = createTask(db, { brief: sampleBrief({ title: 'Report' }), coordinatorSession: 's-1', planFirst: true })
  const lower = createTask(db, { brief: sampleBrief({ title: 'report' }), coordinatorSession: 's-1', planFirst: true })
  const first = await writePlanDocument({ db, mainDir, task: upper, content: 'A' })
  setTaskPlanPath(db, upper.id, first.path)
  const second = await writePlanDocument({ db, mainDir, task: lower, content: 'B' })
  assert.equal(first.path.endsWith('Report.md'), true)
  assert.equal(second.path.endsWith('report-2.md'), true)
  // 纯函数层同口径（taken 用小写比较）。
  assert.equal(planFileName('report', { taken: ['report.md'] }), 'report-2.md')
  assert.equal(planFileName('Report', { taken: ['report.md'] }), 'Report-2.md')
  db.close()
})

test('用例 9：前导点与首尾符号被去掉（.hidden / A- / A.）', () => {
  assert.equal(sanitizePlanStem('.hidden'), 'hidden.md')
  assert.equal(sanitizePlanStem('..hidden'), 'hidden.md')
  assert.equal(sanitizePlanStem('A-'), 'A.md')
  assert.equal(sanitizePlanStem('A.'), 'A.md')
  assert.equal(sanitizePlanStem('  A  '), 'A.md')
  assert.equal(sanitizePlanStem('A--B'), 'A-B.md')
})

test('用例 10：路径分隔符被清洗，最终路径仍在 reports/plans/ 下（..\\..\\etc\\x）', () => {
  const mainDir = join(tempDir(), 'main')
  const name = sanitizePlanStem('..\\..\\etc\\x')
  assert.equal(name.includes('\\'), false)
  assert.equal(name.includes('/'), false)
  assertSafeName(name, mainDir)
  // 白名单兜底：即便有人硬塞带分隔符的名字，planDocPath 也拒绝。
  assert.equal(planDocPath(mainDir, '../etc/x.md').ok, false)
  assert.equal(planDocPath(mainDir, 'a\\b.md').ok, false)
  assert.equal(planDocPath(mainDir, '..').ok, false)
})

test('用例 11：极深工作区 + 长标题 → 按路径预算截断后仍能创建（≤240）', async () => {
  // 造一条接近预算的目录：plans 目录本身就要吃掉大部分 240 字符预算。
  const base = tempDir()
  let deep = base
  for (let index = 0; index < 6; index += 1) {
    deep = join(deep, `第${index}层目录`)
    mkdirSync(deep, { recursive: true })
  }
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '很长的任务标题'.repeat(8) }), coordinatorSession: 's-1', planFirst: true })
  const written = await writePlanDocument({ db, mainDir: deep, task, content: '深目录计划' })
  assert.equal(written.ok, true, written.error)
  assert.ok(written.path.length <= PLAN_PATH_MAX, `路径超预算：${written.path.length}`)
  assert.equal(existsSync(written.path), true)
  assert.equal(written.path.startsWith(join(resolve(deep), PLAN_SUBDIR)), true)
  db.close()
})
