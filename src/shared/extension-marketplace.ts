import { VAST_NATIVE_PERMISSIONS, type VastExtensionKind, type VastNativePermission } from './extension-native-api.ts'
import { canonicalJson, verifyEd25519Signature, VEXT_EXTENSION_ID, VEXT_PUBLISHER_ID, VEXT_VERSION, type VextTrustedKey } from './vext-format.ts'

export type ExtensionInstallSource = 'unpacked' | 'local-vext' | 'hub' | 'bundled'
export type ExtensionTrustLevel = 'developer' | 'local' | 'official'
export type ExtensionUpdateState = 'not-applicable' | 'up-to-date' | 'checking' | 'available' | 'updating' | 'pending-approval' | 'failed'

export interface ExtensionPermissionSnapshot {
  chrome: string[]
  hosts: string[]
  vast: VastNativePermission[]
}

export interface ExtensionPackagePreview {
  token: string
  extensionId: string
  name: string
  description?: string
  version: string
  publisherId?: string
  publisherName: string
  source: Exclude<ExtensionInstallSource, 'unpacked'>
  trust: Exclude<ExtensionTrustLevel, 'developer'>
  kind: VastExtensionKind
  permissions: ExtensionPermissionSnapshot
  isUpdate: boolean
  permissionEscalation: ExtensionPermissionSnapshot
}

export interface VastHubCatalogItem {
  id: string
  slug: string
  name: string
  summary: string
  publisher: { id: string; name: string; verified: boolean }
  category: string
  kind: VastExtensionKind
  version: string
  updatedAt: string
  downloads: number
  iconUrl?: string
  installed: boolean
}

export interface VastHubCatalogResult {
  items: VastHubCatalogItem[]
  page: number
  pageSize: number
  total: number
  featured: VastHubCatalogItem[]
  categories: string[]
}

export interface VastHubExtensionDetails extends VastHubCatalogItem {
  description: string
  homepage?: string
  sourceUrl?: string
  screenshots: string[]
  permissions: ExtensionPermissionSnapshot
}

export interface VastHubReleaseDescriptor {
  schema: 1
  extension_id: string
  publisher_id: string
  version: string
  package_url: string
  sha256: string
  key_id: string
  permissions: ExtensionPermissionSnapshot
  published_at: string
}

export interface SignedVastHubReleaseDescriptor {
  descriptor: VastHubReleaseDescriptor
  signature: {
    signature_version: 1
    algorithm: 'Ed25519'
    key_id: string
    signature: string
  }
}

const encoder = new TextEncoder()
const safeId = /^[a-z0-9][a-z0-9_-]{0,63}$/
const safeCategory = /^[A-Za-z][A-Za-z &-]{0,63}$/
const sha256 = /^[a-f0-9]{64}$/

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Vast Extensions returned an invalid ${label}.`)
  return value.trim()
}

function stringArray(value: unknown, label: string, maxItems = 512): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Vast Extensions returned invalid ${label}.`)
  return [...new Set(value.map((item) => string(item, label, 4_096)))]
}

function permissions(value: unknown): ExtensionPermissionSnapshot {
  if (!object(value)) throw new Error('Vast Extensions returned invalid permissions.')
  const vast = stringArray(value.vast, 'Vast permissions', 64)
  if (vast.some((permission) => !(VAST_NATIVE_PERMISSIONS as readonly string[]).includes(permission))) throw new Error('Vast Extensions returned unknown Vast permissions.')
  return {
    chrome: stringArray(value.chrome, 'Chrome permissions'),
    hosts: stringArray(value.hosts, 'website access'),
    vast: vast as VastNativePermission[]
  }
}

function parseKind(value: unknown): VastExtensionKind {
  if (value !== 'chrome' && value !== 'vast' && value !== 'hybrid') throw new Error('Vast Extensions returned an invalid extension type.')
  return value
}

function optionalHttps(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const input = string(value, label, 2_048)
  const parsed = new URL(input)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`Vast Extensions returned an invalid ${label}.`)
  return parsed.toString()
}

function parseCatalogItem(value: unknown): VastHubCatalogItem {
  if (!object(value) || !VEXT_EXTENSION_ID.test(String(value.id)) || !safeId.test(String(value.slug)) || !VEXT_VERSION.test(String(value.version))) {
    throw new Error('Vast Extensions returned an invalid catalog item.')
  }
  if (!object(value.publisher) || !VEXT_PUBLISHER_ID.test(String(value.publisher.id)) || typeof value.publisher.verified !== 'boolean') {
    throw new Error('Vast Extensions returned invalid publisher information.')
  }
  const downloads = Number(value.downloads)
  if (!Number.isSafeInteger(downloads) || downloads < 0) throw new Error('Vast Extensions returned an invalid download count.')
  const updatedAt = string(value.updatedAt, 'updated date', 64)
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('Vast Extensions returned an invalid updated date.')
  return {
    id: String(value.id),
    slug: String(value.slug),
    name: string(value.name, 'extension name', 128),
    summary: string(value.summary, 'extension summary', 280),
    publisher: { id: String(value.publisher.id), name: string(value.publisher.name, 'publisher name', 128), verified: value.publisher.verified },
    category: safeCategory.test(String(value.category)) ? String(value.category) : 'Utilities',
    kind: parseKind(value.kind),
    version: String(value.version),
    updatedAt,
    downloads,
    ...(optionalHttps(value.iconUrl, 'icon URL') ? { iconUrl: optionalHttps(value.iconUrl, 'icon URL') } : {}),
    installed: value.installed === true
  }
}

export function parseHubCatalog(value: unknown): VastHubCatalogResult {
  if (!object(value) || !Array.isArray(value.items) || !Array.isArray(value.featured) || !Array.isArray(value.categories)) throw new Error('Vast Extensions returned an invalid catalog.')
  const page = Number(value.page)
  const pageSize = Number(value.pageSize)
  const total = Number(value.total)
  if (![page, pageSize, total].every(Number.isSafeInteger) || page < 1 || pageSize < 1 || pageSize > 50 || total < 0 || value.items.length > pageSize || value.featured.length > 12) {
    throw new Error('Vast Extensions returned invalid pagination.')
  }
  return { items: value.items.map(parseCatalogItem), featured: value.featured.map(parseCatalogItem), categories: stringArray(value.categories, 'categories', 32), page, pageSize, total }
}

export function parseHubExtensionDetails(value: unknown): VastHubExtensionDetails {
  if (!object(value)) throw new Error('Vast Extensions returned invalid extension details.')
  const base = parseCatalogItem(value)
  const screenshots = stringArray(value.screenshots ?? [], 'screenshots', 5).map((url) => optionalHttps(url, 'screenshot URL')!)
  return {
    ...base,
    description: string(value.description, 'description', 16_000),
    ...(optionalHttps(value.homepage, 'homepage') ? { homepage: optionalHttps(value.homepage, 'homepage') } : {}),
    ...(optionalHttps(value.sourceUrl, 'source URL') ? { sourceUrl: optionalHttps(value.sourceUrl, 'source URL') } : {}),
    screenshots,
    permissions: permissions(value.permissions)
  }
}

export function parseSignedReleaseDescriptor(value: unknown, fixedOrigin: string): SignedVastHubReleaseDescriptor {
  if (!object(value) || !object(value.descriptor) || !object(value.signature)) throw new Error('Vast Extensions returned invalid install metadata.')
  const descriptor = value.descriptor
  const signature = value.signature
  if (descriptor.schema !== 1 || !VEXT_EXTENSION_ID.test(String(descriptor.extension_id)) || !VEXT_PUBLISHER_ID.test(String(descriptor.publisher_id)) || !VEXT_VERSION.test(String(descriptor.version)) || !sha256.test(String(descriptor.sha256))) {
    throw new Error('Vast Extensions returned invalid install metadata.')
  }
  const packageUrl = new URL(string(descriptor.package_url, 'package URL', 2_048), fixedOrigin)
  const configured = new URL(fixedOrigin)
  const configuredIsSafe = configured.protocol === 'https:' || (configured.protocol === 'http:' && (configured.hostname === '127.0.0.1' || configured.hostname === 'localhost'))
  if (!configuredIsSafe || packageUrl.origin !== configured.origin || packageUrl.protocol !== configured.protocol || packageUrl.username || packageUrl.password) throw new Error('Vast Extensions returned an unsafe package URL.')
  const publishedAt = string(descriptor.published_at, 'published date', 64)
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Vast Extensions returned an invalid published date.')
  const keyId = string(descriptor.key_id, 'key ID', 128)
  if (signature.signature_version !== 1 || signature.algorithm !== 'Ed25519' || signature.key_id !== keyId) throw new Error('Vast Extensions returned invalid signed metadata.')
  return {
    descriptor: {
      schema: 1,
      extension_id: String(descriptor.extension_id),
      publisher_id: String(descriptor.publisher_id),
      version: String(descriptor.version),
      package_url: packageUrl.toString(),
      sha256: String(descriptor.sha256),
      key_id: keyId,
      permissions: permissions(descriptor.permissions),
      published_at: publishedAt
    },
    signature: { signature_version: 1, algorithm: 'Ed25519', key_id: keyId, signature: string(signature.signature, 'signature', 512) }
  }
}

export async function verifySignedReleaseDescriptor(value: SignedVastHubReleaseDescriptor, trustedKeys: readonly VextTrustedKey[]): Promise<void> {
  const valid = await verifyEd25519Signature(encoder.encode(canonicalJson(value.descriptor)), value.signature.signature, value.signature.key_id, trustedKeys)
  if (!valid) throw new Error('Could not verify extension release metadata.')
}

function normalizedHosts(values: readonly string[]): Set<string> {
  const normalized = new Set<string>()
  for (const value of values) {
    const next = value.trim().toLowerCase().replace(/\/$/, '')
    if (next) normalized.add(next)
  }
  return normalized
}

export function permissionEscalation(previous: ExtensionPermissionSnapshot, next: ExtensionPermissionSnapshot): ExtensionPermissionSnapshot {
  const previousChrome = new Set(previous.chrome)
  const previousVast = new Set(previous.vast)
  const previousHosts = normalizedHosts(previous.hosts)
  return {
    chrome: next.chrome.filter((permission) => !previousChrome.has(permission)),
    hosts: next.hosts.filter((host) => !previousHosts.has(host.trim().toLowerCase().replace(/\/$/, ''))),
    vast: next.vast.filter((permission) => !previousVast.has(permission))
  }
}

export function hasPermissionEscalation(value: ExtensionPermissionSnapshot): boolean {
  return value.chrome.length > 0 || value.hosts.length > 0 || value.vast.length > 0
}

export function parseExtensionInstallDeepLink(input: string): string | undefined {
  if (!input || input.length > 512) return undefined
  try {
    const url = new URL(input)
    if (url.protocol !== 'vast:' || url.username || url.password || url.hostname.toLowerCase() !== 'extensions' || url.pathname !== '/install' || url.hash) return undefined
    if ([...url.searchParams.keys()].some((key) => key !== 'id') || url.searchParams.getAll('id').length !== 1) return undefined
    const id = url.searchParams.get('id') ?? ''
    return VEXT_EXTENSION_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}
