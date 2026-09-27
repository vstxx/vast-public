import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probeProtonNaturalIdle } = require('../../scripts/password-manager-gate/probe-proton-natural-idle.cjs')
const ID = 'ghmbeldphafepmbegfdlkpapadhbakde'

function contextAwareSession(onSend?: (method: string) => void) {
  let contextListener: ((params: unknown) => void) | undefined
  return {
    on(method: string, listener: (params: unknown) => void) {
      if (method === 'Runtime.executionContextCreated') contextListener = listener
      return () => undefined
    },
    async send(method: string, params?: { expression?: string }) {
      onSend?.(method)
      if (method === 'Runtime.enable') {
        contextListener?.({ context: { id: 7 } })
        return {}
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: params?.expression === 'typeof chrome === "object" && typeof chrome.runtime === "object"'
          ? true
          : { runtimeIdMatches: true, versionMatches: true } } }
      }
      return {}
    },
    close() {}
  }
}

test('Proton natural idle accepts an atomic worker target replacement and verifies identity', async () => {
  let polls = 0
  const page = { type: 'webview', url: 'https://login.vast-test.local:50889/login', webSocketDebuggerUrl: 'ws://page' }
  const makeWorker = (id: string) => ({ id, type: 'service_worker',
    url: `chrome-extension://${ID}/background.js`, webSocketDebuggerUrl: `ws://${id}` })
  const result = await probeProtonNaturalIdle({
    debuggerPort: 9223, extensionId: ID, version: '1.40.2', timeoutMs: 5_000, pollMs: 1,
    fetchImpl: async () => ({ ok: true, json: async () => [page, makeWorker(polls++ < 1 ? 'old' : 'new')] }),
    connect: async () => contextAwareSession(),
    wait: async () => undefined
  })
  assert.deepEqual({ idleObserved: result.idleObserved, workerWoke: result.workerWoke,
    runtimeIdentityRecovered: result.runtimeIdentityRecovered, passed: result.passed },
  { idleObserved: true, workerWoke: true, runtimeIdentityRecovered: true, passed: true })
})

test('Proton natural idle wakes a sleeping worker before establishing its baseline', async () => {
  let calls = 0
  let reloaded = false
  const page = { type: 'webview', url: 'https://login.vast-test.local:50889/login', webSocketDebuggerUrl: 'ws://page' }
  const worker = (id: string) => ({ id, type: 'service_worker',
    url: `chrome-extension://${ID}/background.js`, webSocketDebuggerUrl: `ws://${id}` })
  const result = await probeProtonNaturalIdle({
    debuggerPort: 9223, extensionId: ID, version: '1.40.2', timeoutMs: 5_000, pollMs: 1,
    fetchImpl: async () => ({ ok: true, json: async () => {
      calls += 1
      if (calls === 1) return [page]
      if (calls === 2) return [page, worker('baseline')]
      return [page, worker('replacement')]
    } }),
    connect: async (url: string) => contextAwareSession((method) => {
      if (url === 'ws://page' && method === 'Page.reload') reloaded = true
    }),
    wait: async () => undefined
  })
  assert.equal(reloaded, true)
  assert.equal(result.passed, true)
})
