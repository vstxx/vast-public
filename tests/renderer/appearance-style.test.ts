import assert from 'node:assert/strict'
import test from 'node:test'

import { appearanceStyle } from '../../src/renderer/app/appearance-style.ts'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.ts'

test('clean toolbar icons enlarge only the toolbar glyph presentation', () => {
  const outlinedSettings = structuredClone(DEFAULT_SETTINGS)
  outlinedSettings.appearance.cleanToolbarIcons = false
  const outlined = appearanceStyle(outlinedSettings) as Record<string, string>
  const clean = appearanceStyle(DEFAULT_SETTINGS) as Record<string, string>

  assert.equal(outlined['--vast-toolbar-icon-size'], '16px')
  assert.equal(clean['--vast-toolbar-icon-size'], '18px')
})

test('glassiness changes dialog transparency without changing backdrop blur', () => {
  const solidSettings = structuredClone(DEFAULT_SETTINGS)
  solidSettings.appearance.glassIntensity = 0
  const glassSettings = structuredClone(DEFAULT_SETTINGS)
  glassSettings.appearance.glassIntensity = 100
  const solid = appearanceStyle(solidSettings) as Record<string, string>
  const glass = appearanceStyle(glassSettings) as Record<string, string>

  assert.equal(solid['--vast-dialog-opacity'], '100.0%')
  assert.ok(Number.parseFloat(solid['--vast-dialog-opacity']) > Number.parseFloat(glass['--vast-dialog-opacity']))
  assert.equal(solid['--vast-dialog-blur'], glass['--vast-dialog-blur'])
  assert.equal(solid['--vast-dialog-blur-low-effects'], glass['--vast-dialog-blur-low-effects'])
  assert.equal(solid['--vast-dialog-backdrop-blur'], glass['--vast-dialog-backdrop-blur'])
  assert.equal(solid['--vast-blur'], glass['--vast-blur'])
  assert.equal(solid['--vast-dialog-card-opacity'], '100.0%')
  assert.ok(Number.parseFloat(solid['--vast-dialog-card-opacity']) > Number.parseFloat(glass['--vast-dialog-card-opacity']))
})

test('blur changes dialog and chrome backdrop filtering without changing transparency', () => {
  const clearSettings = structuredClone(DEFAULT_SETTINGS)
  clearSettings.appearance.blurIntensity = 0
  const blurredSettings = structuredClone(DEFAULT_SETTINGS)
  blurredSettings.appearance.blurIntensity = 100
  const clear = appearanceStyle(clearSettings) as Record<string, string>
  const blurred = appearanceStyle(blurredSettings) as Record<string, string>

  assert.equal(clear['--vast-blur'], '0px')
  assert.equal(clear['--vast-dialog-blur'], '0px')
  assert.equal(clear['--vast-dialog-blur-low-effects'], '0px')
  assert.equal(clear['--vast-dialog-backdrop-blur'], '0px')
  assert.ok(Number.parseFloat(blurred['--vast-dialog-blur']) > 0)
  assert.ok(Number.parseFloat(blurred['--vast-dialog-backdrop-blur']) > 0)
  assert.equal(clear['--vast-dialog-opacity'], blurred['--vast-dialog-opacity'])
  assert.equal(clear['--vast-dialog-card-opacity'], blurred['--vast-dialog-card-opacity'])
})
