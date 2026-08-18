import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mouseNavigationActionForButton,
  shouldTriggerMouseNavigation
} from '../../src/shared/mouse-navigation.ts'

test('side mouse buttons map to browser back and forward', () => {
  assert.equal(mouseNavigationActionForButton(3), 'back')
  assert.equal(mouseNavigationActionForButton(4), 'forward')
  assert.equal(mouseNavigationActionForButton(0), undefined)
})

test('mouse navigation prevents default on press but triggers once on release-style events', () => {
  assert.equal(shouldTriggerMouseNavigation('mousedown'), false)
  assert.equal(shouldTriggerMouseNavigation('mouseup'), true)
  assert.equal(shouldTriggerMouseNavigation('auxclick'), true)
})
