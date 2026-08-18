import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveLayoutMode } from '../../src/shared/layout-mode.ts'

test('Purist resolves only while Experimental features is enabled', () => {
  assert.equal(resolveLayoutMode('purist', true), 'purist')
  assert.equal(resolveLayoutMode('purist', false), 'horizontal')
  assert.equal(resolveLayoutMode('horizontal', false), 'horizontal')
  assert.equal(resolveLayoutMode('vertical', false), 'vertical')
})
