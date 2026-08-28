import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync, zipSync } from 'fflate'
import {
  VEXT_LIMITS,
  VEXT_METADATA_PATH,
  VEXT_SIGNATURE_PATH,
  createEd25519Signer,
  createVextPackage,
  parseVextPackage,
  verifyVextPackage,
  type VextTrustedKey
} from '../../src/shared/vext-format.ts'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const publisherId = 'publisher_0123456789abcdef'
const encoder = new TextEncoder()

function files(version = '1.0.0'): Map<string, Uint8Array> {
  return new Map([
    ['background.js', encoder.encode('globalThis.fixture = true')],
    ['manifest.json', encoder.encode(JSON.stringify({ manifest_version: 3, name: 'Packaged fixture', version, vast: { api_version: 1, extension_id: extensionId, background: 'background.js', permissions: [] } }))]
  ])
}

async function keys(): Promise<{ signer: Awaited<ReturnType<typeof createEd25519Signer>>; trusted: VextTrustedKey }> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const [privateKey, publicKey] = await Promise.all([crypto.subtle.exportKey('pkcs8', pair.privateKey), crypto.subtle.exportKey('spki', pair.publicKey)])
  const keyId = 'vast-test-only-key'
  return {
    signer: await createEd25519Signer(keyId, Buffer.from(privateKey).toString('base64')),
    trusted: { keyId, algorithm: 'Ed25519', publicKeySpkiBase64: Buffer.from(publicKey).toString('base64'), status: 'test' }
  }
}

function replaceAscii(input: Uint8Array, before: string, after: string): Uint8Array {
  assert.equal(before.length, after.length)
  const output = input.slice()
  const source = encoder.encode(before)
  const replacement = encoder.encode(after)
  for (let offset = 0; offset <= output.length - source.length; offset += 1) {
    if (source.every((byte, index) => output[offset + index] === byte)) output.set(replacement, offset)
  }
  return output
}

function makeSymlinkArchive(): Uint8Array {
  const output = zipSync({ link: encoder.encode('target') })
  for (let offset = 0; offset + 46 <= output.byteLength; offset += 1) {
    if (output[offset] !== 0x50 || output[offset + 1] !== 0x4b || output[offset + 2] !== 0x01 || output[offset + 3] !== 0x02) continue
    output[offset + 4] = 20
    output[offset + 5] = 3
    const attributes = (0xa1ff << 16) >>> 0
    output[offset + 38] = attributes & 0xff
    output[offset + 39] = (attributes >>> 8) & 0xff
    output[offset + 40] = (attributes >>> 16) & 0xff
    output[offset + 41] = (attributes >>> 24) & 0xff
    break
  }
  return output
}

test('creates byte-for-byte deterministic .vext archives and validates all metadata hashes', async () => {
  const first = await createVextPackage({ extensionId, version: '1.0.0', publisherId: null, files: files() })
  const second = await createVextPackage({ extensionId, version: '1.0.0', publisherId: null, files: files() })
  assert.deepEqual(first, second)
  const parsed = await parseVextPackage(first)
  assert.equal(parsed.metadata.extension_id, extensionId)
  assert.equal(parsed.metadata.version, '1.0.0')
  assert.deepEqual([...parsed.files.keys()], ['background.js', 'manifest.json'])
  assert.match(parsed.packageSha256, /^[a-f0-9]{64}$/)
})

test('verifies Ed25519 package signatures and rejects unknown keys and tampering', async () => {
  const { signer, trusted } = await keys()
  const signed = await createVextPackage({ extensionId, version: '1.0.0', publisherId, files: files(), signer })
  assert.equal((await verifyVextPackage(signed, [trusted], true)).verifiedKeyId, trusted.keyId)
  await assert.rejects(verifyVextPackage(signed, [], true), /unknown signing key/)

  const archive = unzipSync(signed)
  const record = JSON.parse(new TextDecoder().decode(archive[VEXT_SIGNATURE_PATH])) as { signature: string }
  record.signature = `${record.signature[0] === 'A' ? 'B' : 'A'}${record.signature.slice(1)}`
  archive[VEXT_SIGNATURE_PATH] = encoder.encode(JSON.stringify(record))
  await assert.rejects(verifyVextPackage(zipSync(archive), [trusted], true), /Could not verify/)
})

test('rejects file and manifest tampering even when ZIP checksums are internally valid', async () => {
  const packageBytes = await createVextPackage({ extensionId, version: '1.0.0', publisherId: null, files: files() })
  const archive = unzipSync(packageBytes)
  archive['background.js'] = encoder.encode('globalThis.fixture = false')
  await assert.rejects(parseVextPackage(zipSync(archive)), /hash mismatch/)

  const second = unzipSync(packageBytes)
  const metadata = JSON.parse(new TextDecoder().decode(second[VEXT_METADATA_PATH])) as { extension_id: string }
  metadata.extension_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  second[VEXT_METADATA_PATH] = encoder.encode(JSON.stringify(metadata))
  await assert.rejects(parseVextPackage(zipSync(second)), /identity does not match/)
})

test('rejects traversal, absolute paths, reserved names, nested archives, and case collisions', async () => {
  for (const name of ['../escape.js', '/absolute.js', 'C:/drive.js', 'CON.txt', 'payload.zip', 'bad<name.js', 'bad>name.js', 'bad:name.js', 'bad"name.js', 'bad|name.js', 'bad?name.js', 'bad*name.js', 'trailing. ', 'folder/AUX.json']) {
    await assert.rejects(parseVextPackage(zipSync({ [name]: encoder.encode('x') })), /path|forbidden|reserved|absolute|metadata/i)
  }
  await assert.rejects(parseVextPackage(zipSync({ 'Script.js': encoder.encode('a'), 'script.js': encoder.encode('b') })), /case-colliding/)
  await assert.rejects(parseVextPackage(replaceAscii(zipSync({ 'a.js': encoder.encode('a'), 'b.js': encoder.encode('b') }), 'b.js', 'a.js')), /duplicate/)
})

test('rejects symlinks, compression bombs, too many entries, truncation, and unsupported ZIP flags', async () => {
  await assert.rejects(parseVextPackage(makeSymlinkArchive()), /symlink or special file/)
  await assert.rejects(parseVextPackage(zipSync({ 'bomb.txt': new Uint8Array(2 * 1024 * 1024) })), /compression ratio/)
  const many: Record<string, Uint8Array> = {}
  for (let index = 0; index < VEXT_LIMITS.maxFiles + 3; index += 1) many[`f${index}.txt`] = new Uint8Array()
  await assert.rejects(parseVextPackage(zipSync(many)), /unsupported ZIP layout/)
  const normal = zipSync({ 'plain.txt': encoder.encode('safe') })
  await assert.rejects(parseVextPackage(normal.subarray(0, normal.byteLength - 5)), /damaged or incomplete/)
  const encrypted = normal.slice()
  encrypted[6] |= 1
  const central = encrypted.findIndex((byte, index) => byte === 0x50 && encrypted[index + 1] === 0x4b && encrypted[index + 2] === 0x01 && encrypted[index + 3] === 0x02)
  encrypted[central + 8] |= 1
  await assert.rejects(parseVextPackage(encrypted), /encrypted or unsupported/)
})
