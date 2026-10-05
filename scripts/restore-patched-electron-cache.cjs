#!/usr/bin/env node
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const manifest = require('../patches/extension-compatibility-runtime.json')
const descriptor = require('../third_party/electron/electron-ci-cache.json')

function validateDescriptor(value, approved) {
  if (value?.schemaVersion !== 1 || value.repository !== 'vstxx/vast' ||
    value.patchsetRevision !== approved.electron.patchsetRevision ||
    value.patchsetSha256 !== approved.electron.patchsetSha256 ||
    value.binarySha256 !== approved.electron.binary.sha256 ||
    value.releaseTag !== `ci-cache-electron-${value.binarySha256.slice(0, 16)}` ||
    value.assetName !== `${value.patchsetRevision}-win32-x64.zip` ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256)) {
    throw new Error('Private Electron cache descriptor differs from the approved runtime.')
  }
  return value
}

function assertSafeArchiveEntries(listing) {
  const paths = []
  const seen = new Set()
  for (const raw of String(listing).split(/\r?\n/).filter(Boolean)) {
    if (raw === './' || raw === '.') continue
    const name = raw.startsWith('./') ? raw.slice(2) : raw
    const relative = name.endsWith('/') ? name.slice(0, -1) : name
    const parts = relative.split('/')
    if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes(':') ||
      parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe or invalid Electron cache archive entry: ${raw}`)
    }
    const key = relative.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate Electron cache archive entry: ${relative}`)
    seen.add(key)
    paths.push(relative)
  }
  if (!paths.includes('electron.exe') || !paths.includes('.vast-electron-dist.json')) {
    throw new Error('Electron cache archive lacks its binary or distribution marker.')
  }
  return paths
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = fs.createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', () => resolve(hash.digest('hex')))
  })
}

function runTar(args) {
  const result = spawnSync('tar.exe', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Electron cache archive inspection/extraction failed: ${result.error?.message || result.stderr || result.status}`)
  return result.stdout
}

function assertOnlyRegularFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) assertOnlyRegularFiles(fullPath)
    else if (!entry.isFile()) throw new Error(`Electron cache contains a non-regular entry: ${entry.name}`)
  }
}

async function moveVerifiedCache(temporary, destination, filesystem = fs, retryDelayMs = 250) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (filesystem.existsSync(destination)) throw new Error(`Electron cache destination already exists: ${destination}`)
    try {
      filesystem.renameSync(temporary, destination)
      return
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
}

async function restore(archive) {
  const pinned = validateDescriptor(descriptor, manifest)
  const resolvedArchive = path.resolve(archive)
  if (!fs.statSync(resolvedArchive).isFile()) throw new Error('Electron cache archive is not a regular file.')
  if (await sha256File(resolvedArchive) !== pinned.archiveSha256) throw new Error('Electron cache archive SHA-256 mismatch.')
  assertSafeArchiveEntries(runTar(['-tf', resolvedArchive]))

  const parent = path.join(root, '.vast-build', 'electron-cache-source')
  const destination = path.join(parent, pinned.patchsetRevision)
  if (fs.existsSync(destination)) throw new Error(`Electron cache destination already exists: ${destination}`)
  fs.mkdirSync(parent, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(parent, '.extract-'))
  runTar(['-xf', resolvedArchive, '-C', temporary])
  assertOnlyRegularFiles(temporary)
  const marker = JSON.parse(fs.readFileSync(path.join(temporary, '.vast-electron-dist.json'), 'utf8'))
  if (marker.schemaVersion !== 1 || marker.electronVersion !== manifest.electron.version ||
    marker.patchsetRevision !== pinned.patchsetRevision || marker.patchsetSha256 !== pinned.patchsetSha256 ||
    marker.electronBinarySha256 !== pinned.binarySha256) {
    throw new Error('Electron cache distribution marker does not match the approved runtime.')
  }
  const binary = path.join(temporary, manifest.electron.binary.fileName)
  if (fs.statSync(binary).size !== manifest.electron.binary.size || await sha256File(binary) !== pinned.binarySha256) {
    throw new Error('Electron cache binary does not match the approved runtime.')
  }
  await moveVerifiedCache(temporary, destination)
  return { sourceDirectory: destination, archiveSha256: pinned.archiveSha256, binarySha256: pinned.binarySha256 }
}

if (require.main === module) {
  const index = process.argv.indexOf('--archive')
  if (index < 0 || !process.argv[index + 1]) {
    console.error('Usage: node scripts/restore-patched-electron-cache.cjs --archive <pinned-zip>')
    process.exitCode = 2
  } else {
    restore(process.argv[index + 1]).then(
      (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
      (error) => { console.error(error.message); process.exitCode = 1 }
    )
  }
}

module.exports = { assertSafeArchiveEntries, moveVerifiedCache, restore, validateDescriptor }
