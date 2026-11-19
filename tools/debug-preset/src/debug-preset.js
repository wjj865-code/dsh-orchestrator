// 调试预设（orch-debug）：把随包发货的「创造模式」(preset id: cordis) 组合复制成一个独立预设，
// 让调试子会话拿到 cordis_* 只读运行时洞察工具与 dsh-doc 技能。
//
// 平台现状（DSH 0.2.2-rc.3 起）：预设 = bundle 补丁里的 `@deepseek-ai/dsh-agent-preset` 声明行，
// 旧的 `$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 目录已经没人读了
// （见随包文档「Migrate a legacy preset」：Nothing reads that directory any more）。
// 所以这里产出的不是目录格式，而是一个可安装的 bundle：
//   <outDir>/package.json        —— dsh.bundle.patch 指向 cordis.patch.yml
//   <outDir>/cordis.patch.yml    —— insert 一行 preset-orch-debug 声明
//   <outDir>/skills/dsh-doc/     —— 从安装包抄出的 dsh-doc 技能（有 asar 源时）
// 安装走 plugin_manager 的 install_bundle（或手工把声明行合并进 profile 补丁）。
//
// 本模块只做「读源组合 → 拼 YAML → 落盘」，不安装、不改 profile；失败一律降级成可读结果，
// 不抛异常（加载期/CLI 都不该因为找不到源组合而崩）。
//
// 位置（P1-E）：这是**维护者工具**，已从插件主包外移到开发仓库的 `tools/debug-preset/`，
// 不随 `@wjj865-code/dsh-orchestrator` 发货（package.json 的 files 不含 tools/）。
// 插件运行时只透传 `config.workerPreset`（如 `orch-debug`）给宿主，不 import 本模块。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DEBUG_PRESET_ID = 'orch-debug'
export const SOURCE_PRESET_ID = 'cordis'
export const DEBUG_PRESET_NAME = '调试（创造者能力）'
export const DEBUG_PRESET_DESCRIPTION = '「创造模式」组合的副本：运行时洞察 + dsh-doc 技能 + plugin_manager，给调试子会话用。'
export const DEBUG_PRESET_ORDER = 300
/** 随包发货 preset 在 Desktop 的 app.asar 里的路径（web-app bundle 的 presets 目录）。 */
export const SOURCE_PRESET_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml'
/** 随包「创造模式」挂载的技能目录（dsh-doc），复制到 bundle 里，避免依赖 baseUrl 解析。 */
export const SKILLS_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills'
export const DEBUG_PRESET_PACKAGE_NAME = '@local/dsh-orch-debug-preset'

const SOURCE_HINT = '找不到随包发货的 presets/cordis.patch.yml：用 --source <path> 指定（源码检出在 packages/bundle/web-app/presets/cordis.patch.yml），'
  + '或设置 DSH_ORCH_DEBUG_PRESET_SOURCE / DSH_ASAR 指向安装目录里的 app.asar。'
const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const indentOf = line => line.length - line.trimStart().length

/** 调试预设 bundle 的落地目录：$DSH_HOME/state/orchestrator/debug-presets/orch-debug。 */
export function debugPresetDir(stateDir) {
  return join(stateDir, 'debug-presets', DEBUG_PRESET_ID)
}

/**
 * 打开 asar 归档的目录索引（Electron 布局：16 字节 pickle 头 + JSON 目录 + 内容区）。
 * 读不到/结构不合法就返回 undefined，让调用方走降级分支。
 */
function openAsarIndex(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error('短的 asar 头')
    const headerSize = head.readUInt32LE(12)
    // 目录 JSON 大小按头字段读；异常值直接放弃，避免按坏字段分配巨大 buffer。
    if (!(headerSize > 0 && headerSize < 512 * 1024 * 1024)) throw new Error('坏的目录大小')
    const headerBuffer = Buffer.alloc(headerSize)
    if (readSync(fd, headerBuffer, 0, headerSize, 16) !== headerSize) throw new Error('目录读不全')
    // 内容区起点 = 8 + pickle 负载大小（头里第 2 个 u32）；文件 offset 相对内容区起点。
    return { fd, header: JSON.parse(headerBuffer.toString('utf8')), contentBase: 8 + head.readUInt32LE(4) }
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 关失败不影响结果 */ }
    }
    return undefined
  }
}

const asarNodeAt = (header, entryPath) => {
  let node = header
  for (const part of entryPath.split('/')) {
    if (node?.files === undefined) return undefined
    node = node.files[part]
    if (node === undefined) return undefined
  }
  return node
}

const readAsarNode = (index, node) => {
  if (node?.files !== undefined || typeof node?.size !== 'number' || node.size < 0) return undefined
  const content = Buffer.alloc(node.size)
  if (node.size === 0) return ''
  const read = readSync(index.fd, content, 0, node.size, index.contentBase + Number(node.offset))
  return read === node.size ? content.toString('utf8') : undefined
}

/** 从 asar 归档里读一个文件；读不到返回 undefined。 */
export function readAsarFile(asarPath, entryPath) {
  const index = openAsarIndex(asarPath)
  if (index === undefined) return undefined
  try {
    return readAsarNode(index, asarNodeAt(index.header, entryPath))
  } finally {
    try { closeSync(index.fd) } catch { /* 关失败不影响结果 */ }
  }
}

/** 列出 asar 归档里某个目录下的所有文件（相对该目录的路径 + 字节数）；目录不存在返回 undefined。 */
export function listAsarEntries(asarPath, entryPath) {
  const index = openAsarIndex(asarPath)
  if (index === undefined) return undefined
  try {
    const root = asarNodeAt(index.header, entryPath)
    if (root?.files === undefined) return undefined
    const out = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const path = `${prefix}${name}`
        if (child.files !== undefined) walk(child, `${path}/`)
        else if (typeof child.size === 'number') out.push({ path, size: child.size })
      }
    }
    walk(root, '')
    return out
  } finally {
    try { closeSync(index.fd) } catch { /* 关失败不影响结果 */ }
  }
}

/**
 * 把 asar 里的一棵目录树原样抄到本地目录（用于把 dsh-doc 技能带进生成的 bundle）。
 * 返回 { ok:true, dir, files:[相对路径] } 或 { ok:false, reason }；不抛异常。
 */
export function copyAsarTree(asarPath, entryPath, outDir) {
  const index = openAsarIndex(asarPath)
  if (index === undefined) return { ok: false, reason: 'asar-unreadable' }
  try {
    const root = asarNodeAt(index.header, entryPath)
    if (root?.files === undefined) return { ok: false, reason: 'entry-missing' }
    const files = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const relative = prefix === '' ? name : `${prefix}/${name}`
        if (child.files !== undefined) {
          walk(child, relative)
          continue
        }
        const content = readAsarNode(index, child)
        if (content === undefined) continue
        const target = join(outDir, ...relative.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, 'utf8')
        files.push(relative)
      }
    }
    walk(root, '')
    return files.length === 0 ? { ok: false, reason: 'entry-empty' } : { ok: true, dir: outDir, files }
  } catch (error) {
    return { ok: false, reason: 'copy-failed', hint: error?.message ?? String(error) }
  } finally {
    try { closeSync(index.fd) } catch { /* 关失败不影响结果 */ }
  }
}


/** 候选源路径：显式参数 > 环境变量 > Electron 资源目录 > 各平台默认安装位置。 */
export function sourcePresetCandidates({ source, env = process.env, platform = process.platform, resourcesPath } = {}) {
  const candidates = []
  const add = value => {
    if (typeof value === 'string' && value !== '') candidates.push(value)
  }
  add(source)
  add(env?.DSH_ORCH_DEBUG_PRESET_SOURCE)
  add(env?.DSH_ASAR)
  if (typeof resourcesPath === 'string' && resourcesPath !== '') add(join(resourcesPath, 'app.asar'))
  if (typeof env?.DSH_INSTALL_DIR === 'string' && env.DSH_INSTALL_DIR !== '') add(join(env.DSH_INSTALL_DIR, 'resources', 'app.asar'))
  if (platform === 'win32') {
    if (typeof env?.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '') {
      add(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    }
    if (typeof env?.PROGRAMFILES === 'string' && env.PROGRAMFILES !== '') {
      add(join(env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar'))
    }
  } else if (platform === 'darwin') {
    add('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  }
  return [...new Set(candidates)]
}

/**
 * 定位源组合文本：`.asar` 走归档读，其它路径按普通 YAML 读。
 * 返回 { ok:true, kind, path, entry?, text } 或 { ok:false, reason, tried }。
 */
export function locateSourcePreset({ source, env = process.env, platform = process.platform, resourcesPath } = {}) {
  const tried = []
  for (const candidate of sourcePresetCandidates({ source, env, platform, resourcesPath })) {
    if (!existsSync(candidate)) {
      tried.push(`${candidate}（不存在）`)
      continue
    }
    try {
      if (candidate.toLowerCase().endsWith('.asar')) {
        const text = readAsarFile(candidate, SOURCE_PRESET_ENTRY)
        if (text === undefined) {
          tried.push(`${candidate}#${SOURCE_PRESET_ENTRY}（归档里没有该文件）`)
          continue
        }
        return { ok: true, kind: 'asar', path: candidate, entry: SOURCE_PRESET_ENTRY, text }
      }
      return { ok: true, kind: 'file', path: candidate, text: readFileSync(candidate, 'utf8') }
    } catch (error) {
      tried.push(`${candidate}（读取失败：${error?.message ?? error}）`)
    }
  }
  return { ok: false, reason: 'no-source', tried }
}

/**
 * 从补丁文本里抠出某个预设声明行的 `plugins:` 子列表，统一去掉缩进后返回。
 * 只做行级扫描：源文件是随包发货的固定结构，够用且不引 yaml 依赖。
 */
export function extractPluginsBlock(text, presetId = SOURCE_PRESET_ID) {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.split(/\r?\n/)
  const rowRe = new RegExp(`^(\\s*)-\\s*id:\\s*preset-${escapeRe(presetId)}\\s*$`)
  let rowIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (rowRe.test(lines[index])) { rowIndex = index; break }
  }
  if (rowIndex < 0) return undefined
  const rowIndent = indentOf(lines[rowIndex])
  let pluginsIndex = -1
  let pluginsIndent = -1
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= rowIndent) break
    const match = /^(\s*)plugins:\s*$/.exec(line)
    if (match !== null) {
      pluginsIndex = index
      pluginsIndent = match[1].length
      break
    }
  }
  if (pluginsIndex < 0) return undefined
  const body = []
  for (let index = pluginsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { body.push(''); continue }
    const indent = indentOf(line)
    if (indent <= pluginsIndent) break
    // 列表项在 pluginsIndent+2：统一左移到第 0 列，其余层级保持相对缩进。
    body.push(line.slice(Math.min(indent, pluginsIndent + 2)))
  }
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return body.length === 0 ? undefined : body.join('\n')
}

const yamlQuote = value => `'${String(value).replace(/'/g, "''")}'`

/**
 * 改写 plugins 列表里 skill-filesystem 的 `customSkillDirs`。
 *
 * 源组合写的是 `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`：
 * 这个表达式只在「补丁与 @deepseek-ai/dsh-agent-preset 同处一个 node_modules」时成立（随包布局），
 * 装到 profile 里的 bundle 解析不到那个包（MODULE_NOT_FOUND），整条预设声明都会激活失败。
 * 所以这里换成 bundle 自己的技能目录绝对路径；传 undefined 时整段删掉（退回默认技能根）。
 * 找不到这段就原样返回。
 */
export function replaceSkillDirs(pluginsText, skillDir) {
  if (typeof pluginsText !== 'string' || pluginsText === '') return pluginsText
  const lines = pluginsText.split('\n')
  const rowIndex = lines.findIndex(line => /^\s*-\s*id:\s*skill-filesystem\s*$/.test(line))
  if (rowIndex < 0) return pluginsText
  const rowIndent = indentOf(lines[rowIndex])
  let keyIndex = -1
  let keyIndent = -1
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= rowIndent) break
    const match = /^(\s*)customSkillDirs:\s*$/.exec(line)
    if (match !== null) { keyIndex = index; keyIndent = match[1].length; break }
  }
  if (keyIndex < 0) return pluginsText
  let end = keyIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    end += 1
  }
  const replacement = typeof skillDir === 'string' && skillDir !== ''
    ? [`${' '.repeat(keyIndent)}customSkillDirs:`, `${' '.repeat(keyIndent + 2)}- ${yamlQuote(skillDir)}`]
    : []
  return [...lines.slice(0, keyIndex), ...replacement, ...lines.slice(end)].join('\n')
}

const CUSTOM_SKILLS_RE = /^(\s*)customSkillDirs:\s*$/

/**
 * 把 `customSkillDirs` 整块（键 + 值）删掉，用于「对齐比较」。
 *
 * 源组合（随包 cordis）写的是 baseUrl 解析表达式，生成物写的是 bundle 里的绝对路径或整块省略
 * （`--no-skills` / 源码检出无技能源）：三者语义差别只在技能根落点，工具/权限/系统提示不受影响。
 * 所以比较插件列表时整块抹平；技能根是否真的可用由 `checkDebugPreset` 的 `skills` 单独查。
 */
export function normalizeSkillDirsBlock(pluginsText) {
  if (typeof pluginsText !== 'string' || pluginsText === '') return pluginsText
  const lines = pluginsText.split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = CUSTOM_SKILLS_RE.exec(lines[index])
    if (match === null) {
      out.push(lines[index])
      continue
    }
    const keyIndent = match[1].length
    // 跳过键和值块（比 key 更深的行），下一轮从块的下一行继续。
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() !== '' && indentOf(line) <= keyIndent) break
      end += 1
    }
    index = end - 1
  }
  return out.join('\n')
}

/**
 * 从生成物里读 `customSkillDirs` 指向的技能根（只认生成器写的单引号绝对路径）。
 * 源组合的 `!!js` 表达式返回 undefined——它不是可检查的本地路径。
 */
export function customSkillDirOf(pluginsText) {
  if (typeof pluginsText !== 'string' || pluginsText === '') return undefined
  const lines = pluginsText.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = CUSTOM_SKILLS_RE.exec(lines[index])
    if (match === null) continue
    const keyIndent = match[1].length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      if (indentOf(line) <= keyIndent) break
      const value = /^\s*-\s*(.+)$/.exec(line)
      if (value === null) continue
      let raw = value[1].trim()
      if (raw.startsWith('!!js')) return undefined
      if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1).replace(/''/g, "'")
      return raw
    }
  }
  return undefined
}

/** 插件列表按顶层行（`- id:` 在第 0 列）切成一行一条；组内子行随父行保留。 */
export function splitPluginRows(pluginsText) {
  if (typeof pluginsText !== 'string' || pluginsText.trim() === '') return []
  const rows = []
  let current
  for (const line of pluginsText.split('\n')) {
    const rowMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (rowMatch !== null) {
      current = { id: rowMatch[1], lines: [line] }
      rows.push(current)
    } else if (current !== undefined) {
      current.lines.push(line)
    }
  }
  return rows.map(row => ({
    id: row.id,
    name: (/^ {2}name:\s*(.+)$/m.exec(row.lines.join('\n'))?.[1] ?? '').trim(),
    disabled: (/^ {2}disabled:\s*(.+)$/m.exec(row.lines.join('\n'))?.[1] ?? '').trim(),
    // 行文本抹平技能根后逐字比较：工具行、`!!js` 条件、块量系统提示、顺序都算进对齐。
    text: normalizeSkillDirsBlock(row.lines.join('\n')).trimEnd(),
  }))
}

/** 找两段文本的第一处不同，给对齐差异一句可读定位。 */
function firstLineDifference(left, right) {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const total = Math.max(leftLines.length, rightLines.length)
  for (let index = 0; index < total; index += 1) {
    if (leftLines[index] === rightLines[index]) continue
    const format = line => line === undefined ? '(结束)' : JSON.stringify(line.trim() === '' ? ' ' : line.trim())
    return `第 ${index + 1} 行：源 ${format(leftLines[index])}，生成物 ${format(rightLines[index])}`
  }
  return '内容不同'
}

/**
 * 比较「源预设的 plugins」与「生成物的 plugins」：返回逐行差异。
 *
 * 生成器只允许四处改写（预设 id / 显示名 / 描述 / 排序）与 `customSkillDirs` 的落点；
 * plugins 列表本身必须逐字一致——工具、技能、`disabled` 权限条件、persona 系统提示都在里面。
 * 对齐比较是 `prepareDebugPreset` 的自检，也是 `--check` 在 DSH 升级后判断「要不要重新生成」的依据。
 */
export function comparePresetPlugins(sourcePlugins, generatedPlugins) {
  const source = splitPluginRows(sourcePlugins)
  const generated = splitPluginRows(generatedPlugins)
  const differences = []
  const generatedById = new Map(generated.map(row => [row.id, row]))
  const sourceById = new Map(source.map(row => [row.id, row]))
  for (const row of source) {
    if (!generatedById.has(row.id)) {
      differences.push({ kind: 'missing', id: row.id, detail: `缺少插件行 ${row.id}（${row.name}）` })
    }
  }
  for (const row of generated) {
    if (!sourceById.has(row.id)) {
      differences.push({ kind: 'extra', id: row.id, detail: `多出插件行 ${row.id}（${row.name}）` })
    }
  }
  // 共同行的相对顺序变了也算差异：顺序会改变工具/提示词在请求里的排列。
  const commonSource = source.filter(row => generatedById.has(row.id)).map(row => row.id)
  const commonGenerated = generated.filter(row => sourceById.has(row.id)).map(row => row.id)
  for (let index = 0; index < Math.min(commonSource.length, commonGenerated.length); index += 1) {
    if (commonSource[index] === commonGenerated[index]) continue
    differences.push({
      kind: 'order',
      id: commonSource[index],
      detail: `共同插件行第 ${index + 1} 个应为 ${commonSource[index]}，实际 ${commonGenerated[index]}`,
    })
  }
  for (const left of source) {
    const right = generatedById.get(left.id)
    if (right === undefined) continue
    if (left.name !== right.name) {
      differences.push({ kind: 'name', id: left.id, detail: `${left.id}：包名 ${left.name} → ${right.name}` })
      continue
    }
    if (left.disabled !== right.disabled) {
      differences.push({
        kind: 'disabled',
        id: left.id,
        detail: `${left.id}：disabled ${left.disabled === '' ? '(无)' : left.disabled} → ${right.disabled === '' ? '(无)' : right.disabled}`,
      })
      continue
    }
    if (left.text !== right.text) {
      differences.push({ kind: 'config', id: left.id, detail: `${left.id}：${firstLineDifference(left.text, right.text)}` })
    }
  }
  return {
    aligned: differences.length === 0,
    sourceRows: source.length,
    generatedRows: generated.length,
    differences,
  }
}

/**
 * 检查**已生成的 bundle** 是否仍与当前安装的随包 `cordis` 组合对齐。
 *
 * 用途：DSH 升级后组合会变（增删工具、改 `disabled`、改系统提示），旧 bundle 不会自动跟随。
 * 返回 `{ ok:true, path, plugins, skills }`，或 `{ ok:false, reason, differences?, hint }`：
 * `missing-bundle` / `invalid-bundle` / `no-source` / `no-preset-row` / `drift`。
 * 技能只做报告：`skills.dshDoc` 为 false 表示没挂（`--no-skills` 或复制失败），不算漂移。
 */
export function checkDebugPreset({ outDir, source, env = process.env, platform = process.platform, resourcesPath } = {}) {
  if (typeof outDir !== 'string' || outDir === '') {
    return { ok: false, reason: 'no-out-dir', hint: '未指定输出目录（--out <dir>）' }
  }
  const dir = resolve(outDir)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    return { ok: false, reason: 'missing-bundle', hint: `没找到 ${patchPath}：先跑一次 node tools/debug-preset/cli.mjs 生成并安装` }
  }
  let existingText
  try {
    existingText = readFileSync(patchPath, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'read-failed', hint: `读取 ${patchPath} 失败：${error?.message ?? error}` }
  }
  const existingPlugins = extractPluginsBlock(existingText, DEBUG_PRESET_ID)
  if (existingPlugins === undefined) {
    return { ok: false, reason: 'invalid-bundle', hint: `${patchPath} 里没有 preset-${DEBUG_PRESET_ID} 的 plugins 列表` }
  }
  const located = locateSourcePreset({ source, env, platform, resourcesPath })
  if (located.ok !== true) {
    const tried = located.tried?.length ? `（已尝试：${located.tried.join('；')}）` : ''
    return { ok: false, reason: located.reason ?? 'no-source', hint: SOURCE_HINT + tried }
  }
  const sourcePlugins = extractPluginsBlock(located.text, SOURCE_PRESET_ID)
  if (sourcePlugins === undefined) {
    return {
      ok: false,
      reason: 'no-preset-row',
      hint: `${located.path} 里没有找到 \`- id: preset-${SOURCE_PRESET_ID}\` 的 plugins 列表：DSH 版本可能换了预设格式。`,
    }
  }
  const comparison = comparePresetPlugins(sourcePlugins, existingPlugins)
  const skillDir = customSkillDirOf(existingPlugins)
  const skills = { dir: skillDir, dshDoc: skillDir !== undefined && existsSync(join(skillDir, 'dsh-doc', 'SKILL.md')) }
  const sourceInfo = { kind: located.kind, path: located.path, entry: located.entry }
  if (comparison.aligned !== true) {
    return {
      ok: false,
      reason: 'drift',
      path: patchPath,
      source: sourceInfo,
      skills,
      differences: comparison.differences,
      hint: 'bundle 与当前随包 cordis 组合不一致：重新跑 node tools/debug-preset/cli.mjs，再重装 bundle 并彻底重启 DSH。',
    }
  }
  return { ok: true, path: patchPath, source: sourceInfo, plugins: comparison.generatedRows, skills }
}

/** 技能根下的技能目录名（用于报告「挂了哪些技能」，读不到时为空数组）。 */
export function skillNamesOf(dir) {
  if (typeof dir !== 'string' || dir === '' || !existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 解析技能目录：显式目录 > 从 asar 抄到 bundle > 跳过（缺源时）。 */
function resolveSkillDir({ outDir, skills, skillsDir, located }) {
  if (typeof skillsDir === 'string' && skillsDir !== '') {
    const dir = resolve(skillsDir)
    return { dir, status: 'external', names: skillNamesOf(dir) }
  }
  if (skills === false) return { dir: undefined, status: 'skipped:disabled', names: [] }
  // 普通文件源（源码检出）不假定技能目录位置：用 --skills-dir 显式给。
  if (located.kind !== 'asar') return { dir: undefined, status: 'skipped:no-asar-source', names: [] }
  const target = join(outDir, 'skills')
  const copied = copyAsarTree(located.path, SKILLS_ENTRY, target)
  if (copied.ok !== true) return { dir: undefined, status: `skipped:${copied.reason}`, names: [] }
  return { dir: target, status: `copied:${copied.files.length}`, names: skillNamesOf(target) }
}

/** 生成可安装 bundle 的补丁文本：insert 一行 preset-orch-debug 声明，plugins 原样保留。 */
export function renderBundlePatch({
  plugins,
  id = DEBUG_PRESET_ID,
  name = DEBUG_PRESET_NAME,
  description = DEBUG_PRESET_DESCRIPTION,
  order = DEBUG_PRESET_ORDER,
} = {}) {
  if (typeof plugins !== 'string' || plugins.trim() === '') throw new Error('renderBundlePatch 需要非空的 plugins 内容')
  const body = plugins.split('\n').map(line => line === '' ? '' : `          ${line}`).join('\n')
  return [
    `# 由 dsh-orchestrator 生成（勿手改）：preset ${id} = 随包「创造模式」(${SOURCE_PRESET_ID}) 组合的副本。`,
    '# 重新生成：node tools/debug-preset/cli.mjs',
    '# 对齐检查：node tools/debug-preset/cli.mjs --check',
    '- insert:',
    `    - id: preset-${id}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${id}`,
    `        name: ${yamlQuote(name)}`,
    `        description: ${yamlQuote(description)}`,
    `        order: ${order}`,
    '        plugins:',
    body,
    '',
  ].join('\n')
}

/** 生成 bundle 的 package.json 文本（dsh.bundle.patch 指向同目录补丁）。 */
export function renderBundleManifest({ version = '1.0.0' } = {}) {
  return `${JSON.stringify({
    name: DEBUG_PRESET_PACKAGE_NAME,
    version,
    private: true,
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`
}

/**
 * 把 bundle 落到 outDir（幂等：同内容重写不报错）。
 * 返回 { ok:true, outDir, files, patch } 或 { ok:false, reason:'write-failed', hint }。
 */
export function materializeDebugPreset({ outDir, plugins, ...options } = {}) {
  if (typeof outDir !== 'string' || outDir === '') return { ok: false, reason: 'no-out-dir', hint: '未指定输出目录' }
  let patch
  try {
    patch = renderBundlePatch({ plugins, ...options })
  } catch (error) {
    return { ok: false, reason: 'invalid-plugins', hint: error?.message ?? String(error) }
  }
  const patchPath = join(outDir, 'cordis.patch.yml')
  const manifestPath = join(outDir, 'package.json')
  try {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(patchPath, patch, 'utf8')
    writeFileSync(manifestPath, renderBundleManifest(options), 'utf8')
  } catch (error) {
    return { ok: false, reason: 'write-failed', hint: `写入 ${outDir} 失败：${error?.message ?? error}` }
  }
  return { ok: true, outDir, files: [manifestPath, patchPath], patch }
}

/**
 * 一步到位：定位源组合 → 抠 plugins → 改写技能目录 → 落 bundle。
 * 失败不抛异常，返回 { ok:false, reason, hint }，调用方决定怎么提示。
 */
export function prepareDebugPreset({ outDir, source, skills, skillsDir, env = process.env, platform = process.platform, resourcesPath, ...options } = {}) {
  if (typeof outDir !== 'string' || outDir === '') {
    return { ok: false, reason: 'no-out-dir', hint: '未指定输出目录（--out <dir>）' }
  }
  // 技能目录会以绝对路径写进补丁，所以先把输出目录规范化，避免相对路径被宿主按自己的 cwd 解析。
  const targetDir = resolve(outDir)
  const located = locateSourcePreset({ source, env, platform, resourcesPath })
  if (located.ok !== true) {
    const tried = located.tried?.length ? `（已尝试：${located.tried.join('；')}）` : ''
    return { ok: false, reason: located.reason ?? 'no-source', hint: SOURCE_HINT + tried }
  }
  const extracted = extractPluginsBlock(located.text, SOURCE_PRESET_ID)
  if (extracted === undefined) {
    return {
      ok: false,
      reason: 'no-preset-row',
      hint: `${located.path} 里没有找到 \`- id: preset-${SOURCE_PRESET_ID}\` 的 plugins 列表：DSH 版本可能换了预设格式，请人工核对。`,
    }
  }
  const skill = resolveSkillDir({ outDir: targetDir, skills, skillsDir, located })
  const result = materializeDebugPreset({ outDir: targetDir, plugins: replaceSkillDirs(extracted, skill.dir), ...options })
  if (result.ok !== true) return result
  // 自检：生成物里的 plugins 必须与源组合逐行一致（只允许 customSkillDirs 落点不同）。
  const generatedPlugins = extractPluginsBlock(result.patch, DEBUG_PRESET_ID)
  const alignment = comparePresetPlugins(extracted, generatedPlugins ?? '')
  return {
    ...result,
    source: { kind: located.kind, path: located.path, entry: located.entry },
    skills: skill.status,
    skillDir: skill.dir,
    skillNames: skill.names,
    alignment,
  }
}
