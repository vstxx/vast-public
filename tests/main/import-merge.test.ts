import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DATA } from '../../src/shared/constants.ts'
import type { BrowserSourceSnapshot, ImportedBookmarkEntry } from '../../src/shared/browser-import.ts'
import type { PersistedData } from '../../src/shared/types.ts'
import { mergeImportCandidate } from '../../src/main/import/import-merge.ts'

function state(patch: Partial<PersistedData> = {}): PersistedData {
  return { ...structuredClone(DEFAULT_DATA), ...patch }
}

function bookmark(itemId: string, root: ImportedBookmarkEntry['root'], folderPath: string[], folderSourceIds: string[]): ImportedBookmarkEntry {
  return { title: itemId, url: 'https://same.example/', sourceItemId: itemId, root, folderPath, folderSourceIds }
}

function snapshot(bookmarks: ImportedBookmarkEntry[] = []): BrowserSourceSnapshot {
  return {
    sourceId: 'chrome', profileId: 'profile-a', bookmarks, history: [], extensions: [],
    categories: {
      bookmarks: { status: 'ready' }, history: { status: 'empty' }, extensions: { status: 'empty' }
    }
  }
}

test('candidate retains same-URL bookmarks across roots/folders and is idempotent by source ID', () => {
  const input = state()
  const source = snapshot([
    bookmark('1', 'bar', [], []),
    bookmark('2', 'other', ['Projects'], ['f1']),
    bookmark('3', 'mobile', ['Projects'], ['f2'])
  ])
  const first = mergeImportCandidate(input, source, ['bookmarks'])
  assert.equal(input.bookmarks.length, 0, 'pure merge must not mutate current state')
  assert.equal(first.counts.bookmarks.added, 3)
  assert.equal(first.data.bookmarks.length, 3)
  assert.equal(new Set(first.data.bookmarks.map((item) => item.id)).size, 3)
  assert.equal(first.data.bookmarks.find((item) => item.importSource?.itemId === '1')?.folderId, undefined)
  const other = first.data.bookmarks.find((item) => item.importSource?.itemId === '2')
  const mobile = first.data.bookmarks.find((item) => item.importSource?.itemId === '3')
  assert.notEqual(other?.folderId, mobile?.folderId)
  assert.equal(first.data.bookmarkFolders.length, 4, 'Other and Mobile roots have separate top-level folders')
  const otherChild = first.data.bookmarkFolders.find((folder) => folder.id === other?.folderId)
  assert.equal(otherChild?.name, 'Projects')
  assert.equal(first.data.bookmarkFolders.find((folder) => folder.id === otherChild?.parentId)?.name, 'Other Bookmarks')
  const mobileChild = first.data.bookmarkFolders.find((folder) => folder.id === mobile?.folderId)
  assert.equal(first.data.bookmarkFolders.find((folder) => folder.id === mobileChild?.parentId)?.name, 'Mobile Bookmarks')
  const restored = JSON.parse(JSON.stringify(first.data)) as PersistedData
  const again = mergeImportCandidate(restored, source, ['bookmarks'])
  assert.deepEqual(again.data.bookmarks, restored.bookmarks)
  assert.deepEqual(again.data.bookmarkFolders, restored.bookmarkFolders)
  assert.equal(again.counts.bookmarks.added, 0)
  assert.equal(again.counts.bookmarks.skipped, 3)
})

test('candidate preserves unrelated state and takes max visit count, not a sum', () => {
  const current = state({
    history: [{ id: 'existing', title: 'Existing', url: 'https://same.example/', visitCount: 9, lastVisitedAt: 100 }],
    notes: [{ id: 'note', title: 'Keep', body: 'unchanged', createdAt: 1, updatedAt: 1 }]
  })
  const source = snapshot()
  source.history = [{ title: 'Imported', url: 'https://same.example/', visitCount: 7, lastVisitedAt: 200 }]
  const first = mergeImportCandidate(current, source, ['history'])
  assert.equal(first.data.history[0]?.visitCount, 9)
  assert.equal(first.data.history[0]?.lastVisitedAt, 200)
  assert.deepEqual(first.data.notes, current.notes)
  assert.equal(first.counts.history.updated, 1)
  const again = mergeImportCandidate(first.data, source, ['history'])
  assert.equal(again.data.history[0]?.visitCount, 9)
  assert.equal(again.counts.history.updated, 0)
})

test('candidate history cap preserves existing entries and counts only imported additions', () => {
  const source = snapshot()
  source.history = Array.from({ length: 1_100 }, (_unused, i) => ({
    title: `Site ${i}`, url: `https://site-${i}.example/`, visitCount: 1, lastVisitedAt: 1_000 + i
  }))
  const current = state({ history: [{ id: 'old', title: 'Old', url: 'https://old.example/', visitCount: 1, lastVisitedAt: 1 }] })
  const result = mergeImportCandidate(current, source, ['history'])
  assert.equal(result.data.history.length, 1_000)
  assert.equal(result.counts.history.added, 999)
  assert.equal(result.counts.history.skipped, 101)
  assert.equal(result.counts.history.evicted, 0)
  assert.ok(result.data.history.some((entry) => entry.id === 'old'))
  assert.equal(result.data.history[0]?.url, 'https://site-1099.example/')
})

test('a full existing history rejects new imports without losing or recounting entries', () => {
  const existing = Array.from({ length: 1_000 }, (_unused, i) => ({
    id: `existing-${i}`, title: `Existing ${i}`, url: `https://old-${i}.example/`, visitCount: 1, lastVisitedAt: i
  }))
  const source = snapshot()
  source.history = [{ title: 'New', url: 'https://new.example/', visitCount: 1, lastVisitedAt: 10_000 }]
  const result = mergeImportCandidate(state({ history: existing }), source, ['history'])
  assert.deepEqual(new Set(result.data.history.map((entry) => entry.id)), new Set(existing.map((entry) => entry.id)))
  assert.equal(result.counts.history.added, 0)
  assert.equal(result.counts.history.skipped, 1)
  assert.equal(result.counts.history.evicted, 0)
})

test('candidate rejects UTF-8 serialized state over 8 MiB without mutating source', () => {
  const current = state({ notes: [{ id: 'huge', title: 'Huge', body: 'ż'.repeat(4_300_000), createdAt: 1, updatedAt: 1 }] })
  assert.throws(() => mergeImportCandidate(current, snapshot(), ['bookmarks']), /too large|8 MiB/i)
  assert.equal(current.bookmarks.length, 0)
})
