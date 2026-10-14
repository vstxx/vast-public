const { createHash } = require('node:crypto')
const { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } = require('node:fs')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

function resolveDailyProfile(appData) {
  if (!appData || !isAbsolute(appData)) throw new Error('APPDATA must be an absolute path.')
  const defaultRoot = join(appData, 'Vast')
  const configPath = join(defaultRoot, 'data-root.json')
  let candidate = defaultRoot
  if (existsSync(configPath)) {
    let config
    try { config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) } catch {
      throw new Error('The daily profile configuration is invalid; refusing to guess a data directory.')
    }
    if (typeof config.customDataRoot !== 'string' || !isAbsolute(config.customDataRoot)) {
      throw new Error('The configured daily profile path is invalid.')
    }
    candidate = resolve(config.customDataRoot)
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error('The configured daily profile is missing; refusing to create an empty profile.')
  }
  return realpathSync(candidate)
}

function assertAlphaMetadata(metadata, version, sourceCommit) {
  if (!/^0\.5\.0-alpha\.[1-9][0-9]*$/.test(version)) throw new Error('The local alpha version must be 0.5.0-alpha.N.')
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('The source commit must be a full Git SHA.')
  if (metadata.version !== version || metadata.releaseChannel !== 'alpha' || metadata.distributionChannel !== 'direct') {
    throw new Error('The package is not the requested local alpha version.')
  }
  if (metadata.privateBuild !== true) throw new Error('The alpha package must be private.')
  if (metadata.updateEnabled !== false) throw new Error('The alpha package network updater must be disabled.')
  if (metadata.sourceCommit !== sourceCommit) throw new Error('The alpha package source commit differs from the checked-out source.')
}

function assertOutside(child, parent, label) {
  const rel = relative(realpathSync(parent), realpathSync(child))
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error(`${label} must be outside the Vast installation directory.`)
  }
}

function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'))
}

function listPayloadFiles(root) {
  const files = []
  function visit(directory, prefix = '') {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error(`Payload contains a symbolic link: ${item.name}`)
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name
      if (!safeRelativePath(relativePath)) throw new Error(`Unsafe payload path: ${relativePath}`)
      const fullPath = join(directory, item.name)
      if (item.isDirectory()) visit(fullPath, relativePath)
      else if (item.isFile()) files.push(relativePath)
      else throw new Error(`Payload contains an unsupported entry: ${relativePath}`)
    }
  }
  visit(root)
  return files.sort()
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function createPayloadManifest(root) {
  if (!existsSync(join(root, 'Vast.exe')) || !existsSync(join(root, 'resources', 'app.asar'))) {
    throw new Error('The alpha payload is incomplete.')
  }
  const files = []
  for (const path of listPayloadFiles(root)) {
    const file = join(root, ...path.split('/'))
    files.push({ path, bytes: lstatSync(file).size, sha256: await sha256File(file) })
  }
  return { schemaVersion: 1, files }
}

async function verifyPayloadManifest(root, manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid alpha payload manifest.')
  const declared = manifest.files.map(file => file?.path)
  if (declared.some(path => !safeRelativePath(path))) throw new Error('Unsafe payload path in alpha manifest.')
  if (new Set(declared.map(path => path.toLowerCase())).size !== declared.length) throw new Error('Duplicate alpha payload path.')
  const actual = listPayloadFiles(root)
  if (JSON.stringify(declared) !== JSON.stringify(actual)) throw new Error('Alpha payload file inventory mismatch.')
  for (const entry of manifest.files) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid alpha payload checksum: ${entry.path}`)
    }
    const file = join(root, ...entry.path.split('/'))
    if (lstatSync(file).size !== entry.bytes || await sha256File(file) !== entry.sha256) {
      throw new Error(`Alpha payload hash mismatch: ${entry.path}`)
    }
  }
}

module.exports = { resolveDailyProfile, assertAlphaMetadata, assertOutside, createPayloadManifest, verifyPayloadManifest }
