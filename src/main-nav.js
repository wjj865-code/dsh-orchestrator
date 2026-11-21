// 主会话导航待办（压力提醒「新建协调者会话」确认之后的那一步）。
//
// 为什么要有这个模块（t-a79e12d8 真机证据）：服务端能 create + 切指针，但**跳转到新会话是
// 客户端能力**（宿主的 `uiWorkspace.openSession(sessionId)` 只在浏览器插件里）。0.25.0 的实现
// 只做到切指针：`main.adopt.created` 之后用户仍停在旧会话，旧会话又已不是「主会话」（会话头从
// 「任务」变成「设为协调者」），于是用户看到的就是「既没新建、也没跳转」。真机日志：
// 2026-11-21T08:29:20 代建成功（newId=session-341c…），08:33:52 用户又在旧会话点了「设为协调者」
// 把指针切了回去——正是「没有跳转」的直接后果。
//
// 分工（别再往服务端塞导航）：
//   - 服务端**只记一条待办**（进程内，不写台账/settings）：`{ id, kind, sessionId?, text?, at }`；
//   - 客户端每 5s 轮询 `main-nav` 端点，读到后按 kind 处理：`navigate` → `uiWorkspace.openSession`
//     成功后 `main-nav-ack` 清掉；`notice` → 面板顶部一条可读提示后 ack；
//   - 任何一步失败都只降级：指针不动（指针在服务端早已切好）、客户端给可读提示（用户可在会话列表
//     找到「主会话」）。服务端不归档、不删除任何会话。
//
// 待办是**短命**的：默认 5 分钟过期（客户端不在线时别在半小时后突然把人拽走）；同一时刻只有一条，
// 后一条覆盖前一条（后一条一定是更新的事实）。
export const MAIN_NAV_TTL_MS = 5 * 60_000

/** 待办种类：`navigate` = 跳到 sessionId；`notice` = 只显示一段可读文字（不跳转）。 */
export const MAIN_NAV_KINDS = Object.freeze(['navigate', 'notice'])

/**
 * 需要给用户看的中文文案（服务端产出、客户端原样显示，避免两边各写一份而漂移）。
 * 失败态都由**代建结果**决定，不是猜的：`ADOPT_CREATE_FAILED` = create 失败（零处置，旧主会话还在）；
 * `ADOPT_FAILED` = 新会话已建好但指针没切（旧主会话仍在位，新会话留着可用）。
 */
export const MAIN_NAV_TEXT = Object.freeze({
  pointerFailed: reason => `新建的协调者会话已建好，但主会话指针没切成功（旧主会话保持不动）：${reason}。可稍后重试，或在会话列表里手动打开它。`,
  createFailed: reason => `新建协调者会话失败（旧主会话保持不动）：${reason}。可稍后重试。`,
  busy: () => '另一次协调者切换正在进行，本次没有新建（旧主会话保持不动）。可稍后再试。',
})

const text = value => (typeof value === 'string' ? value.trim() : '')

/**
 * 把「代建结果」翻译成一条导航待办（纯函数，index.js 与单测共用）。
 *
 * - `ok === true` → `{ kind:'navigate', sessionId }`（指针已经切好，只差客户端跳过去）；
 * - `ADOPT_BUSY` → notice：另一次切换进行中，本次什么都没做；
 * - 其余失败 → notice：create 失败 / 指针失败各一句可读原因（`params.reason` 优先）。
 * @param {{ok?:boolean, code?:string, sessionId?:string, params?:{reason?:string}}} outcome
 * @returns {{kind:'navigate', sessionId:string} | {kind:'notice', tone:'error', code:string, text:string} | null}
 */
export function planCoordinatorNav(outcome) {
  const sessionId = text(outcome?.sessionId)
  if (outcome?.ok === true && sessionId !== '') return { kind: 'navigate', sessionId }
  const code = text(outcome?.code)
  if (code === '') return null
  const reason = text(outcome?.params?.reason) || code
  const notice = code === 'ADOPT_BUSY'
    ? MAIN_NAV_TEXT.busy()
    : code === 'ADOPT_FAILED'
      ? MAIN_NAV_TEXT.pointerFailed(reason)
      : MAIN_NAV_TEXT.createFailed(reason)
  return { kind: 'notice', tone: 'error', code, text: notice }
}

/**
 * 进程内「主会话导航待办」：一条待办 + 读/确认。**不写台账、不写 settings、不碰会话**。
 *
 * 日志（都进插件审计日志，排查「为什么没跳过去」只看这几条）：
 *   - `main.nav.pending`：写入待办（kind / sessionId / code）；
 *   - `main.nav.expired`：读到时已过期（> ttlMs），丢弃；
 *   - `main.nav.consumed`：客户端 ack 且跳转成功；
 *   - `main.nav.navigate-failed`：客户端 ack 且跳转失败（带 error，指针保持不动）。
 */
export function createMainNav({ now = () => Date.now(), ttlMs = MAIN_NAV_TTL_MS, idOf, log = () => {} } = {}) {
  let current = null
  let seq = 0
  const nextId = typeof idOf === 'function' ? idOf : () => `nav-${++seq}`
  return {
    /** 写一条待办（覆盖旧的）；kind 不合法/缺 sessionId 时返回 null，不抛。 */
    publish(payload = {}) {
      const kind = text(payload.kind)
      if (!MAIN_NAV_KINDS.includes(kind)) return null
      const sessionId = text(payload.sessionId)
      if (kind === 'navigate' && sessionId === '') return null
      const record = {
        id: text(payload.id) || nextId(),
        kind,
        at: Number.isFinite(payload.at) ? payload.at : now(),
        ...(sessionId === '' ? {} : { sessionId }),
        ...(text(payload.tone) === '' ? {} : { tone: text(payload.tone) }),
        ...(text(payload.text) === '' ? {} : { text: text(payload.text) }),
        ...(text(payload.code) === '' ? {} : { code: text(payload.code) }),
      }
      current = record
      log('main.nav.pending', { detail: { id: record.id, kind, sessionId: record.sessionId ?? null, code: record.code ?? null } })
      return record
    },
    /** 读当前待办（过期即丢，返回 null）。只读，不清。 */
    read() {
      if (current === null) return null
      if (now() - current.at > ttlMs) {
        log('main.nav.expired', { detail: { id: current.id, kind: current.kind, ageMs: now() - current.at } })
        current = null
        return null
      }
      return current
    },
    /**
     * 客户端确认处理过这条待办：id 不匹配（已被别的客户端消费 / 已被新待办覆盖）→ 不清、返回 cleared:false。
     * @param {{id?:string, ok?:boolean, error?:string}} ack
     */
    ack({ id, ok, error } = {}) {
      if (current === null) return { cleared: false }
      if (text(id) !== current.id) return { cleared: false }
      const record = current
      current = null
      const succeeded = ok === true
      log(succeeded ? 'main.nav.consumed' : 'main.nav.navigate-failed', {
        detail: {
          id: record.id,
          kind: record.kind,
          sessionId: record.sessionId ?? null,
          ...(succeeded ? {} : { error: text(error) || '未知原因' }),
        },
      })
      return { cleared: true, kind: record.kind, sessionId: record.sessionId ?? null }
    },
    /** 仅供测试/诊断：当前待办（不判过期）。 */
    peek: () => current,
  }
}
