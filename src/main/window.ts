import { app, BrowserWindow, screen } from 'electron/main'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupWindowSecurity } from './sessions'
import { windowRegistry, type VastWindowKind } from './windows/WindowRegistry'
import { windowCloseCoordinator } from './windows/WindowCloseCoordinator'
import { isDev } from './electron-runtime'
import {
  serializeOpeningHandledStartupFlag,
  serializeOpeningStartupFlag,
  serializeOpeningStartupQuery,
  serializeOpeningStartupVolumeFlag
} from '../shared/opening-startup'
import type { BrowserSettings, DetachedTabPayload, PersistedData } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/constants'
import { recordDiagnosticsEvent } from './diagnostics-events'
import { persistWindowState, restoredWindowState } from './windows/window-state'
import { markPerformance, performanceProbeEnabled } from './performance-probe'
import type { ExtensionManager } from './extensions/extension-manager'

const APP_ICON_PATH = isDev
  ? join(__dirname, process.platform === 'win32' ? '../../assets/logos/vasticon-windows.png' : '../../assets/logos/vasticon.png')
  : join(process.resourcesPath, process.platform === 'win32' ? 'app-icon-windows.png' : 'app-icon.png')
const GUEST_PRELOAD_URL = pathToFileURL(join(__dirname, '../preload/guest.js')).toString()

type MainWindowOptions = {
  kind?: Extract<VastWindowKind, 'primary' | 'normal' | 'detached'>
  openingHandledBySplash?: boolean
  showInitially?: boolean
  showWhenReady?: boolean
  detachedTab?: DetachedTabPayload
  onDetachTab?: (tab: DetachedTabPayload) => void | Promise<void>
  extensionManager?: ExtensionManager
}

export function createMainWindow(
  _onDataSaved?: (data: PersistedData) => void,
  getSettings?: () => BrowserSettings,
  options: MainWindowOptions = {}
): BrowserWindow {
  const settingsProvider = getSettings ?? (() => DEFAULT_SETTINGS)
  const startupSettings = settingsProvider()
  const openingHandledBySplash = options.openingHandledBySplash === true
  const rendererStartupSettings = openingHandledBySplash || options.detachedTab
    ? { ...startupSettings, openingAnimation: false }
    : startupSettings
  const openingStartupQuery: Record<string, string> = serializeOpeningStartupQuery(rendererStartupSettings, openingHandledBySplash)
  if (options.detachedTab) {
    openingStartupQuery.vastDetachedTab = JSON.stringify(options.detachedTab)
  }
  const windowKind = options.kind ?? (options.detachedTab ? 'detached' : 'normal')
  const savedWindowState = restoredWindowState(windowKind)
  const targetDisplay = savedWindowState
    ? screen.getDisplayMatching(savedWindowState)
    : screen.getPrimaryDisplay()
  const workArea = targetDisplay.workArea
  const targetWidth = savedWindowState?.width ?? Math.min(1480, workArea.width)
  const targetHeight = savedWindowState?.height ?? Math.min(980, workArea.height)
  const targetBounds = {
    width: targetWidth,
    height: targetHeight,
    x: savedWindowState?.x ?? Math.round(workArea.x + (workArea.width - targetWidth) / 2),
    y: savedWindowState?.y ?? Math.round(workArea.y + (workArea.height - targetHeight) / 2)
  }

  const mainWindow = new BrowserWindow({
    ...targetBounds,
    minWidth: 980,
    minHeight: 680,
    show: options?.showInitially ?? true,
    backgroundColor: '#030406',
    title: 'Vast',
    icon: APP_ICON_PATH,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: process.platform === 'win32'
      ? false
      : {
          color: '#00000000',
          symbolColor: '#d7dae2',
          height: 48
        },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      additionalArguments: [
        `--vast-radius=${startupSettings.appearance.cornerRadius}`,
        serializeOpeningStartupFlag(rendererStartupSettings),
        serializeOpeningStartupVolumeFlag(startupSettings),
        serializeOpeningHandledStartupFlag(openingHandledBySplash),
        `--vast-guest-preload=${GUEST_PRELOAD_URL}`,
        ...(performanceProbeEnabled() ? ['--vast-performance-probe=1'] : [])
      ],
      backgroundThrottling: process.env.VAST_DISABLE_BACKGROUND_THROTTLING === '1' ? false : true
    }
  })

  persistWindowState(mainWindow, windowKind)

  markPerformance('browser-window-constructed', { kind: windowKind, windowId: mainWindow.id })
  mainWindow.once('ready-to-show', () => {
    markPerformance('window-ready-to-show', { kind: windowKind, windowId: mainWindow.id })
    if (options.showWhenReady && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  mainWindow.webContents.once('did-finish-load', () => {
    markPerformance('renderer-load-finished', { kind: windowKind, windowId: mainWindow.id })
  })

  windowRegistry.register(mainWindow, windowKind)
  mainWindow.once('closed', () => {
    // Native extension hosts are hidden BrowserWindows; they must not keep the
    // application alive after its last browser window has saved and closed.
    if (process.platform !== 'darwin' && windowRegistry.vastWindows().length === 0) app.quit()
  })
  windowCloseCoordinator.install(mainWindow)
  setupWindowSecurity(mainWindow, settingsProvider, _onDataSaved, options.extensionManager)
  mainWindow.webContents.on('did-finish-load', () => windowRegistry.markRendererReady(mainWindow))
  const publishWindowState = (): void => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('vast:window:state-changed', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    })
  }
  mainWindow.on('show', publishWindowState)
  mainWindow.on('hide', publishWindowState)
  mainWindow.on('minimize', publishWindowState)
  mainWindow.on('restore', publishWindowState)
  mainWindow.on('maximize', publishWindowState)
  mainWindow.on('unmaximize', publishWindowState)
  mainWindow.on('enter-full-screen', publishWindowState)
  mainWindow.on('leave-full-screen', publishWindowState)
  mainWindow.webContents.on('did-finish-load', publishWindowState)
  if (savedWindowState?.maximized) mainWindow.once('ready-to-show', () => mainWindow.maximize())

  const rendererCrashTimes: number[] = []
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void recordDiagnosticsEvent('renderer', 'vast-window-renderer-gone', {
      windowId: mainWindow.id,
      kind: options.kind ?? 'normal',
      reason: details.reason,
      exitCode: details.exitCode
    })
    if (mainWindow.isDestroyed() || details.reason === 'clean-exit' || details.reason === 'killed') return
    const now = Date.now()
    rendererCrashTimes.push(now)
    while (rendererCrashTimes[0] && rendererCrashTimes[0] < now - 60_000) rendererCrashTimes.shift()
    if (rendererCrashTimes.length > 2) return
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.reload()
    }, 500)
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(openingStartupQuery)) rendererUrl.searchParams.set(key, value)
    void mainWindow.loadURL(rendererUrl.toString())
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: openingStartupQuery })
  }

  return mainWindow
}
