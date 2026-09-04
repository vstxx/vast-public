import { app, BrowserWindow } from 'electron/main'
import { autoUpdater } from 'electron-updater'
import { envFlag } from '../shared/build-metadata'
import { updaterDisabledReason } from '../shared/updater-policy'
import type { UpdaterDiagnostics, UpdaterEvent } from '../shared/types'
import { getBuildMetadata } from './build-info'
import { showRendererNotification } from './ui-bridge'
import { createUpdaterStateMachine, redactUpdaterError } from './updater-state'
import { checkpointBrowserSessionData } from './sessions'
import { beginUpdateRestart, cancelUpdateRestart } from './update-lifecycle'

let updaterWindow: BrowserWindow | undefined
let updateInstallPromise: Promise<void> | undefined
const updaterState = createUpdaterStateMachine()
let diagnostics: UpdaterDiagnostics = {
  enabled: false,
  reason: 'Updater has not been initialized.',
  state: 'disabled',
  channel: getBuildMetadata().channel,
  autoDownload: false,
  autoInstallOnQuit: false
}

function getWindow(): BrowserWindow | undefined {
  if (updaterWindow && !updaterWindow.isDestroyed()) return updaterWindow
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
}

function notify(notification: Parameters<typeof showRendererNotification>[1]): void {
  showRendererNotification(getWindow(), notification)
}

function emit(mainWindow: BrowserWindow, payload: UpdaterEvent): void {
  diagnostics = { ...diagnostics, state: updaterState.snapshot().state, lastError: updaterState.snapshot().lastError, lastEvent: payload }
  mainWindow.webContents.send('vast:updater', payload)
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  updaterWindow = mainWindow
  const metadata = getBuildMetadata()
  const reason = updaterDisabledReason(app.isPackaged, metadata)
  const autoDownload = envFlag(process.env, 'VAST_UPDATE_AUTO_DOWNLOAD', false)
  const autoInstallOnQuit = envFlag(process.env, 'VAST_UPDATE_AUTO_INSTALL', false)

  diagnostics = {
    enabled: !reason,
    reason: reason ?? 'Updater is enabled.',
    state: reason ? 'disabled' : 'checking',
    channel: metadata.channel,
    autoDownload,
    autoInstallOnQuit
  }

  if (reason) {
    updaterState.transition('disabled')
    emit(mainWindow, { event: 'disabled', message: reason })
    return
  }

  updaterState.transition('checking')

  autoUpdater.autoDownload = autoDownload
  autoUpdater.autoInstallOnAppQuit = autoInstallOnQuit
  autoUpdater.disableWebInstaller = false

  autoUpdater.on('update-available', (info) => {
    updaterState.transition('available', { version: info.version })
    notify({
      id: 'vast-update-available',
      tone: 'info',
      title: `Update available - v${info.version}`,
      message: autoDownload ? 'Vast is downloading the new version.' : 'Open updater controls to download and install it.',
      durationMs: 8_000
    })
    emit(mainWindow, { event: 'update-available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    updaterState.transition('checking', { version: info.version })
    emit(mainWindow, { event: 'up-to-date', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    updaterState.transition('downloading')
    emit(mainWindow, { event: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    updaterState.transition('ready', { version: info.version })
    notify({
      id: 'vast-update-ready',
      tone: 'success',
      title: `Vast v${info.version} ready to install`,
      message: 'Restart Vast to apply the update. Your data is preserved.',
      durationMs: 0
    })
    emit(mainWindow, { event: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const message = redactUpdaterError(err)
    updaterState.transition('error', { error: message })
    diagnostics = { ...diagnostics, state: updaterState.snapshot().state, lastError: updaterState.snapshot().lastError }
    console.warn('[updater] Auto-update error:', message)
    emit(mainWindow, { event: 'error', message })
  })

  const checkDelay = setTimeout(() => {
    diagnostics = { ...diagnostics, lastCheckedAt: Date.now() }
    autoUpdater.checkForUpdates().catch((err) => {
      const message = redactUpdaterError(err)
      updaterState.transition('error', { error: message })
      diagnostics = { ...diagnostics, state: updaterState.snapshot().state, lastError: updaterState.snapshot().lastError }
      console.warn('[updater] Update check failed:', message)
    })
  }, 8_000)

  mainWindow.once('closed', () => clearTimeout(checkDelay))
}

async function prepareAndApplyUpdate(): Promise<void> {
  if (!diagnostics.enabled) throw new Error(diagnostics.reason)
  updaterState.assertInstallAllowed()
  await import('./avidae').then(({ stopAvidae }) => stopAvidae())
  await checkpointBrowserSessionData()
  beginUpdateRestart()
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    cancelUpdateRestart()
    throw error
  }
}

export function applyUpdateNow(): Promise<void> {
  if (updateInstallPromise) return updateInstallPromise
  updateInstallPromise = prepareAndApplyUpdate().catch((error) => {
    updateInstallPromise = undefined
    throw error
  })
  return updateInstallPromise
}

export function getUpdaterDiagnostics(): UpdaterDiagnostics {
  return { ...diagnostics, state: updaterState.snapshot().state, lastError: updaterState.snapshot().lastError }
}
