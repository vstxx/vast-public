#!/usr/bin/env node
// Verify the native code and security metadata in a completed private --dir package.
const { createHash } = require('node:crypto')
const { createReadStream, existsSync, openSync, readSync, closeSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const { assertFuseState } = require('./electron-fuses.cjs')
const { validateRuntimeFingerprint } = require('./verify-extension-compat-runtime.cjs')

const root = path.resolve(__dirname, '..')
const packageDir = path.resolve(process.argv[2] || path.join(root, 'release', 'win-unpacked'))
const dist = path.resolve(process.argv[3] || path.join(root, '.vast-build', 'electron-dist', 'electron-44.3.0-vast-r5-win32-x64'))
const manifest = require(path.join(root, 'patches', 'extension-compatibility-runtime.json'))
const executable = path.join(packageDir, 'Vast.exe')
const sourceExecutable = path.join(dist, 'electron.exe')
const appAsar = path.join(packageDir, 'resources', 'app.asar')
const requireFact = (condition, message) => { if (!condition) throw new Error(message) }

function readAsar(relative) {
  return asar.extractFile(appAsar, relative.replaceAll('/', '\\'))
}

function peSection(file, sectionName) {
  const fd = openSync(file, 'r')
  try {
    const dos = Buffer.alloc(64)
    requireFact(readSync(fd, dos, 0, dos.length, 0) === dos.length, `Incomplete PE DOS header: ${file}`)
    requireFact(dos.toString('ascii', 0, 2) === 'MZ', `Not a PE file: ${file}`)
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(24)
    requireFact(readSync(fd, header, 0, header.length, peOffset) === header.length, `Incomplete PE header: ${file}`)
    requireFact(header.toString('ascii', 0, 4) === 'PE\0\0', `Missing PE signature: ${file}`)
    const count = header.readUInt16LE(6)
    const table = peOffset + 24 + header.readUInt16LE(20)
    for (let index = 0; index < count; index++) {
      const section = Buffer.alloc(40)
      requireFact(readSync(fd, section, 0, 40, table + index * 40) === 40, `Incomplete PE section: ${file}`)
      const name = section.toString('ascii', 0, 8).replace(/\0.*$/, '')
      if (name === sectionName) return { offset: section.readUInt32LE(20), size: section.readUInt32LE(16) }
    }
    throw new Error(`PE section ${sectionName} missing: ${file}`)
  } finally { closeSync(fd) }
}

async function hashFile(file, section) {
  const hash = createHash('sha256')
  const stream = section
    ? createReadStream(file, { start: section.offset, end: section.offset + section.size - 1 })
    : createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  for (const file of [executable, sourceExecutable, appAsar]) requireFact(existsSync(file), `Package input missing: ${file}`)
  const sourceSha256 = await hashFile(sourceExecutable)
  requireFact(sourceSha256 === manifest.electron.binary.sha256 && statSync(sourceExecutable).size === manifest.electron.binary.size,
    'Prepared Electron binary differs from the pinned release-profile candidate')
  const marker = JSON.parse(readFileSync(path.join(packageDir, '.vast-electron-dist.json'), 'utf8'))
  requireFact(marker.electronBinarySha256 === sourceSha256 && marker.patchsetSha256 === manifest.electron.patchsetSha256,
    'Packaged runtime marker differs from the pinned candidate')
  const sourceText = peSection(sourceExecutable, '.text')
  const packageText = peSection(executable, '.text')
  const [sourceTextSha256, packageTextSha256] = await Promise.all([
    hashFile(sourceExecutable, sourceText), hashFile(executable, packageText)
  ])
  requireFact(sourceText.size === packageText.size && sourceTextSha256 === packageTextSha256,
    'Packaged Vast.exe native .text section differs from release-profile Electron')

  const runtimeFiles = [
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
    'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak',
    'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vulkan-1.dll'
  ]
  for (const name of runtimeFiles) {
    const source = path.join(dist, name)
    const packaged = path.join(packageDir, name)
    requireFact(existsSync(source) && existsSync(packaged), `Native runtime resource missing: ${name}`)
    requireFact((await hashFile(source)) === (await hashFile(packaged)), `Native runtime resource changed: ${name}`)
  }

  const fingerprint = JSON.parse(readAsar('out/extension-compatibility-runtime-fingerprint.json').toString('utf8'))
  const metadata = JSON.parse(readAsar('out/release-build-metadata.json').toString('utf8'))
  validateRuntimeFingerprint({ fingerprint, manifest, expectedSourceCommit: metadata.sourceCommit })
  requireFact(metadata.extensionCompatibilityRuntime?.electronBinarySha256 === sourceSha256,
    'Packaged release metadata does not attest the native candidate')
  for (const relative of manifest.ece.runtimeFiles.filter(file => !file.endsWith('.d.ts'))) {
    const packaged = readAsar(`node_modules/electron-chrome-extensions/${relative}`)
    const approved = readFileSync(path.join(root, 'node_modules', 'electron-chrome-extensions', relative))
    requireFact(packaged.equals(approved), `Packaged ECE runtime differs: ${relative}`)
  }

  const fuses = await import('@electron/fuses')
  await assertFuseState(executable, fuses)
  const report = {
    ok: true,
    packageDir,
    sourceCommit: metadata.sourceCommit,
    electronBinarySha256: sourceSha256,
    nativeText: { size: sourceText.size, sha256: sourceTextSha256 },
    nativeResourceFilesVerified: runtimeFiles.length,
    eceRuntimeFilesVerified: manifest.ece.runtimeFiles.filter(file => !file.endsWith('.d.ts')).length,
    fusesVerified: true,
    packageExecutableSha256: await hashFile(executable)
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
