import { BrowserWindow, type IpcMainInvokeEvent } from 'electron/main'
import type { CatAddonService } from '../cat-addon-service'
import type { IpcFeatureRegistrar } from '../ipc'
import { showRendererNotification } from '../ui-bridge'
import { windowRegistry } from '../windows/WindowRegistry'

function senderWindowFor(event: IpcMainInvokeEvent): BrowserWindow {
  const senderWindow = windowRegistry.vastWindowForWebContents(event.sender)
  if (!senderWindow || senderWindow.isDestroyed()) throw new Error('The requesting Vast window is unavailable.')
  return senderWindow
}

export function createCatAddonIpcRegistrar(catAddonService: CatAddonService): IpcFeatureRegistrar {
  return (handle) => {
    handle('vast:cat-addon:status', async () => catAddonService.getState())
    handle('vast:cat-addon:runtime', async () => catAddonService.runtime())
    handle('vast:cat-addon:window-state', async (event) => {
      const window = senderWindowFor(event)
      return { visible: window.isVisible(), minimized: window.isMinimized(), fullscreen: window.isFullScreen() }
    })
    handle('vast:cat-addon:enable', async (event) => {
      const state = await catAddonService.enable()
      showRendererNotification(senderWindowFor(event), state.enabled
        ? { tone: 'success', title: 'Cat Addon enabled', message: 'A hand-animated pixel cat now lives in Vast.' }
        : { tone: 'error', title: 'Cat Addon could not be enabled', message: state.error ?? 'The bundled addon failed validation.' })
      return state
    })
    handle('vast:cat-addon:disable', async (event) => {
      const state = await catAddonService.disable()
      showRendererNotification(senderWindowFor(event), state.error
        ? { tone: 'warning', title: 'Cat Addon disabled', message: state.error }
        : { tone: 'info', title: 'Cat Addon disabled', message: 'Cat animations and extracted assets were removed.' })
      return state
    })
  }
}
