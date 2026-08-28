import { dialog } from 'electron/main'
import type { ExtensionManager } from '../extensions/extension-manager'
import { requestRendererPrompt, showRendererNotification } from '../ui-bridge'
import { VAST_NATIVE_PERMISSIONS, VAST_PERMISSION_METADATA, type VastNativePermission, type VastUiBrokerResponse } from '../../shared/extension-native-api'
import { fail, type IpcHandle, type SenderWindowFor } from './registration'

const EXTENSION_ID = /^[a-p]{32}$/

export function registerExtensionsIpc(
  handle: IpcHandle,
  senderWindowFor: SenderWindowFor,
  extensionManager: ExtensionManager
): void {
  handle('vast:extensions:list', async () => {
    try {
      return {
        ok: true,
        extensions: await extensionManager.list(),
        privateWorkspacesDisabled: true as const
      }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:extensions:load-unpacked', async (event) => {
    const owner = senderWindowFor(event)
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: 'Load unpacked extension',
        buttonLabel: 'Load extension',
        properties: ['openDirectory', 'dontAddToRecent']
      })
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }
      let extension = await extensionManager.installUnpacked(selection.filePaths[0])
      if (extension.native.requestedPermissions.length > 0 && extension.native.state === 'pending-permission') {
        const action = await requestRendererPrompt(owner, {
          tone: 'question',
          title: `Install ${extension.name}?`,
          message: 'Review the access this extension requests from Vast.',
          detail: extension.native.requestedPermissions.map((permission) => `• ${VAST_PERMISSION_METADATA[permission].title}`).join('\n'),
          actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'install', label: 'Install', tone: 'primary' }]
        })
        if (action !== 'install') {
          await extensionManager.remove(extension.id)
          return { ok: true, canceled: true }
        }
        extension = await extensionManager.approvePermissions(extension.id, extension.native.requestedPermissions)
      }
      if (extension.runtimeState === 'loaded' && extension.native.state !== 'error') {
        showRendererNotification(owner, {
          tone: 'success',
          title: 'Extension installed',
          message: `${extension.name} is now active.`
        })
      } else {
        showRendererNotification(owner, {
          tone: 'error',
          title: 'Could not load extension',
          message: extension.error ?? `${extension.name} could not start in a persistent workspace.`
        })
      }
      return { ok: true, extension }
    } catch (error) {
      const result = fail(error)
      showRendererNotification(owner, {
        tone: 'error',
        title: 'Could not load extension',
        message: result.error
      })
      return result
    }
  })

  handle('vast:extensions:install-package', async (event) => {
    const owner = senderWindowFor(event)
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: 'Install Vast Extension Package',
        buttonLabel: 'Review package',
        filters: [{ name: 'Vast Extension Package', extensions: ['vext'] }],
        properties: ['openFile', 'dontAddToRecent']
      })
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }
      return { ok: true, preview: await extensionManager.prepareLocalPackage(selection.filePaths[0]) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:prepare-hub-install', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension ID.')
      return { ok: true, preview: await extensionManager.prepareHubInstall(id) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:confirm-install', async (event, token: unknown) => {
    const owner = senderWindowFor(event)
    try {
      if (typeof token !== 'string' || token.length > 128) throw new Error('Invalid extension installation confirmation.')
      const extension = await extensionManager.installPrepared(token)
      showRendererNotification(owner, { tone: 'success', title: 'Extension installed', message: `${extension.name} is now ${extension.enabled ? 'available' : 'installed and disabled'}.` })
      return { ok: true, extension }
    } catch (error) {
      const result = fail(error)
      showRendererNotification(owner, { tone: 'error', title: 'Could not install extension', message: result.error })
      return result
    }
  })

  handle('vast:extensions:cancel-install', async (_event, token: unknown) => {
    try {
      if (typeof token !== 'string' || token.length > 128) throw new Error('Invalid extension installation confirmation.')
      await extensionManager.cancelPrepared(token)
      return { ok: true }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:catalog', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid catalog request.')
      const request = input as Record<string, unknown>
      if ((request.query !== undefined && (typeof request.query !== 'string' || request.query.length > 128)) || (request.category !== undefined && (typeof request.category !== 'string' || request.category.length > 64)) || (request.page !== undefined && (!Number.isSafeInteger(request.page) || Number(request.page) < 1 || Number(request.page) > 1_000)) || (request.sort !== undefined && request.sort !== 'popular' && request.sort !== 'updated')) throw new Error('Invalid catalog request.')
      return { ok: true, catalog: await extensionManager.catalog({ ...(typeof request.query === 'string' ? { query: request.query } : {}), ...(typeof request.category === 'string' ? { category: request.category } : {}), ...(typeof request.page === 'number' ? { page: request.page } : {}), ...(request.sort === 'popular' || request.sort === 'updated' ? { sort: request.sort } : {}) }) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:catalog-details', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension ID.')
      return { ok: true, extension: await extensionManager.catalogDetails(id) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:check-updates', async (_event, id: unknown) => {
    try {
      if (id !== undefined && (typeof id !== 'string' || !EXTENSION_ID.test(id))) throw new Error('Invalid extension ID.')
      return { ok: true, extensions: await extensionManager.checkForUpdates(id as string | undefined) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:approve-update', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension ID.')
      return { ok: true, extension: await extensionManager.approveUpdate(id) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:enable', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string') throw new Error('Invalid extension ID.')
      return { ok: true, extension: await extensionManager.enable(id) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:extensions:disable', async (event, id: unknown) => {
    try {
      if (typeof id !== 'string') throw new Error('Invalid extension ID.')
      const extension = await extensionManager.disable(id)
      showRendererNotification(senderWindowFor(event), {
        tone: 'info',
        title: 'Disabled',
        message: `${extension.name} is disabled.`
      })
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:extensions:reload', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string') throw new Error('Invalid extension ID.')
      return { ok: true, extension: await extensionManager.reload(id) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:extensions:remove', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string') throw new Error('Invalid extension ID.')
      await extensionManager.remove(id)
      return { ok: true, removedId: id }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:extensions:approve-permissions', async (_event, id: unknown, permissions: unknown) => {
    try {
      if (typeof id !== 'string' || !Array.isArray(permissions) || !permissions.every((permission): permission is VastNativePermission => typeof permission === 'string' && (VAST_NATIVE_PERMISSIONS as readonly string[]).includes(permission))) throw new Error('Invalid extension permissions.')
      return { ok: true, extension: await extensionManager.approvePermissions(id, permissions) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:set-permission', async (_event, id: unknown, permission: unknown, granted: unknown) => {
    try {
      if (typeof id !== 'string' || typeof permission !== 'string' || !(VAST_NATIVE_PERMISSIONS as readonly string[]).includes(permission) || typeof granted !== 'boolean') throw new Error('Invalid extension permission update.')
      return { ok: true, extension: await extensionManager.setPermission(id, permission as VastNativePermission, granted) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:contributions', () => ({ ok: true, contributions: extensionManager.contributionSnapshot() }))
  handle('vast:extensions:prepare-surface', async (_event, id: unknown, kind: unknown, partition: unknown) => {
    try {
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension ID.')
      if (kind !== 'popup' && kind !== 'options') throw new Error('Invalid extension interface type.')
      if (typeof partition !== 'string' || partition.length > 128) throw new Error('Invalid extension workspace.')
      const surface = await extensionManager.prepareSurface(id, kind, partition)
      return surface ? { ok: true, surface } : { ok: true, unavailable: true as const }
    } catch (error) { return fail(error) }
  })
  handle('vast:extensions:prepare-sidebar', async (_event, key: unknown) => {
    try {
      if (typeof key !== 'string' || key.length > 160) throw new Error('Invalid extension sidebar.')
      return { ok: true, surface: await extensionManager.prepareSidebar(key) }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:dispatch-contribution', async (_event, key: unknown, context: unknown) => {
    try {
      if (typeof key !== 'string' || key.length > 160 || (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context)))) throw new Error('Invalid extension contribution action.')
      if (!extensionManager.dispatchContribution(key, context as Record<string, unknown> | undefined)) throw new Error('Extension contribution is unavailable.')
      return { ok: true }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:ui-response', async (event, response: unknown) => {
    try {
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid extension UI response.')
      if (!extensionManager.respondToUiRequest(event.sender, response as VastUiBrokerResponse)) throw new Error('Extension UI request is unavailable.')
      return { ok: true }
    } catch (error) { return fail(error) }
  })

  handle('vast:extensions:tab-event', async (_event, name: unknown, payload: unknown) => {
    try {
      if (!['tabs.onActivated', 'tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved'].includes(String(name))) throw new Error('Invalid tab event.')
      const encoded = JSON.stringify(payload)
      if (encoded.length > 8_192) throw new Error('Tab event is too large.')
      extensionManager.emitTabEvent(name as 'tabs.onActivated' | 'tabs.onCreated' | 'tabs.onUpdated' | 'tabs.onRemoved', payload)
      return { ok: true }
    } catch (error) { return fail(error) }
  })
}
