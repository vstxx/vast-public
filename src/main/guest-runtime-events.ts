import type { BrowserWindow, WebContents } from 'electron/main'
import type { GuestNavigationState, HtmlFullscreenState, MediaCaptureState } from '../shared/types'
import { windowRegistry } from './windows/WindowRegistry'

interface FullscreenSession {
  guestWebContentsId: number
  window: BrowserWindow
  restoreWindowed: boolean
}

const protectedCaptureContents = new Set<number>()
const fullscreenByWindow = new Map<number, FullscreenSession>()
const installedContents = new Set<number>()

function isGuestContents(contents: WebContents): boolean {
  return Boolean((contents as WebContents & { hostWebContents?: WebContents }).hostWebContents)
}

function sendMediaCaptureState(contents: WebContents, active: boolean): void {
  const owner = windowRegistry.vastWindowForWebContents(contents)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return
  const payload: MediaCaptureState = { webContentsId: contents.id, active }
  owner.webContents.send('vast:browser:media-capture-state', payload)
}

export function protectGuestMediaCapture(contents: WebContents): void {
  if (!isGuestContents(contents) || contents.isDestroyed() || protectedCaptureContents.has(contents.id)) return
  protectedCaptureContents.add(contents.id)
  sendMediaCaptureState(contents, true)
}

export function clearGuestMediaCapture(contents: WebContents): void {
  if (!protectedCaptureContents.delete(contents.id)) return
  sendMediaCaptureState(contents, false)
}

// Main-side reads are local; the chrome previously fetched these with one
// synchronous IPC round trip each, several times per page load.
function sendNavigationState(contents: WebContents, reason: GuestNavigationState['reason']): void {
  if (contents.isDestroyed() || !isGuestContents(contents)) return
  const owner = windowRegistry.vastWindowForWebContents(contents)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return
  const payload: GuestNavigationState = {
    webContentsId: contents.id,
    reason,
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward()
  }
  owner.webContents.send('vast:browser:guest-navigation-state', payload)
}

function enterHtmlFullscreen(contents: WebContents): void {
  if (!isGuestContents(contents)) return
  const owner = windowRegistry.vastWindowForWebContents(contents)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return
  const previous = fullscreenByWindow.get(owner.id)
  if (previous && previous.guestWebContentsId !== contents.id) {
    const leavePayload: HtmlFullscreenState = { webContentsId: previous.guestWebContentsId, active: false }
    owner.webContents.send('vast:browser:html-fullscreen-state', leavePayload)
  }
  const restoreWindowed = previous?.restoreWindowed ?? !owner.isFullScreen()
  fullscreenByWindow.set(owner.id, { guestWebContentsId: contents.id, window: owner, restoreWindowed })
  const payload: HtmlFullscreenState = { webContentsId: contents.id, active: true }
  owner.webContents.send('vast:browser:html-fullscreen-state', payload)
  if (!owner.isFullScreen()) owner.setFullScreen(true)
}

function leaveHtmlFullscreen(contents: WebContents): void {
  const owner = windowRegistry.vastWindowForWebContents(contents)
  const entry = owner
    ? ([owner.id, fullscreenByWindow.get(owner.id)] as const)
    : [...fullscreenByWindow.entries()].find(([, session]) => session.guestWebContentsId === contents.id)
  const session = entry?.[1]
  if (!entry || !session || session.guestWebContentsId !== contents.id) return
  fullscreenByWindow.delete(entry[0])
  const sessionWindow = session.window
  if (!sessionWindow.isDestroyed() && !sessionWindow.webContents.isDestroyed()) {
    const payload: HtmlFullscreenState = { webContentsId: contents.id, active: false }
    sessionWindow.webContents.send('vast:browser:html-fullscreen-state', payload)
  }
  if (!sessionWindow.isDestroyed() && session.restoreWindowed && sessionWindow.isFullScreen()) {
    sessionWindow.setFullScreen(false)
  }
}

export function installGuestRuntimeEventHandling(contents: WebContents): void {
  if (installedContents.has(contents.id)) return
  installedContents.add(contents.id)
  contents.on('enter-html-full-screen', () => enterHtmlFullscreen(contents))
  contents.on('leave-html-full-screen', () => leaveHtmlFullscreen(contents))
  contents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) clearGuestMediaCapture(contents)
  })
  contents.on('did-navigate', () => sendNavigationState(contents, 'navigate'))
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    // Pages usually set document.title right after pushState; report on the
    // next tick so that title update has been processed.
    if (isMainFrame) setImmediate(() => sendNavigationState(contents, 'navigate'))
  })
  contents.on('did-stop-loading', () => sendNavigationState(contents, 'stop'))
  contents.on('dom-ready', () => sendNavigationState(contents, 'ready'))
  const cleanup = (): void => {
    leaveHtmlFullscreen(contents)
    clearGuestMediaCapture(contents)
    installedContents.delete(contents.id)
  }
  contents.once('destroyed', cleanup)
  contents.once('render-process-gone', cleanup)
}
