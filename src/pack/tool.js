// `capability_pack` 工具（P3）：协调者唯一的工厂入口。
//
// 动作面（计划 §7 P3）：list / describe / create / update / delete / open / install /
// uninstall / health / export-static。所有写动作遵守三条闸门：
//   1. **dry-run 先行**：不带 confirm 时只回计划（文件树 + 预设行 + CLI 安装卡 + env 声明）；
//   2. **确认**：create/update/delete/install 必须 `confirm:true`（面板按钮同样要 confirm）；
//   3. **幂等**：`clientRequestId` 相同且内容相同 → 回放结果，不重复写盘/重复建会话。
//
// 工具只做参数校验与文案渲染；真正的闸门、回滚、安装执行都在 src/pack/service.js 与 install.js。
// 安装确认卡与面板同源（`MEASURED_INSTALL` 来自 reports/pack-spike.md 的实测），默认建议是「取消」。

import { MEASURED_INSTALL } from './install.js'
import { envSummary } from './env.js'

export const CAPABILITY_PACK_ACTIONS = Object.freeze([
  'list', 'describe', 'create', 'update', 'delete', 'open', 'install', 'uninstall', 'health', 'export-static',
])

const measuredLines = () => [
  `预计新增体积 ≈ ${MEASURED_INSTALL.unpackedMiB} MiB（pnpm store 另 ≈ ${MEASURED_INSTALL.storeMiB} MiB，可被其它包共享）`,
  `${MEASURED_INSTALL.packages} 个包；冷装 ≈ ${Math.floor(MEASURED_INSTALL.coldSeconds / 60)} 分 ${String(MEASURED_INSTALL.coldSeconds % 60).padStart(2, '0')} 秒，热装 ≈ ${MEASURED_INSTALL.warmSeconds} 秒`,
  `安装钩子 ${MEASURED_INSTALL.installHooks} 个（--ignore-scripts 强制）；无浏览器/原生二进制`,
]

/** 安装确认卡文本（工具与面板共用同一份数据；面板按字段渲染）。 */
export function renderInstallCard(plan) {
  if (plan === undefined || plan.ok !== true) return `安装计划不可用：${plan?.error ?? '未知原因'}`
  const lines = [
    `安装确认：${plan.package}@${plan.version}（${plan.manager}，${plan.scope}）`,
    `registry：${plan.registry}`,
    `integrity：${plan.integrity}`,
    `license：${plan.license}｜来源：${plan.sourceUrl}`,
    '完整 argv：',
    `  ${(plan.argv ?? [plan.manualCommand]).join(' ')}`,
    ...measuredLines(),
    '影响面：',
    ...plan.impact.map(item => `- ${item}`),
    `卸载：${plan.uninstall}`,
    `失败后果：${plan.failure}`,
    plan.runnable === true
      ? `确认后调 capability_pack({ action: 'install', id, cliId: '${plan.cliId}', confirm: true, planHash: '${plan.planHash}' })`
      : `当前环境找不到 node/pnpm，无法由插件执行；可复制手动命令：${plan.manualCommand}`,
    '默认建议：先取消——只有确实需要排版/建草稿时才装。',
  ]
  return lines.join('\n')
}

const envLines = manifest => {
  if (manifest.env.length === 0) return ['- （无）']
  return manifest.env.map(item => `- ${item.ref}（${item.kind}${item.required !== false ? '，必填' : ''}）：${item.purpose}`)
}

function renderList(result) {
  if (result.ok !== true) return `能力包列表不可用（${result.code}）：${result.error}`
  if (result.packs.length === 0) return '还没有能力包（内置包应至少有一个：公众号文章）。'
  const lines = [`能力包（${result.packs.length} 个）：`]
  for (const pack of result.packs) {
    if (pack.manifest === undefined && pack.error !== undefined) {
      lines.push(`- ${pack.id}｜包损坏：${pack.error}`)
      continue
    }
    const cli = pack.cli?.[0]
    const cliText = cli === undefined ? '无 CLI' : `${cli.package}@${cli.version}=${cli.status}`
    lines.push(`- ${pack.name}（${pack.id} @ ${pack.version}，${pack.kind === 'builtin' ? '内置' : '用户包'}）｜技能 ${pack.skills?.length ?? 0}｜CLI ${cliText}｜${pack.healthLine}`)
    if (pack.presetRegistered === false) lines.push('  ⚠ 预设未运行时注册（运行时可导出静态兜底：action:"export-static"）')
  }
  return lines.join('\n')
}

function renderDescribe(result) {
  if (result.ok !== true) return `能力包详情不可用（${result.code}）：${result.error}`
  const pack = result.pack
  const preset = result.preset
  const lines = [
    `能力包「${pack.name}」（${pack.id} @ ${pack.version}，${pack.publisher}）：${pack.description}`,
    `目录：${pack.dir}`,
    `预设：${pack.presetId}（${preset.registered ? '运行时已注册' : (preset.runtimeAvailable ? '未注册' : '宿主无 agentPresets，需静态兜底')}）`,
    `技能：${pack.skills.map(skill => skill.name).join('、')}`,
    '环境变量：',
    ...envLines(result.manifest),
    `健康：${pack.healthLine}`,
  ]
  for (const cli of pack.cli) {
    lines.push(`CLI ${cli.id}：${cli.package}@${cli.version} 状态 ${cli.status}${cli.status === 'installed' ? `（入口 ${cli.record?.resolved?.entry ?? '-'}）` : ''}`)
  }
  for (const plan of result.installPlans) {
    lines.push('', renderInstallCard(plan))
  }
  lines.push('', `时间：创建 ${pack.lastOpenedAt === null ? '（未打开）' : new Date(pack.lastOpenedAt).toISOString()}`)
  return lines.join('\n')
}

const renderPlan = result => {
  if (result.ok !== true) {
    const head = `能力包操作未执行（${result.code}）：${result.error}`
    return result.plan === undefined ? head : `${head}\n\n${result.plan.text ?? ''}`
  }
  if (result.dryRun === true) {
    return [
      result.plan.text,
      ...result.plan.cliPlans.filter(plan => plan.ok === true).map(plan => renderInstallCard(plan)),
    ].join('\n\n')
  }
  return [
    `能力包已写入：${result.id}（预设 ${result.presetId}，注册方式 ${result.mode}）`,
    `文件：${result.files.join('、')}`,
    result.healthLine ?? '',
    ...(result.warning === undefined ? [] : [`⚠ ${result.warning}`, result.staticYaml ?? '']),
    '下一步：capability_pack({ action: "describe", id }) 看健康/安装卡；用「open」开包会话。',
  ].filter(Boolean).join('\n')
}

function renderInstall(result) {
  if (result.ok !== true) {
    const head = `安装未完成（${result.code}）：${result.error}`
    return result.plan === undefined ? head : `${head}\n\n${renderInstallCard(result.plan)}`
  }
  if (result.reused === true) {
    return `已安装且版本一致，直接复用：${result.record.package}@${result.record.version}\n入口：${result.record.resolved?.entry ?? '-'}\n${result.healthLine ?? ''}`
  }
  return [
    `安装完成：${result.record.package}@${result.record.version}`,
    `入口（realpath）：${result.record.resolved?.entry ?? '-'}`,
    `解释器：${result.record.resolved?.node ?? '-'}`,
    `耗时：${Math.round(((result.record.finishedAt ?? 0) - (result.record.startedAt ?? 0)) / 1000)} 秒`,
    result.healthLine ?? '',
    '下一步：面板「环境变量」段设置 WECHAT_APP_ID / WECHAT_APP_SECRET（需彻底重启 DSH），再用包会话建草稿。',
  ].filter(Boolean).join('\n')
}

const renderEnv = result => {
  if (result.ok !== true) return `环境变量不可用（${result.code}）：${result.error}`
  if (result.command !== undefined) {
    return [`复制命令（值处是占位符，未预填）：`, `  ${result.command}`, '', ...(result.notes ?? []).map(note => `- ${note}`)].join('\n')
  }
  const lines = ['环境变量状态（只显示存在性，永不显示值）：']
  for (const item of result.env) {
    lines.push(`- ${item.ref}（${item.kind}${item.required ? '，必填' : ''}）：${item.set ? '已设置' : '未设置'}｜${item.purpose}`)
  }
  lines.push('', '设置方式：面板「环境变量」段可复制 setx 命令（默认），或二次确认后由插件执行；设置后必须彻底重启 DSH。')
  return lines.join('\n')
}

/**
 * 造工具定义。
 * @param {object} options
 * @param {object} options.packs - createPackService()
 * @param {Function} options.wrap - tools.js 的 wrap（统一 try/catch + output）
 * @param {object} options.schema - `{ objectSchema, str }`
 */
export function createCapabilityPackTool({ packs, wrap, schema }) {
  const { objectSchema, str } = schema
  const parameters = objectSchema({
    action: { type: 'string', enum: [...CAPABILITY_PACK_ACTIONS], description: '动作：list/describe/create/update/delete/open/install/uninstall/health/export-static' },
    id: str('包 id（create 时取 draft.id；其余动作必填）'),
    cliId: str('包内 CLI id（缺省取第一个，如 wenyan）'),
    draft: {
      type: 'object',
      description: 'create/update 的包定义：{ id, name, description, version?, preset?, skills:[{name,description,content?}], references?, cli?, env?, research? }；dry-run 只回计划',
      additionalProperties: true,
    },
    dryRun: { type: 'boolean', description: '只回计划（文件树/预设/安装卡），不写盘；默认 false' },
    confirm: { type: 'boolean', description: '写动作确认：create/update/delete/install 必须显式 true；不传等价于 dry-run/取消' },
    planHash: str('安装确认卡的 planHash（install 必填；计划变了会拒绝执行）'),
    clientRequestId: str('请求级幂等键：同 id 同内容只执行一次（重试/重复点击不会重复写盘）'),
    cwd: str('open 动作的工作目录（缺省取主会话目录）'),
  })
  return wrap('capability_pack', '能力包工厂：list/describe/create/update/delete/open/install/uninstall/health/export-static。'
    + '写动作先 dry-run（不带 confirm）看计划，再带 confirm:true + clientRequestId 执行；安装 CLI 需先看确认卡（体积/耗时/影响面）再带 planHash。'
    + '内置包只读；能力包会话是普通根会话，不写台账、不进队列。', parameters, async (args = {}) => {
    if (packs === undefined) return '能力包未装配（插件启动时未创建 pack service）：检查插件日志里的 pack.disabled / pack.platform-unsupported 记录。'
    const action = typeof args.action === 'string' ? args.action : 'list'
    if (!CAPABILITY_PACK_ACTIONS.includes(action)) return `未知 action：${JSON.stringify(args.action)}；可用：${CAPABILITY_PACK_ACTIONS.join(' / ')}`
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (action !== 'list' && action !== 'create' && id === '') return '缺 id：除 list/create 外的动作都要传能力包 id。'
    if (action === 'list') return renderList(await packs.list())
    if (action === 'describe') return renderDescribe(await packs.describe(id))
    if (action === 'create') {
      if (args.draft === undefined) return 'create 需要 draft（见工具参数说明）；先不传 confirm 看 dry-run 计划。'
      return renderPlan(await packs.create(args.draft, { dryRun: args.dryRun === true, confirm: args.confirm === true, clientRequestId: args.clientRequestId }))
    }
    if (action === 'update') {
      if (args.draft === undefined) return 'update 需要 draft（会整体替换技能/声明；先 dry-run 看计划）。'
      return renderPlan(await packs.update(id, args.draft, { dryRun: args.dryRun === true, confirm: args.confirm === true, clientRequestId: args.clientRequestId }))
    }
    if (action === 'delete') {
      const result = await packs.delete(id, { confirm: args.confirm === true, clientRequestId: args.clientRequestId })
      if (result.ok !== true) return `删除未执行（${result.code}）：${result.error}`
      return `已删除能力包 ${id}（预设已撤销，旧会话保旧 revision；包目录进 .trash 保留 24h）。`
    }
    if (action === 'open') {
      const result = await packs.open(id, { cwd: args.cwd })
      if (result.ok !== true) return `开包会话失败（${result.code}）：${result.error}${result.staticYaml === undefined ? '' : `\n\n静态兜底：\n${result.staticYaml}`}`
      return `已用能力包「${id}」开新会话：${result.sessionId}（预设 ${result.presetId}，cwd ${result.cwd}）。这是普通根会话，不写台账。`
    }
    if (action === 'install') {
      const manifest = packs.findEntry(id)?.manifest
      const cliId = typeof args.cliId === 'string' && args.cliId !== '' ? args.cliId : manifest?.cli?.[0]?.id
      if (cliId === undefined) return `包 ${id} 没有声明 CLI，不需要安装。`
      return renderInstall(await packs.install(id, cliId, { confirm: args.confirm === true, expectedPlanHash: args.planHash }))
    }
    if (action === 'uninstall') {
      const manifest = packs.findEntry(id)?.manifest
      const cliId = typeof args.cliId === 'string' && args.cliId !== '' ? args.cliId : manifest?.cli?.[0]?.id
      const result = await packs.uninstall(id, cliId)
      if (result.ok !== true) return `卸载未完成（${result.code}）：${result.error}`
      return `已卸载 ${id} 的 CLI（删除 tools/${id}；包与技能保留）。${result.healthLine ?? ''}`
    }
    if (action === 'health') {
      const result = await packs.health(id)
      if (result.ok !== true) return `健康检查失败（${result.code}）：${result.error}`
      return [`能力包 ${id}：${result.healthLine}`, ...result.health.checks.map(check => `- ${check.id}（${check.kind}${check.soft ? '，soft' : ''}）：${check.ok ? '通过' : `未通过${check.missing ? `（缺 ${check.missing.join('、')}）` : ''}${check.status ? `（${check.status}）` : ''}`}`)].join('\n')
    }
    // export-static
    const result = await packs.exportStatic(id)
    if (result.ok !== true) return `导出失败（${result.code}）：${result.error}`
    return [`静态兜底（预设 ${result.presetId}）：`, result.yaml, '', result.hint].join('\n')
  })
}

/** 面板用环境变量视图（只读；`envSummary` 是唯一实现，避免两处各拼一份）。 */
export function packEnvView(manifest, env = process.env) {
  return envSummary(manifest, env)
}
