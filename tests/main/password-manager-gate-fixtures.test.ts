import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { FIXTURE_HOSTS } = require('../../scripts/password-manager-gate/config.cjs')
const {
  MAX_SUBMISSION_BYTES,
  fixtureUrl,
  routeFixtureRequest
} = require('../../scripts/password-manager-gate/fixtures.cjs')

const CANARY = 'VAST_GATE_SECRET_CANARY'
const expectedHashes = {
  username: createHash('sha256').update('fixture-user').digest('hex'),
  password: createHash('sha256').update('fixture-password').digest('hex')
}

function get(host: string, path: string) {
  return routeFixtureRequest({ host, method: 'GET', path, body: Buffer.alloc(0) }, expectedHashes, 4443)
}

test('router assigns each approved origin and route to the intended fixture', () => {
  assert.equal(get('login.vast-test.local', '/login').fixture, 'ordinary-login')
  assert.equal(get('login.vast-test.local', '/native-login').fixture, 'native-login')
  assert.equal(get('login.vast-test.local', '/signup').fixture, 'credential-signup')
  assert.equal(get('login.vast-test.local', '/change-password').fixture, 'credential-update')
  assert.equal(get('spa.vast-test.local', '/spa').fixture, 'spa-login')
  assert.equal(get('dynamic.vast-test.local', '/dynamic').fixture, 'dynamic-login')
  assert.equal(get('dynamic.vast-test.local', '/delayed').fixture, 'delayed-login')
  assert.equal(get('login.vast-test.local', '/same-origin-iframe').fixture, 'same-origin-iframe')
  assert.equal(get('login.vast-test.local', '/cross-origin-iframe').fixture, 'cross-origin-iframe')
  assert.equal(get('iframe.vast-test.local', '/nested').fixture, 'nested-frame')
  assert.equal(get('login.vast-test.local', '/dynamic-iframe').fixture, 'dynamic-iframe')
  assert.equal(get('login.vast-test.local', '/frame-login').fixture, 'iframe-login')
  assert.equal(get('iframe.vast-test.local', '/frame-login').fixture, 'iframe-login')
  assert.equal(get('unknown.vast-test.local', '/login').status, 421)
  assert.equal(get('login.vast-test.local', '/absent').status, 404)
})

test('save and update fixtures use Chromium autocomplete semantics and real bounded POST navigation', () => {
  const nativeLogin = get('login.vast-test.local', '/native-login').body
  assert.match(nativeLogin, /id="gate-native-login"[^>]*method="post"[^>]*action="\/__gate\/native-login-complete"/)
  assert.match(nativeLogin, /id="gate-password"[^>]*autocomplete="current-password"/)

  const signup = get('login.vast-test.local', '/signup').body
  assert.match(signup, /id="gate-signup"[^>]*method="post"[^>]*action="\/__gate\/signup-complete"/)
  assert.match(signup, /id="gate-password"[^>]*autocomplete="new-password"/)

  const update = get('login.vast-test.local', '/change-password').body
  assert.match(update, /id="gate-password-change"[^>]*method="post"[^>]*action="\/__gate\/password-change-complete"/)
  assert.match(update, /id="gate-current-password"[^>]*autocomplete="current-password"/)
  assert.match(update, /id="gate-password"[^>]*autocomplete="new-password"/)
  assert.match(update, /id="gate-confirm-password"[^>]*autocomplete="new-password"/)

  for (const path of ['/__gate/signup-complete', '/__gate/password-change-complete']) {
    const response = routeFixtureRequest({ host: 'login.vast-test.local', method: 'POST', path,
      body: Buffer.from('must=be-discarded') }, expectedHashes, 4443)
    assert.equal(response.status, 200)
    assert.match(response.body, /id="gate-complete"/)
    assert.equal(response.body.includes('must=be-discarded'), false)
  }

  const nativeResult = routeFixtureRequest({
    host: 'login.vast-test.local',
    method: 'POST',
    path: '/__gate/native-login-complete',
    body: Buffer.from('username=fixture-user&password=fixture-password')
  }, expectedHashes, 4443)
  assert.equal(nativeResult.status, 200)
  assert.equal(nativeResult.fixture, 'native-login-complete')
  assert.match(nativeResult.body, /submission\.submitted = true; submission\.matched = true/)
  assert.doesNotMatch(nativeResult.body, /fixture-user|fixture-password/)
})

test('static login fixtures use stable semantic fields and every form fixture exposes only the snapshot contract', () => {
  for (const [host, path] of [
    ['login.vast-test.local', '/login'],
    ['spa.vast-test.local', '/spa'],
    ['login.vast-test.local', '/frame-login'],
    ['iframe.vast-test.local', '/frame-login']
  ]) {
    const response = get(host, path)
    assert.equal(response.status, 200, `${host}${path}`)
    assert.match(response.body, /id="gate-login"/)
    assert.match(response.body, /id="gate-username"[^>]*name="username"[^>]*autocomplete="username"/)
    assert.match(response.body, /id="gate-password"[^>]*name="password"[^>]*type="password"[^>]*autocomplete="current-password"/)
    assert.match(response.body, /id="gate-submit"[^>]*type="submit"/)
    assert.match(response.body, /window\.__vastGate/)
    assert.doesNotMatch(response.body, /fixture-user|fixture-password/)
  }
  for (const [host, path] of [
    ['login.vast-test.local', '/login'],
    ['spa.vast-test.local', '/spa'],
    ['dynamic.vast-test.local', '/dynamic'],
    ['dynamic.vast-test.local', '/delayed'],
    ['login.vast-test.local', '/frame-login'],
    ['iframe.vast-test.local', '/frame-login']
  ]) {
    const response = get(host, path)
    for (const marker of ['gate-login', 'gate-username', 'gate-password', 'current-password']) {
      assert.match(response.body, new RegExp(marker), `${host}${path} lacks ${marker}`)
    }
    for (const key of [
      'fixture',
      'route',
      'frameOrigin',
      'usernamePresent',
      'passwordPresent',
      'usernameMatchesExpectedHash',
      'passwordMatchesExpectedHash',
      'unexpectedForeignFill',
      'submitted',
      'submissionMatchedExpectedHashes'
    ]) assert.match(response.body, new RegExp(`\\b${key}\\b`))
  }
})

test('iframe fixtures preserve explicit same-origin, cross-origin, nested and dynamic boundaries', () => {
  const same = get('login.vast-test.local', '/same-origin-iframe').body
  assert.match(same, /https:\/\/login\.vast-test\.local:4443\/frame-login\?fixture=same-origin-frame/)
  assert.equal(get('login.vast-test.local', '/frame-login?fixture=same-origin-frame').status, 200)

  const cross = get('login.vast-test.local', '/cross-origin-iframe').body
  assert.match(cross, /https:\/\/iframe\.vast-test\.local:4443\/frame-login\?fixture=cross-origin-frame/)

  const nested = get('iframe.vast-test.local', '/nested').body
  assert.match(nested, /https:\/\/iframe\.vast-test\.local:4443\/nested-middle/)
  const nestedMiddle = get('iframe.vast-test.local', '/nested-middle').body
  assert.match(nestedMiddle, /https:\/\/login\.vast-test\.local:4443\/frame-login\?fixture=nested-inner/)
  assert.equal(get('login.vast-test.local', '/frame-login?fixture=nested-inner').status, 200)

  const dynamic = get('login.vast-test.local', '/dynamic-iframe').body
  assert.match(dynamic, /createElement\(['"]iframe['"]\)/)
  assert.match(dynamic, /https:\/\/iframe\.vast-test\.local:4443\/frame-login\?fixture=dynamic-frame/)
})

test('SPA fixture changes routes and replaces its form without a document reload', () => {
  const html = get('spa.vast-test.local', '/spa').body
  assert.match(html, /history\.pushState/)
  assert.match(html, /history\.replaceState/)
  assert.match(html, /addEventListener\(['"]popstate['"]/)
  assert.match(html, /navigate\(path/)
})

test('submission compares hashes in memory and never echoes or logs secret-bearing fields', () => {
  const captured: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => captured.push(values.join(' '))
  try {
    const response = routeFixtureRequest({
      host: 'login.vast-test.local',
      method: 'POST',
      path: '/__gate/submit',
      body: Buffer.from(`username=${encodeURIComponent(CANARY)}&password=${encodeURIComponent(CANARY)}`)
    }, expectedHashes, 4443)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), {
      accepted: true,
      usernameMatchesExpectedHash: false,
      passwordMatchesExpectedHash: false
    })
    assert.equal(response.body.includes(CANARY), false)
    assert.equal(JSON.stringify(captured).includes(CANARY), false)
  } finally {
    console.log = originalLog
  }
})

test('submission body is bounded at 64 KiB and discarded without parsing', () => {
  assert.equal(MAX_SUBMISSION_BYTES, 64 * 1024)
  const response = routeFixtureRequest({
    host: 'login.vast-test.local',
    method: 'POST',
    path: '/__gate/submit',
    body: Buffer.alloc(MAX_SUBMISSION_BYTES + 1, 65)
  }, expectedHashes, 4443)
  assert.equal(response.status, 413)
  assert.deepEqual(JSON.parse(response.body), { accepted: false, tooLarge: true })
})

test('fixture URLs accept only the exact allowlist and valid HTTPS paths', () => {
  assert.equal(fixtureUrl(FIXTURE_HOSTS[0], '/login', 4443), 'https://login.vast-test.local:4443/login')
  assert.equal(fixtureUrl(FIXTURE_HOSTS[0], '/', 4443), 'https://login.vast-test.local:4443/')
  assert.throws(() => fixtureUrl('unlisted.vast-test.local', '/login', 4443), /approved fixture host/i)
  assert.throws(() => fixtureUrl(FIXTURE_HOSTS[0], 'login', 4443), /absolute path/i)
  assert.throws(() => fixtureUrl(FIXTURE_HOSTS[0], '/login', 0), /port/i)
})
