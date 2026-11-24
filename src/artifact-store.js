// 宿主受限产物写入口。同步初始化保证 task_create 的判定/落库/入队之间没有 await 窗口。
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { artifactStoreRootOf, getSetting, getTask, setSetting, setTaskArtifacts } from './ledger.js'
import { isInside } from './artifact-location.js'
import { sanitizePlanStem, MAX_PLAN_CHARS } from './plan-doc.js'

/** 不允许路径链上的软链接；系统级 /var → /private/var 在入口 realpath 后归一。 */
export function secureDirectory(root, path) {
  const base = realpathSync(root)
  const target = resolve(path)
  if (!isInside(base, target)) throw new Error('产物路径越界')
  const parts = []
  for (let cursor = target; cursor !== base; cursor = dirname(cursor)) parts.unshift(cursor)
  for (const part of parts) {
    if (!existsSync(part)) mkdirSync(part)
    const stat = lstatSync(part)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('产物目录不是安全的普通目录')
  }
  return target
}

export function ensureArtifactDirectory(db, task, mainDir) {
  const latest = getTask(db, task.id) ?? task
  let display = latest.artifact_dir
  if (!display) {
    if (!mainDir) throw new Error('没有主会话工作区，不能初始化产物目录')
    mkdirSync(mainDir, { recursive: true })
    const main = realpathSync(mainDir)
    display = secureDirectory(main, join(main, 'artifacts', task.id))
  } else secureDirectory(dirname(dirname(display)), display)
  secureDirectory(display, join(display, 'staging'))
  const privateBase = artifactStoreRootOf(db)
  if (!privateBase) throw new Error('没有宿主产物存储目录')
  mkdirSync(privateBase, { recursive: true })
  const base = realpathSync(privateBase)
  const store = latest.artifact_store_dir ?? join(base, task.id)
  secureDirectory(base, store)
  const identity = { taskId: task.id, title: task.title, coordinatorSession: task.coordinator_session, store, display }
  if (!existsSync(join(store, 'task.json'))) writeFileSync(join(store, 'task.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  // 引用被改写不会改变台账真源，也不经软链接开放宿主私有库。
  const reference = join(display, 'storage.json')
  if (!existsSync(reference)) writeFileSync(reference, JSON.stringify(identity), { flag: 'wx', mode: 0o600 })
  db.prepare('UPDATE tasks SET artifact_dir = ?, artifact_store_dir = ? WHERE id = ?').run(display, store, task.id)
  return store
}

export function saveArtifactDocument({ db, task, mainDir, name, content, callId } = {}) {
  if (typeof name !== 'string' || !name.trim() || /[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new Error('文档名必须是文件名，不能包含路径')
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_PLAN_CHARS) throw new Error(`文档正文不能为空，且不得超过 ${MAX_PLAN_CHARS} 字`)
  const root = ensureArtifactDirectory(db, task, mainDir)
  const docs = secureDirectory(root, join(root, 'docs'))
  const key = callId ? `artifact.document:${task.id}:${createHash('sha256').update(String(callId)).digest('hex')}` : null
  const digest = createHash('sha256').update(`${name}\0${content}`).digest('hex')
  const replay = key ? getSetting(db, key) : null
  let record
  if (replay) {
    record = JSON.parse(replay)
    if (record.digest !== digest) throw new Error('同一调用不能改变文档内容')
    if (dirname(record.path) !== docs) throw new Error('已保存文档路径不安全')
  }
  const stem = sanitizePlanStem(name).replace(/\.md$/, '')
  if (!record) {
    let version = 1
    while (existsSync(join(docs, `${stem}-${version}.md`))) version += 1
    record = { path: join(docs, `${stem}-${version}.md`), digest }
    // 先持久保留调用对应版本；保存后登记前崩溃也不会另生成版本。
    if (key) setSetting(db, key, JSON.stringify(record))
  }
  const { path } = record
  if (!existsSync(path)) {
    const pending = `${path}.pending`
    let fd
    // 中断的临时文件可重写；最终版本只在完整写入后出现。
    fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, content, 'utf8') } finally { closeSync(fd) }
    renameSync(pending, path)
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, 'utf8') !== content) throw new Error('已保存文档缺失、内容改变或不安全')
  setTaskArtifacts(db, task.id, [{ path, label: name, exists: true }])
  return { ...record, chars: content.length, bytes: Buffer.byteLength(content) }
}
