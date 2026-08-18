import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const settings = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')

test('removed Integrations surface is absent from settings, preload, and IPC', () => {
  assert.doesNotMatch(settings, /section id="Integrations"|window\.vast\.integrations|AI assistant/)
  assert.doesNotMatch(preload, /vast:integrations:|vast:ai:/)
  assert.doesNotMatch(ipc, /vast:integrations:|vast:ai:/)
  assert.equal(existsSync(new URL('../../src/main/integrations.ts', import.meta.url)), false)
})

test('Diagnostics controls live inside Developer instead of a duplicate section', () => {
  const developerStart = settings.indexOf('<section id="Developer"')
  const privacyStart = settings.indexOf('<section id="Privacy"', developerStart)
  const developer = settings.slice(developerStart, privacyStart)
  assert.match(developer, /Open Diagnostics/)
  assert.match(developer, /Copy diagnostics/)
  assert.doesNotMatch(settings, /section id="Diagnostics"/)
})
