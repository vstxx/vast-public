import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { approvedWebview, probeWorkerLifecycle, workerTarget } =
  require('../../scripts/password-manager-gate/probe-worker-lifecycle.cjs')
const ID = 'nngceckbapebfimnlniiiahkandclblb'

test('worker probe selects only the exact extension worker and approved HTTPS webview', () => {
  const worker = { id: 'worker-1', type: 'service_worker', url: `chrome-extension://${ID}/background.js` }
  assert.deepEqual(workerTarget([worker], ID), worker)
  assert.equal(workerTarget([{ ...worker, url: `chrome-extension://${ID}/other.js` }], ID), undefined)
  assert.equal(approvedWebview({ type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://page' }), true)
  assert.equal(approvedWebview({ type: 'webview', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://page' }), false)
})

test('worker probe requires targeted stop, navigation wake, and safe privacy recovery', async () => {
  let workerId: string | undefined = 'worker-1'
  let listener: ((event: unknown) => void) | undefined
  const page = { id: 'page-1', type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://page' }
  const fetchImpl = async () => ({ ok: true, json: async () => [page,
    ...(workerId ? [{ id: workerId, type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] : [])] })
  const browser = {
    on(_method: string, callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined } },
    async send(method: string, params?: { versionId: string }) {
      if (method === 'ServiceWorker.enable') listener?.({ versions: [{ versionId: 'version-1',
        scriptURL: `chrome-extension://${ID}/background.js`, runningStatus: 'running' }] })
      if (method === 'ServiceWorker.stopWorker') {
        assert.equal(params?.versionId, 'version-1')
        workerId = undefined
      }
    },
    close() {}
  }
  const result = await probeWorkerLifecycle({ debuggerPort: 9223, extensionId: ID, fetchImpl,
    connectBrowser: async () => browser,
    connectPage: async () => ({ async send(method: string) {
      assert.equal(method, 'Page.reload'); workerId = 'worker-2'
    }, close() {} }),
    capturePrivacy: async () => ({ extensionId: ID, optionalPrivacyGranted: true, keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ] }),
    wait: async () => undefined })
  assert.deepEqual(result, { outcome: 'wake-and-privacy-recovered', workerStopped: true,
    workerWoke: true, privacyRecovered: true })
  assert.equal(JSON.stringify(result).includes('passwordSavingEnabled'), false)
})

test('worker probe observes stopped-version event even when target disappearance is too brief to poll', async () => {
  let workerId = 'worker-1'
  let listener: ((event: unknown) => void) | undefined
  const page = { id: 'page-1', type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://page' }
  const browser = {
    on(_method: string, callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined } },
    async send(method: string) {
      if (method === 'ServiceWorker.enable') listener?.({ versions: [{ versionId: 'version-1',
        scriptURL: `chrome-extension://${ID}/background.js`, runningStatus: 'running' }] })
      if (method === 'ServiceWorker.stopWorker') listener?.({ versions: [{ versionId: 'version-1',
        scriptURL: `chrome-extension://${ID}/background.js`, runningStatus: 'stopped' }] })
    },
    close() {}
  }
  const result = await probeWorkerLifecycle({ debuggerPort: 9223, extensionId: ID,
    fetchImpl: async () => ({ ok: true, json: async () => [page,
      { id: workerId, type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] }),
    connectBrowser: async () => browser,
    connectPage: async () => ({ async send() { workerId = 'worker-2' }, close() {} }),
    capturePrivacy: async () => ({ extensionId: ID, optionalPrivacyGranted: true, keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ] }), wait: async () => undefined })
  assert.equal(result.outcome, 'wake-and-privacy-recovered')
})

test('worker probe does not claim a stop from a successful command alone', async () => {
  let listener: ((event: unknown) => void) | undefined
  const page = { id: 'page-1', type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://page' }
  const browser = {
    on(_method: string, callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined } },
    async send(method: string) {
      if (method === 'ServiceWorker.enable') listener?.({ versions: [{ versionId: 'version-1',
        scriptURL: `chrome-extension://${ID}/background.js`, runningStatus: 'running' }] })
    }, close() {}
  }
  const result = await probeWorkerLifecycle({ debuggerPort: 9223, extensionId: ID,
    fetchImpl: async () => ({ ok: true, json: async () => [page,
      { id: 'worker-1', type: 'service_worker', url: `chrome-extension://${ID}/background.js` }] }),
    connectBrowser: async () => browser, wait: async () => undefined })
  assert.deepEqual(result, { outcome: 'worker-stop-not-observed', workerStopped: false,
    workerWoke: false, privacyRecovered: false })
})
