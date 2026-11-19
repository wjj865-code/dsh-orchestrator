// 提示词分层（prompt-layers）：五层文本的职责边界与**唯一措辞源**。
//
// 背景（审计 §3、§5.1、§5.4）：同一批口径被写在 5 个地方（协调者 policy 3403 字 / brief / task_detail /
// onboarding 708 字 / 通知 hint），其中 **L1 与 L4 重叠 6 条**、**L1 与通知重叠 3 条**，还有 3 处措辞互相打架：
//   1. `LIMITATIONS.md` 说「交付时选项进 question+options」，实现明确不支持（`done` 会清空）；
//   2. brief 的 `CONFIRM_HINT` 说「要点写进 summary」，task_detail 的 `FINISH_HINT` 说「正文写：改了什么…」
//      —— 子会话不知道 summary 该写结论还是写三问；
//   3. 插件页简介（原 `DETAIL.md`，P1-D 已并入 README/ARCHITECTURE）说 brief 是「四件事」，实际有 worktree 时是 6 行（多「访问级别」「worktree 依赖」）。
//
// 本模块把「谁说什么」固定下来，并给出跨层共享的**唯一措辞**：各层从这里取常量，不再各写一份。
// 判据：**一条口径只允许有一个所有者层**；其它层要么不提，要么用本模块的常量（内容逐字一致）。
//
// ┌────┬────────────────────────┬────────────────┬──────────────────────────────────────────┐
// │ 层 │ 载体                    │ 生命周期        │ 唯一职责                                  │
// ├────┼────────────────────────┼────────────────┼──────────────────────────────────────────┤
// │ L1 │ `ctx.systemPrompt`      │ 每回合重渲染    │ 协调者的**行为规则**：能调什么工具、禁止什么、 │
// │    │ `.context().text`       │                │ 交付/确认/追问的决策口径、worktree/写域策略、 │
// │    │ （index.js）            │                │ 用户偏好（第 4 段）、能力诊断                  │
// │ L2 │ 派发消息（brief.js）     │ 每次派发/续派    │ 只做**指路**：任务编号、访问级别、worktree 依赖、│
// │    │                        │                │ 「详情调 task_detail」、执行中/交付时怎么回报    │
// │ L3 │ 子会话按需调用           │ 按需（可能不调）  │ 任务的**创建详情**：目标/验收/约束/背景/原话/    │
// │    │ （task-detail.js）      │                │ 工作目录与权限/前置/经验/产物 + 完成动作          │
// │ L4 │ 一次性 `agent.steer`     │ 仅新主会话首次    │ 只做**开场**：自我介绍一句 + 派索引任务           │
// │    │ （onboarding.js）       │                │ （能力边界归 L1，这里一条都不重复）              │
// │ 旁 │ 通知（notify.js）        │ 每次通知         │ 只做**动作指令**：这条通知要你（协调者）现在做什么 │
// └────┴────────────────────────┴────────────────┴──────────────────────────────────────────┘
//
// 三条判据（写新文案前先自问）：
//   1. 这句话是给**协调者**看的规则，还是给**子会话**看的指引？——协调者规则进 L1，子会话指引进 L2/L3。
//   2. 它需要**每回合都在**吗？——是 → L1；只在派发那一刻需要 → L2；只在子会话主动要时 → L3。
//   3. 它是不是「收到通知后马上要做的动作」？——是 → 通知 hint；否则别写进通知。
import { BLOCKED_HINT, CONFIRM_HINT } from './brief.js'
// P1-C 文案单源：跨层共享的「交付不是结束」与通知/详情/工具回执同源（src/copy.js）。
import { DELIVERY_NOT_FINAL } from './copy.js'

export { DELIVERY_NOT_FINAL }

/**
 * 五层清单（机器可读）：文档、测试与排障都按这张表核对「谁该说什么」。
 * `owns` 是**该层的独占职责**（别的层不许重复）；`forbids` 是明确不该出现在该层的内容。
 */
export const PROMPT_LAYERS = Object.freeze([
  Object.freeze({
    id: 'L1',
    name: '协调者 policy',
    carrier: 'ctx.systemPrompt.context().text（index.js，每回合重渲染）',
    audience: 'coordinator',
    owns: Object.freeze([
      '工具可用与禁用（wait_agent / 团队工具 / 原生 read-glob / schedule 四工具）',
      '能直接回答就不委派（只有新鲜取证/写文件/跨仓库证据才 task_create）',
      '交付与确认的决策口径（done 不是终态、默认保持待确认、何时 task_message({ action: "close" })、何时追问）',
      '不主动问「任务能否关闭」；只在真歧义/不可逆/远端写授权时提问（多条合并成一条清单）',
      'present 与 read_workspace 的用法与边界',
      'worktree 隔离策略（renderWorktreePolicy）',
      '同写域并发防护（renderWriteGuardPolicy）',
      '用户偏好（第 4 段，src/preferences.js）',
      '能力诊断（schedule 服务缺失时的降级说明）',
    ]),
    forbids: Object.freeze(['子会话的完成动作细节（属 L3）', '任务目标与验收内容（属 L3）', '一次性开场介绍（属 L4）']),
  }),
  Object.freeze({
    id: 'L2',
    name: 'brief',
    carrier: '派发消息（src/brief.js，每次派发/续派）',
    audience: 'worker',
    owns: Object.freeze([
      '任务编号（task_detail 的参数）',
      '访问级别（仅 access:full）与 worktree 装依赖提示（仅隔离任务）',
      '「先调 task_detail 读详情」的指引',
      '执行中怎么上报（blocked + question/options）',
      '交付时怎么回报（summary + 待确认要点）',
    ]),
    forbids: Object.freeze([
      '任务目标/验收/约束/背景/经验正文（属 L3）',
      'action:close / delivered / 终态等协调者口径（属 L1）',
      'present、read_workspace 等协调者工具（属 L1）',
    ]),
  }),
  Object.freeze({
    id: 'L3',
    name: 'task_detail',
    carrier: '子会话按需调用（src/task-detail.js）',
    audience: 'worker',
    owns: Object.freeze([
      '任务创建详情：目标 / 验收标准 / 约束 / 背景资料 / 用户原话',
      '工作目录、权限、访问级别、写边界提示',
      '前置任务、经验文件指针、已有产物、编排字段',
      '计划任务与 worktree 隔离的说明',
      '完成动作（task_report 的四种 status 与正文要求）',
    ]),
    forbids: Object.freeze(['协调者的决策口径（属 L1）', '重复 brief 的「先调 task_detail」指引（L2 已说）']),
  }),
  Object.freeze({
    id: 'L4',
    name: 'onboarding',
    carrier: '一次性 agent.steer（src/onboarding.js，仅新主会话首次）',
    audience: 'coordinator',
    owns: Object.freeze([
      '说明这是初始化请求、不是用户手写指令',
      '一句话自我介绍（能拆任务、派子会话、看回报、交付）',
      '派一次「工作区与仓库索引」只读任务',
    ]),
    forbids: Object.freeze([
      '能力边界（只协调不写文件 / 原生 read-glob 被拒 / read_workspace 边界 / 默认 worker 无自动化 / full 只改单任务沙箱）——全部属 L1，L1 每回合都在且不会被 compaction 吃掉',
      '交付与确认口径（属 L1）',
    ]),
  }),
  Object.freeze({
    id: 'NOTIFY',
    name: '通知 hint',
    carrier: '通知正文（src/notify.js，每次通知）',
    audience: 'coordinator',
    owns: Object.freeze([
      '这条通知要求协调者**现在**做什么（present 交付 / 保持待确认 / 追问 / 停止）',
      '产物清单与「不能交付」的原因计数',
    ]),
    forbids: Object.freeze(['解释能力边界或工具清单（属 L1）', '任务详情（属 L3）']),
  }),
])

/** 各层 id → 名称（测试与排障输出用）。 */
export const LAYER_NAME = Object.freeze(Object.fromEntries(PROMPT_LAYERS.map(layer => [layer.id, layer.name])))

/**
 * 跨层共享口径（**唯一措辞**）：多于一层的同一件事，只在这里写一次，各层引用常量。
 *
 * 目前只保留「必须逐字一致」的三条：
 *   - 子会话不能问用户（L2 说原因、L1 说协调者要做的事）；
 *   - 交付不是结束（L1 决策口径、L2 回报指引、L3 完成动作、通知动作指令都依赖它）；
 *   - present 的 1-4 个上限（L1 规则与通知动作指令）。
 *
 * P1-C：句子本体已收口到 `src/copy.js`（这里只做分层出口，避免「同一句话两处定义」）。
 */

/** 子会话问不了用户（平台约束，L2 的 BLOCKED_HINT / CONFIRM_HINT 已含此事实）。 */
export const WORKER_CANNOT_ASK = '子会话调 ask_user_question 会被平台拒（DELEGATED_CALLER）'

/** present 的产品上限（L1 规则与通知 hint 共用）。 */
export const PRESENT_MAX_FILES = 4
export const PRESENT_LIMIT_TEXT = `1-${PRESENT_MAX_FILES} 个最关键的`

/** L2 的两条回报指引（brief 的【执行中待确认】【确认方式】直接引用，不再各写一份）。 */
export const LAYER_L2_HINTS = Object.freeze({
  blocked: BLOCKED_HINT,
  confirm: CONFIRM_HINT,
})

/**
 * 层归属自检：某段文案是否只出现在它该在的层。
 *
 * 测试用它锁住「删掉的重叠不会偷偷回来」：例如 onboarding 里再出现「原生 read/glob 仍被拒」，
 * 就说明有人又把 L1 的能力边界抄回了 L4。
 *
 * @param {'L1'|'L2'|'L3'|'L4'|'NOTIFY'} layerId
 * @param {string} text
 * @returns {string[]} 命中的违规描述（空数组 = 干净）
 */
export function layerViolations(layerId, text) {
  const value = typeof text === 'string' ? text : ''
  const layer = PROMPT_LAYERS.find(item => item.id === layerId)
  if (layer === undefined) return [`未知层：${layerId}`]
  // 「别的层独占、本层不许出现」的探针：每条都对应一次真实的重叠或矛盾。
  const probes = {
    // L4 不许复述 L1 的能力边界（审计 §2.7 列的 6 条重复）。
    L4: [
      [/原生\s*read\/glob\s*仍被拒/, 'L1 的工具禁用口径'],
      [/只协调、不直接写文件/, 'L1 的职责边界'],
      [/read_workspace/, 'L1 的读产物口径'],
      [/full\s*只(?:改变|改)/, 'L1 的 access:full 口径'],
      [/默认\s*worker\s*不开放自动化/, 'L1 的自动化口径'],
    ],
    // L2 不许讲协调者口径。
    L2: [
      [/task_close|action:\s*['\"]close['\"]/, 'L1 的确认交付口径'],
      [/已交付待确认/, 'L1 的两段式终态口径'],
      [/present/, 'L1 的交付工具'],
      [/read_workspace/, 'L1 的读产物口径'],
    ],
    // L3 不许重复 brief 的指路，也不许讲协调者口径。
    L3: [
      [/先调\s*task_detail/, 'L2 的指路指引'],
      [/task_close|action:\s*['\"]close['\"]/, 'L1 的确认交付口径'],
    ],
    // 通知只讲动作，不讲能力边界。
    NOTIFY: [
      [/原生\s*read\/glob/, 'L1 的工具禁用口径'],
      [/只协调、不直接写文件/, 'L1 的职责边界'],
    ],
  }[layerId] ?? []
  const hits = []
  for (const [pattern, owner] of probes) {
    if (pattern.test(value)) hits.push(`出现「${pattern.source}」，该口径属${owner}`)
  }
  return hits
}
