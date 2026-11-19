// Packages the prepared Video & Audio runtime (resources/avidae-runtime) as the
// independently versioned, downloadable module:
//
//   release/avidae-module/<version>/
//     VastVideoAudio-<version>-win-x64.tar.zst      module archive
//     ffmpeg-corresponding-source-win64.tar.zst     GPL corresponding source
//     avidae-module.payload.json                    unsigned release payload
//     SHA256SUMS.txt
//
// The payload is signed separately (scripts/sign-avidae-module.cjs) with a key
// that never enters this repository.
//
// Usage: node scripts/build-avidae-module.cjs --base-url <https download base> [--skip-check] [--level 19]
const { createHash } = require('node:crypto')
const { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const { writeModuleArchive } = require('./avidae-module-archive.cjs')

const root = join(__dirname, '..')
const runtimeRoot = join(root, 'resources', 'avidae-runtime')
const moduleInfo = JSON.parse(readFileSync(join(root, 'resources', 'avidae', 'module.json'), 'utf8'))
const sourceBundle = join(root, '.vast-build', 'ffmpeg', 'ffmpeg-corresponding-source-win64.tar.zst')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const baseUrl = String(argument('--base-url', '')).replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+\/\S+$/.test(baseUrl) && !/^http:\/\/127\.0\.0\.1:\d+(\/\S*)?$/.test(baseUrl)) {
    fail('--base-url must be the HTTPS location the archive will be published at (loopback HTTP is accepted for tests).')
  }
  const level = Number(argument('--level', '19'))
  if (!Number.isInteger(level) || level < 1 || level > 22) fail('--level must be a zstd level between 1 and 22.')
  if (!process.argv.includes('--skip-check')) {
    const check = spawnSync(process.execPath, [join(__dirname, 'prepare-avidae-runtime.cjs'), '--check'], { cwd: root, stdio: 'inherit', windowsHide: true })
    if (check.status !== 0) fail('The prepared Video & Audio runtime failed verification.')
  }
  const runtimeManifestPath = join(runtimeRoot, 'runtime-manifest.json')
  const runtimeManifestBytes = readFileSync(runtimeManifestPath)
  const runtimeManifest = JSON.parse(runtimeManifestBytes.toString('utf8'))
  if (runtimeManifest.schemaVersion !== 4 || runtimeManifest.moduleVersion !== moduleInfo.moduleVersion || !Array.isArray(runtimeManifest.files)) {
    fail('Runtime manifest is not a schema 4 module manifest for resources/avidae/module.json. Run npm run avidae:runtime:prepare -- --resume.')
  }
  const localTest = process.argv.includes('--local-test')
  if (runtimeManifest.localTest === true && !(localTest && baseUrl.startsWith('http://127.0.0.1:'))) {
    fail('This runtime was prepared with --local-test and can only be packaged for a loopback test server.')
  }
  if (!existsSync(sourceBundle) || statSync(sourceBundle).size !== runtimeManifest.ffmpegSourceBundle.size) {
    fail('The FFmpeg corresponding-source archive recorded by the runtime is missing.')
  }

  const version = moduleInfo.moduleVersion
  const outputRoot = resolve(root, 'release', 'avidae-module', version)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })
  const archiveName = `VastVideoAudio-${version}-win-x64.tar.zst`
  const archivePath = join(outputRoot, archiveName)
  const entries = [
    { path: 'runtime-manifest.json', data: runtimeManifestBytes, size: runtimeManifestBytes.length },
    ...runtimeManifest.files.map((record) => ({ path: record.path, source: join(runtimeRoot, ...record.path.split('/')), size: record.size }))
  ]
  console.log(`Writing ${archiveName} (${entries.length} files, zstd level ${level})...`)
  const started = Date.now()
  await writeModuleArchive(entries, archivePath, { level })
  const archiveSha256 = await sha256(archivePath)
  if (archiveSha256 !== await sha256(archivePath)) fail('Archive digest is not stable.')
  const sourceName = 'ffmpeg-corresponding-source-win64.tar.zst'
  copyFileSync(sourceBundle, join(outputRoot, sourceName))
  if (await sha256(join(outputRoot, sourceName)) !== runtimeManifest.ffmpegSourceBundle.sha256) fail('FFmpeg corresponding source does not match the runtime provenance.')

  const unpackedSize = runtimeManifestBytes.length + runtimeManifest.files.reduce((total, record) => total + record.size, 0)
  const payload = {
    schemaVersion: 1,
    moduleId: moduleInfo.moduleId,
    moduleVersion: version,
    sequence: moduleInfo.sequence,
    platform: 'win32',
    arch: 'x64',
    hostApi: moduleInfo.hostApi,
    minVastVersion: moduleInfo.minVastVersion,
    publishedAt: new Date().toISOString(),
    archive: {
      url: `${baseUrl}/${archiveName}`,
      fileName: archiveName,
      format: 'tar.zst',
      size: statSync(archivePath).size,
      sha256: archiveSha256,
      unpackedSize,
      fileCount: entries.length
    },
    runtimeManifest: { sha256: createHash('sha256').update(runtimeManifestBytes).digest('hex'), size: runtimeManifestBytes.length },
    runtime: {
      runtimeVersion: runtimeManifest.runtimeVersion,
      python: runtimeManifest.python,
      playwright: runtimeManifest.playwright,
      pyinstaller: runtimeManifest.pyinstaller,
      ffmpegVersion: runtimeManifest.ffmpegVersion
    },
    ffmpegSource: {
      fileName: sourceName,
      url: `${baseUrl}/${sourceName}`,
      sha256: runtimeManifest.ffmpegSourceBundle.sha256,
      size: runtimeManifest.ffmpegSourceBundle.size
    },
    revokedModuleVersions: moduleInfo.revokedModuleVersions ?? []
  }
  writeFileSync(join(outputRoot, 'avidae-module.payload.json'), `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(join(outputRoot, 'SHA256SUMS.txt'), [
    `${archiveSha256}  ${archiveName}`,
    `${payload.ffmpegSource.sha256}  ${sourceName}`
  ].join('\n') + '\n')
  console.log(JSON.stringify({
    ok: true,
    outputRoot,
    moduleVersion: version,
    sequence: payload.sequence,
    archiveBytes: payload.archive.size,
    unpackedBytes: unpackedSize,
    files: entries.length,
    seconds: Math.round((Date.now() - started) / 1000)
  }, null, 2))
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)))
