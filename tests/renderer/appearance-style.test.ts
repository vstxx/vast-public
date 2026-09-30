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
