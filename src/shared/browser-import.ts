import type { ExtensionPackagePreview, ExtensionPermissionSnapshot } from './extension-marketplace'

export type BrowserImportSourceId = 'chrome' | 'edge' | 'firefox'

export const BROWSER_IMPORT_SOURCE_IDS: readonly BrowserImportSourceId[] = ['chrome', 'edge', 'firefox']

export const BROWSER_IMPORT_SOURCE_NAMES: Record<BrowserImportSourceId, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox'
}

export interface BrowserImportProfileInfo {
  /** Opaque discovered profile ID; never a filesystem path. */
  id: string
  name: string
}

export interface BrowserImportPrepareRequest {
  sourceId: BrowserImportSourceId
  profileId: string
  types: BrowserImportDataType[]
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
  /** Stable source identity. URL alone is not a bookmark key. */
  sourceItemId: string
  root: 'bar' | 'other' | 'mobile' | 'menu' | 'unfiled'
  /** Source folder IDs matching folderPath, outermost first. */
  folderSourceIds: string[]
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
  sourceEnabled: boolean
  manifestVersion: 2 | 3 | null
  state: 'detected' | 'unsupported' | 'failed'
  limitationCodes: string[]
  /** Hash of bounded source metadata, not a claim that the full directory is trusted. */
  fingerprint: string
}

/** `imported` is kept only for the legacy run() caller until onboarding migrates to preview/commit. */
export type BrowserImportCategoryStatus = 'ready' | 'imported' | 'empty' | 'unavailable' | 'failed'

export interface BrowserImportCategoryResult {
  status: BrowserImportCategoryStatus
  message?: string
  skipped?: number
  /** Stable path-free diagnostic for prepared source categories. */
  code?: 'SOURCE_UNAVAILABLE' | 'SOURCE_INVALID' | 'SOURCE_LIMIT_EXCEEDED' | 'SOURCE_READ_FAILED'
}

export function browserImportProblemMessage(result: BrowserImportCategoryResult): string {
  switch (result.code) {
    case 'SOURCE_READ_FAILED': return 'Could not read this source. If the other browser is open, close it and retry; otherwise check file access.'
    case 'SOURCE_INVALID': return 'Source data is invalid or damaged. Nothing from this category was saved.'
    case 'SOURCE_LIMIT_EXCEEDED': return 'Source exceeds the safe import limit. Nothing from this category was saved.'
    case 'SOURCE_UNAVAILABLE': return 'Source data is unavailable. Choose another profile or retry after closing the other browser.'
    default: return result.status === 'unavailable' ? 'This category is unavailable for this browser.' : 'Could not prepare this category.'
  }
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

/** Main-owned, prepared source data. Never exposed to a renderer before redaction. */
export interface BrowserSourceSnapshot {
  sourceId: BrowserImportSourceId
  profileId: string
  bookmarks: ImportedBookmarkEntry[]
  history: ImportedHistoryEntry[]
  extensions: DetectedExtensionInfo[]
  categories: Record<BrowserImportDataType, BrowserImportCategoryResult>
}

export interface BrowserImportCommitCount {
  added: number
  updated: number
  skipped: number
  failed: number
  evicted: number
}

/** Stored with the candidate so a lost IPC acknowledgement can be reconciled. */
export interface BrowserImportCommitReceipt {
  operationId: string
  sourceId: BrowserImportSourceId
  profileId: string
  committedAt: number
  counts: Record<'bookmarks' | 'history', BrowserImportCommitCount>
}

export interface BrowserImportExtensionReceipt {
  id: string
  status: 'installed' | 'partial compatibility' | 'unsupported' | 'failed' | 'already installed' | 'declined'
  recordedAt: number
  message?: string
}

export type BrowserImportExtensionPreparation =
  | { kind: 'preview'; preview: ExtensionPackagePreview }
  | { kind: 'result'; receipt: BrowserImportExtensionReceipt }

export interface BrowserImportExtensionConfirmRequest {
  operationId: string
  extensionId: string
  token: string
  approval: ExtensionPermissionSnapshot
}

/** A read-only summary; source paths and imported URL/title data remain in main. */
export interface BrowserImportPreview {
  token: string
  sourceId: BrowserImportSourceId
  profileId: string
  selected: BrowserImportDataType[]
  detected: Record<BrowserImportDataType, number>
  /** Source metadata only; no profile paths, package bytes or private storage. */
  detectedExtensions: DetectedExtensionInfo[]
  categories: Record<BrowserImportDataType, BrowserImportCategoryResult>
  expiresAt: number
}

export interface BrowserImportCommitRequest {
  token: string
  acceptPartial: boolean
  selectedExtensionIds: string[]
}

export interface BrowserImportStatus {
  preview?: BrowserImportPreview
  receipt?: BrowserImportCommitReceipt
  generation: number
  pendingExtensionIds: string[]
  extensionReceipts: BrowserImportExtensionReceipt[]
}
