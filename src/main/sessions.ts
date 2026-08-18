import { BrowserWindow, app, desktopCapturer, session, webContents, type BrowserWindowConstructorOptions, type Session } from 'electron/main'
import { appendFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isAdRequestUrl, isStrictAdNavigationUrl, isTrackerUrl } from '../shared/adblock'
import {
  AUTH_COMPATIBILITY_MODEL,
  AUTH_IDENTITY_PROFILE,
  isAuthSensitiveUrl,
  isGoogleIdentityProviderUrl,
  shouldBypassVastInterference
} from '../shared/auth-compatibility-policy'
import { BLOCKED_INTERNAL_PROTOCOLS, DEFAULT_SETTINGS } from '../shared/constants'
import { normalizeShortcutKey, parseShortcut } from '../shared/shortcuts'
import { buildSpoofingHeaders, resolveSpoofingProfile, spoofingFromSettings } from '../shared/spoofing'
import {
  VAST_DEFAULT_WEBVIEW_PARTITION,
  buildDefaultChromiumIdentity,
  buildDefaultChromiumRequestHeaders,
  redactOAuthUrl,
  type ChromiumIdentity
} from '../shared/oauth'
import type { BrowserSettings, BrowserTabOpenRequest, PermissionSetting, PermissionSettingKey, PersistedData, SiteInformation, SitePermissionKind, WorkspaceIdentitySettings } from '../shared/types'
import { routeWebviewWindowOpen } from '../shared/window-open-policy'
import { cancelRendererPrompt, requestRendererPrompt } from './ui-bridge'
import { appChromeCsp } from './csp'
import { originFromPermissionUrl, permissionKindsFromElectronPermission, resolveStoredPermissionPolicy, upsertOriginPermissionOverride } from './permission-policy'
import { vastDataPath } from './data-path'
import { isTrustedRendererUrl } from './ipc-security'
import { windowRegistry } from './windows/WindowRegistry'
import { shouldLoadPopupInitialUrl } from './windows/popup-initial-navigation'
import { chromeWebContentsFor as selectChromeWebContents } from './windows/web-contents-routing'
import { recordDiagnosticsEvent } from './diagnostics-events'
import { loadData, saveData } from './storage'
import { avidaeAuthorizationHeader } from './avidae-auth'
import { clearExternalProtocolRequestsForContents, requestExternalProtocolOpen } from './external-protocol'
import { installGuestRuntimeEventHandling, protectGuestMediaCapture } from './guest-runtime-events'
import { initializePrivacyFilters, matchPrivacyFilter, recordPrivacyFilterBlock } from './privacy-filter-lists'
import { cleanTrackingUrl, hostMatchesList } from '../shared/url-cleaning'
import { shouldBlockThirdPartyCookieHeaders } from '../shared/cookie-policy'
import { buildFingerprintingProtectionScript } from '../shared/fingerprinting'
import { checkpointPersistentBrowserSessions, persistentBrowserSessions } from './session-continuity'

const diagnosticLogChains = new Map<string, Promise<void>>()

function appendDiagnosticLog(filename: string, message: string): void {
  const root = join(vastDataPath(), 'Logs')
  const previous = diagnosticLogChains.get(filename) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      await mkdir(root, { recursive: true })
      await appendFile(join(root, filename), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
    })
    .catch(() => undefined)
  diagnosticLogChains.set(filename, next)
  void next.finally(() => {
    if (diagnosticLogChains.get(filename) === next) diagnosticLogChains.delete(filename)
  })
}

function logOAuthPopupFlow(message: string): void {
  appendDiagnosticLog('google-auth.log', message)
}

function logScreenShareFlow(message: string): void {
  appendDiagnosticLog('screen-share.log', message)
}

function writeSpoofingDebug(message: string): void {
  appendDiagnosticLog('spoofing.log', message)
}

function protocolOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).protocol
  } catch {
    return null
  }
}

export function isSafeWebUrl(rawUrl: string): boolean {
  const protocol = protocolOf(rawUrl)
  if (!protocol) return false
  if (BLOCKED_INTERNAL_PROTOCOLS.includes(protocol)) return false
  return protocol === 'http:' || protocol === 'https:'
}

function redactedUrlForLog(rawUrl: string | undefined): string {
  if (!rawUrl) return 'about:blank'
  if (rawUrl === 'about:blank') return rawUrl
  return redactOAuthUrl(rawUrl)
}

function sessionScopeForLog(targetSession: Session | undefined): string {
  if (!targetSession) return 'session=unknown'
  try {
    if (targetSession === session.defaultSession) return 'partition=default persistent=true'
    return `partition=inherited persistent=${typeof targetSession.isPersistent === 'function' ? targetSession.isPersistent() : 'unknown'}`
  } catch {
    return 'session=unknown'
  }
}

const configuredTrackerSessions = new Set<Session>()
const configuredSpoofingSessions = new Set<Session>()
const configuredPermissionSessions = new Set<Session>()
const configuredDisplayMediaSessions = new Set<Session>()
const configuredHeaderSessions = new Set<Session>()
const sessionIdentityScopes = new WeakMap<Session, string>()
const configuredIdentityProxies = new WeakMap<Session, string>()
const trustedInternalNavigationWebContents = new Set<number>()
const trustedOAuthPopupWebContents = new Set<number>()
const adBlockGuardedPopupWebContents = new Set<number>()
const authCompatibilityWebContents = new Map<number, OAuthPopupWindowContext>()
const directAuthOpeners = new Set<number>()
let securitySettings: (() => BrowserSettings) | undefined
let securityDataSaved: ((data: PersistedData) => void) | undefined
let sessionSecurityListenersRegistered = false
let cleanDefaultUserAgent = ''
let nativeDefaultUserAgent = ''
let constructingAuthWindowContext: OAuthPopupWindowContext | undefined
let lastGoogleAuthStatus = 'not-started'
let lastGoogleAuthPartition = 'default'
let defaultChromiumIdentity: ChromiumIdentity = buildDefaultChromiumIdentity({
  chromeVersion: process.versions.chrome,
  platform: process.platform
})

function currentSecurityWindow(): BrowserWindow | undefined {
  return windowRegistry.focusedVastWindow()
}

function ownerWindowForWebContents(contents?: Electron.WebContents): BrowserWindow | undefined {
  return windowRegistry.vastWindowForWebContents(contents)
}

function chromeWebContentsFor(opener: Electron.WebContents): Electron.WebContents | undefined {
  return selectChromeWebContents(
    opener as Electron.WebContents & { hostWebContents?: Electron.WebContents },
    () => ownerWindowForWebContents(opener)?.webContents
  ) as Electron.WebContents | undefined
}

function dispatchBrowserTabOpenRequest(
  opener: Electron.WebContents,
  request: BrowserTabOpenRequest,
  source: 'guest' | 'popup' | 'renderer'
): boolean {
  const receiver = chromeWebContentsFor(opener)
  if (receiver) {
    receiver.send('vast:browser:open-tab', request)
    logOAuthPopupFlow(
      `tab route delivered source=${source} opener=${opener.id} receiver=${receiver.id} disposition=${request.disposition} url=${redactedUrlForLog(request.url)}`
    )
    return true
  }

  logOAuthPopupFlow(
    `tab route undeliverable source=${source} opener=${opener.id} disposition=${request.disposition} url=${redactedUrlForLog(request.url)}`
  )
  void recordDiagnosticsEvent(source === 'renderer' ? 'window' : 'guest', 'tab-open-undeliverable', {
    openerWebContentsId: opener.id,
    disposition: request.disposition,
    url: redactedUrlForLog(request.url)
  })
  return false
}

function currentSecuritySettings(): BrowserSettings {
  return (securitySettings ?? (() => DEFAULT_SETTINGS))()
}

function isLocalHttpHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

const blockedRequestCounts = new Map<number, { trackers: number; ads: number; malware: number }>()

function requestTopLevelUrl(details: { url: string; resourceType: string; webContentsId?: number }): string | undefined {
  return details.resourceType === 'mainFrame'
    ? details.url
    : typeof details.webContentsId === 'number'
      ? webContents.fromId(details.webContentsId)?.getURL()
      : undefined
}

function requestTopLevelOrigin(details: { url: string; resourceType: string; webContentsId?: number }): string | undefined {
  const candidate = requestTopLevelUrl(details)
  if (!candidate) return undefined
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function siteInterventionsDisabled(details: { url: string; resourceType: string; webContentsId?: number }, disabledOrigins: readonly string[]): boolean {
  const origin = requestTopLevelOrigin(details)
  return Boolean(origin && disabledOrigins.includes(origin))
}

function httpsUpgradeUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' || isLocalHttpHost(parsed.hostname)) return undefined
    parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    return undefined
  }
}

function isSafeOAuthPopupNavigationUrl(url: string): boolean {
  if (url === 'about:blank') return true
  const protocol = protocolOf(url)
  if (protocol === 'file:' || protocol === 'javascript:' || protocol === 'data:' || protocol === 'blob:' || protocol === 'chrome:' || protocol === 'devtools:') {
    return false
  }
  return isSafeWebUrl(url)
}

function configureTrackerBlocking(targetSession: Session, getSettings: () => BrowserSettings): void {
  if (configuredTrackerSessions.has(targetSession)) return
  configuredTrackerSessions.add(targetSession)
  const isTemporarySession = typeof targetSession.isPersistent === 'function' && !targetSession.isPersistent()
  let cachedSettings: BrowserSettings | undefined
  let requestPolicy: {
    httpsOnlyMode: boolean
    trackerBlocking: boolean
    adBlocking: boolean
    adBlockerMode: BrowserSettings['privacy']['adBlockerMode']
    disabledOrigins: readonly string[]
    settings: BrowserSettings
  }
  const currentPolicy = (): typeof requestPolicy => {
    const settings = getSettings()
    if (settings !== cachedSettings) {
      cachedSettings = settings
      const adBlocking = settings.privacy.adBlockerEnabled
      requestPolicy = {
        httpsOnlyMode: settings.security.httpsOnlyMode,
        trackerBlocking: isTemporarySession || settings.privacy.blockTrackers,
        adBlocking,
        adBlockerMode: settings.privacy.adBlockerMode ?? 'standard',
        disabledOrigins: settings.privacy.siteInterventionsDisabled,
        settings
      }
    }
    return requestPolicy
  }
  targetSession.webRequest.onBeforeRequest((details, callback) => {
    const authWindow = typeof details.webContentsId === 'number' && authCompatibilityWebContents.has(details.webContentsId)
    const topLevelUrl = requestTopLevelUrl(details)
    if (shouldBypassVastInterference({ url: details.url, topLevelUrl, authWindow })) {
      callback({})
      return
    }
    const policy = currentPolicy()
    if (typeof details.webContentsId === 'number' && details.resourceType === 'mainFrame') {
      blockedRequestCounts.set(details.webContentsId, { trackers: 0, ads: 0, malware: 0 })
    }
    if (siteInterventionsDisabled(details, policy.disabledOrigins)) {
      callback({})
      return
    }
    if (policy.settings.privacy.stripTrackingParameters && details.resourceType === 'mainFrame') {
      const cleaned = cleanTrackingUrl(details.url, policy.settings.privacy.stripAffiliateParameters)
      if (cleaned.changed) {
        callback({ redirectURL: cleaned.url })
        return
      }
    }
    if (policy.httpsOnlyMode && details.resourceType === 'mainFrame') {
      const redirectURL = httpsUpgradeUrl(details.url)
      if (redirectURL) {
        callback({ redirectURL })
        return
      }
    }
    const topLevelOrigin = requestTopLevelOrigin(details)
    if (topLevelOrigin && hostMatchesList(topLevelOrigin, policy.settings.privacy.adBlockAllowlist)) {
      callback({})
      return
    }
    const listCategory = matchPrivacyFilter(details.url, topLevelOrigin, details.resourceType, policy.settings)
    const trackerBlocked = listCategory === 'trackers' || policy.trackerBlocking && isTrackerUrl(details.url)
    const adBlocked = listCategory === 'ads' || policy.adBlocking && isAdRequestUrl(details.url, details.resourceType, policy.adBlockerMode)
    const malwareBlocked = listCategory === 'malware'
    if (trackerBlocked || adBlocked || malwareBlocked) {
      if (listCategory) recordPrivacyFilterBlock(listCategory)
      if (typeof details.webContentsId === 'number' && details.webContentsId > 0) {
        const counts = blockedRequestCounts.get(details.webContentsId) ?? { trackers: 0, ads: 0, malware: 0 }
        blockedRequestCounts.set(details.webContentsId, {
          trackers: counts.trackers + Number(trackerBlocked),
          ads: counts.ads + Number(adBlocked),
          malware: counts.malware + Number(malwareBlocked)
        })
      }
      callback({ cancel: true })
      return
    }
    callback({})
  })
}

function configureSpoofingForSession(targetSession: Session, getSettings: () => BrowserSettings): void {
  if (configuredSpoofingSessions.has(targetSession)) return
  configuredSpoofingSessions.add(targetSession)
  let cachedSettings: BrowserSettings | undefined
  let cachedSpoofing: ReturnType<typeof spoofingFromSettings>
  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const authWindow = typeof details.webContentsId === 'number' && authCompatibilityWebContents.has(details.webContentsId)
    const topLevelUrl = requestTopLevelUrl(details)
    if (shouldBypassVastInterference({ url: details.url, topLevelUrl, authWindow })) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    const settings = getSettings()
    if (siteInterventionsDisabled(details, settings.privacy.siteInterventionsDisabled)) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    if (settings !== cachedSettings) {
      cachedSettings = settings
      cachedSpoofing = spoofingFromSettings(settings)
    }
    const spoofing = cachedSpoofing
    const requestHeaders = spoofing.enabled
      ? buildSpoofingHeaders(spoofing, details.requestHeaders, process.versions.chrome)
      : buildDefaultChromiumRequestHeaders(defaultChromiumIdentity, details.requestHeaders)
    const thirdPartyCookiesBlocked = settings.privacy.blockThirdPartyCookies ||
      settings.privacy.adBlockerMode === 'strict' ||
      settings.privacy.adBlockerMode === 'custom' && settings.privacy.customBlockThirdPartyCookies
    if (shouldBlockThirdPartyCookieHeaders({
      requestUrl: details.url,
      topLevelUrl,
      resourceType: details.resourceType,
      enabled: thirdPartyCookiesBlocked,
      exceptions: settings.privacy.cookieExceptions,
      authWindow
    })) {
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase() === 'cookie') delete requestHeaders[name]
      }
    }
    const avidaeAuthorization = avidaeAuthorizationHeader(details.url)
    if (avidaeAuthorization) requestHeaders.Authorization = avidaeAuthorization
    callback({ requestHeaders })
  })
}

function permissionPolicy(
  permission: string,
  details:
    | Electron.PermissionRequest
    | Electron.PermissionCheckHandlerHandlerDetails
    | Electron.MediaAccessPermissionRequest
    | undefined,
  settings: BrowserSettings
): PermissionSetting {
  const spoofing = spoofingFromSettings(settings)
  if (permission === 'geolocation' && spoofing.enabled && spoofing.location.mode === 'fixed') {
    return 'allow'
  }

  const requestMediaTypes = (details as Electron.MediaAccessPermissionRequest | undefined)?.mediaTypes
  const checkMediaType = (details as Electron.PermissionCheckHandlerHandlerDetails | undefined)?.mediaType
  const mediaTypes: string[] = Array.isArray(requestMediaTypes)
    ? [...requestMediaTypes]
    : checkMediaType
      ? [checkMediaType]
      : []
  if (permission === 'media') {
    const wantsVideo = mediaTypes.includes('video')
    const wantsAudio = mediaTypes.includes('audio')
    if (wantsVideo && settings.security.permissionCamera === 'block') return 'block'
    if (wantsAudio && settings.security.permissionMicrophone === 'block') return 'block'
    if (
      (wantsVideo || wantsAudio) &&
      (!wantsVideo || settings.security.permissionCamera === 'allow') &&
      (!wantsAudio || settings.security.permissionMicrophone === 'allow')
    ) {
      return 'allow'
    }
    return 'ask'
  }
  if (permission === 'geolocation') return settings.security.permissionLocation
  if (permission === 'notifications') return settings.security.permissionNotifications
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return settings.security.permissionClipboard
  if (permission === 'fullscreen') return settings.security.permissionFullscreen
  return 'block'
}

function permissionSettingKeys(
  permission: string,
  details:
    | Electron.PermissionRequest
    | Electron.PermissionCheckHandlerHandlerDetails
    | Electron.MediaAccessPermissionRequest
    | undefined
): PermissionSettingKey[] {
  const requestMediaTypes = (details as Electron.MediaAccessPermissionRequest | undefined)?.mediaTypes
  const checkMediaType = (details as Electron.PermissionCheckHandlerHandlerDetails | undefined)?.mediaType
  const mediaTypes: string[] = Array.isArray(requestMediaTypes)
    ? [...requestMediaTypes]
    : checkMediaType
      ? [checkMediaType]
      : []

  if (permission === 'media') {
    const keys: PermissionSettingKey[] = []
    if (mediaTypes.includes('video')) keys.push('permissionCamera')
    if (mediaTypes.includes('audio')) keys.push('permissionMicrophone')
    return keys
  }
  if (permission === 'geolocation') return ['permissionLocation']
  if (permission === 'notifications') return ['permissionNotifications']
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return ['permissionClipboard']
  if (permission === 'fullscreen') return ['permissionFullscreen']
  return []
}

function permissionLabel(
  permission: string,
  details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest | undefined
): string {
  const requestMediaTypes = (details as Electron.MediaAccessPermissionRequest | undefined)?.mediaTypes
  const mediaTypes: string[] = Array.isArray(requestMediaTypes)
    ? [...requestMediaTypes]
    : []
  if (permission === 'media') {
    if (mediaTypes.includes('audio') && mediaTypes.includes('video')) return 'camera and microphone'
    if (mediaTypes.includes('video')) return 'camera'
    if (mediaTypes.includes('audio')) return 'microphone'
    return 'media devices'
  }
  if (permission === 'geolocation') return 'location'
  if (permission === 'notifications') return 'notifications'
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return 'clipboard'
  if (permission === 'fullscreen') return 'fullscreen'
  return permission
}

function configurePermissionsForSession(
  targetSession: Session,
): void {
  if (configuredPermissionSessions.has(targetSession)) return
  configuredPermissionSessions.add(targetSession)

  targetSession.setPermissionCheckHandler((requestingContents, permission, _requestingOrigin, details) => {
    const topLevelOrigin = originFromPermissionUrl(requestingContents?.getURL() ?? '')
    if (!topLevelOrigin || !ownerWindowForWebContents(requestingContents ?? undefined)) return false
    const requestMediaType = (details as Electron.PermissionCheckHandlerHandlerDetails | undefined)?.mediaType
    const settings = currentSecuritySettings()
    const workspaceId = sessionIdentityScopes.get(targetSession)
    if (permission === 'media' && settings.privacy.webRtcPolicy === 'disabled' && !hostMatchesList(topLevelOrigin, settings.privacy.webRtcExceptions)) return false
    const basePolicy = permissionPolicy(permission, details, settings)
    if (basePolicy === 'allow' && permission === 'geolocation') return true
    const kinds = permissionKindsFromElectronPermission(permission, requestMediaType ? [requestMediaType] : [])
    if (kinds.length === 0) return false
    return kinds.every((kind) => resolveStoredPermissionPolicy(settings, topLevelOrigin, kind, workspaceId) === 'allow')
  })

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originFromPermissionUrl(webContents.getURL())
    const window = ownerWindowForWebContents(webContents)
    if (!origin || !window) {
      callback(false)
      return
    }

    const settings = currentSecuritySettings()
    const workspaceId = sessionIdentityScopes.get(targetSession)
    if (permission === 'media' && settings.privacy.webRtcPolicy === 'disabled' && !hostMatchesList(origin, settings.privacy.webRtcExceptions)) {
      callback(false)
      return
    }
    const requestMediaTypes = (details as Electron.MediaAccessPermissionRequest | undefined)?.mediaTypes
    const mediaTypes = Array.isArray(requestMediaTypes) ? [...requestMediaTypes] : []
    // Electron 42 emits an empty `media` permission request before delegating
    // getDisplayMedia to setDisplayMediaRequestHandler. Device requests include
    // audio/video mediaTypes; this empty gate grants no source by itself.
    if (permission === 'media' && mediaTypes.length === 0) {
      callback(true)
      return
    }
    const permissionKinds = permissionKindsFromElectronPermission(permission, mediaTypes)
    const basePolicy = permissionPolicy(permission, details, settings)
    const storedPolicies = permissionKinds.map((kind) => resolveStoredPermissionPolicy(settings, origin, kind, workspaceId))
    const policy: PermissionSetting = basePolicy === 'allow' && permission === 'geolocation'
      ? 'allow'
      : storedPolicies.some((setting) => setting === 'block')
        ? 'block'
        : storedPolicies.length > 0 && storedPolicies.every((setting) => setting === 'allow')
          ? 'allow'
          : basePolicy === 'block'
            ? 'block'
            : 'ask'
    if (policy === 'block') {
      callback(false)
      return
    }

    if (policy === 'allow') {
      if (permission === 'media' && mediaTypes.some((type) => type === 'audio' || type === 'video')) {
        protectGuestMediaCapture(webContents)
      }
      callback(true)
      return
    }

    const requestId = randomUUID()
    let invalidated = false
    const invalidate = (): void => {
      if (invalidated) return
      invalidated = true
      cancelRendererPrompt(requestId)
    }
    const onNavigation = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame) invalidate()
    }
    webContents.on('did-start-navigation', onNavigation)
    webContents.once('destroyed', invalidate)
    webContents.once('render-process-gone', invalidate)
    window.once('closed', invalidate)

    void requestRendererPrompt(window, {
      id: requestId,
      tone: 'question',
      title: 'Permission request',
      message: `Allow ${origin} to use ${permissionLabel(permission, details)}?`,
      detail: 'Allow once grants access only now. Always allow saves this choice in Settings > Site Data / Permissions.',
      persistSettingKeys: [],
      permissionRequest: permissionKinds[0] ? { origin, workspaceId, permission: permissionKinds[0] } : undefined,
      actions: [
        { id: 'allow-once', label: 'Allow once', tone: 'primary' },
        { id: 'allow-always', label: 'Always allow', tone: 'success' },
        { id: 'block', label: 'Block', tone: 'danger' }
      ]
    })
      .then(async (choice) => {
        if (invalidated || webContents.isDestroyed() || window.isDestroyed()) return false
        if (ownerWindowForWebContents(webContents) !== window || originFromPermissionUrl(webContents.getURL()) !== origin) return false
        if ((choice === 'allow-always' || choice === 'block') && permissionKinds.length > 0) {
          const data = await loadData()
          const settings = permissionKinds.reduce(
            (nextSettings, kind) => upsertOriginPermissionOverride(
              nextSettings,
              origin,
              kind,
              choice === 'allow-always' ? 'allow' : 'block',
              workspaceId
            ),
            data.settings
          )
          const next = { ...data, settings }
          await saveData(next)
          securityDataSaved?.(next)
          windowRegistry.broadcast('vast:settings-saved')
          windowRegistry.broadcast('vast:site-permissions-changed', settings.security.sitePermissions)
        }
        const allowed = choice === 'allow-once' || choice === 'allow-always'
        if (allowed && permission === 'media' && mediaTypes.some((type) => type === 'audio' || type === 'video')) {
          protectGuestMediaCapture(webContents)
        }
        return allowed
      })
      .then(callback)
      .catch(() => callback(false))
      .finally(() => {
        webContents.removeListener('did-start-navigation', onNavigation)
        webContents.removeListener('destroyed', invalidate)
        webContents.removeListener('render-process-gone', invalidate)
        window.removeListener('closed', invalidate)
      })
  })
}

function configureDisplayMediaForSession(targetSession: Session): void {
  if (configuredDisplayMediaSessions.has(targetSession)) return
  configuredDisplayMediaSessions.add(targetSession)

  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    let completed = false
    const finish = (streams: Electron.Streams): void => {
      if (completed) return
      completed = true
      callback(streams)
    }

    const frame = request.frame
    const origin = originFromPermissionUrl(request.securityOrigin)
    const requestingContents = frame ? webContents.fromFrame(frame) : undefined
    const window = ownerWindowForWebContents(requestingContents)
    if (
      !frame ||
      frame.detached ||
      !origin ||
      originFromPermissionUrl(frame.origin) !== origin ||
      !requestingContents ||
      requestingContents.isDestroyed() ||
      !window ||
      !request.videoRequested ||
      !request.userGesture
    ) {
      logScreenShareFlow(`request denied origin=${origin ?? 'invalid'} reason=invalid-context-or-missing-user-gesture`)
      try {
        finish({})
      } catch {
        // Electron also throws locally while rejecting getDisplayMedia.
      }
      return
    }

    const requestId = randomUUID()
    const sourceByChoiceId = new Map<string, { source: Electron.DesktopCapturerSource; includeAudio: boolean }>()
    const invalidate = (): void => {
      cancelRendererPrompt(requestId)
      logScreenShareFlow(`request cancelled origin=${origin} reason=context-invalidated`)
      try {
        finish({})
      } catch {
        // The website receives a rejected getDisplayMedia promise.
      }
    }
    const onNavigation = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame) invalidate()
    }
    requestingContents.on('did-start-navigation', onNavigation)
    requestingContents.once('destroyed', invalidate)
    requestingContents.once('render-process-gone', invalidate)
    window.once('closed', invalidate)

    logScreenShareFlow(`request opened origin=${origin} contents=${requestingContents.id} audioRequested=${request.audioRequested}`)
    void desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
      .then(async (sources) => {
        if (completed) return undefined
        const choices = sources.slice(0, 80).map((source) => {
          const choiceId = randomUUID()
          sourceByChoiceId.set(choiceId, { source, includeAudio: false })
          const audioChoiceId = request.audioRequested && process.platform === 'win32' ? randomUUID() : undefined
          if (audioChoiceId) sourceByChoiceId.set(audioChoiceId, { source, includeAudio: true })
          return {
            id: choiceId,
            label: source.name || 'Unnamed source',
            detail: source.id.startsWith('screen:') ? 'Entire display' : 'Application window',
            thumbnailDataUrl: source.thumbnail.isEmpty() ? undefined : source.thumbnail.toDataURL(),
            alternateAction: audioChoiceId
              ? { id: audioChoiceId, label: 'Share with audio', tone: 'default' as const }
              : undefined
          }
        })

        if (choices.length === 0) {
          logScreenShareFlow(`request denied origin=${origin} reason=no-sources`)
          return undefined
        }

        return await requestRendererPrompt(window, {
          id: requestId,
          tone: 'question',
          title: 'Choose what to share',
          message: `${origin} wants to see your screen. Select one display or application window.`,
          detail: 'Vast never remembers this choice. Screen sharing stops when you end it on the website.',
          choices,
          actions: [{ id: 'cancel', label: 'Cancel', tone: 'default' }]
        }, 120_000)
      })
      .then((choice) => {
        if (completed || !choice || choice === 'cancel') {
          if (!completed) {
            logScreenShareFlow(`request cancelled origin=${origin} reason=user-or-timeout`)
            try {
              finish({})
            } catch {
              // The website receives a rejected getDisplayMedia promise.
            }
          }
          return
        }
        const selected = sourceByChoiceId.get(choice)
        const contextStillValid =
          !frame.detached &&
          !requestingContents.isDestroyed() &&
          !window.isDestroyed() &&
          ownerWindowForWebContents(requestingContents) === window &&
          originFromPermissionUrl(frame.origin) === origin
        if (!selected || !contextStillValid) {
          logScreenShareFlow(`request denied origin=${origin} reason=stale-or-invalid-selection`)
          try {
            finish({})
          } catch {
            // The website receives a rejected getDisplayMedia promise.
          }
          return
        }

        logScreenShareFlow(`request granted origin=${origin} sourceType=${selected.source.id.startsWith('screen:') ? 'screen' : 'window'} audio=${selected.includeAudio}`)
        protectGuestMediaCapture(requestingContents)
        finish({
          video: selected.source,
          audio: selected.includeAudio ? 'loopback' : undefined
        })
      })
      .catch((error: unknown) => {
        if (completed) return
        const errorDetail = error instanceof Error
          ? `${error.name}:${error.message.replace(/[\r\n]+/g, ' ').slice(0, 240)}`
          : 'unknown'
        logScreenShareFlow(`request failed origin=${origin} error=${errorDetail}`)
        try {
          finish({})
        } catch {
          // Electron rejects navigator.getDisplayMedia when an empty stream is
          // returned; some runtime versions surface that rejection here too.
        }
      })
      .finally(() => {
        requestingContents.removeListener('did-start-navigation', onNavigation)
        requestingContents.removeListener('destroyed', invalidate)
        requestingContents.removeListener('render-process-gone', invalidate)
        window.removeListener('closed', invalidate)
      })
  }, { useSystemPicker: process.platform === 'darwin' })
}

function configureSecurityHeaders(targetSession: Session): void {
  if (configuredHeaderSessions.has(targetSession)) return
  configuredHeaderSessions.add(targetSession)

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}
    const isInternalResponse =
      details.url.startsWith('file:') ||
      details.url.startsWith('http://localhost:') ||
      details.url.startsWith('http://127.0.0.1:')

    const settings = currentSecuritySettings()
    const authWindow = typeof details.webContentsId === 'number' && authCompatibilityWebContents.has(details.webContentsId)
    const topLevelUrl = requestTopLevelUrl(details)
    const thirdPartyCookiesBlocked = settings.privacy.blockThirdPartyCookies ||
      settings.privacy.adBlockerMode === 'strict' ||
      settings.privacy.adBlockerMode === 'custom' && settings.privacy.customBlockThirdPartyCookies
    if (shouldBlockThirdPartyCookieHeaders({
      requestUrl: details.url,
      topLevelUrl,
      resourceType: details.resourceType,
      enabled: thirdPartyCookiesBlocked,
      exceptions: settings.privacy.cookieExceptions,
      authWindow
    })) {
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase() === 'set-cookie') delete responseHeaders[name]
      }
    }

    if (isInternalResponse && details.resourceType === 'mainFrame') {
      responseHeaders['X-Content-Type-Options'] = ['nosniff']
      responseHeaders['X-Frame-Options'] = ['DENY']
      responseHeaders['Content-Security-Policy'] = [appChromeCsp(app.isPackaged)]
    }

    callback({ responseHeaders })
  })
}

export function allowInternalNavigationForWebContents(contents: Electron.WebContents): () => void {
  trustedInternalNavigationWebContents.add(contents.id)
  return () => trustedInternalNavigationWebContents.delete(contents.id)
}

export function setupTrackerBlocking(getSettings: () => BrowserSettings): void {
  initializePrivacyFilters(getSettings)
  for (const targetSession of persistentBrowserSessions()) {
    configureTrackerBlocking(targetSession, getSettings)
    configureSpoofingForSession(targetSession, getSettings)
  }
  app.on('session-created', (targetSession) => {
    configureTrackerBlocking(targetSession, getSettings)
    configureSpoofingForSession(targetSession, getSettings)
  })
}

/**
 * Strips the Electron identifier from all session user-agents so that services
 * like Google Accounts do not reject requests from Electron-based browsers.
 * This fixes blank/black pages on Gmail and other Google services that
 * redirect through accounts.google.com when they detect an Electron UA.
 */
export function setupUserAgent(getSettings?: () => BrowserSettings): void {
  nativeDefaultUserAgent ||= session.defaultSession.getUserAgent()
  defaultChromiumIdentity = buildDefaultChromiumIdentity({
    chromeVersion: process.versions.chrome,
    platform: process.platform
  })
  cleanDefaultUserAgent = defaultChromiumIdentity.userAgent
  const getUserAgent = (): string => {
    const settings = getSettings?.()
    if (!settings) return cleanDefaultUserAgent
    const spoofing = spoofingFromSettings(settings)
    return spoofing.enabled ? resolveSpoofingProfile(spoofing, process.versions.chrome).userAgent : cleanDefaultUserAgent
  }

  for (const targetSession of persistentBrowserSessions()) targetSession.setUserAgent(getUserAgent())
  app.on('session-created', (targetSession) => {
    targetSession.setUserAgent(getUserAgent())
  })
}

function userAgentForSettings(settings: BrowserSettings): string {
  const spoofing = spoofingFromSettings(settings)
  return spoofing.enabled ? resolveSpoofingProfile(spoofing, process.versions.chrome).userAgent : cleanDefaultUserAgent || session.defaultSession.getUserAgent()
}

function matchesInputShortcut(input: Electron.Input, shortcut: string): boolean {
  const parts = parseShortcut(shortcut)
  if (!parts) return false
  if (parts.ctrlOrMeta !== (input.control || input.meta)) return false
  if (parts.shift !== input.shift) return false
  if (parts.alt !== input.alt) return false
  const key = normalizeShortcutKey(input.key)
  return parts.key === key || (parts.key === '+' && (key === '=' || key === '+'))
}

interface OAuthPopupWindowContext {
  opener?: Electron.WebContents
  initialUrl?: string
  disposition?: string
  frameName?: string
  directNavigation?: boolean
}

function authCompatibilityUserAgent(): string {
  // The sterile production path keeps Chromium/Electron's native identity.
  // Client Hints remain engine-owned; Vast does not rewrite them or inject a
  // JavaScript identity shim anywhere in the auth chain.
  return nativeDefaultUserAgent || cleanDefaultUserAgent || defaultChromiumIdentity.userAgent
}

function isAuthCompatibilityPopup(context: OAuthPopupWindowContext): boolean {
  return context.initialUrl === 'about:blank' || Boolean(context.initialUrl && isAuthSensitiveUrl(context.initialUrl))
}

function registerAuthCompatibilityContents(
  contents: Electron.WebContents,
  context: OAuthPopupWindowContext
): void {
  authCompatibilityWebContents.set(contents.id, context)
  contents.setUserAgent(authCompatibilityUserAgent())
  if (contents.debugger.isAttached()) {
    try {
      contents.debugger.detach()
    } catch {
      // The auth page must proceed without CDP even if a previous spoofing
      // update raced with popup registration.
    }
  }
}

export function getGoogleAuthDiagnostics(): {
  model: string
  partition: string
  chrome: string
  electron: string
  identityProfile: string
  lastStatus: string
  logPath: string
} {
  return {
    model: AUTH_COMPATIBILITY_MODEL,
    partition: lastGoogleAuthPartition,
    chrome: process.versions.chrome ?? '',
    electron: process.versions.electron ?? '',
    identityProfile: AUTH_IDENTITY_PROFILE,
    lastStatus: lastGoogleAuthStatus,
    logPath: join(vastDataPath(), 'Logs', 'google-auth.log')
  }
}

function createOAuthPopupWindow(options: BrowserWindowConstructorOptions, context: OAuthPopupWindowContext = {}): Electron.WebContents {
  const providedWebContents = (options as BrowserWindowConstructorOptions & {
    webContents?: Electron.WebContents
  }).webContents
  const hasProvidedWebContents = Boolean(providedWebContents)
  const authCompatibilityPopup = isAuthCompatibilityPopup(context)
  const parent = ownerWindowForWebContents(context.opener)
  const openerSession = context.opener && !context.opener.isDestroyed() ? context.opener.session : undefined
  const webPreferences: NonNullable<BrowserWindowConstructorOptions['webPreferences']> = {
    ...(options.webPreferences ?? {}),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false
  }
  delete webPreferences.preload
  delete webPreferences.additionalArguments
  webPreferences.webviewTag = false
  if (openerSession) {
    webPreferences.session = openerSession
    delete (webPreferences as { partition?: string }).partition
  } else if (!webPreferences.session && !webPreferences.partition) {
    webPreferences.partition = VAST_DEFAULT_WEBVIEW_PARTITION
  }

  if (authCompatibilityPopup && providedWebContents) {
    registerAuthCompatibilityContents(providedWebContents, context)
  }

  const previousConstructionContext = constructingAuthWindowContext
  if (authCompatibilityPopup) constructingAuthWindowContext = context
  let popup: BrowserWindow
  try {
    popup = new BrowserWindow({
      ...options,
      parent,
      width: Math.max(420, Math.min(options.width ?? 520, 760)),
      height: Math.max(520, Math.min(options.height ?? 680, 860)),
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#111111',
      title: options.title || 'Sign in',
      webPreferences
    })
  } finally {
    constructingAuthWindowContext = previousConstructionContext
  }

  if (authCompatibilityPopup) {
    registerAuthCompatibilityContents(popup.webContents, context)
    lastGoogleAuthPartition = openerSession === session.defaultSession
      ? 'default'
      : openerSession?.isPersistent()
        ? 'persistent-inherited'
        : 'temporary-inherited'
    lastGoogleAuthStatus = 'popup-created'
  }

  const popupContentsId = popup.webContents.id
  windowRegistry.register(popup, 'popup')
  let lastMainFrameUrl = context.initialUrl || popup.webContents.getURL() || 'about:blank'

  adBlockGuardedPopupWebContents.add(popupContentsId)
  trustedOAuthPopupWebContents.add(popupContentsId)
  logOAuthPopupFlow(
    `created popup id=${popupContentsId} auth=${authCompatibilityPopup} identity=${authCompatibilityPopup ? AUTH_IDENTITY_PROFILE : 'session-default'} debugger=${popup.webContents.debugger.isAttached()} opener=${context.opener?.id ?? 'none'} ${sessionScopeForLog(openerSession ?? popup.webContents.session)} disposition=${context.disposition ?? ''} frameName=${context.frameName ?? ''} initialUrl=${redactedUrlForLog(lastMainFrameUrl)}`
  )
  popup.once('ready-to-show', () => {
    popup.show()
    popup.focus()
  })
  popup.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    lastMainFrameUrl = url
    if (authCompatibilityPopup) lastGoogleAuthStatus = 'navigating'
    logOAuthPopupFlow(`popup navigate id=${popupContentsId} url=${redactedUrlForLog(url)} inPlace=${isInPlace}`)
  })
  popup.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    lastMainFrameUrl = validatedURL || lastMainFrameUrl
    if (authCompatibilityPopup) lastGoogleAuthStatus = `load-failed-${errorCode}`
    logOAuthPopupFlow(`popup fail id=${popupContentsId} code=${errorCode} url=${redactedUrlForLog(validatedURL)}`)
  })
  popup.webContents.on('did-finish-load', () => {
    const currentUrl = popup.webContents.getURL() || lastMainFrameUrl
    lastMainFrameUrl = currentUrl
    if (authCompatibilityPopup) lastGoogleAuthStatus = 'loaded'
    logOAuthPopupFlow(`popup loaded id=${popupContentsId} url=${redactedUrlForLog(currentUrl)}`)
  })
  popup.webContents.on('did-navigate', (_event, url) => {
    if (!context.directNavigation || !context.opener || context.opener.isDestroyed()) return
    if (!isSafeWebUrl(url) || isGoogleIdentityProviderUrl(url)) return
    lastGoogleAuthStatus = 'returning-to-opener'
    logOAuthPopupFlow(`direct auth return id=${popupContentsId} opener=${context.opener.id} url=${redactedUrlForLog(url)}`)
    void context.opener.loadURL(url)
      .then(() => {
        lastGoogleAuthStatus = 'completed-in-opener'
        if (!popup.isDestroyed()) popup.close()
      })
      .catch((error) => {
        lastGoogleAuthStatus = 'opener-return-failed'
        logOAuthPopupFlow(`direct auth return failed id=${popupContentsId} error=${error instanceof Error ? error.name : 'unknown'}`)
      })
  })
  popup.on('closed', () => {
    adBlockGuardedPopupWebContents.delete(popupContentsId)
    trustedOAuthPopupWebContents.delete(popupContentsId)
    authCompatibilityWebContents.delete(popupContentsId)
    if (context.directNavigation && context.opener) directAuthOpeners.delete(context.opener.id)
    if (authCompatibilityPopup && lastGoogleAuthStatus !== 'completed-in-opener') {
      lastGoogleAuthStatus = 'closed'
    }
    logOAuthPopupFlow(`closed popup id=${popupContentsId} lastUrl=${redactedUrlForLog(lastMainFrameUrl)}`)
  })
  setTimeout(() => {
    if (!popup.isDestroyed()) {
      popup.show()
      popup.focus()
    }
  }, 80)

  if (shouldLoadPopupInitialUrl(context.initialUrl, hasProvidedWebContents, isSafeWebUrl)) {
    const initialUrl = context.initialUrl
    void popup.loadURL(initialUrl).catch((error) => {
      logOAuthPopupFlow(
        `popup initial load failed id=${popupContentsId} url=${redactedUrlForLog(initialUrl)} error=${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  return popup.webContents
}

export function createInternalGoogleAuthTestWindow(): Electron.WebContents {
  return createOAuthPopupWindow(
    {
      width: 520,
      height: 680,
      webPreferences: {
        session: session.defaultSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    },
    {
      initialUrl: 'https://accounts.google.com/ServiceLogin?hl=en',
      disposition: 'internal-email-only-check',
      frameName: 'vast-google-auth'
    }
  )
}

export function applySpoofingToWebContents(contents: Electron.WebContents, settings: BrowserSettings = currentSecuritySettings()): void {
  if (contents.isDestroyed()) return
  if (authCompatibilityWebContents.has(contents.id)) {
    contents.setUserAgent(authCompatibilityUserAgent())
    if (contents.debugger.isAttached()) {
      try {
        contents.debugger.detach()
      } catch {
        // Auth compatibility windows never retain a CDP attachment.
      }
    }
    return
  }
  const spoofing = spoofingFromSettings(settings)
  try {
    if (!spoofing.enabled || spoofing.location.mode !== 'fixed') {
      if (contents.debugger.isAttached()) {
        void contents.debugger.sendCommand('Emulation.clearGeolocationOverride').catch(() => undefined)
      }
      return
    }

    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3')
    }
    void contents.debugger
      .sendCommand('Emulation.setGeolocationOverride', {
        latitude: spoofing.location.latitude,
        longitude: spoofing.location.longitude,
        accuracy: spoofing.location.accuracy
      })
      .catch(() => undefined)
  } catch (error) {
    writeSpoofingDebug(`geolocation override failed for contents=${contents.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function applySpoofingToAllWebContents(settings: BrowserSettings = currentSecuritySettings()): void {
  const userAgent = userAgentForSettings(settings)
  session.defaultSession.setUserAgent(userAgent)
  for (const contents of webContents.getAllWebContents()) {
    if (authCompatibilityWebContents.has(contents.id)) {
      contents.setUserAgent(authCompatibilityUserAgent())
      applySpoofingToWebContents(contents, settings)
      continue
    }
    try {
      contents.session.setUserAgent(userAgent)
    } catch {
      // Some destroyed/internal contents can reject session updates.
    }
    applySpoofingToWebContents(contents, settings)
  }
}

function installWindowOpenRouting(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url, disposition, frameName, features }) => {
    const isWebviewGuest = Boolean(
      (contents as Electron.WebContents & { hostWebContents?: Electron.WebContents }).hostWebContents
    )
    const isRealPopup = trustedOAuthPopupWebContents.has(contents.id)
    const bypassVastInterference = shouldBypassVastInterference({
      url,
      authWindow: authCompatibilityWebContents.has(contents.id)
    })
    logOAuthPopupFlow(
      `window-open received contents=${contents.id} guest=${isWebviewGuest} popup=${isRealPopup} disposition=${disposition} url=${redactedUrlForLog(url)}`
    )

    if (isWebviewGuest || isRealPopup) {
      if (requestExternalProtocolOpen(contents, url)) return { action: 'deny' }
      const settings = currentSecuritySettings()
      if (!bypassVastInterference && settings.privacy.adBlockerEnabled && settings.privacy.adBlockerMode === 'strict' && isStrictAdNavigationUrl(url)) {
        logOAuthPopupFlow(`blocked brutal ad popup opener=${contents.id} disposition=${disposition} url=${redactedUrlForLog(url)}`)
        return { action: 'deny' }
      }

      const route = routeWebviewWindowOpen({
        url,
        disposition,
        adBlockerEnabled: settings.privacy.adBlockerEnabled,
        adBlockerMode: settings.privacy.adBlockerMode ?? 'standard',
        frameName,
        features
      })
      logOAuthPopupFlow(
        `webview window.open route=${route} opener=${contents.id} ${sessionScopeForLog(contents.session)} disposition=${disposition} frameName=${frameName || ''} url=${redactedUrlForLog(url)} features=${features || ''}`
      )
      if (route === 'popup-window') {
        return {
          action: 'allow',
          createWindow: (popupOptions) =>
            createOAuthPopupWindow(popupOptions, {
              opener: contents,
              initialUrl: url,
              disposition,
              frameName
            }),
          overrideBrowserWindowOptions: {
            width: 520,
            height: 640,
            autoHideMenuBar: true,
            webPreferences: {
              partition: VAST_DEFAULT_WEBVIEW_PARTITION,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              allowRunningInsecureContent: false
            }
          }
        }
      }

      if (route === 'deny') return { action: 'deny' }

      if (route === 'vast-tab' && isSafeWebUrl(url)) {
        const nextUrl = settings.security.httpsOnlyMode ? httpsUpgradeUrl(url) ?? url : url
        dispatchBrowserTabOpenRequest(contents, {
          url: nextUrl,
          sourceWebContentsId: isWebviewGuest ? contents.id : undefined,
          disposition,
          activate: disposition !== 'background-tab'
        }, isWebviewGuest ? 'guest' : 'popup')
      }

      return { action: 'deny' }
    }

    if (isSafeWebUrl(url)) {
      const nextUrl = currentSecuritySettings().security.httpsOnlyMode ? httpsUpgradeUrl(url) ?? url : url
      dispatchBrowserTabOpenRequest(contents, {
        url: nextUrl,
        disposition,
        activate: disposition !== 'background-tab'
      }, 'renderer')
    }
    return { action: 'deny' }
  })
}

export function setupWindowSecurity(
  mainWindow: BrowserWindow,
  getSettings: () => BrowserSettings,
  onDataSaved?: (data: PersistedData) => void
): void {
  securitySettings = getSettings
  securityDataSaved = onDataSaved
  for (const targetSession of persistentBrowserSessions()) {
    configurePermissionsForSession(targetSession)
    configureDisplayMediaForSession(targetSession)
    configureSecurityHeaders(targetSession)
  }

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    if (src && !isSafeWebUrl(src)) {
      event.preventDefault()
      return
    }

    // Replace any renderer-supplied preload with Vast's narrowly scoped,
    // event-only autofill bridge. It exposes no Node or main-renderer API.
    webPreferences.preload = join(__dirname, '../preload/guest-autofill.js')
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.transparent = false
  })
  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    installWindowOpenRouting(guestContents)
  })

  const guardMainChromeNavigation = (event: Electron.Event, url: string): void => {
    const trusted = isTrustedRendererUrl(url, {
      isPackaged: app.isPackaged,
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      packagedRendererPath: join(__dirname, '../renderer/index.html')
    })
    if (!trusted) event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', guardMainChromeNavigation)
  mainWindow.webContents.on('will-redirect', guardMainChromeNavigation)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (sessionSecurityListenersRegistered) return
  sessionSecurityListenersRegistered = true

  app.on('web-contents-created', (_event, contents) => {
    installGuestRuntimeEventHandling(contents)
    contents.once('destroyed', () => clearExternalProtocolRequestsForContents(contents.id))
    if (constructingAuthWindowContext) {
      registerAuthCompatibilityContents(contents, constructingAuthWindowContext)
    }
    applySpoofingToWebContents(contents)
    contents.on('render-process-gone', (_goneEvent, details) => {
      const guest = Boolean((contents as Electron.WebContents & { hostWebContents?: unknown }).hostWebContents)
      void recordDiagnosticsEvent(guest ? 'guest' : 'renderer', 'render-process-gone', {
        webContentsId: contents.id,
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    contents.on('unresponsive', () => {
      void recordDiagnosticsEvent(
        (contents as Electron.WebContents & { hostWebContents?: unknown }).hostWebContents ? 'guest' : 'renderer',
        'unresponsive',
        { webContentsId: contents.id }
      )
    })
    contents.on('responsive', () => {
      void recordDiagnosticsEvent(
        (contents as Electron.WebContents & { hostWebContents?: unknown }).hostWebContents ? 'guest' : 'renderer',
        'responsive',
        { webContentsId: contents.id }
      )
    })
    contents.on('did-start-navigation', (_navigationEvent, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) applySpoofingToWebContents(contents)
    })

    ;(contents as unknown as {
      on: (channel: 'app-command', listener: (event: { preventDefault: () => void }, command: string) => void) => void
    }).on('app-command', (event, command) => {
      if (command !== 'browser-backward' && command !== 'browser-forward') return
      const window = ownerWindowForWebContents(contents)
      if (!window) return
      event.preventDefault()
      window.webContents.send('vast:shortcut', command === 'browser-backward' ? 'back' : 'forward')
    })

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return

      const key = input.key.toLowerCase()
      const meta = input.control || input.meta
      let shortcut: string | undefined

      const shortcuts = currentSecuritySettings().keyboardShortcuts
      for (const [name, value] of Object.entries(shortcuts)) {
        if (matchesInputShortcut(input, value)) {
          shortcut = name
          break
        }
      }
      if (!shortcut && meta && /^[1-9]$/.test(key)) shortcut = `tab:${key}`

      if (shortcut) {
        const window = ownerWindowForWebContents(contents)
        if (!window) return
        event.preventDefault()
        window.webContents.send('vast:shortcut', shortcut)
      }
    })

    installWindowOpenRouting(contents)

    const guardWebNavigation = (event: Electron.Event, url: string): void => {
      const isWebviewGuest = !!(contents as Electron.WebContents & { hostWebContents?: unknown }).hostWebContents
      if (trustedInternalNavigationWebContents.has(contents.id)) {
        const protocol = protocolOf(url)
        if (protocol === 'file:' || protocol === 'data:' || isSafeWebUrl(url)) return
        event.preventDefault()
        return
      }

      if (isWebviewGuest && isGoogleIdentityProviderUrl(url)) {
        event.preventDefault()
        if (directAuthOpeners.has(contents.id)) return
        directAuthOpeners.add(contents.id)
        lastGoogleAuthStatus = 'opening-direct-auth-window'
        logOAuthPopupFlow(`direct Google auth window requested opener=${contents.id} url=${redactedUrlForLog(url)}`)
        try {
          createOAuthPopupWindow(
            {
              width: 520,
              height: 680,
              webPreferences: {
                session: contents.session,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false
              }
            },
            {
              opener: contents,
              initialUrl: url,
              disposition: 'current-tab-auth-handoff',
              frameName: 'vast-google-auth',
              directNavigation: true
            }
          )
        } catch (error) {
          directAuthOpeners.delete(contents.id)
          lastGoogleAuthStatus = 'auth-window-create-failed'
          logOAuthPopupFlow(`direct Google auth window failed opener=${contents.id} error=${error instanceof Error ? error.name : 'unknown'}`)
        }
        return
      }

      if (
        (isWebviewGuest || trustedOAuthPopupWebContents.has(contents.id)) &&
        requestExternalProtocolOpen(contents, url)
      ) {
        event.preventDefault()
        return
      }

      if (trustedOAuthPopupWebContents.has(contents.id)) {
        if (isSafeOAuthPopupNavigationUrl(url)) return
        event.preventDefault()
        return
      }

      const window = ownerWindowForWebContents(contents)
      const isGuardedPopup = adBlockGuardedPopupWebContents.has(contents.id)
      if (isGuardedPopup && requestExternalProtocolOpen(contents, url)) {
        event.preventDefault()
        return
      }
      const settings = currentSecuritySettings()
      if ((isWebviewGuest || isGuardedPopup) && settings.privacy.adBlockerEnabled && settings.privacy.adBlockerMode === 'strict' && isStrictAdNavigationUrl(url)) {
        logOAuthPopupFlow(`blocked strict ad navigation contents=${contents.id} url=${redactedUrlForLog(url)}`)
        event.preventDefault()
        return
      }

      if (window && contents === window.webContents) {
        const trusted = isTrustedRendererUrl(url, {
          isPackaged: app.isPackaged,
          rendererUrl: process.env.ELECTRON_RENDERER_URL,
          packagedRendererPath: join(__dirname, '../renderer/index.html')
        })
        if (!trusted) event.preventDefault()
        return
      }

      if (!isSafeWebUrl(url)) {
        event.preventDefault()
      }
    }
    contents.on('will-navigate', guardWebNavigation)
    contents.on('will-redirect', guardWebNavigation)
  })

  app.on('session-created', (targetSession) => {
    configurePermissionsForSession(targetSession)
    configureDisplayMediaForSession(targetSession)
    configureSecurityHeaders(targetSession)
  })
}

export async function clearSiteData(origin?: string, webContentsId?: number): Promise<void> {
  const requestedContents = webContentsId ? webContents.fromId(webContentsId) : undefined
  if (webContentsId && (!requestedContents || requestedContents.isDestroyed() || !ownerWindowForWebContents(requestedContents))) {
    throw new Error('The active page is no longer available.')
  }
  const sessions = requestedContents
    ? [requestedContents.session]
    : configuredTrackerSessions.size > 0 ? [...configuredTrackerSessions] : [session.defaultSession]
  const normalizedOrigin = origin && /^https?:\/\//.test(origin) ? new URL(origin).origin : undefined
  await Promise.all(
    sessions.map(async (targetSession) => {
      await targetSession.clearData(normalizedOrigin ? {
        origins: [normalizedOrigin],
        originMatchingMode: 'origin-in-all-contexts',
        dataTypes: ['cache', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL']
      } : undefined)
    })
  )
}

export async function checkpointBrowserSessionData(): Promise<number> {
  return checkpointPersistentBrowserSessions(configuredTrackerSessions)
}

export async function configureWebContentsIdentity(
  webContentsId: number,
  identity: WorkspaceIdentitySettings,
  requestedUrl: string,
  identityId: string
): Promise<void> {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) throw new Error('Invalid web contents identifier.')
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || !ownerWindowForWebContents(contents)) throw new Error('The active page is no longer available.')
  if (!['isolated', 'shared', 'ephemeral'].includes(identity.sessionMode)) throw new Error('Invalid workspace session mode.')
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(identityId)) throw new Error('Invalid workspace identity.')
  if (!['system', 'direct', 'fixed'].includes(identity.proxyMode)) throw new Error('Invalid workspace proxy mode.')
  if (identity.proxyServer.length > 2_048 || identity.proxyBypassRules.length > 2_048) throw new Error('Proxy configuration is too long.')

  const proxySignature = `${identity.proxyMode}\u0000${identity.proxyServer.trim()}\u0000${identity.proxyBypassRules.trim()}`
  if (configuredIdentityProxies.get(contents.session) !== proxySignature) {
    configuredIdentityProxies.set(contents.session, proxySignature)
    try {
      if (identity.proxyMode === 'fixed') {
        if (!/^(?:https?|socks[45]?):\/\/[^\s]+$/i.test(identity.proxyServer.trim())) throw new Error('Enter a valid HTTP(S) or SOCKS proxy URL.')
        await contents.session.setProxy({
          mode: 'fixed_servers',
          proxyRules: identity.proxyServer.trim(),
          proxyBypassRules: identity.proxyBypassRules.trim()
        })
      } else {
        await contents.session.setProxy({ mode: identity.proxyMode })
      }
    } catch (error) {
      configuredIdentityProxies.delete(contents.session)
      throw error
    }
  }
  if (identity.sessionMode === 'shared') sessionIdentityScopes.delete(contents.session)
  else sessionIdentityScopes.set(contents.session, identityId)

  const settings = currentSecuritySettings()
  const exception = hostMatchesList(requestedUrl, settings.privacy.webRtcExceptions)
  const policy = exception || settings.privacy.webRtcPolicy === 'default'
    ? 'default'
    : settings.privacy.webRtcPolicy === 'disabled'
      ? 'disable_non_proxied_udp'
      : 'default_public_interface_only'
  contents.setWebRTCIPHandlingPolicy(policy)
}

export function privacyDocumentScriptForWebContents(contents: Electron.WebContents, requestedUrl: string): string {
  if (contents.isDestroyed() || !ownerWindowForWebContents(contents)) return ''
  const actualUrl = contents.getURL()
  try {
    if (actualUrl && new URL(requestedUrl).origin !== new URL(actualUrl).origin) return ''
  } catch {
    return ''
  }
  if (shouldBypassVastInterference({ url: requestedUrl, authWindow: authCompatibilityWebContents.has(contents.id) })) return ''
  const settings = currentSecuritySettings()
  if (spoofingFromSettings(settings).enabled || hostMatchesList(requestedUrl, settings.privacy.fingerprintingExceptions)) return ''
  const sessionSeed = createHash('sha256')
    .update(contents.session.storagePath ?? `temporary:${contents.id}`)
    .digest('hex')
    .slice(0, 16)
  const disableWebRtc = settings.privacy.webRtcPolicy === 'disabled' && !hostMatchesList(requestedUrl, settings.privacy.webRtcExceptions)
  const fingerprintingMode = settings.privacy.adBlockerMode === 'strict' && settings.privacy.fingerprintingProtection === 'standard'
    ? 'strict'
    : settings.privacy.fingerprintingProtection
  return buildFingerprintingProtectionScript(fingerprintingMode, sessionSeed, disableWebRtc)
}

export async function getSiteInformation(webContentsId: number, requestedUrl: string): Promise<SiteInformation> {
  const { inspectSiteInformation } = await import('./sessions/site-information')
  return inspectSiteInformation(webContentsId, requestedUrl, {
    blockedCountsFor: (id) => blockedRequestCounts.get(id) ?? { trackers: 0, ads: 0, malware: 0 },
    currentSettings: currentSecuritySettings,
    identityScopeFor: (targetSession) => sessionIdentityScopes.get(targetSession),
    ownsWebContents: (contents) => Boolean(ownerWindowForWebContents(contents))
  })
}

export async function requestOAuthExternalFallback(input: unknown, mainWindow: BrowserWindow | undefined = currentSecurityWindow()): Promise<void> {
  const { requestOAuthFallback } = await import('./sessions/external-navigation')
  await requestOAuthFallback(input, mainWindow, {
    isSafeWebUrl,
    logOAuthPopupFlow,
    redactUrl: redactedUrlForLog
  })
}

export async function openExternalUrl(
  url: string,
  mainWindow?: BrowserWindow,
  settings?: BrowserSettings
): Promise<void> {
  const { openExternalWebUrl } = await import('./sessions/external-navigation')
  await openExternalWebUrl(url, mainWindow, settings, isSafeWebUrl)
}
