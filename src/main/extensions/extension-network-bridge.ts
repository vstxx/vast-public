import { app, webContents, type Session, type WebContents, type OnBeforeRequestListenerDetails } from 'electron/main'
import { matchesExtensionMatchPattern } from '../../shared/extension-match-pattern'
import { windowRegistry } from '../windows/WindowRegistry'
import { createDocumentRuleStore, documentRuleUrl, sanitizeDocumentRules } from './extension-document-rules'

type Decision = { cancel?: boolean; redirectURL?: string; csp?: string }
// What the manifest grants is read once when the background page registers: a
// loaded extension's manifest cannot change, and unloading or reloading it
// removes the provider (extension-unloaded, destroyed).
interface Provider { contents: WebContents; session: Session; id: string; hosts: readonly string[]; documentRules: boolean }
const providers = new Map<number, Provider>()
const documents = createDocumentRuleStore()
const watchedSessions = new WeakSet<Session>()
let inFlight = 0
let configured = false

function authority(contents: WebContents): Provider | undefined {
  if (contents.isDestroyed() || contents.getType() !== 'backgroundPage') return
  try {
    const url = new URL(contents.getURL())
    if (url.protocol !== 'chrome-extension:') return
    const extension = contents.session.extensions.getExtension(url.hostname)
    if (extension?.manifest.vast_network !== 1) return
    const permissions = extension.manifest.permissions
    if (!Array.isArray(permissions) || !permissions.includes('webRequest') || !permissions.includes('webRequestBlocking')) return
    const hostPermissions = Array.isArray(extension.manifest.host_permissions) ? extension.manifest.host_permissions : []
    const hosts = [...permissions, ...hostPermissions].filter((host): host is string => typeof host === 'string')
    const background = extension.manifest.background as { persistent?: boolean } | undefined
    return { contents, session: contents.session, id: url.hostname, hosts, documentRules: extension.manifest.vast_document_rules === 1 && background?.persistent === true }
  } catch { return }
}

// Still the registered provider for a live background page.
function active(provider: Provider): boolean {
  return !provider.contents.isDestroyed() && providers.get(provider.contents.id) === provider
}

/** Generic opt-in extension API. No engine, product ID, lists or renderer privileges. */
export function setupExtensionNetworkBridge(): void {
  if (configured) return
  configured = true
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) documents.navigationStarted(contents.id, url)
    })
    const register = (): void => {
      const provider = authority(contents)
      if (provider) {
        providers.set(contents.id, provider)
        if (!watchedSessions.has(provider.session)) {
          watchedSessions.add(provider.session)
          provider.session.extensions.on('extension-unloaded', (_event, extension) => {
            for (const [id, item] of providers) if (item.session === provider.session && item.id === extension.id) {
              documents.invalidateProvider(id); providers.delete(id)
            }
          })
        }
        void contents.executeJavaScript('globalThis.vastExtensionCapabilities = Object.freeze({ network: 1, documentRules: 1 })').catch(() => providers.delete(contents.id))
      }
    }
    contents.on('dom-ready', register)
    contents.once('destroyed', () => { documents.invalidateGuest(contents.id); documents.invalidateProvider(contents.id); providers.delete(contents.id) })
  })
}

function documentProvider(provider: Provider): boolean {
  return provider.documentRules && active(provider)
}

/** Synchronous read by the browser-owned, isolated guest preload only. */
export function takeExtensionDocumentRules(contents: WebContents, requestedUrl: unknown, frame: Electron.WebFrameMain | null): string[] {
  const url = documentRuleUrl(requestedUrl)
  if (!url || contents.isDestroyed() || contents.getType() !== 'webview' || frame !== contents.mainFrame ||
    frame.url !== url || contents.getURL() !== url || !windowRegistry.vastWindowForWebContents(contents)) return []
  return documents.take(contents.id, url, id => {
    const provider = providers.get(id)
    return Boolean(provider && provider.session === contents.session && documentProvider(provider))
  })
}

function sanitizeDecision(result: unknown): Decision {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {}
  const data = result as Record<string, unknown>
  return { cancel: data.cancel === true,
    ...(typeof data.redirectURL === 'string' && data.redirectURL.length <= 1024 * 1024 ? { redirectURL: data.redirectURL } : {}),
    ...(typeof data.csp === 'string' && data.csp.length <= 32_768 && !/[\r\n\0]|(?:^|[;,\s])report-(?:uri|to)\b/i.test(data.csp) ? { csp: data.csp } : {}) }
}

export async function extensionNetworkDecision(target: Session, details: Pick<OnBeforeRequestListenerDetails, 'url' | 'resourceType' | 'webContentsId' | 'referrer'>, topUrl: string, phase: 'request' | 'headers' = 'request'): Promise<Decision> {
  // Without a network extension (the usual case) every request leaves here.
  if (providers.size === 0) return {}
  const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : undefined
  if (!contents || contents.isDestroyed() || !windowRegistry.vastWindowForWebContents(contents) || contents.getType() !== 'webview' || !/^https?:/.test(topUrl) || !/^(?:https?|wss?):/.test(details.url)) return {}
  const documentUrl = contents.getURL()
  const ruleUrl = phase === 'request' && details.resourceType === 'mainFrame' ? documentRuleUrl(details.url) : undefined
  const generation = ruleUrl ? documents.begin(contents.id, ruleUrl) : undefined
  const requestUrl = details.url.replace(/^ws/, 'http')
  const applicable = [...providers.values()].filter(provider =>
    provider.session === target && active(provider) &&
    provider.hosts.some(host => matchesExtensionMatchPattern(topUrl, host)) &&
    provider.hosts.some(host => matchesExtensionMatchPattern(requestUrl, host))
  )
  if (!applicable.length || inFlight >= 2048) return {}
  const results = await Promise.all(applicable.map(provider => new Promise<Decision>(resolve => {
    inFlight++
    let finished = false
    const finish = (value: Decision): void => { if (finished) return; finished = true; inFlight--; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => {
      documents.invalidateProvider(provider.contents.id); providers.delete(provider.contents.id); finish({})
      if (!provider.contents.isDestroyed()) void provider.contents.executeJavaScript('globalThis.vastWebRequest?.unavailable?.()').catch(() => undefined)
    }, 500)
    // The host calls one fixed entry point on the verified extension background.
    // JSON serialization supplies data only; no caller-supplied source is evaluated.
    const prepareDocument = generation !== undefined && documentProvider(provider)
    const input = JSON.stringify({ phase, url: details.url, type: details.resourceType, sourceUrl: details.referrer || topUrl, topUrl, tabId: details.webContentsId, private: false, prepareDocument })
    void provider.contents.executeJavaScript(`globalThis.vastWebRequest?.handle(${input})`).then(
      result => {
        if (finished) return
        if (prepareDocument && documentProvider(provider)) {
          const scripts = sanitizeDocumentRules(result)
          if (scripts) documents.stage(contents.id, generation!, ruleUrl!, provider.contents.id, scripts)
        }
        finish(active(provider) ? sanitizeDecision(result) : {})
      }, () => finish({})
    )
  })))
  if (contents.isDestroyed() || contents.getURL() !== documentUrl) return {}
  for (const result of results) {
    if (result.cancel) return { cancel: true }
    if (result.redirectURL) {
      if (/^data:(?:application\/javascript|text\/javascript|text\/plain|text\/html|application\/json|text\/css|image\/|audio\/|video\/|application\/xml)/i.test(result.redirectURL)) return { redirectURL: result.redirectURL }
      try { const before = new URL(details.url), after = new URL(result.redirectURL); if (before.origin === after.origin && before.pathname === after.pathname) return { redirectURL: after.href } } catch {}
    }
  }
  const csp = results.map(result => result.csp).filter(Boolean).join(', ')
  return csp ? { csp } : {}
}

