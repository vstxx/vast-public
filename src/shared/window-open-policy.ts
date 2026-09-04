import type { AdBlockerMode } from './types'
import { isIdentityProviderPopupUrl, isOAuthLikeFirstPartyAuthUrl } from './auth-compatibility-policy.ts'

export interface WebviewPopupRequest {
  url: string
  disposition?: string
  frameName?: string
  features?: string
  adBlockerEnabled?: boolean
  adBlockerMode?: AdBlockerMode
}

export type WebviewWindowOpenRoute = 'popup-window' | 'vast-tab' | 'deny'

const BLOCKED_POPUP_PROTOCOLS = ['javascript:', 'file:', 'data:', 'blob:', 'chrome:', 'devtools:']

function protocolOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).protocol
  } catch {
    return null
  }
}

function isSafeHttpUrl(rawUrl: string): boolean {
  const protocol = protocolOf(rawUrl)
  if (!protocol) return false
  if (BLOCKED_POPUP_PROTOCOLS.includes(protocol)) return false
  return protocol === 'http:' || protocol === 'https:'
}

function isBlankPopupUrl(rawUrl: string): boolean {
  return rawUrl === 'about:blank'
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function isPaymentPopupUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    if (hostMatches(host, 'stripe.com') || hostMatches(host, 'paypal.com') || hostMatches(host, 'braintreegateway.com')) return true
    if (hostMatches(host, 'adyen.com') || hostMatches(host, 'klarna.com') || hostMatches(host, 'checkout.com')) return true
    return /\/(checkout|payment|payments|pay|billing)(?:\/|$)/.test(path)
  } catch {
    return false
  }
}

function requestsPopupGeometry(features: string | undefined): boolean {
  if (!features) return false
  return /(?:^|,)\s*(?:width|height|left|top|screenx|screeny)\s*=\s*\d+/i.test(features)
}

const NON_WINDOW_FRAME_NAMES = new Set(['', '_blank', '_self', '_parent', '_top'])

/**
 * A named target (window.open(url, 'name')) opts into named browsing-context
 * semantics: Chromium reuses an existing window of that name and keeps the
 * opener relationship. A Vast tab can provide neither, so these stay real
 * popup windows like in a stock browser.
 */
function isNamedWindowTarget(frameName: string | undefined): boolean {
  return typeof frameName === 'string' && frameName !== '' && !NON_WINDOW_FRAME_NAMES.has(frameName)
}

export function shouldOpenWebviewPopupAsWindow(request: WebviewPopupRequest): boolean {
  return routeWebviewWindowOpen(request) === 'popup-window'
}

export function routeWebviewWindowOpen(request: WebviewPopupRequest): WebviewWindowOpenRoute {
  const { url } = request

  if (isBlankPopupUrl(url)) {
    // A blank window must remain a real window so later location assignment,
    // window.opener, and postMessage keep their native Chromium semantics.
    return 'popup-window'
  }

  if (!isSafeHttpUrl(url)) {
    return 'deny'
  }

  if (
    isNamedWindowTarget(request.frameName) ||
    request.disposition === 'new-window' ||
    isIdentityProviderPopupUrl(url) ||
    isOAuthLikeFirstPartyAuthUrl(url) ||
    isPaymentPopupUrl(url) ||
    requestsPopupGeometry(request.features)
  ) {
    return 'popup-window'
  }

  // Anonymous target=_blank links and window.open(url) calls arrive with a
  // tab disposition. Safe page navigation belongs in the browser's tab model
  // regardless of that implementation detail; referrer and POST metadata for
  // the initial request travel with the Vast tab request.
  return 'vast-tab'
}
