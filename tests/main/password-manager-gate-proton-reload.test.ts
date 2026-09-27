import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { probeProtonReload, protonReloadRunMode, safeManagerResult, workerIdentity } = require('../../scripts/password-manager-gate/probe-proton-reload.cjs')
const ID = 'ghmbeldphafepmbegfdlkpapadhbakde'

test('Proton reload probe verifies manager identity and recreated worker without vault data', async () => {
  let workerId = 'old-worker'
  const page = { type: 'page', url: 'file:///vast/index.html', webSocketDebuggerUrl: 'ws://page' }
  const result = await probeProtonReload({
    debuggerPort: 9223,
    extensionId: ID,
    version: '1.40.2',
    fetchImpl: async () => ({ ok: true, json: async () => [page, {
      id: workerId,
      type: 'service_worker',
      url: `chrome-extension://${ID}/background.js`,
      webSocketDebuggerUrl: 'ws://worker'
    }] }),
    connect: async (url: string) => url === 'ws://page' ? ({
      async evaluate() {
        workerId = 'new-worker'
        return { apiOk: true, identityPreserved: true, enabled: true }
      },
      close() {}
    }) : ({
      on(event: string, listener: (params: unknown) => void) {
        assert.equal(event, 'Runtime.executionContextCreated')
        queueMicrotask(() => listener({ context: { id: 7 } }))
        return () => undefined
      },
      async send(method: string, params?: { expression?: string; contextId?: number }) {
        if (method !== 'Runtime.evaluate') return {}
        assert.equal(params?.expression?.includes('password'), false)
        assert.equal(params?.contextId, 7)
        return params?.expression?.includes('typeof chrome')
          ? { result: { value: true } }
          : { result: { value: { runtimeIdMatches: true, versionMatches: true } } }
      },
      close() {}
    }),
    wait: async () => undefined
  })
  assert.deepEqual(result, {
    apiOk: true,
    identityPreserved: true,
    enabled: true,
    workerRecreated: true,
    runtimeIdentityRecovered: true,
    outcome: 'reload-and-worker-identity-recovered',
    passed: true
  })
  assert.equal(JSON.stringify(result).includes('password'), false)
})

test('Proton reload probe rejects expanded manager output', () => {
  assert.throws(() => safeManagerResult({
    apiOk: true, identityPreserved: true, enabled: true, vault: 'must-not-leak'
  }), /unexpected reload result/i)
})

test('Proton worker identity waits for the recreated worker execution context', async () => {
  let listener: ((params: unknown) => void) | undefined
  let enableCalls = 0
  const worker = { webSocketDebuggerUrl: 'ws://worker' }
  const recovered = await workerIdentity(worker, ID, '1.40.2', async () => ({
    on(_event: string, value: (params: unknown) => void) {
      listener = value
      return () => { listener = undefined }
    },
    async send(method: string, params?: { expression?: string }) {
      if (method === 'Runtime.enable') {
        enableCalls += 1
        if (enableCalls === 2) listener?.({ context: { id: 9 } })
        return {}
      }
      if (method === 'Runtime.disable') return {}
      if (method === 'Runtime.evaluate') {
        return params?.expression?.includes('typeof chrome')
          ? { result: { value: true } }
          : { result: { value: { runtimeIdMatches: true, versionMatches: true } } }
      }
      return {}
    },
    close() {}
  }), async () => undefined)

  assert.equal(recovered, true)
  assert.equal(enableCalls, 2)
})

test('Proton worker identity retries a transient evaluation failure after reload', async () => {
  let listener: ((params: unknown) => void) | undefined
  let identityCalls = 0
  const recovered = await workerIdentity({ webSocketDebuggerUrl: 'ws://worker' }, ID, '1.40.2', async () => ({
    on(_event: string, value: (params: unknown) => void) {
      listener = value
      return () => { listener = undefined }
    },
    async send(method: string, params?: { expression?: string }) {
      if (method === 'Runtime.enable') {
        queueMicrotask(() => listener?.({ context: { id: 11 } }))
        return {}
      }
      if (method === 'Runtime.disable') return {}
      if (method === 'Runtime.evaluate' && params?.expression?.includes('typeof chrome')) {
        return { result: { value: true } }
      }
      if (method === 'Runtime.evaluate') {
        identityCalls += 1
        return identityCalls === 1
          ? { exceptionDetails: {} }
          : { result: { value: { runtimeIdMatches: true, versionMatches: true } } }
      }
      return {}
    },
    close() {}
  }), async () => undefined)

  assert.equal(recovered, true)
  assert.equal(identityCalls, 2)
})

test('Proton reload probe accepts a live combined run without weakening run identity checks', () => {
  const command = { mode: 'combined', runId: 'combined-run' }
  const result = { mode: 'combined', runId: 'combined-run' }
  const launcher = { runId: 'combined-run' }
  const status = { status: 'running' }
  assert.equal(protonReloadRunMode(command, result, launcher, status), 'combined')
  assert.throws(() => protonReloadRunMode(
    { mode: 'bitwarden', runId: 'run' },
    { mode: 'bitwarden', runId: 'run' },
    { runId: 'run' },
    status
  ), /Proton or combined gate/i)
})
