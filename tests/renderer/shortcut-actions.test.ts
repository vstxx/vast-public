import { strict as assert } from 'node:assert'
import test from 'node:test'

import { DEFAULT_SHORTCUTS } from '../../src/shared/constants.ts'

test('removed native ad blocker does not reserve a shortcut', () => {
  assert.equal('toggleAdBlocker' in DEFAULT_SHORTCUTS, false)
})
