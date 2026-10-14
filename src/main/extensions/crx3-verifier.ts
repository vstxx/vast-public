import { createHash, createPublicKey, constants, verify } from 'node:crypto'
import { extractSecureZipEntries, VEXT_LIMITS } from '../../shared/vext-format.ts'
import { isChromeExtensionVersion } from '../../shared/chrome-extension-version.ts'
import type { VerifiedUpstreamPackage } from './extension-managed-store.ts'

const MAX_HEADER_BYTES = 1024 * 1024
const SIGNED_CONTEXT = Buffer.from('CRX3 SignedData\0', 'utf8')
const EXTENSION_ID = /^[a-p]{32}$/
// Chromium 152 components/crx_file/crx_verifier.cc: ecdsa_2017_public.
const STORE_PUBLISHER_KEY_SHA256 = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf'

interface Field { number: number; bytes?: Buffer; integer?: number }

function readFields(data: Uint8Array): Field[] {
  const fields: Field[] = []
  let offset = 0
  const varint = (): number => {
    let value = 0
    let shift = 0
    for (let count = 0; count < 8; count += 1) {
      if (offset >= data.length) throw new Error('CRX3 protobuf is truncated.')
      const byte = data[offset++]
      value += (byte & 0x7f) * 2 ** shift
      if (!Number.isSafeInteger(value)) throw new Error('CRX3 protobuf integer is too large.')
      if (!(byte & 0x80)) return value
      shift += 7
    }
    throw new Error('CRX3 protobuf integer is too large.')
  }
  while (offset < data.length) {
    const tag = varint()
    const number = Math.floor(tag / 8)
    const wire = tag % 8
    if (number < 1) throw new Error('CRX3 protobuf field is invalid.')
    if (wire === 2) {
      const size = varint()
      if (size > data.length - offset) throw new Error('CRX3 protobuf field is truncated.')
      fields.push({ number, bytes: Buffer.from(data.subarray(offset, offset + size)) })
      offset += size
    } else if (wire === 0) fields.push({ number, integer: varint() })
    else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (size > data.length - offset) throw new Error('CRX3 protobuf field is truncated.')
      offset += size
    } else throw new Error('CRX3 protobuf wire type is invalid.')
  }
  return fields
}

function onlyBytes(fields: Field[], number: number): Buffer {
  const matches = fields.filter((field) => field.number === number)
  if (matches.length !== 1 || !matches[0].bytes) throw new Error('CRX3 signed identity is missing or ambiguous.')
  return matches[0].bytes
}

function idFromPublicKey(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  return [...hash].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
}

function idFromSignedBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('CRX3 signed extension ID is invalid.')
  return [...bytes].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
}

export function verifyCwsCrx3(bytes: Uint8Array, expectedId: string): VerifiedUpstreamPackage {
  if (!EXTENSION_ID.test(expectedId)) throw new Error('Chrome Web Store extension ID is invalid.')
  if (bytes.length < 13 || bytes.length > VEXT_LIMITS.maxCompressedBytes) throw new Error('CRX3 package size is invalid.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'Cr24' || view.getUint32(4, true) !== 3) throw new Error('Chrome Web Store package must be CRX3.')
  const headerSize = view.getUint32(8, true)
  if (headerSize < 1 || headerSize > MAX_HEADER_BYTES || headerSize >= bytes.length - 12) throw new Error('CRX3 header size is invalid.')
  const fields = readFields(bytes.subarray(12, 12 + headerSize))
  const signedHeader = onlyBytes(fields, 10000)
  const signedId = idFromSignedBytes(onlyBytes(readFields(signedHeader), 1))
  if (signedId !== expectedId) throw new Error('CRX3 signed extension ID does not match the store listing.')
  const archive = bytes.subarray(12 + headerSize)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedHeader.length)
  const signedPayload = Buffer.concat([SIGNED_CONTEXT, length, signedHeader, archive])
  let verifiedKey: Buffer | undefined
  let verifiedPublisher = false
  let proofCount = 0
  for (const field of fields) {
    if ((field.number !== 2 && field.number !== 3) || !field.bytes) continue
    proofCount += 1
    const proof = readFields(field.bytes)
    const publicKey = onlyBytes(proof, 1)
    const signature = onlyBytes(proof, 2)
    let valid = false
    try {
      const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' })
      valid = field.number === 2
        ? key.asymmetricKeyType === 'rsa' && verify('sha256', signedPayload, { key, padding: constants.RSA_PKCS1_PADDING }, signature)
        : key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' && verify('sha256', signedPayload, key, signature)
    } catch { valid = false }
    if (!valid) throw new Error('CRX3 cryptographic proof is invalid.')
    if (idFromPublicKey(publicKey) === signedId) verifiedKey = publicKey
    if (createHash('sha256').update(publicKey).digest('hex') === STORE_PUBLISHER_KEY_SHA256) verifiedPublisher = true
  }
  if (!proofCount || !verifiedKey || !verifiedPublisher) throw new Error('CRX3 developer identity or Chrome Web Store publisher proof is missing.')
  const files = extractSecureZipEntries(archive)
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error('CRX3 manifest is missing.')
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as Record<string, unknown> }
  catch { throw new Error('CRX3 manifest is invalid.') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !isChromeExtensionVersion(String(manifest.version ?? ''))) throw new Error('CRX3 manifest version is invalid.')
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('CRX3 manifest format is unsupported.')
  if ('vast' in manifest) throw new Error('Chrome Web Store extensions cannot request Vast native privileges.')
  for (const group of [manifest.permissions, manifest.optional_permissions]) {
    if (group !== undefined && !Array.isArray(group)) throw new Error('CRX3 permissions are invalid.')
    if (Array.isArray(group) && group.some((value) => value === 'vast' || value === 'vast_network' || value === 'vast_document_rules')) throw new Error('Chrome Web Store extensions cannot request Vast native privileges.')
  }
  if (manifest.key !== undefined) {
    if (typeof manifest.key !== 'string' || !Buffer.from(manifest.key, 'base64').equals(verifiedKey)) throw new Error('CRX3 manifest key does not match the verified signer.')
  } else {
    manifest.key = verifiedKey.toString('base64')
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  }
  return { extensionId: expectedId, version: String(manifest.version), packageSha256: createHash('sha256').update(bytes).digest('hex'), files }
}
