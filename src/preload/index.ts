import { contextBridge, ipcRenderer } from 'electron/renderer'
import {
  parseOpeningHandledStartupFlag,
  parseOpeningHandledStartupSearch,
  parseOpeningStartupFlag,
  parseOpeningStartupSearch,
  parseOpeningStartupVolumeFlag,
  parseOpeningStartupVolumeSearch
} from '../shared/opening-startup'
import { DEFAULT_SETTINGS } from '../shared/constants'
import { OPENING_COMPLETE_IPC_CHANNEL, OPENING_COMPLETE_MESSAGE } from '../shared/opening-sequence'
import type { BrowserTabOpenRequest, DetachedTabPayload, DownloadItem, PersistedData, VastApi } from '../shared/types'
import { TabOpenRequestBuffer } from './tab-open-request-buffer'

declare const __VAST_CAT_ADDON_AVAILABLE__: boolean

const openingAnimationEnabled = parseOpeningStartupSearch(window.location.search) || parseOpeningStartupFlag(process.argv)
const openingAnimationSoundVolume = parseOpeningStartupVolumeSearch(
  window.location.search,
  parseOpeningStartupVolumeFlag(process.argv, DEFAULT_SETTINGS.openingAnimationSoundVolume)
)
const openingAnimationHandledBySplash =
  parseOpeningHandledStartupSearch(window.location.search) || parseOpeningHandledStartupFlag(process.argv)
const guestAutofillPreloadUrl = process.argv.find((value) => value.startsWith('--vast-guest-autofill-preload='))?.slice('--vast-guest-autofill-preload='.length) ?? ''
const performanceProbeEnabled = process.argv.includes('--vast-performance-probe=1')

if (openingAnimationEnabled) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (!event.data || typeof event.data !== 'object') return
    if ((event.data as { type?: unknown }).type !== OPENING_COMPLETE_MESSAGE) return
    ipcRenderer.send(OPENING_COMPLETE_IPC_CHANNEL)
  })
}

if (performanceProbeEnabled) {
  window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.send('vast:performance:mark', 'renderer-dom-ready')
    let shellMarked = false
    let pageProbeBound = false
    const observeShell = new MutationObserver(() => {
      if (!shellMarked && document.querySelector('.app-shell')) {
        shellMarked = true
        ipcRenderer.send('vast:performance:mark', 'browser-shell-interactive')
      }
      const webview = document.querySelector('webview')
      if (!pageProbeBound && webview) {
        pageProbeBound = true
        webview.addEventListener('did-start-loading', () => {
          ipcRenderer.send('vast:performance:mark', 'first-active-page-load-start')
        }, { once: true })
      }
      if (shellMarked && pageProbeBound) observeShell.disconnect()
    })
    observeShell.observe(document.documentElement, { childList: true, subtree: true })
  }, { once: true })
}

// Register before React or the context bridge initializes. Main can dispatch a
// target=_blank request as soon as a guest exists, so delaying this listener
// until onOpenTabRequest() would create a lossy startup race.
const tabOpenRequests = new TabOpenRequestBuffer(100)
ipcRenderer.on('vast:browser:open-tab', (_event, request: BrowserTabOpenRequest) => {
  tabOpenRequests.receive(request)
})

const catAddonApi = __VAST_CAT_ADDON_AVAILABLE__ ? {
  catAddon: {
    status: () => ipcRenderer.invoke('vast:cat-addon:status'),
    runtime: () => ipcRenderer.invoke('vast:cat-addon:runtime'),
    windowState: () => ipcRenderer.invoke('vast:cat-addon:window-state'),
    enable: () => ipcRenderer.invoke('vast:cat-addon:enable'),
    disable: () => ipcRenderer.invoke('vast:cat-addon:disable'),
    onStateChanged: (callback: VastApi['catAddon']['onStateChanged'] extends (callback: infer T) => unknown ? T : never) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => callback(state)
      ipcRenderer.on('vast:cat-addon:state', listener)
      return () => ipcRenderer.removeListener('vast:cat-addon:state', listener)
    },
    onWindowStateChanged: (callback: VastApi['catAddon']['onWindowStateChanged'] extends (callback: infer T) => unknown ? T : never) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => callback(state)
      ipcRenderer.on('vast:cat-addon:window-state-changed', listener)
      return () => ipcRenderer.removeListener('vast:cat-addon:window-state-changed', listener)
    }
  }
} : {}

const api = {
  storage: {
    load: () => ipcRenderer.invoke('vast:storage:load') as Promise<PersistedData>,
    save: (data) => ipcRenderer.invoke('vast:storage:save', data) as Promise<{ ok: boolean; error?: string }>,
    flush: (data) => ipcRenderer.invoke('vast:storage:flush', data) as Promise<{ ok: boolean; error?: string }>,
    exportData: () =>
      ipcRenderer.invoke('vast:storage:export') as Promise<{ ok: boolean; path?: string; error?: string }>,
    importData: () =>
      ipcRenderer.invoke('vast:storage:import') as Promise<{
        ok: boolean
        data?: PersistedData
        error?: string
      }>,
    exportFullBackup: () => ipcRenderer.invoke('vast:storage:export-full'),
    importFullBackup: () => ipcRenderer.invoke('vast:storage:import-full'),
    listBackups: () => ipcRenderer.invoke('vast:storage:list-backups'),
    restoreBackup: (id) => ipcRenderer.invoke('vast:storage:restore-backup', id),
    createBackup: () => ipcRenderer.invoke('vast:storage:create-backup'),
    onSitePermissionsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, permissions: Parameters<typeof callback>[0]): void => callback(permissions)
      ipcRenderer.on('vast:site-permissions-changed', listener)
      return () => ipcRenderer.removeListener('vast:site-permissions-changed', listener)
    }
  },
  dataPath: {
    info: () => ipcRenderer.invoke('vast:data-path:info'),
    openDataFolder: () => ipcRenderer.invoke('vast:data-path:open'),
    changeDataDirectory: () => ipcRenderer.invoke('vast:data-path:change')
  },
  extensions: {
    list: () => ipcRenderer.invoke('vast:extensions:list'),
    loadUnpacked: () => ipcRenderer.invoke('vast:extensions:load-unpacked'),
    installPackage: () => ipcRenderer.invoke('vast:extensions:install-package'),
    prepareHubInstall: (id) => ipcRenderer.invoke('vast:extensions:prepare-hub-install', id),
    confirmInstall: (token) => ipcRenderer.invoke('vast:extensions:confirm-install', token),
    cancelInstall: (token) => ipcRenderer.invoke('vast:extensions:cancel-install', token),
    catalog: (input) => ipcRenderer.invoke('vast:extensions:catalog', input),
    catalogDetails: (id) => ipcRenderer.invoke('vast:extensions:catalog-details', id),
    checkForUpdates: (id) => ipcRenderer.invoke('vast:extensions:check-updates', id),
    approveUpdate: (id) => ipcRenderer.invoke('vast:extensions:approve-update', id),
    enable: (id) => ipcRenderer.invoke('vast:extensions:enable', id),
    disable: (id) => ipcRenderer.invoke('vast:extensions:disable', id),
    reload: (id) => ipcRenderer.invoke('vast:extensions:reload', id),
    remove: (id) => ipcRenderer.invoke('vast:extensions:remove', id),
    approvePermissions: (id, permissions) => ipcRenderer.invoke('vast:extensions:approve-permissions', id, permissions),
    setPermission: (id, permission, granted) => ipcRenderer.invoke('vast:extensions:set-permission', id, permission, granted),
    contributions: () => ipcRenderer.invoke('vast:extensions:contributions'),
    prepareSurface: (id, kind, partition) => ipcRenderer.invoke('vast:extensions:prepare-surface', id, kind, partition),
    prepareSidebar: (key) => ipcRenderer.invoke('vast:extensions:prepare-sidebar', key),
    dispatchContribution: (key, context) => ipcRenderer.invoke('vast:extensions:dispatch-contribution', key, context),
    respondToUiRequest: (response) => ipcRenderer.invoke('vast:extensions:ui-response', response),
    reportTabEvent: (name, payload) => ipcRenderer.invoke('vast:extensions:tab-event', name, payload),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('vast:extensions:changed', listener)
      return () => ipcRenderer.removeListener('vast:extensions:changed', listener)
    },
    onContributionsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof callback>[0]): void => callback(snapshot)
      ipcRenderer.on('vast:extensions:contributions-changed', listener)
      return () => ipcRenderer.removeListener('vast:extensions:contributions-changed', listener)
    },
    onUiRequest: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]): void => callback(request)
      ipcRenderer.on('vast:extensions:ui-request', listener)
      return () => ipcRenderer.removeListener('vast:extensions:ui-request', listener)
    }
  },
  ...catAddonApi,
  privacy: {
    clearSiteData: (origin, webContentsId) =>
      ipcRenderer.invoke('vast:privacy:clear-site-data', origin, webContentsId) as Promise<{ ok: boolean; error?: string }>,
    getSiteInformation: (webContentsId, url) => ipcRenderer.invoke('vast:privacy:site-information', webContentsId, url),
    filterStatus: () => ipcRenderer.invoke('vast:privacy:filter-status'),
    updateFilters: () => ipcRenderer.invoke('vast:privacy:update-filters'),
    configureIdentity: (webContentsId, identity, url, identityId) => ipcRenderer.invoke('vast:privacy:configure-identity', webContentsId, identity, url, identityId)
  },
  avidae: {
    status: () => ipcRenderer.invoke('vast:avidae:status'),
    start: () => ipcRenderer.invoke('vast:avidae:start'),
    stop: () => ipcRenderer.invoke('vast:avidae:stop'),
    installDependencies: () => ipcRenderer.invoke('vast:avidae:install-dependencies')
  },
  network: {
    getDevices: () => ipcRenderer.invoke('vast:network:get-devices'),
    scan: (options) => ipcRenderer.invoke('vast:network:scan', options),
    updateDevice: (id, patch) => ipcRenderer.invoke('vast:network:update-device', id, patch),
    forgetDevice: (id) => ipcRenderer.invoke('vast:network:forget-device', id),
    clearCache: () => ipcRenderer.invoke('vast:network:clear-cache'),
    exportInventory: () => ipcRenderer.invoke('vast:network:export-inventory')
  },
  passwords: {
    sessionStatus: () => ipcRenderer.invoke('vast:passwords:session-status'),
    lockSession: () => ipcRenderer.invoke('vast:passwords:lock-session'),
    list: () => ipcRenderer.invoke('vast:passwords:list'),
    create: (input) => ipcRenderer.invoke('vast:passwords:create', input),
    update: (id, input) => ipcRenderer.invoke('vast:passwords:update', id, input),
    remove: (id) => ipcRenderer.invoke('vast:passwords:remove', id),
    copyUsername: (id) => ipcRenderer.invoke('vast:passwords:copy-username', id),
    copyPassword: (id) => ipcRenderer.invoke('vast:passwords:copy-password', id),
    fillAutofill: (webContentsId, origin) => ipcRenderer.invoke('vast:passwords:autofill', webContentsId, origin),
    getAutofillSuggestions: (webContentsId, origin) => ipcRenderer.invoke('vast:passwords:autofill-suggestions', webContentsId, origin),
    fillById: (id, webContentsId, origin) => ipcRenderer.invoke('vast:passwords:fill-by-id', id, webContentsId, origin),
    saveCapturedLogin: (input) => ipcRenderer.invoke('vast:passwords:save-captured', input),
    captureStatus: (webContentsId, origin) => ipcRenderer.invoke('vast:passwords:capture-status', webContentsId, origin),
    captureLogin: (webContentsId, input) => ipcRenderer.invoke('vast:passwords:capture-login', webContentsId, input),
    allowSavePrompts: (origin) => ipcRenderer.invoke('vast:passwords:allow-save-prompts', origin),
    importCsv: () => ipcRenderer.invoke('vast:passwords:import-csv'),
    exportCsv: () => ipcRenderer.invoke('vast:passwords:export-csv'),
    audit: () => ipcRenderer.invoke('vast:passwords:audit'),
    unlockSession: () => ipcRenderer.invoke('vast:passwords:unlock-session'),
    onSessionState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => callback(state)
      ipcRenderer.on('vast:passwords:session-state', listener)
      return () => ipcRenderer.removeListener('vast:passwords:session-state', listener)
    }
  },
  notes: {
    exportMarkdown: (title, body) => ipcRenderer.invoke('vast:notes:export-markdown', title, body)
  },
  notices: {
    list: () => ipcRenderer.invoke('vast:notices:list')
  },
  relay: {
    state: () => ipcRenderer.invoke('vast:relay:state'),
    dismiss: (presentationId) => ipcRenderer.invoke('vast:relay:dismiss', presentationId),
    performAction: (presentationId) => ipcRenderer.invoke('vast:relay:action', presentationId),
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => callback(state)
      ipcRenderer.on('vast:relay:state', listener)
      return () => ipcRenderer.removeListener('vast:relay:state', listener)
    }
  },
  downloads: {
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, item: DownloadItem) => callback(item)
      ipcRenderer.on('vast:download-changed', listener)
      return () => ipcRenderer.removeListener('vast:download-changed', listener)
    },
    showInFolder: (path) =>
      ipcRenderer.invoke('vast:downloads:show-in-folder', path) as Promise<{ ok: boolean; error?: string }>,
    openFile: (path) =>
      ipcRenderer.invoke('vast:downloads:open-file', path) as Promise<{ ok: boolean; error?: string }>,
    pause: (id) => ipcRenderer.invoke('vast:downloads:pause', id) as Promise<{ ok: boolean; error?: string }>,
    resume: (id) => ipcRenderer.invoke('vast:downloads:resume', id) as Promise<{ ok: boolean; error?: string }>,
    cancel: (id) => ipcRenderer.invoke('vast:downloads:cancel', id) as Promise<{ ok: boolean; error?: string }>,
    retry: (id) => ipcRenderer.invoke('vast:downloads:retry', id) as Promise<{ ok: boolean; error?: string }>,
    clearCompleted: () => ipcRenderer.invoke('vast:downloads:clear-completed') as Promise<{ ok: boolean; error?: string }>
  },
  ui: {
    onNotification: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: Parameters<typeof callback>[0]) => callback(notification)
      ipcRenderer.on('vast:ui:notification', listener)
      return () => ipcRenderer.removeListener('vast:ui:notification', listener)
    },
    onPrompt: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, prompt: Parameters<typeof callback>[0]) => callback(prompt)
      ipcRenderer.on('vast:ui:prompt', listener)
      return () => ipcRenderer.removeListener('vast:ui:prompt', listener)
    },
    resolvePrompt: (id, actionId) =>
      ipcRenderer.invoke('vast:ui:resolve-prompt', id, actionId) as Promise<{ ok: boolean; error?: string }>
  },
  shell: {
    openExternal: (url) =>
      ipcRenderer.invoke('vast:shell:open-external', url) as Promise<{ ok: boolean; error?: string }>
  },
  oauth: {
    requestFallback: (input) =>
      ipcRenderer.invoke('vast:oauth:fallback', input) as Promise<{ ok: boolean; error?: string }>
  },
  browser: {
    onOpenTabRequest: (callback) => tabOpenRequests.subscribe(callback),
    onExternalProtocolRequest: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) => callback(request)
      ipcRenderer.on('vast:browser:external-protocol-request', listener)
      return () => ipcRenderer.removeListener('vast:browser:external-protocol-request', listener)
    },
    resolveExternalProtocolRequest: (id, allow) =>
      ipcRenderer.invoke('vast:browser:resolve-external-protocol', id, allow) as Promise<{ ok: boolean; error?: string }>,
    onHtmlFullscreenState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on('vast:browser:html-fullscreen-state', listener)
      return () => ipcRenderer.removeListener('vast:browser:html-fullscreen-state', listener)
    },
    onMediaCaptureState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on('vast:browser:media-capture-state', listener)
      return () => ipcRenderer.removeListener('vast:browser:media-capture-state', listener)
    },
    setKeepAwake: (webContentsId, keepAwake) =>
      ipcRenderer.invoke('vast:browser:set-keep-awake', webContentsId, keepAwake) as Promise<{ ok: boolean; error?: string }>,
    onShortcut: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, shortcut: string) => callback(shortcut)
      ipcRenderer.on('vast:shortcut', listener)
      return () => ipcRenderer.removeListener('vast:shortcut', listener)
    },
    onPrepareClose: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string) => { void callback(requestId) }
      ipcRenderer.on('vast:window:prepare-close', listener)
      return () => ipcRenderer.removeListener('vast:window:prepare-close', listener)
    },
    closeReady: (requestId, result) =>
      ipcRenderer.invoke('vast:window:close-ready', requestId, result) as Promise<{ ok: boolean; error?: string }>,
    detachTab: (tab) =>
      ipcRenderer.invoke('vast:browser:detach-tab', tab) as Promise<{ ok: boolean; error?: string }>,
    reattachDetachedTab: (tab) =>
      ipcRenderer.invoke('vast:browser:reattach-detached-tab', tab) as Promise<{ ok: boolean; attached?: boolean; error?: string }>,
    onDetachedTabReattach: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, tab: DetachedTabPayload) => callback(tab)
      ipcRenderer.on('vast:browser:reattach-detached-tab', listener)
      return () => ipcRenderer.removeListener('vast:browser:reattach-detached-tab', listener)
    },
    syncDetachedTab: (tab) =>
      ipcRenderer.invoke('vast:browser:sync-detached-tab', tab) as Promise<{ ok: boolean; error?: string }>,
    copyImageAt: (webContentsId, x, y) =>
      ipcRenderer.invoke('vast:browser:copy-image-at', webContentsId, x, y) as Promise<{ ok: boolean; error?: string }>,
    downloadUrl: (webContentsId, url) =>
      ipcRenderer.invoke('vast:browser:download-url', webContentsId, url) as Promise<{ ok: boolean; error?: string }>,
    printWebContents: (webContentsId) =>
      ipcRenderer.invoke('vast:browser:print-web-contents', webContentsId) as Promise<{ ok: boolean; error?: string }>
  },
  pdf: {
    load: (url) =>
      ipcRenderer.invoke('vast:pdf:load', url) as Promise<{
        ok: boolean
        data?: Uint8Array
        mimeType?: string
        filename?: string
        error?: string
      }>,
    print: (data, filename) =>
      ipcRenderer.invoke('vast:pdf:print', data, filename) as Promise<{ ok: boolean; error?: string }>
  },
  app: {
    platform: process.platform,
    guestAutofillPreloadUrl,
    window: {
      state: () => ipcRenderer.invoke('vast:window:state'),
      minimize: () => ipcRenderer.invoke('vast:window:minimize'),
      toggleMaximize: () => ipcRenderer.invoke('vast:window:toggle-maximize'),
      close: () => ipcRenderer.invoke('vast:window:close'),
      onStateChanged: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => callback(state)
        ipcRenderer.on('vast:window:state-changed', listener)
        return () => ipcRenderer.removeListener('vast:window:state-changed', listener)
      }
    },
    startup: {
      openingAnimationEnabled,
      openingAnimationHandledBySplash,
      openingAnimationSoundVolume,
      catAddonAvailable: __VAST_CAT_ADDON_AVAILABLE__
    },
    versions: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? ''
    },
    diagnostics: () => ipcRenderer.invoke('vast:app:diagnostics'),
    processMetrics: () => ipcRenderer.invoke('vast:app:process-metrics'),
    performanceCounters: () => ipcRenderer.invoke('vast:performance:counters'),
    getDefaultBrowserStatus: () => ipcRenderer.invoke('vast:app:default-browser-status'),
    openDefaultBrowserSettings: () => ipcRenderer.invoke('vast:app:open-default-browser-settings')
  },
  updater: {
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
      ipcRenderer.on('vast:updater', listener)
      return () => ipcRenderer.removeListener('vast:updater', listener)
    },
    status: () => ipcRenderer.invoke('vast:updater:status'),
    install: () => ipcRenderer.invoke('vast:updater:install') as Promise<{ ok: boolean; error?: string }>
  }
} as VastApi

contextBridge.exposeInMainWorld('vast', api)
