import { BrowserWindow, ipcMain, screen } from 'electron/main'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupDownloadsWithSettings } from './downloads'
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
import {
  OPENING_COMPLETE_IPC_CHANNEL,
  OPENING_PRESENTATION,
  OPENING_SEQUENCE
} from '../shared/opening-sequence'

const APP_ICON_PATH = isDev
  ? join(__dirname, process.platform === 'win32' ? '../../assets/logos/vasticon-windows.png' : '../../assets/logos/vasticon.png')
  : join(process.resourcesPath, process.platform === 'win32' ? 'app-icon-windows.png' : 'app-icon.png')
const GUEST_AUTOFILL_PRELOAD_URL = pathToFileURL(join(__dirname, '../preload/guest-autofill.js')).toString()

function roundedWindowShape(width: number, height: number, radius: number): Electron.Rectangle[] {
  const safeRadius = Math.max(0, Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)))
  if (safeRadius === 0) return [{ x: 0, y: 0, width, height }]
  const rows: Electron.Rectangle[] = []
  for (let y = 0; y < safeRadius; y += 1) {
    const distance = safeRadius - y - 0.5
    const inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt(safeRadius * safeRadius - distance * distance)))
    rows.push({ x: inset, y, width: width - inset * 2, height: 1 })
    rows.push({ x: inset, y: height - y - 1, width: width - inset * 2, height: 1 })
  }
  rows.push({ x: 0, y: safeRadius, width, height: height - safeRadius * 2 })
  return rows
}

type MainWindowOptions = {
  kind?: Extract<VastWindowKind, 'primary' | 'normal' | 'detached'>
  openingHandledBySplash?: boolean
  openingPresentation?: boolean
  showInitially?: boolean
  showWhenReady?: boolean
  detachedTab?: DetachedTabPayload
  onDetachTab?: (tab: DetachedTabPayload) => void | Promise<void>
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
  const openingPresentation = options.openingPresentation === true && windowKind === 'primary'
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
  const openingWidth = Math.min(OPENING_PRESENTATION.width, Math.max(360, workArea.width - 48))
  const openingHeight = Math.min(OPENING_PRESENTATION.height, Math.max(240, workArea.height - 48))
  const openingBounds = {
    width: openingWidth,
    height: openingHeight,
    x: Math.round(workArea.x + (workArea.width - openingWidth) / 2),
    y: Math.round(workArea.y + (workArea.height - openingHeight) / 2)
  }
  const initialBounds = openingPresentation ? openingBounds : targetBounds

  const mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: openingPresentation ? Math.min(OPENING_PRESENTATION.minimumWidth, openingWidth) : 980,
    minHeight: openingPresentation ? Math.min(OPENING_PRESENTATION.minimumHeight, openingHeight) : 680,
    resizable: !openingPresentation,
    maximizable: !openingPresentation,
    frame: !openingPresentation,
    hasShadow: !openingPresentation,
    ...(process.platform === 'win32' && openingPresentation
      ? { accentColor: '#030406', backgroundMaterial: 'none' as const }
      : {}),
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
        serializeOpeningStartupFlag(rendererStartupSettings),
        serializeOpeningStartupVolumeFlag(startupSettings),
        serializeOpeningHandledStartupFlag(openingHandledBySplash),
        `--vast-guest-autofill-preload=${GUEST_AUTOFILL_PRELOAD_URL}`,
        ...(performanceProbeEnabled() ? ['--vast-performance-probe=1'] : [])
      ],
      backgroundThrottling: process.env.VAST_DISABLE_BACKGROUND_THROTTLING === '1' ? false : true
    }
  })

  if (openingPresentation && (process.platform === 'win32' || process.platform === 'linux')) {
    mainWindow.setShape(roundedWindowShape(openingWidth, openingHeight, OPENING_PRESENTATION.cornerRadius))
  }

  let openingRevealed = !openingPresentation
  let openingFallbackTimer: NodeJS.Timeout | undefined
  let persistenceInstalled = false
  const installWindowStatePersistence = (): void => {
    if (persistenceInstalled) return
    persistenceInstalled = true
    persistWindowState(mainWindow, windowKind)
  }
  const revealBrowserWindow = (): void => {
    if (openingRevealed || mainWindow.isDestroyed()) return
    openingRevealed = true
    clearTimeout(openingFallbackTimer)
    mainWindow.hide()
    if (process.platform === 'win32' || process.platform === 'linux') mainWindow.setShape([])
    mainWindow.setHasShadow(true)
    if (process.platform === 'win32') {
      mainWindow.setAccentColor(null)
      mainWindow.setBackgroundMaterial('auto')
    }
    mainWindow.setResizable(true)
    mainWindow.setMaximizable(true)
    mainWindow.setMinimumSize(980, 680)
    mainWindow.setBounds(targetBounds, false)
    if (savedWindowState?.maximized) mainWindow.maximize()
    installWindowStatePersistence()
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      mainWindow.show()
      mainWindow.focus()
      markPerformance('opening-browser-window-revealed', { windowId: mainWindow.id })
    }, OPENING_PRESENTATION.revealDelayMs)
  }
  const onOpeningComplete = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== mainWindow.webContents) return
    revealBrowserWindow()
  }
  if (openingPresentation) {
    ipcMain.on(OPENING_COMPLETE_IPC_CHANNEL, onOpeningComplete)
    mainWindow.once('closed', () => {
      clearTimeout(openingFallbackTimer)
      ipcMain.removeListener(OPENING_COMPLETE_IPC_CHANNEL, onOpeningComplete)
    })
  } else {
    installWindowStatePersistence()
  }

  markPerformance('browser-window-constructed', { kind: windowKind, windowId: mainWindow.id })
  mainWindow.once('ready-to-show', () => {
    markPerformance('window-ready-to-show', { kind: windowKind, windowId: mainWindow.id })
    if (options.showWhenReady && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    if (openingPresentation) {
      openingFallbackTimer = setTimeout(
        revealBrowserWindow,
        OPENING_SEQUENCE.overlayHideMs + OPENING_PRESENTATION.fallbackGraceMs
      )
    }
  })
  mainWindow.webContents.once('did-finish-load', () => {
    markPerformance('renderer-load-finished', { kind: windowKind, windowId: mainWindow.id })
  })

  windowRegistry.register(mainWindow, windowKind)
  windowCloseCoordinator.install(mainWindow)
  setupWindowSecurity(mainWindow, settingsProvider, _onDataSaved)
  setupDownloadsWithSettings(mainWindow, settingsProvider)
  mainWindow.webContents.on('did-finish-load', () => windowRegistry.markRendererReady(mainWindow))
  const publishWindowState = (): void => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('vast:cat-addon:window-state-changed', {
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized(),
      fullscreen: mainWindow.isFullScreen()
    })
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
  if (savedWindowState?.maximized && !openingPresentation) mainWindow.once('ready-to-show', () => mainWindow.maximize())

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
