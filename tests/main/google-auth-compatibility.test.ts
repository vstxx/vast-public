import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const harnessSource = readFileSync(new URL('../../src/main/google-auth-test-harness.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const viteConfigSource = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8')
const browserStageSource = readFileSync(
  new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url),
  'utf8'
)

test('auth-sensitive requests bypass blockers and identity rewriting only in auth scope', () => {
  assert.match(sessionsSource, /shouldBypassVastInterference\(\{ url: details\.url, topLevelUrl, authWindow \}\)/)
  assert.match(sessionsSource, /const topLevelUrl = requestTopLevelUrl\(details\)/)
  assert.match(sessionsSource, /callback\(\{ requestHeaders: details\.requestHeaders \}\)/)
  assert.match(sessionsSource, /!bypassVastInterference && settings\.privacy\.adBlockerEnabled/)
  assert.match(sessionsSource, /configureTrackerBlocking/)
  assert.match(sessionsSource, /configureSpoofingForSession/)
})

test('sterile auth windows use native identity without preload, scripts, or CDP', () => {
  assert.match(sessionsSource, /AUTH_IDENTITY_PROFILE/)
  assert.match(sessionsSource, /contents\.setUserAgent\(authCompatibilityUserAgent\(\)\)/)
  assert.match(sessionsSource, /return nativeDefaultUserAgent \|\| cleanDefaultUserAgent/)
  assert.match(sessionsSource, /delete webPreferences\.preload/)
  assert.match(sessionsSource, /nodeIntegration: false/)
  assert.match(sessionsSource, /contextIsolation: true/)
  assert.match(sessionsSource, /sandbox: true/)
  assert.match(sessionsSource, /webSecurity: true/)
  assert.match(sessionsSource, /contents\.debugger\.detach\(\)/)
  assert.doesNotMatch(sessionsSource, /OAUTH_POPUP_PROBE_SCRIPT/)
  assert.doesNotMatch(browserStageSource, /OAUTH_BLOCKED_PAGE_PROBE_SCRIPT/)
  assert.doesNotMatch(browserStageSource, /embedded-oauth-blocked-page/)
})

test('Google navigation uses an in-app top-level handoff and redacted diagnostics', () => {
  assert.match(sessionsSource, /direct Google auth window requested/)
  assert.match(sessionsSource, /directNavigation: true/)
  assert.match(sessionsSource, /google-auth\.log/)
  assert.match(sessionsSource, /redactedUrlForLog/)
  assert.doesNotMatch(sessionsSource, /google-embedded-oauth-not-supported/)
})

test('email-only provider check is test-profile gated and uses input events without DOM or CDP', () => {
  assert.doesNotMatch(sessionsSource, /VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK|VAST_GOOGLE_AUTH_TEST_EMAIL|sendEmailInput/)
  assert.match(viteConfigSource, /VAST_INCLUDE_INTERNAL_TEST_HARNESS/)
  assert.match(mainSource, /__VAST_INCLUDE_INTERNAL_TEST_HARNESS__/)
  assert.match(mainSource, /import\('\.\/google-auth-test-harness'\)/)
  assert.match(harnessSource, /VAST_INTERNAL_GOOGLE_AUTH_EMAIL_CHECK/)
  assert.match(harnessSource, /VAST_TEST_USER_DATA_DIR/)
  assert.match(harnessSource, /sendInputEvent\(\{ type: 'char'/)
  assert.match(harnessSource, /export function startInternalGoogleAuthEmailCheck/)
  assert.doesNotMatch(harnessSource, /executeJavaScript|debugger/)
})
