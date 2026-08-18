import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { permissionKindsFromElectronPermission, resolveStoredPermissionPolicy, upsertOriginPermissionOverride } from '../../src/main/permission-policy.ts'
import type { BrowserSettings } from '../../src/shared/types.ts'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const uiBridgeSource = readFileSync(new URL('../../src/main/ui-bridge.ts', import.meta.url), 'utf8')
const rendererSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')

function settings(): BrowserSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as BrowserSettings
}

test('allow once does not persist an origin override', () => {
  const current = settings()
  assert.equal(resolveStoredPermissionPolicy(current, 'https://example.com', 'geolocation'), 'ask')
})

test('permission prompts are owned by webContents, Vast window, origin, navigation, kind, and request id', () => {
  assert.match(sessionsSource, /const requestId = randomUUID\(\)/)
  assert.match(sessionsSource, /ownerWindowForWebContents\(webContents\)/)
  assert.match(sessionsSource, /originFromPermissionUrl\(webContents\.getURL\(\)\)/)
  assert.match(sessionsSource, /permissionKind/)
  assert.match(sessionsSource, /did-start-navigation/)
  assert.match(sessionsSource, /render-process-gone/)
  assert.match(sessionsSource, /window\.once\('closed', invalidate\)/)
})

test('prompt responses are sender-bound and persistent decisions are saved by main only after revalidation', () => {
  assert.match(uiBridgeSource, /pending\.ownerWebContentsId !== sender\.id/)
  assert.match(sessionsSource, /ownerWindowForWebContents\(webContents\) !== window/)
  assert.match(sessionsSource, /upsertOriginPermissionOverride/)
  assert.match(sessionsSource, /await saveData\(next\)/)
  assert.doesNotMatch(rendererSource, /sitePermissions:\s*\[[\s\S]*prompt\.permissionRequest/)
})

test('always allow and block persist only for that origin', () => {
  let current = settings()
  current = upsertOriginPermissionOverride(current, 'https://example.com', 'geolocation', 'allow')
  current = upsertOriginPermissionOverride(current, 'https://blocked.example', 'geolocation', 'block')

  assert.equal(resolveStoredPermissionPolicy(current, 'https://example.com', 'geolocation'), 'allow')
  assert.equal(resolveStoredPermissionPolicy(current, 'https://blocked.example', 'geolocation'), 'block')
  assert.equal(resolveStoredPermissionPolicy(current, 'https://other.example', 'geolocation'), 'ask')
})

test('combined media requests preserve separate camera and microphone decisions', () => {
  assert.deepEqual(permissionKindsFromElectronPermission('media', ['video', 'audio']), ['camera', 'microphone'])
  assert.deepEqual(permissionKindsFromElectronPermission('media', ['audio']), ['microphone'])
  assert.deepEqual(permissionKindsFromElectronPermission('media', ['video']), ['camera'])
})

test('main-owned site permission decisions are synchronized before renderer autosave', () => {
  assert.match(sessionsSource, /vast:site-permissions-changed/)
  assert.match(preloadSource, /onSitePermissionsChanged/)
  assert.match(rendererSource, /onSitePermissionsChanged\(\(sitePermissions\)/)
  assert.match(rendererSource, /updateSettings\(\{ security: \{ sitePermissions \} \}\)/)
})

test('display capture uses a gesture-gated fresh source picker without permanent grants', () => {
  assert.match(sessionsSource, /permission === 'media' && mediaTypes\.length === 0/)
  assert.match(sessionsSource, /setDisplayMediaRequestHandler/)
  assert.match(sessionsSource, /!request\.userGesture/)
  assert.match(sessionsSource, /desktopCapturer\.getSources/)
  assert.match(sessionsSource, /Vast never remembers this choice/)
  assert.match(sessionsSource, /frame\.detached/)
  assert.doesNotMatch(sessionsSource, /setDisplayMediaRequestHandler[\s\S]{0,2500}sources\[0\]/)
})
