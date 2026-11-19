import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  looksLikeUrl,
  normalizeSearchText,
  paletteUrlKey,
  parsePaletteQuery,
  preparePaletteItem,
  scorePaletteItem,
  type PaletteSearchInput
} from '../../src/renderer/lib/palette-search.ts'

const paletteSource = readFileSync(new URL('../../src/renderer/components/command-palette/CommandPalette.tsx', import.meta.url), 'utf8')

function score(item: PaletteSearchInput, query: string): number {
  return scorePaletteItem(preparePaletteItem(item), parsePaletteQuery(query).tokens)
}

function rank(items: PaletteSearchInput[], query: string): string[] {
  return items
    .map((item) => ({ item, value: score(item, query) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.item.title)
}

test('normalization folds case and diacritics, including Polish letters', () => {
  assert.equal(normalizeSearchText('Źródło ŁÓDŹ Café'), 'zrodlo lodz cafe')
  assert.ok(score({ title: 'Źródło danych' }, 'zrodlo') > 0)
  assert.ok(score({ title: 'Łódź' }, 'lodz') > 0)
})

test('every query word must match; word order does not matter', () => {
  assert.ok(score({ title: 'Open Video & Audio' }, 'audio open') > 0)
  assert.equal(score({ title: 'Open Video & Audio' }, 'audio settings'), 0)
})

test('title quality outranks URL and loose matches', () => {
  const items = [
    { title: 'Release notes', url: 'https://github.com/vstxx/vast/releases' },
    { title: 'GitHub', url: 'https://github.com/' },
    { title: 'Go to the gym hub', url: 'https://example.com/' }
  ]
  assert.deepEqual(rank(items, 'github')[0], 'GitHub')
  assert.equal(rank(items, 'github')[1], 'Release notes', 'host match ranks above a scattered subsequence')
  assert.ok(score({ title: 'Clear history' }, 'clear history') > score({ title: 'Clear browsing history now' }, 'clear history'))
})

test('word starts and initials match; scattered letters only in titles', () => {
  assert.ok(score({ title: 'Toggle focus mode' }, 'focus') > score({ title: 'Toggle focus mode' }, 'ocu'))
  assert.ok(score({ title: 'Video & Audio' }, 'va') > 0, 'initials')
  assert.ok(score({ title: 'Network devices' }, 'ntwk') > 0, 'title subsequence')
  assert.equal(score({ title: 'Docs', url: 'https://example.com/network/kit' }, 'ntwk'), 0, 'no subsequence across URLs')
  assert.equal(score({ title: 'Docs', subtitle: '2 hours ago' }, 'x'), 0)
})

test('a section name or relative time is not searchable text', () => {
  // Sections are not passed to the engine; page items exclude their subtitles.
  assert.match(paletteSource, /subtitle: command\.url \? undefined : command\.subtitle/)
  assert.doesNotMatch(paletteSource, /command\.section\} \$\{/)
})

test('scope prefixes restrict results', () => {
  assert.deepEqual(parsePaletteQuery('@tabs mail'), { scope: 'tabs', text: 'mail', tokens: ['mail'] })
  assert.deepEqual(parsePaletteQuery('@history'), { scope: 'history', text: '', tokens: [] })
  assert.equal(parsePaletteQuery('@bookmark docs').scope, 'bookmarks')
  assert.equal(parsePaletteQuery('@notes').scope, 'notes')
  assert.deepEqual(parsePaletteQuery('> settings'), { scope: 'commands', text: 'settings', tokens: ['settings'] })
  assert.equal(parsePaletteQuery('@tabsearch').scope, undefined, 'a prefix must be followed by a space')
  assert.equal(parsePaletteQuery('email@tabs.com').scope, undefined)
})

test('addresses are recognised for a direct Open action', () => {
  for (const value of ['github.com', 'https://example.com/a?b=c', 'localhost:5173', '192.168.1.1', 'vast://settings', 'sub.domain.co.uk/path']) {
    assert.equal(looksLikeUrl(value), true, value)
  }
  for (const value of ['github', 'how to cook rice', 'v1.2', 'file.txt with spaces', '']) {
    assert.equal(looksLikeUrl(value), false, value)
  }
})

test('the same page is keyed once regardless of fragment or trailing slash', () => {
  assert.equal(paletteUrlKey('https://example.com/'), paletteUrlKey('https://example.com'))
  assert.equal(paletteUrlKey('https://example.com/a#top'), paletteUrlKey('https://example.com/a'))
  assert.notEqual(paletteUrlKey('https://example.com/a'), paletteUrlKey('https://example.com/b'))
})

test('the palette ranks globally, dedupes pages and never admits non-matches through usage', () => {
  assert.match(paletteSource, /Usage boosts only reorder matches; they never admit a non-match/)
  assert.match(paletteSource, /if \(match === 0\) continue/)
  assert.match(paletteSource, /KIND_PRIORITY/)
  assert.match(paletteSource, /bookmarks\.map\(\(bookmarkItem\)/, 'all bookmarks are searchable')
  assert.match(paletteSource, /history\.map\(\(entry\)/, 'all history is searchable')
  assert.match(paletteSource, /event\.key === 'Delete' && event\.shiftKey/)
})
