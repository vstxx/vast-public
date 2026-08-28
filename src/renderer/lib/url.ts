import {
  BLOCKED_INTERNAL_PROTOCOLS,
  INTERNAL_AVIDAE_URL,
  INTERNAL_AUTOMATION_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_EXTENSIONS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_PDF_VIEWER_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  INTERNAL_SITE_DATA_URL,
  SEARCH_ENGINES
} from '../../shared/constants'
import type { SearchEngine } from '../../shared/types'

const DOMAIN_LIKE = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i
const LOCALHOST_LIKE = /^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i
const INTERNAL_URLS = new Set([
  INTERNAL_NEW_TAB_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_AUTOMATION_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PDF_VIEWER_URL,
  INTERNAL_SITE_DATA_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  INTERNAL_EXTENSIONS_URL
])

function internalUrlBase(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'vast:') return url
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

export function matchesInternalUrl(url: string, internalUrl: string): boolean {
  return internalUrlBase(url) === internalUrl
}

export function getSearchEngine(id: string): SearchEngine {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES[0]
}

export function isInternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'vast:'
  } catch {
    return false
  }
}

export function isKnownInternalUrl(url: string): boolean {
  return INTERNAL_URLS.has(internalUrlBase(url))
}

export function looksLikePdfUrl(url: string): boolean {
  if (!isSafeLoadUrl(url)) return false
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
    return /\.pdf($|[?#&])/.test(haystack)
  } catch {
    return false
  }
}

export function createPdfViewerUrl(
  sourceUrl: string,
  options: {
    returnTo?: string
    reloadKey?: string
  } = {}
): string {
  const viewerUrl = new URL(INTERNAL_PDF_VIEWER_URL)
  viewerUrl.searchParams.set('src', sourceUrl)
  if (options.returnTo && (isInternalUrl(options.returnTo) || isSafeLoadUrl(options.returnTo))) {
    viewerUrl.searchParams.set('return', options.returnTo)
  }
  if (options.reloadKey) {
    viewerUrl.searchParams.set('r', options.reloadKey)
  }
  return viewerUrl.toString()
}

export function isPdfViewerUrl(url: string): boolean {
  return matchesInternalUrl(url, INTERNAL_PDF_VIEWER_URL)
}

export function getPdfViewerSource(url: string): string | undefined {
  if (!isPdfViewerUrl(url)) return undefined
  try {
    const parsed = new URL(url)
    const sourceUrl = parsed.searchParams.get('src')?.trim()
    return sourceUrl && isSafeLoadUrl(sourceUrl) ? sourceUrl : undefined
  } catch {
    return undefined
  }
}

export function getPdfViewerReturnTo(url: string): string | undefined {
  if (!isPdfViewerUrl(url)) return undefined
  try {
    const parsed = new URL(url)
    const returnUrl = parsed.searchParams.get('return')?.trim()
    return returnUrl && (isInternalUrl(returnUrl) || isSafeLoadUrl(returnUrl)) ? returnUrl : undefined
  } catch {
    return undefined
  }
}

export function getEffectiveTabUrl(url: string): string {
  return getPdfViewerSource(url) ?? url
}

export function isSafeLoadUrl(url: string): boolean {
  if (isInternalUrl(url)) return true
  try {
    const parsed = new URL(url)
    if (BLOCKED_INTERNAL_PROTOCOLS.includes(parsed.protocol)) return false
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function resolveAddressInput(input: string, searchEngineId: string): string {
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()
  if (!trimmed) return INTERNAL_NEW_TAB_URL
  if (lower === INTERNAL_NEW_TAB_URL || lower === 'new tab') return INTERNAL_NEW_TAB_URL
  if (lower === INTERNAL_AVIDAE_URL || lower === 'avidae' || lower === 'video & audio' || lower === 'video and audio' || lower === 'video audio') return INTERNAL_AVIDAE_URL
  if (lower === INTERNAL_PASSWORDS_URL || lower === 'passwords' || lower === 'password manager') return INTERNAL_PASSWORDS_URL
  if (lower === INTERNAL_AUTOMATION_URL || lower === 'automation' || lower === 'macros') return INTERNAL_AUTOMATION_URL
  if (lower === INTERNAL_NOTES_URL || lower === 'notes') return INTERNAL_NOTES_URL
  if (lower === INTERNAL_NETWORK_URL || lower === 'network' || lower === 'network devices') return INTERNAL_NETWORK_URL
  if (lower === INTERNAL_SITE_DATA_URL || lower === 'site data' || lower === 'sitedata') return INTERNAL_SITE_DATA_URL
  if (lower === INTERNAL_DIAGNOSTICS_URL || lower === 'diagnostics' || lower === 'debug') return INTERNAL_DIAGNOSTICS_URL
  if (lower === INTERNAL_SESSION_TIMELINE_URL || lower === 'session timeline' || lower === 'timeline' || lower === 'sessions') return INTERNAL_SESSION_TIMELINE_URL
  if (lower === INTERNAL_EXTENSIONS_URL || lower === 'extensions' || lower === 'extension manager') return INTERNAL_EXTENSIONS_URL

  const shortcutMatch = trimmed.match(/^([a-z]{1,3})\s+(.+)$/i)
  if (shortcutMatch) {
    const engine = SEARCH_ENGINES.find((item) => item.shortcut === shortcutMatch[1].toLowerCase())
    if (engine) return engine.searchUrl.replace('%s', encodeURIComponent(shortcutMatch[2].trim()))
  }

  try {
    const parsed = new URL(trimmed)
    if (isSafeLoadUrl(parsed.toString())) return parsed.toString()
  } catch {
    // Fall through to domain or search handling.
  }

  if (DOMAIN_LIKE.test(trimmed) || LOCALHOST_LIKE.test(trimmed)) {
    return `https://${trimmed}`
  }

  const engine = getSearchEngine(searchEngineId)
  return engine.searchUrl.replace('%s', encodeURIComponent(trimmed))
}

export function displayUrl(url: string): string {
  if (matchesInternalUrl(url, INTERNAL_NEW_TAB_URL)) return 'New tab'
  if (matchesInternalUrl(url, INTERNAL_AVIDAE_URL)) return 'Video & Audio'
  if (matchesInternalUrl(url, INTERNAL_PASSWORDS_URL)) return 'Passwords'
  if (matchesInternalUrl(url, INTERNAL_AUTOMATION_URL)) return 'Automation'
  if (matchesInternalUrl(url, INTERNAL_NOTES_URL)) return 'Notes'
  if (matchesInternalUrl(url, INTERNAL_NETWORK_URL)) return 'Network'
  if (matchesInternalUrl(url, INTERNAL_PDF_VIEWER_URL)) {
    const sourceUrl = getPdfViewerSource(url)
    return sourceUrl ? displayUrl(sourceUrl) : 'PDF Viewer'
  }
  if (matchesInternalUrl(url, INTERNAL_SITE_DATA_URL)) return 'Site Data'
  if (matchesInternalUrl(url, INTERNAL_DIAGNOSTICS_URL)) return 'Diagnostics'
  if (matchesInternalUrl(url, INTERNAL_SESSION_TIMELINE_URL)) return 'Session Timeline'
  if (matchesInternalUrl(url, INTERNAL_EXTENSIONS_URL)) return 'Extensions'
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

export function hostnameFor(url: string): string {
  try {
    return new URL(getEffectiveTabUrl(url)).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function webOriginFor(url: string): { origin: string; hostname: string } | undefined {
  try {
    const parsed = new URL(getEffectiveTabUrl(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return {
      origin: parsed.origin,
      hostname: parsed.hostname.replace(/^www\./, '')
    }
  } catch {
    return undefined
  }
}

export function isSecureUrl(url: string): boolean {
  if (isInternalUrl(url)) return true
  try {
    return new URL(getEffectiveTabUrl(url)).protocol === 'https:'
  } catch {
    return false
  }
}

export function titleFromUrl(url: string): string {
  if (matchesInternalUrl(url, INTERNAL_NEW_TAB_URL)) return 'New tab'
  if (matchesInternalUrl(url, INTERNAL_AVIDAE_URL)) return 'Video & Audio'
  if (matchesInternalUrl(url, INTERNAL_PASSWORDS_URL)) return 'Passwords'
  if (matchesInternalUrl(url, INTERNAL_AUTOMATION_URL)) return 'Automation'
  if (matchesInternalUrl(url, INTERNAL_NOTES_URL)) return 'Notes'
  if (matchesInternalUrl(url, INTERNAL_NETWORK_URL)) return 'Network'
  if (matchesInternalUrl(url, INTERNAL_PDF_VIEWER_URL)) {
    const sourceUrl = getPdfViewerSource(url)
    return sourceUrl ? titleFromUrl(sourceUrl) : 'PDF Viewer'
  }
  if (matchesInternalUrl(url, INTERNAL_SITE_DATA_URL)) return 'Diagnostics'
  if (matchesInternalUrl(url, INTERNAL_DIAGNOSTICS_URL)) return 'Diagnostics'
  if (matchesInternalUrl(url, INTERNAL_SESSION_TIMELINE_URL)) return 'Session Timeline'
  if (matchesInternalUrl(url, INTERNAL_EXTENSIONS_URL)) return 'Extensions'
  const host = hostnameFor(url)
  return host || url
}

export function isLikelySearch(input: string): boolean {
  const trimmed = input.trim()
  return Boolean(trimmed) && !DOMAIN_LIKE.test(trimmed) && !LOCALHOST_LIKE.test(trimmed) && !trimmed.includes('://')
}

export function searchShortcutHint(input: string): SearchEngine | undefined {
  const shortcut = input.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (!shortcut) return undefined
  return SEARCH_ENGINES.find((engine) => engine.shortcut === shortcut)
}
