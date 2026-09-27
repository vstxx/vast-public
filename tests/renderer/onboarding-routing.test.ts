import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA, INTERNAL_ONBOARDING_URL } from '../../src/shared/constants.ts'
import { displayUrl, isKnownInternalUrl, matchesInternalUrl, resolveAddressInput, titleFromUrl } from '../../src/renderer/lib/url.ts'

test('vast://onboarding is a recognized internal page', () => {
  assert.equal(INTERNAL_ONBOARDING_URL, 'vast://onboarding')
  assert.equal(isKnownInternalUrl('vast://onboarding'), true)
  assert.equal(matchesInternalUrl('vast://onboarding', INTERNAL_ONBOARDING_URL), true)
  assert.equal(displayUrl('vast://onboarding'), 'Onboarding')
  assert.equal(titleFromUrl('vast://onboarding'), 'Onboarding')
  assert.equal(resolveAddressInput('onboarding', 'google'), 'vast://onboarding')
  assert.equal(resolveAddressInput('vast://onboarding', 'google'), 'vast://onboarding')
})

test('a fresh DEFAULT_DATA ships onboarding incomplete; existing profiles migrate complete', () => {
  assert.deepEqual(DEFAULT_DATA.onboarding, { completed: false })
})
