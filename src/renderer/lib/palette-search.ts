// Ranking engine for the command palette. Items are prepared once (normalized
// fields, word starts, initials, URL host/path) and every query token must
// match some field. Scores come from match quality per field, so a URL or a
// section name can never outrank a real title match, and loose subsequence
// matching is only tried against titles.

export type PaletteScope = 'tabs' | 'history' | 'bookmarks' | 'notes' | 'commands'

export interface PaletteSearchInput {
  title: string
  subtitle?: string
  url?: string
  keywords?: readonly string[]
}

export interface PreparedPaletteItem {
  title: string
  titleWords: string[]
  initials: string
  keywords: string[]
  host: string
  path: string
  subtitle: string
}

export interface ParsedPaletteQuery {
  scope?: PaletteScope
  text: string
  tokens: string[]
}

const SCOPE_PREFIXES: ReadonlyArray<[string, PaletteScope]> = [
  ['@tabs', 'tabs'],
  ['@tab', 'tabs'],
  ['@history', 'history'],
  ['@bookmarks', 'bookmarks'],
  ['@bookmark', 'bookmarks'],
  ['@notes', 'notes'],
  ['@note', 'notes']
]

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
}

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function splitUrl(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: '', path: '' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { host: normalizeSearchText(parsed.hostname.replace(/^www\./, '')), path: normalizeSearchText(`${parsed.pathname}${parsed.search}`) }
    }
    return { host: normalizeSearchText(`${parsed.protocol}//${parsed.host}`), path: normalizeSearchText(parsed.pathname) }
  } catch {
    return { host: '', path: normalizeSearchText(url) }
  }
}

export function preparePaletteItem(item: PaletteSearchInput): PreparedPaletteItem {
  const title = normalizeSearchText(item.title)
  const titleWords = words(title)
  const { host, path } = splitUrl(item.url)
  return {
    title,
    titleWords,
    initials: titleWords.map((word) => word[0]).join(''),
    keywords: (item.keywords ?? []).flatMap((keyword) => words(normalizeSearchText(keyword))),
    host,
    path,
    subtitle: normalizeSearchText(item.subtitle ?? '')
  }
}

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  let text = raw.trim()
  let scope: PaletteScope | undefined
  if (text.startsWith('>')) {
    scope = 'commands'
    text = text.slice(1).trim()
  } else {
    const lower = text.toLowerCase()
    for (const [prefix, value] of SCOPE_PREFIXES) {
      if (lower === prefix || lower.startsWith(`${prefix} `)) {
        scope = value
        text = text.slice(prefix.length).trim()
        break
      }
    }
  }
  return { scope, text, tokens: normalizeSearchText(text).split(/\s+/).filter(Boolean) }
}

// Ordered subsequence match with a penalty for gaps; only used on titles and
// only for tokens of three or more characters.
function subsequenceScore(source: string, token: string): number {
  if (token.length < 3) return 0
  let cursor = 0
  let gaps = 0
  for (const char of token) {
    const index = source.indexOf(char, cursor)
    if (index < 0) return 0
    if (index > cursor && cursor > 0) gaps += index - cursor
    cursor = index + 1
  }
  const score = 30 - gaps * 2
  return score >= 8 ? score : 0
}

function tokenScore(item: PreparedPaletteItem, token: string): number {
  let best = 0
  const take = (value: number): void => {
    if (value > best) best = value
  }
  if (item.title.startsWith(token)) take(100)
  else if (item.titleWords.some((word) => word.startsWith(token))) take(80)
  else if (item.title.includes(token)) take(50)
  if (token.length >= 2 && item.initials.startsWith(token)) take(70)
  if (item.keywords.some((word) => word.startsWith(token))) take(45)
  else if (item.keywords.some((word) => word.includes(token))) take(30)
  if (item.host) {
    if (item.host.startsWith(token)) take(55)
    else if (item.host.includes(token)) take(35)
  }
  if (token.length >= 2 && item.path.includes(token)) take(20)
  if (best === 0 && item.subtitle) {
    if (words(item.subtitle).some((word) => word.startsWith(token))) take(25)
    else if (token.length >= 3 && item.subtitle.includes(token)) take(15)
  }
  if (best === 0) take(subsequenceScore(item.title, token))
  return best
}

/** Returns 0 when any query token fails to match. */
export function scorePaletteItem(item: PreparedPaletteItem, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1
  let total = 0
  for (const token of tokens) {
    const score = tokenScore(item, token)
    if (score === 0) return 0
    total += score
  }
  const phrase = tokens.join(' ')
  if (item.title === phrase) total += 200
  else if (tokens.length > 1 && item.title.startsWith(phrase)) total += 60
  return total
}

const KNOWN_SCHEMES = /^(https?|vast|file|about|chrome-extension):/i

/** True for input the browser should open directly instead of searching. */
export function looksLikeUrl(text: string): boolean {
  const value = text.trim()
  if (!value || /\s/.test(value)) return false
  if (KNOWN_SCHEMES.test(value)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(value)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value)) return true
  return /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(:\d+)?(\/\S*)?$/u.test(value)
}

/** Canonical key used to collapse the same page across tabs, bookmarks and history. */
export function paletteUrlKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    const href = parsed.href
    return href.endsWith('/') && parsed.pathname === '/' && !parsed.search ? href.slice(0, -1) : href
  } catch {
    return url
  }
}
