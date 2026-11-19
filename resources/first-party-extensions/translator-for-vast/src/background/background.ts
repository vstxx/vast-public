// The service worker: routes requests between pages, content scripts and the engine, owns the
// context menus, and injects the page translator into a tab only after a user action (or an
// automatic-translation rule the user created). It holds no translation state of its own, so a
// restart of the worker loses nothing.

import { catalogLanguages, parseCatalog, planRoute, type Catalog } from '../shared/catalog.ts'
import { normalizeLanguageTag } from '../shared/languages.ts'
import { t, uiLanguage } from '../shared/i18n.ts'
import { LIMITS, SCOPE, errorMessage, parseContentRequest, parseUiRequest, type ContentRequest, type EngineRequest, type PageCommand, type PageState, type Reply, type UiRequest, type Unscoped } from '../shared/protocol.ts'
import { loadSettings, siteBlocked, type Settings } from '../shared/settings.ts'

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html')
const UI_PAGES = new Set([chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('options.html')])
const MENU_PAGE = 'tfv-translate-page'
const MENU_SELECTION = 'tfv-translate-selection'
const MENU_RESTORE = 'tfv-restore-page'
const AUTO_SCRIPT = 'tfv-auto'
const SELECTION_SCRIPT = 'tfv-selection-button'

class ReplyError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

let catalogPromise: Promise<Catalog> | null = null
function catalog(): Promise<Catalog> {
  catalogPromise ??= fetch(chrome.runtime.getURL('catalog/models.json')).then((response) => response.json()).then(parseCatalog)
  catalogPromise.catch(() => { catalogPromise = null })
  return catalogPromise
}

async function defaultTarget(settings: Settings): Promise<string> {
  const { targets } = catalogLanguages(await catalog())
  if (settings.targetLanguage && targets.includes(settings.targetLanguage)) return settings.targetLanguage
  const ui = normalizeLanguageTag(chrome.i18n.getUILanguage())
  return ui && targets.includes(ui) ? ui : 'en'
}

// ---------- Engine (offscreen document) ----------

let creating: Promise<void> | null = null

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [OFFSCREEN_URL] })
  return contexts.length > 0
}

async function ensureOffscreen(): Promise<boolean> {
  if (await offscreenExists()) return false
  creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS' as chrome.offscreen.Reason], justification: 'Runs the on-device translation engine in a Web Worker.' })
    .finally(() => { creating = null })
  await creating
  return true
}

async function engine<T>(request: Unscoped<EngineRequest>, create = true): Promise<T> {
  const message = { scope: SCOPE, ...request } as EngineRequest
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (create) {
      if (await ensureOffscreen()) {
        const settings = await loadSettings()
        await chrome.runtime.sendMessage({ scope: SCOPE, type: 'engine:configure', idleMs: settings.idleSeconds * 1000 }).catch(() => undefined)
      }
    } else if (!await offscreenExists()) throw new ReplyError('Engine is not running', 'released')
    let reply: Reply<T> | undefined
    try {
      reply = await chrome.runtime.sendMessage(message) as Reply<T> | undefined
    } catch (error) {
      // The document closed itself between the check and the message: create it again once.
      if (attempt === 0 && create) continue
      throw error
    }
    if (!reply) {
      if (attempt === 0 && create) continue
      throw new ReplyError('The translation engine did not answer')
    }
    if (!reply.ok) throw new ReplyError(reply.error, reply.code)
    return reply.value
  }
  throw new ReplyError('The translation engine is unavailable')
}

// ---------- Tabs and injection ----------

function webPage(url: string | undefined): URL | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

async function ensureContent(tabId: number): Promise<void> {
  const [probe] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => Boolean((globalThis as { __tfvContent?: boolean }).__tfvContent) })
  if (probe?.result === true) return
  await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, files: ['content.css'] })
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] })
}

async function pageCommand<T>(tabId: number, command: Unscoped<PageCommand>): Promise<T> {
  return await chrome.tabs.sendMessage(tabId, { scope: SCOPE, ...command }, { frameId: 0 }) as T
}

// What the page says about itself and a sample of its prose, read once by a one-off function: the
// page translator is not injected just because the popup opened.
async function readPage(tabId: number): Promise<{ declared: string | null; sample: string }> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    args: [LIMITS.sampleChars],
    func: (limit: number) => {
      const declared = document.documentElement.getAttribute('lang')
      const parts: string[] = []
      let length = 0
      for (const element of document.querySelectorAll('h1, h2, p, li, td, blockquote, article')) {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text.length < 20) continue
        parts.push(text)
        length += text.length + 1
        if (length >= limit) break
      }
      if (length < 200) parts.push((document.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, limit))
      return { declared, sample: parts.join(' ').slice(0, limit) }
    }
  })
  return result?.result ?? { declared: null, sample: '' }
}

async function detect(sample: string, declared: string | null): Promise<{ language: string | null; reliable: boolean }> {
  const page = normalizeLanguageTag(declared)
  const text = sample.slice(0, LIMITS.sampleChars)
  if (text.replace(/\s+/g, '').length >= 3) {
    try {
      const result = await chrome.i18n.detectLanguage(text)
      const top = result.languages?.[0]
      const detected = normalizeLanguageTag(top?.language)
      if (detected && result.isReliable) return { language: detected, reliable: true }
      if (page) return { language: page, reliable: false }
      if (detected && (top?.percentage ?? 0) >= 50) return { language: detected, reliable: false }
    } catch {
      // Falls through to the page's declaration.
    }
  }
  return { language: page, reliable: false }
}

async function startPageTranslation(tabId: number, source: string, target: string): Promise<void> {
  const settings = await loadSettings()
  await ensureContent(tabId)
  await pageCommand(tabId, { type: 'page:translate', source, target, displayMode: settings.displayMode })
}

async function tabInfo(): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const settings = await loadSettings()
  const target = await defaultTarget(settings)
  const languages = catalogLanguages(await catalog())
  const base = { target, sources: languages.sources, targets: languages.targets, settings }
  const url = webPage(tab?.url)
  if (!tab?.id || !url) return { ...base, supported: false }
  let state: PageState | null = null
  try {
    state = await pageCommand<PageState>(tab.id, { type: 'page:state' })
  } catch {
    state = null
  }
  let detected: { language: string | null; reliable: boolean } = { language: state?.source ?? null, reliable: Boolean(state?.source) }
  if (!detected.language) {
    try {
      const page = await readPage(tab.id)
      detected = await detect(page.sample, page.declared)
    } catch {
      detected = { language: null, reliable: false }
    }
  }
  return { ...base, supported: true, tabId: tab.id, host: url.hostname, detected, state, blocked: siteBlocked(settings, url.hostname) }
}

// ---------- Requests ----------

async function handleUi(request: UiRequest): Promise<unknown> {
  switch (request.type) {
    case 'ui:tab':
      return tabInfo()
    case 'ui:translate': {
      const tab = await chrome.tabs.get(request.tabId)
      if (!webPage(tab.url)) throw new ReplyError(t('pageUnsupported'))
      await startPageTranslation(request.tabId, request.source, request.target)
      return { started: true }
    }
    case 'ui:restore':
      return pageCommand(request.tabId, { type: 'page:restore' })
    case 'ui:route':
      return engine({ type: 'engine:route', source: request.source, target: request.target })
    case 'ui:download':
      return engine({ type: 'engine:download', source: request.source, target: request.target })
    case 'ui:cancel-download':
      return engine({ type: 'engine:cancel-download', pairKey: request.pairKey }, false).catch(() => ({ cancelled: false }))
    case 'ui:models':
      return engine({ type: 'engine:models' })
    case 'ui:delete-model':
      return engine({ type: 'engine:delete-model', pairKey: request.pairKey })
    case 'ui:delete-all-models':
      return engine({ type: 'engine:delete-all-models' })
    case 'ui:engine-status':
      // Asking for status must not start the engine.
      return engine({ type: 'engine:status' }, false).catch(() => ({ phase: 'released', heapBytes: 0, routes: [], downloads: [], queued: 0 }))
    case 'ui:settings-changed':
      await applySettings()
      return { applied: true }
  }
}

function tagFor(sender: chrome.runtime.MessageSender): string {
  return `${sender.tab?.id ?? -1}:${sender.frameId ?? 0}:${sender.documentId ?? ''}`
}

async function handleContent(request: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab!.id!
  switch (request.type) {
    case 'content:translate':
      return engine({ type: 'engine:translate', source: request.source, target: request.target, fragments: request.fragments, priority: request.priority, tag: tagFor(sender) })
    case 'content:cancel':
      return engine({ type: 'engine:cancel', tag: tagFor(sender) }, false).catch(() => ({ cancelled: 0 }))
    case 'content:detect':
      return detect(request.sample, request.declared)
    case 'content:route':
      return engine({ type: 'engine:route', source: request.source, target: request.target })
    case 'content:download':
      return engine({ type: 'engine:download', source: request.source, target: request.target })
    case 'content:state':
      return { received: true }
    case 'content:open-options':
      await chrome.runtime.openOptionsPage()
      return { opened: true }
    case 'content:selection-request':
      await showSelection(tabId, request.text)
      return { shown: true }
    case 'content:auto-check':
      return autoCheck(tabId, sender, request.sample, request.declared)
  }
}

async function showSelection(tabId: number, text: string): Promise<void> {
  const settings = await loadSettings()
  const target = await defaultTarget(settings)
  await ensureContent(tabId)
  await pageCommand(tabId, { type: 'page:selection', text: text.slice(0, LIMITS.selectionChars * 4), target, targets: catalogLanguages(await catalog()).targets })
}

// Automatic translation runs only for languages the user listed, only on pages not excluded, and
// only with models already downloaded: it never starts a download on its own.
async function autoCheck(tabId: number, sender: chrome.runtime.MessageSender, sample: string, declared: string | null): Promise<unknown> {
  if (sender.frameId !== 0) return { translate: false }
  const settings = await loadSettings()
  const url = webPage(sender.url)
  if (!url || settings.alwaysTranslate.length === 0 || siteBlocked(settings, url.hostname)) return { translate: false }
  const { language } = await detect(sample, declared)
  const target = await defaultTarget(settings)
  if (!language || language === target || !settings.alwaysTranslate.includes(language) || settings.neverTranslateLanguages.includes(language)) return { translate: false }
  if (!planRoute(await catalog(), language, target)) return { translate: false }
  const route = await engine<{ installed: boolean }>({ type: 'engine:route', source: language, target })
  if (!route.installed) return { translate: false }
  await startPageTranslation(tabId, language, target)
  return { translate: true }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply<unknown>) => void) => {
  if (sender.id !== chrome.runtime.id) return false
  let work: Promise<unknown> | null = null
  // Classified by the sender's document, not by sender.tab: Vast hosts the action popup in a
  // surface the compatibility layer also reports as a tab.
  const page = sender.url?.split(/[?#]/)[0]
  if (page && UI_PAGES.has(page)) {
    const request = parseUiRequest(message)
    if (request) work = handleUi(request)
  } else if (sender.tab?.id !== undefined && webPage(sender.url)) {
    // A content script of this extension, running in a website. Its input is untrusted.
    const request = parseContentRequest(message)
    if (request) work = handleContent(request, sender)
  }
  if (!work) return false
  work.then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) => sendResponse({ ok: false, error: errorMessage(error), ...(error instanceof ReplyError && error.code ? { code: error.code } : {}) })
  )
  return true
})

// ---------- Context menus ----------

async function createMenus(): Promise<void> {
  const language = uiLanguage()
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({ id: MENU_SELECTION, title: t('menuTranslateSelection', {}, language), contexts: ['selection'] })
  chrome.contextMenus.create({ id: MENU_PAGE, title: t('menuTranslatePage', {}, language), contexts: ['page'] })
  chrome.contextMenus.create({ id: MENU_RESTORE, title: t('menuShowOriginal', {}, language), contexts: ['page'] })
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id
  if (tabId === undefined || !webPage(tab?.url ?? info.pageUrl)) return
  void (async () => {
    if (info.menuItemId === MENU_SELECTION) {
      await showSelection(tabId, info.selectionText ?? '')
      return
    }
    if (info.menuItemId === MENU_RESTORE) {
      await pageCommand(tabId, { type: 'page:restore' }).catch(() => undefined)
      return
    }
    if (info.menuItemId === MENU_PAGE) {
      const settings = await loadSettings()
      const target = await defaultTarget(settings)
      const page = await readPage(tabId)
      const { language } = await detect(page.sample, page.declared)
      if (!language || language === target) return
      const route = await engine<{ installed: boolean; available: boolean }>({ type: 'engine:route', source: language, target })
      // Without a model the page cannot be translated yet; the page popup offers the download.
      if (!route.installed) {
        await ensureContent(tabId)
        if (route.available) await pageCommand(tabId, { type: 'page:offer', source: language, target, displayMode: settings.displayMode, targets: catalogLanguages(await catalog()).targets })
        return
      }
      await startPageTranslation(tabId, language, target)
    }
  })().catch((error: unknown) => console.warn('[translator] menu action failed:', errorMessage(error)))
})

// ---------- Settings-driven registrations ----------

function excludeFor(settings: Settings): string[] {
  return settings.neverTranslateSites.flatMap((site) => [`*://${site}/*`, `*://*.${site}/*`])
}

async function applySettings(): Promise<void> {
  const settings = await loadSettings()
  const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id))
  const wanted: chrome.scripting.RegisteredContentScript[] = []
  const common = { matches: ['http://*/*', 'https://*/*'], excludeMatches: excludeFor(settings), runAt: 'document_idle' as const, allFrames: false, persistAcrossSessions: true }
  if (settings.alwaysTranslate.length > 0) wanted.push({ id: AUTO_SCRIPT, js: ['auto.js'], ...common })
  if (settings.selectionButton) wanted.push({ id: SELECTION_SCRIPT, js: ['selection-button.js'], ...common })
  const stale = [...registered].filter((id) => id === AUTO_SCRIPT || id === SELECTION_SCRIPT)
  if (stale.length > 0) await chrome.scripting.unregisterContentScripts({ ids: stale })
  if (wanted.length > 0) await chrome.scripting.registerContentScripts(wanted)
  if (await offscreenExists()) await engine({ type: 'engine:configure', idleMs: settings.idleSeconds * 1000 }, false).catch(() => undefined)
}

chrome.runtime.onInstalled.addListener(() => {
  void createMenus()
  void applySettings()
})
chrome.runtime.onStartup.addListener(() => { void createMenus() })

// Exposed for E2E probes from the worker's devtools target.
;(globalThis as Record<string, unknown>).translatorDebug = { engine, tabInfo, applySettings, createMenus, startPageTranslation, pageCommand }
