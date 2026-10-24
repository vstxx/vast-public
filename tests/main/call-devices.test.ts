import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildFingerprintingProtectionScript } from '../../src/shared/fingerprinting.ts'

const sessions = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')

// Google Meet allowed the camera but then listed no usable devices.
test('fingerprinting protection leaves device enumeration to Chromium in every mode', () => {
  for (const mode of ['standard', 'strict', 'maximum'] as const) {
    const script = buildFingerprintingProtectionScript(mode, 'seed', false)
    assert.doesNotMatch(script, /enumerateDevices\s*=/, `${mode} must not replace enumerateDevices`)
    assert.doesNotMatch(script, /vast-device-/, `${mode} must not substitute device IDs`)
  }
})

test('"Allow once" lasts for the visit: checks see it and the site is not asked again', () => {
  assert.match(sessions, /if \(choice === 'allow-once' && requestIsCurrent\(\)\) grantForVisit\(webContents, origin, permissionKinds\)/)
  // Checks (device names and IDs, permission status) honor it, but never over a block.
  assert.match(sessions, /return stored === 'allow' \|\| \(stored !== 'block' && grantedForVisit\(requestingContents, origin, kind\)\)/)
  // Later requests in the same visit are allowed without a second prompt.
  assert.match(sessions, /permissionKinds\.every\(\(kind\) => grantedForVisit\(webContents, origin, kind\)\)/)
  // It ends when the tab leaves the site or closes.
  assert.match(sessions, /if \(isMainFrame && originFromPermissionUrl\(url\) !== origin\) end\(\)/)
  assert.match(sessions, /contents\.once\('destroyed', end\)/)
})

test('device names follow the camera or microphone decision; speakers follow the microphone', () => {
  assert.match(sessions, /if \(permission === 'speaker-selection'\) return allowed\('microphone'\)/)
  assert.match(sessions, /if \(permission === 'media' && !requestMediaType\) return allowed\('camera'\) \|\| allowed\('microphone'\)/)
})
