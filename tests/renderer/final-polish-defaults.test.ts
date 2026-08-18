import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'

test('new profiles require explicit local-network discovery opt in', () => {
  assert.equal(DEFAULT_SETTINGS.network.enabled, false)
  assert.equal(DEFAULT_SETTINGS.network.allowScans, false)
  assert.equal(DEFAULT_SETTINGS.network.activeProbing, false)
  assert.equal(DEFAULT_SETTINGS.network.rememberDevices, false)
})

test('clean launch keeps the new tab configurable but hides non-neutral dashboard sections', () => {
  assert.equal(DEFAULT_SETTINGS.newTab.showQuickLinks, true)
  assert.equal(DEFAULT_SETTINGS.newTab.showRecentlyClosed, false)
  assert.equal(DEFAULT_SETTINGS.newTab.showNotes, false)
  assert.equal(DEFAULT_SETTINGS.newTab.showTodos, false)
  assert.equal(DEFAULT_SETTINGS.newTab.showSessionTimeline, false)
  assert.equal(DEFAULT_SETTINGS.sidePanel.mode, 'auto')
  assert.ok(DEFAULT_SETTINGS.sidePanel.width >= 304)
})
