// 回合间 keep-alive（K2）：订阅平台 `agent/turn-stopping`，在回合边界给「目标还没完成」的子会话
// 同步投递下一条消息，让它接着跑，而不是先 idle 再被 S1 结算。
//
// 为什么用 turn-stopping 而不是 idle 之后抢投（K1 探针实测，见 reports/k1-keepalive-probe.md）：
//   turn-stopping 是 serial 且被 await 的，监听器返回前投递的消息进 inbox（steer → next-step /
//   followup → next-turn），loop 在回合尾部重读 inbox 就继续跑，`agent.status` 不会经过 idle；
//   子会话的结算 watcher 只有 `whenIdle()` 返回后才推进，所以 keep-alive 期间没有「结算 vs 续轮」
//   的竞态窗口（不是处理了竞态，而是不产生 idle 观察点）。
//
// 模块职责单一：只决定「这一回合边界要不要再投一条消息」。不碰台账终态、不碰 goal 状态、
// 不写结算、不改 progress_count —— 结算永远由 S1（src/settlement.js）在真正的 subagent 结束事件上做。
import { randomUUID } from 'node:crypto'
import { addMessage, bumpKeepAliveRound, findTaskBySession } from './ledger.js'

/** 注入消息的 source.kind：与真人发言、平台 relay 区分开（面板/历史里看得出是宿主续跑）。 */
export const KEEPALIVE_SOURCE = 'orchestrator-keepalive'

/** goal 已经收口的 phase：complete（done）/ cleared（stop·retry·orphaned）。 */
export const GOAL_DONE_PHASES = new Set(['complete', 'cleared'])

/** 默认续跑提示：只描述「继续同一个目标」，不改目标本身（目标正文在平台 goal 里）。 */
export const DEFAULT_KEEPALIVE_PROMPT = [
  '宿主 keep-alive：上一回合已结束，但本任务的目标还没完成。',
  '请接着推进同一个目标：先看已有进展与产物，再做下一件具体的实事，不要重复已经做完的工作。',
  '全部验收标准达成后调用 task_report 上报 done；被阻塞或需要授权时上报 blocked / needs_auth，不要空转。',
].join('\n')

const noop = () => {}
const errorText = error => error?.message ?? String(error)

const lengthOf = value => Array.isArray(value) ? value.length : 0

/**
 * inbox 里是否已经有人排了下一轮：有就不再注入（重复投递只会让子会话多跑一遍）。
 * 兼容三种形态：平台 inbox（`nextStep`/`nextTurn`）、带 `hasPending` 布尔的服务、数组形态的测试假件。
 */
export function hasPendingInput(inbox) {
  if (inbox === null || inbox === undefined) return false
  if (Array.isArray(inbox)) return inbox.length > 0
  if (typeof inbox.hasPending === 'boolean') return inbox.hasPending
  return lengthOf(inbox.nextStep) + lengthOf(inbox.nextTurn) > 0
}

/**
 * 纯判定：这一回合边界要不要注入。返回 `null` 表示「注入」，返回字符串表示跳过原因。
 * 三个续跑条件（缺一不可）：开关开启 / 任务有未完成的 goal / 轮数未满。
 * 其余是「不许打扰」的守卫：会话已中断、任务已不在 running（S1 已结算）、只读任务、inbox 已有待处理输入。
 */
export function keepAliveSkipReason({
  enabled = false,
  signalAborted = false,
  agentStatus,
  inbox = undefined,
  task = undefined,
  goalState = undefined,
  rounds = 0,
  maxRounds = 0,
} = {}) {
  if (enabled !== true) return 'disabled'
  if (signalAborted === true) return 'aborted'
  if (agentStatus !== 'running') return 'agent-not-running'
  if (task === undefined || task === null) return 'no-task'
  if (task.status !== 'running') return 'task-not-running'
  if (task.read_only === true) return 'read-only'
  if (hasPendingInput(inbox)) return 'inbox-pending'
  // 「有未完成 goal」= 平台 goal 存在且还没收口。没有 goal（能力缺失/attach 落空）时不续跑：
  // 否则没人能判定「目标完成」，只能一路跑到轮数上限。
  if (goalState === null || goalState === undefined) return 'no-goal'
  if (GOAL_DONE_PHASES.has(goalState.phase)) return 'goal-finished'
  if (!(Number.isFinite(rounds) && Number.isFinite(maxRounds) && rounds < maxRounds)) return 'rounds-exhausted'
  return null
}

/** 注入消息正文：默认提示 + 轮次标记；`prompt` 配了就整段替换默认提示，轮次标记仍在最前面。 */
export function keepAliveText(task = {}, { round = 1, maxRounds = 1, prompt = '' } = {}) {
  const custom = typeof prompt === 'string' ? prompt.trim() : ''
  const body = custom === '' ? DEFAULT_KEEPALIVE_PROMPT : custom
  return `（keep-alive 第 ${round}/${maxRounds} 轮）${body}`
}

/**
 * keep-alive 注入器。
 *
 * @param {object} options
 * @param {object} options.db 台账（只用来查任务、原子加轮数、写一条审计消息）
 * @param {object} options.config 归一化后的配置（`keepAlive` / `keepAliveMode` / `keepAliveMaxRounds` / `keepAlivePrompt`）
 * @param {object} [options.logger] 审计日志
 * @param {(task: object) => object|null|undefined} [options.goalState]
 *   任务当前 goal 状态（live 优先，缺则台账镜像）；默认读 `task.goal_state`。
 * @param {() => string} [options.newId] 消息 id 生成（测试可固定）
 * @returns {{ handle: (event?: object) => number|null, start: (ctx: object) => () => void }}
 */
export function createKeepAlive({
  db,
  config = {},
  logger,
  goalState = task => task?.goal_state ?? null,
  newId = () => randomUUID(),
} = {}) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不能打断回合 */ }
  }
  // 同一任务同一跳过原因只记一次日志：keep-alive 每个正常回合都会触发，不能刷日志。
  const announced = new Set()
  const announceOnce = (key) => {
    if (announced.has(key)) return false
    announced.add(key)
    // 只在「值得看一眼」的停止原因上留痕（轮满/goal 完成/没有 goal）；其余是常态跳过。
    while (announced.size > 500) announced.delete(announced.values().next().value)
    return true
  }
  const maxRounds = config.keepAliveMaxRounds
  const mode = config.keepAliveMode === 'followup' ? 'followup' : 'steer'

  const stateOfGoal = task => {
    try {
      return goalState(task) ?? task?.goal_state ?? null
    } catch {
      // 平台 goal 服务读失败不能挡住后续判定：退回台账镜像。
      return task?.goal_state ?? null
    }
  }

  /**
   * 处理一次 `agent/turn-stopping`。整段同步执行（探针实测：同步注入即可让 loop 在回合尾部
   * 重读 inbox 继续跑），且绝不抛异常：serial dispatch 里抛错会打断当前回合。
   * @returns {number|null} 注入的轮数 / 未注入
   */
  const handle = ({ agent, turn, signal } = {}) => {
    if (config.keepAlive !== true) return null
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let task
    try {
      task = findTaskBySession(db, sessionId)
    } catch (error) {
      log('task.keepalive.failed', { detail: { hook: 'lookup', sessionId, error: errorText(error) } })
      return null
    }
    if (task === undefined) return null

    const rounds = task.keep_alive_rounds ?? 0
    const reason = keepAliveSkipReason({
      enabled: true,
      signalAborted: signal?.aborted === true,
      agentStatus: agent?.status,
      inbox: agent?.inbox,
      task,
      goalState: stateOfGoal(task),
      rounds,
      maxRounds,
    })
    if (reason !== null) {
      if (reason === 'rounds-exhausted' || reason === 'goal-finished' || reason === 'no-goal') {
        if (announceOnce(`${task.id}:${reason}`)) {
          log('task.keepalive.stopped', {
            taskId: task.id,
            sessionId,
            detail: { reason, rounds, maxRounds, turn: turn ?? null },
          })
        }
      }
      return null
    }

    // 预算先落台账（条件 UPDATE）：注入失败也算掉一轮，宁可少续也不少发。
    let round
    try {
      round = bumpKeepAliveRound(db, task.id, maxRounds)
    } catch (error) {
      log('task.keepalive.failed', { taskId: task.id, detail: { hook: 'budget', error: errorText(error) } })
      return null
    }
    if (round === null) {
      if (announceOnce(`${task.id}:rounds-exhausted`)) {
        log('task.keepalive.stopped', {
          taskId: task.id,
          sessionId,
          detail: { reason: 'rounds-exhausted', rounds, maxRounds, turn: turn ?? null },
        })
      }
      return null
    }

    const message = {
      id: newId(),
      role: 'user',
      content: [{ type: 'text', text: keepAliveText(task, { round, maxRounds, prompt: config.keepAlivePrompt }) }],
      // 自定义 kind：面板/历史里不会被当成真人发言；也不写 kind='followup' 的消息行，
      // 避免和面板「3 秒同文去重」/(taskId, rendered) 投递去重互相误判。
      source: { kind: KEEPALIVE_SOURCE, taskId: task.id, round },
    }
    try {
      const deliver = mode === 'followup' ? agent?.followup : agent?.steer
      if (typeof deliver !== 'function') throw new Error(`agent.${mode} 不可用`)
      deliver.call(agent, message)
    } catch (error) {
      // 注入失败就停这一轮：下一回合自然 idle → 交给 S1 结算，不重试、不回滚台账。
      log('task.keepalive.failed', {
        taskId: task.id,
        detail: { hook: 'inject', mode, round, error: errorText(error) },
      })
      return null
    }
    log('task.keepalive.injected', {
      taskId: task.id,
      sessionId,
      detail: {
        round,
        maxRounds,
        mode,
        turn: turn ?? null,
        goalPhase: stateOfGoal(task)?.phase ?? null,
      },
    })
    // 审计消息：面板/日志里看得到「这一轮是宿主续的」。写失败不影响已投递的消息。
    try {
      addMessage(db, task.id, {
        kind: 'keepalive',
        rendered: `[续跑] keep-alive 第 ${round}/${maxRounds} 轮（${mode}）`,
        meta: { round, maxRounds, mode, source: KEEPALIVE_SOURCE },
      })
    } catch (error) {
      log('task.keepalive.message-failed', { taskId: task.id, detail: { error: errorText(error) } })
    }
    return round
  }

  /** 订阅 `agent/turn-stopping`，返回 disposer（插件卸载时释放）。 */
  const start = ctx => {
    if (typeof ctx?.on !== 'function') return noop
    const dispose = ctx.on('agent/turn-stopping', event => {
      try {
        handle(event)
      } catch (error) {
        // 双保险：handle 内部已全量 try/catch，这里再兜一次，绝不让监听器抛回 serial dispatch。
        log('task.keepalive.failed', { detail: { hook: 'handler', error: errorText(error) } })
      }
    })
    return typeof dispose === 'function' ? dispose : noop
  }

  return { handle, start }
}
