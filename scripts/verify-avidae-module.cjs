// Release gate for a built Video & Audio module. Verifies the signed manifest
// against the keys pinned in Vast (or an explicit test key), the archive size
// and digest, extracts it with the same code Vast uses at install time,
// re-verifies the installed runtime, runs its browser/media self-test and the
// FFmpeg capability contract, and checks license and corresponding-source
// obligations.
//
// Usage: node scripts/verify-avidae-module.cjs --dir release/avidae-module/<version> [--public-key <spki base64>] [--skip-self-test]
const { createHash } = require('node:crypto')
const { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(`Video & Audio module verification failed: ${message}`)
  process.exit(1)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  const directory = argument('--dir')
  if (!directory) fail('--dir is required.')
  const { verifyModuleReleaseManifest } = await import('../src/main/avidae-module-manifest.ts')
  const { extractModuleArchive } = await import('../src/main/avidae-module-archive.ts')
  const { verifyAvidaeRuntime } = await import('../src/main/avidae-runtime.ts')
  const policy = JSON.parse(readFileSync(join(root, 'src', 'shared', 'avidae-module-policy.json'), 'utf8'))
  const testKey = argument('--public-key')
  const trustedKeys = testKey
    ? [{ keyId: JSON.parse(readFileSync(join(directory, 'avidae-module.json'), 'utf8')).keyId, algorithm: 'Ed25519', publicKeySpkiBase64: testKey, status: 'current' }]
    : policy.trustedKeys
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const { payload, keyId } = verifyModuleReleaseManifest(readFileSync(join(directory, 'avidae-module.json'), 'utf8'), {
    trustedKeys,
    vastVersion: pkg.version,
    platform: 'win32',
    arch: 'x64',
    allowLoopbackHttp: Boolean(testKey)
  })
  if (!testKey && !payload.archive.url.startsWith('https://')) fail('Published module URLs must use HTTPS.')
  // Independent module budgets; Core budgets live in check-distribution-size-budget.cjs.
  const MiB = 1024 * 1024
  if (payload.archive.size > 400 * MiB) fail(`Module download is ${Math.ceil(payload.archive.size / MiB)} MiB, over its 400 MiB budget.`)
  if (payload.archive.unpackedSize > 700 * MiB) fail(`Installed module is ${Math.ceil(payload.archive.unpackedSize / MiB)} MiB, over its 700 MiB budget.`)
  const archivePath = join(directory, payload.archive.fileName)
  if (!existsSync(archivePath) || statSync(archivePath).size !== payload.archive.size) fail('Archive size does not match the signed manifest.')
  if (await sha256(archivePath) !== payload.archive.sha256) fail('Archive digest does not match the signed manifest.')
  const sourcePath = join(directory, payload.ffmpegSource.fileName)
  if (!existsSync(sourcePath) || statSync(sourcePath).size !== payload.ffmpegSource.size || await sha256(sourcePath) !== payload.ffmpegSource.sha256) {
    fail('FFmpeg corresponding source is missing beside the module or does not match the signed manifest.')
  }

  const workspace = mkdtempSync(join(tmpdir(), 'vast-avidae-module-verify-'))
  try {
    const started = Date.now()
    const extracted = await extractModuleArchive(archivePath, workspace, {
      runtimeManifestSha256: payload.runtimeManifest.sha256,
      runtimeManifestSize: payload.runtimeManifest.size,
      unpackedSize: payload.archive.unpackedSize,
      fileCount: payload.archive.fileCount
    })
    const extractSeconds = (Date.now() - started) / 1000
    const runtime = await verifyAvidaeRuntime(workspace, { moduleVersion: payload.moduleVersion, hostApi: payload.hostApi })
    const manifest = extracted.runtimeManifest
    if (manifest.localTest === true && !testKey) fail('A --local-test runtime can never be released.')
    const licensePaths = manifest.files.map((record) => record.path.toLowerCase())
    for (const required of ['licenses/ffmpeg-gplv3', 'licenses/ffmpeg-readme.txt', 'licenses/x264-copying', 'licenses/playwright-license.txt', 'licenses/chromium-license.txt', 'python-packages.json', 'third_party_runtime.md']) {
      if (!licensePaths.some((path) => path.startsWith(required) || path.endsWith(required))) fail(`License inventory is missing ${required}.`)
    }
    if (manifest.ffmpegSourceBundle.sha256 !== payload.ffmpegSource.sha256) fail('Runtime provenance and signed corresponding-source reference disagree.')
    let selfTest = null
    if (!process.argv.includes('--skip-self-test')) {
      const result = spawnSync(runtime.executable, ['--runtime-self-test'], {
        cwd: dirname(runtime.executable),
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        env: {
          ...process.env,
          FFMPEG_PATH: runtime.ffmpeg,
          FFPROBE_PATH: runtime.ffprobe,
          PLAYWRIGHT_BROWSERS_PATH: runtime.playwrightBrowsersPath,
          VAST_AVIDAE_CHROMIUM_PATH: runtime.chromiumExecutable,
          VAST_AVIDAE_BUNDLED_RUNTIME: '1'
        }
      })
      try { selfTest = JSON.parse(String(result.stdout).trim()) } catch { fail(`Runtime self-test returned no result: ${result.stderr || result.error}`) }
      if (selfTest?.ok !== true || selfTest.videoRecording !== true || selfTest.headless !== 'new') fail('Runtime self-test did not pass.')
      const capabilityReport = join(root, '.vast-build', 'avidae-module-verify', `${basename(workspace)}-capabilities.json`)
      mkdirSync(dirname(capabilityReport), { recursive: true })
      const capability = spawnSync(process.execPath, [join(__dirname, 'avidae-ffmpeg-capabilities.cjs'), '--ffmpeg', runtime.ffmpeg, '--ffprobe', runtime.ffprobe, '--output', capabilityReport], { stdio: 'inherit', windowsHide: true })
      rmSync(capabilityReport, { force: true })
      if (capability.status !== 0) fail('FFmpeg failed the Video & Audio capability contract.')
    }
    console.log(JSON.stringify({
      ok: true,
      keyId,
      moduleVersion: payload.moduleVersion,
      sequence: payload.sequence,
      archiveBytes: payload.archive.size,
      unpackedBytes: payload.archive.unpackedSize,
      files: extracted.files,
      extractSeconds,
      runtime: runtime.label,
      selfTest
    }, null, 2))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
