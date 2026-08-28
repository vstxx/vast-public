import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesExtensionMatchPattern, parseExtensionMatchPattern } from '../../src/shared/extension-match-pattern.ts'

test('extension match patterns keep IDU access on HTTPS IDU hosts only', () => {
  const iduPattern = 'https://*.idu.edu.pl/*'

  assert.equal(matchesExtensionMatchPattern('https://idu.edu.pl/', iduPattern), true)
  assert.equal(matchesExtensionMatchPattern('https://s19.idu.edu.pl/', iduPattern), true)
  assert.equal(matchesExtensionMatchPattern('https://s19.idu.edu.pl/student/grades?term=2#latest', iduPattern), true)
  assert.equal(matchesExtensionMatchPattern('https://other.idu.edu.pl/', iduPattern), true)
  assert.equal(matchesExtensionMatchPattern('https://region.school.idu.edu.pl/', iduPattern), true)
  assert.equal(matchesExtensionMatchPattern('http://s19.idu.edu.pl/', iduPattern), false)
  assert.equal(matchesExtensionMatchPattern('https://s19.idu.edu.pl.example.com/', iduPattern), false)
  assert.equal(matchesExtensionMatchPattern('https://example.com/?next=https://s19.idu.edu.pl/', iduPattern), false)
  assert.equal(matchesExtensionMatchPattern('not a URL', iduPattern), false)
})

test('extension match parser rejects malformed, credentialed, invalid-port, and suffix-wildcard patterns', () => {
  for (const pattern of [
    '', 'https://example.com', 'https://example.com:65536/*', 'https://example.com:abc/*', 'https://user@example.com/*',
    'https://example.*/*', 'https://*example.com/*', 'https://example.com./*',
    'https://example.com/*#fragment', 'file://server/share/*', 'javascript://example.com/*'
  ]) assert.equal(parseExtensionMatchPattern(pattern), undefined, pattern)
  assert.deepEqual(parseExtensionMatchPattern('https://*.example.com/*'), {
    allUrls: false, scheme: 'https', host: '*.example.com', port: '*', path: '/*'
  })
  assert.equal(matchesExtensionMatchPattern('http://[::1]/private', 'http://[::1]/*'), true)
})

test('extension match patterns implement Chromium port and PathForRequest behavior', () => {
  assert.equal(matchesExtensionMatchPattern('https://example.com/account?view=compact', 'https://example.com:443/account?view=*'), true)
  assert.equal(matchesExtensionMatchPattern('https://example.com:8443/account?view=compact', 'https://example.com:8443/account?view=*'), true)
  assert.equal(matchesExtensionMatchPattern('https://example.com/account', 'https://example.com:8443/*'), false)
  assert.equal(matchesExtensionMatchPattern('http://example.com:8080/', 'http://example.com:*/*'), true)
  assert.equal(matchesExtensionMatchPattern('http://[::1]:8080/private', 'http://[::1]:8080/*'), true)
})

test('extension match patterns support Chromium wildcard hosts without suffix confusion', () => {
  const pattern = '*://*.example.com/private/*'

  assert.equal(matchesExtensionMatchPattern('https://example.com/private/home', pattern), true)
  assert.equal(matchesExtensionMatchPattern('http://sub.example.com/private/home', pattern), true)
  assert.equal(matchesExtensionMatchPattern('https://example.com/public/home', pattern), false)
  assert.equal(matchesExtensionMatchPattern('https://example.com.evil.test/private/home', pattern), false)
})
