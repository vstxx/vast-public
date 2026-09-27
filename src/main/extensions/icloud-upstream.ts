import { createHash } from 'node:crypto'
import semver from 'semver'
import { extractSecureZipEntries, sha256Hex, VEXT_LIMITS, VEXT_VERSION } from '../../shared/vext-format.ts'
import type { VerifiedUpstreamPackage } from './extension-managed-store.ts'

export const ICLOUD_PASSWORDS_EXTENSION_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj'
const UPDATE_ORIGIN = 'https://clients2.google.com'
const ALLOWED_DOWNLOAD_HOSTS = new Set(['clients2.google.com', 'clients2.googleusercontent.com'])
const MAX_UPDATE_XML_BYTES = 128 * 1024

type FetchLike = typeof fetch

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('The upstream CRX is truncated.')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0
  let shift = 0
  let offset = start
  for (;;) {
    if (offset >= bytes.byteLength || shift > 49) throw new Error('The upstream CRX header is invalid.')
    const byte = bytes[offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return [value, offset]
    shift += 7
  }
}

function protobufFields(bytes: Uint8Array): Array<{ field: number; value: Uint8Array | number }> {
  const fields: Array<{ field: number; value: Uint8Array | number }> = []
  let offset = 0
  while (offset < bytes.byteLength) {
    let tag: number
    ;[tag, offset] = readVarint(bytes, offset)
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 2) {
      let length: number
      ;[length, offset] = readVarint(bytes, offset)
      if (offset + length > bytes.byteLength) throw new Error('The upstream CRX header is invalid.')
      fields.push({ field, value: bytes.slice(offset, offset + length) })
      offset += length
    } else if (wire === 0) {
      let value: number
      ;[value, offset] = readVarint(bytes, offset)
      fields.push({ field, value })
    } else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else throw new Error('The upstream CRX header uses an unsupported field.')
    if (offset > bytes.byteLength) throw new Error('The upstream CRX header is invalid.')
  }
  return fields
}

function extensionIdFromKey(key: Uint8Array): string {
  const digest = createHash('sha256').update(key).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}

export function parseVerifiedICloudCrx(bytes: Uint8Array): VerifiedUpstreamPackage {
  if (bytes.byteLength < 13 || bytes.byteLength > VEXT_LIMITS.maxCompressedBytes) throw new Error('The upstream CRX is empty or too large.')
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'Cr24' || readU32(bytes, 4) !== 3) throw new Error('iCloud Passwords must be delivered as CRX3.')
  const headerLength = readU32(bytes, 8)
  if (headerLength <= 0 || 12 + headerLength >= bytes.byteLength) throw new Error('The upstream CRX header is invalid.')
  const header = protobufFields(bytes.slice(12, 12 + headerLength))
  const matchingKey = header
    .filter(({ field, value }) => (field === 2 || field === 3) && value instanceof Uint8Array)
    .map(({ value }) => protobufFields(value as Uint8Array).find(({ field }) => field === 1)?.value)
    .find((value): value is Uint8Array => value instanceof Uint8Array && extensionIdFromKey(value) === ICLOUD_PASSWORDS_EXTENSION_ID)
  if (!matchingKey) throw new Error('The upstream CRX does not match the iCloud Passwords extension ID.')
  const files = extractSecureZipEntries(bytes.slice(12 + headerLength))
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error('The upstream iCloud Passwords manifest is missing.')
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as Record<string, unknown> } catch { throw new Error('The upstream iCloud Passwords manifest is invalid.') }
  const version = String(manifest.version ?? '')
  if (!VEXT_VERSION.test(version) || manifest.manifest_version !== 3) throw new Error('The upstream iCloud Passwords manifest is unsupported.')
  if (typeof manifest.key !== 'string' || extensionIdFromKey(Buffer.from(manifest.key, 'base64')) !== ICLOUD_PASSWORDS_EXTENSION_ID) throw new Error('The upstream iCloud Passwords manifest identity is invalid.')
  return { extensionId: ICLOUD_PASSWORDS_EXTENSION_ID, version, packageSha256: createHash('sha256').update(bytes).digest('hex'), files }
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maximum) throw new Error('The upstream response is too large.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) throw new Error('The upstream response is empty or too large.')
  return bytes
}

function attribute(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]+)"`).exec(xml)?.[1]
}

export class ICloudUpstreamClient {
  private readonly fetcher: FetchLike

  constructor(fetcher: FetchLike = fetch) { this.fetcher = fetcher }

  async latest(currentVersion?: string): Promise<VerifiedUpstreamPackage | undefined> {
    const update = new URL('/service/update2/crx', UPDATE_ORIGIN)
    update.searchParams.set('response', 'updatecheck')
    update.searchParams.set('acceptformat', 'crx3')
    update.searchParams.set('prodversion', process.versions.chrome ?? '144.0.0.0')
    update.searchParams.set('x', `id=${ICLOUD_PASSWORDS_EXTENSION_ID}&uc${currentVersion ? `&v=${currentVersion}` : ''}`)
    const metadataResponse = await this.fetcher(update, { redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'text/xml' } })
    if (!metadataResponse.ok || new URL(metadataResponse.url || update).origin !== UPDATE_ORIGIN) throw new Error('Apple upstream update metadata is unavailable.')
    const metadata = new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(metadataResponse, MAX_UPDATE_XML_BYTES))
    if (!metadata.includes(`appid="${ICLOUD_PASSWORDS_EXTENSION_ID}"`)) throw new Error('Upstream update metadata returned the wrong extension.')
    if (/\bstatus="noupdate"/.test(metadata)) return undefined
    const updateCheck = /<updatecheck\b[^>]*\bstatus="ok"[^>]*\/?\s*>/.exec(metadata)?.[0]
    const codebase = updateCheck ? attribute(updateCheck, 'codebase') : undefined
    const version = updateCheck ? attribute(updateCheck, 'version') : undefined
    const expectedHash = updateCheck ? attribute(updateCheck, 'hash_sha256') : undefined
    if (!codebase || !version || !VEXT_VERSION.test(version) || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Upstream update metadata is invalid.')
    if (currentVersion && !semver.gt(version, currentVersion)) return undefined
    const packageUrl = new URL(codebase)
    if (packageUrl.protocol !== 'https:' || packageUrl.username || packageUrl.password || !ALLOWED_DOWNLOAD_HOSTS.has(packageUrl.hostname)) throw new Error('Upstream update metadata contains an unsafe package URL.')
    const packageResponse = await this.fetcher(packageUrl, { redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/x-chrome-extension, application/octet-stream' } })
    if (!packageResponse.ok || !ALLOWED_DOWNLOAD_HOSTS.has(new URL(packageResponse.url || packageUrl).hostname)) throw new Error('The upstream iCloud Passwords package is unavailable.')
    const bytes = await boundedBytes(packageResponse, VEXT_LIMITS.maxCompressedBytes)
    if (await sha256Hex(bytes) !== expectedHash) throw new Error('The upstream iCloud Passwords package failed its integrity check.')
    const parsed = parseVerifiedICloudCrx(bytes)
    if (parsed.version !== version) throw new Error('Upstream metadata and CRX versions disagree.')
    return parsed
  }
}
