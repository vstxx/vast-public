import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { correlateWarnings, safeCall, scanPassed } = require('../../scripts/password-manager-gate/probe-missing-receiver.cjs')
const extensionId = 'nngceckbapebfimnlniiiahkandclblb'

test('missing-receiver probe retains only approved send metadata', () => {
  assert.deepEqual(safeCall({ method: 'tabs.sendMessage', tabId: 3, frameId: 131,
    message: 'must-not-survive', credential: 'must-not-survive' }, extensionId, 100), {
    at: 100,
    method: 'tabs.sendMessage',
    extensionId,
    senderContext: 'service_worker',
    receiverContext: 'tab_frame',
    tabId: 3,
    frameId: 131
  })
  assert.equal(safeCall({ method: 'unknown', tabId: 3 }, extensionId, 100), undefined)
})

test('missing-receiver correlations expose timing and target metadata without payloads', () => {
  const calls = [safeCall({ method: 'runtime.sendMessage' }, extensionId, 100),
    safeCall({ method: 'tabs.sendMessage', tabId: 3, frameId: 0 }, extensionId, 200)]
  assert.deepEqual(correlateWarnings(calls, [220, 2_000]), [{
    method: 'tabs.sendMessage', extensionId, senderContext: 'service_worker', receiverContext: 'tab_frame',
    tabId: 3, frameId: 0, timingBucket: 'lt50ms', count: 1
  }, { method: 'unmatched', timingBucket: 'unmatched', count: 1 }])
})

test('missing-receiver scan requires all eight fixtures and overlay evidence', () => {
  const names = ['ordinary-login', 'spa-login', 'dynamic-login', 'delayed-login',
    'same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe']
  const fixtures = names.map((fixture) => ({ fixture, fieldDetected: false, focusSucceeded: false,
    overlayButtonCreated: true, frameProbeSupported: true,
    expectedChildFramesLoaded: fixture.includes('iframe') || fixture === 'nested-frame',
    childFormDetected: fixture.includes('iframe') || fixture === 'nested-frame' }))
  assert.equal(scanPassed(fixtures), true)
  assert.equal(scanPassed(fixtures.slice(0, 7)), false)
  assert.equal(scanPassed(fixtures.map((item, index) => ({ ...item,
    overlayButtonCreated: index !== 4 }))), false)
  assert.equal(scanPassed(fixtures.map((item) => ({ ...item,
    childFormDetected: item.fixture === 'nested-frame' ? false : item.childFormDetected }))), false)
})
