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
// 0.25.0（B'）：字段表投影的是 `loadConfig({})` **实际产出的键**（0.25.0 起 22 个，0.32.0 加入能力包
// 三键后 25 个；上一版 29 个：轮换 8 键随功能删除，新增 1 个 `contextPressureThreshold`）。已删的键（`keepAlive*` 四个续跑键 +
// `mergeWindowMs` / `stallRounds` / `preferencesMaxItems` 三个常量化的阈值键 + 8 个轮换键）
// **不得**再出现在这里——它们只留在 `src/config.js` 的 DEPRECATED_KEYS 里给弃用警告，
// 表单上多一行「已删除的键」= 用户改完写回去仍是无效配置。
//
// 暴露策略（0.25.0：轮换整组删除，换成「主会话」组）：`contextPressureThreshold` **可编辑**——
// 「阈值可配」是硬要求，藏成只读或写死在代码里都会让用户在插件页上无从调整；压缩本身归宿主
// compaction-basic，插件不设它的阈值。
// `coordinatorSession` 例外，保留 `readonly: true`：它是**运维兜底通道**，填错（拼错/写了个不存在的会话 id）
// 会让协调者直接指向不存在的会话，工具与派发全部失效、且只能再改配置才恢复——属于高危误操作，
// 不该在表单里手滑改；需要时手改当前 profile 的 `cordis.patch.yml`。
// `readonly` 机制是给这类键用的：标上即只读，表单与 `EDITABLE_KEYS` 自动跟随。

/** 字段分组：顺序即页面上的分组顺序。 */
export const FIELD_GROUPS = Object.freeze([
  Object.freeze({ id: 'dispatch', label: '派发与队列' }),
  Object.freeze({ id: 'watchdog', label: '看门狗与陈旧判定' }),
  Object.freeze({ id: 'delivery', label: '交付与通知' }),
  Object.freeze({ id: 'isolation', label: '隔离与并发' }),
  Object.freeze({ id: 'memory', label: '记忆与快照' }),
  Object.freeze({ id: 'preferences', label: '偏好注入' }),
  Object.freeze({ id: 'context', label: '主会话' }),
  Object.freeze({ id: 'packs', label: '能力包' }),
])

/**
 * 字段规格表。
 *
 * - `kind`：`number` / `boolean` / `string` / `enum`，决定 schema 与控件类型；
 * - `min` / `max` / `integer`：数字字段的合法区间（与 `loadConfig` 的夹取口径一致）；
 * - `pattern`：字符串字段的正则（仅用于提示，非法值仍由 loadConfig 回落）；
 * - `readonly`：true = 只在页面上展示生效值，不给编辑（当前只有 `coordinatorSession` 标它：
 *   运维兜底通道，手滑改错会让协调者指向不存在的会话）；
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
    key: 'staleMinutes', group: 'dispatch', kind: 'number', min: 1, max: 1440, integer: true, default: 30,
    label: '陈旧判定（分钟）', hint: '多久无动静标陈旧 / stall 提醒间隔',
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

  // ── 主会话（1 键可编辑 + coordinatorSession 只读；压缩阈值归宿主，插件不设） ──────
  Object.freeze({
    key: 'contextPressureThreshold', group: 'context', kind: 'number', min: 0.1, max: 0.95, integer: false, default: 0.4,
    label: '上下文压力提醒阈值',
    hint: '插件**自己的提醒阈值**：主会话最近一次请求的 prompt 占该路由上下文窗口的比例（取自 tokenMeter.contextPressure）达到它时，插件弹一张问题卡问你要不要换新协调者会话。'
      + '它和宿主 compaction-basic 的 thresholdRatio（默认 0.8，到点由宿主自己压缩）是两回事，改这里不会改变宿主压缩行为、也不影响子会话。'
      + '插件只提醒、不压缩、不自动切换。保存后需重载插件或重启 DSH 生效',
  }),
  Object.freeze({
    key: 'coordinatorSession', group: 'context', kind: 'string', default: '', readonly: true,
    label: '协调者会话覆盖', hint: '运维兜底通道：页面只读，只在运维场景手改 cordis.patch.yml（填错会让协调者指向不存在的会话）；日常换协调者请用会话头的「设为协调者」',
  }),

  // ── 能力包（0.32.0） ──────────────────────────────────────────
  // 三个布尔开关对应计划里的 capabilityPacks.enabled / .panel / .allowOnWeb（配置键是扁平的，
  // 因为宿主 schema 只认顶层字段；文档按这三行说明）。
  Object.freeze({
    key: 'capabilityPacks', group: 'packs', kind: 'boolean', default: true,
    label: '启用能力包', hint: '总开关：关掉后不注册内置包预设、capability_pack 工具返回停用、面板隐藏能力包入口',
  }),
  Object.freeze({
    key: 'capabilityPacksPanel', group: 'packs', kind: 'boolean', default: true,
    label: '显示能力包面板', hint: '面板入口与包列表；关掉不影响已注册的预设与会话',
  }),
  Object.freeze({
    key: 'capabilityPacksAllowOnWeb', group: 'packs', kind: 'boolean', default: false,
    label: 'Web 下也启用能力包', hint: 'Desktop-only 默认：Web 下不注册预设、工具返回 PLATFORM_UNSUPPORTED、不写文件；打开后按 Desktop 处理（自担风险）',
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

/**
 * 可编辑字段 key 集合：表单控件与保存路径（`buildOps`/`isDirty`）只认这些。
 * 只读字段（`coordinatorSession`）不在这里——它照样出现在页面上（schema 对全部字段标 volatile），
 * 但保存时不会下发。
 */
export const EDITABLE_KEYS = Object.freeze(EDITABLE_FIELDS.map(field => field.key))
