import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const addressBar = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const menu = readFileSync(new URL('../../src/renderer/components/browser/ExtensionsToolbarMenu.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

test('extension button is placed exactly between bookmark and sidebar controls', () => {
  const bookmark = addressBar.indexOf('tooltip={isBookmarked')
  const extensions = addressBar.indexOf('<ExtensionsToolbarMenu')
  const sidebar = addressBar.indexOf("tooltip={sidePanelOpen ? 'Hide sidebar'")
  assert.ok(bookmark >= 0 && extensions > bookmark && sidebar > extensions)
})

test('toolbar menu exposes scrollable extensions, custom surfaces, and bounded management actions', () => {
  assert.match(menu, /data-testid="extensions-toolbar-menu"/)
  assert.match(menu, /min-h-0 flex-1 overflow-y-auto[^"']*overscroll-contain/)
  assert.match(menu, /window\.vast\.extensions\.prepareSurface/)
  assert.match(menu, /window\.vast\.extensions\.onOpenPopup\(/)
  assert.match(menu, /openSurface\(extension, 'popup'\)/)
  assert.match(menu, /webview[\s\S]*extension-toolbar-surface/)
  assert.match(menu, /isInternalUrl\(activeTab\.url\)/)
  assert.match(menu, /Open a website tab before using this extension/)
  for (const label of ['Disable extension', 'Reload extension', 'Manage extension', 'Remove from Vast']) {
    assert.match(menu, new RegExp(label))
  }
  assert.match(menu, /privateWorkspace/)
  assert.match(menu, /useVastConfirm/)
  assert.match(styles, /\.extensions-toolbar-menu/)
  assert.doesNotMatch(styles.match(/\.extensions-toolbar-menu \{[\s\S]*?\}/)?.[0] ?? '', /linear-gradient/)
})

test('toolbar menu resizes on both axes, persists its dimensions, and protects drags over extension webviews', () => {
  assert.match(menu, /resizeExtensionMenu/)
  assert.match(menu, /extensionMenu: persistedSize/)
  assert.match(menu, /data-testid="extensions-menu-width-resizer"/)
  assert.match(menu, /data-testid="extensions-menu-height-resizer"/)
  assert.match(menu, /data-testid="extensions-menu-corner-resizer"/)
  assert.match(menu, /data-testid="extensions-menu-resize-shield"/)
  assert.match(menu, /className="min-h-0 flex-1 overflow-y-auto/)
  assert.doesNotMatch(menu, /max-h-\[22rem\]/)
  assert.doesNotMatch(menu, /h-\[25rem\]/)
})
