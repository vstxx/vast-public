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

test('maximum profile unifies screen and timezone while disabled WebRTC removes the JS API', () => {
  const script = buildFingerprintingProtectionScript('maximum', 'temporary', true)
  assert.match(script, /Screen\.prototype/)
  assert.match(script, /timeZone: 'UTC'/)
  assert.match(script, /getTimezoneOffset = \(\) => 0/)
  assert.match(script, /languages', \(\) => \['en-US', 'en'\]/)
  assert.match(script, /RTCPeerConnection/)
})
