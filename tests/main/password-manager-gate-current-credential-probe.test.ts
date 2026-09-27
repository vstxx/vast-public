import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { approvedCurrentTarget, expectedHashes, frameEntries, safeObservation } = require('../../scripts/password-manager-gate/probe-current-credential.cjs')
const { approvedIcloudTarget } = require('../../scripts/password-manager-gate/probe-icloud-credential.cjs')

test('current credential probe traverses nested frame trees with stable depths', () => {
  assert.deepEqual(frameEntries({ frame: { id: 'top' }, childFrames: [
    { frame: { id: 'child' }, childFrames: [{ frame: { id: 'leaf' } }] }
  ] }), [
    { frameId: 'top', frameDepth: 0 },
    { frameId: 'child', frameDepth: 1 },
    { frameId: 'leaf', frameDepth: 2 }
  ])
})

test('current credential probe restricts targets to approved HTTPS fixture origins and exact port', () => {
  const target = { type: 'webview', url: 'https://login.vast-test.local:50889/login', webSocketDebuggerUrl: 'ws://local' }
  assert.equal(approvedCurrentTarget(target, 50889), true)
  assert.equal(approvedCurrentTarget({ ...target, url: 'https://login.vast-test.local:57638/login' }, 50889), false)
  assert.equal(approvedCurrentTarget({ ...target, url: 'https://example.com:50889/login' }, 50889), false)
  assert.equal(approvedCurrentTarget({ ...target, url: 'http://login.vast-test.local:50889/login' }, 50889), false)
})

test('iCloud credential probe accepts Chrome page targets while preserving origin restrictions', () => {
  const target = { type: 'page', url: 'https://login.vast-test.local:50889/native-login', webSocketDebuggerUrl: 'ws://local' }
  assert.equal(approvedIcloudTarget(target, 50889), true)
  assert.equal(approvedIcloudTarget({ ...target, type: 'webview' }, 50889), true)
  assert.equal(approvedIcloudTarget({ ...target, type: 'service_worker' }, 50889), false)
  assert.equal(approvedIcloudTarget({ ...target, url: 'https://example.com:50889/native-login' }, 50889), false)
  assert.equal(approvedIcloudTarget({ ...target, url: 'http://login.vast-test.local:50889/native-login' }, 50889), false)
})

test('current credential probe output drops field contents and exposes only match booleans', () => {
  const observation = safeObservation({
    targetId: 'target-1', frameId: 'frame-1', frameDepth: 1,
    host: 'login.vast-test.local', route: '/login', visibility: 'visible', focused: true,
    usernamePresent: true, passwordPresent: true, usernameMatchesExpectedHash: true,
    passwordMatchesExpectedHash: true, username: 'must-not-leak', password: 'must-not-leak'
  })
  assert.equal(observation.usernameMatchesExpectedHash, true)
  assert.equal(observation.passwordMatchesExpectedHash, true)
  assert.equal(JSON.stringify(observation).includes('must-not-leak'), false)
})

test('current credential hash input is normalized without exposing credential values', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'vast-hashes-'))
  const file = join(directory, 'hashes.json')
  writeFileSync(file, JSON.stringify({ usernameSha256: 'A'.repeat(64), passwordSha256: 'B'.repeat(64) }))
  t.after(() => rmSync(directory, { recursive: true }))
  assert.deepEqual(expectedHashes(file), { username: 'a'.repeat(64), password: 'b'.repeat(64) })
})
