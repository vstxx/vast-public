import { shell } from 'electron/common'
import { BrowserWindow, app, dialog, session } from 'electron/main'
import type { DownloadItem as ElectronDownloadItem, Session } from 'electron/main'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '../shared/constants'
import { VAST_DEFAULT_WEBVIEW_PARTITION } from '../shared/oauth'
import type { BrowserSettings, DownloadItem } from '../shared/types'
import { alertScanResult, scanDownloadedFile } from './scanner'
import { performanceProbeEnabled, recordDownloadDurableWrite, recordDownloadProgressEvent } from './performance-probe'
import { loadData, upsertDownload } from './storage'
import { windowRegistry } from './windows/WindowRegistry'

const executableExtensions = new Set([
  '.app',
  '.appimage',
  '.bat',
  '.cmd',
  '.com',
  '.deb',
  '.dll',
  '.dmg',
  '.exe',
  '.jar',
  '.js',
  '.lnk',
  '.msi',
  '.pkg',
  '.ps1',
  '.reg',
  '.rpm',
  '.scr',
  '.sh',
  '.vbs',
  '.wsf'
])

function normalizeDownload(item: ElectronDownloadItem, id: string, state: DownloadItem['state'], sha256?: string): DownloadItem {
  const now = Date.now()
  return {
    id,
    filename: item.getFilename(),
    url: item.getURL(),
    mimeType: item.getMimeType(),
    savePath: item.getSavePath(),
    sha256,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    state,
    paused: item.isPaused(),
    dangerType:
      typeof (item as ElectronDownloadItem & { getDangerType?: () => string }).getDangerType === 'function'
        ? (item as ElectronDownloadItem & { getDangerType: () => string }).getDangerType()
        : undefined,
    scanStatus: state === 'progressing' ? 'pending' : undefined,
    startedAt: now,
    updatedAt: now
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

const runtimeDownloads = new Map<string, DownloadItem>()
const activeDownloadItems = new Map<string, ElectronDownloadItem>()
const downloadSpeedSamples = new Map<string, { at: number; bytes: number; bytesPerSecond: number }>()
const durableCheckpointTimers = new Map<string, NodeJS.Timeout>()
const durableCheckpointIntervalMs = 30_000

function addProgressMetrics(download: DownloadItem): DownloadItem {
  const now = Date.now()
  const previous = downloadSpeedSamples.get(download.id)
  let bytesPerSecond = previous?.bytesPerSecond ?? 0
  if (previous && now > previous.at && download.receivedBytes >= previous.bytes) {
    const instant = ((download.receivedBytes - previous.bytes) * 1000) / (now - previous.at)
    bytesPerSecond = previous.bytesPerSecond > 0 ? previous.bytesPerSecond * 0.72 + instant * 0.28 : instant
  }
  downloadSpeedSamples.set(download.id, { at: now, bytes: download.receivedBytes, bytesPerSecond })
  return { ...download, bytesPerSecond: download.paused ? 0 : Math.max(0, Math.round(bytesPerSecond)) }
}

async function persistDownloadCheckpoint(download: DownloadItem): Promise<void> {
  recordDownloadDurableWrite()
  await upsertDownload(download)
}

function cancelDurableCheckpoint(id: string): void {
  const timer = durableCheckpointTimers.get(id)
  if (timer) clearTimeout(timer)
  durableCheckpointTimers.delete(id)
}

function scheduleDurableCheckpoint(download: DownloadItem, persist: boolean): void {
  if (!persist || durableCheckpointTimers.has(download.id)) return
  const timer = setTimeout(() => {
    durableCheckpointTimers.delete(download.id)
    const latest = runtimeDownloads.get(download.id)
    if (!latest || latest.state !== 'progressing') return
    void persistDownloadCheckpoint(latest).catch((error) => {
      console.warn('[downloads] Failed to persist download checkpoint:', error)
    })
  }, durableCheckpointIntervalMs)
  durableCheckpointTimers.set(download.id, timer)
}

async function publishDownload(mainWindow: BrowserWindow, download: DownloadItem, persist: boolean): Promise<void> {
  runtimeDownloads.set(download.id, download)
  if (download.savePath) runtimeDownloads.set(resolve(download.savePath), download)
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vast:download-changed', download)
  }
  if (!persist) return
  try {
    await persistDownloadCheckpoint(download)
  } catch (error) {
    console.warn('[downloads] Failed to persist download state:', error)
  }
}

const configuredDownloadSessions = new Set<Session>()
let downloadWindow: BrowserWindow | undefined
let downloadSettings: (() => BrowserSettings) | undefined
let sessionListenerRegistered = false

function currentDownloadWindow(): BrowserWindow | undefined {
  if (downloadWindow && !downloadWindow.isDestroyed()) return downloadWindow
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
}

function ownerWindowForDownload(item: ElectronDownloadItem): BrowserWindow | undefined {
  const contents = (item as ElectronDownloadItem & { getWebContents?: () => Electron.WebContents }).getWebContents?.()
  return windowRegistry.vastWindowForWebContents(contents) ?? currentDownloadWindow()
}

function currentDownloadSettings(): BrowserSettings {
  return (downloadSettings ?? (() => DEFAULT_SETTINGS))()
}

function dangerType(item: ElectronDownloadItem): string | undefined {
  return typeof (item as ElectronDownloadItem & { getDangerType?: () => string }).getDangerType === 'function'
    ? (item as ElectronDownloadItem & { getDangerType: () => string }).getDangerType()
    : undefined
}

function downloadLooksDangerous(item: ElectronDownloadItem): boolean {
  const currentDangerType = dangerType(item)
  if (currentDangerType && currentDangerType !== 'notDangerous') return true
  const extension = extname(item.getFilename()).toLowerCase()
  if (executableExtensions.has(extension)) return true
  const mimeType = item.getMimeType().toLowerCase()
  return mimeType.includes('application/x-msdownload') || mimeType.includes('application/x-msdos-program')
}

function confirmDangerousDownload(mainWindow: BrowserWindow, item: ElectronDownloadItem): boolean {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    title: 'Potentially dangerous download',
    message: `Download ${item.getFilename()}?`,
    detail:
      'This file type can run code on your computer. Only continue if you trust the site and expected this download.',
    buttons: ['Cancel', 'Download anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result === 1
}

function configureDownloadsForSession(
  targetSession: Session
): void {
  if (configuredDownloadSessions.has(targetSession)) return
  configuredDownloadSessions.add(targetSession)

  targetSession.on('will-download', (event, item) => {
    const id = randomUUID()
    const startedAt = Date.now()
    const mainWindow = ownerWindowForDownload(item)
    const persistDownload = typeof targetSession.isPersistent !== 'function' || targetSession.isPersistent()
    if (currentDownloadSettings().security.warnDangerousDownloads && downloadLooksDangerous(item) && mainWindow) {
      const allowed = confirmDangerousDownload(mainWindow, item)
      if (!allowed) {
        event.preventDefault()
        void publishDownload(mainWindow, normalizeDownload(item, id, 'cancelled'), persistDownload)
        return
      }
    }

    if ((!app.isPackaged || performanceProbeEnabled()) && process.env.VAST_TEST_DOWNLOAD_DIR) {
      item.setSavePath(join(process.env.VAST_TEST_DOWNLOAD_DIR, item.getFilename()))
    }

    activeDownloadItems.set(id, item)

    item.on('updated', (_event, state) => {
      recordDownloadProgressEvent()
      const download = addProgressMetrics(normalizeDownload(
        item,
        id,
        state === 'interrupted' ? 'interrupted' : 'progressing'
      ))
      download.startedAt = startedAt
      const window = ownerWindowForDownload(item)
      if (window) {
        void publishDownload(window, download, false)
      } else if (persistDownload) {
        runtimeDownloads.set(download.id, download)
      }
      scheduleDurableCheckpoint(download, persistDownload)
    })

    item.once('done', (_event, state) => {
      void (async () => {
      cancelDurableCheckpoint(id)
      activeDownloadItems.delete(id)
      downloadSpeedSamples.delete(id)
      const completed = state === 'completed'
      const slowCompletionCheckpoint = completed && persistDownload
        ? setTimeout(() => {
            const checkpoint = normalizeDownload(item, id, 'completed')
            checkpoint.startedAt = startedAt
            checkpoint.scanStatus = 'scanning'
            void persistDownloadCheckpoint(checkpoint).catch((error) => {
              console.warn('[downloads] Failed to persist slow completion checkpoint:', error)
            })
          }, 5_000)
        : undefined
      const savePath = item.getSavePath()
      const sha256 = completed && savePath ? await sha256File(savePath).catch(() => undefined) : undefined
      const download = normalizeDownload(
        item,
        id,
        completed ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        sha256
      )
      download.startedAt = startedAt
      if (completed && download.savePath) download.scanStatus = 'scanning'
      const window = ownerWindowForDownload(item)
      if (window) {
        await publishDownload(window, download, !completed && persistDownload)
      } else if (persistDownload) {
        runtimeDownloads.set(download.id, download)
        if (!completed) await persistDownloadCheckpoint(download)
      }

      if (download.state === 'completed' && download.savePath) {
        let result: Awaited<ReturnType<typeof scanDownloadedFile>> | undefined
        try {
          result = await scanDownloadedFile(download.savePath, download.filename, download.mimeType ?? item.getMimeType() ?? '')
        } catch (error) {
          console.warn('[downloads] Security scan failed:', error)
        } finally {
          if (slowCompletionCheckpoint) clearTimeout(slowCompletionCheckpoint)
        }
        const scannedDownload: DownloadItem = result
          ? {
              ...download,
              scanStatus: result.status,
              scanFindings: [...result.threats, ...result.warnings],
              scannedSha256: sha256,
              scanCompletedAt: Date.now(),
              updatedAt: Date.now()
            }
          : {
              ...download,
              scanStatus: 'scan-failed',
              scanFindings: ['The security scan did not complete.'],
              scannedSha256: sha256,
              scanCompletedAt: Date.now(),
              updatedAt: Date.now()
            }
        const currentWindow = ownerWindowForDownload(item)
        if (currentWindow && !currentWindow.isDestroyed()) {
          await publishDownload(currentWindow, scannedDownload, persistDownload)
          if (result) await alertScanResult(currentWindow, download.filename, result)
        } else if (persistDownload) {
          await persistDownloadCheckpoint(scannedDownload)
        }
      }
      if (slowCompletionCheckpoint) clearTimeout(slowCompletionCheckpoint)
      })().catch((error) => {
        console.warn('[downloads] Failed to finalize download state:', error)
      })
    })
  })
}

export function setupDownloads(mainWindow: BrowserWindow): void {
  setupDownloadsWithSettings(mainWindow, () => DEFAULT_SETTINGS)
}

export function setupDownloadsWithSettings(
  mainWindow: BrowserWindow,
  getSettings: () => BrowserSettings
): void {
  downloadWindow = mainWindow
  downloadSettings = getSettings
  configureDownloadsForSession(session.defaultSession)
  if (sessionListenerRegistered) return
  sessionListenerRegistered = true
  app.on('session-created', (targetSession) => {
    configureDownloadsForSession(targetSession)
  })
}

async function trustedDownloadedItem(identifier: string): Promise<DownloadItem> {
  if (typeof identifier !== 'string' || !identifier) throw new Error('Invalid download identifier.')
  const target = resolve(identifier)
  const runtimeMatch = runtimeDownloads.get(identifier) ?? runtimeDownloads.get(target)
  if (runtimeMatch?.savePath && runtimeMatch.state === 'completed') return runtimeMatch
  const data = await loadData()
  const match = data.downloads.find((item) => item.state === 'completed' && (item.id === identifier || (item.savePath && resolve(item.savePath) === target)))
  if (!match?.savePath) throw new Error('Only completed files downloaded by Vast can be opened from here.')
  return match
}

async function trustedDownloadedPath(identifier: string): Promise<string> {
  const path = (await trustedDownloadedItem(identifier)).savePath!
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) throw new Error('The downloaded file no longer exists.')
  return path
}

function downloadedItemLooksExecutable(item: DownloadItem): boolean {
  if (item.dangerType && item.dangerType !== 'notDangerous') return true
  return executableExtensions.has(extname(item.filename).toLowerCase())
}

async function confirmOpenDownload(item: DownloadItem): Promise<boolean> {
  if (item.scanStatus === 'pending' || item.scanStatus === 'scanning' || !item.scanStatus) {
    throw new Error('This download cannot be opened until security scanning finishes.')
  }
  const currentHash = await sha256File(item.savePath!)
  if (!item.scannedSha256 || currentHash !== item.scannedSha256) {
    throw new Error('The downloaded file changed after it was scanned and cannot be opened safely.')
  }
  const needsWarning = downloadedItemLooksExecutable(item) || item.scanStatus !== 'clean'
  if (!needsWarning) return true
  const window = currentDownloadWindow()
  if (!window) return false
  const scanWarning = item.scanStatus === 'scan-unavailable' || item.scanStatus === 'scan-failed'
    ? 'The operating-system scanner was unavailable or failed. '
    : item.scanStatus === 'dangerous'
      ? 'The security scan marked this file as dangerous. '
      : item.scanStatus === 'suspicious'
        ? 'The security scan found suspicious characteristics. '
        : ''
  const result = await dialog.showMessageBox(window, {
    type: item.scanStatus === 'dangerous' ? 'error' : 'warning',
    title: item.scanStatus === 'dangerous' ? 'Dangerous download' : 'Open executable or suspicious download?',
    message: `Open ${item.filename}?`,
    detail: `${scanWarning}This file may run code on your computer. Only open it if you trust the source and expected this download.`,
    buttons: ['Cancel', 'Open anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

export async function showInFolder(path: string): Promise<void> {
  shell.showItemInFolder(await trustedDownloadedPath(path))
}

export async function openDownloadedFile(path: string): Promise<void> {
  const item = await trustedDownloadedItem(path)
  await trustedDownloadedPath(path)
  if (!await confirmOpenDownload(item)) throw new Error('Opening executable download was cancelled.')
  const error = await shell.openPath(item.savePath!)
  if (error) throw new Error(error)
}

function activeDownload(id: string): ElectronDownloadItem {
  if (typeof id !== 'string' || !id) throw new Error('Invalid download identifier.')
  const item = activeDownloadItems.get(id)
  if (!item) throw new Error('This download is no longer active.')
  return item
}

export function pauseDownload(id: string): void {
  const item = activeDownload(id)
  if (!item.isPaused()) item.pause()
}

export function resumeDownload(id: string): void {
  const item = activeDownload(id)
  if (item.isPaused()) item.resume()
}

export function cancelDownload(id: string): void {
  activeDownload(id).cancel()
}

export async function retryDownload(id: string): Promise<void> {
  if (typeof id !== 'string' || !id) throw new Error('Invalid download identifier.')
  const runtime = runtimeDownloads.get(id)
  const stored = runtime ?? (await loadData()).downloads.find((item) => item.id === id)
  if (!stored || stored.state === 'progressing') throw new Error('Only interrupted or cancelled downloads can be retried.')
  let url: URL
  try {
    url = new URL(stored.url)
  } catch {
    throw new Error('The original download URL is invalid.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) downloads can be retried.')
  session.fromPartition(VAST_DEFAULT_WEBVIEW_PARTITION).downloadURL(url.toString())
}
