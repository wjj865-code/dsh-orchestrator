// 每日日报：配置 digestAt（HH:MM）后，在协调者主会话上挂一个 schedule，
// 到点由平台投递一条用户消息，提示协调者用 task_inbox/task_list 汇总。
// 没有 schedule 服务或没配置时间时完全静默，不影响插件加载。
import { getSetting, setSetting } from './ledger.js'

export const DIGEST_SCHEDULE_KEY = 'digest_schedule_id'
export const DIGEST_SPEC_KEY = 'digest_schedule_spec'

const DIGEST_PROMPT = '请调用 task_inbox 和 task_list(active:false)，汇总当前任务：今日完成、在跑、待你决定、失败与产物，用简洁中文发给我。'

const specOf = (mainSessionId, config) => {
  const zone = config?.digestTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return `${mainSessionId}|${config?.digestAt}|${zone}`
}

async function removeExisting(schedule, db, id) {
  if (typeof id !== 'string' || id === '') return
  try { await schedule.edit({ id, action: 'delete' }) } catch { /* 已不存在也继续 */ }
  try {
    setSetting(db, DIGEST_SCHEDULE_KEY, '')
    setSetting(db, DIGEST_SPEC_KEY, '')
  } catch { /* 清理失败不回滚 */ }
}

/**
 * 确保主会话上只有一条当前配置对应的日报 schedule。
 * @returns {{ok: true, id: string, created: boolean} | {ok: false, reason: string}}
 */
export async function ensureDigest({ schedule, db, mainSessionId, config, log = () => {} }) {
  if (typeof mainSessionId !== 'string' || mainSessionId === '') {
    return { ok: false, reason: 'no-main-session' }
  }
  if (schedule === undefined || schedule === null || typeof schedule.create !== 'function') {
    return { ok: false, reason: 'no-schedule-service' }
  }
  const existingId = getSetting(db, DIGEST_SCHEDULE_KEY)
  const at = config?.digestAt
  if (typeof at !== 'string' || at === '') {
    await removeExisting(schedule, db, existingId)
    return { ok: false, reason: 'disabled' }
  }

  const spec = specOf(mainSessionId, config)
  if (existingId !== undefined && existingId !== '' && getSetting(db, DIGEST_SPEC_KEY) === spec) {
    try {
      const view = await schedule.view({ id: existingId })
      if (view?.status === 'active' && view?.target?.sessionId === mainSessionId) {
        return { ok: true, id: existingId, created: false }
      }
    } catch { /* 查不到就重建 */ }
  }

  await removeExisting(schedule, db, existingId)
  const timeZone = config?.digestTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    const created = await schedule.create({
      title: '任务日报',
      prompt: DIGEST_PROMPT,
      timing: { kind: 'daily', daily: { time: at, time_zone: timeZone } },
      target: { kind: 'session', sessionId: mainSessionId },
    }, mainSessionId)
    const id = created?.id
    if (typeof id !== 'string' || id === '') return { ok: false, reason: 'no-schedule-id' }
    setSetting(db, DIGEST_SCHEDULE_KEY, id)
    setSetting(db, DIGEST_SPEC_KEY, spec)
    log('digest.created', { detail: { scheduleId: id, at, timeZone } })
    return { ok: true, id, created: true }
  } catch (error) {
    log('digest.create-failed', { detail: { error: error?.message ?? String(error), at, timeZone } })
    return { ok: false, reason: error?.message ?? String(error) }
  }
}
