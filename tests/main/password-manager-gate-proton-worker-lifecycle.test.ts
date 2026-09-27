import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probeProtonWorkerLifecycle } = require('../../scripts/password-manager-gate/probe-proton-worker-lifecycle.cjs')
const ID = 'ghmbeldphafepmbegfdlkpapadhbakde'

test('Proton worker lifecycle stops, wakes, and verifies worker identity without vault data', async () => {
  let workerId = 'worker-old'
  let stopped = false
  let versionListener: ((params: unknown) => void) | undefined
  const page = { type: 'webview', url: 'https://login.vast-test.local:50889/login', webSocketDebuggerUrl: 'ws://page' }
  const worker = () => ({ id: workerId, type: 'service_worker',
    url: `chrome-extension://${ID}/background.js`, webSocketDebuggerUrl: 'ws://worker' })
  const control = {
    on: (_method: string, listener: (params: unknown) => void) => {
      versionListener = listener
      return () => undefined
    },
    async send(method: string) {
      if (method === 'ServiceWorker.enable') {
        versionListener?.({ versions: [{ versionId: 'version-1',
          scriptURL: `chrome-extension://${ID}/background.js`, runningStatus: 'running' }] })
        return {}
      }
      if (method === 'ServiceWorker.stopWorker') { stopped = true; workerId = 'worker-new'; return {} }
      return {}
    },
    close() {}
  }
  const result = await probeProtonWorkerLifecycle({
    debuggerPort: 9223,
    extensionId: ID,
    version: '1.40.2',
    fetchImpl: async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/json/list') ? [page, worker()] : { webSocketDebuggerUrl: 'ws://browser' }
    }),
    connectBrowser: async () => control,
    connectPage: async (url: string) => {
      let contextListener: ((params: unknown) => void) | undefined
      return {
      on(method: string, listener: (params: unknown) => void) {
        if (method === 'Runtime.executionContextCreated') contextListener = listener
        return () => undefined
      },
      async send(method: string, params?: { expression?: string }) {
        if (method === 'ServiceWorker.enable') return {}
        if (method === 'Page.reload') return {}
        if (method === 'Runtime.enable') {
          contextListener?.({ context: { id: 9 } })
          return {}
        }
        if (method === 'Runtime.evaluate') {
          assert.equal(params?.expression?.includes('password'), false)
          return { result: { value: params?.expression === 'typeof chrome === "object" && typeof chrome.runtime === "object"'
            ? true
            : { runtimeIdMatches: true, versionMatches: true } } }
        }
        return {}
      },
      close() {}
    } },
    wait: async () => undefined
  })
  assert.equal(stopped, true)
  assert.deepEqual(result, {
    outcome: 'worker-woke-and-identity-recovered', workerStopped: true, workerWoke: true,
    runtimeIdentityRecovered: true, passed: true
  })
})
