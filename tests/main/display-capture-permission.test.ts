import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessions = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const between = (start: string, end: string): string => sessions.slice(sessions.indexOf(start), sessions.indexOf(end, sessions.indexOf(start)))

// Electron 45 reports getDisplayMedia to the permission handlers as
// `display-capture`; Electron 42-44 sent an empty `media` request instead.
test('screen capture permission is gated like the Electron 44 empty media request', () => {
  const requestHandler = between('targetSession.setPermissionRequestHandler(', 'const requestId = randomUUID()')
  assert.match(requestHandler, /if \(\(permission === 'media' && mediaTypes\.length === 0\) \|\| permission === 'display-capture'\) \{\s+callback\(true\)/)
  assert.match(requestHandler, /if \(isCapturePermission\(permission\) && settings\.privacy\.webRtcPolicy === 'disabled'/, 'the WebRTC block still applies to screen capture')
})

test('permission checks let display-capture reach the source picker unless WebRTC is blocked', () => {
  const checkHandler = between('targetSession.setPermissionCheckHandler(', 'targetSession.setPermissionRequestHandler(')
  const webRtc = checkHandler.indexOf("isCapturePermission(permission) && settings.privacy.webRtcPolicy === 'disabled'")
  const allow = checkHandler.indexOf("if (permission === 'display-capture') return true")
  assert.ok(webRtc > -1 && allow > webRtc, 'WebRTC policy is checked before display-capture is allowed')
})

test('the display media handler still requires a user gesture and a picked source', () => {
  const displayHandler = between('targetSession.setDisplayMediaRequestHandler(', 'const requestId = randomUUID()')
  assert.match(displayHandler, /!request\.userGesture/)
  assert.match(sessions, /title: 'Choose what to share'/)
})
