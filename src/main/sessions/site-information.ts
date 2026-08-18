import { webContents } from 'electron/main'
import type { BrowserSettings, SiteInformation } from '../../shared/types'

interface SiteInformationDependencies {
  blockedCountsFor: (webContentsId: number) => { trackers: number; ads: number; malware: number }
  currentSettings: () => BrowserSettings
  identityScopeFor: (targetSession: Electron.Session) => string | undefined
  ownsWebContents: (contents: Electron.WebContents) => boolean
}

function internalSiteInformation(url: string): SiteInformation {
  return {
    kind: 'internal',
    url,
    secure: false,
    certificateStatus: 'not-applicable',
    cookieCount: 0,
    serviceWorkerCount: 0,
    storage: { cookies: 0, localStorageEntries: 0, indexedDBDatabases: 0, serviceWorkers: 0 },
    permissions: [],
    blocked: { trackers: 0, ads: 0, malware: 0 },
    interventionsDisabled: false
  }
}

export async function inspectSiteInformation(
  webContentsId: number,
  requestedUrl: string,
  dependencies: SiteInformationDependencies
): Promise<SiteInformation> {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) throw new Error('Invalid web contents identifier.')
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || !dependencies.ownsWebContents(contents)) {
    throw new Error('The active page is no longer available.')
  }
  const actualUrl = contents.getURL()
  if (actualUrl !== requestedUrl) {
    try {
      if (new URL(actualUrl).origin !== new URL(requestedUrl).origin) throw new Error('Page origin changed.')
    } catch {
      throw new Error('Page origin changed.')
    }
  }
  let parsed: URL
  try {
    parsed = new URL(actualUrl)
  } catch {
    return internalSiteInformation(actualUrl)
  }
  const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  if (!isWeb) return internalSiteInformation(actualUrl)

  const settings = dependencies.currentSettings()
  const cookies = await contents.session.cookies.get({ url: actualUrl })
  const pageStorage = await contents.executeJavaScript(`(async () => {
    let localStorageEntries = 0;
    let indexedDBDatabases = 0;
    let serviceWorkerRegistrations = 0;
    const bounded = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve([]), 750))]);
    try { localStorageEntries = localStorage.length; } catch {}
    try { if (typeof indexedDB.databases === 'function') indexedDBDatabases = (await bounded(indexedDB.databases())).length; } catch {}
    try { if (navigator.serviceWorker?.getRegistrations) serviceWorkerRegistrations = (await bounded(navigator.serviceWorker.getRegistrations())).length; } catch {}
    return { localStorageEntries, indexedDBDatabases, serviceWorkerRegistrations };
  })()`, true).catch(() => ({ localStorageEntries: 0, indexedDBDatabases: 0, serviceWorkerRegistrations: 0 })) as {
    localStorageEntries: number
    indexedDBDatabases: number
    serviceWorkerRegistrations: number
  }
  const runningWorkers = await Promise.resolve(contents.session.serviceWorkers.getAllRunning())
  const serviceWorkerCount = Object.values(runningWorkers).filter((worker) => {
    try {
      return new URL(worker.scope).origin === parsed.origin
    } catch {
      return false
    }
  }).length
  return {
    kind: 'web',
    url: actualUrl,
    origin: parsed.origin,
    hostname: parsed.hostname,
    secure: parsed.protocol === 'https:',
    certificateStatus: parsed.protocol === 'https:' ? 'validated-by-chromium' : 'not-secure',
    cookieCount: cookies.length,
    serviceWorkerCount: Math.max(serviceWorkerCount, pageStorage.serviceWorkerRegistrations),
    storage: {
      cookies: cookies.length,
      localStorageEntries: Number(pageStorage.localStorageEntries) || 0,
      indexedDBDatabases: Number(pageStorage.indexedDBDatabases) || 0,
      serviceWorkers: serviceWorkerCount
    },
    permissions: settings.security.sitePermissions.filter((permission) =>
      permission.origin === parsed.origin && permission.workspaceId === dependencies.identityScopeFor(contents.session)
    ),
    blocked: dependencies.blockedCountsFor(webContentsId),
    interventionsDisabled: settings.privacy.siteInterventionsDisabled.includes(parsed.origin)
  }
}
