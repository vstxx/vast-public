import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL } from '../../src/shared/constants.ts'
import {
  blockedTopLevelNavigationReplacement,
  isAllowedChromeExtensionSubframeRedirect,
  isChromeWebStoreUrl,
  routeTopLevelNavigationUrl,
  sanitizeRestoredTopLevelUrl
} from '../../src/shared/top-level-navigation-policy.ts'

const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')

test('direct and redirected Chrome Web Store top-level URLs route to the Vast unsupported page', () => {
  for (const url of [
    'https://chromewebstore.google.com/',
    'https://chromewebstore.google.com/detail/example/abcdefghijklmnopabcdefghijklmnop',
    'https://chrome.google.com/webstore/',
    'https://chrome.google.com/webstore/detail/example'
  ]) {
    assert.equal(isChromeWebStoreUrl(url), true)
    assert.equal(blockedTopLevelNavigationReplacement(url), INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL)
    assert.equal(routeTopLevelNavigationUrl(url), INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL)
  }
  assert.equal(isChromeWebStoreUrl('https://chrome.google.com/'), false)
  assert.equal(isChromeWebStoreUrl('http://chromewebstore.google.com/'), false)
  assert.equal(isChromeWebStoreUrl('https://chromewebstore.google.com.evil.test/'), false)
})

test('restored blocked and unsafe tabs are sanitized before a webview can be created', () => {
  assert.equal(sanitizeRestoredTopLevelUrl('https://chromewebstore.google.com/detail/example'), INTERNAL_UNSUPPORTED_EXTENSION_STORE_URL)
  assert.equal(sanitizeRestoredTopLevelUrl('javascript:alert(1)'), 'vast://newtab')
  assert.equal(sanitizeRestoredTopLevelUrl('https://example.test/path'), 'https://example.test/path')
})

test('only chrome-extension redirects inside subframes bypass the app top-level guard', () => {
  assert.equal(isAllowedChromeExtensionSubframeRedirect(
    'chrome-extension://e2c63369-d00d-4154-9ab4-966320dc1458/overlay/menu.html',
    false
  ), true)
  assert.equal(isAllowedChromeExtensionSubframeRedirect(
    'chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html',
    false
  ), true)
  assert.equal(isAllowedChromeExtensionSubframeRedirect(
    'chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html',
    true
  ), false)
  assert.equal(isAllowedChromeExtensionSubframeRedirect('vast-extension://example/popup.html', false), false)
  assert.equal(isAllowedChromeExtensionSubframeRedirect('file:///example.html', false), false)
  assert.equal(isAllowedChromeExtensionSubframeRedirect('not a url', false), false)
})

test('the existing session policy covers requests, redirects, popups, and navigation events', () => {
  assert.match(sessionsSource, /webRequest\.onBeforeRequest[\s\S]*resourceType === 'mainFrame'[\s\S]*blockedTopLevelNavigationReplacement/)
  assert.match(sessionsSource, /setWindowOpenHandler[\s\S]*replaceBlockedTopLevelNavigation\(contents, url\)/)
  assert.match(sessionsSource, /contents\.on\('will-navigate', guardWebNavigation\)/)
  assert.match(sessionsSource, /contents\.on\('will-redirect', guardWebNavigation\)/)
  assert.match(sessionsSource, /guardWebNavigation[\s\S]*replaceBlockedTopLevelNavigation\(contents, url\)/)
})
