import { DOMMonitor } from '@ghostery/adblocker-content'
import { installElementPicker } from './picker.ts'
import { proceduralFiltering } from './procedural.ts'
declare const chrome: any
let style: HTMLStyleElement | undefined, monitor: DOMMonitor | undefined, observer: MutationObserver | undefined, cancelPicker: (() => void) | undefined
let generation = 0, dead = false, queue = Promise.resolve(), procedures = proceduralFiltering()
const cssChunks = new Set<string>()
function remove() { style?.remove(); style = undefined; monitor?.stop(); monitor = undefined; observer?.disconnect(); observer = undefined; procedures.stop(); procedures = proceduralFiltering(); cancelPicker?.(); cancelPicker = undefined; cssChunks.clear() }
async function request(features: { ids: string[]; classes: string[]; hrefs: string[] }, initial: boolean, current: number) {
  if (current !== generation || dead || !chrome.runtime?.id) return
  try {
    // Chunk feature deltas instead of dropping all generic filters after 512 IDs.
    const length = Math.max(features.ids.length, features.classes.length, features.hrefs.length, 1)
    for (let offset = 0; offset < Math.min(length, 32768); offset += 512) {
      const input = Object.fromEntries((['ids', 'classes', 'hrefs'] as const).map(key => [key, features[key].slice(offset, offset + 512).filter(value => value.length <= 256)]))
      const response = await chrome.runtime.sendMessage({ type: 'cosmetics', ...input, initial: initial && offset === 0 })
      if (current !== generation) return
      if (!response?.ok || !response.value.active) { if (!response?.ok) console.warn('Adblocker cosmetics:', response?.error); remove(); return }
      const css = response.value.styles
      if (typeof css === 'string' && css.trim() && !cssChunks.has(css) && cssChunks.size < 2048) {
        cssChunks.add(css)
        if (!style) { style = document.createElement('style'); (document.head || document.documentElement).append(style) }
        style.append(document.createTextNode('\n' + css))
      }
      if (Array.isArray(response.value.extended)) procedures.add(response.value.extended)
    }
  } catch (error) { console.warn('Adblocker cosmetics:', String(error)); if (current === generation) { dead = !chrome.runtime?.id; remove() } }
}
function refresh() {
  if (dead || !chrome.runtime?.id || !document.documentElement) return
  generation++; remove(); const current = generation
  const enqueue = (features: { ids: string[]; classes: string[]; hrefs: string[] }, initial = false) => { queue = queue.then(() => request(features, initial, current)) }
  enqueue({ ids: [], classes: [], hrefs: [] }, true)
  let featureCount = 0
  monitor = new DOMMonitor(update => {
    if (current !== generation) return
    if (update.type === 'elements') procedures.changed(update.elements)
    else {
      featureCount += update.ids.length + update.classes.length + update.hrefs.length
      if (featureCount <= 32768) enqueue(update)
      else { monitor?.stop(); console.warn('Adblocker: DOM feature budget reached for this document.') }
    }
  })
  monitor.queryAll(window); monitor.start(window)
  // Ghostery's feature monitor does not watch text or arbitrary attributes.
  // Those can change :has-text/:matches-attr without adding classes or nodes.
  observer = new MutationObserver(mutations => {
    const elements: Element[] = []
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && /^s\d+$/.test(mutation.attributeName ?? '')) continue
      const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
      if (element && element !== style) elements.push(element)
    }
    procedures.changed(elements)
  })
  observer.observe(document.documentElement, { subtree: true, characterData: true, attributes: true })
}
chrome.runtime.onMessage.addListener((message: any, _sender: unknown, respond: (value: unknown) => void) => {
  if (message?.type === 'refresh') { refresh(); respond(true) }
  else if (message?.type === 'pick' && window === window.top && typeof message.token === 'string') {
    cancelPicker?.(); cancelPicker = installElementPicker(async selector => {
      const result = await chrome.runtime.sendMessage({ type: 'picked', token: message.token, selector, cancel: !selector })
      if (result.ok) refresh()
      return result
    }); respond(true)
  }
})
document.addEventListener('DOMContentLoaded', refresh, { once: true })
window.addEventListener('pagehide', () => { generation++; remove() })
window.addEventListener('pageshow', event => { if (event.persisted) refresh() })
window.addEventListener('popstate', refresh)
window.addEventListener('hashchange', refresh)
const lifecycle = setInterval(() => { if (!chrome.runtime?.id) { dead = true; generation++; remove(); clearInterval(lifecycle) } }, 1000)
if (document.documentElement) refresh()
