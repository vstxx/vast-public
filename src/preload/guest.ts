import { contextBridge, ipcRenderer, webFrame } from 'electron/renderer'
import { installDocumentSpoofing, type DocumentSpoofingConfig } from '../shared/spoofing'

const spoofingDocumentConfig = ipcRenderer.sendSync('vast:spoofing:document-config', location.href) as DocumentSpoofingConfig | null
if (spoofingDocumentConfig) {
  try {
    contextBridge.executeInMainWorld({ func: installDocumentSpoofing, args: [spoofingDocumentConfig] })
  } catch {
    // Network headers remain coherent if Chromium locks down one JS surface.
  }
}

const privacyDocumentScript = ipcRenderer.sendSync('vast:privacy:document-script', location.href)
if (typeof privacyDocumentScript === 'string' && privacyDocumentScript) {
  void webFrame.executeJavaScript(privacyDocumentScript).catch(() => undefined)
}

// Rules were matched while the main-frame request was held, before this preload.
// No extension execution API is exposed to the page or to content scripts.
if (process.isMainFrame && /^https?:$/.test(location.protocol)) {
  const documentRules: unknown = ipcRenderer.sendSync('vast:extensions:document-rules', location.href)
  if (Array.isArray(documentRules)) for (const script of documentRules) {
    if (typeof script === 'string') void webFrame.executeJavaScript(script).catch(() => undefined)
  }
}

let scrollBoundaryFrame = 0
let pendingScrollTarget: EventTarget | null = null
let lastScrollAtTop: boolean | undefined
let topOverscrollDistance = 0
let topOverscrollVisible = false

function onZoomWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
  ipcRenderer.sendToHost('vast:wheel-zoom', event.deltaY * scale)
}

function scrollTopFor(target: EventTarget | null): number {
  if (target instanceof Element && target.scrollHeight > target.clientHeight + 2) return target.scrollTop
  const scrollingElement = document.scrollingElement
  return Math.max(window.scrollY, scrollingElement?.scrollTop ?? 0)
}

function publishScrollBoundary(target: EventTarget | null = null): void {
  const atTop = scrollTopFor(target) <= 1
  if (atTop === lastScrollAtTop) return
  lastScrollAtTop = atTop
  ipcRenderer.sendToHost('vast:scroll-boundary', atTop)
  if (!atTop && topOverscrollVisible) {
    topOverscrollVisible = false
    topOverscrollDistance = 0
    ipcRenderer.sendToHost('vast:purist-top-overscroll', 'hide')
  }
}

function documentIsAtTop(): boolean {
  const scrollingElement = document.scrollingElement
  return Math.max(window.scrollY, scrollingElement?.scrollTop ?? 0) <= 1
}

function onTopOverscrollWheel(event: WheelEvent): void {
  if (event.deltaY < 0 && documentIsAtTop() && scrollTopFor(event.target) <= 1) {
    topOverscrollDistance = Math.min(48, topOverscrollDistance + Math.abs(event.deltaY))
    if (!topOverscrollVisible && topOverscrollDistance >= 18) {
      topOverscrollVisible = true
      ipcRenderer.sendToHost('vast:purist-top-overscroll', 'show')
    }
    return
  }
  if (event.deltaY <= 0) return
  topOverscrollDistance = 0
  if (!topOverscrollVisible) return
  topOverscrollVisible = false
  ipcRenderer.sendToHost('vast:purist-top-overscroll', 'hide')
}

function queueScrollBoundary(event?: Event): void {
  pendingScrollTarget = event?.target ?? pendingScrollTarget
  if (scrollBoundaryFrame) return
  scrollBoundaryFrame = window.requestAnimationFrame(() => {
    scrollBoundaryFrame = 0
    const target = pendingScrollTarget
    pendingScrollTarget = null
    publishScrollBoundary(target)
  })
}

document.addEventListener('scroll', queueScrollBoundary, { capture: true, passive: true })
document.addEventListener('wheel', onZoomWheel, { capture: true, passive: false })
document.addEventListener('wheel', onTopOverscrollWheel, { capture: true, passive: true })
window.addEventListener('pageshow', () => queueScrollBoundary())
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => queueScrollBoundary(), { once: true })
} else {
  queueScrollBoundary()
}

