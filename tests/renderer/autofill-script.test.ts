import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')

test('guest preload detects email-first sign-in forms and password fields', () => {
  assert.match(guestPreloadSource, /type === 'password' \|\| type === 'email'/)
  assert.match(guestPreloadSource, /autocomplete/)
  assert.match(guestPreloadSource, /email\|e-mail\|username\|login\|user\|account\|phone/)
  assert.match(guestPreloadSource, /querySelectorAll<HTMLInputElement>\('input'\)/)
})
