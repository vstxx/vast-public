import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { replacedEntryUrl } from '../../src/main/guest-navigation-entries.ts'

const opened = { documentUrl: 'https://earth.google.com/web/@1,2', url: 'https://earth.google.com/web/@1,2', length: 3, index: 2 }

test('a page keeps the URL it was opened at; later replaceState churn rewrites one entry', () => {
  // First replaceState after opening: the opened URL stays in history.
  assert.equal(replacedEntryUrl(opened, { url: 'https://earth.google.com/web/@1.1,2', length: 3, index: 2 }), undefined)
  // Every later replaceState rewrites the entry the previous one created.
  const moved = { ...opened, url: 'https://earth.google.com/web/@1.1,2' }
  assert.equal(replacedEntryUrl(moved, { url: 'https://earth.google.com/web/@1.2,2', length: 3, index: 2 }), 'https://earth.google.com/web/@1.1,2')
})

test('pushState, back/forward and repeated reports are visits, not replacements', () => {
  const moved = { ...opened, url: 'https://mail.example.com/#inbox/1' }
  assert.equal(replacedEntryUrl(moved, { url: 'https://mail.example.com/#inbox/2', length: 4, index: 3 }), undefined, 'pushState adds an entry')
  assert.equal(replacedEntryUrl(moved, { url: 'https://mail.example.com/#inbox', length: 3, index: 1 }), undefined, 'going back moves the index')
  assert.equal(replacedEntryUrl(moved, { url: moved.url, length: 3, index: 2 }), undefined, 'the same URL reported twice')
  assert.equal(replacedEntryUrl(undefined, { url: moved.url, length: 1, index: 0 }), undefined)
})

test('main reports replacements and history rewrites the entry instead of adding one', () => {
  const runtime = readFileSync(new URL('../../src/main/guest-runtime-events.ts', import.meta.url), 'utf8')
  const surface = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')
  assert.match(runtime, /setImmediate\(\(\) => sendNavigationState\(contents, 'navigate', true\)\)/)
  assert.match(runtime, /if \(sameDocument\) replacedUrl = replacedEntryUrl\(previous, entry\)/)
  assert.match(runtime, /committedEntries\.delete\(contents\.id\)/)
  assert.match(surface, /replacesUrl: state\.replacedUrl/)
  // A replacement keeps the visit count and does not grow the history.
  assert.match(store, /const nextEntry: HistoryEntry = \{ \.\.\.replaced, url: entry\.url,[^}]*lastVisitedAt: now \}/)
})
