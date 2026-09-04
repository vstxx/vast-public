import assert from 'node:assert/strict'
import test from 'node:test'

import { updaterDisabledReason } from '../../src/shared/updater-policy.ts'

test('Microsoft Store build always delegates updates to the Store', () => {
  assert.equal(
    updaterDisabledReason(true, { distributionChannel: 'microsoft-store', updateEnabled: false }),
    'Updates are managed by Microsoft Store.'
  )
  assert.equal(
    updaterDisabledReason(true, { distributionChannel: 'microsoft-store', updateEnabled: true }),
    'Updates are managed by Microsoft Store.'
  )
})

test('direct build preserves existing updater policy', () => {
  assert.equal(updaterDisabledReason(true, { distributionChannel: 'direct', updateEnabled: true }), null)
  assert.equal(
    updaterDisabledReason(true, { distributionChannel: 'direct', updateEnabled: false }),
    'Auto-updates are disabled for this build.'
  )
})
