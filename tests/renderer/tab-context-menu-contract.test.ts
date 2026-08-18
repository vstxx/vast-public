import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const contextMenuSource = readFileSync(new URL('../../src/renderer/lib/context-menu.ts', import.meta.url), 'utf8')
const tabRowSource = readFileSync(new URL('../../src/renderer/components/tabs/TabRow.tsx', import.meta.url), 'utf8')
const horizontalSource = readFileSync(new URL('../../src/renderer/components/horizontal/HorizontalChrome.tsx', import.meta.url), 'utf8')
const puristSource = readFileSync(new URL('../../src/renderer/components/purist/PuristChrome.tsx', import.meta.url), 'utf8')

test('every tab chrome routes its context-menu gesture through the shared menu', () => {
  for (const source of [tabRowSource, horizontalSource, puristSource]) {
    assert.match(source, /onContextMenu=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?openTabContextMenu\(tab, event\.clientX, event\.clientY\)/)
  }
})

test('the shared tab menu keeps duplicate, pin, and close-other actions wired', () => {
  assert.match(contextMenuSource, /label: 'Duplicate tab'[\s\S]*?store\.duplicateTab\(tab\.id\)/)
  assert.match(contextMenuSource, /label: tab\.pinned \? 'Unpin tab' : 'Pin tab'[\s\S]*?store\.togglePinnedTab\(tab\.id\)/)
  assert.match(contextMenuSource, /label: 'Close other tabs'[\s\S]*?for \(const target of closeTargetsOther\) useBrowserStore\.getState\(\)\.closeTab\(target\.id\)/)
})
