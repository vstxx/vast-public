import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const paletteSource = readFileSync(new URL('../../src/renderer/components/command-palette/CommandPalette.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const newTabSource = readFileSync(new URL('../../src/renderer/components/new-tab/NewTabPage.tsx', import.meta.url), 'utf8')

test('command palette exposes direct, state-aware privacy and appearance toggles', () => {
  for (const commandId of [
    'toggle-ad-blocker',
    'toggle-tracker-blocking',
    'toggle-tracking-parameter-cleaning',
    'toggle-third-party-cookies',
    'toggle-fingerprinting-protection',
    'toggle-spoofing',
    'toggle-https-only',
    'toggle-force-dark-websites'
  ]) {
    assert.match(paletteSource, new RegExp(`id: '${commandId}'`))
  }
  assert.match(paletteSource, /labs: \{ spoofing: true \}, spoofing: \{ enabled: true \}/)
})

test('command palette moves keyboard focus treatment to its rounded search row', () => {
  assert.match(paletteSource, /command-palette-search/)
  assert.match(paletteSource, /command-palette-input/)
  assert.match(stylesSource, /\.command-palette-search:focus-within\s*\{[^}]*border-bottom-color:/s)
  assert.match(stylesSource, /\.command-palette-input:focus,[\s\S]*?\.command-palette-input:focus-visible\s*\{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important;/s)
})

test('Dim theme uses shallow elevation and the New Tab identity is slightly larger', () => {
  const dimTheme = stylesSource.slice(stylesSource.indexOf('.dim-theme {'), stylesSource.indexOf('.light-theme .text-white'))
  assert.match(dimTheme, /--vast-shadow-md:\s*0 6px 18px rgba\(0, 0, 0, 0\.15\)/)
  assert.match(stylesSource, /\.dim-theme \.settings-modal-shell\s*\{[^}]*0 10px 30px rgba\(0, 0, 0, 0\.2\)/s)
  assert.match(stylesSource, /\.dim-theme \.app-main-surface\s*\{[^}]*background:\s*#1d1d1d !important;/s)
  assert.match(newTabSource, /vast-logo-lockup[^\n]*h-28[^\n]*sm:h-32/)
  assert.match(newTabSource, /vast-logo-image[^\n]*h-36[^\n]*sm:h-40/)
})
