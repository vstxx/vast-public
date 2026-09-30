import { createHash } from 'node:crypto'
import type { BrowserImportDataType, BrowserSourceSnapshot, ImportedBookmarkEntry } from '../../shared/browser-import.ts'
import type { Bookmark, BookmarkFolder, HistoryEntry, PersistedData } from '../../shared/types.ts'

const MAX_BOOKMARKS = 5_000
const MAX_FOLDERS = 1_000
const MAX_HISTORY = 1_000
const MAX_BYTES = 8 * 1024 * 1024
const ROOT_NAMES: Record<ImportedBookmarkEntry['root'], string> = {
  bar: '', other: 'Other Bookmarks', mobile: 'Mobile Bookmarks', menu: 'Bookmarks Menu', unfiled: 'Other Bookmarks (Firefox)'
}

export interface ImportMergeCount { added: number; updated: number; skipped: number; failed: number; evicted: number }
export interface ImportMergeResult {
  data: PersistedData
  counts: Record<'bookmarks' | 'history', ImportMergeCount>
}

function stableId(kind: string, parts: readonly string[]): string {
  return `import-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`
}

function validUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

function sourceKey(browser: string, profileId: string, itemId: string): string {
  return JSON.stringify([browser, profileId, itemId])
}

function folderKey(browser: string, profileId: string, root: string, itemId: string): string {
  return JSON.stringify([browser, profileId, root, itemId])
}

function blankCount(): ImportMergeCount {
  return { added: 0, updated: 0, skipped: 0, failed: 0, evicted: 0 }
}

/** Build a candidate only; the caller owns durable commit and partial-category consent. */
export function mergeImportCandidate(
  current: PersistedData,
  snapshot: BrowserSourceSnapshot,
  selected: readonly BrowserImportDataType[]
): ImportMergeResult {
  const counts = { bookmarks: blankCount(), history: blankCount() }
  const bookmarks = [...current.bookmarks]
  const bookmarkFolders = [...current.bookmarkFolders]
  const history = [...current.history]

  if (selected.includes('bookmarks')) {
    if (snapshot.categories.bookmarks.status === 'failed' || snapshot.categories.bookmarks.status === 'unavailable') {
      counts.bookmarks.failed++
    } else {
      const known = new Set(bookmarks.flatMap((item) => item.importSource
        ? [sourceKey(item.importSource.browser, item.importSource.profileId, item.importSource.itemId)] : []))
      const folderBySource = new Map(bookmarkFolders.flatMap((item) => item.importSource
        ? [[folderKey(item.importSource.browser, item.importSource.profileId, item.importSource.root, item.importSource.itemId), item]] as const : []))
      const usedIds = new Set([...bookmarks.map((item) => item.id), ...bookmarkFolders.map((item) => item.id)])
      const ensureFolder = (root: ImportedBookmarkEntry['root'], itemId: string, name: string, parentId?: string): string | null => {
        const key = folderKey(snapshot.sourceId, snapshot.profileId, root, itemId)
        const existing = folderBySource.get(key)
        if (existing) return existing.id
        if (bookmarkFolders.length >= MAX_FOLDERS) return null
        const id = stableId('folder', [snapshot.sourceId, snapshot.profileId, root, itemId])
        if (usedIds.has(id)) return null
        const folder: BookmarkFolder = {
          id, name: name.trim().slice(0, 1024) || 'Folder', parentId,
          order: bookmarkFolders.filter((item) => item.parentId === parentId).length,
          createdAt: 0, updatedAt: 0,
          importSource: { browser: snapshot.sourceId, profileId: snapshot.profileId, root, itemId }
        }
        bookmarkFolders.push(folder)
        folderBySource.set(key, folder)
        usedIds.add(id)
        return id
      }

      for (const entry of snapshot.bookmarks) {
        if (!validUrl(entry.url) || !entry.sourceItemId || !Array.isArray(entry.folderPath) ||
            !Array.isArray(entry.folderSourceIds) || entry.folderPath.length !== entry.folderSourceIds.length ||
            entry.folderPath.length > 6 || !Object.hasOwn(ROOT_NAMES, entry.root)) {
          counts.bookmarks.failed++
          continue
        }
        const key = sourceKey(snapshot.sourceId, snapshot.profileId, entry.sourceItemId)
        if (known.has(key)) { counts.bookmarks.skipped++; continue }
        if (bookmarks.length >= MAX_BOOKMARKS) { counts.bookmarks.skipped++; continue }
        const id = stableId('bookmark', [snapshot.sourceId, snapshot.profileId, entry.sourceItemId])
        if (usedIds.has(id)) { counts.bookmarks.failed++; continue }
        const foldersBefore = bookmarkFolders.length
        let folderId: string | undefined
        if (entry.root !== 'bar') {
          const rootId = ensureFolder(entry.root, 'root', ROOT_NAMES[entry.root])
          if (!rootId) { counts.bookmarks.failed++; continue }
          folderId = rootId
        }
        let folderFailed = false
        for (let index = 0; index < entry.folderPath.length; index++) {
          if (!entry.folderSourceIds[index]) { folderFailed = true; break }
          const childId = ensureFolder(entry.root, entry.folderSourceIds[index], entry.folderPath[index], folderId)
          if (!childId) { folderFailed = true; break }
          folderId = childId
        }
        if (folderFailed) {
          for (const folder of bookmarkFolders.splice(foldersBefore)) {
            const source = folder.importSource!
            folderBySource.delete(folderKey(source.browser, source.profileId, source.root, source.itemId))
            usedIds.delete(folder.id)
          }
          counts.bookmarks.failed++
          continue
        }
        const bookmark: Bookmark = {
          id, title: entry.title.trim().slice(0, 4096) || entry.url, url: entry.url,
          folderId, createdAt: 0, updatedAt: 0,
          importSource: { browser: snapshot.sourceId, profileId: snapshot.profileId, itemId: entry.sourceItemId }
        }
        bookmarks.push(bookmark)
        known.add(key)
        usedIds.add(id)
        counts.bookmarks.added++
      }
      counts.bookmarks.skipped += snapshot.categories.bookmarks.skipped ?? 0
    }
  }

  if (selected.includes('history')) {
    if (snapshot.categories.history.status === 'failed' || snapshot.categories.history.status === 'unavailable') {
      counts.history.failed++
    } else {
      const indexByUrl = new Map(history.map((item, index) => [item.url, index]))
      const originalIds = new Set(history.map((item) => item.id))
      const proposedIds = new Set(originalIds)
      const addedIds = new Set<string>()
      const updatedIds = new Set<string>()
      for (const entry of snapshot.history) {
        if (!validUrl(entry.url) || !Number.isSafeInteger(entry.visitCount) || entry.visitCount < 1 ||
            entry.visitCount > 1_000_000 || !Number.isSafeInteger(entry.lastVisitedAt) || entry.lastVisitedAt < 0) {
          counts.history.failed++
          continue
        }
        const index = indexByUrl.get(entry.url)
        if (index !== undefined) {
          const existing = history[index]
          const count = Math.max(existing.visitCount, entry.visitCount)
          const last = Math.max(existing.lastVisitedAt, entry.lastVisitedAt)
          if (count === existing.visitCount && last === existing.lastVisitedAt) {
            counts.history.skipped++
          } else {
            history[index] = { ...existing, visitCount: count, lastVisitedAt: last }
            if (!addedIds.has(existing.id)) updatedIds.add(existing.id)
          }
          continue
        }
        const id = stableId('history', [entry.url])
        if (proposedIds.has(id)) { counts.history.failed++; continue }
        const item: HistoryEntry = {
          id, title: entry.title.trim().slice(0, 4096) || entry.url, url: entry.url,
          visitCount: entry.visitCount, lastVisitedAt: entry.lastVisitedAt
        }
        history.push(item)
        indexByUrl.set(item.url, history.length - 1)
        proposedIds.add(id)
        addedIds.add(id)
      }
      history.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      // Imported entries may use spare capacity, but must never evict a user's
      // pre-existing history (including when the existing store is already full).
      const available = Math.max(0, MAX_HISTORY - originalIds.size)
      const acceptedNewIds = new Set(history.filter((item) => !originalIds.has(item.id)).slice(0, available).map((item) => item.id))
      history.splice(0, history.length, ...history.filter((item) => originalIds.has(item.id) || acceptedNewIds.has(item.id)))
      const retainedIds = new Set(history.map((item) => item.id))
      counts.history.added = [...addedIds].filter((id) => retainedIds.has(id)).length
      counts.history.updated = [...updatedIds].filter((id) => retainedIds.has(id)).length
      counts.history.skipped += [...addedIds].filter((id) => !retainedIds.has(id)).length
      counts.history.evicted = 0
      counts.history.skipped += snapshot.categories.history.skipped ?? 0
    }
  }

  const data = { ...current, bookmarks, bookmarkFolders, history }
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_BYTES) {
    throw new Error('Import candidate exceeds the 8 MiB Vast storage limit.')
  }
  return { data, counts }
}
