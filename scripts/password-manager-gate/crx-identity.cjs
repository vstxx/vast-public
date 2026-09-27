const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readVarint(bytes, start) {
  let value = 0
  let shift = 0
  let offset = start
  for (;;) {
    if (offset >= bytes.length || shift > 49) throw new Error('Invalid CRX protobuf varint.')
    const byte = bytes[offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return [value, offset]
    shift += 7
  }
}

function protobufFields(bytes) {
  const fields = []
  let offset = 0
  while (offset < bytes.length) {
    let tag
    ;[tag, offset] = readVarint(bytes, offset)
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 2) {
      let length
      ;[length, offset] = readVarint(bytes, offset)
      if (length < 0 || offset + length > bytes.length) throw new Error('Invalid CRX protobuf field length.')
      fields.push({ field, value: bytes.subarray(offset, offset + length) })
      offset += length
    } else if (wire === 0) {
      let value
      ;[value, offset] = readVarint(bytes, offset)
      fields.push({ field, value })
    } else if (wire === 1) {
      offset += 8
    } else if (wire === 5) {
      offset += 4
    } else {
      throw new Error(`Unsupported CRX protobuf wire type ${wire}.`)
    }
    if (offset > bytes.length) throw new Error('CRX protobuf field extends beyond its header.')
  }
  return fields
}

function idFromKey(key) {
  if (!Buffer.isBuffer(key) || key.length === 0) throw new Error('Extension public key must be a non-empty Buffer.')
  const digest = createHash('sha256').update(key).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}

function readCrxIdentity(crxPath, expectedId) {
  if (!fs.existsSync(crxPath)) throw new Error(`The upstream CRX used to prove ${expectedId} identity is missing: ${crxPath}`)
  const bytes = fs.readFileSync(crxPath)
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'Cr24' || bytes.readUInt32LE(4) !== 3) {
    throw new Error(`Expected a CRX3 package: ${crxPath}`)
  }
  const headerLength = bytes.readUInt32LE(8)
  if (12 + headerLength > bytes.length) throw new Error(`CRX3 header is truncated: ${crxPath}`)
  const header = protobufFields(bytes.subarray(12, 12 + headerLength))
  for (const proof of header.filter(({ field }) => field === 2 || field === 3)) {
    const key = protobufFields(proof.value).find(({ field }) => field === 1)?.value
    if (key && idFromKey(key) === expectedId) {
      return { extensionId: expectedId, manifestKey: key.toString('base64'), crxSha256: sha256(bytes) }
    }
  }
  throw new Error(`CRX3 does not contain a public key for expected extension ID ${expectedId}.`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function stageIdentityRuntime({ gateRoot, key, popup, sourcePath, expectedId, identity }) {
  if (identity.extensionId !== expectedId) throw new Error(`Refusing to stage ${key}: CRX identity does not match ${expectedId}.`)
  const manifestPath = path.join(sourcePath, 'manifest.json')
  const sourceManifestBytes = fs.readFileSync(manifestPath)
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8').replace(/^\uFEFF/, ''))
  if (sourceManifest.manifest_version !== 3) throw new Error(`${key} must be a Manifest V3 extension.`)

  const before = { ...sourceManifest }
  const staged = { ...sourceManifest, key: identity.manifestKey }
  assert.deepEqual(Object.keys(staged).filter((name) => name !== 'key'), Object.keys(before))
  assert.equal(idFromKey(Buffer.from(staged.key, 'base64')), expectedId)

  const sourceManifestSha256 = sha256(sourceManifestBytes)
  const runtimePath = path.join(gateRoot, 'identity-runtime', `${key}-${expectedId}-${sourceManifest.version}`)
  const markerName = '.vast-password-manager-identity.json'
  const marker = { schemaVersion: 1, sourceManifestSha256, crxSha256: identity.crxSha256, expectedId }
  if (fs.existsSync(runtimePath)) {
    const currentMarkerPath = path.join(runtimePath, markerName)
    let currentMarker
    try { currentMarker = readJson(currentMarkerPath) } catch { currentMarker = undefined }
    assert.deepEqual(currentMarker, marker, 'Identity runtime marker does not match its verified sources.')
    const currentManifest = readJson(path.join(runtimePath, 'manifest.json'))
    assert.deepEqual(
      { ...currentManifest, key: undefined },
      { ...sourceManifest, key: undefined },
      'Staged manifest differs from its source outside manifest.key.'
    )
    assert.equal(idFromKey(Buffer.from(currentManifest.key, 'base64')), expectedId)
    return Object.freeze({
      key,
      version: sourceManifest.version,
      popup,
      sourcePath: fs.realpathSync(sourcePath),
      runtimePath: fs.realpathSync(runtimePath),
      runtimeId: expectedId,
      manifestSha256: sourceManifestSha256,
      crxSha256: identity.crxSha256
    })
  }

  fs.mkdirSync(path.dirname(runtimePath), { recursive: true })
  const temporary = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.cpSync(sourcePath, temporary, { recursive: true, force: false, errorOnExist: true })
    fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(staged, null, 2)}\n`, 'utf8')
    fs.writeFileSync(path.join(temporary, markerName), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, runtimePath)
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }

  return Object.freeze({
    key,
    version: sourceManifest.version,
    popup,
    sourcePath: fs.realpathSync(sourcePath),
    runtimePath: fs.realpathSync(runtimePath),
    runtimeId: expectedId,
    manifestSha256: sourceManifestSha256,
    crxSha256: identity.crxSha256
  })
}

module.exports = { idFromKey, readCrxIdentity, stageIdentityRuntime }
