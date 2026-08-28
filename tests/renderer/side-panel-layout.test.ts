import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sidePanelSource = readFileSync(new URL('../../src/renderer/components/side-panel/SidePanel.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')
const addressBarSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const automationSource = readFileSync(new URL('../../src/renderer/components/automation/AutomationPage.tsx', import.meta.url), 'utf8')

test('sidebar keeps one visibility toggle by the address bar and exposes pin mode beside the title', () => {
  const closeControl = sidePanelSource.indexOf('tooltip="Close sidebar"')
  const pinControl = sidePanelSource.indexOf("tooltip={pinned ? 'Unpin sidebar' : 'Pin sidebar over page'}")
  const title = sidePanelSource.indexOf('{activeTitle}')

  assert.equal(closeControl, -1)
  assert.ok(pinControl >= 0)
  assert.ok(title > pinControl)
  assert.match(sidePanelSource, /aria-pressed=\{pinned\}/)
  assert.match(sidePanelSource, /mode: pinned \? 'docked' : 'overlay'/)
  assert.match(sidePanelSource, /className="side-panel-pin-button"/)
  assert.match(stylesSource, /\.app-shell \.side-panel-pin-button\s*{[^}]*width:\s*2rem;[^}]*height:\s*2rem;[^}]*box-shadow:\s*none !important;/s)
  assert.match(sidePanelSource, /truncate text-left text-xl font-semibold/)
})

test('unpinned sidebar is docked while pinned sidebar stays above the page without a scrim', () => {
  assert.doesNotMatch(sidePanelSource, /side-panel-scrim/)
  assert.match(stylesSource, /\.side-panel-slot\.is-docked\s*\{[^}]*position:\s*relative;[^}]*flex:\s*0 0 auto;[^}]*height:\s*100%;[^}]*pointer-events:\s*auto;/s)
  assert.match(stylesSource, /\.side-panel-slot\.is-pinned\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*35;[^}]*pointer-events:\s*none;/s)
  assert.match(stylesSource, /\.side-panel-slot \.side-panel\s*\{[^}]*pointer-events:\s*auto;/s)
  assert.match(stylesSource, /\.side-panel-slot\.is-docked \.side-panel\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s)
  assert.match(sidePanelSource, /style=\{pinned \? undefined : \{ width \}\}/)
})

test('only pinned sidebar is draggable, persisted, and clamped below browser chrome', () => {
  assert.match(sidePanelSource, /data-testid="sidebar-drag-handle"/)
  assert.match(sidePanelSource, /const startMove/)
  assert.match(sidePanelSource, /if \(!pinned \|\| event\.button !== 0/)
  assert.match(sidePanelSource, /onMouseDown=\{pinned \? startMove : undefined\}/)
  assert.match(sidePanelSource, /positionX: lastPosition\.x, positionY: lastPosition\.y/)
  assert.match(sidePanelSource, /window\.vast\.app\.platform === 'win32' \? 60/)
  assert.match(sidePanelSource, /data-pinned=\{pinned \? 'true' : 'false'\}/)
})

test('all user-facing controls consistently call the feature Sidebar', () => {
  const userFacingSources = [sidePanelSource, addressBarSource, settingsSource, automationSource].join('\n')
  assert.doesNotMatch(userFacingSources, /["'`]\s*(?:[^"'`]*\s)?side panel(?:\s[^"'`]*)?["'`]/i)
  assert.match(addressBarSource, /'Hide sidebar'\s*:\s*'Show sidebar'/)
  assert.match(settingsSource, /label="Sidebar mode"/)
  assert.match(settingsSource, /label="Sidebar width"/)
  assert.match(settingsSource, /Pinned over page/)
})
