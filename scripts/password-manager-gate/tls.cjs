const fs = require('node:fs')
const path = require('node:path')
const { FIXTURE_HOSTS } = require('./config.cjs')

const ROOT_SUBJECT = 'CN=Vast Password Manager Gate Root'
const LEAF_SUBJECT = 'CN=login.vast-test.local'
const MINIMUM_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000

function isApprovedFixtureHost(hostname) {
  return typeof hostname === 'string' && FIXTURE_HOSTS.includes(hostname)
}

function fixtureHostResolverRules() {
  return FIXTURE_HOSTS.map((hostname) => `MAP ${hostname} 127.0.0.1`).join(', ')
}

function assertSafeLeafName(value, field) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/]/.test(value) || path.basename(value) !== value) {
    throw new Error(`TLS metadata ${field} must be a plain file name.`)
  }
}

function validateTlsMetadata(metadata, now = new Date()) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('TLS metadata must be an object.')
  if (metadata.schemaVersion !== 1) throw new Error('Unsupported TLS metadata schema version.')
  if (metadata.rootSubject !== ROOT_SUBJECT) throw new Error(`TLS root subject must be ${ROOT_SUBJECT}.`)
  if (metadata.leafSubject !== LEAF_SUBJECT) throw new Error(`TLS leaf subject must be ${LEAF_SUBJECT}.`)
  for (const field of ['rootThumbprint', 'leafThumbprint']) {
    if (typeof metadata[field] !== 'string' || !/^[A-F0-9]{40}$/.test(metadata[field])) {
      throw new Error(`TLS metadata ${field} must be a normalized SHA-1 thumbprint.`)
    }
  }
  if (!Array.isArray(metadata.dnsNames) ||
      metadata.dnsNames.length !== FIXTURE_HOSTS.length ||
      metadata.dnsNames.some((name, index) => name !== FIXTURE_HOSTS[index])) {
    throw new Error(`TLS leaf SAN list must exactly match: ${FIXTURE_HOSTS.join(', ')}.`)
  }
  const expiresAt = new Date(metadata.expiresAt)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < now.getTime() + MINIMUM_VALIDITY_MS) {
    throw new Error('TLS leaf certificate must remain valid for at least seven days.')
  }
  assertSafeLeafName(metadata.pfxFile, 'pfxFile')
  assertSafeLeafName(metadata.passphraseFile, 'passphraseFile')
}

function readRequiredFile(filePath, label) {
  try {
    return fs.readFileSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} is missing: ${filePath}`)
    throw error
  }
}

function ensureTlsMaterial(tlsRoot) {
  const resolvedRoot = path.resolve(tlsRoot)
  const metadataPath = path.join(resolvedRoot, 'metadata.json')
  let metadata
  try {
    metadata = JSON.parse(readRequiredFile(metadataPath, 'TLS metadata').toString('utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`TLS metadata is invalid JSON: ${error.message}`)
    throw error
  }
  validateTlsMetadata(metadata)

  const pfx = readRequiredFile(path.join(resolvedRoot, metadata.pfxFile), 'TLS PFX')
  const passphrase = readRequiredFile(path.join(resolvedRoot, metadata.passphraseFile), 'TLS passphrase').toString('utf8').trim()
  if (!passphrase) throw new Error('TLS passphrase file is empty.')

  const material = {
    pfx,
    rootThumbprint: metadata.rootThumbprint,
    leafThumbprint: metadata.leafThumbprint,
    dnsNames: Object.freeze([...metadata.dnsNames]),
    expiresAt: metadata.expiresAt
  }
  Object.defineProperty(material, 'passphrase', {
    value: passphrase,
    enumerable: false,
    writable: false,
    configurable: false
  })
  return Object.freeze(material)
}

module.exports = {
  LEAF_SUBJECT,
  ROOT_SUBJECT,
  ensureTlsMaterial,
  fixtureHostResolverRules,
  isApprovedFixtureHost,
  validateTlsMetadata
}
