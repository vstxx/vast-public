import { createPublicKey, verify } from 'node:crypto'
import semver from 'semver'
import { canonicalizeRelayPayload } from './relay/crypto.ts'

// Signed release manifest for the downloadable Video & Audio module. The
// signature covers a domain-separated canonical JSON payload, so a key used
// here can never be confused with a Relay or Hub signature. The archive URL,
// size and digest are trusted only because they are inside the signed payload.

export const AVIDAE_MODULE_ID = 'vast-video-audio'
export const AVIDAE_MODULE_HOST_API = 1
export const AVIDAE_MODULE_SIGNATURE_DOMAIN = 'vast-avidae-module-manifest/v1\n'
const SHA256 = /^[a-f0-9]{64}$/
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3
const MAX_UNPACKED_BYTES = 8 * 1024 ** 3

export interface AvidaeModuleTrustedKey {
  keyId: string
  algorithm: 'Ed25519'
  publicKeySpkiBase64: string
  status: 'current' | 'legacy' | 'revoked'
}

export interface AvidaeModuleReleasePayload {
  schemaVersion: 1
  moduleId: typeof AVIDAE_MODULE_ID
  moduleVersion: string
  sequence: number
  platform: 'win32'
  arch: 'x64'
  hostApi: number
  minVastVersion: string
  publishedAt: string
  archive: {
    url: string
    fileName: string
    format: 'tar.zst'
    size: number
    sha256: string
    unpackedSize: number
    fileCount: number
  }
  runtimeManifest: { sha256: string; size: number }
  runtime: { runtimeVersion: string; python: string; playwright: string; pyinstaller: string; ffmpegVersion: string }
  ffmpegSource: { fileName: string; url: string; sha256: string; size: number }
  revokedModuleVersions: string[]
}

export interface VerifiedAvidaeModuleRelease {
  keyId: string
  payload: AvidaeModuleReleasePayload
}

export class ModuleManifestError extends Error {
  readonly code: 'signature' | 'incompatible' | 'invalid'

  constructor(message: string, code: 'signature' | 'incompatible' | 'invalid') {
    super(message)
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ModuleManifestError(message, 'invalid')
}

function isString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isSize(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
}

export function isAllowedModuleUrl(value: unknown, allowLoopbackHttp: boolean): value is string {
  if (!isString(value, 2048)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return allowLoopbackHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function validatePayload(value: unknown, allowLoopbackHttp: boolean): AvidaeModuleReleasePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Module manifest payload is missing.')
  const payload = value as Partial<AvidaeModuleReleasePayload>
  if (payload.schemaVersion !== 1 || payload.moduleId !== AVIDAE_MODULE_ID) invalid('Module manifest is not a Video & Audio module manifest.')
  if (!isString(payload.moduleVersion, 64) || !semver.valid(payload.moduleVersion)) invalid('Module version is invalid.')
  if (!Number.isSafeInteger(payload.sequence) || (payload.sequence as number) < 1) invalid('Module sequence is invalid.')
  if (!Number.isSafeInteger(payload.hostApi) || (payload.hostApi as number) < 1) invalid('Module host API is invalid.')
  if (!isString(payload.minVastVersion, 64) || !semver.valid(payload.minVastVersion)) invalid('Module minimum Vast version is invalid.')
  if (!isString(payload.publishedAt, 64) || Number.isNaN(Date.parse(payload.publishedAt))) invalid('Module publication time is invalid.')
  const archive = payload.archive
  if (!archive || !isAllowedModuleUrl(archive.url, allowLoopbackHttp) || !isString(archive.fileName, 128) ||
      !/^[A-Za-z0-9._-]+\.tar\.zst$/.test(archive.fileName) || archive.format !== 'tar.zst' ||
      !isSize(archive.size, MAX_ARCHIVE_BYTES) || !SHA256.test(String(archive.sha256)) ||
      !isSize(archive.unpackedSize, MAX_UNPACKED_BYTES) || !isSize(archive.fileCount, 200_000)) {
    invalid('Module archive metadata is invalid.')
  }
  if (!payload.runtimeManifest || !SHA256.test(String(payload.runtimeManifest.sha256)) || !isSize(payload.runtimeManifest.size, 4 * 1024 * 1024)) {
    invalid('Module runtime manifest metadata is invalid.')
  }
  const runtime = payload.runtime
  if (!runtime || !['runtimeVersion', 'python', 'playwright', 'pyinstaller', 'ffmpegVersion'].every((key) => isString((runtime as unknown as Record<string, unknown>)[key]))) {
    invalid('Module runtime metadata is invalid.')
  }
  const source = payload.ffmpegSource
  if (!source || !isString(source.fileName, 128) || !isAllowedModuleUrl(source.url, allowLoopbackHttp) ||
      !SHA256.test(String(source.sha256)) || !isSize(source.size, MAX_ARCHIVE_BYTES)) {
    invalid('Module FFmpeg corresponding-source reference is invalid.')
  }
  if (!Array.isArray(payload.revokedModuleVersions) || !payload.revokedModuleVersions.every((item) => isString(item, 64) && semver.valid(item))) {
    invalid('Module revocation list is invalid.')
  }
  return payload as AvidaeModuleReleasePayload
}

export function signedModuleBytes(payload: unknown): Buffer {
  return Buffer.from(`${AVIDAE_MODULE_SIGNATURE_DOMAIN}${canonicalizeRelayPayload(payload)}`, 'utf8')
}

export function verifyModuleReleaseManifest(
  raw: string,
  options: {
    trustedKeys: readonly AvidaeModuleTrustedKey[]
    vastVersion: string
    platform: string
    arch: string
    allowLoopbackHttp?: boolean
  }
): VerifiedAvidaeModuleRelease {
  if (raw.length > MAX_MANIFEST_BYTES) invalid('Module manifest is too large.')
  let envelope: { format?: unknown; keyId?: unknown; signature?: unknown; payload?: unknown }
  try {
    envelope = JSON.parse(raw) as typeof envelope
  } catch {
    invalid('Module manifest is not valid JSON.')
  }
  if (envelope.format !== 'vast-avidae-module-manifest' || !isString(envelope.keyId, 128) || !isString(envelope.signature, 256)) {
    invalid('Module manifest envelope is invalid.')
  }
  const trust = options.trustedKeys.find((key) => key.keyId === envelope.keyId)
  if (!trust || trust.status === 'revoked' || trust.algorithm !== 'Ed25519') {
    throw new ModuleManifestError('Module manifest is signed by an untrusted key.', 'signature')
  }
  let valid = false
  try {
    const keyBytes = Buffer.from(trust.publicKeySpkiBase64, 'base64')
    const signature = Buffer.from(envelope.signature, 'base64')
    const publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' })
    valid = publicKey.asymmetricKeyType === 'ed25519' && signature.length === 64 &&
      signature.toString('base64') === envelope.signature &&
      verify(null, signedModuleBytes(envelope.payload), publicKey, signature)
  } catch {
    valid = false
  }
  if (!valid) throw new ModuleManifestError('Module manifest signature is invalid.', 'signature')
  const payload = validatePayload(envelope.payload, options.allowLoopbackHttp === true)
  if (payload.platform !== options.platform || payload.arch !== options.arch) {
    throw new ModuleManifestError('This Video & Audio module is built for a different platform.', 'incompatible')
  }
  if (payload.hostApi !== AVIDAE_MODULE_HOST_API || !semver.valid(options.vastVersion) || semver.lt(options.vastVersion, payload.minVastVersion)) {
    throw new ModuleManifestError('This Video & Audio module needs a different version of Vast.', 'incompatible')
  }
  return { keyId: trust.keyId, payload }
}
