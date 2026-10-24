import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'
import { normalizeSpoofingSettings, spoofingFromSettings } from '../../src/shared/spoofing.ts'

// Permission checks and request hooks derive spoofing from settings many times
// per page; normalizing builds an Intl.DateTimeFormat each time.
test('spoofing is normalized once per settings object and again after an update', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  const first = spoofingFromSettings(settings)
  assert.equal(spoofingFromSettings(settings), first, 'same settings, same result object')
  assert.equal(spoofingFromSettings({ ...settings }), first, 'a new settings object with the same spoofing reuses it')
  assert.deepEqual(first, normalizeSpoofingSettings(settings.spoofing))

  // Settings updates replace the spoofing object, so the change is picked up.
  const updated = { ...settings, spoofing: { ...settings.spoofing, enabled: !settings.spoofing.enabled } }
  const next = spoofingFromSettings(updated)
  assert.notEqual(next, first)
  assert.equal(next.enabled, !first.enabled)
})
