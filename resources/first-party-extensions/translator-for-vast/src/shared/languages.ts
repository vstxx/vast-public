// Language tags as the catalog spells them, display names in the interface language, and script
// direction. Names come from the browser's own CLDR data, so no table here goes stale.

const RTL = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb'])

export function isRtlLanguage(code: string): boolean {
  return RTL.has(code.toLowerCase().split(/[-_]/)[0] ?? '')
}

// A BCP 47 tag from a page, the detector or the browser, in the catalog's spelling. Bare primary
// subtags, except Chinese, which the catalog splits by script.
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  const trimmed = tag?.trim()
  if (!trimmed || trimmed.length > 35) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('zh')) {
    const parts = lower.split(/[-_]/)
    return parts.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans'
  }
  if (lower === 'no' || lower === 'nn' || lower.startsWith('nb')) return 'nb'
  if (lower === 'iw') return 'he'
  if (lower === 'in') return 'id'
  if (lower === 'fil') return 'tl'
  const primary = lower.split(/[-_]/)[0]
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : null
}

const nameCache = new Map<string, Intl.DisplayNames | null>()

export function languageName(code: string, uiLanguage: string): string {
  let names = nameCache.get(uiLanguage)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([uiLanguage, 'en'], { type: 'language' })
    } catch {
      names = null
    }
    nameCache.set(uiLanguage, names)
  }
  const name = names?.of(code)
  if (!name || name === code) return code
  // CLDR gives lower-case names in some languages ("polski"); a picker reads better capitalised.
  return name.charAt(0).toLocaleUpperCase(uiLanguage) + name.slice(1)
}

export function sortByName(codes: Iterable<string>, uiLanguage: string): string[] {
  const collator = new Intl.Collator(uiLanguage)
  return [...codes].sort((a, b) => collator.compare(languageName(a, uiLanguage), languageName(b, uiLanguage)))
}
