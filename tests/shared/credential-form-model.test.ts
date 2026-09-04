import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autocompleteTokens,
  classifyCredentialField,
  parseCredentialFields,
  type CredentialFieldFacts
} from '../../src/shared/credential-form-model.ts'

function field(id: string, patch: Partial<CredentialFieldFacts> = {}): CredentialFieldFacts {
  return {
    id,
    type: 'text',
    autocomplete: '',
    value: '',
    visible: true,
    disabled: false,
    readOnly: false,
    order: 0,
    userEdited: false,
    ...patch
  }
}

test('autocomplete is parsed as tokens including sectioned and WebAuthn forms', () => {
  assert.deepEqual(autocompleteTokens(' section-login   username webauthn '), ['username'])
  assert.deepEqual(autocompleteTokens('section-account current-password'), ['current-password'])
  assert.deepEqual(autocompleteTokens('billing one-time-code'), ['one-time-code'])
})

test('semantic field classification rejects OTP, PIN, CVC, honeypots, readonly and unrelated text', () => {
  assert.equal(classifyCredentialField(field('otp', { type: 'password', name: 'otp', value: '123456', userEdited: true })).role, 'one-time-code')
  assert.equal(classifyCredentialField(field('cvc', { type: 'password', ariaLabel: 'Card CVV', value: '123', maxLength: 3, userEdited: true })).role, 'one-time-code')
  assert.equal(classifyCredentialField(field('csc', { type: 'password', autocomplete: 'cc-csc', value: '123', userEdited: true })).role, 'one-time-code')
  assert.equal(classifyCredentialField(field('pin', { type: 'tel', autocomplete: 'one-time-code', value: '1234', userEdited: true })).role, 'one-time-code')
  assert.equal(classifyCredentialField(field('honeypot', { type: 'password', visible: false, value: 'trap', userEdited: true })).role, 'unrelated')
  assert.equal(classifyCredentialField(field('readonly', { type: 'password', readOnly: true, value: 'secret', userEdited: true })).role, 'unrelated')
  assert.equal(classifyCredentialField(field('search', { type: 'search', value: 'query', userEdited: true })).role, 'unrelated')
  assert.equal(classifyCredentialField(field('nearby', { type: 'text', value: 'not-a-user', userEdited: true })).role, 'unrelated')
})

test('a page-owned password value is never considered a user submission', () => {
  const parsed = parseCredentialFields([
    field('email', { type: 'email', autocomplete: 'username', value: 'page@example.com', order: 0 }),
    field('password', { type: 'password', autocomplete: 'current-password', value: 'page-secret', order: 1 })
  ])
  assert.equal(parsed.kind, 'login')
  assert.equal(parsed.valid, false)
  assert.equal(parsed.reason, 'password-not-edited')
})

test('three generic password fields infer current, new and matching confirmation conservatively', () => {
  const parsed = parseCredentialFields([
    field('current', { type: 'password', value: 'old', userEdited: true, order: 0 }),
    field('next', { type: 'password', value: 'new', userEdited: true, order: 1 }),
    field('confirm', { type: 'password', value: 'new', userEdited: true, order: 2 })
  ])
  assert.equal(parsed.kind, 'change-password')
  assert.equal(parsed.valid, true)
  assert.equal(parsed.currentPassword?.field.id, 'current')
  assert.equal(parsed.newPassword?.field.id, 'next')
  assert.equal(parsed.confirmationPassword?.field.id, 'confirm')
})

test('semantic scoring prefers an explicit username over nearby text noise', () => {
  const parsed = parseCredentialFields([
    field('nickname', { type: 'text', name: 'display-name', value: 'noise', userEdited: true, order: 0 }),
    field('account', { type: 'text', autocomplete: 'section-auth username webauthn', value: 'alice', userEdited: true, order: 1 }),
    field('password', { type: 'password', autocomplete: 'current-password', value: 'secret', userEdited: true, order: 2 })
  ])
  assert.equal(parsed.username?.field.id, 'account')
  assert.equal(parsed.valid, true)
})

test('traditional login chooses a semantic username and an edited password', () => {
  const parsed = parseCredentialFields([
    field('search', { type: 'text', name: 'search', value: 'noise', order: 0, userEdited: true }),
    field('email', { type: 'email', autocomplete: 'section-login username', value: 'a@example.com', order: 1, userEdited: true }),
    field('password', { type: 'password', autocomplete: 'current-password', value: 'secret', order: 2, userEdited: true })
  ])
  assert.equal(parsed.kind, 'login')
  assert.equal(parsed.valid, true)
  assert.equal(parsed.username?.field.id, 'email')
  assert.equal(parsed.password?.field.id, 'password')
})

test('password-only login remains valid for username-first correlation', () => {
  const parsed = parseCredentialFields([
    field('password', { type: 'password', autocomplete: 'current-password', value: 'secret', userEdited: true })
  ])
  assert.equal(parsed.kind, 'login')
  assert.equal(parsed.valid, true)
  assert.equal(parsed.username, undefined)
})

test('username-first forms require an actually edited semantic username', () => {
  const edited = parseCredentialFields([
    field('email', { type: 'email', autocomplete: 'username', value: 'a@example.com', userEdited: true })
  ])
  const pageOwned = parseCredentialFields([
    field('email', { type: 'email', autocomplete: 'username', value: 'page@example.com', userEdited: false })
  ])
  assert.equal(edited.kind, 'username-first')
  assert.equal(edited.valid, true)
  assert.equal(pageOwned.kind, 'none')
  assert.equal(pageOwned.valid, false)
})

test('signup recognizes one new password and matching confirmation', () => {
  const single = parseCredentialFields([
    field('email', { type: 'email', autocomplete: 'username', value: 'new@example.com', userEdited: true, order: 0 }),
    field('new', { type: 'password', autocomplete: 'new-password', value: 'new-secret', userEdited: true, order: 1 })
  ])
  const confirmed = parseCredentialFields([
    field('email', { type: 'email', value: 'new@example.com', userEdited: true, order: 0 }),
    field('new', { type: 'password', autocomplete: 'new-password', value: 'new-secret', userEdited: true, order: 1 }),
    field('confirm', { type: 'password', autocomplete: 'new-password', value: 'new-secret', userEdited: true, order: 2 })
  ])
  assert.equal(single.kind, 'signup')
  assert.equal(single.valid, true)
  assert.equal(confirmed.kind, 'signup')
  assert.equal(confirmed.valid, true)
  assert.equal(confirmed.confirmationPassword?.field.id, 'confirm')
})

test('signup and password change reject mismatching confirmations', () => {
  for (const current of [false, true]) {
    const fields = [
      ...(current ? [field('current', { type: 'password', autocomplete: 'current-password', value: 'old', userEdited: true, order: 0 })] : []),
      field('new', { type: 'password', autocomplete: 'new-password', value: 'new-a', userEdited: true, order: 1 }),
      field('confirm', { type: 'password', autocomplete: 'new-password', value: 'new-b', userEdited: true, order: 2 })
    ]
    const parsed = parseCredentialFields(fields)
    assert.equal(parsed.valid, false)
    assert.equal(parsed.reason, 'confirmation-mismatch')
  }
})

test('change-password forms keep current and new credentials distinct', () => {
  const parsed = parseCredentialFields([
    field('current', { type: 'password', autocomplete: 'current-password', value: 'old', userEdited: true, order: 0 }),
    field('new', { type: 'password', autocomplete: 'new-password', value: 'new', userEdited: true, order: 1 }),
    field('confirm', { type: 'password', autocomplete: 'new-password', value: 'new', userEdited: true, order: 2 })
  ])
  assert.equal(parsed.kind, 'change-password')
  assert.equal(parsed.valid, true)
  assert.equal(parsed.currentPassword?.field.value, 'old')
  assert.equal(parsed.newPassword?.field.value, 'new')
})

test('ambiguous multiple generic password fields are not captured', () => {
  const parsed = parseCredentialFields([
    field('one', { type: 'password', value: 'one', userEdited: true, order: 0 }),
    field('two', { type: 'password', value: 'different', userEdited: true, order: 1 })
  ])
  assert.equal(parsed.kind, 'none')
  assert.equal(parsed.valid, false)
  assert.equal(parsed.reason, 'ambiguous-passwords')
})
