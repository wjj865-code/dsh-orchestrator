// 回合结束 → 最终阶段保存 → 既有结算器。两个事件来源与启动恢复共用，不另造任务状态机。
import { getTask, findTaskBySession, setTaskArtifactStage, setTaskDeliveryPending } from './ledger.js'
import { collectArtifactStage } from './artifact-stage.js'
import { changedEventsOf } from './artifact-collect.js'

export function createArtifactDelivery({ db, settlement, sessionOf, workspaceChanges, mainDir, log = () => {}, collect = collectArtifactStage }) {
  const inflight = new Map()
  const report = input => {
    const task = input.taskId ? getTask(db, input.taskId) : findTaskBySession(db, input.sessionId)
    if (!task) return Promise.resolve(settlement.report(input))
    if (inflight.has(task.id)) return inflight.get(task.id)
    const promise = (async () => {
      if (task.status === 'running' || task.delivery_pending) {
        try {
          const session = sessionOf(task.session_id)
          const seq = input.eventSeq ?? changedEventsOf(session).at(-1)?.seq
          await collect({
            db, task, cwd: task.target_dir ?? task.brief?.inheritedTarget ?? mainDir(),
            mainDir: mainDir(), session, workspaceChanges: workspaceChanges(),
            changedFiles: task.delivery_pending?.changedFiles ?? [], artifacts: task.delivery_pending?.artifacts ?? [],
            artifactsOmitted: task.delivery_pending?.artifactsOmitted ?? 0,
            eventSeq: task.delivery_pending && !(seq > task.delivery_pending.eventSeq)
              ? (task.delivery_pending.eventSeq + 1) : seq,
            key: `final:${task.attempts ?? 0}`, interrupted: input.stopReason !== 'completed' || task.delivery_pending?.frozen === false,
          })
        } catch (error) {
          setTaskArtifactStage(db, task.id, { mode: 'unknown', complete: false, reason: error?.code ?? 'save-failed' })
          log('task.artifacts.failed', { taskId: task.id, detail: { code: error?.code ?? 'save-failed' } })
        }
      }
      // 用户可能在收集期间停止，结算器据当前状态决定，不让取消任务重新成交付。
      const result = settlement.report(input)
      if (getTask(db, task.id)?.delivery_pending) setTaskDeliveryPending(db, task.id, null)
      return result
    })().finally(() => inflight.delete(task.id))
    inflight.set(task.id, promise)
    return promise
  }
  return { report }
}
