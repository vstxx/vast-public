import assert from 'node:assert/strict'
import test from 'node:test'
import { clampWindowBounds } from '../../src/shared/window-bounds.ts'

test('restored windows remain visible on the selected monitor', () => {
  assert.deepEqual(
    clampWindowBounds({ x: -9000, y: 9000, width: 3000, height: 2000 }, { x: 0, y: 0, width: 1920, height: 1080 }),
    { x: 0, y: 0, width: 1920, height: 1080 }
  )
  assert.deepEqual(
    clampWindowBounds({ x: 2100, y: 120, width: 1200, height: 800 }, { x: 1920, y: 0, width: 1920, height: 1040 }),
    { x: 2100, y: 120, width: 1200, height: 800 }
  )
})
