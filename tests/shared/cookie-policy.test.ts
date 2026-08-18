import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldBlockThirdPartyCookieHeaders } from '../../src/shared/cookie-policy.ts'

const protectedContext = {
  enabled: true,
  exceptions: [] as string[]
}

test('top-level redirects keep request and response cookies across site boundaries', () => {
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    requestUrl: 'https://auth.openai.com/log-in',
    topLevelUrl: 'https://chatgpt.com/',
    resourceType: 'mainFrame'
  }), false)
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    requestUrl: 'https://chatgpt.com/auth/callback?code=test&state=test',
    topLevelUrl: 'https://auth.openai.com/log-in',
    resourceType: 'mainFrame'
  }), false)
})

test('recognized authentication pages keep cookies for their bounded subrequest chain', () => {
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    requestUrl: 'https://static.example.test/session/bootstrap',
    topLevelUrl: 'https://auth.openai.com/log-in',
    resourceType: 'xhr'
  }), false)
})

test('ordinary third-party cookie headers remain blocked', () => {
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    requestUrl: 'https://tracker.example.net/pixel',
    topLevelUrl: 'https://news.example.com/article',
    resourceType: 'image'
  }), true)
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    requestUrl: 'https://cdn.example.com/app.js',
    topLevelUrl: 'https://news.example.com/article',
    resourceType: 'script'
  }), false)
})

test('cookie exceptions work for either the top-level site or embedded provider', () => {
  assert.equal(shouldBlockThirdPartyCookieHeaders({
    ...protectedContext,
    exceptions: ['accounts.example.net'],
    requestUrl: 'https://accounts.example.net/session',
    topLevelUrl: 'https://app.example.com/',
    resourceType: 'xhr'
  }), false)
})
