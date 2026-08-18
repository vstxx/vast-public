import { strict as assert } from 'node:assert'
import test from 'node:test'

import { routeWebviewWindowOpen, shouldOpenWebviewPopupAsWindow } from '../../src/shared/window-open-policy.ts'

test('webview OAuth popups can start at about:blank before navigating to Google', () => {
  assert.equal(shouldOpenWebviewPopupAsWindow({ url: 'about:blank', disposition: 'new-window' }), true)
})

test('webview Google auth popups stay as real windows even when Chromium reports a tab disposition', () => {
  assert.equal(
    shouldOpenWebviewPopupAsWindow({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      disposition: 'foreground-tab'
    }),
    true
  )
})

test('webview Apple auth popups stay as real windows even when Chromium reports a tab disposition', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://appleid.apple.com/auth/authorize?client_id=test',
      disposition: 'foreground-tab'
    }),
    'popup-window'
  )
})

test('webview Microsoft auth popups stay as real windows even when Chromium reports a tab disposition', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test',
      disposition: 'foreground-tab'
    }),
    'popup-window'
  )
})

test('GitHub, Auth0, Okta, Spotify, and Discord OAuth stay as real popup windows', () => {
  for (const url of [
    'https://github.com/login/oauth/authorize?client_id=test',
    'https://tenant.auth0.com/authorize?client_id=test',
    'https://tenant.okta.com/oauth2/v1/authorize?client_id=test',
    'https://accounts.spotify.com/authorize?client_id=test',
    'https://discord.com/oauth2/authorize?client_id=test'
  ]) {
    assert.equal(routeWebviewWindowOpen({ url, disposition: 'new-window' }), 'popup-window', url)
  }
})

test('webview OAuth popups can start at the app auth endpoint before redirecting to Google', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/auth/google',
      disposition: 'default'
    }),
    'popup-window'
  )
})

test('webview first-party auth URLs stay as real popups even when Chromium reports a tab disposition', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://www.airbnb.com/login/oauth_connect?client_id=airbnb&provider=google',
      disposition: 'foreground-tab'
    }),
    'popup-window'
  )
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://www.airbnb.com/oauth2/authorize?client_id=airbnb',
      disposition: 'background-tab'
    }),
    'popup-window'
  )
})

test('regular foreground tab links still route into Vast tabs', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/docs',
      disposition: 'foreground-tab'
    }),
    'vast-tab'
  )
})

test('target blank, script-opened links, ctrl-click, and middle-click route to Vast tabs', () => {
  for (const disposition of ['new-window', 'foreground-tab', 'background-tab', 'default']) {
    assert.equal(routeWebviewWindowOpen({ url: 'https://example.com/article', disposition }), 'vast-tab')
  }
})

test('popup geometry and payment flows retain real popup semantics', () => {
  assert.equal(
    routeWebviewWindowOpen({ url: 'https://example.com/tool', disposition: 'foreground-tab', features: 'width=500,height=700' }),
    'popup-window'
  )
  assert.equal(
    routeWebviewWindowOpen({ url: 'https://checkout.stripe.com/c/pay/test', disposition: 'foreground-tab' }),
    'popup-window'
  )
  assert.equal(
    routeWebviewWindowOpen({ url: 'https://www.paypal.com/checkoutnow?token=test', disposition: 'background-tab' }),
    'popup-window'
  )
})

test('regular script-opened new windows become Vast tabs when ad blocking is off or soft', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/listing',
      disposition: 'new-window',
      adBlockerEnabled: false
    }),
    'vast-tab'
  )
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/dashboard',
      disposition: 'new-window',
      adBlockerEnabled: true,
      adBlockerMode: 'standard'
    }),
    'vast-tab'
  )
})

test('webview popup policy still blocks unsafe protocols', () => {
  assert.equal(shouldOpenWebviewPopupAsWindow({ url: 'javascript:alert(1)', disposition: 'new-window' }), false)
  assert.equal(routeWebviewWindowOpen({ url: 'file:///C:/Windows/System32/calc.exe', disposition: 'new-window' }), 'deny')
})

test('disabled ad blocker preserves blank popup semantics and routes safe URLs to tabs', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'about:blank',
      disposition: 'background-tab',
      adBlockerEnabled: false
    }),
    'popup-window'
  )
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://ads.example.test/popup',
      disposition: 'new-window',
      adBlockerEnabled: false
    }),
    'vast-tab'
  )
})

test('soft ad blocker routes redirect-style safe URLs into Vast tabs', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://popads.net/redirect?zoneid=123',
      disposition: 'new-window',
      adBlockerEnabled: true,
      adBlockerMode: 'standard'
    }),
    'vast-tab'
  )
})

test('brutal ad blocker keeps the routing boundary functional while session policy blocks known ad URLs', () => {
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/pop',
      disposition: 'new-window',
      adBlockerEnabled: true,
      adBlockerMode: 'strict'
    }),
    'vast-tab'
  )
  assert.equal(
    routeWebviewWindowOpen({
      url: 'https://example.com/article',
      disposition: 'foreground-tab',
      adBlockerEnabled: true,
      adBlockerMode: 'strict'
    }),
    'vast-tab'
  )
})
