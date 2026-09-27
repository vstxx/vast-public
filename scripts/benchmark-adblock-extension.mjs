import { readFile, writeFile } from 'node:fs/promises'
import { Request } from '@ghostery/adblocker'
import { initialize, documentRules } from '../resources/first-party-extensions/adblocker-for-vast/src/engine.ts'
import { defaults, LISTS } from '../resources/first-party-extensions/adblocker-for-vast/src/settings.ts'
const root = new URL('../resources/first-party-extensions/adblocker-for-vast/assets/', import.meta.url)
const resources = { safe: await readFile(new URL('resources-safe.json', root), 'utf8'), trusted: await readFile(new URL('resources-trusted.json', root), 'utf8') }
const lists = Object.fromEntries(await Promise.all(LISTS.map(async list => [list.id, { text: await readFile(new URL(list.id + '.txt', root), 'utf8'), updatedAt: 0, checkedAt: 0 }])))
const settings = { ...defaults(), customFilters: '||vast-benchmark-blocked.invalid^' }
globalThis.gc?.()
const before = process.memoryUsage()
let state = await initialize({ settings, lists, resources })
globalThis.gc?.()
const after = process.memoryUsage()
const report = { environment: { node: process.version, platform: process.platform, arch: process.arch }, coldInitializationMs: state.cache.initializationMs, memoryDelta: { heapBytes: after.heapUsed - before.heapUsed, rssBytes: after.rss - before.rss }, compiledBytes: state.cache.bytes.length + (state.cache.trustedBytes?.length ?? 0), resourceBytes: Buffer.byteLength(resources.safe) + Buffer.byteLength(resources.trusted), listBytes: LISTS.filter(list=>list.default).reduce((sum,list)=>sum+Buffer.byteLength(lists[list.id].text),0), rules: state.cache.report }
const cached = state.cache
state = await initialize({ settings, lists, resources, cached })
if (!state.cache.cacheHit) throw new Error('Compiled cache did not restore')
report.cachedInitializationMs = state.cache.initializationMs
for (const [name, url, blocked] of [['allowed','https://example.org/article',false], ['blocked','https://vast-benchmark-blocked.invalid/ad.js',true]]) {
  const input = { url, sourceUrl: 'https://example.org/', type: 'script' }
  for(let i=0;i<1000;i++) state.engine.match(Request.fromRawDetails(input))
  const samples=[]
  for(let i=0;i<10000;i++) { const start=performance.now(); const result=state.engine.match(Request.fromRawDetails(input)); samples.push(performance.now()-start); if(result.match!==blocked) throw new Error('Unexpected benchmark decision') }
  samples.sort((a,b)=>a-b)
  report[name+'Request']={ count:samples.length, meanMs:samples.reduce((sum,x)=>sum+x,0)/samples.length,p50Ms:samples[5000],p95Ms:samples[9500] }
}
const start=performance.now(), scripts=documentRules(state,'https://www.youtube.com/watch?v=fixture')
report.youtubeRulePreparation={ms:performance.now()-start, groups:scripts.length, bytes:scripts.reduce((sum,x)=>sum+Buffer.byteLength(x),0)}
report.note='Local engine measurement, including Request construction; not browser-wide RAM or live YouTube acceptance. Memory delta includes compilation allocations retained after GC.'
console.log(JSON.stringify(report,null,2))
if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n')
