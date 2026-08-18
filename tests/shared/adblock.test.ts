import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCosmeticAdBlockScript, isAdRequestUrl, isStrictAdNavigationUrl, isTrackerUrl } from '../../src/shared/adblock.ts'

test('standard ad blocker leaves main-frame navigations alone', () => {
  assert.equal(isAdRequestUrl('https://ads.example.com/banner.js', 'mainFrame', 'standard'), false)
})

test('standard ad blocker blocks common ad subresources', () => {
  assert.equal(isAdRequestUrl('https://cdn.example.com/pagead/show.js', 'script', 'standard'), true)
  assert.equal(isAdRequestUrl('https://googleads.g.doubleclick.net/pagead/id', 'image', 'standard'), true)
})

test('strict ad blocker blocks known ad redirect navigations', () => {
  assert.equal(isAdRequestUrl('https://popads.net/redirect?zoneid=123', 'mainFrame', 'strict'), true)
  assert.equal(isStrictAdNavigationUrl('https://go.exoclick.com/click?clickid=abc'), true)
})

test('strict ad blocker keeps ordinary hyperlinks navigable', () => {
  assert.equal(isAdRequestUrl('https://example.com/watch/interesting-video', 'mainFrame', 'strict'), false)
  assert.equal(isStrictAdNavigationUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=vast'), false)
})

test('tracker matcher recognizes known tracker hosts only', () => {
  assert.equal(isTrackerUrl('https://www.google-analytics.com/collect?v=1'), true)
  assert.equal(isTrackerUrl('https://mail.google.com/mail/u/0/#inbox'), false)
})

test('cosmetic ad blocker does nothing when disabled except remove its own style', () => {
  const script = buildCosmeticAdBlockScript(false, 'standard')
  assert.match(script, /existing\?\.remove\(\)/)
  assert.doesNotMatch(script, /ytp-ad-module/)
})

test('standard cosmetic ad blocker includes YouTube and common portal ad slots', () => {
  const script = buildCosmeticAdBlockScript(true, 'standard')
  assert.match(script, /ytp-ad-module/)
  assert.match(script, /ytd-display-ad-renderer/)
  assert.match(script, /adsbygoogle/)
  assert.match(script, /adocean\.pl/)
})

test('strict cosmetic ad blocker includes broader sponsored and ad iframe selectors', () => {
  const script = buildCosmeticAdBlockScript(true, 'strict')
  assert.match(script, /\[class\*=\\"sponsor\\"\]/)
  assert.match(script, /iframe\[src\*=\\"pop\\"\]/)
})
