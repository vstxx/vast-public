import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sidePanelSource = readFileSync(new URL('../../src/renderer/components/side-panel/SidePanel.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8')

test('pinned sidebar constrains height while docked sidebar fills its column', () => {
  assert.match(sidePanelSource, /\? \{ position: 'absolute', width, height: panelHeight, left: position\.x, top: position\.y \}/)
  assert.match(sidePanelSource, /: \{ position: 'relative', width: '100%', height: '100%' \}/)
  assert.match(sidePanelSource, /side-panel no-drag[^\n]*min-h-0/)
  assert.match(stylesSource, /\.side-panel-slot\.is-pinned\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s)
  assert.match(stylesSource, /\.side-panel-slot\.is-docked\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s)
  assert.match(stylesSource, /\.side-panel\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*max-height:\s*100%;/s)
})

test('sidebar body owns vertical scrolling for every view', () => {
  assert.match(sidePanelSource, /min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 pb-6/)
})
