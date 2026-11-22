// 调试用：查看「继续」与「主会话」相关的 DOM 结构，并用真实指针事件点击。
import { connectPage, sleep } from './cdp.mjs'

const base = process.env.CDP_BASE ?? 'http://127.0.0.1:9541'
const page = await connectPage({ base })
await sleep(300)
const info = await page.evaluate(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"], a, div')) {
    const t = (el.textContent || '').trim();
    if (t === '继续' || t === '主会话') {
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, role: el.getAttribute('role'), text: t, w: Math.round(r.width), h: Math.round(r.height), cls: String(el.className).slice(0, 80), html: el.outerHTML.slice(0, 300) });
    }
  }
  return out;
})()`)
console.log(JSON.stringify(info, null, 2))
page.close()
