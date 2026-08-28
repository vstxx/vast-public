import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const addressBarSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')
const notesSource = readFileSync(new URL('../../src/renderer/components/notes/NotesPage.tsx', import.meta.url), 'utf8')
const promptSource = readFileSync(new URL('../../src/renderer/components/ui/NotificationsOverlay.tsx', import.meta.url), 'utf8')

test('address draft survives blur and Escape explicitly restores the current URL', () => {
  const blurHandler = addressBarSource.match(/onBlur=\{\(\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] ?? ''
  assert.doesNotMatch(blurHandler, /setValue/)
  assert.match(addressBarSource, /event\.key === 'Escape'/)
  assert.match(addressBarSource, /setValue\(activeTab \? addressValueForTab\(activeTab\.url\) : ''\)/)
})

test('address submissions keep the literal draft unless a suggestion was explicitly chosen', () => {
  assert.match(addressBarSource, /useState\(-1\)/)
  assert.match(addressBarSource, /selectedSuggestion >= 0 \? suggestions\[selectedSuggestion\] : undefined/)
  assert.match(addressBarSource, /runtime\.navigateActive\(suggestion\?\.url \?\? value\)/)
  assert.doesNotMatch(addressBarSource, /onMouseEnter=\{\(\) => setSelectedSuggestion/)
})

test('full notes page owns a height-constrained vertical scroll container', () => {
  assert.match(notesSource, /data-testid="notes-page"/)
  assert.match(notesSource, /h-full min-h-0 overflow-y-auto overflow-x-hidden/)
})

test('screen-share chooser renders explicit source previews and keyboard focus', () => {
  assert.match(promptSource, /data-testid="prompt-choice-grid"/)
  assert.match(promptSource, /data-testid="prompt-choice"/)
  assert.match(promptSource, /choice\.thumbnailDataUrl/)
  assert.match(promptSource, /focus-visible:ring-vast-cyan/)
})
