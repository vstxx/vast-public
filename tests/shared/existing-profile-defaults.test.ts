import assert from 'node:assert/strict'
import test from 'node:test'
import { preserveExistingProfileFeatureDefaults } from '../../src/shared/existing-profile-defaults.ts'

test('saved profiles without new fields keep previous effective defaults', () => {
  const settings = { appearance: { cornerRadius: 19 }, labs: { avidae: true }, other: 'unchanged' }
  const migrated = preserveExistingProfileFeatureDefaults(settings)
  assert.deepEqual(migrated.appearance, { cornerRadius: 19, cleanToolbarIcons: false })
  assert.deepEqual(migrated.labs, { enabled: false, avidae: true, networkDevices: false,
    automation: false, advancedDiagnostics: false, spoofing: false })
  assert.equal(migrated.other, 'unchanged')
  assert.equal('cleanToolbarIcons' in settings.appearance, false)
})

test('explicit settings on existing profiles are never reset', () => {
  const migrated = preserveExistingProfileFeatureDefaults({ appearance: { cleanToolbarIcons: true },
    labs: { enabled: true, spoofing: true, networkDevices: false } })
  assert.deepEqual(migrated.appearance, { cleanToolbarIcons: true })
  assert.deepEqual(migrated.labs, { enabled: true, avidae: false, networkDevices: false,
    automation: false, advancedDiagnostics: false, spoofing: true })
})
