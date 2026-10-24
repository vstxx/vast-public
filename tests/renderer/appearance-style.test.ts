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

test('transparency sets how see-through floating surfaces are, capped for readability', () => {
  const style = (transparency: number): Record<string, string> => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.appearance.transparency = transparency
    return appearanceStyle(settings) as Record<string, string>
  }
  assert.equal(style(0)['--vast-float-opacity'], '100.0%')
  assert.equal(style(0)['--vast-float-alpha'], '1.000')
  assert.equal(style(100)['--vast-float-opacity'], '30.0%')
  assert.equal(style(DEFAULT_SETTINGS.appearance.transparency)['--vast-float-opacity'], '89.5%')
})

test('frost blurs see-through surfaces, and is off when nothing shows through', () => {
  const style = (transparency: number, glassIntensity: number): Record<string, string> => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    Object.assign(settings.appearance, { transparency, glassIntensity })
    return appearanceStyle(settings) as Record<string, string>
  }
  assert.match(style(15, 100)['--vast-float-filter'], /^blur\(20px\) saturate\(/)
  assert.match(style(15, 50)['--vast-float-filter'], /^blur\(10px\)/)
  assert.equal(style(0, 100)['--vast-float-filter'], 'none')
  assert.equal(style(15, 0)['--vast-float-filter'], 'none')
  // Background blur and Transparency are independent of Frost.
  assert.equal(style(15, 0)['--vast-dialog-backdrop-blur'], style(15, 100)['--vast-dialog-backdrop-blur'])
  assert.equal(style(15, 0)['--vast-float-opacity'], style(15, 100)['--vast-float-opacity'])
})

test('background blur only changes the backdrop behind dialogs', () => {
  const style = (blurIntensity: number): Record<string, string> => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.appearance.blurIntensity = blurIntensity
    return appearanceStyle(settings) as Record<string, string>
  }
  assert.equal(style(0)['--vast-dialog-backdrop-blur'], '0px')
  assert.equal(style(100)['--vast-dialog-backdrop-blur'], '12px')
  assert.equal(style(0)['--vast-float-filter'], style(100)['--vast-float-filter'])
  assert.equal(style(0)['--vast-float-opacity'], style(100)['--vast-float-opacity'])
})

test('dim surfaces take the surface tint only when it differs from the default', () => {
  const neutral = appearanceStyle(DEFAULT_SETTINGS) as Record<string, string>
  assert.equal(neutral['--vast-dim-surface-tint-mix'], '0%')
  const tinted = structuredClone(DEFAULT_SETTINGS)
  tinted.appearance.surfaceTintColor = '#2a6bff'
  assert.equal((appearanceStyle(tinted) as Record<string, string>)['--vast-dim-surface-tint-mix'], '22%')
})

test('cyan utilities and the glow shadow are the accent color', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
  assert.match(css, /@theme inline \{[^}]*--color-vast-cyan: var\(--vast-accent\);/s)
  assert.doesNotMatch(css, /rgba\(116, 231, 255/)
})

test('a profile saved before Transparency existed gets the default, not NaN', () => {
  const legacy = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS
  delete (legacy.appearance as Partial<typeof legacy.appearance>).transparency
  assert.equal((appearanceStyle(legacy) as Record<string, string>)['--vast-float-opacity'], '89.5%')
  assert.equal(DEFAULT_SETTINGS.appearance.transparency, 15)
})
