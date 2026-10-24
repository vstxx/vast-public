import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

// "Side panel": notes, bookmarks, history. "Sidebar": the vertical layout's tab column.
test('the vertical sidebar has no side panel toggle; the address bar keeps one', () => {
  const sidebar = read('renderer/components/tabs/Sidebar.tsx')
  assert.doesNotMatch(sidebar, /setSidePanelOpen|PanelRight|tooltip="Sidebar"/)
  assert.match(read('renderer/components/browser/AddressBar.tsx'), /tooltip=\{sidePanelOpen \? 'Hide side panel' : 'Show side panel'\}/)
})

test('side panel controls and settings say side panel', () => {
  const panel = read('renderer/components/side-panel/SidePanel.tsx')
  assert.match(panel, /'Unpin side panel' : 'Pin side panel over page'/)
  assert.match(panel, /'Drag side panel'/)
  const settings = read('renderer/components/settings/SettingsModal.tsx')
  for (const label of ['Side panel mode', 'Side panel width', 'Side panel labels', 'Background blur', 'Transparency', 'Frost']) assert.match(settings, new RegExp(`label="${label}"`))
  assert.doesNotMatch(settings, /label="Sidebar (mode|width|labels)"|label="Chrome opacity"|label="Side panel opacity"|label="Glassiness"|'In sidebar'/)
  const search = read('renderer/components/settings/settings-search.ts')
  for (const label of ['Side panel mode', 'Side panel width', 'Side panel labels', 'Background blur', 'Transparency', 'Frost']) assert.match(search, new RegExp(`\\['${label}'`))
})

test('every keyboard shortcut has a readable label in Settings', async () => {
  const settings = read('renderer/components/settings/SettingsModal.tsx')
  const { DEFAULT_SHORTCUTS } = await import('../../src/shared/constants.ts')
  for (const id of Object.keys(DEFAULT_SHORTCUTS)) assert.match(settings, new RegExp(`\\n  ${id}: \\['`), id)
  assert.match(settings, /toggleSidebar: \['Sidebar or side panel', 'Collapses the sidebar in the vertical layout; shows or hides the side panel in other layouts\.'\]/)
})
