import { FiltersEngine, Resources, Request } from '@ghostery/adblocker'
import { engineConfig, parseSupported, assembleScriptlets } from './rules.ts'
import { LISTS, validateSettings, type Settings } from './settings.ts'
import type { CachedList } from './cache.ts'

export interface EngineCache {
  fingerprint: string; bytes: Uint8Array; trustedBytes?: Uint8Array
  report: Record<string, { rules: number; unsupported: number }>
  initializationMs: number; cacheHit: boolean; trustedError?: string
}
const environment = () => new Map([['env_chromium', true], ['ext_ghostery', true], ['cap_html_filtering', false], ['cap_user_stylesheet', false]])
const merge = (engines: FiltersEngine[]) => engines.length === 1 ? engines[0] : FiltersEngine.merge(engines)
export async function initialize(input: { settings: Settings; lists: Record<string, CachedList>; resources: { safe: string; trusted: string }; cached?: EngineCache }) {
  const started = performance.now(), settings = validateSettings(input.settings)
  const selected = LISTS.filter(list => settings.lists.includes(list.id) && (list.category !== 'ads' || settings.blockAds) && (list.category !== 'trackers' || settings.blockTrackers))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    '2.18.2-vext-1.1.0-domain-1', input.resources, settings.customFilters,
    selected.map(list => [list.id, list.trusted, input.lists[list.id].text])
  ])))
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const safeResources = Resources.parse(input.resources.safe, { checksum: fingerprint })
  if (safeResources.scriptlets.some(entry => entry.requiresTrust)) throw new Error('Invalid safe resource bundle.')
  let engine: FiltersEngine | undefined, trusted: FiltersEngine | undefined, trustedError: string | undefined
  let trustedResources: Resources | undefined
  try { trustedResources = Resources.parse(input.resources.trusted, { checksum: fingerprint }) }
  catch { trustedError = 'Advanced resources could not load. Network blocking remains active.' }
  let report: EngineCache['report'] = {}, cacheHit = false
  const cached = input.cached
  if (cached?.fingerprint === fingerprint && cached.bytes instanceof Uint8Array && cached.bytes.length < 48 * 1024 * 1024) {
    try {
      if (!trustedResources) throw new Error('Trusted resources unavailable')
      engine = FiltersEngine.deserialize(cached.bytes)
      if (cached.trustedBytes instanceof Uint8Array && cached.trustedBytes.length < 8 * 1024 * 1024) trusted = FiltersEngine.deserialize(cached.trustedBytes)
      else throw new Error('Missing trusted domain cache')
      report = cached.report; cacheHit = true
    } catch { engine = undefined; trusted = undefined }
  }
  if (!engine) {
    const parsed = selected.map(list => {
      const fragment = parseSupported(input.lists[list.id].text, safeResources, list.trusted ? trustedResources : undefined)
      const rules = fragment.networkFilters.length + fragment.cosmeticFilters.length + fragment.trustedCosmeticFilters.length
      if (rules < 10) throw new Error(`Too few usable rules in ${list.name}.`)
      report[list.id] = { rules, unsupported: fragment.unsupported }
      return fragment
    })
    // Custom/imported text NEVER receives the trusted library or a source ID.
    const custom = parseSupported(settings.customFilters, safeResources)
    if (custom.unsupported) throw new Error(`${custom.unsupported} custom rules are invalid, unavailable or forbidden (trusted rules and HTML rewriting are not allowed). No changes were saved.`)
    parsed.push(custom)
    const fragments = parsed.map(fragment => new FiltersEngine({ ...fragment, config: engineConfig }))
    engine = merge(fragments)
    engine.updateResources(input.resources.safe, fingerprint)
    engine.updateEnv(environment())
    try {
      if (!trustedResources) throw new Error('Trusted resources unavailable')
      // Keep the upstream preprocessors with their source filters. Safe unhides
      // and network exceptions also constrain this domain; trusted hides do not
      // enter the ordinary engine or affect its network matching.
      trusted = merge(parsed.map(fragment => new FiltersEngine({
        ...fragment, config: engineConfig,
        networkFilters: fragment.networkFilters.filter(rule => rule.isException()),
        cosmeticFilters: [...fragment.trustedCosmeticFilters, ...fragment.cosmeticFilters.filter(rule => rule.isUnhide())]
      })))
      trusted.updateResources(input.resources.trusted, fingerprint)
      trusted.updateEnv(environment())
    } catch { trusted = undefined; trustedError = 'Some advanced rules could not load. Network blocking remains active.' }
  }
  const cache: EngineCache = { fingerprint, bytes: engine.serialize(), trustedBytes: trusted?.serialize(), report, trustedError, initializationMs: performance.now() - started, cacheHit }
  return { engine, trusted, safeResources, trustedResources, cache }
}
export type Engines = Awaited<ReturnType<typeof initialize>>
export function documentRules(state: Engines, url: string): string[] {
  const request = Request.fromRawDetails({ url, type: 'main_frame' })
  const scripts = new Set<string>()
  for (const [engine, resources] of [[state.engine, state.safeResources], [state.trusted, state.trustedResources]] as const) {
    if (!engine || !resources) continue
    const result = engine.matchCosmeticFilters({ url, hostname: request.hostname, domain: request.domain, getInjectionRules: true, getExtendedRules: false, getRulesFromDOM: false, getRulesFromHostname: true })
    const filters = result.matches.flatMap(({ filter, exception }) => filter?.isScriptInject() && !exception ? [filter] : [])
    const script = assembleScriptlets(filters, resources)
    if (script) scripts.add(script)
  }
  if (scripts.size > 128 || [...scripts].reduce((sum, script) => sum + script.length, 0) > 512 * 1024) throw new Error('Too many advanced rules for this document.')
  return [...scripts]
}
