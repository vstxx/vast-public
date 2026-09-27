import { contextBridge, ipcRenderer, webUtils } from 'electron/renderer'
import {
  parseOpeningHandledStartupFlag,
  parseOpeningHandledStartupSearch,
  parseOpeningStartupFlag,
  parseOpeningStartupSearch,
  parseOpeningStartupVolumeFlag,
  parseOpeningStartupVolumeSearch
} from '../shared/opening-startup'
import { DEFAULT_SETTINGS } from '../shared/constants'
import type { BrowserTabOpenRequest, DetachedTabPayload, DownloadItem, ExtensionCompatibilityTabCommand, PersistedData, VastApi } from '../shared/types'
import { TabOpenRequestBuffer } from './tab-open-request-buffer'

const openingAnimationEnabled = parseOpeningStartupSearch(window.location.search) || parseOpeningStartupFlag(process.argv)
const openingAnimationSoundVolume = parseOpeningStartupVolumeSearch(
  window.location.search,
  parseOpeningStartupVolumeFlag(process.argv, DEFAULT_SETTINGS.openingAnimationSoundVolume)
)
const openingAnimationHandledBySplash =
  parseOpeningHandledStartupSearch(window.location.search) || parseOpeningHandledStartupFlag(process.argv)
const guestPreloadUrl = process.argv.find((value) => value.startsWith('--vast-guest-preload='))?.slice('--vast-guest-preload='.length) ?? ''
const startupRadius = Number(process.argv.find((value) => value.startsWith('--vast-radius='))?.slice('--vast-radius='.length))
window.addEventListener('DOMContentLoaded', () => {
  const radius = Number.isFinite(startupRadius) ? Math.min(36, Math.max(6, startupRadius)) : DEFAULT_SETTINGS.appearance.cornerRadius
  document.documentElement.style.setProperty('--vast-radius-base', `${radius}px`)
}, { once: true })

const performanceProbeEnabled = process.argv.includes('--vast-performance-probe=1')

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
  newTabBackground: {
    get: () => ipcRenderer.invoke('vast:new-tab-background:get'),
    choose: () => ipcRenderer.invoke('vast:new-tab-background:choose')
  },
  importer: {
    discover: () => ipcRenderer.invoke('vast:importer:discover'),
    run: (request) => ipcRenderer.invoke('vast:importer:run', request)
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
    onOpenPopup: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, extensionId: unknown): void => {
        if (typeof extensionId === 'string') callback(extensionId)
      }
      ipcRenderer.on('vast:extensions:open-popup', listener)
      return () => ipcRenderer.removeListener('vast:extensions:open-popup', listener)
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
  privacy: {
    clearSiteData: (origin, webContentsId) =>
      ipcRenderer.invoke('vast:privacy:clear-site-data', origin, webContentsId) as Promise<{ ok: boolean; error?: string }>,
    getSiteInformation: (webContentsId, url) => ipcRenderer.invoke('vast:privacy:site-information', webContentsId, url),
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
    listCurrent: () => ipcRenderer.invoke('vast:downloads:list-current') as Promise<DownloadItem[]>,
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
    writeClipboardText: (text) => ipcRenderer.invoke('vast:browser:write-clipboard-text', text),
    onOpenTabRequest: (callback) => tabOpenRequests.subscribe(callback),
    onExtensionCompatibilityTabCommand: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, command: ExtensionCompatibilityTabCommand): void => callback(command)
      ipcRenderer.on('vast:extension-compat:tab-command', listener)
      return () => ipcRenderer.removeListener('vast:extension-compat:tab-command', listener)
    },
    confirmExtensionCompatibilityTab: (requestId, webContentsId) =>
      ipcRenderer.invoke('vast:extension-compat:confirm-tab', requestId, webContentsId) as Promise<{ ok: boolean; error?: string }>,
    selectExtensionCompatibilityTab: (webContentsId) =>
      ipcRenderer.invoke('vast:extension-compat:select-tab', webContentsId) as Promise<{ ok: boolean; error?: string }>,
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
    onCapture: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, capture: Parameters<typeof callback>[0]): void => callback(capture)
      ipcRenderer.on('vast:pdf:capture', listener)
      return () => ipcRenderer.removeListener('vast:pdf:capture', listener)
    },
    captures: (guestWebContentsId) => ipcRenderer.invoke('vast:pdf:captures', guestWebContentsId),
    openLocalFile: (file) => {
      try {
        const path = webUtils.getPathForFile(file)
        if (!path) return Promise.resolve({ ok: false, error: 'The dropped item is not backed by a local file.' })
        return ipcRenderer.invoke('vast:pdf:open-local-file', path)
      } catch {
        return Promise.resolve({ ok: false, error: 'The dropped item is not a valid local file.' })
      }
    },
    info: (id) => ipcRenderer.invoke('vast:pdf:info', id),
    readRange: (id, begin, end) => ipcRenderer.invoke('vast:pdf:read-range', id, begin, end),
    save: (id, filename) => ipcRenderer.invoke('vast:pdf:save', id, filename),
    openExternal: (id) => ipcRenderer.invoke('vast:pdf:open-external-fallback', id),
    print: (id) => ipcRenderer.invoke('vast:pdf:print', id)
  },
  app: {
    platform: process.platform,
    guestPreloadUrl,
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
      openingAnimationSoundVolume
    },
    uiReady: () => ipcRenderer.send('vast:renderer-ui-ready'),
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
