import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { protonRootDetected, protonUiIds, safeObservation, scanPassed } = require('../../scripts/password-manager-gate/scan-proton-fixtures.cjs')

test('Proton marker detection evaluates the top frame in an explicit DOM world', async () => {
  const calls: Array<{ method: string; params?: { frameId?: string; contextId?: number } }> = []
  const session = {
    async evaluate() { return false },
    async send(method: string, params?: { frameId?: string; contextId?: number }) {
      calls.push({ method, params })
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return {}
    }
  }
  const tree = { frame: { id: 'top', url: 'https://login.vast-test.local/login' } }

  assert.equal(await protonRootDetected(session, tree), true)
  assert.deepEqual(calls.map(({ method, params }) => ({ method, frameId: params?.frameId, contextId: params?.contextId })), [
    { method: 'Page.createIsolatedWorld', frameId: 'top', contextId: undefined },
    { method: 'Runtime.evaluate', frameId: undefined, contextId: 17 }
  ])
})

test('Proton UI detection uses only the official isolated dropdown target', () => {
  const id = 'ghmbeldphafepmbegfdlkpapadhbakde'
  const ids = protonUiIds([
    { id: 'right', type: 'iframe', url: `chrome-extension://${id}/dropdown.html` },
    { id: 'wrong-page', type: 'page', url: `chrome-extension://${id}/dropdown.html` },
    { id: 'wrong-file', type: 'iframe', url: `chrome-extension://${id}/popup.html` },
    { id: 'wrong-id', type: 'iframe', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/dropdown.html' }
  ])
  assert.deepEqual([...ids], ['right'])
})

test('Proton scan retains structural metadata only', () => {
  const item = safeObservation({ fixture: 'ordinary-login', host: 'login.vast-test.local', route: '/login',
    focus: { fieldDetected: true, focusSucceeded: true, frameScope: 'top' }, rootInjected: true,
    childFrameCount: 0, expectedChildFramesLoaded: false, childFormDetected: false, frameProbeSupported: true,
    payload: 'must-not-survive', value: 'must-not-survive' })
  assert.equal(JSON.stringify(item).includes('must-not-survive'), false)
})

test('Proton scan requires root injection across all eight fixtures', () => {
  const names = ['ordinary-login', 'spa-login', 'dynamic-login', 'delayed-login',
    'same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe']
  const observations = names.map((fixture) => ({ fixture, rootInjected: true, frameProbeSupported: true,
    expectedChildFramesLoaded: fixture.includes('iframe') || fixture === 'nested-frame',
    childFormDetected: fixture.includes('iframe') || fixture === 'nested-frame' }))
  assert.equal(scanPassed(observations), true)
  assert.equal(scanPassed(observations.map((item, index) => ({ ...item, rootInjected: index !== 3 }))), false)
})
