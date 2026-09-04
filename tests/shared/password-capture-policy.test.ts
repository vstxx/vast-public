import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automaticPasswordCaptureOrigin,
  sanitizeCredentialDocumentState,
  sanitizeCredentialEvidenceReport,
  sanitizeCredentialSubmissionCandidate,
  sanitizeCredentialUsernameObservation
} from '../../src/shared/password-capture-policy.ts'
import { canonicalCredentialUsername } from '../../src/shared/credential-matching.ts'

test('automatic password capture is limited to secure pages and local test origins', () => {
  assert.equal(automaticPasswordCaptureOrigin('https://example.com/login?next=%2Fapp'), 'https://example.com')
  assert.equal(automaticPasswordCaptureOrigin('http://127.0.0.1:4321/login'), 'http://127.0.0.1:4321')
  assert.equal(automaticPasswordCaptureOrigin('http://example.com/login'), undefined)
  assert.equal(automaticPasswordCaptureOrigin('vast://passwords'), undefined)
})

test('Google identity pages remain outside automatic password capture', () => {
  assert.equal(automaticPasswordCaptureOrigin('https://accounts.google.com/v3/signin/identifier'), undefined)
  assert.equal(automaticPasswordCaptureOrigin('https://calendar.google.com/'), 'https://calendar.google.com')
})

test('credential attempt payloads are normalized and bounded', () => {
  const result = sanitizeCredentialSubmissionCandidate({
    attemptId: 'c'.repeat(32),
    origin: 'https://example.com',
    submissionUrl: 'https://example.com/login',
    kind: 'login',
    username: '  User@Example.com  ',
    password: 'secret',
    title: '  Example  ',
    submittedAt: Date.now()
  })
  assert.equal(result.username, 'User@Example.com')
  assert.equal(result.title, 'Example')
  assert.equal(canonicalCredentialUsername(' User@Example.COM '), 'user@example.com')
  assert.throws(() => sanitizeCredentialSubmissionCandidate({
    attemptId: 'd'.repeat(32), origin: 'https://example.com', submissionUrl: 'https://example.com/login',
    kind: 'login', username: '', password: '', submittedAt: Date.now()
  }))
})

test('stateful capture payloads are attempt-bound, origin-bound and time-bounded', () => {
  const now = Date.now()
  const attemptId = 'a'.repeat(32)
  assert.equal(sanitizeCredentialSubmissionCandidate({
    attemptId,
    origin: 'https://example.com',
    submissionUrl: 'https://example.com/login',
    kind: 'login',
    username: 'alice',
    password: 'secret',
    submittedAt: now
  }).attemptId, attemptId)
  assert.equal(sanitizeCredentialEvidenceReport({
    attemptId,
    origin: 'https://example.com',
    url: 'https://example.com/login',
    kind: 'validation-error',
    observedAt: now
  }).kind, 'validation-error')
  assert.equal(sanitizeCredentialDocumentState({
    origin: 'https://example.com',
    url: 'https://example.com/home',
    hasLoginFields: false,
    hasPasswordFields: false,
    observedAt: now
  }).hasPasswordFields, false)
  assert.equal(sanitizeCredentialUsernameObservation({
    origin: 'https://example.com', username: 'alice', observedAt: now, userEntered: true
  }).username, 'alice')
  assert.throws(() => sanitizeCredentialSubmissionCandidate({
    attemptId,
    origin: 'https://example.com',
    submissionUrl: 'https://evil.example/login',
    kind: 'login',
    username: 'alice',
    password: 'secret',
    submittedAt: now
  }))
  assert.throws(() => sanitizeCredentialEvidenceReport({
    attemptId,
    origin: 'https://example.com',
    url: 'https://example.com/login',
    kind: 'invented-signal',
    observedAt: now
  }))
  assert.throws(() => sanitizeCredentialUsernameObservation({
    origin: 'https://example.com', username: 'alice', observedAt: now, userEntered: false
  }))
  assert.throws(() => sanitizeCredentialDocumentState({
    origin: 'https://example.com', url: 'https://other.example/home',
    hasLoginFields: false, hasPasswordFields: false, observedAt: now
  }))
  assert.throws(() => sanitizeCredentialEvidenceReport({
    attemptId,
    origin: 'https://example.com',
    url: 'https://example.com/login',
    kind: 'validation-error',
    observedAt: now - 3 * 60_000
  }))
})

test('password changes require a bounded current password and secure origin', () => {
  const base = {
    attemptId: 'b'.repeat(32),
    origin: 'https://example.com',
    submissionUrl: 'https://example.com/change',
    kind: 'change-password',
    username: '',
    password: 'new',
    submittedAt: Date.now()
  }
  assert.throws(() => sanitizeCredentialSubmissionCandidate(base))
  assert.equal(sanitizeCredentialSubmissionCandidate({ ...base, currentPassword: 'old' }).currentPassword, 'old')
  assert.throws(() => sanitizeCredentialSubmissionCandidate({ ...base, origin: 'http://example.com', submissionUrl: 'http://example.com/change', currentPassword: 'old' }))
})
