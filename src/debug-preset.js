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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DEBUG_PRESET_ID = 'orch-debug'
export const SOURCE_PRESET_ID = 'cordis'
export const DEBUG_PRESET_NAME = '调试（创造者能力）'
export const DEBUG_PRESET_DESCRIPTION = '「创造模式」组合的副本：只读运行时洞察工具 + dsh-doc 技能，给调试子会话用。'
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

/** 解析技能目录：显式目录 > 从 asar 抄到 bundle > 跳过（缺源时）。 */
function resolveSkillDir({ outDir, skills, skillsDir, located }) {
  if (typeof skillsDir === 'string' && skillsDir !== '') return { dir: resolve(skillsDir), status: 'external' }
  if (skills === false) return { dir: undefined, status: 'skipped:disabled' }
  // 普通文件源（源码检出）不假定技能目录位置：用 --skills-dir 显式给。
  if (located.kind !== 'asar') return { dir: undefined, status: 'skipped:no-asar-source' }
  const target = join(outDir, 'skills')
  const copied = copyAsarTree(located.path, SKILLS_ENTRY, target)
  if (copied.ok !== true) return { dir: undefined, status: `skipped:${copied.reason}` }
  return { dir: target, status: `copied:${copied.files.length}` }
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
    '# 重新生成：node scripts/orch-debug-preset.mjs',
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
  return {
    ...result,
    source: { kind: located.kind, path: located.path, entry: located.entry },
    skills: skill.status,
    skillDir: skill.dir,
  }
}
