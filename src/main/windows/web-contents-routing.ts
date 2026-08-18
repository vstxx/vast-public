export interface ChromeWebContentsLike {
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
}

export interface OpenerWebContentsLike {
  isDestroyed: () => boolean
  hostWebContents?: ChromeWebContentsLike
}

export function chromeWebContentsFor<T extends ChromeWebContentsLike>(
  opener: OpenerWebContentsLike,
  ownerFallback: () => T | undefined
): ChromeWebContentsLike | T | undefined {
  const host = opener.hostWebContents
  if (host && !host.isDestroyed()) return host

  const fallback = ownerFallback()
  return fallback && !fallback.isDestroyed() ? fallback : undefined
}

export function sendBrowserTabOpenRequest(
  opener: OpenerWebContentsLike,
  request: unknown,
  ownerFallback: () => ChromeWebContentsLike | undefined
): boolean {
  const receiver = chromeWebContentsFor(opener, ownerFallback)
  if (!receiver) return false
  receiver.send('vast:browser:open-tab', request)
  return true
}
