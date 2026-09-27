import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  BROWSER_IMPORT_DATA_TYPES,
  BROWSER_IMPORT_SOURCE_IDS,
  BROWSER_IMPORT_SOURCE_NAMES,
  type BrowserImportCatalog,
  type BrowserImportDataType,
  type BrowserImportProfileInfo,
  type BrowserImportRequest,
  type BrowserImportRunResult,
  type DetectedExtensionInfo,
  type ImportedBookmarkEntry,
  type ImportedHistoryEntry
} from '../shared/browser-import.ts'

const MAX_BOOKMARKS = 5_000
const MAX_HISTORY = 2_000
const MAX_FOLDERS = 1_000
const MAX_EXTENSIONS = 200
const MAX_URL_LENGTH = 2_048
const MAX_TITLE_LENGTH = 512
const MAX_FOLDER_DEPTH = 6
// Chromium stores timestamps as microseconds since 1601-01-01 UTC.
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000

interface ChromiumRoot {
  key: string
  label: string
}

const CHROMIUM_ROOTS: readonly ChromiumRoot[] = [
  { key: 'bookmark_bar', label: 'Bookmarks bar' },
  { key: 'other', label: 'Other bookmarks' },
  { key: 'synced', label: 'Mobile bookmarks' }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

/** Keeps http(s) URLs only; everything else a browser may contain is dropped. */
function safeUrl(value: unknown): string | null {
  const raw = safeText(value, MAX_URL_LENGTH)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.href.length > MAX_URL_LENGTH) return null
    return parsed.href
  } catch {
    return null
  }
}

function safeProfileId(profileId: unknown): string | null {
  if (typeof profileId !== 'string') return null
  const trimmed = profileId.trim()
  if (!trimmed || trimmed.length > 128 || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null
  return trimmed
}

/** Resolves profileId inside baseDir and refuses anything that escapes it. */
function profilePath(baseDir: string, profileId: string): string | null {
  const base = resolve(baseDir)
  const candidate = resolve(base, profileId)
  if (candidate !== base && !candidate.startsWith(base + sep)) return null
  return candidate
}

function chromeTimeToMs(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value <= 0n) return 0
    return Number(value / 1_000n) - CHROME_EPOCH_OFFSET_MS
  }
  return chromeTimeToMs(BigInt(Math.trunc(value)))
}

function unixMicroToMs(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value <= 0n) return 0
    return Number(value / 1_000n)
  }
  return unixMicroToMs(BigInt(Math.trunc(value)))
}

function userDataRoots(): { chrome: string | null; edge: string | null; firefoxProfiles: string | null } {
  const local = process.env.LOCALAPPDATA?.trim() || null
  const roaming = process.env.APPDATA?.trim() || null
  return {
    chrome: local ? join(local, 'Google', 'Chrome', 'User Data') : null,
    edge: local ? join(local, 'Microsoft', 'Edge', 'User Data') : null,
    firefoxProfiles: roaming ? join(roaming, 'Mozilla', 'Firefox', 'Profiles') : null
  }
}

async function chromiumProfilesFor(userDataDir: string): Promise<BrowserImportProfileInfo[]> {
  if (!existsSync(userDataDir)) return []
  let entries: string[]
  try {
    entries = await readdir(userDataDir)
  } catch {
    return []
  }
  const profileDirs = entries.filter((entry) => !entry.startsWith('.') && entry !== 'System Profile' && entry !== 'Guest Profile' && entry !== 'Crashpad')
  const profiles: BrowserImportProfileInfo[] = []
  for (const dir of profileDirs) {
    const profilePath = join(userDataDir, dir)
    if (!existsSync(join(profilePath, 'Bookmarks')) && !existsSync(join(profilePath, 'History'))) continue
    let name = dir === 'Default' ? 'Default' : dir
    try {
      const localState = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8')) as Record<string, unknown>
      const infoCache = isRecord(localState.profile) && isRecord((localState.profile as Record<string, unknown>).info_cache)
        ? (localState.profile as Record<string, unknown>).info_cache as Record<string, unknown>
        : {}
      const cached = isRecord(infoCache[dir]) ? infoCache[dir] as Record<string, unknown> : undefined
      const cachedName = safeText(cached?.name, 128)
      if (cachedName) name = cachedName
    } catch {
      // Local State is optional; fall back to the directory name.
    }
    profiles.push({ id: dir, name })
  }
  return profiles
}

async function firefoxProfilesFor(profilesDir: string): Promise<BrowserImportProfileInfo[]> {
  if (!existsSync(profilesDir)) return []
  let entries: string[]
  try {
    entries = await readdir(profilesDir)
  } catch {
    return []
  }
  const profiles: BrowserImportProfileInfo[] = []
  for (const dir of entries) {
    if (!existsSync(join(profilesDir, dir, 'places.sqlite'))) continue
    profiles.push({ id: dir, name: dir })
  }
  return profiles.sort((a, b) => Number(b.id.includes('default-release')) - Number(a.id.includes('default-release')))
}

export async function discoverImportSources(): Promise<BrowserImportCatalog> {
  const roots = userDataRoots()
  const [chromeProfiles, edgeProfiles, firefoxProfiles] = await Promise.all([
    roots.chrome ? chromiumProfilesFor(roots.chrome) : Promise.resolve([]),
    roots.edge ? chromiumProfilesFor(roots.edge) : Promise.resolve([]),
    roots.firefoxProfiles ? firefoxProfilesFor(roots.firefoxProfiles) : Promise.resolve([])
  ])
  return {
    sources: [
      { id: 'chrome', name: BROWSER_IMPORT_SOURCE_NAMES.chrome, available: chromeProfiles.length > 0, profiles: chromeProfiles },
      { id: 'edge', name: BROWSER_IMPORT_SOURCE_NAMES.edge, available: edgeProfiles.length > 0, profiles: edgeProfiles },
      { id: 'firefox', name: BROWSER_IMPORT_SOURCE_NAMES.firefox, available: firefoxProfiles.length > 0, profiles: firefoxProfiles }
    ]
  }
}

interface ChromiumBookmarkNode {
  type?: string
  name?: string
  url?: string
  children?: ChromiumBookmarkNode[]
}

function collectChromiumBookmarks(
  node: ChromiumBookmarkNode,
  folderPath: string[],
  bookmarks: ImportedBookmarkEntry[]
): void {
  if (bookmarks.length >= MAX_BOOKMARKS) return
  const url = safeUrl(node.url)
  if (url) {
    bookmarks.push({ title: safeText(node.name, MAX_TITLE_LENGTH), url, folderPath: [...folderPath] })
    return
  }
  const childPath = safeText(node.name, MAX_TITLE_LENGTH) ? [...folderPath, safeText(node.name, MAX_TITLE_LENGTH).slice(0, 64)] : folderPath
  for (const child of Array.isArray(node.children) ? node.children : []) {
    collectChromiumBookmarks(child, childPath, bookmarks)
  }
}

function readChromiumBookmarks(profileDir: string): ImportedBookmarkEntry[] {
  const raw = JSON.parse(readFileSync(join(profileDir, 'Bookmarks'), 'utf8')) as Record<string, unknown>
  const roots = isRecord(raw.roots) ? raw.roots : {}
  const bookmarks: ImportedBookmarkEntry[] = []
  for (const root of CHROMIUM_ROOTS) {
    const rootNode = isRecord(roots[root.key]) ? roots[root.key] as unknown as ChromiumBookmarkNode : undefined
    if (!rootNode) continue
    // Entries directly under a browser root land at Vast's top level.
    for (const child of Array.isArray(rootNode.children) ? rootNode.children : []) {
      collectChromiumBookmarks(child, [], bookmarks)
      if (bookmarks.length >= MAX_BOOKMARKS) return bookmarks
    }
  }
  return bookmarks
}

interface FirefoxBookmarkRow {
  id: number
  type: number
  title: string | null
  url: string | null
  parent: number
}

function readFirefoxBookmarks(db: DatabaseSync): ImportedBookmarkEntry[] {
  const rawRows = db.prepare('SELECT b.id, b.type, b.title, p.url, b.parent FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id').all() as unknown as Array<{
    id: number | bigint
    type: number | bigint
    title: string | null
    url: string | null
    parent: number | bigint
  }>
  const rows: FirefoxBookmarkRow[] = rawRows.map((row) => ({
    id: toInteger(row.id),
    type: toInteger(row.type),
    title: row.title,
    url: row.url,
    parent: toInteger(row.parent)
  }))
  const byId = new Map<number, FirefoxBookmarkRow>()
  for (const row of rows) byId.set(row.id, row)
  // Root folders (parent 0) are browser-level containers; their titles stay out
  // of the imported folder chain.
  const rootIds = new Set(rows.filter((row) => row.parent === 0).map((row) => row.id))
  const folderChainFor = (row: FirefoxBookmarkRow): string[] => {
    const chain: string[] = []
    let current = byId.get(row.parent)
    while (current && current.type === 2 && !rootIds.has(current.id) && chain.length < MAX_FOLDER_DEPTH) {
      const title = safeText(current.title, 64)
      if (title) chain.unshift(title)
      current = current.parent === 0 ? undefined : byId.get(current.parent)
    }
    return chain
  }
  const bookmarks: ImportedBookmarkEntry[] = []
  for (const row of rows) {
    if (row.type !== 1) continue
    const url = safeUrl(row.url)
    if (!url) continue
    bookmarks.push({ title: safeText(row.title, MAX_TITLE_LENGTH), url, folderPath: folderChainFor(row) })
    if (bookmarks.length >= MAX_BOOKMARKS) break
  }
  return bookmarks
}

interface HistoryRow {
  url: string
  title: string | null
  visit_count: number | bigint
  time: number | bigint
}

/** SQLite integers can exceed Number.MAX_SAFE_INTEGER; node:sqlite then yields BigInt. */
function toInteger(value: number | bigint): number {
  if (typeof value === 'bigint') return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
  return Number.isFinite(value) ? value : 0
}

function readChromiumHistory(db: DatabaseSync): ImportedHistoryEntry[] {
  const rows = db.prepare(
    'SELECT url, title, visit_count, last_visit_time AS time FROM urls WHERE hidden = 0 AND url LIKE ? ORDER BY last_visit_time DESC LIMIT ?'
  ).all('http%', MAX_HISTORY) as unknown as HistoryRow[]
  return rows
    .map((row) => {
      const visitCount = toInteger(row.visit_count)
      return {
        title: safeText(row.title, MAX_TITLE_LENGTH),
        url: safeUrl(row.url) ?? '',
        visitCount: visitCount > 0 ? visitCount : 1,
        lastVisitedAt: chromeTimeToMs(row.time)
      }
    })
    .filter((entry) => entry.url)
}

function readFirefoxHistory(db: DatabaseSync): ImportedHistoryEntry[] {
  const rows = db.prepare(
    'SELECT url, title, visit_count, last_visit_date AS time FROM moz_places WHERE hidden = 0 AND url LIKE ? ORDER BY last_visit_date DESC LIMIT ?'
  ).all('http%', MAX_HISTORY) as unknown as HistoryRow[]
  return rows
    .map((row) => {
      const visitCount = toInteger(row.visit_count)
      return {
        title: safeText(row.title, MAX_TITLE_LENGTH),
        url: safeUrl(row.url) ?? '',
        visitCount: visitCount > 0 ? visitCount : 1,
        lastVisitedAt: unixMicroToMs(row.time)
      }
    })
    .filter((entry) => entry.url)
}

function localeManifestName(manifest: Record<string, unknown>, profileDir: string): string {
  const rawName = safeText(manifest.name, 128)
  const match = rawName.match(/^__MSG_(.+)__$/)
  if (manifest.default_locale && match) {
    for (const locale of [safeText(manifest.default_locale, 32).toLowerCase(), 'en', 'en_us']) {
      try {
        const messages = JSON.parse(readFileSync(join(profileDir, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, unknown>
        const entry = messages[match[1]] ?? messages[match[1].toLowerCase()]
        const message = isRecord(entry) ? entry : undefined
        const text = safeText(message?.message, 128)
        if (text) return text
      } catch {
        // Missing locale file: keep trying, then fall back to the raw name.
      }
    }
  }
  return rawName || 'Unknown extension'
}

function detectChromiumExtensions(profileDir: string): DetectedExtensionInfo[] {
  const extensionsDir = join(profileDir, 'Extensions')
  if (!existsSync(extensionsDir)) return []
  const found: DetectedExtensionInfo[] = []
  for (const extensionId of readdirSyncSafe(extensionsDir)) {
    const versions = readdirSyncSafe(join(extensionsDir, extensionId))
    const latest = versions.sort(compareVersionDesc)[0]
    if (!latest) continue
    try {
      const manifest = JSON.parse(readFileSync(join(extensionsDir, extensionId, latest, 'manifest.json'), 'utf8')) as Record<string, unknown>
      found.push({
        id: extensionId,
        name: localeManifestName(manifest, join(extensionsDir, extensionId, latest)),
        version: safeText(manifest.version, 32) || latest
      })
    } catch {
      // Unreadable manifests are skipped; detection stays best-effort.
    }
    if (found.length >= MAX_EXTENSIONS) break
  }
  return found
}

function readdirSyncSafe(dir: string): string[] {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
  } catch {
    return []
  }
}

function compareVersionDesc(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const [aParts, bParts] = [parts(a), parts(b)]
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const delta = (bParts[index] ?? 0) - (aParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return b.localeCompare(a)
}

/**
 * Copies a source database into a private temp directory before opening it so
 * a running (file-locked) source browser is never opened or mutated in place.
 */
async function copyDatabaseForRead(path: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'vast-import-'))
  try {
    await copyFile(path, join(tempDir, 'db.sqlite'))
    for (const sidecar of ['-wal', '-shm']) {
      if (existsSync(path + sidecar)) {
        try {
          await copyFile(path + sidecar, join(tempDir, 'db.sqlite' + sidecar))
        } catch {
          // Sidecars are optional for a consistent-enough snapshot.
        }
      }
    }
    return join(tempDir, 'db.sqlite')
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function withCopiedDatabase<T>(path: string, run: (db: DatabaseSync) => T): Promise<T> {
  const copiedPath = await copyDatabaseForRead(path)
  const tempDir = resolve(copiedPath, '..')
  let db: DatabaseSync | null = null
  try {
    // Chromium timestamps exceed Number.MAX_SAFE_INTEGER, so wide integers
    // must come back as BigInt and be narrowed explicitly.
    db = new DatabaseSync(copiedPath, { readBigInts: true })
    return run(db)
  } finally {
    db?.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const unavailable = (message: string): BrowserImportRunResult['categories']['bookmarks'] => ({ status: 'unavailable', message })

/** First occurrence of a URL wins; later duplicates collapse. */
function dedupeBookmarks(bookmarks: ImportedBookmarkEntry[]): ImportedBookmarkEntry[] {
  const seen = new Set<string>()
  return bookmarks.filter((bookmark) => {
    if (seen.has(bookmark.url)) return false
    seen.add(bookmark.url)
    return true
  })
}

function validateRequest(request: BrowserImportRequest): string | null {
  if (!isRecord(request)) return 'Invalid import request.'
  if (!BROWSER_IMPORT_SOURCE_IDS.includes(request.sourceId)) return 'Unknown import source.'
  if (!safeProfileId(request.profileId)) return 'Invalid profile.'
  if (!Array.isArray(request.types) || request.types.length === 0 || request.types.some((type) => !BROWSER_IMPORT_DATA_TYPES.includes(type))) {
    return 'Invalid import selection.'
  }
  return null
}

export async function runBrowserImport(request: BrowserImportRequest): Promise<BrowserImportRunResult> {
  const invalid = validateRequest(request)
  if (invalid) return importFailure(invalid)

  const profileId = safeProfileId(request.profileId)!
  const roots = userDataRoots()
  const baseDir = request.sourceId === 'firefox' ? roots.firefoxProfiles : request.sourceId === 'edge' ? roots.edge : roots.chrome
  if (!baseDir) return importFailure('Browser data locations are not available on this system.')
  const profileDir = profilePath(baseDir, profileId)
  if (!profileDir || !existsSync(profileDir)) return importFailure('The selected browser profile could not be found.')

  const result: BrowserImportRunResult = {
    ok: true,
    sourceId: request.sourceId,
    sourceName: BROWSER_IMPORT_SOURCE_NAMES[request.sourceId],
    bookmarks: [],
    history: [],
    extensions: [],
    categories: {
      bookmarks: { status: 'empty' },
      history: { status: 'empty' },
      extensions: { status: 'empty' }
    }
  }
  const wants = (type: BrowserImportDataType): boolean => request.types.includes(type)
  const isChromium = request.sourceId === 'chrome' || request.sourceId === 'edge'

  if (wants('bookmarks')) {
    try {
      if (isChromium) {
        result.bookmarks = dedupeBookmarks(readChromiumBookmarks(profileDir))
      } else {
        result.bookmarks = dedupeBookmarks(await withCopiedDatabase(join(profileDir, 'places.sqlite'), readFirefoxBookmarks))
      }
      result.categories.bookmarks = result.bookmarks.length > 0
        ? { status: 'imported' }
        : { status: 'empty', message: 'No bookmarks were found in this profile.' }
    } catch {
      result.categories.bookmarks = {
        status: 'failed',
        message: 'Bookmarks could not be read. The profile may be locked by the source browser.'
      }
    }
  }

  if (wants('history')) {
    try {
      const historyPath = isChromium ? join(profileDir, 'History') : join(profileDir, 'places.sqlite')
      result.history = await withCopiedDatabase(historyPath, isChromium ? readChromiumHistory : readFirefoxHistory)
      result.categories.history = result.history.length > 0
        ? { status: 'imported' }
        : { status: 'empty', message: 'No browsing history was found in this profile.' }
    } catch {
      result.categories.history = {
        status: 'failed',
        message: 'History could not be read. The profile may be locked by the source browser.'
      }
    }
  }

  if (wants('extensions')) {
    if (isChromium) {
      try {
        result.extensions = detectChromiumExtensions(profileDir)
        result.categories.extensions = result.extensions.length > 0
          ? { status: 'imported' }
          : { status: 'empty', message: 'No extensions were found in this profile.' }
      } catch {
        result.categories.extensions = { status: 'failed', message: 'Extensions could not be read from this profile.' }
      }
    } else {
      result.categories.extensions = unavailable('Extension detection is available for Chrome and Edge profiles.')
    }
  }

  return result
}

function importFailure(error: string): BrowserImportRunResult {
  return {
    ok: false,
    error,
    bookmarks: [],
    history: [],
    extensions: [],
    categories: {
      bookmarks: { status: 'failed' },
      history: { status: 'failed' },
      extensions: { status: 'failed' }
    }
  }
}
