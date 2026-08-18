import { createHash, timingSafeEqual } from 'node:crypto'
import type { RelayBroadcastMedia, RelayPresentationMedia } from '../../shared/relay-types.ts'

export const RELAY_MAX_ASSET_BYTES = 2 * 1024 * 1024
export const RELAY_MEDIA_TIMEOUT_MS = 7_500
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_ENTRIES = 8

export type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function hasExpectedMagic(bytes: Uint8Array, mime: RelayBroadcastMedia['mime']): boolean {
  if (mime === 'image/png') {
    const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value)
  }
  if (mime === 'image/gif') {
    const header = Buffer.from(bytes.subarray(0, 6)).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  return bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
}

async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > RELAY_MAX_ASSET_BYTES)) {
    throw new Error('Relay asset Content-Length is invalid or oversized.')
  }
  if (!response.body) throw new Error('Relay asset body is empty.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > RELAY_MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Relay asset exceeds the client size limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total < 1) throw new Error('Relay asset body is empty.')
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function downloadRelayMedia(
  endpoint: string,
  metadata: RelayBroadcastMedia,
  fetcher: RelayFetch,
  timeoutMs = RELAY_MEDIA_TIMEOUT_MS
): Promise<RelayPresentationMedia> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const assetUrl = new URL(`/v1/assets/${encodeURIComponent(metadata.id)}`, `${endpoint}/`)
    const response = await fetcher(assetUrl, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: { Accept: metadata.mime }
    })
    if (!response.ok) throw new Error(`Relay asset returned HTTP ${response.status}.`)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== metadata.mime) throw new Error('Relay asset MIME does not match signed metadata.')
    const bytes = await readBoundedBytes(response)
    if (!hasExpectedMagic(bytes, metadata.mime)) throw new Error('Relay asset magic bytes are invalid.')
    const expected = Buffer.from(metadata.sha256, 'hex')
    const actual = createHash('sha256').update(bytes).digest()
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Relay asset SHA-256 does not match.')
    return { mime: metadata.mime, sha256: metadata.sha256, bytes }
  } finally {
    clearTimeout(timeout)
  }
}

export class RelayMediaCache {
  private readonly entries = new Map<string, RelayPresentationMedia>()
  private totalBytes = 0

  get(metadata: RelayBroadcastMedia): RelayPresentationMedia | undefined {
    const key = `${metadata.id}\n${metadata.sha256}`
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return { mime: value.mime, sha256: value.sha256, bytes: value.bytes.slice() }
  }

  set(metadata: RelayBroadcastMedia, value: RelayPresentationMedia): void {
    const key = `${metadata.id}\n${metadata.sha256}`
    const existing = this.entries.get(key)
    if (existing) this.totalBytes -= existing.bytes.byteLength
    this.entries.delete(key)
    this.entries.set(key, { mime: value.mime, sha256: value.sha256, bytes: value.bytes.slice() })
    this.totalBytes += value.bytes.byteLength
    while (this.entries.size > MAX_CACHE_ENTRIES || this.totalBytes > MAX_CACHE_BYTES) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (!oldestKey) break
      const removed = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      if (removed) this.totalBytes -= removed.bytes.byteLength
    }
  }
}
