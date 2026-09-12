import { FiltersEngine, Resources, Request } from '@ghostery/adblocker'
import { parseSupported } from './rules.ts'
import { LISTS } from './settings.ts'
let engine: FiltersEngine
self.onmessage = async ({ data }) => {
  try {
    let result: unknown
    if (data.type === 'init') {
      const { settings, lists, resources, cached } = data.input, started = performance.now()
      const selected = LISTS.filter(list => settings.lists.includes(list.id) && (list.category !== 'ads' || settings.blockAds) && (list.category !== 'trackers' || settings.blockTrackers))
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('2.18.2-vext-2' + resources + settings.customFilters + selected.map(list => list.id + lists[list.id].text).join('')))
      const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
      let report: Record<string, { rules: number; unsupported: number }> = {}, cacheHit = false
      if (cached?.fingerprint === fingerprint && cached.bytes instanceof Uint8Array && cached.bytes.length < 48 * 1024 * 1024) {
        try { engine = FiltersEngine.deserialize(cached.bytes); report = cached.report; cacheHit = true } catch { /* Compile bundled/last-good text. */ }
      }
      if (!engine) {
        const library = Resources.parse(resources, { checksum: fingerprint }), config = { loadPreprocessors: true, loadExtendedSelectors: true, enableHtmlFiltering: true, integrityCheck: true }
        const fragments = selected.map(list => { const parsed = parseSupported(lists[list.id].text, library), rules = parsed.networkFilters.length + parsed.cosmeticFilters.length; if (rules < 10) throw new Error('Too few usable list rules.'); report[list.id] = { rules, unsupported: parsed.unsupported }; return new FiltersEngine({ ...parsed, config }) })
        const custom = parseSupported(settings.customFilters, library); if (custom.unsupported) throw new Error(`${custom.unsupported} custom rules are invalid or unsupported. No changes were saved.`)
        fragments.push(new FiltersEngine({ ...custom, config })); engine = fragments.length === 1 ? fragments[0] : FiltersEngine.merge(fragments)
        engine.updateResources(resources, fingerprint); engine.updateEnv(new Map([['env_chromium', true], ['ext_ghostery', true], ['cap_html_filtering', false], ['cap_user_stylesheet', false]]))
      }
      result = { fingerprint, bytes: engine.serialize(), report, initializationMs: performance.now() - started, cacheHit }
    } else if (!engine) throw new Error('Filters are loading.')
    else if (data.type === 'match') {
      if (data.input.type === 'mainFrame') result = {}
      else { const matched = engine.match(Request.fromRawDetails(data.input)); result = matched.redirect ? { redirectURL: matched.redirect.dataUrl } : matched.match ? { cancel: true } : matched.rewrite ? { redirectURL: matched.rewrite.url } : {} }
    } else if (data.type === 'headers') result = { csp: engine.getCSPDirectives(Request.fromRawDetails(data.input)) }
    else if (data.type === 'cosmetics') {
      const input = data.input, request = Request.fromRawDetails({ url: input.url, type: 'main_frame' })
      const options = { ...input, hostname: request.hostname, domain: request.domain, getBaseRules: input.initial, getRulesFromHostname: input.initial, getInjectionRules: input.initial, getExtendedRules: true, getRulesFromDOM: true }
      const matched = engine.getCosmeticsFilters(options), extended = engine.matchCosmeticFilters(options)
      result = { active: matched.active, styles: matched.styles + '\n' + extended.matches.flatMap(({ filter, exception }) => filter && !exception && filter.isExtended() && (extended.allowGenericHides || !filter.isGenericHide()) ? [`${filter.getSelector()}{${filter.getStyle()}}`] : []).join('\n') }
    } else throw new Error('Unknown engine operation.')
    self.postMessage({ id: data.id, result })
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Filtering failed.' }) }
}
