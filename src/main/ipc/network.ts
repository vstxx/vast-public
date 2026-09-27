import type { NetworkDevicePatch, NetworkScanOptions } from '../../shared/types'
import {
  clearNetworkCache,
  exportNetworkInventory,
  forgetNetworkDevice,
  getNetworkDevices,
  scanNetwork,
  updateNetworkDevice
} from '../network/discovery'
import { loadData } from '../storage'
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
      return { ok: true, ...(await getNetworkDevices()) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:scan', async (_event, options: NetworkScanOptions = {}) => {
    try {
      assertObject(options, 'scan options')
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
      return { ok: true, device: await updateNetworkDevice(id, patch) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:forget-device', async (_event, id: string) => {
    try {
      assertNonEmptyString(id, 'device id', 256)
      await forgetNetworkDevice(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:clear-cache', async () => {
    try {
      await clearNetworkCache()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:network:export-inventory', async (event) => {
    try {
      const owner = senderWindowFor(event)
      return { ok: true, ...(await exportNetworkInventory(owner)) }
    } catch (error) {
      return fail(error)
    }
  })
}
