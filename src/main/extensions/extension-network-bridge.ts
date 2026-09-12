import { app, webContents, type Session, type WebContents, type OnBeforeRequestListenerDetails } from 'electron/main'
import { matchesExtensionMatchPattern } from '../../shared/extension-match-pattern'
import { windowRegistry } from '../windows/WindowRegistry'

type Decision = { cancel?: boolean; redirectURL?: string; csp?: string }
interface Provider { contents: WebContents; session: Session; id: string }
const providers = new Map<number, Provider>()
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
    return { contents, session: contents.session, id: url.hostname }
  } catch { return }
}

/** Generic opt-in extension API. No engine, product ID, lists or renderer privileges. */
export function setupExtensionNetworkBridge(): void {
  if (configured) return
  configured = true
  app.on('web-contents-created', (_event, contents) => {
    const register = (): void => {
      const provider = authority(contents)
      if (provider) {
        providers.set(contents.id, provider)
        void contents.executeJavaScript('globalThis.vastExtensionCapabilities = Object.freeze({ network: 1 })').catch(() => providers.delete(contents.id))
      }
    }
    contents.on('dom-ready', register)
    contents.once('destroyed', () => providers.delete(contents.id))
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
  const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : undefined
  if (!contents || contents.isDestroyed() || !windowRegistry.vastWindowForWebContents(contents) || contents.getType() !== 'webview' || !/^https?:/.test(topUrl) || !/^(?:https?|wss?):/.test(details.url)) return {}
  const documentUrl = contents.getURL()
  const applicable = [...providers.values()].filter(provider => {
    if (provider.session !== target || !authority(provider.contents)) return false
    const manifest = target.extensions.getExtension(provider.id)?.manifest
    const hosts = [...(Array.isArray(manifest?.permissions) ? manifest.permissions : []), ...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [])]
    return hosts.some(host => typeof host === 'string' && matchesExtensionMatchPattern(topUrl, host)) && hosts.some(host => typeof host === 'string' && matchesExtensionMatchPattern(details.url.replace(/^ws/, 'http'), host))
  })
  if (!applicable.length || inFlight >= 2048) return {}
  const results = await Promise.all(applicable.map(provider => new Promise<Decision>(resolve => {
    inFlight++
    let finished = false
    const finish = (value: Decision): void => { if (finished) return; finished = true; inFlight--; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => {
      providers.delete(provider.contents.id); finish({})
      if (!provider.contents.isDestroyed()) void provider.contents.executeJavaScript('globalThis.vastWebRequest?.unavailable?.()').catch(() => undefined)
    }, 500)
    // The host calls one fixed entry point on the verified extension background.
    // JSON serialization supplies data only; no caller-supplied source is evaluated.
    const input = JSON.stringify({ phase, url: details.url, type: details.resourceType, sourceUrl: details.referrer || topUrl, topUrl, tabId: details.webContentsId, private: false })
    void provider.contents.executeJavaScript(`globalThis.vastWebRequest?.handle(${input})`).then(
      result => finish(authority(provider.contents) ? sanitizeDecision(result) : {}), () => finish({})
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
