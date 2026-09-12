import { installElementPicker } from './picker.ts'
declare const chrome: any
let style: HTMLStyleElement | undefined, observer: MutationObserver | undefined, timer: number | undefined, cancelPicker: (() => void) | undefined
let initial = true, busy = false, generation = 0, dead = false
const known = new Set<string>()
function remove() { style?.remove(); style = undefined; observer?.disconnect(); observer = undefined; clearTimeout(timer); cancelPicker?.(); cancelPicker = undefined; known.clear() }
async function refresh(reset = false) {
  if (dead || !chrome.runtime?.id) { remove(); return }
  if (reset) { generation++; remove(); initial = true }
  if (busy) { timer = window.setTimeout(() => void refresh(), 150); return }
  busy = true; const current = generation
  try {
    const features = { ids: [] as string[], classes: [] as string[], hrefs: [] as string[] }
    const elements = document.querySelectorAll('[id],[class],[href]')
    for (let i = 0; i < Math.min(elements.length, 12000); i++) {
      const element = elements[i]
      for (const [key, values] of [['ids', [element.id]], ['classes', [...element.classList]], ['hrefs', [element.getAttribute('href')]]] as const) {
        for (const value of values) if (value && value.length <= 256 && features[key].length < 512 && !known.has(key + value)) features[key].push(value)
      }
    }
    const response = await chrome.runtime.sendMessage({ type: 'cosmetics', ...features, initial })
    if (generation !== current) return
    if (!response?.ok || !response.value.active) { remove(); return }
    for (const key of ['ids', 'classes', 'hrefs'] as const) for (const value of features[key]) if (known.size < 8192) known.add(key + value)
    const css = response.value.styles
    if (typeof css === 'string' && css.trim()) { if (!style) { style = document.createElement('style'); (document.head || document.documentElement).append(style) } style.textContent += '\n' + css }
    initial = false
    if (!observer) { observer = new MutationObserver(() => { clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 400) }); observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class', 'href'] }) }
  } catch { dead = !chrome.runtime?.id; remove() }
  finally { busy = false }
}
chrome.runtime.onMessage.addListener((message: any, _sender: unknown, respond: (value: unknown) => void) => {
  if (message?.type === 'refresh') { void refresh(true); respond(true) }
  else if (message?.type === 'pick' && window === window.top && typeof message.token === 'string') {
    cancelPicker?.(); cancelPicker = installElementPicker(async selector => {
      const result = await chrome.runtime.sendMessage({ type: 'picked', token: message.token, selector, cancel: !selector })
      if (result.ok) void refresh(true)
      return result
    }); respond(true)
  }
})
document.addEventListener('DOMContentLoaded', () => void refresh(true), { once: true })
window.addEventListener('pagehide', () => remove())
window.addEventListener('pageshow', event => { if (event.persisted) void refresh(true) })
// Native unload invalidates chrome.runtime in surviving content contexts.
// Poll only the local extension identity; no browsing data or extra IPC.
const lifecycle = setInterval(() => { if (!chrome.runtime?.id) { dead = true; remove(); clearInterval(lifecycle) } }, 1000)
if (document.documentElement) void refresh()
