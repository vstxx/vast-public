import type { BrowserWindow } from 'electron/main'
import type { BrowserTabOpenRequest } from '../../shared/types'
import type { WindowRegistry } from './WindowRegistry'
import { parseExtensionInstallDeepLink } from '../../shared/extension-marketplace.ts'

const MAX_EXTERNAL_URL_LENGTH = 128 * 1024
const MAX_QUEUED_URLS = 100
const DUPLICATE_WINDOW_MS = 1_500
const SAFE_EXTERNAL_NEW_TAB_URL = 'vast://newtab'

function unquoteArgument(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function safeHttpUrl(input: string): string | undefined {
  if (!input || input.length > MAX_EXTERNAL_URL_LENGTH) return undefined
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username || parsed.password) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/** Parses public protocol input without exposing privileged internal pages. */
export function externalNavigationTarget(input: string): string | undefined {
  const candidate = unquoteArgument(input)
  const direct = safeHttpUrl(candidate)
  if (direct) return direct
  if (!candidate || candidate.length > MAX_EXTERNAL_URL_LENGTH) return undefined

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'vast:' || parsed.username || parsed.password) return undefined
    const extensionInstallId = parseExtensionInstallDeepLink(candidate)
    if (extensionInstallId) return `vast://extensions?install=${encodeURIComponent(extensionInstallId)}`
    const command = parsed.hostname.toLowerCase()
    if (command === 'newtab' && !parsed.search && !parsed.hash && (parsed.pathname === '' || parsed.pathname === '/')) {
      return SAFE_EXTERNAL_NEW_TAB_URL
    }
    if (command !== 'open' || (parsed.pathname !== '' && parsed.pathname !== '/')) return undefined
    const target = parsed.searchParams.get('url')
    return target ? safeHttpUrl(target) : undefined
  } catch {
    return undefined
  }
}

export function externalNavigationTargets(argv: readonly string[]): string[] {
  const targets: string[] = []
  for (const argument of argv) {
    const target = externalNavigationTarget(argument)
    if (target) targets.push(target)
  }
  return targets
}

export class ExternalNavigationRouter {
  private readonly queue: string[] = []
  private readonly recentlyAccepted = new Map<string, number>()
  private readonly registry: WindowRegistry
  private readonly createWindow: () => BrowserWindow

  constructor(registry: WindowRegistry, createWindow: () => BrowserWindow) {
    this.registry = registry
    this.createWindow = createWindow
  }

  acceptArguments(argv: readonly string[]): void {
    for (const target of externalNavigationTargets(argv)) this.acceptTarget(target)
  }

  acceptUrl(rawUrl: string): void {
    const target = externalNavigationTarget(rawUrl)
    if (target) this.acceptTarget(target)
  }

  rendererReady(window: BrowserWindow): void {
    this.registry.markRendererReady(window)
    this.flush(window)
  }

  private acceptTarget(target: string): void {
    const now = Date.now()
    const lastAccepted = this.recentlyAccepted.get(target)
    if (lastAccepted !== undefined && now - lastAccepted < DUPLICATE_WINDOW_MS) return
    this.recentlyAccepted.set(target, now)
    for (const [url, acceptedAt] of this.recentlyAccepted) {
      if (now - acceptedAt > DUPLICATE_WINDOW_MS) this.recentlyAccepted.delete(url)
    }

    const window = this.registry.focusedVastWindow()
    if (window && this.registry.isRendererReady(window)) {
      this.deliver(window, target)
      return
    }

    if (this.queue.length >= MAX_QUEUED_URLS) this.queue.shift()
    this.queue.push(target)
    if (!window) this.createWindow()
  }

  private flush(preferredWindow: BrowserWindow): void {
    if (!this.registry.isRendererReady(preferredWindow)) return
    while (this.queue.length > 0) this.deliver(preferredWindow, this.queue.shift()!)
  }

  private deliver(window: BrowserWindow, url: string): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      if (this.queue.length >= MAX_QUEUED_URLS) this.queue.shift()
      this.queue.push(url)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const request: BrowserTabOpenRequest = {
      url,
      disposition: 'external',
      activate: true
    }
    window.webContents.send('vast:browser:open-tab', request)
  }
}
