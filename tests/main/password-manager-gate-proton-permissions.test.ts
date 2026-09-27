import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { OPTIONAL_ALLOWLIST, extensionApiTarget, safePermissions, storedPermissions } = require('../../scripts/password-manager-gate/probe-proton-permissions.cjs')

test('Proton permission probe prefers an active routed popup without retaining its URL', () => {
  const id = 'ghmbeldphafepmbegfdlkpapadhbakde'
  const worker = { id: 'worker', type: 'service_worker', url: `chrome-extension://${id}/background.js`, webSocketDebuggerUrl: 'ws://worker' }
  const popup = { id: 'popup', type: 'webview', url: `chrome-extension://${id}/popup.html#/opaque-route`, webSocketDebuggerUrl: 'ws://popup' }
  assert.equal(extensionApiTarget([worker, popup]).id, 'popup')
})

test('Proton permission evidence retains only allowlisted names and booleans', () => {
  assert.deepEqual(OPTIONAL_ALLOWLIST, [
    'clipboardRead', 'clipboardWrite', 'nativeMessaging', 'privacy', 'webRequestAuthProvider'
  ])
  const safe = safePermissions({ runtimeId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    permissions: ['storage', 'clipboardWrite', 'privacy'], lastError: false, vault: 'must-not-leak' })
  assert.deepEqual(safe, { runtimeIdMatches: true, permissions: ['clipboardWrite', 'privacy'], lastError: false })
  assert.equal(JSON.stringify(safe).includes('must-not-leak'), false)
})

test('Proton stored permission evidence retains only optional allowlisted grants', () => {
  const safe = storedPermissions({ extensions: [{
    id: 'ghmbeldphafepmbegfdlkpapadhbakde',
    grantedChromePermissions: ['storage', 'clipboardRead', 'nativeMessaging'],
    path: 'must-not-leak'
  }] })
  assert.deepEqual(safe, {
    runtimeIdMatches: true,
    permissions: ['clipboardRead', 'nativeMessaging']
  })
  assert.equal(JSON.stringify(safe).includes('must-not-leak'), false)
})
