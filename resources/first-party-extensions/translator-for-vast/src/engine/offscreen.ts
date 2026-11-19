// The offscreen document hosts the engine: a service worker cannot own a Web Worker across events.
// It accepts requests from this extension's service worker only. Content scripts can reach every
// extension page with runtime.sendMessage, so a message from anything else is ignored here.

import { SCOPE, errorMessage, isEngineRequest, type EngineEvent, type EngineRequest, type Reply } from '../shared/protocol.ts'
import { EngineError, EngineHost } from './engine-host.ts'

const serviceWorkerUrl = chrome.runtime.getURL('background.js')

function broadcast(event: EngineEvent): void {
  chrome.runtime.sendMessage(event).catch(() => undefined)
}

const host = new EngineHost((progress) => broadcast({ scope: SCOPE, type: 'engine:progress', progress }))
host.onPhase = (phase) => broadcast({ scope: SCOPE, type: 'engine:phase', phase })
// Released means no worker, no queue and no download: the document has nothing left to hold, and
// closing it returns its memory. The service worker recreates it on the next request.
host.onRelease = () => window.close()

async function handle(request: EngineRequest): Promise<unknown> {
  switch (request.type) {
    case 'engine:translate':
      return host.translate(request.source, request.target, request.fragments, request.priority, request.tag)
    case 'engine:cancel':
      return { cancelled: host.cancel(request.tag) }
    case 'engine:route':
      return host.run(() => host.routeStatus(request.source, request.target))
    case 'engine:download':
      return host.run(() => host.download(request.source, request.target))
    case 'engine:cancel-download':
      return { cancelled: host.store.cancel(request.pairKey) }
    case 'engine:models':
      return host.run(async () => {
        const catalog = await host.catalog()
        return { installed: await host.store.listInstalled(catalog.pairs), downloads: host.store.downloadState(), usage: await host.store.usage() }
      })
    case 'engine:delete-model':
      return host.run(async () => {
        await host.unloadPair(request.pairKey)
        const catalog = await host.catalog()
        return { deleted: await host.store.deletePair(request.pairKey, catalog.pairs[request.pairKey]) }
      })
    case 'engine:delete-all-models':
      return host.run(async () => {
        host.release(false)
        await host.store.deleteAll()
        return { deleted: true }
      })
    case 'engine:status':
      return host.status()
    case 'engine:configure':
      host.configure(request.idleMs)
      return { idleMs: request.idleMs }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply<unknown>) => void) => {
  if (!isEngineRequest(message)) return false
  if (sender.id !== chrome.runtime.id || sender.url !== serviceWorkerUrl) return false
  handle(message).then(
    (value) => sendResponse({ ok: true, value }),
    (error: unknown) => sendResponse({ ok: false, error: errorMessage(error), ...(error instanceof EngineError || (error instanceof Error && 'code' in error) ? { code: String((error as { code: unknown }).code) } : {}) })
  )
  return true
})

// For performance probes and manual debugging from the document's devtools.
;(globalThis as { translatorEngine?: EngineHost }).translatorEngine = host
