// DSH 已解析写根的覆盖检查；不自建沙箱，不把私有目录 chmod 当安全边界。
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { isInside } from './artifact-location.js'

function canonical(path) {
  let cursor = resolve(path)
  while (!existsSync(cursor) && dirname(cursor) !== cursor) cursor = dirname(cursor)
  return join(realpathSync(cursor), relative(cursor, resolve(path)))
}

export function artifactProtection({ store, policy, target, temporaryRoots = ['/tmp', tmpdir()] }) {
  if (!store || !policy) return { ok: false, reason: '无法核验宿主产物存储保护边界' }
  if (policy.mode === 'danger-full-access') return { ok: true, protected: false, reason: '完整访问不保证产物防覆盖' }
  if (policy.mode === 'read-only') return { ok: true, protected: true }
  try {
    const privatePath = canonical(store)
    const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? []), target, ...temporaryRoots].filter(Boolean)
    if (roots.some(root => isInside(canonical(root), privatePath) || isInside(privatePath, canonical(root)))) {
      return { ok: false, reason: '工作写根覆盖宿主产物库；请缩小工作范围或使用库外工作目录' }
    }
    return { ok: true, protected: true }
  } catch { return { ok: false, reason: '无法核验宿主产物存储真实路径' } }
}
