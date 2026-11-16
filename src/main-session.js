// 主会话：唯一协调者。创建/打开/重建都从这里走；不再由 task_create 自动绑定。
import { mkdir } from 'node:fs/promises'
import { setSetting } from './ledger.js'
import { onboardingKey } from './onboarding.js'
import { getMainSessionId, getMainSessionPreset, setMainSessionId, setMainSessionPreset } from './ledger.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const WORKER_PRESET_ID = 'dsh-orchestrator-worker'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'

export function createMainSession({ db, config, agents, sessionController, workspaces, presetFor, selectPreset, workspacePath, workspaceName = '指挥舱', rotation, now = () => Date.now(), log = () => {} }) {
  // 服务既可以直接传对象（测试/同步场景），也可以传 getter（index 惰性取，等 cordis 服务就绪）。
  const resolveAgents = () => typeof agents === 'function' ? agents() : agents
  const resolveSessionController = () => typeof sessionController === 'function' ? sessionController() : sessionController
  const resolveWorkspaces = () => typeof workspaces === 'function' ? workspaces() : workspaces
  // G1 S3：轮换动作面（src/main-rotation.js 的 createRotationService）。允许传 getter：
  // 服务在 index 里是「先建、晚装配」，getter 形式能让调用方在 apply 早期就先挂上引用。
  const resolveRotation = () => typeof rotation === 'function' ? rotation() : rotation
  // 刚轮换出来的新会话在平台异步起 agent 之前不 live；这段时间里再点「打开主会话」不能再建一个
  // （openOnce 的「不 live 就新建」会把一次轮换变成两次 + 一个空白残留）。窗口只拦这一条路，过期后照旧重建。
  const FRESH_MAIN_LOAD_GRACE_MS = 60_000
  let freshMain
  const liveAgent = id => resolveAgents()?.get?.(id)
  const currentId = () => config?.coordinatorSession ?? getMainSessionId(db)
  // worker 预设只认 spawn provider（fork 不满足 capabilities.agentPreset）；不静默降级、不改用户配置。
  const spawnProvider = config?.spawnProvider ?? 'spawn'

  // 读 live agent 实际跑的预设：优先 agentPresets.presetForSession，退到 session.header.agentPreset。
  // 读不到一律视为「不是协调者预设」——旧版建的主会话没有预设，必须重建而不是一直复用。
  const sessionPreset = agent => {
    try {
      const value = typeof presetFor === 'function' ? presetFor(agent) : undefined
      if (typeof value === 'string' && value !== '') return value
    } catch { /* 读不到就当未知 */ }
    const header = agent?.session?.header
    return typeof header?.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined
  }

  // UI 打开空白会话时可能把预设 rebind 成 default（standard）；平台允许空白会话重绑，
  // 这里在复用前/agent 创建时拉回协调者预设，非空白会话会抛 locked，交给 guard 兜底。
  const guardPreset = async agent => {
    if (agent === undefined) return false
    const current = sessionPreset(agent)
    if (current === PRESET_ID) return true
    if (typeof selectPreset !== 'function') return false
    try {
      await selectPreset(agent, PRESET_ID)
      log('main.session.preset-restored', { sessionId: agent.id, from: current ?? null })
      return true
    } catch (error) {
      const reason = error?.message ?? String(error)
      if (/locked|already started/i.test(reason)) {
        log('main.session.preset-locked', { sessionId: agent.id, from: current ?? null })
        return false
      }
      log('main.session.preset-restore-failed', { sessionId: agent.id, from: current ?? null, error: reason })
      return false
    }
  }

  const ensureWorkspace = async () => {
    const services = resolveWorkspaces()
    if (services === undefined) return undefined
    // 工作区 API 是位置参数：create(path, title?)；目录必须先存在。
    // 注意 resolveByPath 是 async（内部 realpath，目录不存在会 reject ENOENT），必须 await 才能接住。
    let found
    try { found = await services.resolveByPath?.(workspacePath) } catch { found = undefined }
    if (found !== undefined) return found.id
    await mkdir(workspacePath, { recursive: true })
    const created = await services.create?.(workspacePath, workspaceName)
    return created?.id
  }

  const createdPreset = created =>
    typeof created?.agentPreset === 'string' && created.agentPreset !== '' ? created.agentPreset : PRESET_ID

  /**
   * G1 S3：命中轮换（计划 §5.1）。这里的**顺序就是回退边界**：
   *   create 失败 = 零处置 → 写 marker → 切指针 → 写时间戳/跳过 onboarding → 新会话标题
   *   → 旧会话改名「已退役」+ 归档 → 审计 + 清 marker。
   * 指针切换前失败 = 什么都没发生（旧主会话照常可用）；指针切换后失败 = 轮换成立，最多旧会话没处置干净。
   * 归档不可逆（平台无 unarchive）：`rotateArchiveOld=false` 时只改名。
   */
  const rotateMain = async ({ oldId, decision }) => {
    const rot = resolveRotation()
    const sessions = resolveSessionController()
    if (sessions?.create === undefined) return { ok: false, error: '创建主会话失败：缺少 sessionController 服务（平台尚未就绪）' }
    const at = now()
    let workspaceId
    try { workspaceId = await ensureWorkspace() } catch (error) {
      return { ok: false, error: `指挥舱工作区不可用：${error?.message ?? error}` }
    }
    // F2：create 失败必须**零处置**。此刻 marker 还没写、指针没动、旧会话没碰。
    let created
    try {
      created = await sessions.create({ workspaceId, agentPreset: PRESET_ID })
    } catch (error) {
      log('main.rotation.failed', { stage: 'create', oldId: oldId ?? null, error: `${error?.message ?? error}` })
      return { ok: false, error: `创建主会话失败：${error?.message ?? error}` }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      log('main.rotation.failed', { stage: 'create', oldId: oldId ?? null, reason: 'no-session-id' })
      return { ok: false, error: '创建主会话失败：没有返回 sessionId' }
    }
    // F6 锚点：先落 marker（新会话还不是主会话；崩溃 → 下次启动把这块空白归档）。
    const marker = rot?.begin?.({ oldId, newId: sessionId, at, decision })
    // 切指针：单条 UPSERT。失败 = 轮换没发生（F3）：旧指针原样可用，空白新会话归档隐藏。
    try {
      setMainSessionId(db, sessionId)
    } catch (error) {
      const discarded = (await rot?.discard?.({ sessionId })) === true
      log('main.rotation.pointer-failed', {
        oldId: oldId ?? null, newId: sessionId, error: `${error?.message ?? error}`, discarded,
      })
      return { ok: false, error: `轮换失败，旧主会话仍可用：${error?.message ?? error}`, rotated: false }
    }
    // 指针已切：以下每一步失败都只降级，**不回滚指针**（回滚等于把人踢回旧会话又换了主会话）。
    try {
      setMainSessionPreset(db, createdPreset(created))
      rot?.commitTimes?.(at)
    } catch (error) {
      log('main.rotation.commit.failed', { newId: sessionId, error: `${error?.message ?? error}` })
    }
    // 跳过首次介绍 + 工作区索引任务：status 直接落 'sent'（否则每轮换一次多派一个重复索引任务）。
    try {
      setSetting(db, onboardingKey(sessionId), 'sent')
    } catch (error) {
      log('main.rotation.onboarding.failed', { newId: sessionId, error: `${error?.message ?? error}` })
    }
    try {
      await sessions.rename?.({ sessionId, title: '主会话' })
    } catch (error) {
      log('main.session.rename.failed', { sessionId, error: `${error?.message ?? error}` })
    }
    // 旧会话处置（不可逆）：改名「已退役」+ 归档；rename/archive 各自失败只降级，轮换仍成立。
    const disposal = (await rot?.disposeOld?.({ oldId, at })) ?? { renamed: false, archived: false }
    let audit = null
    try {
      audit = rot?.finish?.({ oldId, newId: sessionId, at, decision, disposal }) ?? null
    } catch (error) {
      // 审计/清 marker 写不进 → marker 还在，下次启动幂等补完。
      log('main.rotation.audit.failed', { newId: sessionId, error: `${error?.message ?? error}` })
    }
    freshMain = { sessionId, at }
    log('main.session.rotated', {
      old: oldId ?? null,
      new: sessionId,
      triggers: Array.isArray(decision?.triggers) ? decision.triggers : [],
      renamed: disposal.renamed === true,
      archived: disposal.archived === true,
      marker: marker !== null && marker !== undefined,
      audit: audit !== null,
    })
    return {
      ok: true,
      sessionId,
      created: true,
      rotated: true,
      replaced: oldId ?? null,
      agentPreset: created?.agentPreset,
      rotation: {
        reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
        metrics: decision?.metrics !== null && typeof decision?.metrics === 'object' ? decision.metrics : {},
        at,
      },
    }
  }

  const openOnce = async () => {
    const override = config?.coordinatorSession
    if (override !== undefined) {
      if (liveAgent(override) === undefined) return { ok: false, error: `配置的协调者会话 ${override} 当前未加载` }
      return { ok: true, sessionId: override, created: false }
    }
    if (spawnProvider !== 'spawn') {
      return { ok: false, error: `主会话的子任务需要 spawn provider（当前 spawnProvider=${spawnProvider}）：请把 spawnProvider 改回 spawn，或改用配置覆盖的会话` }
    }
    const id = getMainSessionId(db)
    const live = id === undefined ? undefined : liveAgent(id)
    // 刚轮换出来的新会话还没 live（平台异步起 agent）：别再建一个，直接把同一个 id 交回去。
    if (live === undefined && id !== undefined && freshMain !== undefined
      && freshMain.sessionId === id && now() - freshMain.at < FRESH_MAIN_LOAD_GRACE_MS) {
      return { ok: true, sessionId: id, created: true, rotated: false, loading: true, agentPreset: getMainSessionPreset(db) }
    }
    // G1 S3：命不命中轮换由纯判定决定（S1）+ 采集（S2）；这里只负责「due 就跳过复用、走轮换动作」。
    // 旧主会话不 live 时不做判定：那条路本来就只是隐式重建（计划 §0「重启时算不算已覆盖」）。
    // S4：判定异常只当「本次不轮换」——一次采集/台账抖动绝不能把「打开主会话」变成失败（下面照走复用分支）。
    if (live !== undefined) {
      let decision = null
      try {
        decision = await resolveRotation()?.evaluate?.({ mainSessionId: id, liveAgent: live, source: 'open' })
      } catch (error) {
        log('main.rotation.failed', { stage: 'evaluate', sessionId: id, error: `${error?.message ?? error}` })
      }
      if (decision?.due === true) return rotateMain({ oldId: id, decision })
    }
    if (live !== undefined) {
      const marker = getMainSessionPreset(db)
      const preset = sessionPreset(live)
      // 台账为准：我们创建时记过协调者预设就复用，不再因读回漂移而重建（重建会换 id、通知漂移）。
      if (marker === PRESET_ID) {
        const mismatch = preset !== undefined && preset !== PRESET_ID
        if (mismatch) {
          log('main.session.preset-mismatch', {
            sessionId: id,
            marker,
            preset,
            header: live.session?.header?.agentPreset ?? null,
          })
          await guardPreset(live)
        }
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: mismatch }
      }
      // 旧版主会话没有台账标记：能明确读到协调者预设就认领复用，否则重建一次。
      if (marker === undefined && preset === PRESET_ID) {
        setMainSessionPreset(db, PRESET_ID)
        log('main.session.preset-adopted', { sessionId: id, preset })
        return { ok: true, sessionId: id, created: false, agentPreset: PRESET_ID, presetMismatch: false }
      }
      log('main.session.recreate', {
        sessionId: id,
        reason: marker === undefined ? (preset === undefined ? 'preset-unknown' : 'preset-mismatch') : 'marker-mismatch',
        marker: marker ?? null,
        preset: preset ?? null,
      })
    }
    const sessions = resolveSessionController()
    if (sessions?.create === undefined) return { ok: false, error: '创建主会话失败：缺少 sessionController 服务（平台尚未就绪）' }
    let workspaceId
    try { workspaceId = await ensureWorkspace() } catch (error) {
      return { ok: false, error: `指挥舱工作区不可用：${error?.message ?? error}` }
    }
    let created
    try {
      created = await sessions.create({ workspaceId, agentPreset: PRESET_ID })
    } catch (error) {
      return { ok: false, error: `创建主会话失败：${error?.message ?? error}` }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '创建主会话失败：没有返回 sessionId' }
    // create 不接受 title；标题单独 rename，失败只记日志，不影响主会话可用。
    try {
      await sessions.rename?.({ sessionId, title: '主会话' })
    } catch (error) {
      log('main.session.rename.failed', { sessionId, error: `${error?.message ?? error}` })
    }
    setSetting(db, onboardingKey(sessionId), 'pending')
    setMainSessionId(db, sessionId)
    setMainSessionPreset(db, createdPreset(created))
    log('main.session.created', { sessionId, agentPreset: created?.agentPreset ?? null })
    return { ok: true, sessionId, created: true, agentPreset: created?.agentPreset }
  }

  // 并发点击/路由重复调用只建一次：后来者 await 同一个 in-flight Promise。
  // finally 里清掉（失败也清），否则一次创建失败会让后续点击永久复用失败结果。
  // catch 兜底：open() 对调用方永不 reject（宿主把未处理拒绝当 fatal load failure）。
  let opening
  const open = () => {
    if (opening !== undefined) return opening
    opening = Promise.resolve()
      .then(openOnce)
      .catch(error => ({ ok: false, error: `打开主会话失败：${error?.message ?? error}` }))
      .finally(() => { opening = undefined })
    return opening
  }

  return { open, currentId, guardPreset }
}
