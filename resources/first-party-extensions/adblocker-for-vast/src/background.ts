import { defaults, validateSettings, LISTS, type Settings } from './settings.ts'
import { adblockHostname } from './hosts.ts'
import { download, readState, writeState, writeTotal, validateList, type CachedList } from './cache.ts'
declare const chrome: any
declare global { interface Window { vastExtensionCapabilities?: { network: number }; vastWebRequest?: { handle: typeof network; unavailable: () => void } } }
let settings = defaults(), lists: Record<string, CachedList> = {}, compiled: any, engine: Client | undefined
let error = '', ready = false, updating = false, total = 0, retryAt = 0, revision = 0
let queue: Promise<unknown> = Promise.resolve(), queued = 0
const pages = new Map<number, { url: string; count: number; generation: number }>()
const retries = new Map<string, { start: number; count: number }>()
const pickerTokens = new Map<number, { token: string; url: string; expires: number }>()
let resources = '', savedTotal = 0
let updateController: AbortController | undefined
class Client {
  worker = new Worker(chrome.runtime.getURL('dist/worker.js'))
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>()
  id = 0; dead = false
  constructor() {
    this.worker.onmessage = ({ data }) => { const task = this.pending.get(data.id); if (!task) return; clearTimeout(task.timer); this.pending.delete(data.id); data.error ? task.reject(new Error(data.error)) : task.resolve(data.result) }
    this.worker.onerror = () => this.stop()
  }
  call(type: string, input: unknown): Promise<any> {
    if (this.dead || this.pending.size >= 1024) return Promise.reject(new Error('Filtering engine is unavailable.'))
    return new Promise((resolve, reject) => { const id = ++this.id, timer = self.setTimeout(() => this.stop(), type === 'init' ? 45000 : 180); this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, type, input }) })
  }
  stop(): void { this.dead = true; this.worker.terminate(); for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('Filtering engine stopped.')) } this.pending.clear(); if (engine === this) { engine = undefined; ready = false; error = 'Filtering stopped. Disable and re-enable the extension to retry.' } }
}
function serial<T>(operation: () => Promise<T>): Promise<T> {
  if (queued >= 16) return Promise.reject(new Error('Busy. Try again shortly.'))
  queued++; const next = queue.catch(() => undefined).then(operation).finally(() => queued--); queue = next; return next
}
function stored() { return { schema: 1, settings, lists, compiled, total, retryAt } }
function active(url: string) { const host = adblockHostname(url); return Boolean(host && settings.enabled && ready && engine && !settings.allowlist.includes(host)) }
function page(id: number, url: string) {
  let entry = pages.get(id)
  if (!entry || entry.url !== url) { entry = { url, count: 0, generation: (entry?.generation ?? 0) + 1 }; if (pages.size >= 1000) pages.delete(pages.keys().next().value!); pages.set(id, entry) }
  return entry
}
async function refreshPages() {
  revision++
  const tabs = await chrome.tabs.query({}).catch(() => [])
  for (const tab of tabs) if (adblockHostname(tab.url ?? '')) void chrome.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => undefined)
}
async function candidate(next: Settings, nextLists: Record<string, CachedList>, cache = compiled) {
  const client = new Client()
  try { return { client, result: await client.call('init', { settings: next, lists: nextLists, resources, cached: cache }) } } catch (failure) { client.stop(); throw failure }
}
async function installCandidate(next: Settings, nextLists: Record<string, CachedList>) {
  const filterIdentity = (value: Settings) => JSON.stringify([value.blockAds, value.blockTrackers, value.lists, value.customFilters])
  if (ready && engine && nextLists === lists && filterIdentity(next) === filterIdentity(settings)) {
    await writeState({ ...stored(), settings: next }); settings = next; await refreshPages(); return
  }
  const { client, result } = await candidate(next, nextLists)
  try { await writeState({ ...stored(), settings: next, lists: nextLists, compiled: result }) } catch (failure) { client.stop(); throw failure }
  const previous = engine; engine = client; previous?.stop(); settings = next; lists = nextLists; compiled = result; ready = true; error = ''; await refreshPages()
}
async function update(force: boolean) {
  if (!settings.enabled || !force && Date.now() < retryAt) return
  const selected = LISTS.filter(list => settings.lists.includes(list.id) && (force || Date.now() - (lists[list.id]?.checkedAt ?? 0) > 86400000))
  if (!selected.length) return
  updating = true
  const controller = new AbortController(); updateController = controller
  try {
    const next = { ...lists }; let changed = false
    for (const list of selected) {
      try { next[list.id] = await download(list.url, lists[list.id], controller.signal); changed = true }
      catch (failure) { if (controller.signal.aborted) return; next[list.id] = { ...lists[list.id], error: failure instanceof Error ? failure.message : 'Update failed.' } }
    }
    if (Object.values(next).reduce((size, item) => size + new TextEncoder().encode(item.text).length, 0) > 48 * 1024 * 1024) throw new Error('Combined filters exceed 48 MiB.')
    if (controller.signal.aborted) return
    if (changed) await installCandidate(settings, next)
    else lists = next
  } catch (failure) { error = failure instanceof Error ? failure.message : 'Previous filters remain active.' }
  finally { updateController = undefined; updating = false; retryAt = Date.now() + 3600000; await writeState(stored()).catch(() => undefined) }
}
async function network(input: any) {
  if (input.type === 'mainFrame' && input.phase === 'request') { pages.delete(input.tabId) }
  if (!active(input.topUrl)) return {}
  const entry = page(input.tabId, input.topUrl)
  try {
    const result = await engine!.call(input.phase === 'headers' ? 'headers' : 'match', { url: input.url, sourceUrl: input.sourceUrl, type: input.type })
    if (result.cancel) {
      const key = `${input.tabId}:${entry.generation}:${input.url}`; let budget = retries.get(key)
      if (!budget || Date.now() - budget.start > 1000) { budget = { start: Date.now(), count: 0 }; if (retries.size >= 256) retries.delete(retries.keys().next().value!); retries.set(key, budget) }
      if (++budget.count > 16) await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!active(input.topUrl) || pages.get(input.tabId) !== entry) return {}
    if (result.cancel || result.redirectURL?.startsWith('data:')) { entry.count++; total = Math.min(Number.MAX_SAFE_INTEGER, total + 1) }
    return result
  } catch { return {} }
}
function status(tabId?: number, url?: string) {
  const hostname = adblockHostname(url ?? '')
  return { settings, ready, error, updating, revision, hostname, pageBlocked: tabId ? pages.get(tabId)?.count ?? 0 : 0, totalBlocked: total,
    siteEnabled: active(url ?? ''), cosmeticActive: active(url ?? '') && settings.cosmetics && !settings.cosmeticAllowlist.includes(hostname!),
    lists: LISTS.map(list => ({ ...list, ...compiled?.report?.[list.id], updatedAt: lists[list.id]?.updatedAt, checkedAt: lists[list.id]?.checkedAt, error: lists[list.id]?.error })), performance: { initializationMs: compiled?.initializationMs, cacheHit: compiled?.cacheHit } }
}
async function message(input: any, sender: any) {
  if (!input || typeof input !== 'object' || sender.id !== chrome.runtime.id) throw new Error('Invalid message.')
  const privileged = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))
  if (input.type === 'cosmetics') {
    const url = sender.url, tabId = sender.tab?.id, topUrl = sender.tab?.url
    if (!Number.isInteger(tabId) || !adblockHostname(url) || !active(topUrl ?? '') || !settings.cosmetics || settings.cosmeticAllowlist.includes(adblockHostname(topUrl)!)) return { active: false, styles: '' }
    for (const key of ['ids', 'classes', 'hrefs']) if (!Array.isArray(input[key]) || input[key].length > 512 || input[key].some((value: unknown) => typeof value !== 'string' || value.length > 256)) throw new Error('Invalid page features.')
    const current = revision
    const result = await engine!.call('cosmetics', { url, ids: input.ids, classes: input.classes, hrefs: input.hrefs, initial: input.initial === true })
    return current === revision ? result : { active: false, styles: '' }
  }
  if (input.type === 'picked') {
    const pending = pickerTokens.get(sender.tab?.id)
    if (!pending || input.token !== pending.token || sender.frameId !== 0 || sender.url !== pending.url || pending.expires < Date.now()) throw new Error('Picker expired or page changed.')
    pickerTokens.delete(sender.tab.id)
    if (input.cancel) return {}
    if (typeof input.selector !== 'string' || input.selector.length > 512 || /[\r\n\0{}]/.test(input.selector) || !input.selector.includes(':nth-of-type(')) throw new Error('Choose a narrower element.')
    return serial(() => installCandidate(validateSettings({ ...settings, customFilters: `${settings.customFilters}\n${adblockHostname(sender.url)}##${input.selector}`.trim() }), lists))
  }
  if (!privileged) throw new Error('This operation is limited to extension pages.')
  if (input.type === 'status') {
    const tabs = await chrome.tabs.query({ active: true }); const tab = tabs.find((tab: any) => adblockHostname(tab.url ?? ''))
    return { ...status(tab?.id, tab?.url), tabId: tab?.id, url: tab?.url }
  }
  if (['settings', 'site'].includes(input.type)) updateController?.abort()
  if (input.type === 'settings') return serial(async () => {
    if (input.expected && JSON.stringify(validateSettings(input.expected)) !== JSON.stringify(settings)) throw new Error('Settings changed. Load current settings before saving.')
    await installCandidate(validateSettings(input.settings), lists)
  })
  if (input.type === 'site' || input.type === 'picker' || input.type === 'reload') {
    const tabs = await chrome.tabs.query({}), tab = tabs.find((tab: any) => tab.id === input.tabId && tab.url === input.url)
    if (!tab || !adblockHostname(tab.url)) throw new Error('The page changed. Reopen the popup.')
    if (input.type === 'reload') return chrome.tabs.reload(tab.id)
    if (input.type === 'picker') {
      if (!active(tab.url)) throw new Error('Enable blocking first.')
      const token = crypto.randomUUID(); pickerTokens.set(tab.id, { token, url: tab.url, expires: Date.now() + 120000 })
      return chrome.tabs.sendMessage(tab.id, { type: 'pick', token }, { frameId: 0 })
    }
    return serial(async () => { const key = input.cosmeticOnly ? 'cosmeticAllowlist' : 'allowlist', hosts = new Set(settings[key]); input.enabled ? hosts.delete(adblockHostname(tab.url)!) : hosts.add(adblockHostname(tab.url)!); const next = validateSettings({ ...settings, [key]: [...hosts] }); await writeState({ ...stored(), settings: next }); settings = next; await refreshPages() })
  }
  if (input.type === 'update') return serial(() => update(true))
  if (input.type === 'reset-stats') return serial(async () => { total = 0; await writeTotal(total); savedTotal = total })
  throw new Error('Unknown operation.')
}
chrome.runtime.onMessage.addListener((input: unknown, sender: unknown, respond: (value: unknown) => void) => {
  void message(input, sender).then(value => respond({ ok: true, value }), failure => respond({ ok: false, error: failure instanceof Error ? failure.message : 'Operation failed.' })); return true
})
async function start() {
  let saved: any
  try { saved = await readState(); if (saved?.schema === 1) { settings = validateSettings(saved.settings); total = Number.isSafeInteger(saved.total) && saved.total > 0 ? saved.total : 0; retryAt = Number.isSafeInteger(saved.retryAt) && saved.retryAt < Date.now() + 86400000 ? saved.retryAt : 0; compiled = saved.compiled } } catch { error = 'Saved settings could not load. Defaults are active.' }
  resources = await (await fetch(chrome.runtime.getURL('assets/resources.json'))).text()
  const provenance = await (await fetch(chrome.runtime.getURL('assets/provenance.json'))).json(), preparedAt = Date.parse(provenance.preparedAt)
  for (const list of LISTS) {
    try { const item = saved?.lists?.[list.id]; validateList(item.text); lists[list.id] = item } catch { lists[list.id] = { text: await (await fetch(chrome.runtime.getURL(`assets/${list.id}.txt`))).text(), updatedAt: preparedAt, checkedAt: preparedAt } }
  }
  await installCandidate(settings, lists)
  if (window.vastExtensionCapabilities?.network !== 1) throw new Error('Update Vast to a version with the extension network API before enabling this extension.')
  window.vastWebRequest = { handle: network, unavailable: () => { ready = false; error = 'Extension request processing timed out. Disable and re-enable the extension to retry.' } }
  if (settings.autoUpdate) void serial(() => update(false)).catch(() => undefined)
  setInterval(() => { if (settings.autoUpdate) void serial(() => update(false)).catch(() => undefined) }, 3600000)
  savedTotal = total
  setInterval(() => { if (total !== savedTotal) { const snapshot = total; void writeTotal(snapshot).then(() => { savedTotal = snapshot }).catch(() => undefined) } }, 15000)
}
void start().catch(failure => { ready = false; error = failure instanceof Error ? failure.message : 'Could not initialize. Browsing remains available.' })
