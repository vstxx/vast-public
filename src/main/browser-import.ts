import {
  BROWSER_IMPORT_DATA_TYPES,
  BROWSER_IMPORT_SOURCE_IDS,
  BROWSER_IMPORT_SOURCE_NAMES,
  type BrowserImportCategoryResult,
  type BrowserImportRequest,
  type BrowserImportRunResult
} from '../shared/browser-import.ts'
import { resolveImportProfile } from './import/profile-discovery.ts'
import { readBrowserSource } from './import/worker-client.ts'

export { discoverImportSources } from './import/profile-discovery.ts'

function invalidRequest(request: BrowserImportRequest): string | null {
  if (!request || typeof request !== 'object') return 'Invalid import request.'
  if (!BROWSER_IMPORT_SOURCE_IDS.includes(request.sourceId)) return 'Unknown import source.'
  if (typeof request.profileId !== 'string' || !request.profileId.trim() || request.profileId.length > 128) return 'Invalid profile.'
  if (!Array.isArray(request.types) || request.types.length === 0 ||
      request.types.some((type) => !BROWSER_IMPORT_DATA_TYPES.includes(type))) return 'Invalid import selection.'
  return null
}

function failure(message: string): BrowserImportRunResult {
  return {
    ok: false, error: message, bookmarks: [], history: [], extensions: [],
    categories: {
      bookmarks: { status: 'failed' }, history: { status: 'failed' }, extensions: { status: 'failed' }
    }
  }
}

/** Legacy reader helper for controlled fixtures; no renderer IPC exposes raw source records. */
export async function runBrowserImport(request: BrowserImportRequest): Promise<BrowserImportRunResult> {
  const invalid = invalidRequest(request)
  if (invalid) return failure(invalid)
  try {
    const source = await resolveImportProfile(request.sourceId, request.profileId)
    const snapshot = await readBrowserSource(source, request.types, new AbortController().signal)
    const legacyCategory = (type: keyof typeof snapshot.categories): BrowserImportCategoryResult => {
      const next = snapshot.categories[type]
      if (next.status === 'ready') return { ...next, status: 'imported' }
      if (next.status === 'empty' && !next.message) {
        return { ...next, message: `No ${type} were found in this profile.` }
      }
      return next
    }
    return {
      ok: true,
      sourceId: source.sourceId,
      sourceName: BROWSER_IMPORT_SOURCE_NAMES[source.sourceId],
      bookmarks: snapshot.bookmarks,
      history: snapshot.history,
      extensions: snapshot.extensions,
      categories: {
        bookmarks: legacyCategory('bookmarks'),
        history: legacyCategory('history'),
        extensions: legacyCategory('extensions')
      }
    }
  } catch {
    return failure('The selected browser profile could not be read.')
  }
}
