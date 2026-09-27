import type { ImportedBookmarkEntry, ImportedHistoryEntry } from '../../shared/browser-import'
import type { Bookmark, BookmarkFolder, HistoryEntry, ID, PersistedData } from '../../shared/types'
import { createId } from '../lib/id.ts'
import { titleFromUrl } from '../lib/url.ts'

export interface ImportedDataMergeInput {
  bookmarks: ImportedBookmarkEntry[]
  history: ImportedHistoryEntry[]
}

export interface ImportedDataMergeCounts {
  bookmarksAdded: number
  foldersCreated: number
  historyAdded: number
}

export type ImportedDataMergeResult = ImportedDataMergeCounts & Pick<PersistedData, 'bookmarks' | 'bookmarkFolders' | 'history'>

const MAX_FOLDERS = 1_000
const MAX_BOOKMARKS = 5_000
const MAX_HISTORY = 1_000
const MAX_FOLDER_DEPTH = 6
const MAX_FOLDER_NAME_LENGTH = 64

interface FolderLookup {
  byId: Map<ID, BookmarkFolder>
  byParentName: Map<string, BookmarkFolder>
}

function folderKey(parentId: ID | undefined, name: string): string {
  return `${parentId ?? 'root'}\u001f${name}`
}

function ensureFolderChain(
  folderPath: readonly string[],
  folders: FolderLookup,
  counters: { foldersCreated: number }
): ID | undefined {
  let parentId: ID | undefined
  for (const rawName of folderPath.slice(0, MAX_FOLDER_DEPTH)) {
    const name = rawName.trim().slice(0, MAX_FOLDER_NAME_LENGTH)
    if (!name) continue
    const key = folderKey(parentId, name)
    const existing = folders.byParentName.get(key)
    if (existing) {
      parentId = existing.id
      continue
    }
    if (folders.byId.size >= MAX_FOLDERS) return parentId
    const now = Date.now()
    const folder: BookmarkFolder = {
      id: createId('folder'),
      name,
      parentId,
      order: [...folders.byId.values()].filter((entry) => entry.parentId === parentId).length,
      createdAt: now,
      updatedAt: now
    }
    folders.byId.set(folder.id, folder)
    folders.byParentName.set(folderKey(folder.parentId, folder.name), folder)
    counters.foldersCreated += 1
    parentId = folder.id
  }
  return parentId
}

/**
 * Merges normalized entries from a browser import into the existing
 * collections. Pure: returns the next arrays plus honest counts. Existing
 * URLs always win, duplicates inside the import collapse, and limits mirror
 * the persistence caps.
 */
export function mergeImportedEntries(
  current: Pick<PersistedData, 'bookmarks' | 'bookmarkFolders' | 'history'>,
  imported: ImportedDataMergeInput
): ImportedDataMergeResult {
  const folders: FolderLookup = {
    byId: new Map(current.bookmarkFolders.map((folder) => [folder.id, folder])),
    byParentName: new Map(current.bookmarkFolders.map((folder) => [folderKey(folder.parentId, folder.name), folder]))
  }
  const counters = { foldersCreated: 0 }

  const existingBookmarkUrls = new Set(current.bookmarks.map((bookmark) => bookmark.url))
  const importedUrls = new Set<string>()
  const newBookmarks: Bookmark[] = []
  const now = Date.now()
  for (const entry of imported.bookmarks) {
    if (existingBookmarkUrls.has(entry.url) || importedUrls.has(entry.url)) continue
    importedUrls.add(entry.url)
    if (current.bookmarks.length + newBookmarks.length >= MAX_BOOKMARKS) break
    const folderId = entry.folderPath.length > 0 ? ensureFolderChain(entry.folderPath, folders, counters) : undefined
    newBookmarks.push({
      id: createId('bookmark'),
      title: entry.title || titleFromUrl(entry.url),
      url: entry.url,
      folderId,
      createdAt: now,
      updatedAt: now
    })
  }

  const historyByUrl = new Map<string, HistoryEntry>()
  for (const entry of current.history) historyByUrl.set(entry.url, { ...entry })
  let historyAdded = 0
  for (const entry of imported.history) {
    const existing = historyByUrl.get(entry.url)
    if (existing) {
      existing.visitCount += entry.visitCount
      existing.lastVisitedAt = Math.max(existing.lastVisitedAt, entry.lastVisitedAt)
      existing.title = existing.title || entry.title
      continue
    }
    historyAdded += 1
    historyByUrl.set(entry.url, {
      id: createId('history'),
      title: entry.title || titleFromUrl(entry.url),
      url: entry.url,
      visitCount: entry.visitCount,
      lastVisitedAt: entry.lastVisitedAt
    })
  }
  const history = [...historyByUrl.values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).slice(0, MAX_HISTORY)

  return {
    bookmarks: [...newBookmarks, ...current.bookmarks],
    bookmarkFolders: [...folders.byId.values()],
    history,
    bookmarksAdded: newBookmarks.length,
    foldersCreated: counters.foldersCreated,
    historyAdded
  }
}
