import { BrowserWindow, app, nativeTheme, protocol, session, webContents } from 'electron/main'
import { join } from 'node:path'
import { createMainWindow } from './window'
import { applySpoofingToAllWebContents, checkpointBrowserSessionData, clearSiteData, prepareBrowserSessionSecurity, setupTrackerBlocking, setupUserAgent } from './sessions'
import { loadData } from './storage'
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../shared/constants'
import { isOpeningAnimationEnabled } from '../shared/opening-startup'
import type { BrowserSettings, DetachedTabPayload } from '../shared/types'
import { assertPublicDistributionGuards, getBuildMetadata } from './build-info'
import { setAppUserModelId, watchWindowShortcuts } from './electron-runtime'
import { configureVastUserDataPath } from './data-path'
import { setupIpc } from './ipc'
import { ExternalNavigationRouter } from './windows/ExternalNavigationRouter'
import { windowRegistry } from './windows/WindowRegistry'
import { recordDiagnosticsEvent } from './diagnostics-events'
import { flushPerformanceReport, markPerformance, registerPerformanceProbeIpc } from './performance-probe'
import { completeLegacyDefaultSessionMigration, prepareLegacyDefaultSessionMigration, type LegacySessionMigrationPlan } from './session-continuity'
import { isUpdateRestartInProgress } from './update-lifecycle'
import { initializePasswordVaultSessionLifecycle, lockPasswordVaultSession } from './password-vault-session'
import { settingsAllowedByRuntimeFeaturePolicy } from './runtime-feature-policy'
import { createVastRelayService } from './relay/runtime'
import type { ExtensionManager } from './extensions/extension-manager'
import { extensionHubOrigin } from './extensions/extension-hub-config'
import { VAST_EXTENSION_SCHEME } from './extensions/extension-resource-protocol'
import { disposePdfResources } from './pdf-resources'

declare const __VAST_INCLUDE_INTERNAL_TEST_HARNESS__: boolean

// Set the stable product identity before resolving userData/sessionData.
app.setName('Vast')
configureVastUserDataPath()
protocol.registerSchemesAsPrivileged([{ scheme: VAST_EXTENSION_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, allowServiceWorkers: false } }])
markPerformance('main-module-ready')
registerPerformanceProbeIpc()

if (process.platform === 'win32' && getBuildMetadata().distributionChannel === 'direct') {
  // Groups windows under the Vast identity in the Windows taskbar.
  app.setAppUserModelId('app.vast.browser')
}

assertPublicDistributionGuards()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
const pendingExternalArguments: string[][] = []
const pendingExternalUrls: string[] = []
const pendingExternalFiles: string[] = []
let externalNavigationRouter: ExternalNavigationRouter | undefined
let legacySessionMigration: LegacySessionMigrationPlan | undefined

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  try {
    legacySessionMigration = prepareLegacyDefaultSessionMigration()
  } catch (error) {
    console.warn('[session-continuity] Could not stage legacy browser session migration:', error)
  }
  app.on('second-instance', (_event, commandLine) => {
    if (externalNavigationRouter) externalNavigationRouter.acceptArguments(commandLine)
    else pendingExternalArguments.push([...commandLine])
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (externalNavigationRouter) externalNavigationRouter.acceptUrl(url)
    else pendingExternalUrls.push(url)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (externalNavigationRouter) externalNavigationRouter.acceptFile(path)
    else pendingExternalFiles.push(path)
  })
}

const buildMetadata = getBuildMetadata()
if (buildMetadata.performanceGpu && !buildMetadata.safeGpu) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization')
}

let currentSettings = DEFAULT_SETTINGS
let relayService: ReturnType<typeof createVastRelayService> | undefined
let extensionManager: ExtensionManager | undefined
let extensionUpdateStartupTimer: NodeJS.Timeout | undefined
let extensionUpdateInterval: NodeJS.Timeout | undefined
const gpuCrashTimes: number[] = []
let shutdownCleanupStarted = false
let shutdownCleanupComplete = false

app.on('will-quit', disposePdfResources)

app.on('child-process-gone', (_event, details) => {
  const now = Date.now()
  if (details.type === 'GPU') {
    gpuCrashTimes.push(now)
    while (gpuCrashTimes[0] && gpuCrashTimes[0] < now - 5 * 60_000) gpuCrashTimes.shift()
  }
  void recordDiagnosticsEvent(details.type === 'GPU' ? 'gpu' : 'child', 'child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? '',
    repeatedGpuCrashes: details.type === 'GPU' ? gpuCrashTimes.length : 0
  })
  if (details.type === 'GPU' && gpuCrashTimes.length >= 3) {
    for (const window of windowRegistry.vastWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('vast:runtime-warning', {
          kind: 'gpu-crashes',
          message: 'Vast detected repeated graphics-process crashes. Restart with Safe GPU mode if rendering remains unstable.'
        })
      }
    }
  }
})

function nativeThemeSource(settings: BrowserSettings): 'dark' | 'light' | 'system' {
  if (settings.theme === 'system') return 'system'
  return settings.theme === 'light' ? 'light' : 'dark'
}

function websiteDarkModeEnabled(settings: BrowserSettings): boolean {
  return settings.appearance.forceDarkModeWebsites === true
}

function titleBarUsesDark(settings: BrowserSettings): boolean {
  if (settings.theme === 'system') return nativeTheme.shouldUseDarkColors
  return settings.theme !== 'light'
}

function runtimeSettings(settings: BrowserSettings): BrowserSettings {
  return settingsAllowedByRuntimeFeaturePolicy(settings)
}

function syncTitleBarOverlay(): void {
  if (process.platform !== 'linux') return
  const dark = titleBarUsesDark(currentSettings)
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: dark ? '#f3f5f8' : '#111827',
        height: 48
      })
    } catch {
      // Splash and auxiliary windows may not opt into titlebar overlays.
    }
  }
}

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  markPerformance('app-ready')
  if (getBuildMetadata().distributionChannel === 'direct') setAppUserModelId('app.vast.browser')
  app.on('browser-window-created', (_, window) => {
    watchWindowShortcuts(window)
  })
  app.on('browser-window-focus', () => relayService?.refreshPresentationTarget())
  initializePasswordVaultSessionLifecycle()

  const [storageResult] = await Promise.allSettled([loadData()])
  let startupData = DEFAULT_DATA
  if (storageResult.status === 'fulfilled') {
    const data = storageResult.value
    startupData = data
    currentSettings = data.settings
    nativeTheme.themeSource = nativeThemeSource(data.settings)
    markPerformance('startup-storage-loaded')
  } else {
    console.warn('[main] Failed to load settings before startup:', storageResult.reason)
  }
  markPerformance('startup-settings-ready')

  setupTrackerBlocking(() => currentSettings)
  setupUserAgent(() => runtimeSettings(currentSettings))
  prepareBrowserSessionSecurity(() => currentSettings)
  applySpoofingToAllWebContents(runtimeSettings(currentSettings))
  if (legacySessionMigration) {
    try {
      await completeLegacyDefaultSessionMigration(legacySessionMigration)
    } catch (error) {
      console.warn('[session-continuity] Could not complete legacy browser session migration:', error)
    }
  }
  const [{ ExtensionManager }, { matchesExtensionMatchPattern }] = await Promise.all([
    import('./extensions/extension-manager'),
    import('../shared/extension-match-pattern')
  ])
  extensionManager = new ExtensionManager({
    userDataRoot: app.getPath('userData'),
    hubOrigin: extensionHubOrigin(app.isPackaged),
    sessionProvider: (partition) => session.fromPartition(partition),
    nativeSurfacePreloadPath: join(app.getAppPath(), 'out', 'preload', 'extension-host.js'),
    reloadMatchingTabs: (patterns) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed() || contents.getType() !== 'webview') continue
        const url = contents.getURL()
        if (patterns.some((pattern) => matchesExtensionMatchPattern(url, pattern))) contents.reload()
      }
    },
    onChanged: () => windowRegistry.broadcast('vast:extensions:changed'),
    onContributionsChanged: (snapshot) => windowRegistry.broadcast('vast:extensions:contributions-changed', snapshot)
  })
  try {
    await extensionManager.initialize(startupData.workspaces)
  } catch (error) {
    console.warn('[extensions] Could not initialize the extension registry:', error)
  }

  const onDataSaved = (data: Awaited<ReturnType<typeof loadData>>): void => {
    const previousSettings = currentSettings
    currentSettings = data.settings
    nativeTheme.themeSource = nativeThemeSource(data.settings)
    if (JSON.stringify(runtimeSettings(previousSettings).spoofing) !== JSON.stringify(runtimeSettings(data.settings).spoofing)) {
      applySpoofingToAllWebContents(runtimeSettings(data.settings), true)
    }
    if (websiteDarkModeEnabled(previousSettings) !== websiteDarkModeEnabled(data.settings)) {
      windowRegistry.broadcast('vast:website-dark-mode-changed', websiteDarkModeEnabled(data.settings))
    }
    if (previousSettings.theme !== data.settings.theme) syncTitleBarOverlay()
    void extensionManager?.syncWorkspaces(data.workspaces).catch((error) => {
      console.warn('[extensions] Could not synchronize workspace sessions:', error)
    })
  }
  const openDetachedTabWindow = (detachedTab: DetachedTabPayload): void => {
    createMainWindow(onDataSaved, () => currentSettings, {
      kind: 'detached',
      detachedTab,
      extensionManager,
      onDetachTab: openDetachedTabWindow
    })
    syncTitleBarOverlay()
  }

  relayService = createVastRelayService(() => currentSettings)
  setupIpc({
    onDataSaved,
    onDetachTab: openDetachedTabWindow,
    relayService,
    extensionManager
  })

  const watchExternalNavigation = (window: BrowserWindow): BrowserWindow => {
    window.webContents.on('did-finish-load', () => externalNavigationRouter?.rendererReady(window))
    return window
  }
  externalNavigationRouter = new ExternalNavigationRouter(windowRegistry, () =>
    watchExternalNavigation(
      createMainWindow(onDataSaved, () => currentSettings, {
        kind: 'normal',
        extensionManager,
        onDetachTab: openDetachedTabWindow
      })
    )
  )
  const openingEnabled = isOpeningAnimationEnabled(currentSettings)
  const mainWindow = watchExternalNavigation(createMainWindow(onDataSaved, () => currentSettings, {
    kind: 'primary',
    openingHandledBySplash: false,
    openingPresentation: openingEnabled,
    showInitially: !openingEnabled,
    showWhenReady: openingEnabled,
    extensionManager,
    onDetachTab: openDetachedTabWindow
  }))
  markPerformance('primary-window-created')
  externalNavigationRouter.acceptArguments(process.argv)
  for (const args of pendingExternalArguments.splice(0)) externalNavigationRouter.acceptArguments(args)
  for (const url of pendingExternalUrls.splice(0)) externalNavigationRouter.acceptUrl(url)
  for (const path of pendingExternalFiles.splice(0)) externalNavigationRouter.acceptFile(path)
  syncTitleBarOverlay()
  mainWindow.webContents.once('did-finish-load', () => {
    // Relay is intentionally started only after the primary browser shell is usable.
    // The service itself delays its first request and never blocks window creation.
    void relayService?.start()
    if (__VAST_INCLUDE_INTERNAL_TEST_HARNESS__ && process.env.VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK === '1' && process.env.VAST_TEST_USER_DATA_DIR) {
      void import('./google-auth-test-harness').then(({ startInternalGoogleAuthEmailCheck }) => {
        if (startInternalGoogleAuthEmailCheck()) console.info('[google-auth] Started isolated internal email-only check.')
      }).catch((error) => console.warn('[google-auth] Could not start internal email-only check:', error))
    }
    // Keep updater module parsing and update-service initialization outside the
    // critical path to the first usable browser shell.
    const updaterTimer = setTimeout(() => {
      void import('./updater').then(({ setupAutoUpdater }) => setupAutoUpdater(mainWindow)).catch((error) => {
        console.warn('[main] Failed to initialize updater:', error)
      })
    }, 2_000)
    mainWindow.once('closed', () => clearTimeout(updaterTimer))
    extensionUpdateStartupTimer = setTimeout(() => {
      void extensionManager?.checkForUpdates().catch((error) => console.warn('[extensions:update] Background update check failed:', error))
      extensionUpdateInterval = setInterval(() => {
        void extensionManager?.checkForUpdates().catch((error) => console.warn('[extensions:update] Background update check failed:', error))
      }, 18 * 60 * 60_000)
      extensionUpdateInterval.unref()
    }, 30_000)
    extensionUpdateStartupTimer.unref()
  })

  nativeTheme.on('updated', syncTitleBarOverlay)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      watchExternalNavigation(createMainWindow(onDataSaved, () => currentSettings, { kind: 'normal', extensionManager, onDetachTab: openDetachedTabWindow }))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (extensionUpdateStartupTimer) clearTimeout(extensionUpdateStartupTimer)
  if (extensionUpdateInterval) clearInterval(extensionUpdateInterval)
  relayService?.stop()
  lockPasswordVaultSession('system-lock')
  if (isUpdateRestartInProgress() || shutdownCleanupComplete) return
  event.preventDefault()
  if (shutdownCleanupStarted) return
  shutdownCleanupStarted = true
  void (async () => {
    try {
      await import('./avidae').then(({ stopAvidae }) => stopAvidae()).catch((error) => {
        console.warn('[main] Failed to stop Video & Audio during shutdown:', error)
      })
      await extensionManager?.shutdown()
      await extensionManager?.flush()
      let clearCookiesOnExit = false
      try {
        clearCookiesOnExit = (await loadData()).settings.privacy.clearCookiesOnExit
      } catch (error) {
        console.warn('[main] Could not read privacy settings during shutdown; preserving website sessions:', error)
      }
      if (clearCookiesOnExit) await clearSiteData()
      else await checkpointBrowserSessionData()
    } catch (error) {
      console.warn('[main] Failed during shutdown cleanup:', error)
    } finally {
      shutdownCleanupComplete = true
      app.quit()
    }
  })()
})

app.on('will-quit', flushPerformanceReport)
