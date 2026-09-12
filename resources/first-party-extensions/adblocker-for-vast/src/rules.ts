import { parseFilters, type Resources, type CosmeticFilter } from '@ghostery/adblocker'
const config = { loadPreprocessors: true, loadExtendedSelectors: true, enableHtmlFiltering: true, integrityCheck: true }

/** Explicitly report platform omissions in addition to upstream parse failures. */
const nativePseudos = new Set('has not is where nth-child nth-last-child nth-of-type nth-last-of-type first-child last-child only-child first-of-type last-of-type only-of-type empty root checked disabled enabled link visited any-link hover active focus focus-within focus-visible before after'.split(' '))
function nativeCss(rule: CosmeticFilter): boolean {
  return !rule.isExtended() || [...rule.getSelector().matchAll(/:([a-z-]+)/gi)].every((match) => nativePseudos.has(match[1].toLowerCase()))
}
function safeCosmetic(rule: CosmeticFilter): boolean {
  if (rule.isScriptInject()) return true
  // CSS cannot become a publisher-controlled network client or escape its rule.
  if (/[{}\0@]/.test(rule.getSelector())) return false
  return rule.getStyle().split(';').every((part) => !part.trim() ||
    /^(?:display|visibility|opacity|height|max-height|min-height|width|max-width|min-width|overflow(?:-x|-y)?|margin(?:-top|-right|-bottom|-left)?|padding(?:-top|-right|-bottom|-left)?|position|top|left|right|bottom|z-index|color|background-color)\s*:\s*[-#a-z0-9.%\s]+(?:!\s*important)?\s*$/i.test(part.trim()))
}
export function parseSupported(text: string, resources: Resources) {
  const parsed = parseFilters(text, config)
  const supportedCosmetic = (rule: CosmeticFilter): boolean => nativeCss(rule) && safeCosmetic(rule) && !rule.isHtmlFiltering() &&
    !rule.isScriptInject()
  const supportedNetwork = (rule: (typeof parsed.networkFilters)[number]): boolean => !rule.isHtmlFilteringRule() &&
    !(rule.isCSP() && /(?:^|[;,\s])report-(?:uri|to)\b/i.test(rule.optionValue ?? ''))
  const unsupported = parsed.notSupportedFilters.length + parsed.cosmeticFilters.filter((rule) => !supportedCosmetic(rule)).length + parsed.networkFilters.filter((rule) => !supportedNetwork(rule)).length
  // Procedural cosmetics and response-body rewriting require a different renderer/body pipeline.
  return { ...parsed, cosmeticFilters: parsed.cosmeticFilters.filter(supportedCosmetic), networkFilters: parsed.networkFilters.filter(supportedNetwork), unsupported }
}

