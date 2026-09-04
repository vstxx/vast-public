import type { BrowserSettings, PersistedData, SearchEngine } from './types'

export const APP_NAME = 'Vast'
export const INTERNAL_NEW_TAB_URL = 'vast://newtab'
export const INTERNAL_AVIDAE_URL = 'vast://avidae'
export const INTERNAL_PASSWORDS_URL = 'vast://passwords'
export const INTERNAL_AUTOMATION_URL = 'vast://automation'
export const INTERNAL_NOTES_URL = 'vast://notes'
export const INTERNAL_PDF_VIEWER_URL = 'vast://pdf'
export const INTERNAL_SITE_DATA_URL = 'vast://site-data'
export const INTERNAL_DIAGNOSTICS_URL = 'vast://diagnostics'
export const INTERNAL_NETWORK_URL = 'vast://network'
export const INTERNAL_SESSION_TIMELINE_URL = 'vast://session-timeline'
export const INTERNAL_EXTENSIONS_URL = 'vast://extensions'
export const STORAGE_SCHEMA_VERSION = 8

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    shortcut: 'g',
    searchUrl: 'https://www.google.com/search?q=%s',
    homeUrl: 'https://www.google.com'
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    shortcut: 'd',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    homeUrl: 'https://duckduckgo.com'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    shortcut: 'b',
    searchUrl: 'https://search.brave.com/search?q=%s',
    homeUrl: 'https://search.brave.com'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    shortcut: 'p',
    searchUrl: 'https://www.perplexity.ai/search?q=%s',
    homeUrl: 'https://www.perplexity.ai'
  },
  {
    id: 'youtube',
    name: 'YouTube',
    shortcut: 'yt',
    searchUrl: 'https://www.youtube.com/results?search_query=%s',
    homeUrl: 'https://www.youtube.com'
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    shortcut: 'w',
    searchUrl: 'https://en.wikipedia.org/wiki/Special:Search?search=%s',
    homeUrl: 'https://www.wikipedia.org'
  }
]

export const SEARCH_ENGINE_SHORTCUTS = new Map(SEARCH_ENGINES.map((engine) => [engine.shortcut, engine]))

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  commandPalette: 'Ctrl/Cmd+K',
  focusAddress: 'Ctrl/Cmd+L',
  newTab: 'Ctrl/Cmd+T',
  closeTab: 'Ctrl/Cmd+W',
  reload: 'Ctrl/Cmd+R',
  reopenClosedTab: 'Ctrl/Cmd+Shift+T',
  toggleSidebar: 'Ctrl/Cmd+B',
  findInPage: 'Ctrl/Cmd+F',
  back: 'Alt+Left',
  forward: 'Alt+Right',
  zoomIn: 'Ctrl/Cmd+Plus',
  zoomOut: 'Ctrl/Cmd+Minus',
  resetZoom: 'Ctrl/Cmd+0',
  print: 'Ctrl/Cmd+P',
  toggleAdBlocker: 'Ctrl/Cmd+Shift+A'
}

export const DEFAULT_SETTINGS: BrowserSettings = {
  theme: 'dark',
  accentColor: '#d1a3ff',
  appearance: {
    secondaryAccentColor: '#79159d',
    backgroundTintColor: '#000000',
    surfaceTintColor: '#1d1127',
    backgroundStyle: 'carbon',
    cornerRadius: 26,
    glassIntensity: 100,
    blurIntensity: 76,
    glowIntensity: 1,
    borderIntensity: 46,
    shadowIntensity: 4,
    gradientIntensity: 52,
    panelOpacity: 78,
    chromeOpacity: 84,
    saturation: 100,
    forceDarkModeWebsites: false
  },
  sidebarDensity: 'comfortable',
  layoutMode: 'horizontal',
  tabLayout: 'vertical',
  sidePanel: {
    mode: 'auto',
    width: 356,
    showLabels: true,
    positionX: -1,
    positionY: 60
  },
  bookmarksBarVisible: true,
  bookmarksBarOnlyOnNewTab: false,
  hibernateInactiveTabs: true,
  defaultSearchEngine: 'google',
  startupBehavior: 'restore',
  newTabBehavior: 'search',
  newTab: {
    compactCards: true,
    showQuickLinks: true,
    showRecentPages: false,
    showBookmarks: false,
    showTodos: false,
    showNotes: false,
    showRecentlyClosed: false,
    showWorkspaceSummary: false,
    showSessionTimeline: false
  },
  commandPalette: {
    favoriteCommandIds: []
  },
  restorePreviousSession: true,
  animations: true,
  openingAnimation: false,
  openingAnimationSoundVolume: 0,
  privacy: {
    blockTrackers: true,
    adBlockerEnabled: true,
    adBlockerMode: 'standard',
    filterEasyList: true,
    filterEasyPrivacy: true,
    filterPeterLowe: true,
    filterMalware: true,
    filterPolishAnnoyances: false,
    filterAutoUpdate: true,
    customFilterRules: '',
    adBlockAllowlist: [],
    customBlockAds: true,
    customBlockTrackers: true,
    customBlockMalware: true,
    customBlockThirdPartyCookies: true,
    stripTrackingParameters: true,
    stripAffiliateParameters: false,
    blockThirdPartyCookies: true,
    cookieExceptions: [],
    clearSiteDataOnClose: [],
    fingerprintingProtection: 'standard',
    fingerprintingExceptions: [],
    webRtcPolicy: 'public-interface-only',
    webRtcExceptions: ['meet.google.com', 'discord.com', 'zoom.us', 'teams.microsoft.com'],
    fakeHistoryEnabled: false,
    clearCookiesOnExit: false,
    privateWorkspaceDefault: false,
    disableHistory: false,
    disableRecentlyClosedTabs: false,
    disablePageTextCapture: false,
    disableFavicons: false,
    siteInterventionsDisabled: []
  },
  spoofing: {
    enabled: false,
    browserProfile: 'chrome-windows',
    customUserAgent: '',
    languages: ['en-US', 'en'],
    timezone: 'UTC',
    doNotTrack: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    location: {
      mode: 'off',
      latitude: 52.2297,
      longitude: 21.0122,
      accuracy: 50
    }
  },
  advanced: {
    ramLimitMb: 2048,
    hibernateAfterMinutes: 10,
    discardAfterMinutes: 120,
    keepPinnedTabsAwake: false,
    confirmBeforeClosingManyTabs: true,
    confirmBeforeDeletingWorkspace: true,
    showAdvancedBrowserActions: true,
    showInternalPagesInCommandPalette: true,
    experimentalFeatures: false,
    developerMode: false
  },
  security: {
    httpsOnlyMode: false,
    confirmExternalLinks: false,
    warnDangerousDownloads: true,
    alwaysConfirmAutofill: true,
    permissionCamera: 'ask',
    permissionMicrophone: 'ask',
    permissionLocation: 'ask',
    permissionNotifications: 'ask',
    permissionClipboard: 'ask',
    permissionFullscreen: 'allow',
    sitePermissions: []
  },
  network: {
    enabled: false,
    allowScans: false,
    passiveDiscovery: true,
    activeProbing: false,
    rememberDevices: false,
    showRawMetadata: false,
    probeTimeoutMs: 750,
    probeConcurrency: 16,
    includeVpnAdapters: false
  },
  labs: {
    enabled: false,
    avidae: false,
    networkDevices: false,
    automation: false,
    passwordManager: false,
    advancedDiagnostics: false,
    spoofing: false
  },
  keyboardShortcuts: DEFAULT_SHORTCUTS
}

const now = Date.now()

export const DEFAULT_DATA: PersistedData = {
  schemaVersion: STORAGE_SCHEMA_VERSION,
  activeWorkspaceId: 'workspace-default',
  activeSidePanel: 'notes',
  sidePanelOpen: false,
  sidebarCollapsed: true,
  focusMode: false,
  splitView: {
    enabled: false,
    ratio: 50
  },
  workspaces: [
    {
      id: 'workspace-default',
      name: 'Workspace',
      icon: 'Globe2',
      color: '#d1a3ff',
      order: 0,
      activeTabId: 'tab-new',
      identity: { sessionMode: 'isolated', proxyMode: 'system', proxyServer: '', proxyBypassRules: '<local>' },
      createdAt: now,
      updatedAt: now
    }
  ],
  tabGroups: [],
  tabs: [
    {
      id: 'tab-new',
      workspaceId: 'workspace-default',
      title: 'New tab',
      url: INTERNAL_NEW_TAB_URL,
      pinned: false,
      status: 'idle',
      lifecycle: 'active',
      progress: 0,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      lastAccessedAt: now,
      createdAt: now
    }
  ],
  recentlyClosedTabs: [],
  bookmarks: [],
  bookmarkFolders: [],
  history: [],
  downloads: [],
  notes: [],
  readingList: [],
  quickLinks: [],
  siteMemory: [],
  todos: [],
  macros: [],
  macroLogs: [],
  sessionSnapshots: [],
  recentCommandIds: [],
  settings: DEFAULT_SETTINGS
}

export const BLOCKED_INTERNAL_PROTOCOLS = [
  'file:',
  'javascript:',
  'data:',
  'vbscript:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'view-source:'
]

export const TRACKER_HOST_PATTERNS = [
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'facebook.net',
  'hotjar.com',
  'segment.io',
  'mixpanel.com',
  'adsystem.com',
  'adservice.google.com',
  'scorecardresearch.com'
]

export const AD_HOST_PATTERNS = [
  'adform.net',
  'adnxs.com',
  'adroll.com',
  'adsafeprotected.com',
  'adsrvr.org',
  'advertising.com',
  'amazon-adsystem.com',
  'ad-maven.com',
  'admaven.com',
  'adsterra.com',
  'adsterra.org',
  'adxpansion.com',
  'clickadilla.com',
  'criteo.com',
  'ero-advertising.com',
  'exoclick.com',
  'exosrv.com',
  'googleadservices.com',
  'googlesyndication.com',
  'hilltopads.net',
  'juicyads.com',
  'mgid.com',
  'moatads.com',
  'onclickads.net',
  'openx.net',
  'outbrain.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propeller-tracking.com',
  'pubmatic.com',
  'realsrv.com',
  'revcontent.com',
  'rubiconproject.com',
  'sharethrough.com',
  'smartadserver.com',
  'taboola.com',
  'trafficjunky.net',
  'trafficshop.com',
  'yieldmo.com',
  'zedo.com'
]

export const AD_URL_SNIPPETS = [
  '/ads/',
  '/adserver',
  '/banner',
  '/gampad/',
  '/pagead/',
  '/pagead2.',
  '/prebid',
  '/pubads',
  '/securepubads',
  '?ad_',
  '&ad_'
]

export const FAKE_HISTORY_SEEDS = [
  { title: 'Facebook', url: 'https://www.facebook.com/' },
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Office 365', url: 'https://www.office.com/' },
  { title: 'Outlook', url: 'https://outlook.office.com/mail/' },
  { title: 'Booking.com', url: 'https://www.booking.com/' },
  { title: 'JamesEdition - Luxury Real Estate', url: 'https://www.jamesedition.com/real_estate' },
  { title: 'Google Search - best hotels in Warsaw', url: 'https://www.google.com/search?q=best+hotels+in+Warsaw' },
  { title: 'Google Search - flights to Tokyo', url: 'https://www.google.com/search?q=flights+to+Tokyo' },
  { title: 'Google Search - MacBook Pro deals', url: 'https://www.google.com/search?q=MacBook+Pro+deals' },
  { title: 'Google Search - Notion templates', url: 'https://www.google.com/search?q=Notion+templates' },
  { title: 'Google Search - luxury apartments Paris', url: 'https://www.google.com/search?q=luxury+apartments+Paris' },
  { title: 'Google Search - office 365 login', url: 'https://www.google.com/search?q=office+365+login' },
  { title: 'Google Search - restaurants nearby', url: 'https://www.google.com/search?q=restaurants+nearby' },
  { title: 'Google Search - weekend trip ideas', url: 'https://www.google.com/search?q=weekend+trip+ideas' }
]
