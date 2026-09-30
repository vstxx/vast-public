import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { DetectedExtensionInfo } from '../../shared/browser-import.ts'

const MAX_PREFERENCES_BYTES = 32 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_MESSAGES_BYTES = 1024 * 1024
const MAX_EXTENSIONS = 200
const MAX_VERSIONS = 16
const ID_PATTERN = /^[a-p]{32}$/
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){0,3}(?:_[0-9]+)?$/
const LOCALE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

function inside(root: string, candidate: string): boolean {
  const next = relative(root, candidate)
  return next === '' || (next !== '..' && !next.startsWith(`..${sep}`) && !isAbsolute(next))
}

async function safeDirectory(path: string, root?: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) return undefined
  const canonical = await realpath(path).catch(() => undefined)
  return canonical && (!root || inside(root, canonical)) ? canonical : undefined
}

async function safeText(path: string, root: string, maxBytes: number): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Extension source file is invalid or exceeds its limit.')
  const canonical = await realpath(path)
  if (!inside(root, canonical)) throw new Error('Extension source file escapes its profile.')
  const bytes = await readFile(path)
  if (bytes.byteLength > maxBytes) throw new Error('Extension source file exceeds its limit.')
  return bytes.toString('utf8')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function extensionSettings(profile: string): Promise<Record<string, unknown>> {
  // Windows Chrome/Edge normally store extension state in Secure Preferences.
  // Preferences is retained for older/portable profiles and controlled tests.
  for (const filename of ['Secure Preferences', 'Preferences']) {
    let source: string
    try { source = await safeText(join(profile, filename), profile, MAX_PREFERENCES_BYTES) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const preferences = object(JSON.parse(source))
    const settings = object(object(preferences?.extensions)?.settings)
    if (settings) return settings
  }
  throw new Error('Chromium extension preferences are unavailable.')
}

function name(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) : ''
}

async function localizeName(contentRoot: string, manifest: Record<string, unknown>): Promise<string> {
  const raw = name(manifest.name)
  const match = /^__MSG_([A-Za-z0-9_]+)__$/.exec(raw)
  if (!match) return raw
  const locale = manifest.default_locale
  if (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale)) return raw
  try {
    const messages = object(JSON.parse(await safeText(join(contentRoot, '_locales', locale, 'messages.json'), contentRoot, MAX_MESSAGES_BYTES)))
    const entry = messages && Object.entries(messages).find(([key]) => key.toLowerCase() === match[1].toLowerCase())?.[1]
    return name(object(entry)?.message) || raw
  } catch {
    return raw
  }
}

function result(id: string, state: DetectedExtensionInfo['state'], limitationCode: string): DetectedExtensionInfo {
  return { id, name: id, version: '', sourceEnabled: false, manifestVersion: null, state,
    limitationCodes: [limitationCode], fingerprint: '' }
}

/** Reads only bounded installation metadata; extension private storage is never opened. */
export async function discoverChromiumExtensions(profilePath: string): Promise<DetectedExtensionInfo[]> {
  const profile = await safeDirectory(profilePath)
  if (!profile) throw new Error('Chromium profile is unavailable.')
  const extensionsRoot = await safeDirectory(join(profile, 'Extensions'), profile)
  if (!extensionsRoot) return []
  const settings = await extensionSettings(profile)
  // Secure Preferences also lists built-in/component extensions with no
  // profile-owned code directory. They are not transferable installations.
  const entries = (await readdir(extensionsRoot, { withFileTypes: true }))
    .filter((entry) => ID_PATTERN.test(entry.name))
  if (entries.length > MAX_EXTENSIONS) throw new Error('Chromium extension count exceeds the import limit.')
  const found: DetectedExtensionInfo[] = []
  for (const entry of entries) {
    const id = entry.name
    const configured = object(settings[id])
    if (!configured) { found.push(result(id, 'failed', 'SOURCE_STATE_UNAVAILABLE')); continue }
    const configuredManifest = object(configured?.manifest)
    const expectedVersion = name(configuredManifest?.version)
    const enabled = configured?.state === 1
    const base = await safeDirectory(join(extensionsRoot, id), extensionsRoot)
    if (!base) { found.push(result(id, 'failed', 'SOURCE_DIRECTORY_UNAVAILABLE')); continue }
    const versions = await readdir(base, { withFileTypes: true }).catch(() => [])
    if (versions.length > MAX_VERSIONS) { found.push(result(id, 'failed', 'TOO_MANY_VERSIONS')); continue }
    let selected: { contentRoot: string; text: string; manifest: Record<string, unknown> } | undefined
    for (const version of versions.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!version.isDirectory() || !VERSION_PATTERN.test(version.name)) continue
      const contentRoot = await safeDirectory(join(base, version.name), base)
      if (!contentRoot) continue
      try {
        const text = await safeText(join(contentRoot, 'manifest.json'), contentRoot, MAX_MANIFEST_BYTES)
        const manifest = object(JSON.parse(text))
        if (!manifest || name(manifest.version) !== expectedVersion || !version.name.startsWith(`${expectedVersion}_`) && version.name !== expectedVersion) continue
        selected = { contentRoot, text, manifest }
        break
      } catch { /* Report this item below, not an unrelated profile failure. */ }
    }
    if (!selected) { found.push(result(id, 'failed', 'VERSION_OR_MANIFEST_MISMATCH')); continue }
    const manifestVersion = selected.manifest.manifest_version === 2 || selected.manifest.manifest_version === 3
      ? selected.manifest.manifest_version : null
    const limitationCodes: string[] = []
    if (!manifestVersion) limitationCodes.push('UNSUPPORTED_MANIFEST_VERSION')
    if (!enabled) limitationCodes.push('SOURCE_DISABLED')
    found.push({
      id,
      name: await localizeName(selected.contentRoot, selected.manifest) || name(configuredManifest?.name) || id,
      version: expectedVersion,
      sourceEnabled: enabled,
      manifestVersion,
      state: manifestVersion ? 'detected' : 'unsupported',
      limitationCodes,
      fingerprint: createHash('sha256').update(id).update('\0').update(String(configured?.state)).update('\0')
        .update(selected.text).digest('hex')
    })
  }
  return found
}

/** Main-only resolver. Never send its path to the renderer. */
export async function resolveChromiumExtensionDirectory(
  profilePath: string, extensionId: string, expectedVersion: string, expectedFingerprint: string
): Promise<string> {
  if (!ID_PATTERN.test(extensionId) || !VERSION_PATTERN.test(expectedVersion) || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error('Invalid source extension selection.')
  }
  const found = (await discoverChromiumExtensions(profilePath)).find((item) => item.id === extensionId)
  if (!found || found.state !== 'detected' || found.version !== expectedVersion || found.fingerprint !== expectedFingerprint) {
    throw new Error('Source extension changed after import preview.')
  }
  const profile = await safeDirectory(profilePath)
  const root = profile && await safeDirectory(join(profile, 'Extensions'), profile)
  const base = root && await safeDirectory(join(root, extensionId), root)
  if (!base) throw new Error('Source extension directory disappeared.')
  const versions = await readdir(base, { withFileTypes: true })
  if (versions.length > MAX_VERSIONS) throw new Error('Source extension has too many versions.')
  const state = object((await extensionSettings(profile!))[extensionId])?.state
  for (const entry of versions.sort((a, b) => b.name.localeCompare(a.name))) {
    if (!entry.isDirectory() || (entry.name !== expectedVersion && !entry.name.startsWith(`${expectedVersion}_`))) continue
    const contentRoot = await safeDirectory(join(base, entry.name), base)
    if (!contentRoot) continue
    try {
      const text = await safeText(join(contentRoot, 'manifest.json'), contentRoot, MAX_MANIFEST_BYTES)
      const manifest = object(JSON.parse(text))
      const fingerprint = createHash('sha256').update(extensionId).update('\0').update(String(state)).update('\0').update(text).digest('hex')
      if (manifest?.version === expectedVersion && fingerprint === expectedFingerprint) return contentRoot
    } catch { /* A changed version is not a valid selection. */ }
  }
  throw new Error('Source extension files changed after import preview.')
}
