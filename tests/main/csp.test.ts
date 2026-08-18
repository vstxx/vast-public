import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'

import { devAppChromeCsp, packagedAppChromeCsp } from '../../src/main/csp.ts'

test('packaged app chrome CSP is strict and keeps dangerous directives out', () => {
  const csp = packagedAppChromeCsp()
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /base-uri 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.doesNotMatch(csp, /unsafe-eval/)
  assert.doesNotMatch(csp, /script-src[^;]*\*/)
  assert.doesNotMatch(csp, /object-src[^;]*(https?:|\*)/)
})

test('dev app chrome CSP allows Vite React refresh without weakening packaged CSP', () => {
  const devCsp = devAppChromeCsp()
  const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

  assert.match(devCsp, /script-src 'self' 'unsafe-inline'/)
  assert.match(indexHtml, /script-src 'self' 'unsafe-inline'/)
  assert.doesNotMatch(packagedAppChromeCsp(), /script-src[^;]*unsafe-inline/)
  assert.doesNotMatch(devCsp, /unsafe-eval/)
})
