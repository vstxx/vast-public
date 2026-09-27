import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probeNaturalIdle } = require('../../scripts/password-manager-gate/probe-worker-idle.cjs')
const ID = 'nngceckbapebfimnlniiiahkandclblb'
const page = { id: 'page-1', type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://page' }

test('natural idle probe does not claim sleep when the worker remains live', async () => {
  const observation = await probeNaturalIdle({ debuggerPort: 9223, extensionId: ID, maxWaitMs: 1_000,
    fetchImpl: async () => ({ ok: true, json: async () => [page,
      { id: 'worker-1', type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] }),
    wait: async () => undefined })
  assert.deepEqual(observation, { outcome: 'idle-not-observed', idleObserved: false,
    workerWoke: false, privacyRecovered: false, waitedMs: 1_000 })
})

test('natural idle probe requires disappearance before navigation, new worker, and privacy recovery', async () => {
  let polls = 0
  let reloaded = false
  const observation = await probeNaturalIdle({ debuggerPort: 9223, extensionId: ID, maxWaitMs: 2_000,
    fetchImpl: async () => ({ ok: true, json: async () => {
      polls += 1
      return [page, ...(reloaded ? [{ id: 'worker-2', type: 'service_worker', url: `chrome-extension://${ID}/background.js` }]
        : polls < 3 ? [{ id: 'worker-1', type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] : [])]
    } }),
    connectPage: async () => ({ async send(method: string) { assert.equal(method, 'Page.reload'); reloaded = true }, close() {} }),
    capturePrivacy: async () => ({ extensionId: ID, optionalPrivacyGranted: true, keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ] }), wait: async () => undefined })
  assert.deepEqual(observation, { outcome: 'idle-wake-and-privacy-recovered', idleObserved: true,
    workerWoke: true, privacyRecovered: true, waitedMs: 1_000 })
})
