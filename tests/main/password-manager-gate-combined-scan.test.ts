import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  combinedWorkers,
  protonMarkerExpression,
  rememberWorkers,
  safeCombinedObservation,
  scanPassed
} = require('../../scripts/password-manager-gate/scan-combined-fixtures.cjs')

const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'
const PROTON_ID = 'ghmbeldphafepmbegfdlkpapadhbakde'

test('combined scanner detects Proton structural field and icon markers without reading values', () => {
  const expression = protonMarkerExpression()
  assert.match(expression, /data-protonpass-role/)
  assert.match(expression, /data-protonpass-form/)
  assert.match(expression, /protonpass-control-/)
  assert.doesNotMatch(expression, /\.value\b|textContent|innerText/)
})

test('combined worker detection accepts only both official service workers', () => {
  const workers = combinedWorkers([
    { id: 'bitwarden', type: 'service_worker', url: `chrome-extension://${BITWARDEN_ID}/background.js` },
    { id: 'proton', type: 'service_worker', url: `chrome-extension://${PROTON_ID}/background.js` },
    { id: 'wrong-type', type: 'page', url: `chrome-extension://${BITWARDEN_ID}/background.js` },
    { id: 'wrong-id', type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js' }
  ])
  assert.deepEqual(workers, { bitwarden: 'bitwarden', proton: 'proton' })
})

test('combined worker evidence tolerates normal MV3 sleep between observations', () => {
  const bitwardenOnly = [{ id: 'bitwarden', type: 'service_worker', url: `chrome-extension://${BITWARDEN_ID}/background.js` }]
  const protonOnly = [{ id: 'proton', type: 'service_worker', url: `chrome-extension://${PROTON_ID}/background.js` }]
  const afterBitwarden = rememberWorkers({ bitwarden: false, proton: false }, bitwardenOnly)
  assert.deepEqual(afterBitwarden, { bitwarden: true, proton: false })
  assert.deepEqual(rememberWorkers(afterBitwarden, protonOnly), { bitwarden: true, proton: true })
})

test('combined fixture evidence retains structural booleans only', () => {
  const observation = safeCombinedObservation({
    fixture: 'ordinary-login', host: 'login.vast-test.local', route: '/login',
    focus: { fieldDetected: true, focusSucceeded: true, frameScope: 'top' },
    bitwardenInjected: true, protonInjected: true,
    childFrameCount: 0, expectedChildFramesLoaded: false,
    childFormDetected: false, frameProbeSupported: true,
    username: 'must-not-survive', password: 'must-not-survive', payload: 'must-not-survive'
  })
  assert.equal(JSON.stringify(observation).includes('must-not-survive'), false)
})

test('combined scan requires both managers on every approved fixture', () => {
  const names = ['ordinary-login', 'spa-login', 'dynamic-login', 'delayed-login',
    'same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe']
  const observations = names.map((fixture) => ({
    fixture,
    bitwardenInjected: true,
    protonInjected: true,
    frameProbeSupported: true,
    expectedChildFramesLoaded: fixture.includes('iframe') || fixture === 'nested-frame',
    childFormDetected: fixture.includes('iframe') || fixture === 'nested-frame'
  }))
  assert.equal(scanPassed(observations), true)
  assert.equal(scanPassed(observations.map((item, index) => ({
    ...item,
    protonInjected: index !== 4
  }))), false)
})
