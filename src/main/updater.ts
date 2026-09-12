import { app } from 'electron/main'
import { autoUpdater as platformUpdater, NsisUpdater, type AppUpdater } from 'electron-updater'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { envFlag } from '../shared/build-metadata'
import { updaterDisabledReason } from '../shared/updater-policy'
import type { UpdaterDiagnostics, UpdaterEvent } from '../shared/types'
import { getBuildMetadata } from './build-info'
import { createUpdaterStateMachine, redactUpdaterError } from './updater-state'
import { windowRegistry } from './windows/WindowRegistry'
import { pendingUpdatePath, stagePendingUpdate, updateCacheKey, type PendingUpdate } from './updater-pending'

const updaterState = createUpdaterStateMachine()
let updater: AppUpdater | undefined
let initialized = false
let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined
let checkPromise: Promise<void> | undefined
let failures = 0
let manualQuitHandlerAdded = false
let stagePromise: Promise<void> = Promise.resolve()
let pendingRecord: Omit<PendingUpdate, 'attempts'> | undefined
let diagnostics: UpdaterDiagnostics = {
  enabled: false,
  reason: 'Updater has not been initialized.',
  state: 'disabled',
  channel: getBuildMetadata().channel,
  autoDownload: false,
  autoInstallOnQuit: false
}

function emit(payload: UpdaterEvent): void {
  diagnostics = { ...diagnostics, lastEvent: payload }
  windowRegistry.broadcast('vast:updater', payload)
}

function scheduleCheck(delay: number): void {
  if (timer) clearTimeout(timer)
  if (stopped) return
  timer = setTimeout(() => { timer = undefined; void checkForUpdates() }, delay)
  timer.unref()
}

function failed(error: unknown): void {
  // An installer error must not leave the UI promising an update on next launch.
  const message = redactUpdaterError(error)
  if (updaterState.snapshot().state === 'error' && updaterState.snapshot().lastError === message) return
  updaterState.transition('error', { error: message })
  emit({ event: 'error', message })
  console.warn('[updater]', message)
}

// Use the public config-path API so each profile/install has its own native
// download cache, without replacing the library's transport or verification.
async function createWindowsUpdater(): Promise<NsisUpdater> {
  const installDirectory = dirname(app.getPath('exe'))
  const [realInstall, realProfile] = await Promise.all([realpath(installDirectory), realpath(app.getPath('userData'))])
  const profileRelative = relative(realInstall, realProfile)
  if (!profileRelative || (profileRelative !== '..' && !profileRelative.startsWith('..' + sep) && !isAbsolute(profileRelative))) {
    throw new Error('Automatic installation is unsafe because the profile is inside the application directory. Move the data directory outside it first.')
  }
  const key = updateCacheKey(app.getPath('exe'), app.getPath('userData'))
  const source = await readFile(join(process.resourcesPath, 'app-update.yml'), 'utf8')
  const cacheName = 'vast-update-' + key
  const config = /^updaterCacheDirName:.*$/m.test(source)
    ? source.replace(/^updaterCacheDirName:.*$/m, 'updaterCacheDirName: ' + cacheName)
    : source.trimEnd() + '\nupdaterCacheDirName: ' + cacheName + '\n'
  const root = join(app.getPath('userData'), 'UpdateCache')
  const configPath = join(root, 'app-update-' + key + '.yml')
  await mkdir(root, { recursive: true })
  if (await readFile(configPath, 'utf8').catch(() => '') !== config) {
    await writeFile(configPath + '.tmp', config, 'utf8')
    await rename(configPath + '.tmp', configPath)
  }
  const result = new NsisUpdater()
  result.updateConfigPath = configPath
  result.installDirectory = installDirectory
  return result
}

export async function setupAutoUpdater(): Promise<void> {
  if (initialized) return
  initialized = true
  const metadata = getBuildMetadata()
  let reason = updaterDisabledReason(app.isPackaged, metadata)
  if (!reason && process.platform === 'win32') {
    if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) {
      reason = 'Portable Vast must be updated with the portable release; an installed-browser update would change its installation and profile.'
    } else if (basename(app.getPath('exe')).toLowerCase() !== 'vast.exe') {
      reason = 'This executable was renamed. Use the standalone updater with an explicit installation path.'
    } else if (!existsSync(join(dirname(app.getPath('exe')), 'Uninstall Vast.exe'))) {
      reason = 'This is an unpacked Vast copy. Use the standalone updater with its explicit installation path.'
    }
  }
  const autoDownload = envFlag(process.env, 'VAST_UPDATE_AUTO_DOWNLOAD', true)
  const autoInstallOnQuit = envFlag(process.env, 'VAST_UPDATE_AUTO_INSTALL', true)
  diagnostics = {
    enabled: !reason, reason: reason ?? 'Updates download in the background and are prepared for the next launch.',
    state: reason ? 'disabled' : 'checking', channel: metadata.channel, autoDownload,
    autoInstallOnQuit: process.platform !== 'win32' && autoInstallOnQuit,
    autoInstallOnNextStart: process.platform === 'win32' && autoInstallOnQuit
  }
  if (reason) {
    updaterState.transition('disabled')
    emit({ event: 'disabled', message: reason })
    return
  }

  try {
    updater = process.platform === 'win32' ? await createWindowsUpdater() : platformUpdater
  } catch (error) {
    diagnostics.enabled = false
    diagnostics.reason = 'Could not prepare the update cache.'
    failed(error)
    return
  }
  updater.autoDownload = autoDownload
  updater.autoInstallOnAppQuit = diagnostics.autoInstallOnQuit
  updater.autoRunAppAfterInstall = false
  updater.disableWebInstaller = true
  updater.allowPrerelease = metadata.channel !== 'stable'
  updater.allowDowngrade = false
  updaterState.transition('checking')

  updater.on('checking-for-update', () => {
    updaterState.transition('checking')
    emit({ event: 'checking' })
  })
  updater.on('update-available', (info) => {
    updaterState.transition('available', { version: info.version })
    emit({ event: 'update-available', version: info.version, autoDownload, autoInstallOnQuit })
  })
  updater.on('update-not-available', (info) => {
    updaterState.transition('up-to-date', { version: info.version })
    emit({ event: 'up-to-date', version: info.version })
  })
  updater.on('download-progress', (progress) => {
    updaterState.transition('downloading')
    const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)))
    if (diagnostics.lastEvent?.event === 'downloading' && diagnostics.lastEvent.percent === percent) return
    emit({ event: 'downloading', percent })
  })
  updater.on('update-downloaded', (info) => {
    stagePromise = (async () => {
      if (process.platform === 'win32') {
        const file = info.files.find(file => new URL(file.url, 'https://update.invalid/').pathname.endsWith('.exe'))
        if (!file?.sha512 || !info.downloadedFile) throw new Error('The update has no verified installer metadata.')
        pendingRecord = { version: info.version, executable: app.getPath('exe'), installer: info.downloadedFile, sha512: file.sha512, automatic: autoInstallOnQuit }
        const attempts = await stagePendingUpdate(pendingRecord, app.getPath('userData'), join(process.resourcesPath, 'apply-update.ps1'))
        diagnostics.autoInstallOnNextStart = autoInstallOnQuit && attempts < 3
      }
      updaterState.transition('ready', { version: info.version })
      if (timer) clearTimeout(timer)
      timer = undefined
      emit({ event: 'ready', version: info.version, autoInstallOnQuit: diagnostics.autoInstallOnQuit, autoInstallOnNextStart: diagnostics.autoInstallOnNextStart })
    })()
    void stagePromise.catch(failed)
  })
  updater.on('error', failed)
  updater.on('update-cancelled', () => {
    if (!stopped) failed(new Error('Update download was interrupted. Vast will retry automatically.'))
  })
  if (process.platform === 'win32') {
    const previousError = await readFile(pendingUpdatePath(app.getPath('exe'), app.getPath('userData')) + '.error', 'utf8').catch(() => '')
    if (previousError.trim()) failed(new Error('The previous update did not finish: ' + previousError.trim()))
  }
  // Main loads this module after 2 seconds; check after another 8, outside startup.
  scheduleCheck(8_000)
  app.once('quit', () => { stopped = true; if (timer) clearTimeout(timer) })
}

export function checkForUpdates(): Promise<void> {
  if (checkPromise) return checkPromise
  if (!updater || stopped || updaterState.snapshot().state === 'ready') return Promise.resolve()
  diagnostics = { ...diagnostics, lastCheckedAt: Date.now() }
  checkPromise = Promise.resolve().then(async () => {
    try {
      const result = await updater!.checkForUpdates()
      // checkForUpdates resolves before its background transfer; always observe both.
      await result?.downloadPromise
      await stagePromise
      failures = 0
    } catch (error) {
      failed(error)
      failures += 1
    } finally {
      checkPromise = undefined
      if (updaterState.snapshot().state !== 'ready') {
        // Retry offline/partial downloads without busy looping. Ready files stay cached.
        scheduleCheck(failures ? Math.min(60_000 * 2 ** Math.min(failures - 1, 4), 15 * 60_000) : 4 * 60 * 60_000)
      }
    }
  })
  return checkPromise
}

export async function applyUpdateNow(): Promise<void> {
  if (!diagnostics.enabled || !updater) throw new Error(diagnostics.reason)
  await stagePromise
  updaterState.assertInstallAllowed()
  if (process.platform === 'win32' && pendingRecord) {
    pendingRecord.automatic = true
    await stagePendingUpdate(pendingRecord, app.getPath('userData'), join(process.resourcesPath, 'apply-update.ps1'), true)
    app.quit()
    return
  }
  // Do not launch an installer before WindowCloseCoordinator and main shutdown
  // have saved every window/session. The native updater installs on the quit event.
  // This also leaves cancel-close/retry-save in control of the user.
  updater.autoInstallOnAppQuit = true
  diagnostics = { ...diagnostics, autoInstallOnQuit: true }
  // If auto-install was opted out during download, its native quit hook is absent.
  // Register our own once-only hook in that case, after the normal shutdown barrier.
  if (!manualQuitHandlerAdded && !envFlag(process.env, 'VAST_UPDATE_AUTO_INSTALL', true)) {
    manualQuitHandlerAdded = true
    app.once('quit', () => updater?.quitAndInstall(true, false))
  }
  app.quit()
}

export function getUpdaterDiagnostics(): UpdaterDiagnostics {
  return { ...diagnostics, state: updaterState.snapshot().state, lastError: updaterState.snapshot().lastError }
}
