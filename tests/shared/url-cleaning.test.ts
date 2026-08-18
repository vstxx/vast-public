import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanTrackingUrl, isThirdPartyUrl, siteDomain } from '../../src/shared/url-cleaning.ts'

test('tracking parameters are removed while useful parameters and fragments survive', () => {
  const result = cleanTrackingUrl('https://shop.example/item?id=42&utm_source=newsletter&fbclid=abc#details')
  assert.equal(result.url, 'https://shop.example/item?id=42#details')
  assert.deepEqual(result.removedParameters, ['utm_source', 'fbclid'])
})

test('affiliate parameters are opt-in', () => {
  assert.equal(cleanTrackingUrl('https://example.com/?ref=friend&id=1').changed, false)
  assert.equal(cleanTrackingUrl('https://example.com/?ref=friend&id=1', true).url, 'https://example.com/?id=1')
})

test('Instagram, TikTok, X and ad click identifiers are cleaned', () => {
  const result = cleanTrackingUrl('https://example.com/?igshid=a&ttclid=b&twclid=c&gclid=d&msclkid=e')
  assert.deepEqual(result.removedParameters, ['igshid', 'ttclid', 'twclid', 'gclid', 'msclkid'])
})

test('same-site subdomains are distinguished from third-party requests', () => {
  assert.equal(siteDomain('https://a.school.example.co.uk/path'), 'example.co.uk')
  assert.equal(isThirdPartyUrl('https://cdn.example.co.uk/app.js', 'https://www.example.co.uk/'), false)
  assert.equal(isThirdPartyUrl('https://tracker.invalid/pixel', 'https://www.example.co.uk/'), true)
})
