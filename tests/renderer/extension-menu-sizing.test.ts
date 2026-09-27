import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampExtensionMenuSize,
  resizeExtensionMenu,
  sanitizeStoredExtensionMenuSize
} from '../../src/shared/extension-menu-sizing.ts'

test('stored extension menu dimensions are constrained to durable desktop limits', () => {
  assert.deepEqual(sanitizeStoredExtensionMenuSize({ width: 9_999, height: 50 }), { width: 720, height: 280 })
  assert.deepEqual(sanitizeStoredExtensionMenuSize({ width: 50, height: 9_999 }), { width: 320, height: 1_200 })
  assert.deepEqual(sanitizeStoredExtensionMenuSize({ width: 511.6, height: 603.4 }), { width: 512, height: 603 })
})

test('extension menu dimensions remain inside the currently available viewport', () => {
  assert.deepEqual(
    clampExtensionMenuSize({ width: 700, height: 700 }, { width: 600, height: 500 }, 60),
    { width: 584, height: 432 }
  )
  assert.deepEqual(
    clampExtensionMenuSize({ width: 368, height: 452 }, { width: 300, height: 300 }, 60),
    { width: 284, height: 232 }
  )
})

test('left, bottom, and corner drags resize the top-right anchored extension menu', () => {
  const viewport = { width: 1_440, height: 900 }
  const start = { width: 368, height: 452 }

  assert.deepEqual(resizeExtensionMenu(start, 'width', { x: -80, y: 100 }, viewport, 60), { width: 448, height: 452 })
  assert.deepEqual(resizeExtensionMenu(start, 'height', { x: -80, y: 100 }, viewport, 60), { width: 368, height: 552 })
  assert.deepEqual(resizeExtensionMenu(start, 'both', { x: -80, y: 100 }, viewport, 60), { width: 448, height: 552 })
})
