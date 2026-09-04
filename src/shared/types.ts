import type { RelayActionResult, RelayClientSnapshot } from './relay-types'
import type { VastExtensionKind, VastNativeRuntimeState, VastNativePermission, VastPermissionMetadata, VastExtensionContributionSnapshot, VastUiBrokerRequest, VastUiBrokerResponse } from './extension-native-api'
import type { ExtensionInstallSource, ExtensionPackagePreview, ExtensionTrustLevel, ExtensionUpdateState, VastHubCatalogResult, VastHubExtensionDetails } from './extension-marketplace'

export type ID = string

export type ThemePreference = 'dark' | 'dim' | 'light' | 'system'
export type SidebarDensity = 'comfortable' | 'compact'
export type StartupBehavior = 'restore' | 'new-tab' | 'home'
export type NewTabBehavior = 'vast' | 'search' | 'blank'
export type LayoutMode = 'vertical' | 'horizontal' | 'purist'
export type TabStatus = 'idle' | 'loading' | 'error'
export type TabLifecycle = 'active' | 'sleeping' | 'discarded' | 'crashed'
export type SidePanelView = 'notes' | 'bookmarks' | 'history' | 'downloads' | 'reading-list'
export type MacroTriggerType = 'manual' | 'command-palette' | 'startup' | 'workspace-opened' | 'new-tab-opened' | 'time'
export type NetworkDeviceSource = 'mdns' | 'ssdp' | 'probe' | 'arp' | 'manual' | 'mock'
export type NetworkDeviceCategory = 'audio' | 'tv' | 'cast' | 'computer' | 'phone' | 'printer' | 'router' | 'nas' | 'smart-home' | 'unknown'
export type MacroActionType =
  | 'open-url-current'
  | 'open-url-new-tab'
  | 'open-multiple-urls'
  | 'open-internal-page'
  | 'switch-workspace'
  | 'create-workspace'
  | 'create-note'
  | 'append-note'
  | 'open-side-panel'
  | 'save-reading-list'
  | 'save-session-snapshot'
  | 'close-duplicate-tabs'
  | 'hibernate-inactive-tabs'
  | 'toggle-focus-mode'
  | 'run-command'

export interface SearchEngine {
  id: string
  name: string
  shortcut: string
  searchUrl: string
  homeUrl: string
}

export interface TabGroup {
  id: ID
  workspaceId: ID
  name: string
  color: string
  collapsed: boolean
  order: number
}

export interface Tab {
  id: ID
  workspaceId: ID
  /** Optional workspace whose isolated browser identity this tab borrows. */
  identityWorkspaceId?: ID
  groupId?: ID
  title: string
  url: string
  displayUrl?: string
  favicon?: string
  pinned: boolean
  muted?: boolean
  loginFormDetected?: boolean
  status: TabStatus
  lifecycle: TabLifecycle
  progress: number
  canGoBack: boolean
  canGoForward: boolean
  error?: {
    code: number
    description: string
    validatedUrl: string
  }
  zoom: number
  lastAccessedAt: number
  createdAt: number
}

export interface DetachedTabPayload {
  url: string
  title?: string
  favicon?: string
  muted?: boolean
  zoom?: number
  sourceTabId?: ID
  sourceWorkspaceId?: ID
  sourceGroupId?: ID
}

/**
 * Main-process-authoritative request to add a URL to a Vast renderer's tab
 * model. The source guest id lets the renderer preserve workspace, group, and
 * private-session ownership without trusting renderer-supplied routing data.
 */
export interface TabOpenPostDataEntry {
  type: 'rawData' | 'file'
  bytes?: Uint8Array
  filePath?: string
  offset?: number
  length?: number
}

/**
 * Ephemeral navigation metadata captured from Electron's window-open handler so
 * a Vast-tab initial navigation matches what Chromium would have requested:
 * same URL, same referrer, same POST body. Never persisted to storage.
 */
export interface TabOpenNavigationMetadata {
  referrer?: { url: string; policy: string }
  postBody?: {
    contentType: string
    boundary?: string
    data: TabOpenPostDataEntry[]
  }
}

export interface BrowserTabOpenRequest {
  url: string
  sourceWebContentsId?: number
  disposition: string
  activate: boolean
  navigation?: TabOpenNavigationMetadata
}

export interface ExternalProtocolRequest {
  id: ID
  scheme: string
  sourceOrigin?: string
}

export interface HtmlFullscreenState {
  webContentsId: number
  active: boolean
}

export interface MediaCaptureState {
  webContentsId: number
  active: boolean
}

export interface RecentlyClosedTab {
  id: ID
  workspaceId: ID
  title: string
  url: string
  favicon?: string
  closedAt: number
}

export interface Workspace {
  id: ID
  name: string
  icon: string
  color: string
  order: number
  activeTabId?: ID
  isPrivate?: boolean
  identity?: WorkspaceIdentitySettings
  createdAt: number
  updatedAt: number
}

export type WorkspaceSessionMode = 'isolated' | 'shared' | 'ephemeral'
export type WorkspaceProxyMode = 'system' | 'direct' | 'fixed'

export interface WorkspaceIdentitySettings {
  sessionMode: WorkspaceSessionMode
  proxyMode: WorkspaceProxyMode
  proxyServer: string
  proxyBypassRules: string
}

export interface BookmarkFolder {
  id: ID
  name: string
  parentId?: ID
  order: number
  createdAt: number
  updatedAt?: number
}

export interface Bookmark {
  id: ID
  title: string
  url: string
  favicon?: string
  folderId?: ID
  workspaceId?: ID
  createdAt: number
  updatedAt: number
}

export interface HistoryEntry {
  id: ID
  title: string
  url: string
  favicon?: string
  visitCount: number
  lastVisitedAt: number
  workspaceId?: ID
}

export interface DownloadItem {
  id: ID
  filename: string
  url: string
  mimeType?: string
  savePath?: string
  sha256?: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  paused?: boolean
  bytesPerSecond?: number
  dangerType?: string
  scanStatus?: 'pending' | 'scanning' | 'clean' | 'suspicious' | 'dangerous' | 'scan-unavailable' | 'scan-failed'
  scanFindings?: string[]
  scannedSha256?: string
  scanCompletedAt?: number
  startedAt: number
  updatedAt: number
}

export type PermissionSetting = 'ask' | 'allow' | 'block'
export type SitePermissionKind = 'camera' | 'microphone' | 'media' | 'geolocation' | 'notifications' | 'clipboard' | 'fullscreen'
export interface SitePermissionOverride {
  origin: string
  workspaceId?: ID
  permission: SitePermissionKind
  setting: Exclude<PermissionSetting, 'ask'>
  updatedAt: number
}

export interface SiteInformation {
  kind: 'web' | 'internal'
  url: string
  origin?: string
  hostname?: string
  secure: boolean
  certificateStatus: 'validated-by-chromium' | 'not-applicable' | 'not-secure'
  cookieCount: number
  serviceWorkerCount: number
  storage: {
    cookies: number
    localStorageEntries: number
    indexedDBDatabases: number
    serviceWorkers: number
  }
  permissions: SitePermissionOverride[]
  blocked: { trackers: number; ads: number; malware: number }
  interventionsDisabled: boolean
}
export type AdBlockerMode = 'standard' | 'strict' | 'custom'
export type FingerprintingProtectionMode = 'standard' | 'strict' | 'maximum'
export type WebRtcPolicy = 'public-interface-only' | 'default' | 'disabled'

export interface PrivacyFilterStatus {
  updating: boolean
  lastUpdatedAt?: number
  nextUpdateAt?: number
  ruleCounts: Record<string, number>
  lastError?: string
  blockedSinceStart: { ads: number; trackers: number; malware: number }
}
export type SpoofingBrowserProfile = 'chrome-windows' | 'chrome-macos' | 'firefox-windows' | 'safari-macos' | 'custom'
export type SpoofingLocationMode = 'off' | 'fixed'

export interface BrowserSpoofingSettings {
  enabled: boolean
  browserProfile: SpoofingBrowserProfile
  customUserAgent: string
  languages: string[]
  timezone: string
  doNotTrack: boolean
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  webglVendor: string
  webglRenderer: string
  location: {
    mode: SpoofingLocationMode
    latitude: number
    longitude: number
    accuracy: number
  }
}

export interface BrowserSettings {
  theme: ThemePreference
  accentColor: string
  appearance: {
    secondaryAccentColor: string
    backgroundTintColor: string
    surfaceTintColor: string
    backgroundStyle: 'graphite' | 'midnight' | 'aurora' | 'violet' | 'carbon' | 'frost'
    cornerRadius: number
    glassIntensity: number
    blurIntensity: number
    glowIntensity: number
    borderIntensity: number
    shadowIntensity: number
    gradientIntensity: number
    panelOpacity: number
    chromeOpacity: number
    saturation: number
    forceDarkModeWebsites: boolean
  }
  sidebarDensity: SidebarDensity
  layoutMode: LayoutMode
  tabLayout: 'vertical' | 'compact'
  sidePanel: {
    mode: 'auto' | 'docked' | 'overlay'
    width: number
    showLabels: boolean
    positionX: number
    positionY: number
  }
  bookmarksBarVisible: boolean
  bookmarksBarOnlyOnNewTab: boolean
  hibernateInactiveTabs: boolean
  defaultSearchEngine: string
  startupBehavior: StartupBehavior
  newTabBehavior: NewTabBehavior
  newTab: {
    compactCards: boolean
    showQuickLinks: boolean
    showRecentPages: boolean
    showBookmarks: boolean
    showTodos: boolean
    showNotes: boolean
    showRecentlyClosed: boolean
    showWorkspaceSummary: boolean
    showSessionTimeline: boolean
  }
  commandPalette: {
    favoriteCommandIds: string[]
  }
  restorePreviousSession: boolean
  animations: boolean
  openingAnimation: boolean
  openingAnimationSoundVolume: number
  privacy: {
    blockTrackers: boolean
    adBlockerEnabled: boolean
    adBlockerMode: AdBlockerMode
    filterEasyList: boolean
    filterEasyPrivacy: boolean
    filterPeterLowe: boolean
    filterMalware: boolean
    filterPolishAnnoyances: boolean
    filterAutoUpdate: boolean
    customFilterRules: string
    adBlockAllowlist: string[]
    customBlockAds: boolean
    customBlockTrackers: boolean
    customBlockMalware: boolean
    customBlockThirdPartyCookies: boolean
    stripTrackingParameters: boolean
    stripAffiliateParameters: boolean
    blockThirdPartyCookies: boolean
    cookieExceptions: string[]
    clearSiteDataOnClose: string[]
    fingerprintingProtection: FingerprintingProtectionMode
    fingerprintingExceptions: string[]
    webRtcPolicy: WebRtcPolicy
    webRtcExceptions: string[]
    fakeHistoryEnabled: boolean
    clearCookiesOnExit: boolean
    privateWorkspaceDefault: boolean
    disableHistory: boolean
    disableRecentlyClosedTabs: boolean
    disablePageTextCapture: boolean
    disableFavicons: boolean
    siteInterventionsDisabled: string[]
  }
  spoofing: BrowserSpoofingSettings
  advanced: {
    ramLimitMb: number
    hibernateAfterMinutes: number
    discardAfterMinutes: number
    keepPinnedTabsAwake: boolean
    confirmBeforeClosingManyTabs: boolean
    confirmBeforeDeletingWorkspace: boolean
    showAdvancedBrowserActions: boolean
    showInternalPagesInCommandPalette: boolean
    experimentalFeatures: boolean
    developerMode: boolean
  }
  security: {
    httpsOnlyMode: boolean
    confirmExternalLinks: boolean
    warnDangerousDownloads: boolean
    alwaysConfirmAutofill: boolean
    permissionCamera: PermissionSetting
    permissionMicrophone: PermissionSetting
    permissionLocation: PermissionSetting
    permissionNotifications: PermissionSetting
    permissionClipboard: PermissionSetting
    permissionFullscreen: PermissionSetting
    sitePermissions: SitePermissionOverride[]
  }
  network: {
    enabled: boolean
    allowScans: boolean
    passiveDiscovery: boolean
    activeProbing: boolean
    rememberDevices: boolean
    showRawMetadata: boolean
    probeTimeoutMs: number
    probeConcurrency: number
    includeVpnAdapters: boolean
  }
  labs: {
    enabled: boolean
    avidae: boolean
    networkDevices: boolean
    automation: boolean
    passwordManager: boolean
    advancedDiagnostics: boolean
    spoofing: boolean
  }
  keyboardShortcuts: Record<string, string>
}

export type PermissionSettingKey = keyof Pick<
  BrowserSettings['security'],
  | 'permissionCamera'
  | 'permissionMicrophone'
  | 'permissionLocation'
  | 'permissionNotifications'
  | 'permissionClipboard'
  | 'permissionFullscreen'
>

export interface UiNotificationPayload {
  id: ID
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  detail?: string
  durationMs?: number
  actions?: Array<{ label: string; action: () => void }>
}

export type ExtensionCompatibility = 'compatible' | 'partial' | 'unsupported'
export type ExtensionRuntimeState = 'loaded' | 'disabled' | 'error'
export type { VastExtensionKind, VastNativeRuntimeState, VastNativePermission, VastPermissionMetadata, VastExtensionContributionSnapshot, VastUiBrokerRequest, VastUiBrokerResponse } from './extension-native-api'

export interface VastExtensionInfo {
  id: string
  name: string
  version: string
  description?: string
  path: string
  enabled: boolean
  source: ExtensionInstallSource
  trust: ExtensionTrustLevel
  publisherId?: string
  publisherName?: string
  category?: string
  firstParty: boolean
  removable: boolean
  update: {
    state: ExtensionUpdateState
    availableVersion?: string
    previousVersion?: string
    lastCheckedAt?: number
    error?: string
  }
  runtime: 'chrome' | 'vast' | 'hybrid'
  kind: VastExtensionKind
  manifestVersion: 2 | 3
  compatibility: ExtensionCompatibility
  compatibilitySummary: string
  compatibilityWarnings: string[]
  permissions: string[]
  hostPermissions: string[]
  runtimeState: ExtensionRuntimeState
  loadedSessionCount: number
  eligibleSessionCount: number
  chrome: { state: ExtensionRuntimeState; loadedSessionCount: number; eligibleSessionCount: number; error?: string }
  native: {
    state: VastNativeRuntimeState
    apiVersion?: number
    requestedPermissions: VastNativePermission[]
    grantedPermissions: VastNativePermission[]
    permissionDetails: VastPermissionMetadata[]
    error?: string
  }
  ui: {
    popup: boolean
    options: boolean
  }
  error?: string
  iconDataUrl?: string
  installedAt: number
  updatedAt: number
}

export interface VastExtensionListResult {
  ok: boolean
  extensions?: VastExtensionInfo[]
  privateWorkspacesDisabled?: true
  error?: string
}

export interface VastExtensionMutationResult {
  ok: boolean
  extension?: VastExtensionInfo
  removedId?: string
  canceled?: boolean
  error?: string
}

export interface VastExtensionPrepareResult {
  ok: boolean
  preview?: ExtensionPackagePreview
  canceled?: boolean
  error?: string
}

export type VastExtensionSurfaceKind = 'popup' | 'options'

export interface VastExtensionSurface {
  src: string
  partition: string
  kind: VastExtensionSurfaceKind
  runtime: 'chrome' | 'native'
}

export interface VastExtensionSurfaceResult {
  ok: boolean
  surface?: VastExtensionSurface
  unavailable?: true
  error?: string
}

export interface UiPromptAction {
  id: string
  label: string
  tone?: 'default' | 'primary' | 'success' | 'danger'
}

export interface WindowFrameState {
  maximized: boolean
  fullscreen: boolean
}

export interface UiPromptChoice {
  id: string
  label: string
  detail?: string
  thumbnailDataUrl?: string
  alternateAction?: UiPromptAction
}

export interface UiPromptPayload {
  id: ID
  tone: 'question' | 'warning' | 'danger'
  title: string
  message: string
  detail?: string
  actions: UiPromptAction[]
  choices?: UiPromptChoice[]
  persistSettingKeys?: PermissionSettingKey[]
  permissionRequest?: {
    origin: string
    workspaceId?: ID
    permission: SitePermissionKind
  }
}

export interface NetworkDeviceService {
  name: string
  type: string
  protocol?: string
  port?: number
  hostname?: string
  addresses?: string[]
  txt?: Record<string, string>
}

export interface NetworkDevice {
  id: ID
  source: NetworkDeviceSource
  sources: NetworkDeviceSource[]
  name: string
  alias?: string
  hostname?: string
  addresses: string[]
  primaryIp?: string
  macAddress?: string
  manufacturer?: string
  model?: string
  deviceType?: string
  category: NetworkDeviceCategory
  services: NetworkDeviceService[]
  ports: number[]
  webUrls: string[]
  presentationUrl?: string
  iconUrl?: string
  firstSeenAt: number
  lastSeenAt: number
  online: boolean
  favorite?: boolean
  pinned?: boolean
  notes?: string
  raw?: Record<string, unknown>
}

export interface NetworkScanOptions {
  mdns?: boolean
  ssdp?: boolean
  probe?: boolean
  arp?: boolean
  mock?: boolean
  confirmed?: boolean
}

export interface NetworkDevicePatch {
  alias?: string
  favorite?: boolean
  pinned?: boolean
  notes?: string
}

export interface NetworkScanResult {
  devices: NetworkDevice[]
  logs: string[]
  startedAt?: number
  finishedAt?: number
  scanning: boolean
}

export interface NoteQuote {
  id: ID
  text: string
  sourceUrl: string
  sourceTitle: string
  createdAt: number
}

export interface Note {
  id: ID
  title: string
  body: string
  tags?: string[]
  url?: string
  workspaceId?: ID
  linkedTabId?: ID
  pinned?: boolean
  archived?: boolean
  favorite?: boolean
  quotes?: NoteQuote[]
  createdAt: number
  updatedAt: number
}

export interface ReadingListItem {
  id: ID
  title: string
  url: string
  favicon?: string
  workspaceId?: ID
  excerpt?: string
  read: boolean
  createdAt: number
  updatedAt: number
}

export interface QuickLink {
  id: ID
  title: string
  url: string
  color: string
}

export interface SiteMemoryEntry {
  origin: string
  hostname: string
  title?: string
  favicon?: string
  lastUrl?: string
  zoom?: number
  muted?: boolean
  sidePanelOpen?: boolean
  sidePanelView?: SidePanelView
  visitCount: number
  lastUsedAt: number
  updatedAt: number
}

export interface TodoItem {
  id: ID
  workspaceId?: ID
  title: string
  completed: boolean
  createdAt: number
  updatedAt: number
}

export type SessionSnapshotTrigger = 'manual' | 'workspace-switch' | 'startup' | 'restore'

export interface SessionSnapshotTab {
  title: string
  url: string
  favicon?: string
  pinned: boolean
  groupId?: ID
  groupName?: string
  muted?: boolean
  lastAccessedAt: number
}

export interface SessionSnapshot {
  id: ID
  title: string
  workspaceId?: ID
  workspaceName?: string
  workspaceColor?: string
  tabIds: ID[]
  tabs?: SessionSnapshotTab[]
  activeUrl?: string
  trigger?: SessionSnapshotTrigger
  counts?: {
    tabs: number
    pinned: number
    internal: number
  }
  createdAt: number
}

export interface MacroAction {
  id: ID
  type: MacroActionType
  label?: string
  url?: string
  urls?: string[]
  internalUrl?: string
  workspaceId?: ID
  workspaceName?: string
  noteTitle?: string
  noteBody?: string
  noteId?: ID
  sidePanelView?: SidePanelView
  commandId?: string
}

export interface Macro {
  id: ID
  name: string
  description: string
  icon: string
  color: string
  trigger: MacroTriggerType
  actions: MacroAction[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
}

export interface MacroRunLog {
  id: ID
  macroId: ID
  macroName: string
  status: 'success' | 'error'
  message: string
  ranAt: number
}

export interface Command {
  id: string
  title: string
  subtitle?: string
  url?: string
  favicon?: string
  keywords?: string[]
  section: 'Tabs' | 'Navigation' | 'Workspaces' | 'Bookmarks' | 'History' | 'Notes' | 'Actions' | 'Settings' | 'Search'
  shortcut?: string
  perform: () => void | Promise<void>
}

export interface AvidaeStatus {
  state: 'stopped' | 'starting' | 'running' | 'installing' | 'error'
  url?: string
  port?: number
  python?: string
  runtimeBundled?: boolean
  error?: string
  logs: string[]
  sourcePath: string
  dataPath: string
}

export interface PasswordVaultItem {
  id: ID
  origin: string
  hostname: string
  username: string
  title: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  notes?: string
  favicon?: string
  autofillPolicy?: 'ask' | 'never'
}

export interface PasswordVaultInput {
  origin: string
  username: string
  password: string
  title?: string
  notes?: string
  favicon?: string
  autofillPolicy?: 'ask' | 'never'
}

export interface PasswordVaultUpdate {
  origin?: string
  username?: string
  password?: string
  title?: string
  notes?: string
  favicon?: string
  autofillPolicy?: 'ask' | 'never'
}

export interface PasswordVaultAudit {
  weakIds: ID[]
  reusedGroups: ID[][]
  duplicateIds: ID[]
}

export type PasswordVaultLockReason = 'startup' | 'manual' | 'idle' | 'system-lock' | 'suspend' | 'session-expired'

export interface PasswordVaultSessionState {
  locked: boolean
  reason: PasswordVaultLockReason
  unlockedAt?: number
  expiresAt?: number
  idleExpiresAt?: number
  freshUntil?: number
}

export interface PasswordSavePromptPayload {
  attemptId: string
  webContentsId: number
  origin: string
  hostname: string
  username: string
  kind: 'login' | 'signup' | 'change-password'
  action: 'save' | 'update'
  expiresAt: number
}

export type PasswordSavePromptAction = 'save' | 'update' | 'not-now' | 'never'

export type VastNoticeSeverity = 'info' | 'important' | 'security'

export interface VastNotice {
  id: string
  title: string
  message: string
  severity: VastNoticeSeverity
  publishedAt: string
  expiresAt?: string
}

export interface VastNoticesTrustConfig {
  enabled: boolean
  feedUrl: string
  keyId: string
  publicKeySpkiBase64: string
}

export interface VastNoticesResult {
  enabled: boolean
  notices: VastNotice[]
  generatedAt?: string
  expiresAt?: string
  reason?: string
}

export interface PasswordAutofillSuggestion {
  id: ID
  username: string
  title: string
  favicon?: string
}

export interface PasswordAutofillCredential {
  id: ID
  origin: string
  username: string
  password: string
}

export type PasswordCaptureOutcome = 'saved' | 'updated' | 'unchanged' | 'dismissed' | 'suppressed' | 'duplicate'

export interface PersistedData {
  schemaVersion: number
  activeWorkspaceId: ID
  activeSidePanel: SidePanelView
  sidePanelOpen: boolean
  sidebarCollapsed: boolean
  focusMode: boolean
  splitView: {
    enabled: boolean
    primaryTabId?: ID
    secondaryTabId?: ID
    ratio?: number
  }
  workspaces: Workspace[]
  tabGroups: TabGroup[]
  tabs: Tab[]
  recentlyClosedTabs: RecentlyClosedTab[]
  bookmarks: Bookmark[]
  bookmarkFolders: BookmarkFolder[]
  history: HistoryEntry[]
  downloads: DownloadItem[]
  notes: Note[]
  readingList: ReadingListItem[]
  quickLinks: QuickLink[]
  siteMemory: SiteMemoryEntry[]
  todos: TodoItem[]
  macros: Macro[]
  macroLogs: MacroRunLog[]
  sessionSnapshots: SessionSnapshot[]
  recentCommandIds: string[]
  settings: BrowserSettings
}

export interface StorageBackupInfo {
  id: string
  path: string
  createdAt: number
  sizeBytes: number
  kind: 'rolling' | 'manual' | 'invalid' | 'pre-import' | 'pre-restore'
}

export interface StorageRecoveryState {
  active: boolean
  reason?: string
  rejectedPath?: string
  backupPath?: string
  occurredAt?: number
}

export interface StorageImportPreview {
  workspaces: number
  tabs: number
  bookmarks: number
  notes: number
  history: number
  passwordsExcluded: true
}

export interface DataPathInfo {
  currentDataPath: string
  defaultDataPath: string
  stableConfigPath: string
  customDataPathActive: boolean
  configuredCustomDataPath?: string
  appInstallPath: string
}

export interface DataOperationSkippedFile {
  path: string
  reason: string
}

export interface MigrationReport {
  ok: boolean
  path?: string
  dataPath?: string
  backupPath?: string
  restartRequired?: boolean
  includedSections?: string[]
  importedSections?: string[]
  includedFileCount?: number
  skippedFileCount?: number
  copiedFiles?: string[]
  skippedFiles?: string[]
  skippedFileDetails?: DataOperationSkippedFile[]
  vastDataIncluded?: boolean
  passwordVaultIncluded?: boolean
  warnings?: string[]
  error?: string
}

export interface PdfCaptureEvent {
  id: string
  guestWebContentsId: number
  state: 'started' | 'progress' | 'ready' | 'failed'
  sourceUrl: string
  filename: string
  mimeType: string
  receivedBytes: number
  totalBytes: number
  error?: string
}

export interface PdfResourceInfo {
  sourceUrl: string
  filename: string
  mimeType: string
  sizeBytes: number
  state: 'downloading' | 'ready' | 'failed'
  receivedBytes: number
  totalBytes: number
  error?: string
}

export interface VastApi {
  storage: {
    load: () => Promise<PersistedData>
    save: (data: PersistedData) => Promise<{ ok: boolean; error?: string }>
    flush: (data: PersistedData) => Promise<{ ok: boolean; error?: string }>
    exportData: () => Promise<{ ok: boolean; path?: string; error?: string }>
    importData: () => Promise<{ ok: boolean; data?: PersistedData; error?: string }>
    exportFullBackup: () => Promise<MigrationReport>
    importFullBackup: () => Promise<MigrationReport>
    onSitePermissionsChanged: (callback: (permissions: SitePermissionOverride[]) => void) => () => void
  }
  dataPath: {
    info: () => Promise<DataPathInfo>
    openDataFolder: () => Promise<{ ok: boolean; error?: string }>
    changeDataDirectory: () => Promise<MigrationReport>
  }
  extensions: {
    list: () => Promise<VastExtensionListResult>
    loadUnpacked: () => Promise<VastExtensionMutationResult>
    installPackage: () => Promise<VastExtensionPrepareResult>
    prepareHubInstall: (id: string) => Promise<VastExtensionPrepareResult>
    confirmInstall: (token: string) => Promise<VastExtensionMutationResult>
    cancelInstall: (token: string) => Promise<{ ok: boolean; error?: string }>
    catalog: (input: { query?: string; category?: string; page?: number; sort?: 'popular' | 'updated' }) => Promise<{ ok: boolean; catalog?: VastHubCatalogResult; error?: string }>
    catalogDetails: (id: string) => Promise<{ ok: boolean; extension?: VastHubExtensionDetails; error?: string }>
    checkForUpdates: (id?: string) => Promise<{ ok: boolean; extensions?: VastExtensionInfo[]; error?: string }>
    approveUpdate: (id: string) => Promise<VastExtensionMutationResult>
    enable: (id: string) => Promise<VastExtensionMutationResult>
    disable: (id: string) => Promise<VastExtensionMutationResult>
    reload: (id: string) => Promise<VastExtensionMutationResult>
    remove: (id: string) => Promise<VastExtensionMutationResult>
    approvePermissions: (id: string, permissions: VastNativePermission[]) => Promise<VastExtensionMutationResult>
    setPermission: (id: string, permission: VastNativePermission, granted: boolean) => Promise<VastExtensionMutationResult>
    contributions: () => Promise<{ ok: boolean; contributions?: VastExtensionContributionSnapshot; error?: string }>
    prepareSurface: (id: string, kind: VastExtensionSurfaceKind, partition: string) => Promise<VastExtensionSurfaceResult>
    prepareSidebar: (key: string) => Promise<{ ok: boolean; surface?: { src: string; partition: string }; error?: string }>
    dispatchContribution: (key: string, context?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
    respondToUiRequest: (response: VastUiBrokerResponse) => Promise<{ ok: boolean; error?: string }>
    reportTabEvent: (name: 'tabs.onActivated' | 'tabs.onCreated' | 'tabs.onUpdated' | 'tabs.onRemoved', payload: unknown) => Promise<{ ok: boolean; error?: string }>
    onContributionsChanged: (callback: (snapshot: VastExtensionContributionSnapshot) => void) => () => void
    onUiRequest: (callback: (request: VastUiBrokerRequest) => void) => () => void
    onChanged: (callback: () => void) => () => void
  }
  privacy: {
    clearSiteData: (origin?: string, webContentsId?: number) => Promise<{ ok: boolean; error?: string }>
    getSiteInformation: (webContentsId: number, url: string) => Promise<{ ok: boolean; info?: SiteInformation; error?: string }>
    filterStatus: () => Promise<{ ok: boolean; status?: PrivacyFilterStatus; error?: string }>
    updateFilters: () => Promise<{ ok: boolean; status?: PrivacyFilterStatus; error?: string }>
    configureIdentity: (webContentsId: number, identity: WorkspaceIdentitySettings, url: string, identityId: ID) => Promise<{ ok: boolean; error?: string }>
  }
  avidae: {
    status: () => Promise<AvidaeStatus>
    start: () => Promise<AvidaeStatus>
    stop: () => Promise<AvidaeStatus>
    installDependencies: () => Promise<AvidaeStatus>
  }
  passwords: {
    sessionStatus: () => Promise<{ ok: boolean; state?: PasswordVaultSessionState; error?: string }>
    lockSession: () => Promise<{ ok: boolean; state?: PasswordVaultSessionState; error?: string }>
    list: () => Promise<{ ok: boolean; items?: PasswordVaultItem[]; encryptionAvailable?: boolean; suppressedOrigins?: string[]; error?: string }>
    create: (input: PasswordVaultInput) => Promise<{ ok: boolean; item?: PasswordVaultItem; error?: string }>
    update: (id: ID, input: PasswordVaultUpdate) => Promise<{ ok: boolean; item?: PasswordVaultItem; error?: string }>
    remove: (id: ID) => Promise<{ ok: boolean; error?: string }>
    copyUsername: (id: ID) => Promise<{ ok: boolean; error?: string }>
    copyPassword: (id: ID) => Promise<{ ok: boolean; error?: string }>
    fillAutofill: (webContentsId: number, origin: string) => Promise<{ ok: boolean; filled?: boolean; error?: string }>
    getAutofillSuggestions: (webContentsId: number, origin: string) => Promise<{ ok: boolean; suggestions?: PasswordAutofillSuggestion[]; error?: string }>
    fillById: (id: ID, webContentsId: number, origin: string, requestId: string) => Promise<{ ok: boolean; filled?: boolean; error?: string }>
    saveCapturedLogin: (input: PasswordVaultInput) => Promise<{ ok: boolean; item?: PasswordVaultItem; error?: string }>
    captureStatus: (webContentsId: number, origin: string) => Promise<{ ok: boolean; enabled?: boolean; error?: string }>
    allowSavePrompts: (origin: string) => Promise<{ ok: boolean; error?: string }>
    importCsv: () => Promise<{ ok: boolean; imported?: number; skipped?: number; error?: string }>
    exportCsv: () => Promise<{ ok: boolean; path?: string; error?: string }>
    audit: () => Promise<{ ok: boolean; audit?: PasswordVaultAudit; error?: string }>
    unlockSession: () => Promise<{ ok: boolean; state?: PasswordVaultSessionState; error?: string }>
    onSessionState: (callback: (state: PasswordVaultSessionState) => void) => () => void
    onSavePrompt: (callback: (prompt: PasswordSavePromptPayload) => void) => () => void
    onSavePromptCleared: (callback: (attemptId: string) => void) => () => void
    resolveSavePrompt: (attemptId: string, action: PasswordSavePromptAction) => Promise<{ ok: boolean; outcome?: PasswordCaptureOutcome; error?: string }>
  }
  notes: {
    exportMarkdown: (title: string, body: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  }
  notices: {
    list: () => Promise<{ ok: boolean; result?: VastNoticesResult; error?: string }>
  }
  relay: {
    state: () => Promise<RelayClientSnapshot>
    dismiss: (presentationId: string) => Promise<{ ok: boolean; error?: string }>
    performAction: (presentationId: string) => Promise<RelayActionResult>
    onStateChanged: (callback: (state: RelayClientSnapshot) => void) => () => void
  }
  downloads: {
    onChanged: (callback: (item: DownloadItem) => void) => () => void
    showInFolder: (path: string) => Promise<{ ok: boolean; error?: string }>
    openFile: (path: string) => Promise<{ ok: boolean; error?: string }>
    pause: (id: ID) => Promise<{ ok: boolean; error?: string }>
    resume: (id: ID) => Promise<{ ok: boolean; error?: string }>
    cancel: (id: ID) => Promise<{ ok: boolean; error?: string }>
    retry: (id: ID) => Promise<{ ok: boolean; error?: string }>
    clearCompleted: () => Promise<{ ok: boolean; error?: string }>
  }
  ui: {
    onNotification: (callback: (notification: UiNotificationPayload) => void) => () => void
    onPrompt: (callback: (prompt: UiPromptPayload) => void) => () => void
    resolvePrompt: (id: ID, actionId: string) => Promise<{ ok: boolean; error?: string }>
  }
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  }
  oauth: {
    requestFallback: (input: {
      url: string
      fallbackUrl?: string
      reason?: string
    }) => Promise<{ ok: boolean; error?: string }>
  }
  browser: {
    onOpenTabRequest: (callback: (request: BrowserTabOpenRequest) => void) => () => void
    onExternalProtocolRequest: (callback: (request: ExternalProtocolRequest) => void) => () => void
    resolveExternalProtocolRequest: (id: ID, allow: boolean) => Promise<{ ok: boolean; error?: string }>
    onHtmlFullscreenState: (callback: (state: HtmlFullscreenState) => void) => () => void
    onMediaCaptureState: (callback: (state: MediaCaptureState) => void) => () => void
    setKeepAwake: (webContentsId: number, keepAwake: boolean) => Promise<{ ok: boolean; error?: string }>
    onShortcut: (callback: (shortcut: string) => void) => () => void
    onPrepareClose: (callback: (requestId: string) => void | Promise<void>) => () => void
    closeReady: (requestId: string, result: { ok: boolean; error?: string }) => Promise<{ ok: boolean; error?: string }>
    detachTab: (tab: DetachedTabPayload) => Promise<{ ok: boolean; error?: string }>
    reattachDetachedTab: (tab: DetachedTabPayload) => Promise<{ ok: boolean; attached?: boolean; error?: string }>
    onDetachedTabReattach: (callback: (tab: DetachedTabPayload) => void) => () => void
    syncDetachedTab: (tab: DetachedTabPayload) => Promise<{ ok: boolean; error?: string }>
    copyImageAt: (webContentsId: number, x: number, y: number) => Promise<{ ok: boolean; error?: string }>
    downloadUrl: (webContentsId: number, url: string) => Promise<{ ok: boolean; error?: string }>
    printWebContents: (webContentsId: number) => Promise<{ ok: boolean; error?: string }>
  }
  pdf: {
    onCapture: (callback: (event: PdfCaptureEvent) => void) => () => void
    captures: (guestWebContentsId: number) => Promise<{ ok: boolean; captures?: PdfCaptureEvent[]; error?: string }>
    openLocalFile: (file: File) => Promise<{ ok: boolean; viewerUrl?: string; error?: string }>
    info: (id: string) => Promise<{ ok: boolean; resource?: PdfResourceInfo; error?: string }>
    readRange: (id: string, begin: number, end: number) => Promise<{ ok: boolean; data?: Uint8Array; error?: string }>
    save: (id: string, filename?: string) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
    openExternal: (id: string) => Promise<{ ok: boolean; error?: string }>
    print: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  app: {
    platform: string
    guestAutofillPreloadUrl: string
    window: {
      state: () => Promise<WindowFrameState>
      minimize: () => Promise<{ ok: boolean; error?: string }>
      toggleMaximize: () => Promise<{ ok: boolean; error?: string }>
      close: () => Promise<{ ok: boolean; error?: string }>
      onStateChanged: (callback: (state: WindowFrameState) => void) => () => void
    }
    startup: {
      openingAnimationEnabled: boolean
      openingAnimationHandledBySplash: boolean
      openingAnimationSoundVolume: number
    }
    versions: {
      electron: string
      chrome: string
      node: string
    }
    diagnostics: () => Promise<{
      appVersion: string
      platform: string
      userDataPath: string
      storagePath: string
      dataPath: DataPathInfo
      backupCount: number
      recovery: StorageRecoveryState
      electron: string
      chrome: string
      node: string
      googleAuth: {
        model: string
        partition: string
        chrome: string
        electron: string
        identityProfile: string
        lastStatus: string
        logPath: string
      }
      releaseChannel: string
      distributionChannel: string
      releaseRepo: string
      updaterEnabled: boolean
      updaterReason: string
      obfuscationEnabled: boolean
      privateBuild: boolean
      packaged: boolean
      labsEnabled: boolean
      recentEvents: Array<{
        at: string
        category: 'renderer' | 'guest' | 'gpu' | 'child' | 'window'
        event: string
        details?: Record<string, string | number | boolean | null>
      }>
      }>
    processMetrics: () => Promise<{
      totalWorkingSetMb: number
      processes: Array<{ type: string; workingSetMb: number }>
    }>
    performanceCounters: () => Promise<{
      storageWrites: number
      storageBytes: number
      rollingBackups: number
      storageWriteDurationMs: number
      downloadProgressEvents: number
      downloadDurableWrites: number
    }>
    getDefaultBrowserStatus: () => Promise<DefaultBrowserStatus>
    openDefaultBrowserSettings: () => Promise<{ ok: boolean; status?: DefaultBrowserStatus; error?: string }>
  }
  network: {
    getDevices: () => Promise<{ ok: boolean; devices?: NetworkDevice[]; logs?: string[]; scanning?: boolean; startedAt?: number; finishedAt?: number; error?: string }>
    scan: (options?: NetworkScanOptions) => Promise<{ ok: boolean; devices?: NetworkDevice[]; logs?: string[]; startedAt?: number; finishedAt?: number; error?: string }>
    updateDevice: (id: ID, patch: NetworkDevicePatch) => Promise<{ ok: boolean; device?: NetworkDevice; error?: string }>
    forgetDevice: (id: ID) => Promise<{ ok: boolean; error?: string }>
    clearCache: () => Promise<{ ok: boolean; error?: string }>
    exportInventory: () => Promise<{ ok: boolean; path?: string; error?: string }>
  }
  updater: {
    onEvent: (callback: (payload: UpdaterEvent) => void) => () => void
    status: () => Promise<UpdaterDiagnostics>
    install: () => Promise<{ ok: boolean; error?: string }>
  }
}

export type UpdaterEventType = 'disabled' | 'checking' | 'update-available' | 'downloading' | 'ready' | 'error' | 'up-to-date'

export interface UpdaterEvent {
  event: UpdaterEventType
  version?: string
  percent?: number
  message?: string
}

export interface UpdaterDiagnostics {
  enabled: boolean
  reason: string
  state: 'disabled' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  channel: string
  autoDownload: boolean
  autoInstallOnQuit: boolean
  lastEvent?: UpdaterEvent
  lastCheckedAt?: number
  lastError?: string
}

export interface DefaultBrowserStatus {
  supported: boolean
  isDefault: boolean
  platform: string
  settingsUri?: string
  message: string
}
