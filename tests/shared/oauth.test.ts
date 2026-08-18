import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDefaultChromiumIdentity,
  buildDefaultChromiumRequestHeaders,
  isLikelyOAuthBlockedText,
  redactOAuthUrl
} from '../../src/shared/oauth.ts'

test('redacts OAuth credentials while preserving debuggable URL shape', () => {
  const redacted = redactOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&code=secret&id_token=jwt&state=stateful#access_token=token&scope=email')
  assert.equal(redacted, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=[present]&code=[redacted]&id_token=[redacted]&state=[redacted]#access_token=[redacted]&scope=[present]')

  const identityRedacted = redactOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?login_hint=user%40example.test&email=user%40example.test&identifier=123')
  assert.equal(identityRedacted, 'https://accounts.google.com/o/oauth2/v2/auth?login_hint=[redacted]&email=[redacted]&identifier=[redacted]')
})

test('default Chromium identity removes Electron from classic UA and client hints', () => {
  const identity = buildDefaultChromiumIdentity({
    chromeVersion: '142.0.7444.52',
    platform: 'win32'
  })
  assert.match(identity.userAgent, /Chrome\/142\.0\.7444\.52/)
  assert.doesNotMatch(identity.userAgent, /Electron/i)
  assert.equal(identity.secChUaPlatform, 'Windows')

  const headers = buildDefaultChromiumRequestHeaders(identity, {
    'User-Agent': 'Mozilla/5.0 Electron/42.2.0',
    'Sec-CH-UA': '"Electron";v="42"',
    'Sec-CH-UA-Full-Version-List': '"Electron";v="42.2.0"'
  })
  assert.doesNotMatch(String(headers['User-Agent']), /Electron/i)
  assert.doesNotMatch(String(headers['Sec-CH-UA']), /Electron/i)
  assert.doesNotMatch(String(headers['Sec-CH-UA-Full-Version-List']), /Electron/i)
})

test('OAuth blocked page detection catches common provider messages', () => {
  assert.equal(isLikelyOAuthBlockedText('Error 403: disallowed_useragent'), true)
  assert.equal(isLikelyOAuthBlockedText('This browser or app may not be secure'), true)
  assert.equal(isLikelyOAuthBlockedText('Welcome back to your account'), false)
})
