import assert from 'node:assert/strict'
import test from 'node:test'

import { applyCredentialEvidence, expireCredentialAssessment, initialCredentialAssessment } from '../../src/shared/credential-capture-state.ts'

function evidence(...kinds: Parameters<typeof applyCredentialEvidence>[1][]) {
  return kinds.reduce(applyCredentialEvidence, initialCredentialAssessment())
}

test('a submit intent alone remains pending and expires as unknown', () => {
  const pending = initialCredentialAssessment()
  assert.equal(pending.state, 'pending')
  assert.equal(expireCredentialAssessment(pending).state, 'unknown')
})
test('traditional navigation needs corroborating document evidence before success', () => {
  assert.equal(evidence('navigation-away').state, 'pending')
  assert.equal(evidence('navigation-away', 'password-fields-disappeared').state, 'succeeded')
})

test('XHR form disappearance and SPA navigation are successful multi-signal outcomes', () => {
  assert.equal(evidence('form-disappeared', 'password-fields-disappeared').state, 'succeeded')
  assert.equal(evidence('spa-navigation-away', 'form-disappeared').state, 'succeeded')
})

test('validation, invalid events and a reappearing login form are failures', () => {
  assert.equal(evidence('validation-error').state, 'failed')
  assert.equal(evidence('invalid-event').state, 'failed')
  assert.equal(evidence('navigation-same-auth', 'login-form-reappeared').state, 'failed')
})

test('a focused, still-visible password form is treated as failure conservatively', () => {
  assert.equal(evidence('password-refocused').state, 'pending')
  assert.equal(evidence('password-refocused', 'form-still-visible').state, 'failed')
})

test('failure evidence can override tentative success during the settle window', () => {
  const tentative = evidence('form-disappeared', 'password-fields-disappeared')
  assert.equal(tentative.state, 'succeeded')
  assert.equal(applyCredentialEvidence(tentative, 'validation-error').state, 'failed')
})

test('duplicate evidence does not inflate confidence', () => {
  const first = evidence('form-disappeared')
  assert.deepEqual(applyCredentialEvidence(first, 'form-disappeared'), first)
})
