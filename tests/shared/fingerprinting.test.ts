import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFingerprintingProtectionScript } from '../../src/shared/fingerprinting.ts'

test('strict fingerprinting protection uses stable identity-and-origin noise', () => {
  const script = buildFingerprintingProtectionScript('strict', 'workspace-school')
  assert.match(script, /seedText.*location\.origin/)
  assert.match(script, /CanvasRenderingContext2D/)
  assert.match(script, /WebGLRenderingContext/)
  assert.match(script, /FontFaceSet/)
  assert.match(script, /roundedWidth/)
  assert.doesNotMatch(script, /Math\.random/)
})

test('standard protection leaves the core count native; stricter profiles still mask it', () => {
  // Workers see the real value regardless, and a lower main-world value capped
  // worker pools on many-core machines.
  const coreCount = (mode: 'standard' | 'strict' | 'maximum'): unknown => {
    class Navigator {}
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 24 })
    const navigator = Object.create(Navigator.prototype) as { hardwareConcurrency: number }
    class Stub {}
    const page = {
      Navigator, Screen: Stub, HTMLCanvasElement: Stub, CanvasRenderingContext2D: Stub, Date: Stub,
      Intl: { DateTimeFormat: Stub }, location: { origin: 'https://example.com' }, screen: { width: 1920, height: 1080 }
    }
    new Function(...Object.keys(page), `const globalThis = {}; return (${buildFingerprintingProtectionScript(mode, 'workspace')})`)(...Object.values(page))
    return navigator.hardwareConcurrency
  }
  assert.equal(coreCount('standard'), 24)
  assert.equal(coreCount('strict'), 8)
  assert.equal(coreCount('maximum'), 4)
})

test('maximum profile unifies screen and timezone while disabled WebRTC removes the JS API', () => {
  const script = buildFingerprintingProtectionScript('maximum', 'temporary', true)
  assert.match(script, /Screen\.prototype/)
  assert.match(script, /timeZone: 'UTC'/)
  assert.match(script, /getTimezoneOffset = \(\) => 0/)
  assert.match(script, /languages', \(\) => \['en-US', 'en'\]/)
  assert.match(script, /RTCPeerConnection/)
})
