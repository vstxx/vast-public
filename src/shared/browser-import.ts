export type BrowserImportSourceId = 'chrome' | 'edge' | 'firefox'

export const BROWSER_IMPORT_SOURCE_IDS: readonly BrowserImportSourceId[] = ['chrome', 'edge', 'firefox']

export const BROWSER_IMPORT_SOURCE_NAMES: Record<BrowserImportSourceId, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox'
}

export interface BrowserImportProfileInfo {
  /** Opaque profile directory name; safe to echo back to the importer. */
  id: string
  name: string
}

export interface BrowserImportSourceInfo {
  id: BrowserImportSourceId
  name: string
  /** False when the browser is not installed / no profile data exists. */
  available: boolean
  profiles: BrowserImportProfileInfo[]
}

export interface BrowserImportCatalog {
  sources: BrowserImportSourceInfo[]
}

export type BrowserImportDataType = 'bookmarks' | 'history' | 'extensions'

export const BROWSER_IMPORT_DATA_TYPES: readonly BrowserImportDataType[] = ['bookmarks', 'history', 'extensions']

export interface BrowserImportRequest {
  sourceId: BrowserImportSourceId
  profileId: string
  types: BrowserImportDataType[]
}

export interface ImportedBookmarkEntry {
  title: string
  url: string
  /** Folder chain, outermost first; empty for top-level bookmarks. */
  folderPath: string[]
}

export interface ImportedHistoryEntry {
  title: string
  url: string
  visitCount: number
  lastVisitedAt: number
}

export interface DetectedExtensionInfo {
  id: string
  name: string
  version: string
}

export type BrowserImportCategoryStatus = 'imported' | 'empty' | 'unavailable' | 'failed'

export interface BrowserImportCategoryResult {
  status: BrowserImportCategoryStatus
  message?: string
}

export interface BrowserImportRunResult {
  ok: boolean
  error?: string
  sourceId?: BrowserImportSourceId
  sourceName?: string
  bookmarks: ImportedBookmarkEntry[]
  history: ImportedHistoryEntry[]
  extensions: DetectedExtensionInfo[]
  categories: Record<BrowserImportDataType, BrowserImportCategoryResult>
}
