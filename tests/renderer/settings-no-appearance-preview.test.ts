import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const path = (file: string): URL => new URL(`../../src/renderer/${file}`, import.meta.url)
const read = (file: string): string => readFileSync(path(file), 'utf8')

test('Appearance settings have no live preview', () => {
  assert.equal(existsSync(path('components/settings/AppearancePreview.tsx')), false)
  const settings = read('components/settings/SettingsModal.tsx')
  assert.doesNotMatch(settings, /AppearancePreview|settings-card-title">Preview</)
  // Visual profiles took the slot; Colors follows it.
  assert.match(settings, /<div className="settings-stack">\s*<VisualProfilesCard \/>\s*<div className="settings-card">\s*<h3 className="settings-card-title">Colors<\/h3>/)
  assert.doesNotMatch(read('styles/index.css'), /settings-preview|data-preview-layout|\.pv-/)
})
