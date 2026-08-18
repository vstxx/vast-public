import { app, BrowserWindow, dialog, ipcMain, screen, webContents, type IpcMainInvokeEvent } from 'electron/main'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrowserSettings,
  DetachedTabPayload,
  PersistedData,
  Tab
} from '../shared/types'
import { getDefaultBrowserStatus, openDefaultBrowserSettings } from './default-browser'
import {
  getGoogleAuthDiagnostics,
  isSafeWebUrl,
  openExternalUrl,
  privacyDocumentScriptForWebContents,
  requestOAuthExternalFallback
} from './sessions'
import { updatePrivacyFilters } from './privacy-filter-lists'
import {
  assertStorageTextSize,
  createStorageBackup,
  getStorageRecoveryState,
  isPersistedData,
  listStorageBackups,
  loadData,
  replaceDataFromImport,
  restoreStorageBackup,
  saveData,
  storagePath
} from './storage'
import { resolveRendererPrompt, showRendererNotification } from './ui-bridge'
import { redactedBuildDiagnostics } from './build-info'
import type { VastRelayService } from './relay/service'
import { isSafeDownloadUrl, isTrustedRendererUrl as rendererUrlIsTrusted } from './ipc-security'
import {
  chooseAndMigrateDataDirectory,
  exportFullVastData,
  getDataPathInfo,
  importFullVastData,
  openCurrentDataFolder,
  vastDataPath
} from './data-path'
import { windowRegistry } from './windows/WindowRegistry'
import { windowCloseCoordinator } from './windows/WindowCloseCoordinator'
import { recentDiagnosticsEvents } from './diagnostics-events'
import { resolveExternalProtocolOpen } from './external-protocol'
import type { CatAddonService } from './cat-addon-service'
import {
  assertIpcFeatureAllowed,
  assertSensitiveIpcRegistrationComplete,
  requiredFeatureForIpcChannel,
  vaultAccessForIpcChannel
} from './ipc-feature-policy'
import {
  assertPasswordVaultIpcAccess,
  lockPasswordVaultSession,
  passwordVaultSessionStatus,
  unlockPasswordVaultSession
} from './password-vault-session'
import { registerAvidaeIpc } from './ipc/avidae'
import { registerDownloadsIpc } from './ipc/downloads'
import { registerNetworkIpc } from './ipc/network'
import { registerNoticesIpc } from './ipc/notices'
import { registerPasswordIpc } from './ipc/passwords'
import { registerPdfIpc } from './ipc/pdf'
import { registerPrivacyIpc } from './ipc/privacy'
import { fail, ok } from './ipc/registration'

function isTrustedRendererUrl(rawUrl: string): boolean {
  return rendererUrlIsTrusted(rawUrl, {
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    packagedRendererPath: join(__dirname, '../renderer/index.html')
  })
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderWindow = windowRegistry.vastWindowForWebContents(event.sender)
  if (!senderWindow || senderWindow.isDestroyed()) {
    throw new Error('Rejected IPC call from untrusted webContents.')
  }
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Rejected IPC call from a non-main renderer frame.')
  }
  if (!isTrustedRendererUrl(event.senderFrame.url)) {
    throw new Error('Rejected IPC call from untrusted renderer URL.')
  }
}

function senderWindowFor(event: IpcMainInvokeEvent): BrowserWindow {
  const senderWindow = windowRegistry.vastWindowForWebContents(event.sender)
  if (!senderWindow || senderWindow.isDestroyed()) throw new Error('The requesting Vast window is unavailable.')
  return senderWindow
}

function resolveTrustedGuestWebContents(hostContents: Electron.WebContents, guestId: number): Electron.WebContents {
  if (!Number.isInteger(guestId) || guestId <= 0) throw new Error('Invalid webContents id.')
  const target = webContents.fromId(guestId)
  if (!target || target.isDestroyed()) throw new Error('Target webContents is unavailable.')
  if (target.hostWebContents?.id !== hostContents.id) {
    throw new Error('Rejected guest webContents outside this window.')
  }
  return target
}

function limitedOptionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Invalid detached tab payload.')
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function isSafeDetachedTabUrl(url: string): boolean {
  return isSafeWebUrl(url) || url.startsWith('vast://')
}

function detachedTabPayload(input: unknown): DetachedTabPayload {
  if (!input || typeof input !== 'object') throw new Error('Invalid detached tab payload.')
  const payload = input as Partial<DetachedTabPayload>
  const url = limitedOptionalString(payload.url, 4096)
  if (!url || !isSafeDetachedTabUrl(url)) throw new Error('Invalid detached tab URL.')
  const zoom = typeof payload.zoom === 'number' && Number.isFinite(payload.zoom)
    ? Math.min(5, Math.max(0.25, payload.zoom))
    : undefined

  return {
    url,
    title: limitedOptionalString(payload.title, 512),
    favicon: limitedOptionalString(payload.favicon, 4096),
    muted: typeof payload.muted === 'boolean' ? payload.muted : undefined,
    zoom,
    sourceTabId: limitedOptionalString(payload.sourceTabId, 128),
    sourceWorkspaceId: limitedOptionalString(payload.sourceWorkspaceId, 128),
    sourceGroupId: limitedOptionalString(payload.sourceGroupId, 128)
  }
}

export interface IpcServices {
  onDataSaved?: (data: PersistedData) => void
  onDetachTab?: (tab: DetachedTabPayload) => void | Promise<void>
  catAddonService?: CatAddonService
  relayService?: VastRelayService
}

let ipcRegistered = false

export function setupIpc(services: IpcServices = {}): void {
  if (ipcRegistered) throw new Error('Vast IPC handlers must be registered exactly once.')
  ipcRegistered = true
  const { onDataSaved, onDetachTab, catAddonService, relayService } = services
  ipcMain.on('vast:privacy:document-script', (event, requestedUrl: unknown) => {
    const host = event.sender.hostWebContents
    const trustedHost = host && windowRegistry.vastWindowForWebContents(host)
    if (!trustedHost || trustedHost.isDestroyed() || typeof requestedUrl !== 'string' || requestedUrl.length > 32_768) {
      event.returnValue = ''
      return
    }
    event.returnValue = privacyDocumentScriptForWebContents(event.sender, requestedUrl)
  })
  const registeredChannels = new Set<string>()
  const handle = <TArgs extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown
  ): void => {
    const requiredFeature = requiredFeatureForIpcChannel(channel)
    const vaultAccess = vaultAccessForIpcChannel(channel)
    registeredChannels.add(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcSender(event)
      try {
        if (requiredFeature) {
          const data = await loadData()
          assertIpcFeatureAllowed(channel, data.settings)
        }
        assertPasswordVaultIpcAccess(vaultAccess)
      } catch (error) {
        return fail(error)
      }
      return listener(event, ...(args as TArgs))
    })
  }

  const persistRendererData = async (data: PersistedData): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      if (!isPersistedData(data)) throw new Error('Invalid storage payload.')
      await saveData(data)
      onDataSaved?.(data)
      void updatePrivacyFilters(false)
      return ok()
    } catch (error) {
      return fail(error)
    }
  }

  handle('vast:storage:load', async () => loadData())

  handle('vast:cat-addon:status', async () => {
    if (!catAddonService) throw new Error('Cat Addon service is unavailable.')
    return catAddonService.getState()
  })

  handle('vast:cat-addon:runtime', async () => {
    if (!catAddonService) throw new Error('Cat Addon service is unavailable.')
    return catAddonService.runtime()
  })

  handle('vast:cat-addon:window-state', async (event) => {
    const window = senderWindowFor(event)
    return { visible: window.isVisible(), minimized: window.isMinimized(), fullscreen: window.isFullScreen() }
  })

  handle('vast:cat-addon:enable', async (event) => {
    if (!catAddonService) throw new Error('Cat Addon service is unavailable.')
    const state = await catAddonService.enable()
    showRendererNotification(senderWindowFor(event), state.enabled
      ? { tone: 'success', title: 'Cat Addon enabled', message: 'A hand-animated pixel cat now lives in Vast.' }
      : { tone: 'error', title: 'Cat Addon could not be enabled', message: state.error ?? 'The bundled addon failed validation.' })
    return state
  })

  handle('vast:cat-addon:disable', async (event) => {
    if (!catAddonService) throw new Error('Cat Addon service is unavailable.')
    const state = await catAddonService.disable()
    showRendererNotification(senderWindowFor(event), state.error
      ? { tone: 'warning', title: 'Cat Addon disabled', message: state.error }
      : { tone: 'info', title: 'Cat Addon disabled', message: 'Cat animations and extracted assets were removed.' })
    return state
  })

  handle('vast:storage:save', async (_event, data: PersistedData) => persistRendererData(data))

  handle('vast:storage:flush', async (_event, data: PersistedData) => persistRendererData(data))

  handle('vast:window:close-ready', async (event, requestId: string, result: { ok?: unknown; error?: unknown }) => {
    if (typeof requestId !== 'string' || !requestId || !result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error('Invalid close persistence response.')
    }
    const accepted = windowCloseCoordinator.resolve(event.sender, requestId, {
      ok: result.ok,
      error: typeof result.error === 'string' ? result.error.slice(0, 1_000) : undefined
    })
    if (!accepted) throw new Error('Close persistence response does not belong to this window.')
    return ok()
  })

  handle('vast:window:state', async (event) => {
    const window = senderWindowFor(event)
    return { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
  })

  handle('vast:window:minimize', async (event) => {
    try {
      senderWindowFor(event).minimize()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:window:toggle-maximize', async (event) => {
    try {
      const window = senderWindowFor(event)
      if (window.isFullScreen()) window.setFullScreen(false)
      else if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:window:close', async (event) => {
    try {
      const window = senderWindowFor(event)
      setImmediate(() => {
        if (!window.isDestroyed()) window.close()
      })
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:list-backups', async () => {
    try {
      return { ok: true, backups: await listStorageBackups(), recovery: getStorageRecoveryState() }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:create-backup', async () => {
    try {
      return { ok: true, backup: await createStorageBackup('manual') }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:data-path:info', async () => getDataPathInfo())

  handle('vast:data-path:open', async () => {
    try {
      await openCurrentDataFolder()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:data-path:change', async (event) => {
    try {
      return await chooseAndMigrateDataDirectory(senderWindowFor(event))
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:restore-backup', async (_event, id: string) => {
    try {
      if (typeof id !== 'string' || !id) throw new Error('Invalid backup id.')
      const data = await restoreStorageBackup(id)
      onDataSaved?.(data)
      windowRegistry.broadcast('vast:settings-saved')
      return { ok: true, data }
    } catch (error) {
      return fail(error)
    }
  })

  registerAvidaeIpc(handle)
  registerDownloadsIpc(handle)
  registerNetworkIpc(handle, senderWindowFor)
  registerNoticesIpc(handle)
  handle('vast:relay:state', (event) => {
    const snapshot = relayService?.snapshot() ?? {
      enabled: false as const,
      environment: 'staging' as const,
      current: null,
      pendingCount: 0
    }
    const target = windowRegistry.focusedVastWindow()
    return target && senderWindowFor(event) === target ? snapshot : { ...snapshot, current: null, pendingCount: 0 }
  })
  handle('vast:relay:dismiss', async (_event, presentationId: unknown) => {
    if (!relayService || typeof presentationId !== 'string' || presentationId.length > 128) return fail('Invalid Relay presentation.')
    return relayService.dismiss(presentationId)
  })
  handle('vast:relay:action', async (_event, presentationId: unknown) => {
    if (!relayService || typeof presentationId !== 'string' || presentationId.length > 128) return fail('Invalid Relay presentation.')
    return relayService.performAction(presentationId)
  })
  registerPasswordIpc(handle, senderWindowFor, {
    status: passwordVaultSessionStatus,
    lock: () => lockPasswordVaultSession('manual'),
    unlock: unlockPasswordVaultSession
  })
  registerPdfIpc(handle, senderWindowFor, resolveTrustedGuestWebContents, showRendererNotification)
  registerPrivacyIpc(handle)

  handle('vast:updater:install', async () => {
    try {
      const { applyUpdateNow } = await import('./updater')
      await applyUpdateNow()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:updater:status', async () => (await import('./updater')).getUpdaterDiagnostics())

  handle('vast:app:default-browser-status', async () => getDefaultBrowserStatus())

  handle('vast:app:open-default-browser-settings', async () => {
    try {
      return { ok: true, status: await openDefaultBrowserSettings() }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:notes:export-markdown', async (event, title: string, body: string) => {
    try {
      if (typeof title !== 'string' || typeof body !== 'string' || title.length > 8_192 || body.length > 256 * 1024) throw new Error('Invalid note export payload.')
      const safeName = (title.trim() || 'Vast note').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120)
      const result = await dialog.showSaveDialog(senderWindowFor(event), {
        title: 'Export Markdown note',
        defaultPath: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }]
      })
      if (result.canceled || !result.filePath) return { ok: true }
      await writeFile(result.filePath, body, 'utf8')
      return { ok: true, path: result.filePath }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:detach-tab', async (_event, input: unknown) => {
    try {
      if (!onDetachTab) throw new Error('Detached windows are unavailable.')
      await onDetachTab(detachedTabPayload(input))
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:reattach-detached-tab', async (event, input: unknown) => {
    try {
      const sourceWindow = senderWindowFor(event)
      if (windowRegistry.kindOf(sourceWindow) !== 'detached') throw new Error('Only a detached tab window can be reattached.')
      const payload = detachedTabPayload(input)
      const targetWindow = windowRegistry.reattachTargetAt(screen.getCursorScreenPoint(), sourceWindow)
      if (!targetWindow || !windowRegistry.isRendererReady(targetWindow)) return { ok: true, attached: false }

      targetWindow.webContents.send('vast:browser:reattach-detached-tab', payload)
      setImmediate(() => {
        if (!sourceWindow.isDestroyed()) sourceWindow.destroy()
      })
      return { ok: true, attached: true }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:sync-detached-tab', async (_event, input: unknown) => {
    try {
      const payload = detachedTabPayload(input)
      if (!payload.sourceTabId || !payload.sourceWorkspaceId) {
        throw new Error('Detached tab is missing source identifiers.')
      }

      const data = await loadData()
      const workspace = data.workspaces.find((item) => item.id === payload.sourceWorkspaceId)
      if (!workspace || workspace.isPrivate) {
        // Detached tabs from deleted or private workspaces are intentionally not persisted.
        return ok()
      }

      const now = Date.now()
      const existing = data.tabs.find((tab) => tab.id === payload.sourceTabId)
      const groupId = payload.sourceGroupId &&
        data.tabGroups.some((group) => group.id === payload.sourceGroupId && group.workspaceId === workspace.id)
        ? payload.sourceGroupId
        : undefined
      const tab: Tab = {
        id: payload.sourceTabId,
        workspaceId: workspace.id,
        groupId,
        title: payload.title || existing?.title || payload.url,
        url: payload.url,
        displayUrl: payload.url,
        favicon: payload.favicon,
        pinned: existing?.pinned ?? false,
        muted: payload.muted,
        status: 'idle',
        lifecycle: 'active',
        progress: 0,
        canGoBack: false,
        canGoForward: false,
        zoom: payload.zoom ?? existing?.zoom ?? 1,
        lastAccessedAt: now,
        createdAt: existing?.createdAt ?? now
      }
      const next: PersistedData = {
        ...data,
        workspaces: data.workspaces.map((item) =>
          item.id === workspace.id ? { ...item, activeTabId: tab.id, updatedAt: now } : item
        ),
        tabs: [...data.tabs.filter((item) => item.id !== tab.id), tab],
        recentlyClosedTabs: data.recentlyClosedTabs.filter((item) => item.id !== tab.id)
      }
      await saveData(next)
      onDataSaved?.(next)
      windowRegistry.broadcast('vast:settings-saved')
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:copy-image-at', async (event, webContentsId: number, x: number, y: number) => {
    try {
      const target = resolveTrustedGuestWebContents(event.sender, webContentsId)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid image coordinates.')
      target.copyImageAt(Math.round(x), Math.round(y))
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:download-url', async (event, webContentsId: number, url: string) => {
    try {
      const target = resolveTrustedGuestWebContents(event.sender, webContentsId)
      if (typeof url !== 'string' || !url.trim()) throw new Error('Invalid download URL.')
      const trimmedUrl = url.trim()
      if (!isSafeDownloadUrl(trimmedUrl)) throw new Error('Only HTTP(S) downloads can be started from this IPC handler.')
      target.downloadURL(trimmedUrl)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:ui:resolve-prompt', async (event, promptId: string, actionId: string) => {
    try {
      if (typeof promptId !== 'string' || !promptId) throw new Error('Invalid prompt id.')
      if (typeof actionId !== 'string' || !actionId) throw new Error('Invalid prompt action.')
      if (!resolveRendererPrompt(event.sender, promptId, actionId)) throw new Error('Prompt is no longer active for this window.')
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:resolve-external-protocol', async (event, requestId: string, allow: boolean) => {
    try {
      if (typeof requestId !== 'string' || !requestId) throw new Error('Invalid external app request id.')
      if (typeof allow !== 'boolean') throw new Error('Invalid external app decision.')
      await resolveExternalProtocolOpen(event.sender, requestId, allow)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:browser:set-keep-awake', async (event, webContentsId: number, keepAwake: boolean) => {
    try {
      if (typeof keepAwake !== 'boolean') throw new Error('Invalid keep-awake state.')
      const target = resolveTrustedGuestWebContents(event.sender, webContentsId)
      target.setBackgroundThrottling(!keepAwake)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:shell:open-external', async (event, url: string) => {
    try {
      if (typeof url !== 'string') throw new Error('Invalid URL.')
      const data = await loadData()
      await openExternalUrl(url, senderWindowFor(event), data.settings)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:oauth:fallback', async (event, input: unknown) => {
    try {
      await requestOAuthExternalFallback(input, senderWindowFor(event))
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:export', async (event) => {
    try {
      const data = await loadData()
      const result = await dialog.showSaveDialog(senderWindowFor(event), {
        title: 'Export Vast data',
        defaultPath: 'vast-export.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, error: 'Export cancelled.' }
      await writeFile(result.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      return { ok: true, path: result.filePath }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:import', async (event) => {
    try {
      const result = await dialog.showOpenDialog(senderWindowFor(event), {
        title: 'Import Vast data',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Import cancelled.' }
      const raw = await readFile(result.filePaths[0], 'utf8')
      assertStorageTextSize(raw)
      const parsed = JSON.parse(raw) as unknown
      if (!isPersistedData(parsed)) throw new Error('Selected file is not a valid Vast export.')
      const data = await replaceDataFromImport(parsed)
      onDataSaved?.(data)
      windowRegistry.broadcast('vast:settings-saved')
      return { ok: true, data }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:export-full', async (event) => {
    try {
      return await exportFullVastData(senderWindowFor(event))
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:storage:import-full', async (event) => {
    try {
      return await importFullVastData(senderWindowFor(event))
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:app:diagnostics', async () => {
    const includePaths = !app.isPackaged || process.env.VAST_DIAGNOSTICS_INCLUDE_PATHS === '1'
    const [backups, data, recentEvents] = await Promise.all([
      listStorageBackups().catch(() => []),
      loadData().catch(() => null),
      recentDiagnosticsEvents().catch(() => [])
    ])
    const updater = (await import('./updater')).getUpdaterDiagnostics()
    const dataPath = await getDataPathInfo()
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      userDataPath: includePaths ? vastDataPath() : '[redacted]',
      storagePath: includePaths ? storagePath() : '[redacted]',
      dataPath: includePaths
        ? dataPath
        : {
            ...dataPath,
            currentDataPath: '[redacted]',
            defaultDataPath: '[redacted]',
            stableConfigPath: '[redacted]',
            configuredCustomDataPath: dataPath.configuredCustomDataPath ? '[redacted]' : undefined,
            appInstallPath: '[redacted]'
          },
      backupCount: backups.length,
      recovery: getStorageRecoveryState(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      googleAuth: getGoogleAuthDiagnostics(),
      ...redactedBuildDiagnostics(),
      updaterEnabled: updater.enabled,
      updaterReason: updater.reason,
      labsEnabled: data?.settings.labs?.enabled ?? false,
      recentEvents
    }
  })

  handle('vast:app:process-metrics', async () => {
    const processes = app.getAppMetrics().map((metric) => ({
      type: metric.type,
      workingSetMb: Math.max(0, metric.memory.workingSetSize / 1024)
    }))
    return {
      totalWorkingSetMb: processes.reduce((sum, process) => sum + process.workingSetMb, 0),
      processes
    }
  })

  assertSensitiveIpcRegistrationComplete(registeredChannels)
}
