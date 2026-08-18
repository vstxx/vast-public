import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeSettingsSearchText, searchSettings, settingsSearchCatalog, type SettingsSearchSectionId } from '../../src/renderer/components/settings/settings-search.ts'

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const modalShellSource = readFileSync(new URL('../../src/renderer/components/ui/ModalShell.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

test('settings modal exposes a compact search input in the nav', () => {
  assert.match(settingsSource, /settings-search-panel/)
  assert.match(settingsSource, /settingsSearchQuery/)
  assert.match(settingsSource, /placeholder="Search settings"/)
  assert.match(settingsSource, /aria-label="Search settings"/)
  assert.match(settingsSource, /data-testid="settings-search-input"/)
})

test('settings search keeps focus across controlled input renders', () => {
  assert.match(modalShellSource, /const onCloseRef = useRef\(onClose\)/)
  assert.match(modalShellSource, /onCloseRef\.current\(\)/)
  assert.match(modalShellSource, /useEffect\(\(\) => \{[\s\S]*?const panel = panelRef\.current[\s\S]*?\}, \[\]\)/)
})

test('settings search draws focus on the rounded container without an inner box', () => {
  assert.match(stylesSource, /\.settings-search-panel:focus-within\s*\{[^}]*box-shadow:/s)
  assert.match(stylesSource, /\.settings-search-panel input:focus-visible\s*\{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important;/s)
})

test('settings search exposes ranked function results and direct navigation', () => {
  assert.match(settingsSource, /searchSettings\(settingsSearchQuery/)
  assert.match(settingsSource, /data-settings-search-result=/)
  assert.match(settingsSource, /openSettingsSearchResult/)
  assert.match(settingsSource, /settings-search-highlight/)
  assert.match(settingsSource, /event\.key === 'ArrowDown'/)
  assert.match(settingsSource, /visibleSettingsNav/)
  assert.match(settingsSource, /sectionVisible\('Appearance'\)/)
  assert.match(settingsSource, /sectionVisible\('Security'\)/)
  assert.match(settingsSource, /hidden=\{!sectionVisible\('Developer'\)\}/)
  assert.doesNotMatch(settingsSource, /hidden=\{!sectionVisible\('Diagnostics'\)\}/)
})

test('settings search provides clear and empty states', () => {
  assert.match(settingsSource, /Clear settings search/)
  assert.match(settingsSource, /No settings found/)
  assert.match(settingsSource, /Try a name, synonym, or shorter phrase/)
})

test('settings search catalog covers every section and a broad function inventory', () => {
  const sections = new Set<SettingsSearchSectionId>(settingsSearchCatalog.map((entry) => entry.section))
  assert.equal(sections.size, 14)
  assert.ok(settingsSearchCatalog.length >= 180)
  assert.equal(new Set(settingsSearchCatalog.map((entry) => `${entry.section}:${entry.label}`)).size, settingsSearchCatalog.length)
})

test('settings search normalizes case, camelCase, punctuation, and Polish diacritics', () => {
  assert.equal(normalizeSettingsSearchText('  Menedżer-Haseł  '), 'menedzer hasel')
  assert.equal(normalizeSettingsSearchText('commandPalette'), 'command palette')
})

test('settings search finds exact functions, synonyms, Polish terms, and word-order variants', () => {
  const expectMatch = (query: string, label: string, section?: SettingsSearchSectionId): void => {
    const results = searchSettings(query)
    assert.ok(results.some((result) => result.label === label && (!section || result.section === section)), `${query} did not find ${section ?? '*'}:${label}`)
  }

  expectMatch('search engine', 'Search engine')
  expectMatch('ram limit', 'Memory target (best effort)')
  expectMatch('tryb ciemny', 'Force dark mode on websites')
  expectMatch('mikrofon', 'Microphone')
  expectMatch('menedżer haseł', 'Password Manager')
  expectMatch('cookies third party', 'Block third-party cookies')
  expectMatch('default browser', 'set browser as default')
  expectMatch('duck duck go', 'Search engine')
})

test('settings search tolerates useful typos and respects disabled sections', () => {
  assert.ok(searchSettings('passwrod manager').some((result) => result.label === 'Password Manager'))
  const onlyAppearance = new Set<SettingsSearchSectionId>(['Appearance'])
  assert.deepEqual(searchSettings('password', onlyAppearance), [])
})
