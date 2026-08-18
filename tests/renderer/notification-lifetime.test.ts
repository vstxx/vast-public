import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldAutoDismissNotification } from '../../src/shared/notification-lifetime.ts'

test('zero-duration updater notifications remain until manually dismissed', () => {
  assert.equal(shouldAutoDismissNotification(0), false)
  assert.equal(shouldAutoDismissNotification(-1), false)
  assert.equal(shouldAutoDismissNotification(8_000), true)
})
