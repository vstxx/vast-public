import {
  parseHubCatalog,
  parseHubExtensionDetails,
  parseSignedReleaseDescriptor,
  verifySignedReleaseDescriptor,
  type SignedVastHubReleaseDescriptor,
  type VastHubCatalogResult,
  type VastHubExtensionDetails
} from '../../shared/extension-marketplace.ts'
import { sha256Hex, VEXT_EXTENSION_ID, VEXT_LIMITS, type VextTrustedKey } from '../../shared/vext-format.ts'

const MAX_JSON_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 30_000

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Vast Extensions response is too large.')
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) throw new Error('Vast Extensions response is too large.')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch { throw new Error('Vast Extensions returned invalid data.') }
}

function publicError(status: number): Error {
  if (status === 404) return new Error('This extension is unavailable.')
  if (status === 429) return new Error('Vast Extensions is busy. Try again shortly.')
  return new Error('Vast Extensions is currently unavailable.')
}

export class ExtensionHubClient {
  private readonly origin: string
  private readonly trustedKeys: readonly VextTrustedKey[]

  constructor(origin: string, trustedKeys: readonly VextTrustedKey[]) {
    this.origin = origin
    this.trustedKeys = trustedKeys
  }

  async catalog(input: { query?: string; category?: string; page?: number; sort?: 'popular' | 'updated' }): Promise<VastHubCatalogResult> {
    const url = new URL('/v1/catalog', this.origin)
    if (input.query) url.searchParams.set('query', input.query.slice(0, 128))
    if (input.category) url.searchParams.set('category', input.category.slice(0, 64))
    url.searchParams.set('page', String(Math.max(1, Math.min(1_000, Math.trunc(input.page ?? 1)))))
    if (input.sort) url.searchParams.set('sort', input.sort)
    return parseHubCatalog(await this.getJson(url))
  }

  async details(extensionId: string): Promise<VastHubExtensionDetails> {
    this.assertId(extensionId)
    return parseHubExtensionDetails(await this.getJson(new URL(`/v1/extensions/${extensionId}`, this.origin)))
  }

  async descriptor(extensionId: string, version?: string): Promise<SignedVastHubReleaseDescriptor> {
    this.assertId(extensionId)
    const pathname = version ? `/v1/extensions/${extensionId}/releases/${encodeURIComponent(version)}` : `/v1/install/${extensionId}`
    const signed = parseSignedReleaseDescriptor(await this.getJson(new URL(pathname, this.origin)), this.origin)
    if (signed.descriptor.extension_id !== extensionId) throw new Error('Vast Extensions returned the wrong extension identity.')
    await verifySignedReleaseDescriptor(signed, this.trustedKeys)
    return signed
  }

  async download(descriptor: SignedVastHubReleaseDescriptor): Promise<Uint8Array> {
    await verifySignedReleaseDescriptor(descriptor, this.trustedKeys)
    const url = new URL(descriptor.descriptor.package_url)
    if (url.origin !== new URL(this.origin).origin) throw new Error('Vast Extensions returned an unsafe package URL.')
    const response = await this.fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, { headers: { accept: 'application/vnd.vast.extension+zip, application/octet-stream' } })
    if (!response.ok) throw publicError(response.status)
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/vnd.vast.extension+zip' && contentType !== 'application/octet-stream') throw new Error('Vast Extensions returned an invalid package response.')
    const bytes = await readBounded(response, VEXT_LIMITS.maxCompressedBytes)
    if (await sha256Hex(bytes) !== descriptor.descriptor.sha256) throw new Error('Extension package download failed its integrity check.')
    return bytes
  }

  private async getJson(url: URL): Promise<unknown> {
    const response = await this.fetchWithTimeout(url, REQUEST_TIMEOUT_MS, { headers: { accept: 'application/json' } })
    if (!response.ok) throw publicError(response.status)
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') throw new Error('Vast Extensions returned an invalid response type.')
    return parseJson(await readBounded(response, MAX_JSON_BYTES))
  }

  private async fetchWithTimeout(url: URL, timeoutMs: number, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try { return await fetch(url, { ...init, redirect: 'error', signal: controller.signal, credentials: 'omit', cache: 'no-store' }) }
    catch { throw new Error('Vast Extensions is currently unavailable.') }
    finally { clearTimeout(timeout) }
  }

  private assertId(extensionId: string): void {
    if (!VEXT_EXTENSION_ID.test(extensionId)) throw new Error('Invalid extension ID.')
  }
}
