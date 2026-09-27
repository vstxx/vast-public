import { INTERNAL_NEW_TAB_URL, INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL } from './constants.ts'

const BLOCKED_TOP_LEVEL_HOSTS = new Set(['chromewebstore.google.com'])

export function isChromeWebStoreUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    if (BLOCKED_TOP_LEVEL_HOSTS.has(hostname)) return true
    return hostname === 'chrome.google.com' && (url.pathname === '/webstore' || url.pathname.startsWith('/webstore/'))
  } catch {
    return false
  }
}

export function blockedTopLevelNavigationReplacement(rawUrl: string): string | undefined {
  return isChromeWebStoreUrl(rawUrl) ? INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL : undefined
}

export function isAllowedChromeExtensionSubframeRedirect(rawUrl: string, isMainFrame: boolean): boolean {
  if (isMainFrame) return false
  try {
    return new URL(rawUrl).protocol === 'chrome-extension:'
  } catch {
    return false
  }
}

export function routeTopLevelNavigationUrl(rawUrl: string): string {
  return blockedTopLevelNavigationReplacement(rawUrl) ?? rawUrl
}

export function sanitizeRestoredTopLevelUrl(rawUrl: string): string {
  const routed = routeTopLevelNavigationUrl(rawUrl)
  if (routed.startsWith('vast://')) return routed
  try {
    const protocol = new URL(routed).protocol
    return protocol === 'http:' || protocol === 'https:' ? routed : INTERNAL_NEW_TAB_URL
  } catch {
    return INTERNAL_NEW_TAB_URL
  }
}
