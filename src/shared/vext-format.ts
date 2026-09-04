import { inflateSync, zipSync } from 'fflate'

export const VEXT_FORMAT_VERSION = 1
export const VEXT_SIGNATURE_VERSION = 1
export const VEXT_SIGNATURE_ALGORITHM = 'Ed25519'
export const VEXT_METADATA_PATH = 'META-INF/vast-package.json'
export const VEXT_SIGNATURE_PATH = 'META-INF/vast-signature.json'
export const VEXT_LIMITS = Object.freeze({
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 40 * 1024 * 1024,
  maxFileBytes: 15 * 1024 * 1024,
  maxFiles: 2_000,
  maxPathBytes: 512,
  maxCompressionRatio: 200
})

export const VEXT_EXTENSION_ID = /^[a-p]{32}$/
export const VEXT_PUBLISHER_ID = /^publisher_[a-z0-9]{16,48}$/
export const VEXT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const forbiddenExtensions = new Set([
  '.exe', '.dll', '.node', '.sys', '.dylib', '.so', '.bat', '.cmd', '.ps1', '.sh',
  '.msi', '.com', '.scr', '.jar', '.app', '.deb', '.rpm', '.zip', '.vext', '.rar', '.7z', '.tar', '.gz'
])
const reservedWindowsNames = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const packageMetadataPaths = new Set([VEXT_METADATA_PATH.toLowerCase(), VEXT_SIGNATURE_PATH.toLowerCase()])

export interface VextPackageFile {
  path: string
  size: number
  sha256: string
}

export interface VextPackageMetadata {
  format_version: 1
  extension_id: string
  version: string
  manifest_sha256: string
  publisher_id: string | null
  files: VextPackageFile[]
}

export interface VextSignatureRecord {
  signature_version: 1
  algorithm: 'Ed25519'
  key_id: string
  signature: string
}

export interface VextTrustedKey {
  keyId: string
  algorithm: 'Ed25519'
  publicKeySpkiBase64: string
  status: 'current' | 'next' | 'legacy' | 'test'
}

export interface ParsedVextPackage {
  metadata: VextPackageMetadata
  signature?: VextSignatureRecord
  files: Map<string, Uint8Array>
  packageSha256: string
  canonicalMetadata: Uint8Array
  verifiedKeyId?: string
}

export interface VextPackageSigner {
  keyId: string
  sign: (canonicalMetadata: Uint8Array) => Promise<Uint8Array>
}

interface ZipDirectoryEntry {
  path: string
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  versionMadeBy: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error('Package is damaged or incomplete.')
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('Package is damaged or incomplete.')
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function sliceExact(bytes: Uint8Array, start: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > bytes.byteLength) {
    throw new Error('Package is damaged or incomplete.')
  }
  return bytes.subarray(start, start + length)
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new Error('Package contains invalid UTF-8.')
  }
}

function findEocd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 0xffff - 22)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset
  }
  throw new Error('Package is damaged or incomplete.')
}

export function normalizeVextPath(input: string): string {
  if (!input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || input.startsWith('//') || /^[A-Za-z]:/.test(input) || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error(`Unsafe package path: ${input || '[empty]'}.`)
  }
  if (encoder.encode(input).byteLength > VEXT_LIMITS.maxPathBytes || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error(`Invalid package path: ${input || '[empty]'}.`)
  }
  const segments = input.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment) || segment.endsWith('.') || segment.endsWith(' ') || reservedWindowsNames.test(segment))) {
    throw new Error(`Unsafe Windows path: ${input}.`)
  }
  return segments.join('/')
}

function extensionFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function parseZipDirectory(bytes: Uint8Array): { entries: ZipDirectoryEntry[]; centralOffset: number } {
  if (bytes.byteLength === 0 || bytes.byteLength > VEXT_LIMITS.maxCompressedBytes) throw new Error('Package is empty or too large.')
  const eocd = findEocd(bytes)
  const disk = readU16(bytes, eocd + 4)
  const centralDisk = readU16(bytes, eocd + 6)
  const diskEntries = readU16(bytes, eocd + 8)
  const entryCount = readU16(bytes, eocd + 10)
  const centralSize = readU32(bytes, eocd + 12)
  const centralOffset = readU32(bytes, eocd + 16)
  const commentLength = readU16(bytes, eocd + 20)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 || entryCount > VEXT_LIMITS.maxFiles + 2) {
    throw new Error('Package uses an unsupported ZIP layout.')
  }
  if (eocd + 22 + commentLength !== bytes.byteLength || centralOffset + centralSize !== eocd) throw new Error('Invalid ZIP directory.')

  const entries: ZipDirectoryEntry[] = []
  const exact = new Set<string>()
  const folded = new Set<string>()
  let cursor = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory.')
    const versionMadeBy = readU16(bytes, cursor + 4)
    const flags = readU16(bytes, cursor + 8)
    const method = readU16(bytes, cursor + 10)
    const crc = readU32(bytes, cursor + 16)
    const compressedSize = readU32(bytes, cursor + 20)
    const uncompressedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const entryCommentLength = readU16(bytes, cursor + 32)
    const diskStart = readU16(bytes, cursor + 34)
    const externalAttributes = readU32(bytes, cursor + 38)
    const localOffset = readU32(bytes, cursor + 42)
    const recordLength = 46 + nameLength + extraLength + entryCommentLength
    if (cursor + recordLength > eocd || diskStart !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error('Invalid or unsupported ZIP64 entry.')
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0 || (flags & ~0x0800) !== 0 || (method !== 0 && method !== 8)) {
      throw new Error('ZIP entry is encrypted or unsupported.')
    }
    const path = normalizeVextPath(decodeUtf8(sliceExact(bytes, cursor + 46, nameLength)))
    if (path.endsWith('/')) throw new Error(`ZIP directories are not allowed: ${path}.`)
    const lower = path.toLowerCase()
    if (exact.has(path) || folded.has(lower)) throw new Error(`duplicate or case-colliding path: ${path}.`)
    exact.add(path)
    folded.add(lower)
    const unixMode = (externalAttributes >>> 16) & 0xffff
    const host = versionMadeBy >>> 8
    if (host === 3 && unixMode !== 0 && (unixMode & 0xf000) !== 0x8000) throw new Error(`Package has a symlink or special file: ${path}.`)
    if (!packageMetadataPaths.has(lower) && forbiddenExtensions.has(extensionFor(path))) throw new Error(`Forbidden executable or archive: ${path}.`)
    if (uncompressedSize > VEXT_LIMITS.maxFileBytes) throw new Error(`Package file too large: ${path}.`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > VEXT_LIMITS.maxUncompressedBytes) throw new Error('Package expands past its limit.')
    if (uncompressedSize > 1024 * 1024 && compressedSize > 0 && uncompressedSize / compressedSize > VEXT_LIMITS.maxCompressionRatio) {
      throw new Error(`Suspicious compression ratio: ${path}.`)
    }
    entries.push({ path, flags, method, crc32: crc, compressedSize, uncompressedSize, localOffset, externalAttributes, versionMadeBy })
    cursor += recordLength
  }
  if (cursor !== eocd) throw new Error('ZIP directory has trailing data.')
  return { entries, centralOffset }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let next = value
    for (let bit = 0; bit < 8; bit += 1) next = (next & 1) !== 0 ? 0xedb88320 ^ (next >>> 1) : next >>> 1
    table[value] = next >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function extractZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const { entries, centralOffset } = parseZipDirectory(bytes)
  const result = new Map<string, Uint8Array>()
  const ranges: Array<{ start: number; end: number }> = []
  for (const entry of entries) {
    const offset = entry.localOffset
    if (offset + 30 > centralOffset || readU32(bytes, offset) !== 0x04034b50) throw new Error(`Invalid local ZIP entry: ${entry.path}.`)
    const localFlags = readU16(bytes, offset + 6)
    const localMethod = readU16(bytes, offset + 8)
    const localCrc = readU32(bytes, offset + 14)
    const localCompressed = readU32(bytes, offset + 18)
    const localUncompressed = readU32(bytes, offset + 22)
    const nameLength = readU16(bytes, offset + 26)
    const extraLength = readU16(bytes, offset + 28)
    const localPath = decodeUtf8(sliceExact(bytes, offset + 30, nameLength))
    if (localPath !== entry.path || localFlags !== entry.flags || localMethod !== entry.method || localCrc !== entry.crc32 || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      throw new Error(`ZIP records disagree: ${entry.path}.`)
    }
    const dataStart = offset + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > centralOffset) throw new Error(`Invalid ZIP bounds: ${entry.path}.`)
    ranges.push({ start: offset, end: dataEnd })
    const compressed = sliceExact(bytes, dataStart, entry.compressedSize)
    let data: Uint8Array
    try {
      data = entry.method === 0 ? compressed.slice() : inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) })
    } catch {
      throw new Error(`Could not decompress: ${entry.path}.`)
    }
    if (data.byteLength !== entry.uncompressedSize || crc32(data) !== entry.crc32) throw new Error(`ZIP integrity failed: ${entry.path}.`)
    result.set(entry.path, data)
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index].start < ranges[index - 1].end) throw new Error('ZIP entries overlap.')
  return result
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Package metadata has an invalid ${label}.`)
  return value
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Package contains an invalid UTF-8')) throw error
    throw new Error(`Invalid JSON: ${label}.`)
  }
}

function parseMetadata(value: unknown): VextPackageMetadata {
  if (!isObject(value) || value.format_version !== 1 || !VEXT_EXTENSION_ID.test(String(value.extension_id)) || !VEXT_VERSION.test(String(value.version))) {
    throw new Error('Invalid package metadata version.')
  }
  const publisher = value.publisher_id
  if (publisher !== null && (!VEXT_PUBLISHER_ID.test(String(publisher)))) throw new Error('Invalid publisher identity.')
  const manifestSha = requiredString(value.manifest_sha256, 'manifest hash', 64)
  if (!/^[a-f0-9]{64}$/.test(manifestSha) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > VEXT_LIMITS.maxFiles) {
    throw new Error('Invalid package file list.')
  }
  const files: VextPackageFile[] = value.files.map((item) => {
    if (!isObject(item)) throw new Error('Invalid package file entry.')
    const path = normalizeVextPath(requiredString(item.path, 'file path', VEXT_LIMITS.maxPathBytes))
    const size = item.size
    const sha256 = requiredString(item.sha256, 'file hash', 64)
    if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > VEXT_LIMITS.maxFileBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Package metadata is invalid for ${path}.`)
    }
    return { path, size: Number(size), sha256 }
  })
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path))
  if (files.some((file, index) => file.path !== sorted[index].path) || new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) {
    throw new Error('Package files are not uniquely sorted.')
  }
  return {
    format_version: 1,
    extension_id: String(value.extension_id),
    version: String(value.version),
    manifest_sha256: manifestSha,
    publisher_id: publisher === null ? null : String(publisher),
    files
  }
}

function parseSignature(value: unknown): VextSignatureRecord {
  if (!isObject(value) || value.signature_version !== 1 || value.algorithm !== VEXT_SIGNATURE_ALGORITHM) throw new Error('Package signature record is invalid.')
  const keyId = requiredString(value.key_id, 'signature key ID', 128)
  const signature = requiredString(value.signature, 'signature', 512)
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(keyId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('Package signature record is invalid.')
  return { signature_version: 1, algorithm: 'Ed25519', key_id: keyId, signature }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON needs finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  throw new Error('Unsupported canonical JSON value.')
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new Error('Invalid signature encoding.')
  }
}

export async function verifyEd25519Signature(
  payload: Uint8Array,
  signatureBase64: string,
  keyId: string,
  trustedKeys: readonly VextTrustedKey[]
): Promise<boolean> {
  const trusted = trustedKeys.find((key) => key.keyId === keyId && key.algorithm === VEXT_SIGNATURE_ALGORITHM)
  if (!trusted) throw new Error('Extension metadata uses an unknown signing key.')
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('spki', base64ToBytes(trusted.publicKeySpkiBase64).slice().buffer, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    throw new Error('Invalid trusted extension key.')
  }
  return crypto.subtle.verify('Ed25519', key, base64ToBytes(signatureBase64).slice().buffer, payload.slice().buffer)
}

async function validateManifestIdentity(metadata: VextPackageMetadata, manifestBytes: Uint8Array): Promise<void> {
  let manifest: unknown
  try { manifest = JSON.parse(decodeUtf8(manifestBytes)) as unknown } catch { throw new Error('Invalid packaged manifest.json.') }
  if (!isObject(manifest) || manifest.version !== metadata.version) throw new Error('Package version differs from manifest.json.')
  if (isObject(manifest.vast) && manifest.vast.extension_id !== undefined && manifest.vast.extension_id !== metadata.extension_id) {
    throw new Error('Package extension identity does not match manifest.json.')
  }
}

export async function parseVextPackage(bytes: Uint8Array): Promise<ParsedVextPackage> {
  const entries = extractZipEntries(bytes)
  const metadataBytes = entries.get(VEXT_METADATA_PATH)
  if (!metadataBytes) throw new Error('Package metadata is missing.')
  const metadata = parseMetadata(parseJson(metadataBytes, 'Package metadata'))
  const canonicalMetadata = encoder.encode(canonicalJson(metadata))
  if (decodeUtf8(metadataBytes) !== decodeUtf8(canonicalMetadata)) throw new Error('Package metadata is not canonical.')
  const signatureBytes = entries.get(VEXT_SIGNATURE_PATH)
  const signature = signatureBytes ? parseSignature(parseJson(signatureBytes, 'Package signature')) : undefined
  const extensionFiles = new Map([...entries].filter(([path]) => !packageMetadataPaths.has(path.toLowerCase())))
  if (extensionFiles.size !== metadata.files.length) throw new Error('Package file list differs from metadata.')
  for (const expected of metadata.files) {
    const data = extensionFiles.get(expected.path)
    if (!data || data.byteLength !== expected.size || await sha256Hex(data) !== expected.sha256) throw new Error(`Package hash mismatch for ${expected.path}.`)
  }
  const manifest = extensionFiles.get('manifest.json')
  if (!manifest || await sha256Hex(manifest) !== metadata.manifest_sha256) throw new Error('Manifest hash mismatch.')
  await validateManifestIdentity(metadata, manifest)
  return { metadata, ...(signature ? { signature } : {}), files: extensionFiles, packageSha256: await sha256Hex(bytes), canonicalMetadata }
}

export async function verifyVextPackage(bytes: Uint8Array, trustedKeys: readonly VextTrustedKey[], requireSignature: boolean): Promise<ParsedVextPackage> {
  const parsed = await parseVextPackage(bytes)
  if (!parsed.signature) {
    if (requireSignature) throw new Error('Could not verify extension package.')
    return parsed
  }
  const valid = await verifyEd25519Signature(parsed.canonicalMetadata, parsed.signature.signature, parsed.signature.key_id, trustedKeys)
  if (!valid) throw new Error('Could not verify extension package.')
  return { ...parsed, verifiedKeyId: parsed.signature.key_id }
}

export async function createVextPackage(input: {
  extensionId: string
  version: string
  publisherId: string | null
  files: ReadonlyMap<string, Uint8Array>
  signer?: VextPackageSigner
}): Promise<Uint8Array> {
  if (!VEXT_EXTENSION_ID.test(input.extensionId) || !VEXT_VERSION.test(input.version) || (input.publisherId !== null && !VEXT_PUBLISHER_ID.test(input.publisherId))) {
    throw new Error('Invalid package identity.')
  }
  const files = [...input.files].map(([path, data]) => ({ path: normalizeVextPath(path), data }))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (files.length === 0 || files.length > VEXT_LIMITS.maxFiles || new Set(files.map((item) => item.path.toLowerCase())).size !== files.length) {
    throw new Error('Invalid package file set.')
  }
  let total = 0
  const fileMetadata: VextPackageFile[] = []
  for (const file of files) {
    if (packageMetadataPaths.has(file.path.toLowerCase()) || forbiddenExtensions.has(extensionFor(file.path)) || file.data.byteLength > VEXT_LIMITS.maxFileBytes) {
      throw new Error(`Forbidden or oversized file: ${file.path}.`)
    }
    total += file.data.byteLength
    if (total > VEXT_LIMITS.maxUncompressedBytes) throw new Error('Package expands past its limit.')
    fileMetadata.push({ path: file.path, size: file.data.byteLength, sha256: await sha256Hex(file.data) })
  }
  const manifest = input.files.get('manifest.json')
  if (!manifest) throw new Error('Package requires manifest.json.')
  const metadata: VextPackageMetadata = {
    format_version: 1,
    extension_id: input.extensionId,
    version: input.version,
    manifest_sha256: await sha256Hex(manifest),
    publisher_id: input.publisherId,
    files: fileMetadata
  }
  await validateManifestIdentity(metadata, manifest)
  const canonicalMetadata = encoder.encode(canonicalJson(metadata))
  const archiveEntries: Record<string, Uint8Array> = {}
  for (const file of files) archiveEntries[file.path] = file.data
  archiveEntries[VEXT_METADATA_PATH] = canonicalMetadata
  if (input.signer) {
    const signature = await input.signer.sign(canonicalMetadata)
    const record: VextSignatureRecord = { signature_version: 1, algorithm: 'Ed25519', key_id: input.signer.keyId, signature: bytesToBase64(signature) }
    archiveEntries[VEXT_SIGNATURE_PATH] = encoder.encode(canonicalJson(record))
  }
  const packageBytes = zipSync(archiveEntries, { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') })
  if (packageBytes.byteLength > VEXT_LIMITS.maxCompressedBytes) throw new Error('Package is too large.')
  return packageBytes
}

export async function createEd25519Signer(keyId: string, privateKeyPkcs8Base64: string): Promise<VextPackageSigner> {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(keyId)) throw new Error('Signing key ID is invalid.')
  const key = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyPkcs8Base64).slice().buffer, { name: 'Ed25519' }, false, ['sign'])
  return { keyId, sign: async (metadata) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, metadata.slice().buffer)) }
}
