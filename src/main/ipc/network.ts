import type { NetworkDevicePatch, NetworkScanOptions } from '../../shared/types'
import {
  assertNonEmptyString,
  assertObject,
  fail,
  ok,
  type IpcHandle,
  type SenderWindowFor
} from './registration'

export function registerNetworkIpc(handle: IpcHandle, senderWindowFor: SenderWindowFor): void {
  handle('vast:network:get-devices', async () => {
    try {
      return { ok: true, ...(await (await import('../network/discovery')).getNetworkDevices()) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:scan', async (_event, options: NetworkScanOptions = {}) => {
    try {
      assertObject(options, 'scan options')
      const [{ loadData }, { scanNetwork }] = await Promise.all([import('../storage'), import('../network/discovery')])
      const data = await loadData()
      return { ok: true, ...(await scanNetwork(data.settings.network, options)) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:update-device', async (_event, id: string, patch: NetworkDevicePatch) => {
    try {
      assertNonEmptyString(id, 'device id', 256)
      assertObject(patch, 'device update')
      return { ok: true, device: await (await import('../network/discovery')).updateNetworkDevice(id, patch) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:forget-device', async (_event, id: string) => {
    try {
      assertNonEmptyString(id, 'device id', 256)
      await (await import('../network/discovery')).forgetNetworkDevice(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:clear-cache', async () => {
    try {
      await (await import('../network/discovery')).clearNetworkCache()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:export-inventory', async (event) => {
    try {
      const owner = senderWindowFor(event)
      return { ok: true, ...(await (await import('../network/discovery')).exportNetworkInventory(owner)) }
    } catch (error) {
      return fail(error)
    }
  })
}
