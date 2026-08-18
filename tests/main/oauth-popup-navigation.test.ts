import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')

test('OAuth popup BrowserWindows are tracked as trusted popup webContents', () => {
  assert.match(sessionsSource, /trustedOAuthPopupWebContents\s*=\s*new Set<number>/)
  assert.match(sessionsSource, /trustedOAuthPopupWebContents\.add\(popupContentsId\)/)
  assert.match(sessionsSource, /trustedOAuthPopupWebContents\.delete\(popupContentsId\)/)
})

test('trusted OAuth popups may navigate to safe auth URLs while app chrome remains guarded', () => {
  assert.match(sessionsSource, /trustedOAuthPopupWebContents\.has\(contents\.id\)/)
  assert.match(sessionsSource, /isSafeOAuthPopupNavigationUrl\(url\)/)
  assert.match(sessionsSource, /url === 'about:blank'/)
  assert.match(sessionsSource, /if \(window && contents === window\.webContents\)/)
  assert.match(sessionsSource, /isTrustedRendererUrl\(url,/)
  assert.match(sessionsSource, /protocol === 'file:' \|\| protocol === 'javascript:' \|\| protocol === 'data:' \|\| protocol === 'blob:' \|\| protocol === 'chrome:' \|\| protocol === 'devtools:'/)
})

test('Google OAuth is routed through the sterile top-level compatibility window', () => {
  assert.match(sessionsSource, /isGoogleIdentityProviderUrl\(url\)/)
  assert.match(sessionsSource, /createOAuthPopupWindow/)
  assert.match(sessionsSource, /directNavigation: true/)
  assert.doesNotMatch(sessionsSource, /google-embedded-oauth-not-supported/)
})
