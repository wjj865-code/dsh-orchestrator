// Tiny CDP client (no dependencies) for driving headless Chrome against the throwaway DSH Web UI.
// Copied from reports/main-permission-badge-verify/harness/cdp.mjs (same author, same purpose).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function launchChrome({ port = 9433, userDataDir, startUrl, chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe' }) {
  mkdirSync(userDataDir, { recursive: true })
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    startUrl,
  ], { stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/json/version`)
      if (res.ok) {
        const version = await res.json()
        return { child, base, version }
      }
    } catch {}
    await sleep(200)
  }
  throw new Error('chrome did not expose the debugging endpoint')
}

export async function connectPage({ base, url }) {
  let target
  for (let i = 0; i < 100; i += 1) {
    const list = await (await fetch(`${base}/json/list`)).json()
    target = list.find(t => t.type === 'page')
    if (target !== undefined) break
    await sleep(200)
  }
  if (target === undefined) throw new Error('no page target')
  if (url !== undefined && target.url !== url) {
    await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    await sleep(300)
    const list = await (await fetch(`${base}/json/list`)).json()
    target = list.find(t => t.type === 'page' && t.url === url) ?? list.find(t => t.type === 'page')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`CDP ${msg.error.message}`))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    })
    if (result.exceptionDetails) throw new Error(`eval failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
    return result.result?.value
  }
  const navigate = async target => {
    await send('Page.navigate', { url: target })
    await sleep(1000)
  }
  const screenshot = async file => {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(result.data, 'base64'))
  }
  const text = () => evaluate('document.body.innerText')
  const insertText = async value => { await send('Input.insertText', { text: value }) }
  const pressKey = async (key, { code = key, vk = 13 } = {}) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  }
  return { ws, send, evaluate, navigate, screenshot, text, insertText, pressKey, close: () => ws.close() }
}

/** Wait until predicate (evaluated in page) is truthy or timeout. */
export async function waitFor(page, expression, { timeout = 30000, interval = 250 } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await page.evaluate(expression)
      if (last) return last
    } catch {}
    await sleep(interval)
  }
  throw new Error(`waitFor timeout: ${expression} (last=${JSON.stringify(last)})`)
}

/** Click the deepest visible element whose trimmed text matches exactly, or contains the text. */
export function clickByText(page, needle, { exact = false } = {}) {
  return page.evaluate(`(() => {
    const needle = ${JSON.stringify(needle)};
    const all = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], li, span, div')];
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const matches = all.filter(el => {
      const t = (el.textContent || '').trim();
      if (!t) return false;
      return ${exact} ? t === needle : t.includes(needle);
    }).filter(visible);
    if (matches.length === 0) return { ok: false, reason: 'no-match' };
    matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const target = matches[0];
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, tag: target.tagName, text: (target.textContent || '').trim().slice(0, 80), aria: target.getAttribute('aria-label') };
  })()`)
}

/** Read the permission badge (aria-label + visible label) from the composer. */
export function readBadge(page) {
  return page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[aria-label]')];
    const badge = buttons.find(b => /访问模式|Access mode/i.test(b.getAttribute('aria-label') || ''));
    if (!badge) return null;
    return {
      aria: badge.getAttribute('aria-label'),
      text: (badge.textContent || '').trim(),
      title: badge.getAttribute('title') || null,
    };
  })()`)
}

/** Type text into the composer and optionally submit with Enter. */
export async function sendComposer(page, text, { submit = true } = {}) {
  const focused = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const el = nodes[0];
    if (!el) return { ok: false };
    el.focus();
    return { ok: true, tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') };
  })()`)
  if (!focused?.ok) throw new Error('composer not found')
  await sleep(200)
  await page.insertText(text)
  await sleep(600)
  if (submit) {
    await page.pressKey('Enter')
    await sleep(800)
  }
  return focused
}

export const artifacts = {
  writeJson(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8') },
}
