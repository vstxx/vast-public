import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const spoofingSection = settingsSource.slice(settingsSource.indexOf('<section id="Spoofing"'), settingsSource.indexOf('<section id="Security"'))

test('spoofing settings use the custom settings dropdowns instead of native selects', () => {
  assert.match(spoofingSection, /label="Browser brand"/)
  assert.match(spoofingSection, /label="Timezone"/)
  assert.match(spoofingSection, /label="Location"/)
  assert.doesNotMatch(spoofingSection, /<select/)
})

test('spoofing copy describes the feature as best effort', () => {
  assert.match(spoofingSection, /Best-effort privacy controls/)
  assert.doesNotMatch(spoofingSection, /full anti-detection/i)
})
