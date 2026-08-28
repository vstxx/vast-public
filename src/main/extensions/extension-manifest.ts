import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChromeExtensionManifest, ValidatedExtensionManifest } from './extension-types.ts'
import { VAST_NATIVE_API_VERSION, VAST_NATIVE_PERMISSIONS, type VastExtensionManifestSection, type VastNativePermission } from '../../shared/extension-native-api.ts'
import { VEXT_EXTENSION_ID } from '../../shared/vext-format.ts'
import { parseExtensionMatchPattern } from '../../shared/extension-match-pattern.ts'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ICON_BYTES = 1024 * 1024
const VERSION = /^\d+(?:\.\d+){0,3}$/
const ASSET_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
])

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Extension manifest has an invalid ${label}.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error(`Extension manifest has an invalid ${label}.`)
  return trimmed
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label, maxLength)
}

function stringArray(value: unknown, label: string, maxItems = 512): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Extension manifest has invalid ${label}.`)
  return value.map((item) => requiredString(item, label, 4_096))
}

async function optionalHtmlAsset(rootPath: string, value: unknown, label: string): Promise<string | undefined> {
  const asset = optionalString(value, label, 1_024)
  if (!asset) return undefined
  const file = await resolveExtensionAssetPath(rootPath, asset)
  const info = await stat(file)
  if (!info.isFile() || !['.html', '.htm'].includes(extname(file).toLowerCase())) {
    throw new Error(`${label} must be a local HTML file inside the extension.`)
  }
  return asset.replaceAll('\\', '/')
}

function isHostPattern(value: string): boolean {
  return Boolean(parseExtensionMatchPattern(value))
}

const NATIVE_PERMISSION_SET = new Set<string>(VAST_NATIVE_PERMISSIONS)

async function validateVastSection(rootPath: string, value: unknown): Promise<{
  vast?: VastExtensionManifestSection
  compatibilityError?: string
}> {
  if (value === undefined) return {}
  if (!object(value)) throw new Error('Extension manifest has an invalid vast section.')
  if (!Number.isInteger(value.api_version) || Number(value.api_version) < 1 || Number(value.api_version) > 10_000) {
    throw new Error('Extension manifest has an invalid vast.api_version.')
  }
  const requested = stringArray(value.permissions, 'vast permissions', 64)
  const unique = [...new Set(requested)]
  const unknown = unique.filter((permission) => !NATIVE_PERMISSION_SET.has(permission))
  const background = optionalString(value.background, 'vast background', 1_024)
  const popup = await optionalHtmlAsset(rootPath, value.popup, 'vast popup')
  const options = await optionalHtmlAsset(rootPath, value.options, 'vast options page')
  const extensionId = optionalString(value.extension_id, 'vast extension ID', 64)
  if (extensionId && !VEXT_EXTENSION_ID.test(extensionId)) throw new Error('Extension manifest has an invalid vast.extension_id.')
  if (background) {
    const file = await resolveExtensionAssetPath(rootPath, background)
    const info = await stat(file)
    if (!info.isFile() || !['.js', '.mjs'].includes(extname(file).toLowerCase())) {
      throw new Error('vast.background must be a local JavaScript module inside the extension.')
    }
  }
  const vast: VastExtensionManifestSection = {
    api_version: Number(value.api_version),
    ...(extensionId ? { extension_id: extensionId } : {}),
    ...(background ? { background } : {}),
    ...(popup ? { popup } : {}),
    ...(options ? { options } : {}),
    permissions: unique.filter((permission): permission is VastNativePermission => NATIVE_PERMISSION_SET.has(permission))
  }
  const compatibilityError = unknown.length > 0
    ? `Unknown Vast permission${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`
    : vast.api_version !== VAST_NATIVE_API_VERSION
      ? `Vast API version ${vast.api_version} is not supported by this version of Vast.`
      : !background
        ? 'Vast-native extensions must declare vast.background.'
        : undefined
  return { vast, ...(compatibilityError ? { compatibilityError } : {}) }
}

function hasChromeLayer(input: Record<string, unknown>, vastOnlyPermissions: readonly string[]): boolean {
  if (input.content_scripts !== undefined || input.background !== undefined || input.action !== undefined || input.browser_action !== undefined || input.page_action !== undefined) return true
  const permissions = Array.isArray(input.permissions) ? input.permissions.filter((item): item is string => typeof item === 'string') : []
  if (permissions.some((permission) => !vastOnlyPermissions.includes(permission))) return true
  return input.host_permissions !== undefined || input.optional_host_permissions !== undefined || input.web_accessible_resources !== undefined
}

function isInside(root: string, candidate: string): boolean {
  const next = relative(root, candidate)
  return next === '' || (!next.startsWith(`..${sep}`) && next !== '..' && !isAbsolute(next))
}

export async function resolveExtensionAssetPath(rootPath: string, manifestPath: string): Promise<string> {
  if (typeof manifestPath !== 'string' || !manifestPath.trim() || manifestPath.includes('\0') || isAbsolute(manifestPath)) {
    throw new Error('Extension asset path is invalid.')
  }
  const canonicalRoot = await realpath(rootPath)
  const candidate = resolve(canonicalRoot, manifestPath)
  if (!isInside(canonicalRoot, candidate)) throw new Error('Extension asset path escapes the extension directory.')
  const canonicalCandidate = await realpath(candidate)
  if (!isInside(canonicalRoot, canonicalCandidate)) throw new Error('Extension asset path escapes the extension directory.')
  return canonicalCandidate
}

async function extensionIconDataUrl(rootPath: string, icons: unknown): Promise<string | undefined> {
  if (!object(icons)) return undefined
  const candidates = Object.entries(icons)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort((left, right) => (Number(right[0]) || 0) - (Number(left[0]) || 0))
  for (const [, iconPath] of candidates) {
    try {
      const file = await resolveExtensionAssetPath(rootPath, iconPath)
      const mime = ASSET_MIME.get(extname(file).toLowerCase())
      if (!mime) continue
      const info = await stat(file)
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ICON_BYTES) continue
      const data = await readFile(file)
      if (mime === 'image/svg+xml') {
        const source = data.toString('utf8')
        if (/<(?:script|foreignObject)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["'](?:https?:|\/\/)/i.test(source)) continue
      }
      return `data:${mime};base64,${data.toString('base64')}`
    } catch {
      // Try the next declared icon and fall back to the native puzzle icon.
    }
  }
  return undefined
}

async function validateContentScripts(rootPath: string, value: unknown): Promise<void> {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error('Extension manifest has invalid content_scripts.')
  }
  for (const entry of value) {
    if (!object(entry)) throw new Error('Extension manifest has an invalid content script entry.')
    const matches = stringArray(entry.matches, 'content script matches')
    const excludeMatches = stringArray(entry.exclude_matches, 'content script exclude matches')
    const scripts = stringArray(entry.js, 'content script JavaScript files')
    const styles = stringArray(entry.css, 'content script CSS files')
    if (matches.length === 0 || matches.some((pattern) => !isHostPattern(pattern))) {
      throw new Error('Extension content scripts must declare valid match patterns.')
    }
    if (excludeMatches.some((pattern) => !isHostPattern(pattern))) {
      throw new Error('Extension content scripts contain invalid exclude match patterns.')
    }
    if (scripts.length === 0 && styles.length === 0) {
      throw new Error('Extension content scripts must declare a JavaScript or CSS file.')
    }
    if (entry.run_at !== undefined && !['document_start', 'document_end', 'document_idle'].includes(String(entry.run_at))) {
      throw new Error('Extension content script has an invalid run_at value.')
    }
    if (entry.all_frames !== undefined && typeof entry.all_frames !== 'boolean') {
      throw new Error('Extension content script has an invalid all_frames value.')
    }
    for (const asset of [...scripts, ...styles]) {
      const assetPath = await resolveExtensionAssetPath(rootPath, asset)
      const assetInfo = await stat(assetPath)
      if (!assetInfo.isFile()) throw new Error('Extension content script asset is not a file.')
    }
  }
}

export function chromeExtensionId(rootPath: string, manifestKey?: string): string {
  let identity = Buffer.from(process.platform === 'win32' ? rootPath.toLowerCase() : rootPath)
  if (manifestKey) {
    try {
      const decoded = Buffer.from(manifestKey, 'base64')
      if (decoded.length > 0) identity = decoded
    } catch {
      // Invalid keys are left for Electron to reject; the path keeps the local ID deterministic.
    }
  }
  const digest = createHash('sha256').update(identity).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}

export async function validateExtensionManifest(extensionPath: string): Promise<ValidatedExtensionManifest> {
  if (typeof extensionPath !== 'string' || !extensionPath.trim() || !isAbsolute(extensionPath)) {
    throw new Error('Choose a valid extension directory.')
  }
  const rootInfo = await lstat(extensionPath).catch(() => undefined)
  if (!rootInfo?.isDirectory()) throw new Error('The selected extension directory is unavailable.')
  const rootPath = await realpath(extensionPath)
  const selectedManifestPath = join(rootPath, 'manifest.json')
  const manifestInfo = await stat(selectedManifestPath).catch(() => undefined)
  if (!manifestInfo?.isFile()) throw new Error('The selected directory does not contain manifest.json.')
  if (manifestInfo.size <= 0 || manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error('Extension manifest is empty or too large.')
  const manifestPath = await realpath(selectedManifestPath)
  if (!isInside(rootPath, manifestPath)) throw new Error('Extension manifest must live inside the selected directory.')

  let input: unknown
  try {
    input = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('Extension manifest.json is not valid JSON.')
  }
  if (!object(input)) throw new Error('Extension manifest root must be an object.')

  const name = requiredString(input.name, 'name', 256)
  const version = requiredString(input.version, 'version', 64)
  if (!VERSION.test(version)) throw new Error('Extension manifest has an invalid version.')
  if (input.manifest_version !== 2 && input.manifest_version !== 3) {
    throw new Error('Vast supports Chrome Manifest V2 and V3 extensions only.')
  }
  const description = optionalString(input.description, 'description', 4_096)
  const key = optionalString(input.key, 'key', 32_768)
  const permissions = stringArray(input.permissions, 'permissions')
  const optionalPermissions = stringArray(input.optional_permissions, 'optional permissions')
  const hostPermissions = stringArray(input.host_permissions, 'host permissions')
  const optionalHostPermissions = stringArray(input.optional_host_permissions, 'optional host permissions')
  const mv2HostPermissions = permissions.filter(isHostPattern)
  const apiPermissions = permissions.filter((permission) => !isHostPattern(permission))

  await validateContentScripts(rootPath, input.content_scripts)
  const native = await validateVastSection(rootPath, input.vast)
  if (input.action !== undefined && !object(input.action)) throw new Error('Extension manifest has an invalid action.')
  if (input.browser_action !== undefined && !object(input.browser_action)) throw new Error('Extension manifest has an invalid browser_action.')
  if (input.options_ui !== undefined && !object(input.options_ui)) throw new Error('Extension manifest has invalid options_ui.')
  const action = object(input.action) ? input.action : object(input.browser_action) ? input.browser_action : undefined
  const chromePopup = action ? await optionalHtmlAsset(rootPath, action.default_popup, 'extension action popup') : undefined
  const chromeOptions = object(input.options_ui)
    ? await optionalHtmlAsset(rootPath, input.options_ui.page, 'extension options page')
    : await optionalHtmlAsset(rootPath, input.options_page, 'extension options page')
  const chromeLayer = hasChromeLayer(input, native.vast?.permissions ?? [])
  const kind = native.vast ? (chromeLayer ? 'hybrid' : 'vast') : 'chrome'

  const manifest: ChromeExtensionManifest = {
    ...input,
    name,
    version,
    ...(description ? { description } : {}),
    ...(key ? { key } : {}),
    manifest_version: input.manifest_version
  } as ChromeExtensionManifest
  const contentScriptHosts = Array.isArray(input.content_scripts)
    ? input.content_scripts.flatMap((entry) => object(entry) && Array.isArray(entry.matches)
      ? entry.matches.filter((pattern): pattern is string => typeof pattern === 'string')
      : [])
    : []

  return {
    rootPath,
    manifestPath,
    manifest,
    permissions: [...new Set([...apiPermissions, ...optionalPermissions.filter((permission) => !isHostPattern(permission))])],
    hostPermissions: [...new Set([...hostPermissions, ...optionalHostPermissions, ...mv2HostPermissions, ...contentScriptHosts])],
    iconDataUrl: await extensionIconDataUrl(rootPath, input.icons),
    kind,
    ...(native.vast ? { vast: native.vast } : {}),
    ui: {
      ...(native.vast?.popup
        ? { popup: { runtime: 'native' as const, path: native.vast.popup } }
        : chromePopup
          ? { popup: { runtime: 'chrome' as const, path: chromePopup } }
          : {}),
      ...(native.vast?.options
        ? { options: { runtime: 'native' as const, path: native.vast.options } }
        : chromeOptions
          ? { options: { runtime: 'chrome' as const, path: chromeOptions } }
          : {})
    },
    ...(native.compatibilityError ? { nativeCompatibilityError: native.compatibilityError } : {})
  }
}
