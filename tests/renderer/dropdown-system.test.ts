import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rendererRoot = new URL('../../src/renderer/', import.meta.url)
const componentsRoot = new URL('../../src/renderer/components/', import.meta.url)
const selectSource = readFileSync(new URL('../../src/renderer/components/ui/VastSelect.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

function collectTsx(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? collectTsx(path) : entry.endsWith('.tsx') ? [path] : []
  })
}

test('renderer uses the shared Vast dropdown instead of native selects', () => {
  const componentFiles = collectTsx(fileURLToPath(componentsRoot))
  const offenders = componentFiles.filter((path) => /<select\b|<option\b/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(offenders, [])
  const labelWrappedButtons = componentFiles.filter((path) => {
    const source = readFileSync(path, 'utf8')
    return [...source.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].some((match) => /<VastSelect\b/.test(match[1]))
  })
  assert.deepEqual(labelWrappedButtons, [], 'VastSelect buttons must not be nested in labels because label activation can reopen a dismissed menu')

  const expectedConsumers = [
    'settings/SettingsModal.tsx',
    'automation/AutomationPage.tsx',
    'notes/NotesPage.tsx',
    'new-tab/NewTabPage.tsx',
    'passwords/PasswordsPage.tsx',
    'side-panel/SidePanel.tsx',
    'tabs/TabRow.tsx',
    'pdf/PdfViewerPage.tsx'
  ]
  for (const relativePath of expectedConsumers) {
    assert.match(readFileSync(new URL(`components/${relativePath}`, rendererRoot), 'utf8'), /<VastSelect\b/, relativePath)
  }
})

test('Vast dropdown keeps menus above clipped surfaces and supports keyboard interaction', () => {
  assert.match(selectSource, /createPortal\(/)
  assert.match(selectSource, /closest\('\.app-shell'\)/)
  assert.match(selectSource, /role="listbox"/)
  assert.match(selectSource, /role="option"/)
  assert.match(selectSource, /aria-activedescendant/)
  assert.match(selectSource, /event\.key === 'ArrowDown'/)
  assert.match(selectSource, /event\.key === 'Home'/)
  assert.match(selectSource, /event\.key === 'Escape'/)
  assert.match(selectSource, /typeaheadRef/)
  assert.match(stylesSource, /\.vast-select-menu\s*\{[\s\S]*?position:\s*fixed/)
  assert.match(stylesSource, /\.vast-select-button:focus-visible/)
})

test('Vast dropdown uses concentric radii and aligned trigger and option content', () => {
  assert.match(stylesSource, /--vast-select-menu-padding:\s*0\.35rem/)
  assert.match(stylesSource, /--vast-select-outer-radius:\s*calc\(var\(--vast-select-inner-radius\) \+ var\(--vast-select-menu-padding\)\)/)
  assert.match(stylesSource, /\.vast-select-menu\s*\{[\s\S]*?border-radius:\s*var\(--vast-select-outer-radius\)/)
  assert.match(stylesSource, /\.vast-select-option\s*\{[\s\S]*?padding:\s*0\.55rem calc\(0\.8rem - var\(--vast-select-menu-padding\)\)/)
  assert.match(selectSource, /className="vast-select-trailing-icon"/)
})

test('Vast dropdown expands for readable options without reserving an empty scrollbar gutter', () => {
  assert.match(selectSource, /width: 'max-content'/)
  assert.match(selectSource, /maxWidth = Math\.max\(176, Math\.min\(448,/)
  assert.match(selectSource, /menuRef\.current\?\.getBoundingClientRect\(\)/)
  assert.match(selectSource, /observer\.observe\(menu\)/)
  assert.match(stylesSource, /\.settings-select-control\s*\{[\s\S]*?max-width:\s*100%/)
  assert.doesNotMatch(stylesSource, /\.vast-select-menu\s*\{[^}]*scrollbar-gutter:\s*stable/)
})

test('Vast dropdown exposes exactly three deliberate control lengths', () => {
  assert.match(selectSource, /export type VastSelectSize = 'short' \| 'medium' \| 'long'/)
  assert.match(selectSource, /vast-select-size-\$\{size\}/)
  assert.match(stylesSource, /\.vast-select-size-short\s*\{[^}]*width:\s*min\(100%, 9rem\)/s)
  assert.match(stylesSource, /\.vast-select-size-medium\s*\{[^}]*width:\s*min\(100%, 12rem\)/s)
  assert.match(stylesSource, /\.vast-select-size-long\s*\{[^}]*width:\s*min\(100%, 16rem\)/s)
  assert.match(settingsSource, /label="Layout"\s+size="short"/)
  assert.match(settingsSource, /label="Ad blocking"\s+size="long"/)
  assert.match(settingsSource, /size = 'medium'/)
})

test('settings dropdown titles stay concise and on one line', () => {
  assert.match(settingsSource, /className="settings-select-title" title=\{label\}/)
  assert.match(stylesSource, /\.settings-select-title\s*\{[^}]*white-space:\s*nowrap/)
  assert.match(stylesSource, /\.settings-grid label,\s*\.settings-select-label,\s*\.settings-grid-action\s*\{/)
  assert.match(stylesSource, /\.settings-grid label:hover,\s*\.settings-select-label:hover,\s*\.settings-grid-action:hover\s*\{/)
  assert.match(stylesSource, /\.light-theme \.settings-grid label,\s*\.light-theme \.settings-select-label\s*\{/)
  for (const longLabel of [
    'Fingerprinting protection',
    'Microphone permission',
    'Notifications permission',
    'Default search engine',
    'Startup behavior'
  ]) {
    assert.doesNotMatch(settingsSource, new RegExp(`label="${longLabel}"`))
  }
})

test('legacy one-off settings and PDF dropdown styles are gone', () => {
  assert.doesNotMatch(stylesSource, /\.settings-select-(?:button|menu|option)\b/)
  assert.doesNotMatch(stylesSource, /\.pdf-select-(?:button|menu|option)\b/)
})
