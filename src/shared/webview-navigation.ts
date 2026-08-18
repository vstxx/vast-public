export interface WebviewNavigationEventLike {
  url?: string
  isMainFrame?: boolean
  detail?: {
    url?: string
    isMainFrame?: boolean
  }
}

export interface WebviewNavigationDetails {
  url?: string
  isMainFrame?: boolean
}

const maxRememberedGuestNavigationUrls = 64

/**
 * Tracks URL state updates that originated inside a guest webview. React can
 * render those updates after the guest has already advanced to a newer SPA
 * route. Consuming the queued URLs prevents that stale render from being
 * mistaken for a fresh address-bar navigation and loaded back into the guest.
 */
export class GuestNavigationUrlQueue {
  private readonly urls: string[] = []

  remember(url: string): void {
    if (!url) return
    this.urls.push(url)
    if (this.urls.length > maxRememberedGuestNavigationUrls) {
      this.urls.splice(0, this.urls.length - maxRememberedGuestNavigationUrls)
    }
  }

  consume(url: string): boolean {
    const index = this.urls.indexOf(url)
    if (index < 0) {
      this.urls.length = 0
      return false
    }
    this.urls.splice(0, index + 1)
    return true
  }

  clear(): void {
    this.urls.length = 0
  }
}

export function getWebviewNavigationDetails(event: WebviewNavigationEventLike): WebviewNavigationDetails {
  return {
    url: event.url ?? event.detail?.url,
    isMainFrame: event.isMainFrame ?? event.detail?.isMainFrame
  }
}

export function shouldAcceptWebviewNavigationEvent(event: WebviewNavigationEventLike, currentWebviewUrl = ''): boolean {
  const details = getWebviewNavigationDetails(event)
  if (details.isMainFrame === false) return false

  // Some Electron webview in-page events from iframes can arrive without an
  // isMainFrame flag. In that case the guest's top-level URL stays unchanged,
  // while the event URL points at the iframe URL.
  if (details.isMainFrame !== true && details.url && currentWebviewUrl && details.url !== currentWebviewUrl) {
    return false
  }

  return true
}

export function webviewNavigationUrl(event: WebviewNavigationEventLike, currentWebviewUrl = ''): string {
  return getWebviewNavigationDetails(event).url || currentWebviewUrl
}
