import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  BROWSER_IMPORT_SOURCE_NAMES,
  type BrowserImportCatalog,
  type BrowserImportProfileInfo,
  type BrowserImportSourceId
} from '../../shared/browser-import.ts'

const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024
const MAX_PROFILES_INI_BYTES = 1024 * 1024
const MAX_PROFILE_ENTRIES = 256
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/

export interface ResolvedImportSource {
  sourceId: BrowserImportSourceId
  profileId: string
  canonicalPath: string
}

interface DiscoveredProfile extends BrowserImportProfileInfo {
  canonicalPath: string
}

function inside(root: string, candidate: string): boolean {
  const next = relative(root, candidate)
  return next === '' || (next !== '..' && !next.startsWith(`..${sep}`) && !isAbsolute(next))
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128)
  return name || fallback
}

async function limitedText(file: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function validDirectory(path: string, root?: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory()) return undefined
    const canonical = await realpath(path)
    if (root && !inside(root, canonical)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

async function hasProfileFile(root: string, name: string): Promise<boolean> {
  try {
    const file = join(root, name)
    const info = await lstat(file)
    return info.isFile() && inside(root, await realpath(file))
  } catch {
    return false
  }
}

function roots(): { chrome?: string; edge?: string; firefox?: string } {
  const local = process.env.LOCALAPPDATA?.trim()
  const roaming = process.env.APPDATA?.trim()
  return {
    ...(local ? {
      chrome: join(local, 'Google', 'Chrome', 'User Data'),
      edge: join(local, 'Microsoft', 'Edge', 'User Data')
    } : {}),
    ...(roaming ? { firefox: join(roaming, 'Mozilla', 'Firefox') } : {})
  }
}

async function chromiumProfiles(userDataDir: string | undefined): Promise<DiscoveredProfile[]> {
  if (!userDataDir) return []
  const canonicalRoot = await validDirectory(userDataDir)
  if (!canonicalRoot) return []
  const stateText = await limitedText(join(canonicalRoot, 'Local State'), MAX_LOCAL_STATE_BYTES)
  let infoCache: Record<string, unknown> = {}
  if (stateText) {
    try {
      const state = JSON.parse(stateText) as Record<string, unknown>
      const profile = state.profile as Record<string, unknown> | undefined
      if (profile?.info_cache && typeof profile.info_cache === 'object' && !Array.isArray(profile.info_cache)) {
        infoCache = profile.info_cache as Record<string, unknown>
      }
    } catch {
      // Invalid Local State is metadata loss, not a reason to miss usable profiles.
    }
  }
  const entries = await readdir(canonicalRoot, { withFileTypes: true }).catch(() => [])
  const profiles: DiscoveredProfile[] = []
  for (const entry of entries.slice(0, MAX_PROFILE_ENTRIES)) {
    if (!entry.isDirectory() || !PROFILE_ID.test(entry.name) || ['System Profile', 'Guest Profile', 'Crashpad'].includes(entry.name)) continue
    const canonicalPath = await validDirectory(join(canonicalRoot, entry.name), canonicalRoot)
    if (!canonicalPath) continue
    if (!await hasProfileFile(canonicalPath, 'Bookmarks') && !await hasProfileFile(canonicalPath, 'History') && !await hasProfileFile(canonicalPath, 'Preferences')) continue
    const cached = infoCache[entry.name]
    const displayName = cached && typeof cached === 'object' && !Array.isArray(cached)
      ? safeName((cached as Record<string, unknown>).name, entry.name)
      : entry.name
    profiles.push({ id: entry.name, name: displayName, canonicalPath })
  }
  return profiles
}

function iniProfiles(text: string): Array<Record<string, string>> {
  const result: Array<Record<string, string>> = []
  let current: Record<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^\[Profile\d+\]$/i.test(line)) {
      current = {}
      result.push(current)
      if (result.length >= MAX_PROFILE_ENTRIES) break
      continue
    }
    if (line.startsWith('[')) { current = undefined; continue }
    if (!current || !line || line.startsWith(';') || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals > 0) current[line.slice(0, equals).trim()] = line.slice(equals + 1).trim()
  }
  return result
}

async function firefoxProfiles(firefoxRoot: string | undefined): Promise<DiscoveredProfile[]> {
  if (!firefoxRoot) return []
  const canonicalRoot = await validDirectory(firefoxRoot)
  if (!canonicalRoot) return []
  const standardRoot = await validDirectory(join(canonicalRoot, 'Profiles'), canonicalRoot)
  const profiles: DiscoveredProfile[] = []
  const seen = new Set<string>()
  const add = async (path: string, name: string, relativeToRoot: boolean): Promise<void> => {
    const canonicalPath = await validDirectory(path, relativeToRoot ? canonicalRoot : undefined)
    if (!canonicalPath || (!relativeToRoot && resolve(path).toLowerCase() !== canonicalPath.toLowerCase())) return
    if (seen.has(canonicalPath.toLowerCase()) || !await hasProfileFile(canonicalPath, 'places.sqlite')) return
    seen.add(canonicalPath.toLowerCase())
    const standardName = standardRoot && relative(standardRoot, canonicalPath)
    const id = standardName && PROFILE_ID.test(standardName) && !standardName.includes(sep)
      ? standardName
      : `ff-${createHash('sha256').update(canonicalPath.toLowerCase()).digest('hex').slice(0, 16)}`
    profiles.push({ id, name: safeName(name, basename(canonicalPath)), canonicalPath })
  }

  const ini = await limitedText(join(canonicalRoot, 'profiles.ini'), MAX_PROFILES_INI_BYTES)
  if (ini) {
    for (const profile of iniProfiles(ini)) {
      const configured = profile.Path
      if (!configured || configured.includes('\0')) continue
      if (profile.IsRelative === '1' && !isAbsolute(configured)) {
        const path = resolve(canonicalRoot, configured)
        if (inside(canonicalRoot, path)) await add(path, profile.Name ?? basename(path), true)
      } else if (profile.IsRelative === '0' && isAbsolute(configured)) {
        await add(resolve(configured), profile.Name ?? basename(configured), false)
      }
    }
  }
  if (standardRoot) {
    const entries = await readdir(standardRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.slice(0, MAX_PROFILE_ENTRIES)) {
      if (!entry.isDirectory() || !PROFILE_ID.test(entry.name)) continue
      await add(join(standardRoot, entry.name), entry.name, true)
    }
  }
  return profiles
}

async function discoverProfiles(sourceId: BrowserImportSourceId): Promise<DiscoveredProfile[]> {
  const sourceRoots = roots()
  return sourceId === 'chrome'
    ? chromiumProfiles(sourceRoots.chrome)
    : sourceId === 'edge'
      ? chromiumProfiles(sourceRoots.edge)
      : firefoxProfiles(sourceRoots.firefox)
}

export async function discoverImportSources(): Promise<BrowserImportCatalog> {
  const [chrome, edge, firefox] = await Promise.all([
    discoverProfiles('chrome'), discoverProfiles('edge'), discoverProfiles('firefox')
  ])
  return (['chrome', 'edge', 'firefox'] as const).reduce<BrowserImportCatalog>((catalog, id, index) => {
    const found = [chrome, edge, firefox][index]
    catalog.sources.push({ id, name: BROWSER_IMPORT_SOURCE_NAMES[id], available: found.length > 0, profiles: found.map(({ id: profileId, name }) => ({ id: profileId, name })) })
    return catalog
  }, { sources: [] })
}

export async function resolveImportProfile(sourceId: BrowserImportSourceId, profileId: string): Promise<ResolvedImportSource> {
  if (!(['chrome', 'edge', 'firefox'] as readonly string[]).includes(sourceId) || typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) {
    throw new Error('Invalid browser profile selection.')
  }
  const profile = (await discoverProfiles(sourceId)).find((entry) => entry.id === profileId)
  if (!profile) throw new Error('The selected browser profile is unavailable.')
  const canonicalPath = await validDirectory(profile.canonicalPath)
  if (!canonicalPath || canonicalPath !== profile.canonicalPath) throw new Error('The selected browser profile changed.')
  return { sourceId, profileId, canonicalPath }
}
