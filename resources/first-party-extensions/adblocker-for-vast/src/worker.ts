import { Request } from '@ghostery/adblocker'
import { initialize, documentRules, type Engines } from './engine.ts'
let state: Engines | undefined
const documents = new Map<string, { scripts: string[]; expires: number }>()
self.onmessage = async ({ data }) => {
  try {
    let result: unknown
    if (data.type === 'init') { state = await initialize(data.input); documents.clear(); result = state.cache }
    else if (!state) throw new Error('Filters are loading.')
    else if (data.type === 'match') {
      if (data.input.type === 'mainFrame') result = {}
      else { const matched = state.engine.match(Request.fromRawDetails(data.input)); result = matched.redirect ? { redirectURL: matched.redirect.dataUrl } : matched.match ? { cancel: true } : matched.rewrite ? { redirectURL: matched.rewrite.url } : {} }
    } else if (data.type === 'headers') result = { csp: state.engine.getCSPDirectives(Request.fromRawDetails(data.input)) }
    else if (data.type === 'document') {
      const url = data.input.url, cached = documents.get(url)
      if (cached && cached.expires > Date.now()) result = { scripts: cached.scripts }
      else {
        const scripts = documentRules(state, url)
        if (documents.size >= 64) documents.delete(documents.keys().next().value!)
        documents.set(url, { scripts, expires: Date.now() + 60_000 }); result = { scripts }
      }
    }
    else if (data.type === 'cosmetics') {
      const input = data.input, request = Request.fromRawDetails({ url: input.url, type: 'main_frame' })
      result = state.engine.getCosmeticsFilters({ ...input, hostname: request.hostname, domain: request.domain, getBaseRules: input.initial, getRulesFromHostname: input.initial, getInjectionRules: false, getExtendedRules: input.advanced === true, getRulesFromDOM: true })
    } else throw new Error('Unknown engine operation.')
    self.postMessage({ id: data.id, result })
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Filtering failed.' }) }
}
