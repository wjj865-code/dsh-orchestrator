// 能力包预设模板（计划 §3.2）：把 manifest 变成一行 `@deepseek-ai/dsh-agent-preset` 配置。
//
// 这是**固定模板**，不是「按包自由拼插件」：能力包会话是普通根会话，工具面必须与任务子会话
// 长得一样（能写、能跑命令、有 web/todo/skill），但**不能**有编排工具（task_* / plan_save /
// capability_pack）——否则包会话能派子任务、写台账，与「普通根会话、不进队列」的边界直接冲突。
//
// 技能目录走 `skill-filesystem.customSkillDirs`（绝对路径，平台每 step 重算 → 新技能免重启）。
// 包的运行期事实（node/entry/APPDATA 重定向）不写死在模板里：persona 只给**解析规则与路径**，
// 技能正文给确切命令——「已安装/已设置」永远现场读，不写死。
//
// 静态兜底（`exportStaticPreset`）：运行时注册被宿主 RC 拒绝时，把同一份行导出成可粘进
// `cordis.patch.yml` 的 YAML（改完需彻底重启）。两条路径共用本模板，不各写一份。

import { join } from 'node:path'

/** 能力包预设的默认排序（协调者 80 / worker 81 / 能力包 200：排在自定义组靠后）。 */
export const PACK_PRESET_ORDER = 200

/** 包会话**不该有**的全局工具（编排与台账只属于协调者/任务子会话）。 */
export const PACK_DENY_TOOLS = Object.freeze([
  'task_create',
  'task_list',
  'task_status',
  'task_message',
  'task_report',
  'task_detail',
  'plan_save',
  'capability_pack',
])

/** 包会话声明「出生即可用」的全局只读上下文工具（不派活、只读）。 */
export const PACK_KEEP_TOOLS = Object.freeze(['context'])

/**
 * 包会话的 persona：身份 + 边界 + CLI 解析规则。
 * 这里**不写**「CLI 已安装」「凭据已设置」这类会过期的话，只给现场读的位置。
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.installStatePath - `install.json` 绝对路径
 * @param {string} options.stateDir - 包状态目录（`APPDATA` 重定向目标 `.../.state/wenyan`）
 * @param {string} options.workspaceDir - 默认工作目录（用户可改）
 */
export function renderPackPersona({ manifest, installStatePath, stateDir, workspaceDir }) {
  const cliLines = manifest.cli.length === 0
    ? '本包没有声明外部 CLI。'
    : manifest.cli.map(cli => {
      const env = cli.env.length === 0 ? '' : `｜凭据变量：${cli.env.join('、')}（只认环境变量，不要落盘/回显）`
      return `- ${cli.id}：${cli.purpose}（包内安装 ${cli.install.package}@${cli.install.version}，license ${cli.install.license}）${env}`
    }).join('\n')
  return `你是「${manifest.name}」能力包的会话（普通根会话，不写台账、不进任务队列、不派子任务）。
你的职责：用本包技能把用户的事做完，产物写进工作目录（默认 ${workspaceDir}），交付时用 present 声明文件。

## 边界（硬性）
- 不要调用 task_create / task_list / task_status / task_message / task_report / plan_save / capability_pack：能力包会话没有编排职责，工具层也会拒绝。
- 不读 ~/.dsh 凭据文件、不读 .env、不打印任何 token/AppSecret；凭据只认环境变量存在性。
- 不发布/群发：本包只做到公众号草稿箱，最终发布由用户自己在公众号后台完成。

## 本包 CLI
${cliLines}

CLI 解析规则（每次执行前都现场读，不要凭记忆）：
- 安装状态文件：${installStatePath}
- 只有其中 status = "installed" 且 resolved.node / resolved.entry 都存在时才可执行；
  entry 必须是真路径（pnpm junction 需 realpathSync.native 解析，安装器已回填）。
- 执行任何 CLI 前把 APPDATA / LOCALAPPDATA 指向：${join(stateDir, '.state', 'wenyan')}（文颜会往这里写 token 存储）。
- 未安装 / 未设置凭据时：如实说明缺什么、给出面板里的入口，**不要自己安装依赖、不要自研替代渲染、不要假成功**。

## 交付
- 写文章：out/article.md（frontmatter title 必填）。
- 排版预览：out/article.html（render 输出）。
- 建草稿成功后记 out/draft.json（Media ID/时间/标题）；重复建前先问用户。
- 完成后用 present 声明真实产物路径；没有产物就直说没有。`
}

/**
 * 生成预设定义（`agentPresets.register()` 的入参形状）。
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.packRoot - 包根绝对路径（内置包=插件安装目录；用户包=state 下的包目录）
 * @param {string} options.installStatePath
 * @param {string} options.stateDir
 * @param {string} [options.platform] - `process.platform`（测试注入）
 * @param {string} [options.workspaceDir]
 */
export function buildPresetDefinition({ manifest, packRoot, installStatePath, stateDir, platform = process.platform, workspaceDir = '' }) {
  const skillsDir = join(packRoot, manifest.skillsDir)
  const windows = platform === 'win32'
  const plugins = [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: renderPackPersona({ manifest, installStatePath, stateDir, workspaceDir: workspaceDir === '' ? '当前工作目录' : workspaceDir }),
      },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: windows },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !windows },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ],
    },
    // 技能目录：绝对路径（平台 `resolve(root)`，相对路径会解析到宿主进程 cwd）。
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [skillsDir] } },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    {
      id: 'preset-tools',
      name: '@wjj865-code/dsh-orchestrator/preset-tools',
      config: { deny: [...PACK_DENY_TOOLS], keep: [...PACK_KEEP_TOOLS] },
    },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ]
  return {
    id: manifest.preset.id,
    name: manifest.preset.name,
    description: manifest.preset.description,
    order: manifest.preset.order ?? PACK_PRESET_ORDER,
    plugins,
  }
}

const yamlValue = value => {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  return /^[A-Za-z0-9_./@-]+$/.test(text) ? text : JSON.stringify(text)
}

const yamlLines = (value, indent) => {
  const pad = ' '.repeat(indent)
  const lines = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') lines.push(`${pad}- ${yamlLines(item, indent + 2).trimStart()}`)
      else lines.push(`${pad}- ${yamlValue(item)}`)
    }
    return lines.join('\n')
  }
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === 'object') {
      lines.push(`${pad}${key}:`)
      lines.push(yamlLines(item, indent + 2))
    } else {
      lines.push(`${pad}${key}: ${yamlValue(item)}`)
    }
  }
  return lines.join('\n')
}

/**
 * 静态兜底：把预设定义导出成可粘进当前 profile `cordis.patch.yml` 的 YAML 片段。
 * 只导出 insert 行（不改别人的行）；粘完必须彻底重启 DSH（静态预设不热加载）。
 */
export function exportStaticPreset(definition) {
  const row = {
    insert: [{
      id: `orchestrator-pack-${definition.id}`,
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        order: definition.order,
        plugins: definition.plugins,
      },
    }],
  }
  return [
    '# 能力包静态兜底：粘到当前 profile 的 cordis.patch.yml 顶层（与既有 insert 并列），',
    '# 然后**彻底退出 DSH 再启动**（静态预设不热加载）。运行时注册可用时不需要这段。',
    yamlLines(row, 0),
  ].join('\n')
}
