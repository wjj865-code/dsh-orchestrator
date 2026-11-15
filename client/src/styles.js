/**
 * 样式注入（P7 / T7.2 迁入）：样式表在构建期以 ?inline 内联成字符串，运行时只注入一次。
 *
 * 平台只 serve 一个 JS（.css 路由 404），所以不能用 <link>；没有 document（单测/SSR）时静默跳过，
 * 注入失败也只丢样式，不能让整个面板炸掉。
 */
import { STYLE_ID } from './constants.js'
import STYLE_TEXT from './styles.css?inline'

export { STYLE_TEXT }

export const ensureStyles = () => {
  try {
    if (typeof document === 'undefined' || document === null) return false
    if (document.getElementById(STYLE_ID) !== null) return false
    const host = document.head || document.documentElement
    if (host === null || typeof host.appendChild !== 'function') return false
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE_TEXT
    host.appendChild(style)
    return true
  } catch {
    // 注入失败只丢样式，不该让整个面板炸掉。
    return false
  }
}
