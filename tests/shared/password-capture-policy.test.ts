import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automaticPasswordCaptureOrigin,
  classifyPasswordCapture,
  normalizedCredentialUsername,
  sanitizePasswordLoginCandidate
} from '../../src/shared/password-capture-policy.ts'

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

test('captured login payloads are normalized and bounded', () => {
  const result = sanitizePasswordLoginCandidate({
    origin: 'https://example.com',
    username: '  User@Example.com  ',
    password: 'secret',
    title: '  Example  '
  })
  assert.deepEqual(result, {
    origin: 'https://example.com',
    username: 'User@Example.com',
    password: 'secret',
    title: 'Example',
    favicon: undefined
  })
  assert.equal(normalizedCredentialUsername(' User@Example.COM '), 'user@example.com')
  assert.throws(() => sanitizePasswordLoginCandidate({ origin: 'https://example.com', username: '', password: '' }))
})

test('capture classification distinguishes save, update, unchanged, and suppressed flows', () => {
  assert.equal(classifyPasswordCapture({ suppressed: false, hasExistingCredential: false, passwordMatches: false }), 'save')
  assert.equal(classifyPasswordCapture({ suppressed: false, hasExistingCredential: true, passwordMatches: false }), 'update')
  assert.equal(classifyPasswordCapture({ suppressed: false, hasExistingCredential: true, passwordMatches: true }), 'unchanged')
  assert.equal(classifyPasswordCapture({ suppressed: true, hasExistingCredential: false, passwordMatches: false }), 'suppressed')
})
