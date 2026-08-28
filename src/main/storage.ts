import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_DATA, STORAGE_SCHEMA_VERSION } from '../shared/constants'
import { migrateLegacyInternalTab, migrateLegacySessionSnapshot, stripRetiredReaderState } from '../shared/legacy-internal-url-migration'
import { resolveLayoutMode } from '../shared/layout-mode'
import { mergePersistedDataForMigration } from '../shared/storage-schema-migration'
import type { BrowserSettings, DownloadItem, PersistedData, SitePermissionOverride, StorageBackupInfo, StorageRecoveryState } from '../shared/types'
import { dataFilePath, vastDataPath } from './data-path'
import { recordStorageWrite } from './performance-probe'
import { LatestTaskQueue } from './latest-task-queue'
import { readTextWithRetry } from './storage-read-retry'

const storageFileName = 'vast-data.json'
const storageBackupFolderName = 'storage-backups'
const maxStorageBytes = 8 * 1024 * 1024
const maxRollingBackups = 12
const rollingBackupIntervalMs = 60_000
const maxManualBackups = 24
const arrayLimits = {
  workspaces: 100,
  tabGroups: 300,
  tabs: 1200,
  recentlyClosedTabs: 80,
  bookmarks: 5000,
  bookmarkFolders: 1000,
  history: 1200,
  downloads: 250,
  notes: 1000,
  readingList: 1200,
  quickLinks: 24,
  siteMemory: 300,
  todos: 300,
  macros: 200,
  macroLogs: 250,
  sessionSnapshots: 100,
  recentCommandIds: 32
} as const
let cachedData: PersistedData | null = null
let lastWrittenSerialized: string | null = null
let lastRollingBackupAt = 0
let lastRecoveryState: StorageRecoveryState = { active: false }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function storagePath(): string {
  return dataFilePath(storageFileName)
}

function storageBackupDir(): string {
  return join(vastDataPath(), storageBackupFolderName)
}

function backupId(kind: StorageBackupInfo['kind'], createdAt = Date.now()): string {
  return `${kind}-${createdAt}.json`
}

function backupKindFromId(id: string): StorageBackupInfo['kind'] {
  if (id.startsWith('manual-')) return 'manual'
  if (id.startsWith('invalid-')) return 'invalid'
  if (id.startsWith('pre-import-')) return 'pre-import'
  if (id.startsWith('pre-restore-')) return 'pre-restore'
  return 'rolling'
}

function backupCreatedAtFromId(id: string): number {
  const match = id.match(/(\d{11,})/)
  return match ? Number(match[1]) : 0
}

function assertBackupId(id: string): void {
  if (!/^(rolling|manual|invalid|pre-import|pre-restore)-\d{11,}\.json$/.test(id)) {
    throw new Error('Invalid backup id.')
  }
}

function backupPathForId(id: string): string {
  assertBackupId(id)
  const baseDir = resolve(storageBackupDir())
  const file = resolve(join(baseDir, basename(id)))
  const rel = relative(baseDir, file)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid backup path.')
  return file
}

function cloneDefaultData(): PersistedData {
  const data = JSON.parse(JSON.stringify(DEFAULT_DATA)) as PersistedData
  const now = Date.now()
  data.workspaces = data.workspaces.map((workspace) => ({
    ...workspace,
    createdAt: now,
    updatedAt: now
  }))
  data.tabs = data.tabs.map((tab) => ({
    ...tab,
    createdAt: now,
    lastAccessedAt: now
  }))
  return data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasSettingsShape(value: unknown): boolean {
  if (!isRecord(value)) return false
  const sections = ['appearance', 'privacy', 'advanced', 'security', 'network']
  return sections.every((key) => value[key] === undefined || isRecord(value[key]))
}

export function assertStorageTextSize(raw: string): void {
  if (raw.length > maxStorageBytes) {
    throw new Error('Vast data file is too large to import safely.')
  }
}

async function safeBackupInfo(id: string): Promise<StorageBackupInfo | null> {
  try {
    assertBackupId(id)
    const file = backupPathForId(id)
    const info = await stat(file)
    return {
      id,
      path: file,
      createdAt: backupCreatedAtFromId(id) || info.mtimeMs,
      sizeBytes: info.size,
      kind: backupKindFromId(id)
    }
  } catch {
    return null
  }
}

async function trimBackups(kind: StorageBackupInfo['kind'], keep: number): Promise<void> {
  try {
    const backups = (await listStorageBackups())
      .filter((backup) => backup.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    await Promise.all(backups.slice(keep).map((backup) => rm(backup.path, { force: true })))
  } catch (error) {
    console.warn('[storage] Could not trim backups:', error)
  }
}

async function copyActiveStorageToBackup(kind: StorageBackupInfo['kind']): Promise<StorageBackupInfo | null> {
  const source = storagePath()
  const directory = storageBackupDir()
  const id = backupId(kind)
  const target = join(directory, id)
  try {
    await stat(source)
  } catch {
    return null
  }
  await mkdir(directory, { recursive: true })
  await copyFile(source, target)
  if (kind === 'rolling') await trimBackups('rolling', maxRollingBackups)
  if (kind === 'manual') await trimBackups('manual', maxManualBackups)
  return safeBackupInfo(id)
}

export async function createStorageBackup(kind: StorageBackupInfo['kind'] = 'manual'): Promise<StorageBackupInfo | null> {
  if (!['rolling', 'manual', 'invalid', 'pre-import', 'pre-restore'].includes(kind)) {
    throw new Error('Invalid backup kind.')
  }
  return copyActiveStorageToBackup(kind)
}

export async function listStorageBackups(): Promise<StorageBackupInfo[]> {
  try {
    const entries = await readdir(storageBackupDir())
    const backups = await Promise.all(entries.map((entry) => safeBackupInfo(entry)))
    return backups
      .filter((backup): backup is StorageBackupInfo => Boolean(backup))
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function getStorageRecoveryState(): StorageRecoveryState {
  return lastRecoveryState
}

function arrayWithinLimit(value: unknown, key: keyof typeof arrayLimits, required = true): boolean {
  if (value === undefined) return !required
  return Array.isArray(value) && value.length <= arrayLimits[key] * 2
}

function boundedArray<T>(
  value: unknown,
  fallback: T[],
  key: keyof typeof arrayLimits,
  maxItemBytes = 128 * 1024,
  guard: (item: unknown) => item is T = (_item): _item is T => true
): T[] {
  if (!Array.isArray(value)) return fallback
  const next: T[] = []
  for (const item of value.slice(0, arrayLimits[key])) {
    try {
      if (!guard(item)) continue
      const serialized = JSON.stringify(item)
      if (serialized.length <= maxItemBytes) next.push(JSON.parse(serialized) as T)
    } catch {
      // Drop malformed or non-serializable imported records.
    }
  }
  return next
}

function finiteNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function safeString(value: unknown, maxLength = 64 * 1024, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0)
}

function safeId(value: unknown): value is string {
  return safeString(value, 256, false)
}

function optionalString(value: unknown, maxLength = 64 * 1024): boolean {
  return value === undefined || safeString(value, maxLength)
}

function optionalId(value: unknown): boolean {
  return value === undefined || safeId(value)
}

function storedUrl(value: unknown, allowInternal = true): value is string {
  if (!safeString(value, 128 * 1024, false)) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || (allowInternal && parsed.protocol === 'vast:')
  } catch {
    return false
  }
}

function optionalFavicon(value: unknown): boolean {
  if (value === undefined) return true
  if (!safeString(value, 256 * 1024)) return false
  if (value.startsWith('data:image/')) return true
  return storedUrl(value, false)
}

const entityGuards = {
  workspace(item: unknown): item is PersistedData['workspaces'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.name, 512, false) && safeString(item.icon, 128) && safeString(item.color, 128) &&
      finiteNumber(item.order, -10_000, 10_000) && optionalId(item.activeTabId) && (item.isPrivate === undefined || typeof item.isPrivate === 'boolean') &&
      (item.identity === undefined || isRecord(item.identity) &&
        ['isolated', 'shared', 'ephemeral'].includes(String(item.identity.sessionMode)) &&
        ['system', 'direct', 'fixed'].includes(String(item.identity.proxyMode)) &&
        safeString(item.identity.proxyServer, 2_048) && safeString(item.identity.proxyBypassRules, 2_048)) &&
      finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
  },
  tabGroup(item: unknown): item is PersistedData['tabGroups'][number] {
    return isRecord(item) && safeId(item.id) && safeId(item.workspaceId) && safeString(item.name, 512, false) && safeString(item.color, 128) &&
      typeof item.collapsed === 'boolean' && finiteNumber(item.order, -10_000, 10_000)
  },
  tab(item: unknown): item is PersistedData['tabs'][number] {
    return isRecord(item) && safeId(item.id) && safeId(item.workspaceId) && optionalId(item.identityWorkspaceId) && optionalId(item.groupId) && safeString(item.title, 4_096) && storedUrl(item.url) &&
      optionalString(item.displayUrl, 128 * 1024) && optionalFavicon(item.favicon) && typeof item.pinned === 'boolean' &&
      (item.muted === undefined || typeof item.muted === 'boolean') &&
      ['idle', 'loading', 'error'].includes(String(item.status)) && ['active', 'sleeping', 'discarded', 'crashed'].includes(String(item.lifecycle)) &&
      finiteNumber(item.progress, 0, 1) && typeof item.canGoBack === 'boolean' && typeof item.canGoForward === 'boolean' && finiteNumber(item.zoom, 0.25, 5) &&
      finiteNumber(item.lastAccessedAt) && finiteNumber(item.createdAt)
  },
  recentlyClosed(item: unknown): item is PersistedData['recentlyClosedTabs'][number] {
    return isRecord(item) && safeId(item.id) && safeId(item.workspaceId) && safeString(item.title, 4_096) && storedUrl(item.url) && optionalFavicon(item.favicon) && finiteNumber(item.closedAt)
  },
  bookmark(item: unknown): item is PersistedData['bookmarks'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 4_096) && storedUrl(item.url) && optionalFavicon(item.favicon) && optionalId(item.folderId) && optionalId(item.workspaceId) && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
  },
  bookmarkFolder(item: unknown): item is PersistedData['bookmarkFolders'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.name, 1_024, false) && optionalId(item.parentId) && finiteNumber(item.order, -10_000, 10_000) && finiteNumber(item.createdAt) && (item.updatedAt === undefined || finiteNumber(item.updatedAt))
  },
  history(item: unknown): item is PersistedData['history'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 4_096) && storedUrl(item.url) && optionalFavicon(item.favicon) && finiteNumber(item.visitCount, 0, 1_000_000) && finiteNumber(item.lastVisitedAt) && optionalId(item.workspaceId)
  },
  download(item: unknown): item is PersistedData['downloads'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.filename, 4_096, false) && storedUrl(item.url, false) && optionalString(item.mimeType, 512) && optionalString(item.savePath, 32_768) && optionalString(item.sha256, 128) &&
      finiteNumber(item.receivedBytes) && finiteNumber(item.totalBytes) && ['progressing', 'completed', 'cancelled', 'interrupted'].includes(String(item.state)) &&
      (item.paused === undefined || typeof item.paused === 'boolean') && (item.bytesPerSecond === undefined || finiteNumber(item.bytesPerSecond, 0, 1_000_000_000_000)) && optionalString(item.dangerType, 512) &&
      (item.scanStatus === undefined || ['pending', 'scanning', 'clean', 'suspicious', 'dangerous', 'scan-unavailable', 'scan-failed'].includes(String(item.scanStatus))) &&
      (item.scanFindings === undefined || Array.isArray(item.scanFindings) && item.scanFindings.length <= 100 && item.scanFindings.every((finding) => safeString(finding, 8_192))) &&
      optionalString(item.scannedSha256, 128) && (item.scanCompletedAt === undefined || finiteNumber(item.scanCompletedAt)) && finiteNumber(item.startedAt) && finiteNumber(item.updatedAt)
  },
  note(item: unknown): item is PersistedData['notes'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 8_192) && safeString(item.body, 256 * 1024) &&
      (item.tags === undefined || Array.isArray(item.tags) && item.tags.length <= 100 && item.tags.every((tag) => safeString(tag, 256, false))) &&
      (item.url === undefined || storedUrl(item.url)) && optionalId(item.workspaceId) && optionalId(item.linkedTabId) && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
  },
  readingList(item: unknown): item is PersistedData['readingList'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 4_096) && storedUrl(item.url) && optionalFavicon(item.favicon) && optionalId(item.workspaceId) && optionalString(item.excerpt, 32_768) && typeof item.read === 'boolean' && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
  },
  quickLink(item: unknown): item is PersistedData['quickLinks'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 1_024) && storedUrl(item.url) && safeString(item.color, 128)
  },
  siteMemory(item: unknown): item is PersistedData['siteMemory'][number] {
    return isRecord(item) && safeString(item.origin, 4_096, false) && safeString(item.hostname, 1_024, false) && optionalString(item.title, 4_096) && optionalFavicon(item.favicon) &&
      (item.lastUrl === undefined || storedUrl(item.lastUrl)) && (item.zoom === undefined || finiteNumber(item.zoom, 0.25, 5)) && finiteNumber(item.visitCount, 0, 1_000_000) && finiteNumber(item.lastUsedAt) && finiteNumber(item.updatedAt)
  },
  todo(item: unknown): item is PersistedData['todos'][number] {
    return isRecord(item) && safeId(item.id) && optionalId(item.workspaceId) && safeString(item.title, 8_192, false) && typeof item.completed === 'boolean' && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt)
  },
  macro(item: unknown): item is PersistedData['macros'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.name, 1_024, false) && safeString(item.description, 8_192) && safeString(item.icon, 128) && safeString(item.color, 128) && safeString(item.trigger, 128, false) &&
      Array.isArray(item.actions) && item.actions.length <= 100 && item.actions.every((action) => isRecord(action) && safeId(action.id) && safeString(action.type, 128, false)) &&
      typeof item.enabled === 'boolean' && finiteNumber(item.createdAt) && finiteNumber(item.updatedAt) && (item.lastRunAt === undefined || finiteNumber(item.lastRunAt))
  },
  macroLog(item: unknown): item is PersistedData['macroLogs'][number] {
    return isRecord(item) && safeId(item.id) && safeId(item.macroId) && safeString(item.macroName, 1_024) && (item.status === 'success' || item.status === 'error') && safeString(item.message, 16_384) && finiteNumber(item.ranAt)
  },
  sessionSnapshot(item: unknown): item is PersistedData['sessionSnapshots'][number] {
    return isRecord(item) && safeId(item.id) && safeString(item.title, 4_096) && optionalId(item.workspaceId) && Array.isArray(item.tabIds) && item.tabIds.length <= arrayLimits.tabs && item.tabIds.every(safeId) &&
      (item.tabs === undefined || Array.isArray(item.tabs) && item.tabs.length <= arrayLimits.tabs && item.tabs.every((tab) => isRecord(tab) && safeString(tab.title, 4_096) && storedUrl(tab.url) && typeof tab.pinned === 'boolean' && finiteNumber(tab.lastAccessedAt))) && finiteNumber(item.createdAt)
  }
}

const enumSettings = new Map<string, ReadonlySet<string>>([
  ['theme', new Set(['dark', 'dim', 'light', 'system'])],
  ['sidebarDensity', new Set(['comfortable', 'compact'])],
  ['layoutMode', new Set(['vertical', 'horizontal', 'purist'])],
  ['tabLayout', new Set(['vertical', 'compact'])],
  ['sidePanel.mode', new Set(['auto', 'docked', 'overlay'])],
  ['startupBehavior', new Set(['restore', 'new-tab', 'home'])],
  ['newTabBehavior', new Set(['vast', 'search', 'blank'])],
  ['privacy.adBlockerMode', new Set(['standard', 'strict', 'custom'])],
  ['privacy.fingerprintingProtection', new Set(['standard', 'strict', 'maximum'])],
  ['privacy.webRtcPolicy', new Set(['public-interface-only', 'default', 'disabled'])],
  ['spoofing.browserProfile', new Set(['chrome-windows', 'chrome-macos', 'firefox-windows', 'safari-macos', 'custom'])],
  ['spoofing.location.mode', new Set(['off', 'fixed'])]
])

function sanitizeSettingsNode(input: unknown, fallback: unknown, path = ''): unknown {
  if (typeof fallback === 'boolean') return typeof input === 'boolean' ? input : fallback
  if (typeof fallback === 'number') return finiteNumber(input, -1_000_000, 1_000_000) ? input : fallback
  if (typeof fallback === 'string') {
    const allowed = enumSettings.get(path)
    return safeString(input, 64 * 1024) && (!allowed || allowed.has(input)) ? input : fallback
  }
  if (Array.isArray(fallback)) {
    return Array.isArray(input) && input.length <= 100 && input.every((item) => safeString(item, 1_024)) ? [...input] : [...fallback]
  }
  if (!isRecord(fallback)) return fallback
  const source = isRecord(input) ? input : {}
  const next: Record<string, unknown> = {}
  for (const [key, defaultValue] of Object.entries(fallback)) {
    const childPath = path ? `${path}.${key}` : key
    next[key] = sanitizeSettingsNode(source[key], defaultValue, childPath)
  }
  return next
}

function sanitizeBrowserSettings(value: unknown): BrowserSettings {
  const next = sanitizeSettingsNode(value, DEFAULT_DATA.settings) as BrowserSettings
  const source = isRecord(value) ? value : {}
  const security = isRecord(source.security) ? source.security : {}
  next.security.sitePermissions = sanitizeSitePermissions(security.sitePermissions)
  next.advanced.ramLimitMb = sanitizeRamLimitMb(next.advanced.ramLimitMb)
  next.layoutMode = resolveLayoutMode(next.layoutMode, next.advanced.experimentalFeatures)
  next.sidePanel.width = Math.min(520, Math.max(304, Math.round(next.sidePanel.width)))
  return next
}

function sanitizeRamLimitMb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_DATA.settings.advanced.ramLimitMb
  return Math.min(32_768, Math.max(1_024, Math.round(parsed / 256) * 256))
}

function deriveLegacyRamLimitMb(advanced: Record<string, unknown> | undefined): number {
  if (!advanced) return DEFAULT_DATA.settings.advanced.ramLimitMb

  const mode = advanced.ramManagementMode
  const maxActiveRaw = advanced.maxActiveWebviews
  const modeBudget =
    mode === 'saver'
      ? 1_536
      : mode === 'performance'
        ? 4_608
        : 3_072
  const maxActive = typeof maxActiveRaw === 'number' && Number.isFinite(maxActiveRaw) ? Math.min(16, Math.max(1, Math.round(maxActiveRaw))) : 4
  const webviewBudget = 896 + maxActive * 384
  return sanitizeRamLimitMb(Math.max(modeBudget, webviewBudget))
}

function sanitizeSitePermissions(value: unknown): SitePermissionOverride[] {
  if (!Array.isArray(value)) return []
  const knownPermissions = new Set(['camera', 'microphone', 'media', 'geolocation', 'notifications', 'clipboard', 'fullscreen'])
  const next: SitePermissionOverride[] = []
  for (const item of value.slice(0, 500)) {
    if (!isRecord(item)) continue
    const { origin, workspaceId, permission, setting, updatedAt } = item
    if (typeof origin !== 'string' || !origin.startsWith('https://') && !origin.startsWith('http://')) continue
    if (typeof permission !== 'string' || !knownPermissions.has(permission)) continue
    if (setting !== 'allow' && setting !== 'block') continue
    next.push({
      origin,
      workspaceId: optionalId(workspaceId) ? workspaceId as string | undefined : undefined,
      permission: permission as SitePermissionOverride['permission'],
      setting,
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : Date.now()
    })
  }
  return next
}

export function isPersistedData(value: unknown): value is PersistedData {
  if (!isRecord(value)) return false
  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.activeWorkspaceId === 'string' &&
    arrayWithinLimit(value.workspaces, 'workspaces') &&
    arrayWithinLimit(value.tabGroups, 'tabGroups') &&
    arrayWithinLimit(value.tabs, 'tabs') &&
    arrayWithinLimit(value.recentlyClosedTabs, 'recentlyClosedTabs', false) &&
    arrayWithinLimit(value.bookmarks, 'bookmarks') &&
    arrayWithinLimit(value.bookmarkFolders, 'bookmarkFolders') &&
    arrayWithinLimit(value.history, 'history') &&
    arrayWithinLimit(value.downloads, 'downloads') &&
    arrayWithinLimit(value.notes, 'notes') &&
    arrayWithinLimit(value.readingList, 'readingList') &&
    arrayWithinLimit(value.quickLinks, 'quickLinks') &&
    arrayWithinLimit(value.siteMemory, 'siteMemory', false) &&
    arrayWithinLimit(value.todos, 'todos', false) &&
    arrayWithinLimit(value.macros, 'macros', false) &&
    arrayWithinLimit(value.macroLogs, 'macroLogs', false) &&
    arrayWithinLimit(value.sessionSnapshots, 'sessionSnapshots', false) &&
    arrayWithinLimit(value.recentCommandIds, 'recentCommandIds', false) &&
    hasSettingsShape(value.settings)
  )
}

export function migrateData(data: PersistedData): PersistedData {
  const fallback = cloneDefaultData()
  const legacyAdvanced = isRecord(data.settings?.advanced) ? data.settings.advanced : undefined
  const nextRamLimitMb =
    legacyAdvanced && 'ramLimitMb' in legacyAdvanced
      ? sanitizeRamLimitMb(legacyAdvanced.ramLimitMb)
      : deriveLegacyRamLimitMb(legacyAdvanced)
  const settingsInput = JSON.parse(JSON.stringify(data.settings ?? {})) as Record<string, unknown>
  const legacyPrivacy = isRecord(settingsInput.privacy) ? settingsInput.privacy : undefined
  if (legacyPrivacy?.adBlockerMode === 'soft') legacyPrivacy.adBlockerMode = 'standard'
  if (legacyPrivacy?.adBlockerMode === 'brutal') legacyPrivacy.adBlockerMode = 'strict'
  const sanitizedSettings = sanitizeBrowserSettings(settingsInput)
  sanitizedSettings.advanced.ramLimitMb = nextRamLimitMb
  const merged: PersistedData = {
    ...mergePersistedDataForMigration(fallback, data, STORAGE_SCHEMA_VERSION),
    activeSidePanel: ['notes', 'bookmarks', 'history', 'downloads', 'reading-list'].includes(String(data.activeSidePanel))
      ? data.activeSidePanel
      : fallback.activeSidePanel,
    sidePanelOpen: typeof data.sidePanelOpen === 'boolean' ? data.sidePanelOpen : fallback.sidePanelOpen,
    sidebarCollapsed: typeof data.sidebarCollapsed === 'boolean' ? data.sidebarCollapsed : fallback.sidebarCollapsed,
    focusMode: typeof data.focusMode === 'boolean' ? data.focusMode : fallback.focusMode,
    settings: sanitizedSettings,
    splitView: {
      enabled: typeof data.splitView?.enabled === 'boolean' ? data.splitView.enabled : fallback.splitView.enabled,
      primaryTabId: optionalId(data.splitView?.primaryTabId) ? data.splitView?.primaryTabId : undefined,
      secondaryTabId: optionalId(data.splitView?.secondaryTabId) ? data.splitView?.secondaryTabId : undefined,
      ratio: typeof data.splitView?.ratio === 'number' && Number.isFinite(data.splitView.ratio)
        ? Math.min(72, Math.max(28, data.splitView.ratio))
        : 50
    },
    todos: Array.isArray(data.todos) ? data.todos : fallback.todos,
    macros: Array.isArray(data.macros) ? data.macros : fallback.macros,
    macroLogs: Array.isArray(data.macroLogs) ? data.macroLogs : fallback.macroLogs,
    sessionSnapshots: Array.isArray(data.sessionSnapshots) ? data.sessionSnapshots : fallback.sessionSnapshots,
    siteMemory: Array.isArray(data.siteMemory) ? data.siteMemory : fallback.siteMemory,
    recentCommandIds: Array.isArray(data.recentCommandIds) ? data.recentCommandIds : fallback.recentCommandIds
  }

  if (!merged.workspaces.some((workspace) => workspace.id === merged.activeWorkspaceId)) {
    merged.activeWorkspaceId = merged.workspaces[0]?.id ?? fallback.activeWorkspaceId
  }

  merged.workspaces = boundedArray(merged.workspaces, fallback.workspaces, 'workspaces', 24 * 1024, entityGuards.workspace)
    .map((workspace) => ({
      ...workspace,
      identity: workspace.identity ?? {
        sessionMode: workspace.isPrivate ? 'ephemeral' : 'isolated',
        proxyMode: 'system',
        proxyServer: '',
        proxyBypassRules: '<local>'
      }
    }))
  if (merged.workspaces.length === 0) merged.workspaces = fallback.workspaces
  const workspaceIds = new Set(merged.workspaces.map((item) => item.id))
  merged.tabGroups = boundedArray(merged.tabGroups, fallback.tabGroups, 'tabGroups', 16 * 1024, entityGuards.tabGroup)
    .filter((group) => workspaceIds.has(group.workspaceId))
  const groupIds = new Set(merged.tabGroups.map((item) => item.id))
  merged.tabs = boundedArray(merged.tabs, fallback.tabs, 'tabs', 32 * 1024, entityGuards.tab)
    .filter((tab) => workspaceIds.has(tab.workspaceId) && (!tab.identityWorkspaceId || workspaceIds.has(tab.identityWorkspaceId)) && (!tab.groupId || groupIds.has(tab.groupId)))
    .map(migrateLegacyInternalTab)
  merged.recentlyClosedTabs = boundedArray(merged.recentlyClosedTabs, fallback.recentlyClosedTabs, 'recentlyClosedTabs', 16 * 1024, entityGuards.recentlyClosed)
    .filter((tab) => workspaceIds.has(tab.workspaceId))
    .map(migrateLegacyInternalTab)
  merged.bookmarks = boundedArray(merged.bookmarks, fallback.bookmarks, 'bookmarks', 16 * 1024, entityGuards.bookmark)
  merged.bookmarkFolders = boundedArray(merged.bookmarkFolders, fallback.bookmarkFolders, 'bookmarkFolders', 8 * 1024, entityGuards.bookmarkFolder)
  merged.history = boundedArray(merged.history, fallback.history, 'history', 16 * 1024, entityGuards.history)
  merged.downloads = boundedArray(merged.downloads, fallback.downloads, 'downloads', 16 * 1024, entityGuards.download)
  merged.notes = boundedArray(merged.notes, fallback.notes, 'notes', 256 * 1024, entityGuards.note)
  merged.readingList = boundedArray(merged.readingList, fallback.readingList, 'readingList', 24 * 1024, entityGuards.readingList)
  merged.quickLinks = boundedArray(merged.quickLinks, fallback.quickLinks, 'quickLinks', 8 * 1024, entityGuards.quickLink)
  merged.siteMemory = boundedArray(merged.siteMemory, fallback.siteMemory, 'siteMemory', 24 * 1024, entityGuards.siteMemory)
    .map(stripRetiredReaderState)
  merged.todos = boundedArray(merged.todos, fallback.todos, 'todos', 8 * 1024, entityGuards.todo)
  merged.macros = boundedArray(merged.macros, fallback.macros, 'macros', 64 * 1024, entityGuards.macro)
  merged.macroLogs = boundedArray(merged.macroLogs, fallback.macroLogs, 'macroLogs', 16 * 1024, entityGuards.macroLog)
  merged.sessionSnapshots = boundedArray(merged.sessionSnapshots, fallback.sessionSnapshots, 'sessionSnapshots', 128 * 1024, entityGuards.sessionSnapshot)
    .map(migrateLegacySessionSnapshot)
  merged.recentCommandIds = boundedArray(merged.recentCommandIds, fallback.recentCommandIds, 'recentCommandIds', 1024, safeId)

  const activeWorkspace = merged.workspaces.find((workspace) => workspace.id === merged.activeWorkspaceId)
  const primaryTabId = merged.splitView.primaryTabId ?? activeWorkspace?.activeTabId
  const primaryTab = merged.tabs.find((tab) => tab.id === primaryTabId)
  const secondaryTab = merged.tabs.find((tab) => tab.id === merged.splitView.secondaryTabId)
  if (
    !merged.splitView.enabled ||
    !primaryTab ||
    !secondaryTab ||
    primaryTab.id === secondaryTab.id ||
    primaryTab.workspaceId !== activeWorkspace?.id ||
    secondaryTab.workspaceId !== activeWorkspace.id
  ) {
    merged.splitView = { enabled: false, ratio: 50 }
  } else {
    merged.splitView = {
      enabled: true,
      primaryTabId: primaryTab.id,
      secondaryTabId: secondaryTab.id,
      ratio: merged.splitView.ratio ?? 50
    }
  }

  if (!merged.workspaces.some((workspace) => workspace.id === merged.activeWorkspaceId)) {
    merged.activeWorkspaceId = merged.workspaces[0]?.id ?? fallback.activeWorkspaceId
  }

  return merged
}

export function normalizePersistedData(value: unknown): PersistedData {
  if (!isPersistedData(value)) throw new StorageSchemaError('Stored data does not match the Vast storage schema.')
  return migrateData(value)
}

class StorageSchemaError extends Error {
  override name = 'StorageSchemaError'
}

function isStorageCorruptionError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof StorageSchemaError
}

async function findLatestValidStorageBackup(): Promise<{ backup: StorageBackupInfo; data: PersistedData } | null> {
  const backups = (await listStorageBackups()).filter((backup) => backup.kind !== 'invalid')
  for (const backup of backups) {
    try {
      const raw = await readTextWithRetry(backup.path)
      assertStorageTextSize(raw)
      return { backup, data: normalizePersistedData(JSON.parse(raw) as unknown) }
    } catch (error) {
      console.warn(`[storage] Skipping invalid recovery backup ${backup.id}:`, error)
    }
  }
  return null
}

async function recoverCorruptStorage(file: string, raw: string, error: unknown): Promise<PersistedData> {
  const restored = await findLatestValidStorageBackup()
  const rejected = await backupRejectedStorageFile(file, raw)
  if (!rejected) {
    throw new Error('Vast data is corrupt, but a verified safety copy could not be created. The source file was not modified.', {
      cause: error
    })
  }

  const next = restored?.data ?? cloneDefaultData()
  await saveData(next)
  lastRecoveryState = {
    active: true,
    reason: error instanceof Error ? error.message : String(error),
    rejectedPath: file,
    backupPath: rejected.path,
    occurredAt: Date.now()
  }
  console.warn(restored
    ? `[storage] Restored data from ${restored.backup.id} after detecting corrupt active storage.`
    : '[storage] No valid recovery backup was available; initialized default data after preserving corrupt storage.')
  return next
}

export async function loadData(): Promise<PersistedData> {
  if (cachedData) return cachedData

  const file = storagePath()
  let raw: string
  try {
    raw = await readTextWithRetry(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    cachedData = cloneDefaultData()
    await saveData(cachedData)
    return cachedData
  }

  try {
    assertStorageTextSize(raw)
    const parsed = JSON.parse(raw) as unknown
    const parsedSchemaVersion = isRecord(parsed) && typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : -1
    cachedData = normalizePersistedData(parsed)
    if (cachedData.schemaVersion === parsedSchemaVersion) lastWrittenSerialized = JSON.stringify(cachedData)
    if (cachedData.schemaVersion !== parsedSchemaVersion) {
      await saveData(cachedData)
    }
    return cachedData
  } catch (error) {
    if (!isStorageCorruptionError(error)) throw error
    return recoverCorruptStorage(file, raw, error)
  }
}

async function backupRejectedStorageFile(file: string, expectedRaw: string): Promise<StorageBackupInfo | null> {
  try {
    const directory = storageBackupDir()
    const id = backupId('invalid')
    const backupPath = join(directory, id)
    await mkdir(directory, { recursive: true })
    await copyFile(file, backupPath)
    const copiedRaw = await readTextWithRetry(backupPath)
    if (copiedRaw !== expectedRaw) throw new Error('Rejected storage backup verification failed.')
    return await safeBackupInfo(id)
  } catch (backupError) {
    console.warn('[storage] Could not back up rejected data file:', backupError)
    return null
  }
}

async function writeData(data: PersistedData): Promise<void> {
  const writeStartedAt = performance.now()
  const next = normalizePersistedData(data)
  const file = storagePath()
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const serialized = JSON.stringify(next)
  if (serialized === lastWrittenSerialized) return
  assertStorageTextSize(serialized)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, `${serialized}\n`, 'utf8')
  let rollingBackupCreated = false
  if (Date.now() - lastRollingBackupAt >= rollingBackupIntervalMs) {
    await copyActiveStorageToBackup('rolling').then((backup) => {
      rollingBackupCreated = Boolean(backup)
      if (backup) lastRollingBackupAt = Date.now()
    }).catch((error) => {
      console.warn('[storage] Could not create rolling backup before save:', error)
    })
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file)
      break
    } catch (error) {
      if (attempt >= 4) {
        await unlink(tmp).catch(() => undefined)
        throw error
      }
      await delay(35 * (attempt + 1))
    }
  }
  cachedData = next
  lastWrittenSerialized = serialized
  recordStorageWrite(Buffer.byteLength(serialized) + 1, performance.now() - writeStartedAt, rollingBackupCreated)
}

const durableSaveQueue = new LatestTaskQueue<PersistedData>(writeData)

export async function saveData(data: PersistedData): Promise<void> {
  await durableSaveQueue.run(data)
}

export async function clearHistory(): Promise<PersistedData> {
  const data = await loadData()
  const next = { ...data, history: [] }
  await saveData(next)
  return next
}

export async function upsertDownload(download: DownloadItem): Promise<void> {
  const data = await loadData()
  const downloads = data.downloads.filter((item) => item.id !== download.id)
  downloads.unshift(download)
  await saveData({ ...data, downloads: downloads.slice(0, 200) })
}

export async function clearCompletedDownloads(): Promise<void> {
  const data = await loadData()
  const downloads = data.downloads.filter((item) => item.state !== 'completed' && item.state !== 'cancelled')
  await saveData({ ...data, downloads })
}

export async function replaceDataFromImport(data: PersistedData): Promise<PersistedData> {
  const next = migrateData(data)
  await createStorageBackup('pre-import')
  await saveData(next)
  return next
}

export async function restoreStorageBackup(id: string): Promise<PersistedData> {
  const file = backupPathForId(id)
  const raw = await readFile(file, 'utf8')
  assertStorageTextSize(raw)
  const parsed = JSON.parse(raw) as unknown
  if (!isPersistedData(parsed)) throw new Error('Selected backup is not valid Vast data.')
  await createStorageBackup('pre-restore')
  const next = migrateData(parsed)
  await saveData(next)
  return next
}
