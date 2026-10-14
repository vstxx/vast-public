/**
 * Parses a CWS listing into an install intent. This module does not authorize
 * navigation, download, installation, or permission grants.
 *
 * Keep this separate from top-level-navigation-policy.ts: production builds
 * using an unverified Electron runtime must continue to block CWS navigation.
 */
export interface ChromeWebStoreListing {
  extensionId: string
  sourceUrl: string
  store: 'chrome-web-store'
}

const CWS_ID = '[a-p]{32}'
const MODERN_DETAIL = new RegExp('^/detail/(?:[^/]+/)?(' + CWS_ID + ')/?$')
const LEGACY_DETAIL = new RegExp('^/webstore/detail/(?:[^/]+/)?(' + CWS_ID + ')/?$')
const MAX_URL_LENGTH = 4_096

export function parseChromeWebStoreListingUrl(rawUrl: string): ChromeWebStoreListing | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) return undefined
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    const match = url.hostname === 'chromewebstore.google.com'
      ? MODERN_DETAIL.exec(url.pathname)
      : url.hostname === 'chrome.google.com'
        ? LEGACY_DETAIL.exec(url.pathname)
        : null
    if (!match) return undefined
    return {
      extensionId: match[1],
      // Strip query parameters and fragments: the installer needs an identity,
      // not tracking tokens or arbitrary metadata supplied by a web page.
      sourceUrl: url.origin + url.pathname,
      store: 'chrome-web-store'
    }
  } catch {
    return undefined
  }
}
