import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const guestPreloadSource = readFileSync(new URL('../../src/preload/guest-autofill.ts', import.meta.url), 'utf8')
const parserSource = readFileSync(new URL('../../src/preload/credential-form-parser.ts', import.meta.url), 'utf8')
const modelSource = readFileSync(new URL('../../src/shared/credential-form-model.ts', import.meta.url), 'utf8')

test('guest autofill uses the shared semantic form parser for email-first and password forms', () => {
  assert.match(guestPreloadSource, /isAutofillCredentialInput/)
  assert.match(guestPreloadSource, /autofillUsernameInput/)
  assert.match(parserSource, /classifyCredentialField/)
  assert.match(parserSource, /querySelectorAll<HTMLInputElement>\('input'\)/)
  assert.match(modelSource, /autocompleteTokens/)
  assert.match(modelSource, /usernameMetadata/)
  assert.match(modelSource, /current-password/)
})
