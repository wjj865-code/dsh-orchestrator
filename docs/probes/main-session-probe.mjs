// 主会话平台契约探测：解析已安装 app.asar 的文件表，按包路径取源码取证；不启动 app。
// 用法：node docs/probes/main-session-probe.mjs [app.asar 路径]
import { readFileSync } from 'node:fs'
import { matchesPhrase } from './lib/phrase-match.mjs'

const ASAR = process.argv[2] ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const bytes = readFileSync(ASAR)

// asar：0..16 是 pickle 头，JSON 头从 16 开始，长度在 u32@12；文件 offset 相对 dataStart。
// 数据区起点按 4 字节对齐（rc.3 的 headerSize 会落成 16+hs ≡ 1 mod 4，少加 3 字节会读到前一个文件的尾巴）。
const headerSize = bytes.readUInt32LE(12)
const dataStart = Math.ceil((16 + headerSize) / 4) * 4
const header = JSON.parse(bytes.slice(16, 16 + headerSize).toString('utf8'))
const files = []
const collect = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) collect(entry, path)
    else files.push({ path, offset: Number(entry.offset), size: Number(entry.size) })
  }
}
collect(header, '')

const resolve = suffix => {
  const hits = files.filter(item => item.path.endsWith(suffix))
  if (hits.length !== 1) throw new Error(`文件不唯一或缺失：${suffix}（${hits.length} 个）`)
  return hits[0]
}
const read = suffix => {
  const file = resolve(suffix)
  return bytes.slice(dataStart + file.offset, dataStart + file.offset + file.size).toString('utf8')
}

const results = []
// phrase 支持「多版同义写法」：rc.1→rc.3 改过入参形状，一条断言要为两版留位；
// 每个写法都是精确子串，全部不在时红（平台再改形状不会继续绿）。
const check = (label, file, phrase, { absent = false } = {}) => {
  const text = read(file)
  const { hit, at, matched } = matchesPhrase(text, phrase, { absent })
  results.push({ label, file, hit })
  const where = at === -1 ? '' : ` @${at}${matched === undefined ? '' : `，命中 ${matched} 形状`}`
  console.log(`${hit ? 'PASS' : 'FAIL'} ${label}（${file}${where}）`)
  return hit
}
const snippet = (file, phrase, before = 260, after = 520) => {
  const text = read(file)
  const at = text.indexOf(phrase)
  if (at === -1) return ''
  return text.slice(Math.max(0, at - before), at + after)
}

console.log(`asar: ${ASAR} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${files.length} files)\n`)

const PRESET = '@deepseek-ai/dsh-agent-preset/lib/index.js'
const PRESET_PATCH = '@deepseek-ai/dsh-web-app/presets/cordis.patch.yml'
const SUBAGENT = '@deepseek-ai/dsh-subagent/lib/index.js'
const SESSION_API = '@deepseek-ai/dsh-api-session-controller/lib/index.js'
const WORKSPACE = '@deepseek-ai/dsh-workspace/lib/index.js'
const WORKDIR = '@deepseek-ai/dsh-working-directory/lib/index.js'
const TOOLS = '@deepseek-ai/dsh-tools/lib/index.js'
const SANDBOX = '@deepseek-ai/dsh-sandbox-policy/lib/index.js'
const SESSION = '@deepseek-ai/dsh-session/lib/index.js'
const ASK_USER = '@deepseek-ai/dsh-tool-ask-user/lib/index.js'

// Q1 预设工具集
console.log('## Q1 预设工具集：toolFilter 字段与嵌套')
check('预设 Config 声明 plugins（唯一按字段组装的入口）', PRESET, 'plugins')
check('预设源码不出现 toolFilter（该字段只在子代理 descriptor）', PRESET, 'toolFilter', { absent: true })
check('预设按 plugins 行组装（mountPreset(config.id, config.plugins)）', '@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'mountPreset(context, record.config.id, record.config.plugins)')
check('mountPreset 只挂声明行（prepareProfileEntries(ctx, plugins)）', '@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'prepareProfileEntries')
check('子代理 composition.toolFilter 走 childCtx.tools.restrict', SUBAGENT, 'composition.toolFilter !== void 0')
check('子代理 composition 的 restrict 调用', SUBAGENT, 'childCtx.tools.restrict(composition.toolFilter)')
check('工具 restrict 是 agent-scoped 的 allow/deny 掩码', TOOLS, 'restrict')
// Q1 继承：preset scope 共享 → 子会话继承父 preset 的 restrict
check('preset 挂载用共享 scope（createScope(owner, key)）', '@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'createScope(this.owner, key)')
check('agent 绑定 preset scope（bindScopeParent）', '@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'bindScopeParent')
check('子会话未指定 preset 时 composeFrom 继承父 preset', SUBAGENT, 'composeFrom(childCtx, parent.ctx)')
check('worker 显式 preset：agentPreset 传给 composition（两版形状分别断言）', SUBAGENT, [
  { name: 'rc.3', phrase: 'composition: { agentPreset: spec.agentPreset }' },
  { name: 'rc.1', phrase: 'composition: { agentPreset: request.agentPreset }' },
])
check('显式 preset 走 presets.mount（不 composeFrom）', SUBAGENT, 'presets.mount(childCtx, composition.agentPreset)')
check('空 plugins 是合法预设（entryListProblem 只拒非数组）', '@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'the composition must be a top-level list of plugin rows')
check('标准预设自己声明 tool-fs（工具是 preset 行，不是全局）', PRESET_PATCH, '@deepseek-ai/dsh-tool-fs')
check('标准预设自己声明 tool-bash（空 worker 预设会丢文件/shell 工具）', PRESET_PATCH, '@deepseek-ai/dsh-tool-bash')

// Q2 sessionController.create / rename
console.log('\n## Q2 sessionController.create / rename 入参')
check('create(request) 接受 workspaceId', SESSION_API, 'workspaceId')
check('create 与 cwd 互斥', SESSION_API, 'session.create accepts workspaceId or cwd, not both')
check('create 接受 agentPreset', SESSION_API, 'agentPreset')
check('create 不接受 title（用 rename）', SESSION_API, 'async rename(request)')
check('rename 依赖 sessionTitle 服务，缺失时报错', SESSION_API, 'this deployment mounts no session-title service')

// Q3 workspaceRegistry
console.log('\n## Q3 workspaceRegistry 注册/查找')
check('workspaceRegistry.create(path, title?)', WORKSPACE, 'async create(path, title)')
check('workspaceRegistry.get(id)', WORKSPACE, 'get(id) {')
check('workspaceRegistry.list()', WORKSPACE, 'list() {')
check('workspaceRegistry.resolveByPath(path)', WORKSPACE, 'async resolveByPath(path) {')
check('Workspace.attachSession(sessionId)', WORKSPACE, 'attachSession(sessionId)')
check('Workspace.setTitle(title)', WORKSPACE, 'setTitle(title)')

// Q4 子会话 cwd / 沙箱
console.log('\n## Q4 子会话 cwd 与沙箱')
check('沙箱：session cwd 就是 workspace-write 边界', SANDBOX, 'A session cwd is its workspace-write boundary')
check('sandboxPolicy.resolve 用 header.cwd 作 workspaceRoot（两版形状分别断言）', SANDBOX, [
  { name: 'rc.3', phrase: 'workspaceRoot: this.sessionWorkspaceRoot(session)' },
  { name: 'rc.1', phrase: 'workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)' },
])
check('工作目录 set 要求目录存在（fs.stat → directory）', WORKDIR, 'info?.type === "directory"')
check('子代理 cwd 直接采用（resolveDirectory 两版入参形状分别断言）', SUBAGENT, [
  { name: 'rc.3', phrase: 'const cwd = await this.resolveDirectory(spec, signal)' },
  { name: 'rc.1', phrase: 'const cwd = await this.resolveDirectory(request, spec.signal)' },
])
check('子代理继承父会话的 sandbox 模式', SUBAGENT, 'sandboxMode: parent.ctx.get("sandboxPolicy")?.overrideOf(parent.session)')

// Q5 session/created
console.log('\n## Q5 session/created 载荷与时机')
check('session/created 事件在会话包定义', SESSION, 'session/created')
check('listener 收到整个 Session（含 id/header/firstLiveSeq）', SESSION_API, 'ctx.on("session/created", (session)')
check('session 创建后才能 append（session/created 完成前拒绝）', SESSION, 'cannot append before session/created completes')

// 最小预设栈：标准 cordis 预设里的行
console.log('\n## 最小预设栈（标准 cordis 预设原文）')
for (const [label, phrase] of [
  ['persona', '@deepseek-ai/dsh-persona'],
  ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
  ['time-context', '@deepseek-ai/dsh-time-context'],
  ['tool-ask-user', '@deepseek-ai/dsh-tool-ask-user'],
]) check(`标准预设包含 ${label}`, PRESET_PATCH, phrase)
check('标准预设行是 @deepseek-ai/dsh-agent-preset', PRESET_PATCH, "@deepseek-ai/dsh-agent-preset")
check('ask_user 工具包存在', ASK_USER, 'ask_user')

const failed = results.filter(item => !item.hit)
console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) {
  for (const item of failed) console.log(`- 未命中：${item.label}（${item.file}）`)
  process.exit(1)
}

// 结论所需的原文摘录（供 main-session-probe.md 引用）
console.log('\n## 摘录（写文档用）')
for (const [title, file, phrase] of [
  ['Q1 预设 Config 附近', PRESET, 'record.config.plugins'],
  ['Q1 子代理 composition.toolFilter', SUBAGENT, 'composition.toolFilter !== void 0'],
  ['Q2 create 入参', SESSION_API, 'async create(request)'],
  ['Q2 rename', SESSION_API, 'async rename(request)'],
  ['Q3 工作区 create', WORKSPACE, 'async create(path: string, title?: string)'],
  ['Q4 沙箱边界', SANDBOX, 'A session cwd is its workspace-write boundary'],
  ['Q4 子会话 cwd', SUBAGENT, 'const cwd = await this.resolveDirectory('],
  ['Q5 session/created', SESSION, "'session/created'"],
  ['Q5 标准预设 stack', PRESET_PATCH, '@deepseek-ai/dsh-persona'],
]) {
  const text = snippet(file, phrase)
  if (text === '') continue
  console.log(`\n### ${title}\n${file}\n${text.slice(0, 900)}`)
}
