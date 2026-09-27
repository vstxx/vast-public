import { chooseNewTabBackground, getNewTabBackgroundDataUrl } from '../new-tab-background'
import { fail, type IpcHandle, type SenderWindowFor } from './registration'

export function registerNewTabBackgroundIpc(handle: IpcHandle, senderWindowFor: SenderWindowFor): void {
  handle('vast:new-tab-background:get', async () => {
    try {
      return { ok: true, dataUrl: await getNewTabBackgroundDataUrl() }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:new-tab-background:choose', async (event) => {
    try {
      return { ok: true, ...await chooseNewTabBackground(senderWindowFor(event)) }
    } catch (error) {
      return fail(error)
    }
  })
}
