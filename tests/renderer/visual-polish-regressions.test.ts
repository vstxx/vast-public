import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const notificationsSource = readFileSync(new URL('../../src/renderer/components/ui/NotificationsOverlay.tsx', import.meta.url), 'utf8')
const notificationCardSource = readFileSync(new URL('../../src/renderer/components/ui/NotificationCard.tsx', import.meta.url), 'utf8')
const localErrorBoundarySource = readFileSync(new URL('../../src/renderer/components/ui/LocalErrorBoundary.tsx', import.meta.url), 'utf8')
const notesSource = readFileSync(new URL('../../src/renderer/components/notes/NotesPage.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8')
const addressBarSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const browserStageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const commandPaletteSource = readFileSync(new URL('../../src/renderer/components/command-palette/CommandPalette.tsx', import.meta.url), 'utf8')
const horizontalChromeSource = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')
const smartUnloadSource = readFileSync(new URL('../../src/renderer/components/browser/SmartUnloadPanel.tsx', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('../../src/renderer/app/browser-runtime.tsx', import.meta.url), 'utf8')
const constantsSource = readFileSync(new URL('../../src/shared/constants.ts', import.meta.url), 'utf8')
const labsPages = [
  'notes/NotesPage.tsx',
  'passwords/PasswordsPage.tsx',
  'automation/AutomationPage.tsx',
  'avidae/AvidaePage.tsx',
  'diagnostics/DiagnosticsPage.tsx',
  'network/NetworkPage.tsx',
  'session-timeline/SessionTimelinePage.tsx'
].map((path) => readFileSync(new URL(`../../src/renderer/components/${path}`, import.meta.url), 'utf8'))

test('omnibox keeps focus on its rounded container without an inner rectangular ring', () => {
  assert.match(
    stylesSource,
    /\.address-bar-input:focus-visible,[\s\S]*?\.vast-top-address:focus-within \.address-bar-input\s*{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important;/
  )
  assert.match(addressBarSource, /focused \? 'text-white' : 'text-white\/45'/)
  assert.match(addressBarSource, /transition-colors duration-150/)
})

test('Labs settings remain local and visually grouped', () => {
  const labsStart = settingsSource.indexOf('<section id="Labs"')
  const labsEnd = settingsSource.indexOf('<section id="Network"', labsStart)

  assert.ok(labsStart >= 0)
  assert.ok(labsEnd > labsStart)
  const labsSource = settingsSource.slice(labsStart, labsEnd)
  assert.match(labsSource, /local, experimental feature flags/)
  assert.doesNotMatch(labsSource, /license|upgrade|subscription/i)
})

test('Sidebar sheen and active-download toast remain visually restrained', () => {
  assert.match(stylesSource, /\.side-panel::before\s*{[^}]*var\(--vast-accent\) 4%[^}]*opacity:\s*0\.58;/s)

  const downloadToastStart = notificationsSource.indexOf('className="download-progress-toast')
  const downloadToastEnd = notificationsSource.indexOf('{toasts.map', downloadToastStart)
  const downloadToastSource = notificationsSource.slice(downloadToastStart, downloadToastEnd)

  assert.ok(downloadToastStart >= 0)
  assert.ok(downloadToastEnd > downloadToastStart)
  assert.doesNotMatch(downloadToastSource, /linear-gradient|backdrop-blur|shadow-\[[^\]]*(?:cyan|purple|violet)/)
  assert.match(downloadToastSource, /bg-\[#0b0c10\]\/\[0\.97\]/)
  assert.match(downloadToastSource, /bg-white\/\[0\.55\]/)
  assert.doesNotMatch(appSource, /title:\s*'Download started'/)
  assert.match(appSource, /title:\s*'Download completed'/)
})

test('Vast notification surfaces share one geometry contract', () => {
  assert.match(notificationCardSource, /vast-notification-card/)
  assert.match(stylesSource, /\.vast-notification-stack,[\s\S]{0,140}width:\s*min\(25rem, calc\(100vw - 2\.5rem\)\)/)
  assert.match(stylesSource, /\.vast-notification-card\s*\{[^}]*min-height:\s*104px;[^}]*border-radius:\s*22px;[^}]*padding:\s*16px;/s)
  assert.equal((notificationsSource.match(/<NotificationCard/g) ?? []).length, 2)
  assert.match(notificationsSource, /vast-notification-icon/)
  assert.match(notificationsSource, /vast-notification-message/)
  assert.match(localErrorBoundarySource, /<NotificationCard/)
  assert.match(notesSource, /<NotificationCard role="status"/)
  assert.match(settingsSource, /<NotificationCard role="status" className="settings-developer-notification/)
})

test('top chrome and Labs surfaces avoid white decorative gradients', () => {
  const horizontalChrome = stylesSource.slice(stylesSource.indexOf('.horizontal-chrome::before'), stylesSource.indexOf('.side-panel::before {'))
  assert.doesNotMatch(horizontalChrome, /rgba\(255,\s*255,\s*255/)
  assert.match(stylesSource, /\.app-shell \.labs-page-surface\s*{[^}]*background:\s*var\(--vast-bg\) !important;/s)
  for (const theme of ['light', 'dim']) {
    const addressStart = stylesSource.indexOf(`.${theme}-theme .vast-top-address {`)
    const addressEnd = stylesSource.indexOf('}', addressStart)
    assert.ok(addressStart >= 0)
    assert.doesNotMatch(stylesSource.slice(addressStart, addressEnd), /gradient/)
  }
  for (const page of labsPages) {
    assert.match(page, /labs-page-surface/)
  }
})

test('New Tab uses a flat canvas and neutral matching horizontal chrome dividers', () => {
  assert.match(appSource, /activeTabIsNewTab = activeTabUrl === INTERNAL_NEW_TAB_URL/)
  assert.match(appSource, /activeTabIsNewTab \? 'is-new-tab' : ''/)
  assert.match(stylesSource, /\.app-shell\.is-new-tab \.app-main-surface\s*{[^}]*background:\s*var\(--vast-bg\) !important;/s)
  assert.match(stylesSource, /\.app-shell\.is-new-tab \.app-main-surface::before\s*{[^}]*display:\s*none;/)
  assert.match(stylesSource, /\.browser-stage\.is-new-tab,[\s\S]*?\.browser-stage\.is-new-tab \.new-tab-page\s*{[^}]*background:\s*var\(--vast-bg\) !important;[^}]*background-image:\s*none !important;/)
  assert.match(stylesSource, /\.horizontal-chrome\s*{[^}]*--horizontal-chrome-divider:\s*rgba\(255, 255, 255, 0\.055\);[^}]*background-image:\s*none !important;[^}]*border-bottom-color:\s*var\(--horizontal-chrome-divider\) !important;/s)
  assert.match(stylesSource, /\.horizontal-chrome \.address-bar-divider\s*{[^}]*border-top:\s*1px solid var\(--horizontal-chrome-divider\);[^}]*background:\s*none;/s)
  assert.match(stylesSource, /\.horizontal-bookmarks-bar:not\(\.purist-bookmarks-bar\)\s*{[^}]*border-top:\s*0 !important;/s)
  assert.match(stylesSource, /\.horizontal-chrome::before,[\s\S]*?\.horizontal-chrome::after\s*{[^}]*content:\s*none;[^}]*display:\s*none !important;/s)
  assert.doesNotMatch(horizontalChromeSource, /border-t/)
  assert.doesNotMatch(addressBarSource, /address-bar-divider[^\n]*gradient|address-bar-divider[^\n]*vast-cyan/)
})

test('Smart Unload uses explicit surfaces for every selected theme', () => {
  assert.match(stylesSource, /\.dark-theme \.smart-unload-panel\s*{[^}]*--smart-unload-panel-bg:\s*#050507;/s)
  assert.match(stylesSource, /\.dim-theme \.smart-unload-panel\s*{[^}]*--smart-unload-panel-bg:\s*#1b1b1b;/s)
  assert.match(stylesSource, /\.light-theme \.smart-unload-panel\s*{[^}]*--smart-unload-panel-bg:\s*#f7f9fc;/s)
  assert.match(stylesSource, /\.smart-unload-panel\s*{[^}]*background:\s*var\(--smart-unload-panel-bg\) !important;/s)
  for (const className of ['smart-unload-summary', 'smart-unload-row', 'smart-unload-empty', 'smart-unload-metric']) {
    assert.match(smartUnloadSource, new RegExp(className))
  }
})

test('retired Reader and system-browser actions stay out of user-facing surfaces', () => {
  const readerSurfaces = `${appSource}\n${addressBarSource}\n${browserStageSource}\n${commandPaletteSource}\n${runtimeSource}\n${constantsSource}`
  assert.doesNotMatch(readerSurfaces, /INTERNAL_READER_URL|Focus Reader|toggleReaderMode|vast:\/\/reader/)
  assert.doesNotMatch(`${addressBarSource}\n${browserStageSource}\n${horizontalChromeSource}`, /Open in system browser|Open in browser|openCurrentInSystemBrowser/)
})
