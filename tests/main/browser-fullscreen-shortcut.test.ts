import assert from 'node:assert/strict'
import test from 'node:test'

import { isBrowserFullscreenInput } from '../../src/shared/browser-fullscreen-shortcut.ts'

test('plain F11 toggles browser fullscreen on key down from browser chrome or guest content', () => {
  assert.equal(isBrowserFullscreenInput({ type: 'keyDown', code: 'F11', control: false, meta: false, alt: false, shift: false }), true)
  assert.equal(isBrowserFullscreenInput({ type: 'keyUp', code: 'F11', control: false, meta: false, alt: false, shift: false }), false)
  assert.equal(isBrowserFullscreenInput({ type: 'keyDown', code: 'F10', control: false, meta: false, alt: false, shift: false }), false)
  assert.equal(isBrowserFullscreenInput({ type: 'keyDown', code: 'F11', control: true, meta: false, alt: false, shift: false }), false)
  assert.equal(isBrowserFullscreenInput({ type: 'keyDown', code: 'F11', control: false, meta: false, alt: true, shift: false }), false)
})
