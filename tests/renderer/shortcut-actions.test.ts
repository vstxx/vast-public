import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_SHORTCUTS } from '../../src/shared/constants.ts'

test('ad blocker has a configurable keyboard shortcut', () => {
  assert.equal(typeof DEFAULT_SHORTCUTS.toggleAdBlocker, 'string')
  assert.match(DEFAULT_SHORTCUTS.toggleAdBlocker, /Ctrl\/Cmd/i)
})
