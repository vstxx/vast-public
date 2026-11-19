import { languageName, sortByName } from '../shared/languages.ts'
import { formatBytes, t, uiLanguage } from '../shared/i18n.ts'
import { SCOPE, errorMessage, parsePageState, type DownloadProgress, type PageState, type RouteStatus } from '../shared/protocol.ts'
import { saveSettings, type DisplayMode, type Settings } from '../shared/settings.ts'
import { h, localize, onEngineEvents, request } from './common.ts'

interface TabInfo {
  supported: boolean
  tabId?: number
  host?: string
  detected?: { language: string | null; reliable: boolean }
  state?: PageState | null
  blocked?: boolean
  target: string
  sources: string[]
  targets: string[]
  settings: Settings
}

const language = uiLanguage()
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const view = {
  source: $<HTMLSelectElement>('source'),
  target: $<HTMLSelectElement>('target'),
  action: $<HTMLButtonElement>('action'),
  status: $<HTMLParagraphElement>('status'),
  download: $<HTMLDivElement>('download'),
  downloadText: $<HTMLParagraphElement>('download-text'),
  downloadButton: $<HTMLButtonElement>('download-button'),
  downloadCancel: $<HTMLButtonElement>('download-cancel'),
  downloadBar: $<HTMLDivElement>('download-bar'),
  controls: $<HTMLDivElement>('controls'),
  display: $<HTMLDivElement>('display'),
  always: $<HTMLInputElement>('always'),
  alwaysLabel: $<HTMLSpanElement>('always-label'),
  never: $<HTMLInputElement>('never'),
  neverLabel: $<HTMLSpanElement>('never-label'),
  settings: $<HTMLButtonElement>('open-settings')
}

let info: TabInfo | null = null
let route: RouteStatus | null = null
let page: PageState | null = null
let downloading = false
const loadedByPair = new Map<string, number>()

const name = (code: string) => languageName(code, language)

function fillSelect(select: HTMLSelectElement, codes: string[], selected: string, auto?: string | null): void {
  const options = sortByName(codes, language).map((code) => h('option', { value: code, selected: code === selected }, name(code)))
  if (auto !== undefined) options.unshift(h('option', { value: '', selected: selected === '' }, auto ? t('detected', { language: name(auto) }) : t('unknownLanguage')))
  select.replaceChildren(...options)
}

function source(): string | null {
  return view.source.value || info?.detected?.language || null
}

function setStatus(text: string, error = false): void {
  view.status.textContent = text
  view.status.classList.toggle('error', error)
}

function render(): void {
  if (!info) return
  const src = source()
  const target = view.target.value
  view.download.hidden = true
  view.action.disabled = true
  if (!info.supported) {
    view.action.textContent = t('translatePage')
    setStatus(t('pageUnsupported'))
    return
  }
  if (page && (page.status === 'translating' || page.status === 'translated' || page.status === 'restoring')) {
    view.action.disabled = false
    view.action.textContent = page.status === 'translating' ? t('cancel') : t('showOriginal')
    view.action.classList.remove('primary')
    setStatus(page.status === 'translating' ? t('translating', { done: page.done, total: Math.max(page.total, page.done) }) : `${t('translated', { done: page.done })}${page.error ? ` ${page.error}` : ''}`, Boolean(page.error && page.status !== 'translating'))
    return
  }
  view.action.classList.add('primary')
  view.action.textContent = t('translatePage')
  if (page?.status === 'error' && page.error) setStatus(t('errorGeneric', { error: page.error }), true)
  else if (page?.kept) setStatus(t('translatedKept', { kept: page.kept }))
  else setStatus('')
  if (!src) {
    setStatus(t('unknownLanguage'))
    return
  }
  if (src === target) {
    setStatus(t('pageAlreadyTarget', { language: name(target) }))
    return
  }
  if (!route || route.source !== src || route.target !== target) return
  if (!route.available) {
    setStatus(t('noRoute', { source: name(src), target: name(target) }))
    return
  }
  if (!route.installed) {
    view.download.hidden = false
    view.downloadText.textContent = `${t('downloadNeeded', { source: name(src), target: name(target) })}${route.pivot ? ` ${t('downloadPivot')}` : ''}`
    view.downloadButton.hidden = downloading
    view.downloadCancel.hidden = !downloading
    view.downloadBar.hidden = !downloading
    view.downloadButton.textContent = t('downloadAction', { size: formatBytes(route.downloadBytes) })
    return
  }
  view.action.disabled = false
  if (!view.status.textContent) setStatus(t('offlineReady'))
}

async function refreshRoute(): Promise<void> {
  const src = source()
  const target = view.target.value
  route = null
  render()
  if (!src || src === target) return
  try {
    route = await request<RouteStatus>('ui:route', { source: src, target })
  } catch (error) {
    setStatus(errorMessage(error), true)
  }
  render()
}

function renderToggles(): void {
  if (!info) return
  const src = source()
  view.controls.hidden = !info.supported
  for (const button of view.display.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === info.settings.displayMode))
  view.always.parentElement!.hidden = !src || src === view.target.value
  if (src) {
    view.alwaysLabel.textContent = t('alwaysTranslateLanguage', { language: name(src) })
    view.always.checked = info.settings.alwaysTranslate.includes(src)
  }
  view.never.parentElement!.hidden = !info.host
  view.neverLabel.textContent = t('neverTranslateSite', { site: info.host ?? '' })
  view.never.checked = Boolean(info.blocked)
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  if (!info) return
  info.settings = await saveSettings(patch)
  await request('ui:settings-changed').catch(() => undefined)
  renderToggles()
}

async function start(): Promise<void> {
  localize()
  try {
    info = await request<TabInfo>('ui:tab')
  } catch (error) {
    setStatus(errorMessage(error), true)
    return
  }
  page = info.state ?? null
  const detected = info.detected?.language ?? null
  const chosenSource = page?.source && page.source !== detected ? page.source : ''
  fillSelect(view.source, info.sources, chosenSource, detected)
  fillSelect(view.target, info.targets, page?.target ?? info.target)
  renderToggles()
  render()
  await refreshRoute()
}

view.source.addEventListener('change', () => { renderToggles(); void refreshRoute() })
view.target.addEventListener('change', () => {
  void updateSettings({ targetLanguage: view.target.value })
  renderToggles()
  void refreshRoute()
})

view.action.addEventListener('click', async () => {
  if (!info?.tabId) return
  view.action.disabled = true
  try {
    if (page && (page.status === 'translating' || page.status === 'translated')) {
      page = await request<PageState>('ui:restore', { tabId: info.tabId })
    } else {
      const src = source()
      if (!src) return
      await request('ui:translate', { tabId: info.tabId, source: src, target: view.target.value })
      page = { status: 'translating', source: src, target: view.target.value, done: 0, total: 0, error: null, kept: 0 }
    }
  } catch (error) {
    setStatus(errorMessage(error), true)
  }
  render()
})

view.downloadButton.addEventListener('click', async () => {
  const src = source()
  if (!src) return
  downloading = true
  render()
  try {
    route = await request<RouteStatus>('ui:download', { source: src, target: view.target.value })
    setStatus(t('offlineReady'))
  } catch (error) {
    const code = (error as { code?: string }).code
    setStatus(code === 'cancelled' || /cancel/i.test(errorMessage(error)) ? t('downloadCancelled') : t('downloadFailed', { error: errorMessage(error) }), code !== 'cancelled')
    await refreshRoute()
  } finally {
    downloading = false
    render()
  }
})

view.downloadCancel.addEventListener('click', () => {
  for (const hop of route?.hops ?? []) if (!hop.installed) void request('ui:cancel-download', { pairKey: hop.pairKey }).catch(() => undefined)
})

view.display.addEventListener('click', (event) => {
  const mode = (event.target as HTMLElement).closest('button')?.dataset.mode as DisplayMode | undefined
  if (mode) void updateSettings({ displayMode: mode })
})

view.always.addEventListener('change', () => {
  const src = source()
  if (!info || !src) return
  const list = new Set(info.settings.alwaysTranslate)
  if (view.always.checked) list.add(src)
  else list.delete(src)
  void updateSettings({ alwaysTranslate: [...list] })
})

view.never.addEventListener('change', () => {
  if (!info?.host) return
  const host = info.host.replace(/^www\./, '')
  const list = new Set(info.settings.neverTranslateSites)
  if (view.never.checked) list.add(host)
  else list.delete(host)
  info.blocked = view.never.checked
  void updateSettings({ neverTranslateSites: [...list] })
})

// Vast shows extension pages inside its own surface. Navigate within that surface so settings
// remain reachable even when ECE does not open a Chrome options tab.
view.settings.addEventListener('click', () => { location.href = chrome.runtime.getURL('options.html') })

onEngineEvents({
  progress(progress: DownloadProgress) {
    if (!route?.hops.some((hop) => hop.pairKey === progress.pairKey)) return
    // A route through English downloads two pairs; progress is the sum over both.
    loadedByPair.set(progress.pairKey, progress.loadedBytes)
    const total = route.downloadBytes || progress.totalBytes
    const done = [...loadedByPair.values()].reduce((sum, value) => sum + value, 0)
    ;(view.downloadBar.firstElementChild as HTMLElement).style.width = `${Math.min(100, Math.round(done / Math.max(1, total) * 100))}%`
    if (progress.phase === 'download') setStatus(t('downloading', { loaded: formatBytes(done), total: formatBytes(total) }))
  }
})

// Progress of the page translation comes straight from the tab's content script.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== info?.tabId || sender.frameId !== 0) return false
  const value = message as { scope?: string; type?: string; state?: unknown }
  if (value?.scope !== SCOPE || value.type !== 'content:state') return false
  const state = parsePageState(value.state)
  if (state) {
    page = state
    render()
  }
  return false
})

void start()
