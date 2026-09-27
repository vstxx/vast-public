#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(root, 'patches', 'extension-compatibility-runtime.json')

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function assertSafeOutput({ source, stock, output }) {
  const resolved = path.resolve(output)
  const parsed = path.parse(resolved)
  const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
  if (resolved === parsed.root || overlaps(resolved, path.resolve(source)) || overlaps(resolved, path.resolve(stock))) {
    throw new Error('Refusing to replace an unsafe Electron distribution output path.')
  }
  return resolved
}

function copyOfficialInventory({ source, stock, output, relativePath = '' }) {
  const stockPath = path.join(stock, relativePath)
  const outputPath = path.join(output, relativePath)
  const stat = fs.statSync(stockPath)
  if (stat.isDirectory()) {
    fs.mkdirSync(outputPath, { recursive: true })
    let count = 0
    for (const entry of fs.readdirSync(stockPath)) {
      count += copyOfficialInventory({ source, stock, output, relativePath: path.join(relativePath, entry) })
    }
    return count
  }
  if (!stat.isFile()) throw new Error(`Unsupported official Electron distribution entry: ${relativePath}`)
  const patchedPath = path.join(source, relativePath)
  const selectedPath = fs.existsSync(patchedPath) && fs.statSync(patchedPath).isFile() ? patchedPath : stockPath
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.copyFileSync(selectedPath, outputPath)
  return 1
}

function preparePatchedElectronDist({ source, stock, output, manifest }) {
  const resolvedSource = path.resolve(source)
  const resolvedStock = path.resolve(stock)
  const resolvedOutput = assertSafeOutput({ source: resolvedSource, stock: resolvedStock, output })
  const binaryPath = path.join(resolvedSource, manifest.electron.binary.fileName)
  const binaryStat = fs.statSync(binaryPath)
  if (binaryStat.size !== manifest.electron.binary.size) throw new Error('Patched Electron binary size does not match the approved manifest.')
  const binarySha256 = sha256File(binaryPath)
  if (binarySha256 !== manifest.electron.binary.sha256) throw new Error('Patched Electron binary hash does not match the approved manifest.')

  fs.rmSync(resolvedOutput, { recursive: true, force: true })
  fs.mkdirSync(resolvedOutput, { recursive: true })
  const fileCount = copyOfficialInventory({ source: resolvedSource, stock: resolvedStock, output: resolvedOutput })
  const copiedBinaryPath = path.join(resolvedOutput, manifest.electron.binary.fileName)
  if (sha256File(copiedBinaryPath) !== binarySha256) throw new Error('Prepared Electron distribution changed the approved binary.')

  const marker = {
    schemaVersion: 1,
    electronVersion: manifest.electron.version,
    patchsetRevision: manifest.electron.patchsetRevision,
    patchsetSha256: manifest.electron.patchsetSha256,
    electronBinarySha256: binarySha256,
    fileCount
  }
  fs.writeFileSync(path.join(resolvedOutput, '.vast-electron-dist.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return { output: resolvedOutput, marker }
}

function defaultOutputPath(manifest) {
  return path.join(root, '.vast-build', 'electron-dist', `${manifest.electron.patchsetRevision}-win32-x64`)
}

if (require.main === module) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
    const source = path.resolve(process.env.VAST_PATCHED_ELECTRON_SOURCE_DIR || process.env.VAST_PATCHED_ELECTRON_DIST || '')
    if (!process.env.VAST_PATCHED_ELECTRON_SOURCE_DIR && !process.env.VAST_PATCHED_ELECTRON_DIST) {
      throw new Error('VAST_PATCHED_ELECTRON_SOURCE_DIR must point to the patched Electron GN output.')
    }
    const stock = path.join(root, 'node_modules', 'electron', 'dist')
    const output = defaultOutputPath(manifest)
    const result = preparePatchedElectronDist({ source, stock, output, manifest })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { defaultOutputPath, preparePatchedElectronDist }
