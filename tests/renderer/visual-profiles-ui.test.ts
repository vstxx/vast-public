import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const card = read('renderer/components/settings/VisualProfilesCard.tsx')
const ipc = read('main/ipc/visual-profiles.ts')
const preload = read('preload/index.ts')

test('Visual profiles is the first Appearance card, where Preview used to be', () => {
  const settings = read('renderer/components/settings/SettingsModal.tsx')
  assert.match(settings, /<div className="settings-stack">\s*<VisualProfilesCard \/>\s*<div className="settings-card">\s*<h3 className="settings-card-title">Colors<\/h3>/)
  assert.doesNotMatch(settings, /AppearancePreview|Reserved for Visual profiles/)
  assert.match(card, /<h3 className="settings-card-title">Visual profiles<\/h3>/)
})

test('applying is one settings update built from validated values, image first', () => {
  assert.equal(card.match(/updateSettings\(/g)?.length, 2, 'one call to apply, one to undo')
  assert.match(card, /updateSettings\(visualProfileSettingsPatch\(target\.values\)\)/)
  assert.match(card, /updateSettings\(visualProfileSettingsPatch\(undo\.values\)\)/)
  assert.ok(card.indexOf('applyImage(target.id)') < card.indexOf('updateSettings(visualProfileSettingsPatch(target.values))'))
  // Imported text is never rendered as markup or used to reach the network.
  assert.doesNotMatch(card, /dangerouslySetInnerHTML|innerHTML|fetch\(|window\.open/)
})

test('every renderer channel goes through the sender-validated handle and nothing else', () => {
  const invoked = [...preload.matchAll(/'(vast:visual-profiles:[a-z-]+)'/g)].map((match) => match[1]).sort()
  const handled = [...ipc.matchAll(/handle\('(vast:visual-profiles:[a-z-]+)'/g)].map((match) => match[1]).sort()
  assert.equal(invoked.length, 10)
  assert.deepEqual(invoked, handled)
  assert.doesNotMatch(ipc, /ipcMain|webContents|shell\.|openExternal/)
  assert.match(read('main/ipc.ts'), /registerVisualProfilesIpc\(handle, senderWindowFor\)/)
})

test('import checks the file size before reading, and files use the .vastvisual extension', () => {
  const importHandler = ipc.slice(ipc.indexOf("'vast:visual-profiles:import'"))
  assert.ok(importHandler.indexOf('info.size > VISUAL_PROFILE_MAX_FILE_BYTES') < importHandler.indexOf('readFile('))
  assert.match(ipc, /const fileFilters = \(extension: string\) => \[\{ name: 'Vast visual profile', extensions: \[extension\] \}\]/)
  assert.equal(ipc.match(/filters: fileFilters\(VISUAL_PROFILE_EXTENSION\)/g)?.length, 2)
  assert.match(read('shared/visual-profile.ts'), /VISUAL_PROFILE_EXTENSION = 'vastvisual'/)
})

// Keeps the main entry inside its performance budget.
test('the profile library and format load on first use, not at startup', () => {
  assert.match(ipc, /const profileModules = \(\) => Promise\.all\(\[import\('\.\.\/visual-profile-library'\), import\('\.\.\/\.\.\/shared\/visual-profile'\)\]\)/)
  assert.doesNotMatch(ipc, /^import (?!type)[^\n]*(visual-profile-library|shared\/visual-profile)'/m)
})

test('the card is always the height of the Preview it replaced; the list scrolls inside', () => {
  const css = read('renderer/styles/index.css')
  assert.match(css, /\.settings-card\.visual-profiles \{\n  display: flex;\n  height: 366px;\n  flex-direction: column;/)
  assert.match(css, /\.visual-profile-list \{[^}]*min-height: 0;[^}]*flex: 1 1 auto;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/s)
  // The status line is always rendered, so messages never change the list height.
  assert.match(card, /<div className=\{`visual-profiles-status\$\{status\?\.error \? ' is-error' : ''\}`\}/)
  // Menus are positioned against the card, so the scrolling list cannot clip them.
  assert.doesNotMatch(css, /\.visual-profile-menu-slot \{[^}]*position:/s)
  assert.match(card, /list\?\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/)
})

test('the profile menu keeps Escape to itself and supports arrow keys', () => {
  assert.match(card, /event\.key === 'Escape'[\s\S]{0,160}event\.stopPropagation\(\)/)
  assert.match(card, /ArrowDown/)
  assert.match(card, /role="menu"/)
  assert.match(card, /aria-haspopup="menu"/)
})
