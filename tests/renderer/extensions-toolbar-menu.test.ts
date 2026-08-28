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
  assert.match(menu, /max-h-\[22rem\][^"']*overflow-y-auto/)
  assert.match(menu, /window\.vast\.extensions\.prepareSurface/)
  assert.match(menu, /webview[\s\S]*extension-toolbar-surface/)
  for (const label of ['Disable extension', 'Reload extension', 'Manage extension', 'Remove from Vast']) {
    assert.match(menu, new RegExp(label))
  }
  assert.match(menu, /privateWorkspace/)
  assert.match(menu, /useVastConfirm/)
  assert.match(styles, /\.extensions-toolbar-menu/)
  assert.doesNotMatch(styles.match(/\.extensions-toolbar-menu \{[\s\S]*?\}/)?.[0] ?? '', /linear-gradient/)
})
