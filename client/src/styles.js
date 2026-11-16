/**
 * 样式注入（P7 / T7.2 迁入）：样式表在构建期以 ?inline 内联成字符串，运行时注入一次。
 *
 * 平台只 serve 一个 JS（.css 路由 404），所以不能用 <link>；没有 document（单测/SSR）时静默跳过，
 * 注入失败也只丢样式，不能让整个面板炸掉。
 */
import { STYLE_ID } from './constants.js'
import STYLE_TEXT from './styles.css?inline'

export { STYLE_TEXT }

// 样式只在**内容变化**时刷新，不按「id 在不在」一刀切：
// 客户端插件可以在页面活着的状态下被宿主热替换（桌面端升级插件包即是如此）。旧实现看到同 id 的
// <style> 就 return，于是一页里留下来自上一代构建的 CSS，而新构建的标记（例如会话头入口的
// .orch-entry-mark / .orch-entry-label）一个规则都匹配不到：图标裸在 18px 行盒里、没字号没间距，
// 只有「任务」入口偏，别的沿用旧 class 的面板都正常。文本不同就就地覆盖，热替换后立刻自愈。
export const ensureStyles = () => {
  try {
    if (typeof document === 'undefined' || document === null) return false
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null && existing !== undefined) {
      if (existing.textContent === STYLE_TEXT) return false
      existing.textContent = STYLE_TEXT
      return true
    }
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
