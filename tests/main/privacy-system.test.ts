import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessions = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const filters = readFileSync(new URL('../../src/main/privacy-filter-lists.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const stage = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurface = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const browserRuntime = `${stage}\n${webviewSurface}`
const cookiePolicy = readFileSync(new URL('../../src/shared/cookie-policy.ts', import.meta.url), 'utf8')

test('request blocking uses maintained lists before requests are sent', () => {
  for (const marker of ['easylist.txt', 'easyprivacy.txt', 'pgl.yoyo.org', 'urlhaus-filter-domains-online.txt', 'PolishAnnoyanceFilters']) {
    assert.match(filters, new RegExp(marker.replaceAll('.', '\\.'), 'i'))
  }
  assert.match(sessions, /webRequest\.onBeforeRequest/)
  assert.match(sessions, /matchPrivacyFilter/)
  assert.match(filters, /filterAutoUpdate/)
  assert.match(filters, /blockedSinceStart/)
  assert.doesNotMatch(filters, /visitedUrls|history\.push|pageHistory/)
})

test('third-party cookies are stripped in both request and response directions', () => {
  assert.match(sessions, /webRequest\.onBeforeSendHeaders/)
  assert.match(sessions, /name\.toLowerCase\(\) === 'cookie'/)
  assert.match(sessions, /webRequest\.onHeadersReceived/)
  assert.match(sessions, /name\.toLowerCase\(\) === 'set-cookie'/)
  assert.match(sessions, /shouldBlockThirdPartyCookieHeaders/)
  assert.match(cookiePolicy, /resourceType === 'mainFrame'/)
  assert.match(cookiePolicy, /topLevelUrl: context\.topLevelUrl/)
})

test('privacy IPC is narrow and identity configuration is main-owned', () => {
  assert.match(preload, /filterStatus:/)
  assert.match(preload, /updateFilters:/)
  assert.match(preload, /configureIdentity:/)
  assert.match(sessions, /setWebRTCIPHandlingPolicy/)
  assert.match(sessions, /session\.setProxy/)
})

test('context menu exposes clean-link preview and one-tab identity routing', () => {
  assert.match(browserRuntime, /label: 'Copy clean link'/)
  assert.match(browserRuntime, /Removed:.*removedParameters/)
  assert.match(browserRuntime, /identityWorkspaceId: workspace\.id/)
})
