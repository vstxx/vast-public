import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type {
  BrowserImportCategoryResult,
  BrowserImportDataType,
  BrowserSourceSnapshot,
  ImportedBookmarkEntry,
  ImportedHistoryEntry
} from '../../shared/browser-import.ts'
import type { ResolvedImportSource } from './profile-discovery.ts'
import type { ImportReadResult } from './bookmark-reader.ts'
import { readChromiumBookmarks, readFirefoxBookmarks } from './bookmark-reader.ts'
import { readChromiumHistory, readFirefoxHistory } from './history-reader.ts'
import { withSqliteSnapshot } from './sqlite-snapshot.ts'
import { discoverChromiumExtensions } from './chromium-extension-discovery.ts'

interface WorkRequest {
  source: ResolvedImportSource
  types: BrowserImportDataType[]
  stagingRoot?: string
}

function failed(error: unknown, skipped = 0): BrowserImportCategoryResult {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code: NonNullable<BrowserImportCategoryResult['code']> = /limit exceeded|exceeds 32 MiB/i.test(message)
    ? 'SOURCE_LIMIT_EXCEEDED'
    : /invalid|corrupt|integrity|truncated/i.test(message)
      ? 'SOURCE_INVALID'
      : /ENOENT|could not be found/i.test(message)
        ? 'SOURCE_UNAVAILABLE'
        : 'SOURCE_READ_FAILED'
  return { status: code === 'SOURCE_UNAVAILABLE' ? 'unavailable' : 'failed', code,
    message: code.replaceAll('_', ' ').toLowerCase(), skipped }
}

function category<T>(result: ImportReadResult<T>): BrowserImportCategoryResult {
  if (result.error) return failed(result.error, result.skipped)
  return { status: result.items.length ? 'ready' : 'empty', skipped: result.skipped }
}

async function perform({ source, types, stagingRoot }: WorkRequest): Promise<BrowserSourceSnapshot> {
  const snapshot: BrowserSourceSnapshot = {
    sourceId: source.sourceId,
    profileId: source.profileId,
    bookmarks: [], history: [], extensions: [],
    categories: { bookmarks: { status: 'empty' }, history: { status: 'empty' }, extensions: { status: 'empty' } }
  }
  const wants = (type: BrowserImportDataType): boolean => types.includes(type)
  const firefox = source.sourceId === 'firefox'

  if (firefox && (wants('bookmarks') || wants('history'))) {
    try {
      // Both categories are read from one online backup of places.sqlite.
      const found = await withSqliteSnapshot(join(source.canonicalPath, 'places.sqlite'), (db) => ({
        bookmarks: wants('bookmarks') ? readFirefoxBookmarks(db) : undefined,
        history: wants('history') ? readFirefoxHistory(db) : undefined
      }), { stagingRoot })
      if (found.bookmarks) {
        snapshot.categories.bookmarks = category(found.bookmarks)
        if (!found.bookmarks.error) snapshot.bookmarks = found.bookmarks.items
      }
      if (found.history) {
        snapshot.categories.history = category(found.history)
        if (!found.history.error) snapshot.history = found.history.items
      }
    } catch (error) {
      if (wants('bookmarks')) snapshot.categories.bookmarks = failed(error)
      if (wants('history')) snapshot.categories.history = failed(error)
    }
  } else if (!firefox) {
    if (wants('bookmarks')) {
      const result = await readChromiumBookmarks(source.canonicalPath)
      snapshot.categories.bookmarks = category(result)
      if (!result.error) snapshot.bookmarks = result.items
    }
    if (wants('history')) {
      try {
        const result = await withSqliteSnapshot(join(source.canonicalPath, 'History'), readChromiumHistory, { stagingRoot })
        snapshot.categories.history = category(result)
        if (!result.error) snapshot.history = result.items
      } catch (error) { snapshot.categories.history = failed(error) }
    }
    if (wants('extensions')) {
      try {
        snapshot.extensions = await discoverChromiumExtensions(source.canonicalPath)
        snapshot.categories.extensions.status = snapshot.extensions.length ? 'ready' : 'empty'
      } catch (error) { snapshot.categories.extensions = failed(error) }
    }
  }
  if (firefox && wants('extensions')) snapshot.categories.extensions = {
    status: 'unavailable', code: 'SOURCE_UNAVAILABLE', message: 'Firefox extension import is unavailable'
  }
  return snapshot
}

const port = parentPort
if (!port) throw new Error('Import source reader requires a worker parent')
void perform(workerData as WorkRequest).then(
  (snapshot) => port.postMessage({ ok: true, snapshot }),
  () => port.postMessage({ ok: false })
)
