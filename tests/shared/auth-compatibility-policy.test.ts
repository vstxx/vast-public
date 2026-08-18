import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTH_COMPATIBILITY_MODEL,
  AUTH_IDENTITY_PROFILE,
  isAuthSensitiveUrl,
  isGoogleIdentityProviderUrl,
  isOAuthCallbackUrl,
  shouldBypassVastInterference
} from '../../src/shared/auth-compatibility-policy.ts'

test('Google auth classification is narrow and rejects suffix tricks', () => {
  assert.equal(isGoogleIdentityProviderUrl('https://accounts.google.com/ServiceLogin'), true)
  assert.equal(isGoogleIdentityProviderUrl('https://oauth2.googleapis.com/token'), true)
  assert.equal(isGoogleIdentityProviderUrl('https://accounts.googleusercontent.com/o/oauth2/auth'), true)
  assert.equal(isGoogleIdentityProviderUrl('https://accounts.google.com.evil.test/login'), false)
  assert.equal(isGoogleIdentityProviderUrl('https://calendar.google.com/'), false)
  assert.equal(isGoogleIdentityProviderUrl('javascript:https://accounts.google.com'), false)
})

test('auth-sensitive policy recognizes provider, first-party, and callback URLs', () => {
  assert.equal(isAuthSensitiveUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=test'), true)
  assert.equal(isAuthSensitiveUrl('https://app.example.test/auth/google'), true)
  assert.equal(isAuthSensitiveUrl('https://app.example.test/oauth/callback?code=secret&state=value'), true)
  assert.equal(isOAuthCallbackUrl('https://app.example.test/return?code=secret&state=value'), true)
  assert.equal(isAuthSensitiveUrl('https://example.test/docs'), false)
  assert.equal(isAuthSensitiveUrl('about:blank'), false)
  assert.equal(isAuthSensitiveUrl('https://auth.openai.com/log-in'), true)
  assert.equal(isAuthSensitiveUrl('https://auth0.openai.com/u/login'), true)
  assert.equal(isAuthSensitiveUrl('https://openai.com/research'), false)
})

test('registered auth windows bypass Vast interference for their entire redirect chain', () => {
  assert.equal(shouldBypassVastInterference({ url: 'https://example.test/callback', authWindow: true }), true)
  assert.equal(shouldBypassVastInterference({
    url: 'https://static.example.test/app.js',
    topLevelUrl: 'https://app.example.test/auth/login'
  }), true)
  assert.equal(shouldBypassVastInterference({ url: 'https://example.test/article', authWindow: false }), false)
  assert.equal(AUTH_COMPATIBILITY_MODEL, 'sterile-top-level-window')
  assert.equal(AUTH_IDENTITY_PROFILE, 'native-electron')
})
