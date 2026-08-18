import { app, session } from 'electron/main'
import type { BrowserSettings } from '../../shared/types'
import { getRelayBuildConfig } from '../../shared/relay-config'
import { dataFilePath } from '../data-path'
import { openExternalUrl } from '../sessions'
import { windowRegistry } from '../windows/WindowRegistry'
import { VastRelayService } from './service'
import { RelayStateStore } from './storage'

declare const __VAST_INCLUDE_INTERNAL_TEST_HARNESS__: boolean

export function createVastRelayService(getSettings: () => BrowserSettings): VastRelayService {
  const relaySession = session.fromPartition('vast-relay', { cache: false })
  const simulateOffline = __VAST_INCLUDE_INTERNAL_TEST_HARNESS__ &&
    process.env.VAST_RELAY_TEST_OFFLINE === '1' && Boolean(process.env.VAST_TEST_USER_DATA_DIR)
  const service = new VastRelayService({
    config: getRelayBuildConfig(),
    stateStore: new RelayStateStore(dataFilePath('vast-relay-state.json')),
    fetcher: simulateOffline
      ? async () => { throw new Error('Simulated isolated Relay outage.') }
      : (input, init) => relaySession.fetch(input instanceof URL ? input.toString() : input, init),
    currentVersion: () => app.getVersion(),
    emitSnapshot: (snapshot) => {
      const target = windowRegistry.focusedVastWindow() ?? windowRegistry.vastWindows()[0]
      for (const window of windowRegistry.vastWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send('vast:relay:state', window === target ? snapshot : {
          ...snapshot,
          current: null,
          pendingCount: 0
        })
      }
    },
    openExternal: async (url) => {
      const target = windowRegistry.focusedVastWindow() ?? windowRegistry.vastWindows()[0]
      await openExternalUrl(url, target, getSettings())
    },
    applyTrustedUpdate: async () => {
      const updater = await import('../updater')
      const diagnostics = updater.getUpdaterDiagnostics()
      if (!diagnostics.enabled || diagnostics.state !== 'ready') return false
      await updater.applyUpdateNow()
      return true
    }
  })
  return service
}
