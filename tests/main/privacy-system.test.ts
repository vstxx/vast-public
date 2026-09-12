import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessions = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const guestPreload = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')
const stage = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurface = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const browserRuntime = `${stage}\n${webviewSurface}`
const cookiePolicy = readFileSync(new URL('../../src/shared/cookie-policy.ts', import.meta.url), 'utf8')

test('native ad lists are gone while tracker protection and extension networking remain', () => {
  assert.match(sessions, /extensionNetworkDecision/)
  assert.match(sessions, /isTrackerUrl/)
  assert.doesNotMatch(sessions, /matchPrivacyFilter|isAdRequestUrl|isStrictAdNavigationUrl/)
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
  assert.doesNotMatch(preload, /filterStatus:/)
  assert.doesNotMatch(preload, /updateFilters:/)
  assert.match(preload, /configureIdentity:/)
  assert.match(sessions, /setWebRTCIPHandlingPolicy/)
  assert.match(sessions, /session\.setProxy/)
})

test('spoofing is installed in the page main world at document start and settings changes reload guests', () => {
  assert.match(guestPreload, /sendSync\('vast:spoofing:document-config'/)
  assert.match(guestPreload, /contextBridge\.executeInMainWorld/)
  assert.match(sessions, /spoofingDocumentConfigForWebContents/)
  for (const command of ['Emulation.setUserAgentOverride', 'Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride', 'Emulation.setHardwareConcurrencyOverride']) {
    assert.match(sessions, new RegExp(command.replaceAll('.', '\\.')))
  }
  assert.match(sessions, /reloadDocuments && contents\.getType\(\) === 'webview'/)
  assert.doesNotMatch(webviewSurface, /buildSpoofingInjectionScript|effectiveSpoofingSettings/)
})

test('context menu exposes clean-link preview and one-tab identity routing', () => {
  assert.match(browserRuntime, /label: 'Copy clean link'/)
  assert.match(browserRuntime, /Removed:.*removedParameters/)
  assert.match(browserRuntime, /identityWorkspaceId: workspace\.id/)
})
