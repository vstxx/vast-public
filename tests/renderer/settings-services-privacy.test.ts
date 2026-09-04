import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settings = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')

test('Settings discloses production Relay data and exposes official privacy controls', () => {
  assert.match(settings, /Official public builds use production Vast Relay/)
  assert.match(settings, /random installation ID/)
  assert.match(settings, /cumulative launch count/)
  assert.match(settings, /does not receive browsing history/)
  assert.match(settings, /Cloudflare may process request IPs ephemerally/)
  assert.match(settings, /https:\/\/vastbrowser\.com\/privacy/)
  assert.match(settings, /https:\/\/vastbrowser\.com\/support/)
  assert.match(settings, /INTERNAL_SITE_DATA_URL/)
  assert.match(settings, /window\.vast\.relay\.state/)
})
