#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(root, 'patches', 'extension-compatibility-runtime.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hashOrderedFiles(files) {
  const hash = createHash('sha256')
  for (const relativePath of files) {
    hash.update(relativePath.replaceAll('\\', '/'), 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(fs.readFileSync(path.join(root, relativePath)))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

function hashEceRuntime(packageRoot, files) {
  const hash = createHash('sha256')
  for (const relativePath of files) {
    hash.update(relativePath, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(fs.readFileSync(path.join(packageRoot, relativePath)))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function exactPackageVersion(packageJson, name) {
  const value = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name]
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${name} must be pinned to an exact version.`)
  }
  return value
}

function validateReleaseSource({ head, expected, dirty }) {
  const normalizedHead = String(head || '').trim().toLowerCase()
  const normalizedExpected = String(expected || '').trim().toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(normalizedExpected)) {
    throw new Error('Release compatibility verification requires VAST_RELEASE_COMMIT as a full source commit SHA.')
  }
  if (normalizedExpected !== normalizedHead) {
    throw new Error('VAST_RELEASE_COMMIT must match the checked-out HEAD.')
  }
  if (dirty) throw new Error('Release compatibility verification requires a clean Vast worktree.')
  return normalizedHead
}

function approvedElectronDist({ env = process.env, manifest, exists = fs.existsSync, readText = (filePath) => fs.readFileSync(filePath, 'utf8') }) {
  const configured = String(env.VAST_PATCHED_ELECTRON_DIST || '').trim()
  if (!configured) throw new Error('Release packaging requires VAST_PATCHED_ELECTRON_DIST.')
  if (!path.isAbsolute(configured)) throw new Error('VAST_PATCHED_ELECTRON_DIST must be an absolute path.')
  const resolved = path.resolve(configured)
  const binaryPath = path.join(resolved, manifest.electron.binary.fileName)
  if (!exists(binaryPath)) throw new Error(`Approved Electron binary is missing: ${binaryPath}`)
  const markerPath = path.join(resolved, '.vast-electron-dist.json')
  if (!exists(markerPath)) throw new Error(`Approved Electron distribution marker is missing: ${markerPath}`)
  let marker
  try {
    marker = JSON.parse(readText(markerPath).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`Approved Electron distribution marker is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.electronVersion !== manifest.electron.version ||
    marker.patchsetRevision !== manifest.electron.patchsetRevision ||
    marker.patchsetSha256 !== manifest.electron.patchsetSha256 ||
    marker.electronBinarySha256 !== manifest.electron.binary.sha256
  ) {
    throw new Error('Approved Electron distribution marker does not match the compatibility manifest.')
  }
  return resolved
}

function writeRuntimeFingerprint(outputPath, verified) {
  if (verified?.releaseMode !== true || verified?.vastDirty !== false || !/^[a-f0-9]{40}$/.test(String(verified?.vastSourceCommit || ''))) {
    throw new Error('A runtime fingerprint can only be written from a verified release result.')
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(verified, null, 2)}\n`, 'utf8')
}

function validateRuntimeFingerprint({ fingerprint, manifest, expectedSourceCommit }) {
  if (fingerprint?.schemaVersion !== 2 || fingerprint?.releaseMode !== true || fingerprint?.vastDirty !== false) {
    throw new Error('Packaged extension compatibility provenance is not a verified release fingerprint.')
  }
  if (fingerprint.manifest !== 'patches/extension-compatibility-runtime.json') {
    throw new Error('Packaged compatibility manifest identity is invalid.')
  }
  if (fingerprint.electronVersion !== manifest.electron.version) throw new Error('Packaged Electron version does not match the approved runtime.')
  if (fingerprint.electronPatchsetRevision !== manifest.electron.patchsetRevision) throw new Error('Packaged Electron patchset revision does not match the approved runtime.')
  if (fingerprint.electronPatchsetSha256 !== manifest.electron.patchsetSha256) throw new Error('Packaged Electron patchset fingerprint does not match the approved runtime.')
  if (fingerprint.electronBinarySha256 !== manifest.electron.binary.sha256) throw new Error('Packaged Electron binary fingerprint does not match the approved runtime.')
  if (fingerprint.eceVersion !== manifest.ece.version) throw new Error('Packaged ECE version does not match the approved runtime.')
  if (fingerprint.ecePatchSha256 !== manifest.ece.patchSha256) throw new Error('Packaged ECE patch fingerprint does not match the approved runtime.')
  if (fingerprint.eceRuntimeSha256 !== manifest.ece.runtimeSha256) throw new Error('Packaged ECE runtime fingerprint does not match the approved runtime.')
  if (fingerprint.vastSourceCommit !== String(expectedSourceCommit || '').trim().toLowerCase()) {
    throw new Error('Packaged compatibility source commit does not match VAST_RELEASE_COMMIT.')
  }
  return fingerprint
}

async function verifyRuntime({ release = false, env = process.env } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported compatibility runtime manifest schema.')
  if (manifest.vastSource?.mode !== 'release-env-must-match-head') throw new Error('Unsupported Vast source provenance policy.')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (exactPackageVersion(packageJson, 'electron') !== manifest.electron.version) throw new Error('Electron version does not match the compatibility manifest.')
  if (exactPackageVersion(packageJson, 'electron-chrome-extensions') !== manifest.ece.version) throw new Error('ECE version does not match the compatibility manifest.')

  const patchPaths = manifest.electron.patches.map((entry) => entry.path)
  for (const entry of manifest.electron.patches) {
    const actual = sha256(fs.readFileSync(path.join(root, entry.path)))
    if (actual !== entry.sha256) throw new Error(`Electron patch hash mismatch: ${entry.path}`)
  }
  if (hashOrderedFiles(patchPaths) !== manifest.electron.patchsetSha256) throw new Error('Electron patchset hash mismatch.')

  const ecePatch = fs.readFileSync(path.join(root, manifest.ece.patchPath))
  if (sha256(ecePatch) !== manifest.ece.patchSha256) throw new Error('ECE patch hash mismatch.')
  const eceRoot = path.resolve(env.VAST_ECE_RUNTIME_ROOT || path.join(root, 'node_modules', 'electron-chrome-extensions'))
  const ecePackage = JSON.parse(fs.readFileSync(path.join(eceRoot, 'package.json'), 'utf8'))
  if (ecePackage.version !== manifest.ece.version) throw new Error('Installed ECE version does not match the compatibility manifest.')
  if (hashEceRuntime(eceRoot, manifest.ece.runtimeFiles) !== manifest.ece.runtimeSha256) throw new Error('Installed ECE runtime fingerprint mismatch.')

  const vastCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().toLowerCase()
  const vastDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().length > 0
  if (release) validateReleaseSource({ head: vastCommit, expected: env.VAST_RELEASE_COMMIT, dirty: vastDirty })

  const binaryPath = path.resolve(env.VAST_PATCHED_ELECTRON_EXE ||
    path.join(env.VAST_PATCHED_ELECTRON_DIST || 'D:\\VastElectron44\\src\\out\\VastCompat', manifest.electron.binary.fileName))
  const stat = fs.statSync(binaryPath)
  if (stat.size !== manifest.electron.binary.size) throw new Error('Electron binary size does not match the compatibility manifest.')
  const binarySha256 = await hashFile(binaryPath)
  if (binarySha256 !== manifest.electron.binary.sha256) throw new Error('Electron binary fingerprint mismatch.')

  return Object.freeze({
    schemaVersion: 2,
    manifest: path.relative(root, manifestPath).replaceAll('\\', '/'),
    electronVersion: manifest.electron.version,
    electronPatchsetRevision: manifest.electron.patchsetRevision,
    electronPatchsetSha256: manifest.electron.patchsetSha256,
    electronBinarySha256: binarySha256,
    eceVersion: manifest.ece.version,
    ecePatchSha256: manifest.ece.patchSha256,
    eceRuntimeSha256: manifest.ece.runtimeSha256,
    vastSourceCommit: vastCommit,
    vastDirty,
    releaseMode: release
  })
}

if (require.main === module) {
  const release = process.argv.includes('--release')
  const writeIndex = process.argv.indexOf('--write')
  const writeTarget = writeIndex >= 0 ? process.argv[writeIndex + 1] : undefined
  if (writeIndex >= 0 && (!writeTarget || writeTarget.startsWith('--'))) {
    console.error('--write requires an output path.')
    process.exitCode = 1
  } else if (writeTarget && !release) {
    console.error('--write is only available with --release.')
    process.exitCode = 1
  } else verifyRuntime({ release })
    .then((result) => {
      if (writeTarget) writeRuntimeFingerprint(path.resolve(root, writeTarget), result)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = {
  approvedElectronDist,
  hashEceRuntime,
  hashOrderedFiles,
  validateRuntimeFingerprint,
  validateReleaseSource,
  verifyRuntime,
  writeRuntimeFingerprint
}
