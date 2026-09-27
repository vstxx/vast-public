import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BaseWindow, BrowserWindow, Extension, Session, WebContents } from 'electron/main'
import { INTERNAL_NEW_TAB_URL } from '../../shared/constants.ts'
import type { BrowserTabOpenRequest, ExtensionCompatibilityTabCommand } from '../../shared/types.ts'
import {
  ChromePrivacySettingsStore,
  type ChromePrivacyDetails,
  type ChromePrivacyServiceKey
} from './chrome-privacy-settings.ts'

export const ECE_GPL_LICENSE = 'GPL-3.0' as const

export interface ExtensionCompatibilityGateInput {
  isPackaged: boolean
  appVersion?: string
  electronVersion: string
  executablePath: string
  env: NodeJS.ProcessEnv
  approvedRuntime?: ExtensionCompatibilityApprovedRuntime
  packagedEvidence?: ExtensionCompatibilityPackagedEvidence
}

export interface ExtensionCompatibilityApprovedRuntime {
  electron: {
    version: string
    patchsetRevision: string
    patchsetSha256: string
    binary: { sha256: string }
  }
  ece: {
    version: string
    patchSha256: string
    runtimeSha256: string
  }
}

export interface ExtensionCompatibilityPackagedEvidence {
  fingerprint: unknown
  releaseMetadata: unknown
  distributionMarker: unknown
}

export interface ExtensionCompatibilityPackagedEvidenceResult {
  evidence?: ExtensionCompatibilityPackagedEvidence
  error?: string
}

export function readPackagedCompatibilityEvidence(input: {
  appPath: string
  executablePath: string
}): ExtensionCompatibilityPackagedEvidenceResult {
  const readJson = (filePath: string): unknown => JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  let fingerprint: unknown
  let releaseMetadata: unknown
  let distributionMarker: unknown
  try {
    fingerprint = readJson(join(input.appPath, 'out', 'extension-compatibility-runtime-fingerprint.json'))
  } catch {
    return { error: 'packaged compatibility fingerprint is unavailable or invalid' }
  }
  try {
    releaseMetadata = readJson(join(input.appPath, 'out', 'release-build-metadata.json'))
  } catch {
    return { error: 'packaged release metadata is unavailable or invalid' }
  }
  try {
    distributionMarker = readJson(join(dirname(input.executablePath), '.vast-electron-dist.json'))
  } catch {
    return { error: 'packaged Electron distribution marker is unavailable or invalid' }
  }
  return { evidence: { fingerprint, releaseMetadata, distributionMarker } }
}

export interface ExtensionCompatibilityGate {
  enabled: boolean
  reason: string
  license?: typeof ECE_GPL_LICENSE
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function packagedCompatibilityGate(input: ExtensionCompatibilityGateInput): ExtensionCompatibilityGate {
  const approved = input.approvedRuntime
  const evidence = input.packagedEvidence
  if (!approved || !evidence) return { enabled: false, reason: 'packaged compatibility attestation is missing' }
  const fingerprint = objectValue(evidence.fingerprint)
  const metadata = objectValue(evidence.releaseMetadata)
  const marker = objectValue(evidence.distributionMarker)
  if (!fingerprint || !metadata || !marker) return { enabled: false, reason: 'packaged compatibility attestation is malformed' }
  if (!input.appVersion || metadata.version !== input.appVersion) {
    return { enabled: false, reason: 'packaged release metadata version does not match the application' }
  }
  if (metadata.sourceCommit !== fingerprint.vastSourceCommit) {
    return { enabled: false, reason: 'packaged release metadata source commit does not match the compatibility fingerprint' }
  }
  if (!isDeepStrictEqual(metadata.extensionCompatibilityRuntime, fingerprint)) {
    return { enabled: false, reason: 'packaged release metadata fingerprint does not match the compatibility fingerprint' }
  }
  if (
    fingerprint.schemaVersion !== 2 ||
    fingerprint.manifest !== 'patches/extension-compatibility-runtime.json' ||
    fingerprint.electronVersion !== approved.electron.version ||
    fingerprint.electronPatchsetRevision !== approved.electron.patchsetRevision ||
    fingerprint.electronPatchsetSha256 !== approved.electron.patchsetSha256 ||
    fingerprint.electronBinarySha256 !== approved.electron.binary.sha256 ||
    fingerprint.eceVersion !== approved.ece.version ||
    fingerprint.ecePatchSha256 !== approved.ece.patchSha256 ||
    fingerprint.eceRuntimeSha256 !== approved.ece.runtimeSha256 ||
    !/^[a-f0-9]{40}$/.test(String(fingerprint.vastSourceCommit ?? '')) ||
    fingerprint.vastDirty !== false ||
    fingerprint.releaseMode !== true ||
    input.electronVersion !== approved.electron.version
  ) {
    return { enabled: false, reason: 'packaged compatibility fingerprint does not match the approved runtime' }
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.electronVersion !== approved.electron.version ||
    marker.patchsetRevision !== approved.electron.patchsetRevision ||
    marker.patchsetSha256 !== approved.electron.patchsetSha256 ||
    marker.electronBinarySha256 !== approved.electron.binary.sha256
  ) {
    return { enabled: false, reason: 'packaged Electron distribution marker does not match the approved runtime' }
  }
  return { enabled: true, reason: 'verified packaged compatibility runtime', license: ECE_GPL_LICENSE }
}

export function extensionCompatibilityGate(input: ExtensionCompatibilityGateInput): ExtensionCompatibilityGate {
  if (input.env.VAST_EXTENSION_COMPATIBILITY_DISABLE === '1') return { enabled: false, reason: 'internal rollback switch is on' }
  if (input.isPackaged) return packagedCompatibilityGate(input)
  if (input.env.VAST_EXTENSION_COMPATIBILITY !== '1') return { enabled: false, reason: 'feature flag is off' }
  if (input.env.VAST_PATCHED_ELECTRON_COMPAT !== '1') return { enabled: false, reason: 'patched-Electron marker is missing' }
  if (input.electronVersion !== '44.3.0') return { enabled: false, reason: `Electron ${input.electronVersion} is not the validated 44.3.0 base` }

  const expectedDist = input.env.VAST_PATCHED_ELECTRON_DIST?.trim()
  if (!expectedDist) return { enabled: false, reason: 'VAST_PATCHED_ELECTRON_DIST is missing' }
  const normalizedExecutable = input.executablePath.replaceAll('\\', '/').toLowerCase()
  const normalizedDist = expectedDist.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  if (!normalizedExecutable.startsWith(`${normalizedDist}/`)) {
    return { enabled: false, reason: 'the running executable is outside VAST_PATCHED_ELECTRON_DIST' }
  }

  return { enabled: true, reason: 'validated development compatibility runtime', license: ECE_GPL_LICENSE }
}

export interface ChromePermissionRequest {
  permissions?: string[]
  origins?: string[]
}

export interface ChromePrivacyRequest {
  key: string
  value?: unknown
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
}

/** Chrome permits permissions.request only for permissions declared optional. */
export function isDeclaredOptionalPermissionRequest(extension: Pick<Extension, 'manifest'>, request: ChromePermissionRequest): boolean {
  const manifest = extension.manifest as Record<string, unknown>
  const optionalPermissions = stringSet(manifest.optional_permissions)
  const optionalOrigins = stringSet(manifest.optional_host_permissions)
  const requestedPermissions = Array.isArray(request.permissions) ? request.permissions : []
  const requestedOrigins = Array.isArray(request.origins) ? request.origins : []
  if (requestedPermissions.length === 0 && requestedOrigins.length === 0) return false
  return requestedPermissions.every((permission) => optionalPermissions.has(permission)) &&
    requestedOrigins.every((origin) => optionalOrigins.has(origin))
}

interface EceInstance {
  addTab(tab: WebContents, window: BaseWindow): void
  removeTab(tab: WebContents): void
  selectTab(tab: WebContents): void
}

interface EceModule {
  ElectronChromeExtensions: new (options: Record<string, unknown>) => EceInstance
}

interface NativeExtensionActionEvents {
  on?: (
    event: 'extension-action-open-popup',
    listener: (event: unknown, extensionId: string, senderWebContentsId: number) => void
  ) => unknown
}

interface PendingTab {
  id: string
  session: Session
  window: BrowserWindow
  resolve: (value: [WebContents, BaseWindow]) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export interface ExtensionCompatibilityRuntimeOptions {
  gate: ExtensionCompatibilityGate
  loadEce?: () => Promise<EceModule>
  focusedWindow: () => BrowserWindow | undefined
  windowById: (id: number) => BrowserWindow | undefined
  dispatchTabOpen: (window: BrowserWindow, request: BrowserTabOpenRequest) => boolean
  dispatchTabCommand: (window: BrowserWindow, command: ExtensionCompatibilityTabCommand) => void
  dispatchPopupOpen: (window: BrowserWindow, extensionId: string) => boolean
  getGrantedPermissions?: (extension: Extension) => ChromePermissionRequest
  persistGrantedPermissions?: (extension: Extension, permissions: ChromePermissionRequest) => Promise<boolean>
  removeGrantedPermissions?: (extension: Extension, permissions: ChromePermissionRequest) => Promise<boolean>
  requestPermissionApproval?: (extension: Extension, request: ChromePermissionRequest) => Promise<boolean>
  privacyStatePathForSession?: (session: Session) => string
  allowTestPermissionGrant?: boolean
  tabCreationTimeoutMs?: number
}

/**
 * Adapter between Vast-owned tabs and ECE-owned Chrome API state. Production
 * use is permitted only by the packaged attestation gate above. It contains no
 * network hooks; the patched native request pipeline remains the sole composer
 * for Vast session.webRequest and extension chrome.webRequest.
 */
export class ExtensionCompatibilityRuntime {
  enabled: boolean
  reason: string
  private readonly options: ExtensionCompatibilityRuntimeOptions
  private readonly instances = new Map<Session, EceInstance>()
  private readonly privacyStores = new Map<Session, ChromePrivacySettingsStore>()
  private readonly tabs = new Map<number, { contents: WebContents; window: BrowserWindow; instance: EceInstance }>()
  private readonly pendingTabs = new Map<string, PendingTab>()
  private vastTabNotificationDepth = 0
  private modulePromise?: Promise<EceModule>
  private initializationFailure?: Error

  constructor(options: ExtensionCompatibilityRuntimeOptions) {
    this.options = options
    this.enabled = options.gate.enabled
    this.reason = options.gate.reason
  }

  async prepareSession(targetSession: Session): Promise<void> {
    if (this.initializationFailure) throw this.initializationFailure
    if (!this.enabled || this.instances.has(targetSession)) return
    try {
      const module = await (this.modulePromise ??= (this.options.loadEce ?? (() => import('electron-chrome-extensions') as unknown as Promise<EceModule>))())
      const license = this.options.gate.license
      if (!license) throw new Error('ECE license was not selected.')
      const instance = new module.ElectronChromeExtensions({
        license,
        session: targetSession,
        createTab: (details: { url?: string; active?: boolean; windowId?: number }) => this.createTab(targetSession, details),
        selectTab: (tab: WebContents, window: BaseWindow) => this.commandTab(tab, window, 'select'),
        removeTab: (tab: WebContents, window: BaseWindow) => this.commandTab(tab, window, 'remove'),
        openPopup: (extension: Extension, tab: WebContents, window: BaseWindow) =>
          this.openPopup(targetSession, extension, tab, window),
        getGrantedPermissions: (extension: Extension) => this.enabled
          ? this.options.getGrantedPermissions?.(extension) ?? { permissions: [], origins: [] }
          : { permissions: [], origins: [] },
        requestPermissions: (extension: Extension, request: ChromePermissionRequest) => this.requestPermissions(extension, request),
        removePermissions: (extension: Extension, request: ChromePermissionRequest) => this.removePermissions(extension, request),
        getPrivacySetting: (extension: Extension, request: ChromePrivacyRequest) => this.getPrivacySetting(targetSession, extension, request),
        setPrivacySetting: (extension: Extension, request: ChromePrivacyRequest) => this.setPrivacySetting(targetSession, extension, request),
        clearPrivacySetting: (extension: Extension, request: ChromePrivacyRequest) => this.clearPrivacySetting(targetSession, extension, request)
      })
      this.instances.set(targetSession, instance)
      const nativeActionEvents = targetSession.extensions as typeof targetSession.extensions & NativeExtensionActionEvents
      nativeActionEvents?.on?.('extension-action-open-popup', (_event, extensionId, senderWebContentsId) => {
        this.routeNativeActionPopup(targetSession, extensionId, senderWebContentsId)
      })
    } catch {
      throw this.failClosed()
    }
  }

  private failClosed(): Error {
    if (this.initializationFailure) return this.initializationFailure
    this.enabled = false
    this.reason = 'disabled after compatibility runtime initialization failure'
    this.initializationFailure = new Error('Extension compatibility runtime initialization failed; compatibility layer is disabled.')
    for (const pending of this.pendingTabs.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.initializationFailure)
    }
    this.pendingTabs.clear()
    this.tabs.clear()
    return this.initializationFailure
  }

  private async requestPermissions(extension: Extension, request: ChromePermissionRequest): Promise<boolean> {
    if (!this.enabled) return false
    if (!isDeclaredOptionalPermissionRequest(extension, request)) return false
    const approved = this.options.allowTestPermissionGrant === true ||
      await this.options.requestPermissionApproval?.(extension, request) === true
    if (!approved) return false
    return await this.options.persistGrantedPermissions?.(extension, request) === true
  }

  private async removePermissions(extension: Extension, request: ChromePermissionRequest): Promise<boolean> {
    if (!this.enabled) return false
    if (!isDeclaredOptionalPermissionRequest(extension, request)) return false
    const removed = await this.options.removeGrantedPermissions?.(extension, request) === true
    if (removed && request.permissions?.includes('privacy')) await this.removePrivacyControl(extension.id)
    return removed
  }

  async removePrivacyControl(extensionId: string): Promise<void> {
    await Promise.all([...this.privacyStores.values()].map((store) => store.removeExtension(extensionId)))
  }

  private privacyStore(targetSession: Session): ChromePrivacySettingsStore {
    const existing = this.privacyStores.get(targetSession)
    if (existing) return existing
    const statePath = this.options.privacyStatePathForSession?.(targetSession)
    if (!statePath) throw new Error('Chrome privacy settings store is unavailable.')
    const store = new ChromePrivacySettingsStore(statePath)
    this.privacyStores.set(targetSession, store)
    return store
  }

  private assertPrivacyPermission(extension: Extension): void {
    if (!/^[a-p]{32}$/.test(extension.id)) throw new Error('Invalid Chrome extension ID.')
    const manifest = extension.manifest as Record<string, unknown>
    const required = stringSet(manifest.permissions)
    const optional = stringSet(manifest.optional_permissions)
    if (required.has('privacy')) return
    const granted = new Set(this.options.getGrantedPermissions?.(extension).permissions ?? [])
    if (!optional.has('privacy') || !granted.has('privacy')) {
      throw new Error('Chrome privacy permission is not granted.')
    }
  }

  private async getPrivacySetting(
    targetSession: Session,
    extension: Extension,
    request: ChromePrivacyRequest
  ): Promise<ChromePrivacyDetails> {
    if (!this.enabled) throw new Error('Extension compatibility layer is disabled.')
    this.assertPrivacyPermission(extension)
    return this.privacyStore(targetSession).get(extension.id, request.key as ChromePrivacyServiceKey)
  }

  private async setPrivacySetting(
    targetSession: Session,
    extension: Extension,
    request: ChromePrivacyRequest
  ): Promise<ChromePrivacyDetails> {
    if (!this.enabled) throw new Error('Extension compatibility layer is disabled.')
    this.assertPrivacyPermission(extension)
    return this.privacyStore(targetSession).set(extension.id, request.key as ChromePrivacyServiceKey, request.value as boolean)
  }

  private async clearPrivacySetting(
    targetSession: Session,
    extension: Extension,
    request: ChromePrivacyRequest
  ): Promise<ChromePrivacyDetails> {
    if (!this.enabled) throw new Error('Extension compatibility layer is disabled.')
    this.assertPrivacyPermission(extension)
    return this.privacyStore(targetSession).clear(extension.id, request.key as ChromePrivacyServiceKey)
  }

  attachTab(contents: WebContents, window: BrowserWindow): void {
    if (!this.enabled || contents.isDestroyed()) return
    const instance = this.instances.get(contents.session)
    if (!instance || this.tabs.has(contents.id)) return
    this.vastTabNotificationDepth++
    try {
      instance.addTab(contents, window)
    } finally {
      this.vastTabNotificationDepth--
    }
    this.tabs.set(contents.id, { contents, window, instance })
    contents.once('destroyed', () => {
      this.tabs.delete(contents.id)
    })
  }

  selectTab(contents: WebContents): void {
    const tracked = this.tabs.get(contents.id)
    if (!this.enabled || !tracked || contents.isDestroyed()) return
    this.vastTabNotificationDepth++
    try {
      tracked.instance.selectTab(contents)
    } finally {
      this.vastTabNotificationDepth--
    }
  }

  confirmCreatedTab(requestId: string, contents: WebContents, senderWindow: BrowserWindow): boolean {
    const pending = this.pendingTabs.get(requestId)
    const tracked = this.tabs.get(contents.id)
    if (!this.enabled || !pending || !tracked) return false
    if (pending.window !== senderWindow || tracked.window !== senderWindow || contents.session !== pending.session) return false
    clearTimeout(pending.timer)
    this.pendingTabs.delete(requestId)
    pending.resolve([contents, senderWindow])
    return true
  }

  private createTab(targetSession: Session, details: { url?: string; active?: boolean; windowId?: number }): Promise<[WebContents, BaseWindow]> {
    if (!this.enabled) return Promise.reject(new Error('Extension compatibility layer is disabled.'))
    const targetWindow = typeof details.windowId === 'number'
      ? this.options.windowById(details.windowId)
      : this.options.focusedWindow()
    if (!targetWindow || targetWindow.isDestroyed()) return Promise.reject(new Error('No Vast window is available for chrome.tabs.create.'))

    const id = randomUUID()
    return new Promise<[WebContents, BaseWindow]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTabs.delete(id)
        reject(new Error('Timed out waiting for Vast to attach the chrome.tabs.create webview.'))
      }, this.options.tabCreationTimeoutMs ?? 15_000)
      this.pendingTabs.set(id, { id, session: targetSession, window: targetWindow, resolve, reject, timer })
      const delivered = this.options.dispatchTabOpen(targetWindow, {
        url: details.url || INTERNAL_NEW_TAB_URL,
        disposition: details.active === false ? 'background-tab' : 'foreground-tab',
        activate: details.active !== false,
        compatibilityRequestId: id
      })
      if (!delivered) {
        clearTimeout(timer)
        this.pendingTabs.delete(id)
        reject(new Error('Vast renderer is unavailable for chrome.tabs.create.'))
      }
    })
  }

  private async openPopup(
    targetSession: Session,
    extension: Extension,
    tab: WebContents,
    baseWindow: BaseWindow
  ): Promise<boolean> {
    const report = (outcome: string): void => {
      console.info('[extensions:compatibility] popup-route', JSON.stringify({
        extensionId: extension.id,
        outcome,
        tabId: tab.id,
        baseWindowId: baseWindow.id
      }))
    }
    if (!this.enabled) { report('compatibility-disabled'); return false }
    if (tab.isDestroyed()) { report('tab-destroyed'); return false }
    if (tab.session !== targetSession) { report('session-mismatch'); return false }
    if (!targetSession.extensions.getExtension(extension.id)) { report('extension-not-loaded'); return false }
    const tracked = this.tabs.get(tab.id)
    const instance = this.instances.get(targetSession)
    if (!tracked) { report('tab-not-tracked'); return false }
    if (!instance) { report('session-not-prepared'); return false }
    if (tracked.instance !== instance) { report('instance-mismatch'); return false }
    if (tracked.window !== baseWindow) { report('window-mismatch'); return false }
    const dispatched = this.options.dispatchPopupOpen(tracked.window, extension.id)
    report(dispatched ? 'renderer-dispatched' : 'renderer-unavailable')
    return dispatched
  }

  private routeNativeActionPopup(
    targetSession: Session,
    extensionId: string,
    senderWebContentsId: number
  ): void {
    if (!this.enabled || !/^[a-p]{32}$/.test(extensionId) || !Number.isSafeInteger(senderWebContentsId)) return
    const extension = targetSession.extensions.getExtension(extensionId)
    const tracked = this.tabs.get(senderWebContentsId)
    if (!extension || !tracked || tracked.contents.session !== targetSession) return
    void this.openPopup(targetSession, extension, tracked.contents, tracked.window)
  }

  private commandTab(tab: WebContents, baseWindow: BaseWindow, action: ExtensionCompatibilityTabCommand['action']): void {
    // ECE invokes selectTab for its own active-tab bookkeeping while Vast is
    // notifying it of a selection. Echoing that callback back to Vast causes
    // restored tabs to steal focus from one another indefinitely.
    if (action === 'select' && this.vastTabNotificationDepth > 0) return
    const tracked = this.tabs.get(tab.id)
    const window = tracked?.window ?? (baseWindow as BrowserWindow)
    // ECE observes WebContents destruction and routes its internal cleanup
    // through the same removeTab callback used by chrome.tabs.remove. Ignore
    // that cleanup callback: Vast already removed/replaced the guest.
    if (!this.enabled || tab.isDestroyed() || !window || window.isDestroyed()) return
    this.options.dispatchTabCommand(window, { action, webContentsId: tab.id })
  }
}
