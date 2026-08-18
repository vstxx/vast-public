import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const browserStageSource = readFileSync(
  new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url),
  'utf8'
)
const contextMenuSource = readFileSync(
  new URL('../../src/renderer/components/ui/ContextMenu.tsx', import.meta.url),
  'utf8'
)

test('every internal Vast page routes its context-menu gesture through the page menu', () => {
  assert.match(browserStageSource, /onContextMenu=\{\(event\) => openInternalPageMenu\(event, tab\)\}/)
  assert.match(browserStageSource, /const openInternalPageMenu = useCallback\([\s\S]*?event\.preventDefault\(\)[\s\S]*?openContextMenu\(\{/)
})

test('the internal page menu keeps its core tools wired to real actions', () => {
  assert.match(browserStageSource, /label: 'Focus address bar',[\s\S]*?action: runtime\.focusAddress/)
  assert.match(browserStageSource, /label: 'Open command palette',[\s\S]*?action: \(\) => setCommandPaletteOpen\(true\)/)
  assert.match(browserStageSource, /label: 'Open settings',[\s\S]*?action: \(\) => setSettingsOpen\(true\)/)
})

test('the shared menu renders accessible menu items and invokes their actions', () => {
  assert.match(contextMenuSource, /role="menu"/)
  assert.match(contextMenuSource, /role="menuitem"/)
  assert.match(contextMenuSource, /void item\.action\?\.\(\)/)
})
