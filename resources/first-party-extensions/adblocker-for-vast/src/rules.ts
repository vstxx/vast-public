import { parseFilters, type Resources, type CosmeticFilter } from '@ghostery/adblocker'
export const engineConfig = { loadPreprocessors: true, loadExtendedSelectors: true, enableHtmlFiltering: false, integrityCheck: true }

/** Explicitly report platform omissions in addition to upstream parse failures. */
function safeCosmetic(rule: CosmeticFilter): boolean {
  if (rule.isScriptInject()) return true
  // CSS cannot become a publisher-controlled network client or escape its rule.
  if (rule.isExtended() ? /\0/.test(rule.getSelector()) : /[{}\0@]/.test(rule.getSelector())) return false
  return rule.getStyle().split(';').every((part) => !part.trim() ||
    /^(?:display|visibility|opacity|height|max-height|min-height|width|max-width|min-width|overflow(?:-x|-y)?|margin(?:-top|-right|-bottom|-left)?|padding(?:-top|-right|-bottom|-left)?|position|top|left|right|bottom|z-index|color|background-color)\s*:\s*[-#a-z0-9.%\s]+(?:!\s*important)?\s*$/i.test(part.trim()))
}
export function scriptletResource(rule: CosmeticFilter, resources: Resources) {
  const parsed = rule.parseScript()
  if (!parsed || !/^[a-zA-Z0-9_.-]+$/.test(parsed.name) || parsed.name.endsWith('.fn') || parsed.args.length > 32) return
  const canonical = resources.getScriptletCanonicalName(parsed.name)
  return resources.scriptlets.find(entry => entry.name === canonical)
}
// Ghostery owns parsing, aliases and exceptions. Its 2.18 template assembler
// repeats dependencies per rule and interpolates arguments inside JS literals.
// Share pinned dependencies and pass JSON data, without parsing another language.
export function assembleScriptlets(rules: CosmeticFilter[], resources: Resources): string | undefined {
  const dependencies = new Map<string, string>(), functions = new Map<string, number>(), bodies: string[] = [], calls: string[] = []
  const include = (name: string) => {
    if (dependencies.has(name)) return
    const entry = resources.scriptlets.find(item => item.name === name)
    if (!entry) throw new Error('Missing pinned scriptlet dependency.')
    dependencies.set(name, entry.body)
    entry.dependencies.forEach(include)
  }
  for (const rule of rules) {
    const resource = scriptletResource(rule, resources)
    if (!resource) continue
    resource.dependencies.forEach(include)
    if (!functions.has(resource.name)) { functions.set(resource.name, bodies.length); bodies.push(resource.body) }
    calls.push(`try{s${functions.get(resource.name)}(...${JSON.stringify(rule.parseScript()!.args)})}catch{}`)
  }
  if (!calls.length) return
  return `(function(){const scriptletGlobals={};\n${[...dependencies.values()].join('\n')}\n${bodies.map((body, i) => `const s${i}=${body};`).join('\n')}\n${calls.join('\n')}\n})()`
}
export function parseSupported(text: string, resources: Resources, trustedResources?: Resources) {
  // Parse HTML syntax only to report it; neither resulting engine enables it.
  const parsed = parseFilters(text, { ...engineConfig, enableHtmlFiltering: true })
  const trustedCosmeticFilters: CosmeticFilter[] = []
  const supportedCosmetic = (rule: CosmeticFilter): boolean => {
    if (!safeCosmetic(rule) || rule.isHtmlFiltering()) return false
    if (!rule.isScriptInject()) return !rule.isExtended() || rule.getASTComponents() !== undefined
    if (rule.isUnhide() && !rule.getSelector()) return true
    if (scriptletResource(rule, resources)) return true
    if (trustedResources && scriptletResource(rule, trustedResources)?.requiresTrust === true) {
      trustedCosmeticFilters.push(rule); return true
    }
    return false
  }
  const supportedNetwork = (rule: (typeof parsed.networkFilters)[number]): boolean => !rule.isHtmlFilteringRule() &&
    !(rule.isCSP() && /(?:^|[;,\s])report-(?:uri|to)\b/i.test(rule.optionValue ?? ''))
  const cosmetics = parsed.cosmeticFilters.filter(supportedCosmetic)
  const unsupported = parsed.notSupportedFilters.length + parsed.cosmeticFilters.length - cosmetics.length + parsed.networkFilters.filter((rule) => !supportedNetwork(rule)).length
  return { ...parsed, cosmeticFilters: cosmetics.filter(rule => !trustedCosmeticFilters.includes(rule)), trustedCosmeticFilters, networkFilters: parsed.networkFilters.filter(supportedNetwork), unsupported }
}

