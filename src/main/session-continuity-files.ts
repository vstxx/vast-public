import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { VAST_DEFAULT_WEBVIEW_PARTITION } from '../shared/oauth.ts'

const migrationVersion = 1
const migrationMarkerName = `default-session-to-vast-default-v${migrationVersion}.json`

// Durable Chromium stores used by websites. Rebuildable caches stay excluded.
export const LEGACY_DEFAULT_SESSION_ITEMS = [
  'Network',
  'Cookies',
  'Cookies-journal',
  'Preferences',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Service Worker',
  'WebStorage',
  'SharedStorage',
  'SharedStorage-wal',
  'SharedStorage-shm',
  'Shared Dictionary',
  'DIPS',
  'DIPS-wal',
  'DIPS-shm',
  'Trust Tokens',
  'Trust Tokens-journal',
  'QuotaManager',
  'QuotaManager-journal',
  'File System',
  'databases',
  'Platform Notifications'
] as const

export interface LegacySessionMigrationPlan {
  needed: boolean
  sourceRoot: string
  targetRoot: string
  markerPath: string
  sourceItems: string[]
  copiedItems: string[]
  preservedTargetItems: string[]
}

function partitionDirectoryName(partition: string): string {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition
}

function hasContent(path: string): boolean {
  try {
    const info = statSync(path)
    if (info.isFile()) return info.size > 0
    if (info.isDirectory()) return readdirSync(path).length > 0
  } catch {
    // Missing or unreadable items cannot be migrated.
  }
  return false
}

function copyMissingStore(source: string, target: string): boolean {
  if (existsSync(target)) return false
  mkdirSync(dirname(target), { recursive: true })
  if (statSync(source).isDirectory()) {
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
  } else {
    copyFileSync(source, target)
  }
  return true
}

export function writeLegacySessionMigrationMarker(
  plan: LegacySessionMigrationPlan,
  details: Record<string, unknown>
): void {
  mkdirSync(dirname(plan.markerPath), { recursive: true })
  writeFileSync(plan.markerPath, `${JSON.stringify({
    migrationVersion,
    source: 'default',
    target: VAST_DEFAULT_WEBVIEW_PARTITION,
    completedAt: new Date().toISOString(),
    copiedItems: plan.copiedItems,
    preservedTargetItems: plan.preservedTargetItems,
    ...details
  }, null, 2)}\n`, 'utf8')
}

/** Stages closed Chromium stores without ever overwriting a new-partition store. */
export function prepareLegacyDefaultSessionFiles(sessionDataRoot: string): LegacySessionMigrationPlan {
  const targetRoot = join(sessionDataRoot, 'Partitions', partitionDirectoryName(VAST_DEFAULT_WEBVIEW_PARTITION))
  const markerPath = join(sessionDataRoot, '.vast-migrations', migrationMarkerName)
  const plan: LegacySessionMigrationPlan = {
    needed: !existsSync(markerPath),
    sourceRoot: sessionDataRoot,
    targetRoot,
    markerPath,
    sourceItems: [],
    copiedItems: [],
    preservedTargetItems: []
  }
  if (!plan.needed) return plan

  plan.sourceItems = LEGACY_DEFAULT_SESSION_ITEMS.filter((item) => hasContent(join(sessionDataRoot, item)))
  if (plan.sourceItems.length === 0) {
    writeLegacySessionMigrationMarker(plan, { sourceItems: 0, importedCookies: 0 })
    plan.needed = false
    return plan
  }

  mkdirSync(targetRoot, { recursive: true })
  for (const item of plan.sourceItems) {
    const source = join(sessionDataRoot, item)
    const target = join(targetRoot, item)
    if (copyMissingStore(source, target)) plan.copiedItems.push(item)
    else plan.preservedTargetItems.push(item)
  }
  return plan
}

export function readLegacySessionMigrationMarker(markerPath: string): unknown {
  return JSON.parse(readFileSync(markerPath, 'utf8'))
}
