// 配置字段的**单一事实源**（SSOT）：字段名 / 类型 / 枚举 / 区间 / 默认 / 是否暴露 / 分组。
//
// 为什么要有这个文件：同一批字段现在有三个消费方，以前它们各自散落、靠人肉对齐——
//   1. 宿主侧 schemastery `Config`（index.js 导出，决定「插件页能改什么」）；
//   2. 浏览器侧表单（client/src/config-form.js，决定「页面怎么画、怎么分组」）；
//   3. `loadConfig()`（src/config.js，决定「运行时真正用什么值」）。
// 三处各写一遍必然漂移：漏一个字段 = UI 上静默少一行（不报错）；多一个字段 = 写入被宿主拒绝。
// 所以这里只声明**一次**，三方都从这里派生。
//
// 与 `loadConfig()` 的关系：本文件**不取代**归一化。`loadConfig` 继续按自己的规则把非法值
// 回落默认（那是运行时的最后一道防线，行为零变化）；本文件描述的是「字段的规格」，供
// schema 与 UI 使用。两边由 test/config-fields.test.js 双向比对守住。
//
// 暴露策略（Q3 已定）：高频子集可编辑；`mainRotation.*` 与 `coordinatorSession` 只读展示
// （readonly: true）——它们要么牵动不可逆动作（归档），要么是运维兜底通道，不该在表单里手滑改。

/** 字段分组：顺序即页面上的分组顺序。 */
export const FIELD_GROUPS = Object.freeze([
  Object.freeze({ id: 'dispatch', label: '派发与队列' }),
  Object.freeze({ id: 'watchdog', label: '看门狗与陈旧判定' }),
  Object.freeze({ id: 'keepalive', label: '回合间续跑' }),
  Object.freeze({ id: 'delivery', label: '交付与通知' }),
  Object.freeze({ id: 'isolation', label: '隔离与并发' }),
  Object.freeze({ id: 'memory', label: '记忆与快照' }),
  Object.freeze({ id: 'preferences', label: '偏好注入' }),
  Object.freeze({ id: 'rotation', label: '主会话轮换（只读）' }),
])

/**
 * 字段规格表。
 *
 * - `kind`：`number` / `boolean` / `string` / `enum`，决定 schema 与控件类型；
 * - `min` / `max` / `integer`：数字字段的合法区间（与 `loadConfig` 的夹取口径一致）；
 * - `pattern`：字符串字段的正则（仅用于提示，非法值仍由 loadConfig 回落）；
 * - `readonly`：true = 只在页面上展示生效值，不给编辑（Q3）；
 * - `default`：与 `loadConfig` 的默认值**必须一致**（由单测守）。
 */
export const CONFIG_FIELDS = Object.freeze([
  // ── 派发与队列 ────────────────────────────────────────────────
  Object.freeze({
    key: 'spawnProvider', group: 'dispatch', kind: 'string', default: 'spawn',
    label: '子会话 provider', hint: '本地 fresh 子会话的 provider 名',
  }),
  Object.freeze({
    key: 'workerPreset', group: 'dispatch', kind: 'string', default: 'dsh-orchestrator-worker',
    label: '子会话预设', hint: '只认小写字母/数字/连字符；非法值回落 dsh-orchestrator-worker',
  }),
  Object.freeze({
    key: 'maxQueue', group: 'dispatch', kind: 'number', min: 1, max: 10000, integer: true, default: 50,
    label: '队列安全阀', hint: 'pending + waiting_dep 的上限',
  }),
  Object.freeze({
    key: 'autoResumeQueue', group: 'dispatch', kind: 'boolean', default: true,
    label: '重启后自动恢复排队任务',
  }),
  Object.freeze({
    key: 'mergeWindowMs', group: 'dispatch', kind: 'number', min: 1, max: 600000, integer: true, default: 5000,
    label: '完成通知合并窗口（ms）',
  }),
  Object.freeze({
    key: 'staleMinutes', group: 'dispatch', kind: 'number', min: 1, max: 1440, integer: true, default: 30,
    label: '陈旧判定（分钟）', hint: '多久无动静标陈旧 / stall 提醒间隔',
  }),
  Object.freeze({
    key: 'stallRounds', group: 'dispatch', kind: 'number', min: 1, max: 1000, integer: true, default: 3,
    label: 'stall 提醒轮数', hint: '连续 progress 达阈值后提醒一次「可能卡住」',
  }),

  // ── 看门狗 ────────────────────────────────────────────────────
  Object.freeze({
    key: 'idleWatchdog', group: 'watchdog', kind: 'boolean', default: true,
    label: '空闲看门狗', hint: '只告警，不杀任务',
  }),
  Object.freeze({
    key: 'watchdogIntervalMinutes', group: 'watchdog', kind: 'number', min: 1, max: 1440, integer: true, default: 5,
    label: '巡检间隔（分钟）',
  }),
  Object.freeze({
    key: 'watchdogIdleMinutes', group: 'watchdog', kind: 'number', min: 1, max: 1440, integer: true, default: 15,
    label: '空闲阈值（分钟）', hint: '同一段空闲每任务只报一次',
  }),

  // ── 续跑 ──────────────────────────────────────────────────────
  Object.freeze({
    key: 'keepAlive', group: 'keepalive', kind: 'boolean', default: false,
    label: '回合间续跑', hint: '需要 ctx.goals；默认关闭，升级后行为不突变',
  }),
  Object.freeze({
    key: 'keepAliveMode', group: 'keepalive', kind: 'enum', values: ['steer', 'followup'], default: 'steer',
    label: '续跑方式', hint: 'steer = 同回合再走一步；followup = 新回合（会写 turn/end）',
  }),
  Object.freeze({
    key: 'keepAliveMaxRounds', group: 'keepalive', kind: 'number', min: 1, max: 50, integer: true, default: 8,
    label: '续跑轮数上限',
  }),
  Object.freeze({
    key: 'keepAlivePrompt', group: 'keepalive', kind: 'string', default: '',
    label: '续跑提示词', hint: '留空 = 用内置默认提示',
  }),

  // ── 交付与通知 ────────────────────────────────────────────────
  Object.freeze({
    key: 'deliveredTimeoutMinutes', group: 'delivery', kind: 'number', min: 1, max: 1440, integer: true, default: 60,
    label: '待确认超时（分钟）', hint: '设成 1 约等于「交付即完成」的旧行为',
  }),
  Object.freeze({
    key: 'digestAt', group: 'delivery', kind: 'string', default: '',
    label: '每日日报时刻', hint: 'HH:MM（如 09:00）；留空 = 关闭',
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
  }),
  Object.freeze({
    key: 'digestTimeZone', group: 'delivery', kind: 'string', default: '',
    label: '日报时区', hint: '如 Asia/Shanghai；留空 = 系统时区',
  }),

  // ── 隔离与并发 ────────────────────────────────────────────────
  Object.freeze({
    key: 'sameDirGuard', group: 'isolation', kind: 'enum', values: ['require', 'warn', 'off'], default: 'require',
    label: '同写域并发防护', hint: 'require = 拒绝并给可操作错误；非法值一律回落 require（默认必须安全）',
  }),
  Object.freeze({
    key: 'worktreePolicy', group: 'isolation', kind: 'enum', values: ['required', 'auto', 'off'], default: 'auto',
    label: 'worktree 隔离策略', hint: 'required = 每个需求都隔离；auto = 满足三条件才建议',
  }),
  Object.freeze({
    key: 'worktreeBranchPrefix', group: 'isolation', kind: 'string', default: 'orch/',
    label: '隔离分支前缀', hint: '默认分支名 <prefix><taskId>',
  }),
  Object.freeze({
    key: 'worktreeRecentDays', group: 'isolation', kind: 'number', min: 1, max: 90, integer: true, default: 7,
    label: '近期活跃分支窗口（天）',
  }),

  // ── 记忆与快照 ────────────────────────────────────────────────
  Object.freeze({
    key: 'memoryInject', group: 'memory', kind: 'boolean', default: true,
    label: '注入事实层记忆', hint: '新任务是否注入跨项目记忆',
  }),
  Object.freeze({
    key: 'memoryLimit', group: 'memory', kind: 'number', min: 1, max: 10, integer: true, default: 3,
    label: '注入记忆条数',
  }),
  Object.freeze({
    key: 'snapshotRetentionDays', group: 'memory', kind: 'number', min: 1, max: 30, integer: true, default: 7,
    label: '台账快照保留（天）',
  }),

  // ── 偏好注入 ──────────────────────────────────────────────────
  Object.freeze({
    key: 'preferencesInject', group: 'preferences', kind: 'boolean', default: true,
    label: '注入偏好段', hint: '协调者 policy 的第 4 段；关闭则整段消失',
  }),
  Object.freeze({
    key: 'preferencesMaxChars', group: 'preferences', kind: 'number', min: 200, max: 4000, integer: true, default: 1200,
    label: '偏好字数上限',
  }),
  Object.freeze({
    key: 'preferencesMaxItems', group: 'preferences', kind: 'number', min: 1, max: 20, integer: true, default: 12,
    label: '偏好条数上限',
  }),

  // ── 主会话轮换（只读，Q3） ─────────────────────────────────────
  Object.freeze({
    key: 'coordinatorSession', group: 'rotation', kind: 'string', default: '', readonly: true,
    label: '协调者会话覆盖', hint: '留空 = 读台账 settings.main_session_id；只在运维兜底时手改 YAML',
  }),
  Object.freeze({
    key: 'mainRotation', group: 'rotation', kind: 'enum', values: ['auto', 'off'], default: 'off', readonly: true,
    label: '轮换总开关', hint: '默认 off（默认必须安全）；拼错也回落 off',
  }),
  Object.freeze({
    key: 'rotateAfterMainLogMiB', group: 'rotation', kind: 'number', min: 0.5, max: 4096, integer: false, default: 6, readonly: true,
    label: '触发：主会话日志体积（MiB）',
  }),
  Object.freeze({
    key: 'rotateAfterDays', group: 'rotation', kind: 'number', min: 1, max: 365, integer: true, default: 10, readonly: true,
    label: '触发：运行天数',
  }),
  Object.freeze({
    key: 'rotateCooldownHours', group: 'rotation', kind: 'number', min: 1, max: 720, integer: true, default: 48, readonly: true,
    label: '冷却期（小时）',
  }),
  Object.freeze({
    key: 'rotateMinAgeHours', group: 'rotation', kind: 'number', min: 1, max: 720, integer: true, default: 12, readonly: true,
    label: '最小龄（小时）',
  }),
  Object.freeze({
    key: 'rotateIdleMinutes', group: 'rotation', kind: 'number', min: 1, max: 1440, integer: true, default: 10, readonly: true,
    label: '闲置判定（分钟）',
  }),
  Object.freeze({
    key: 'rotateArchiveOld', group: 'rotation', kind: 'boolean', default: true, readonly: true,
    label: '轮换后归档旧主会话', hint: '不可逆：平台没有 unarchive',
  }),
])

/** 可编辑字段（页面上给输入控件的那些）。 */
export const EDITABLE_FIELDS = Object.freeze(CONFIG_FIELDS.filter(field => field.readonly !== true))

/** 按 key 索引的字段表，便于 schema / 表单 / 单测 O(1) 查。 */
export const FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field])),
)

/** 分组 → 字段列表（保持 FIELD_GROUPS 的顺序，空分组不出现）。 */
export const FIELDS_BY_GROUP = Object.freeze(
  FIELD_GROUPS
    .map(group => Object.freeze({
      ...group,
      fields: Object.freeze(CONFIG_FIELDS.filter(field => field.group === group.id)),
    }))
    .filter(group => group.fields.length > 0),
)

/** 全部字段 key（顺序与声明一致）。 */
export const FIELD_KEYS = Object.freeze(CONFIG_FIELDS.map(field => field.key))

/** 可编辑字段 key 集合：宿主 schema 只把这些标 volatile。 */
export const EDITABLE_KEYS = Object.freeze(EDITABLE_FIELDS.map(field => field.key))
