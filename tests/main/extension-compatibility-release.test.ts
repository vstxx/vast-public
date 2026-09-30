import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const verifier = require('../../scripts/verify-extension-compat-runtime.cjs')
const electronDistPreparer = require('../../scripts/prepare-patched-electron-dist.cjs')
const manifest = require('../../patches/extension-compatibility-runtime.json')
const COMMIT = 'a'.repeat(40)

test('approved ECE is a production dependency, not just available to dev builds', () => {
  assert.doesNotThrow(() => verifier.assertProductionEceDependency({ dependencies: { 'electron-chrome-extensions': manifest.ece.version } }, manifest.ece.version))
  assert.throws(() => verifier.assertProductionEceDependency({ devDependencies: { 'electron-chrome-extensions': manifest.ece.version } }, manifest.ece.version), /production dependency/)
})

function verifiedFingerprint() {
  return {
    schemaVersion: 2,
    manifest: 'patches/extension-compatibility-runtime.json',
    electronVersion: '44.3.0',
    electronPatchsetRevision: manifest.electron.patchsetRevision,
    electronPatchsetSha256: manifest.electron.patchsetSha256,
    electronBinarySha256: manifest.electron.binary.sha256,
    eceVersion: '4.9.0',
    ecePatchSha256: manifest.ece.patchSha256,
    eceRuntimeSha256: manifest.ece.runtimeSha256,
    vastSourceCommit: COMMIT,
    vastDirty: false,
    releaseMode: true
  }
}

test('release runtime provenance accepts only the exact clean release commit', () => {
  assert.equal(typeof verifier.validateReleaseSource, 'function')
  assert.equal(verifier.validateReleaseSource({ head: COMMIT, expected: COMMIT, dirty: false }), COMMIT)
  assert.throws(
    () => verifier.validateReleaseSource({ head: COMMIT, expected: '', dirty: false }),
    /VAST_RELEASE_COMMIT/
  )
  assert.throws(
    () => verifier.validateReleaseSource({ head: COMMIT, expected: 'b'.repeat(40), dirty: false }),
    /match.*HEAD/i
  )
  assert.throws(
    () => verifier.validateReleaseSource({ head: COMMIT, expected: COMMIT, dirty: true }),
    /clean Vast worktree/i
  )
})

test('release packaging resolves an absolute approved Electron dist containing the fingerprinted binary', () => {
  assert.equal(typeof verifier.approvedElectronDist, 'function')
  const absolute = resolve('approved-electron-dist')
  const expectedBinary = join(absolute, manifest.electron.binary.fileName)
  const expectedMarker = join(absolute, '.vast-electron-dist.json')
  const marker = JSON.stringify({
    schemaVersion: 1,
    electronVersion: manifest.electron.version,
    patchsetRevision: manifest.electron.patchsetRevision,
    patchsetSha256: manifest.electron.patchsetSha256,
    electronBinarySha256: manifest.electron.binary.sha256
  })
  assert.equal(verifier.approvedElectronDist({
    env: { VAST_PATCHED_ELECTRON_DIST: absolute },
    manifest,
    exists: (path: string) => path === expectedBinary || path === expectedMarker,
    readText: () => marker
  }), absolute)
  assert.ok(isAbsolute(absolute))
  assert.throws(
    () => verifier.approvedElectronDist({ env: {}, manifest, exists: () => false }),
    /VAST_PATCHED_ELECTRON_DIST/
  )
  assert.throws(
    () => verifier.approvedElectronDist({
      env: { VAST_PATCHED_ELECTRON_DIST: 'relative-electron' },
      manifest,
      exists: () => true
    }),
    /absolute/i
  )
  assert.throws(
    () => verifier.approvedElectronDist({
      env: { VAST_PATCHED_ELECTRON_DIST: absolute },
      manifest,
      exists: (path: string) => path === expectedBinary || path === expectedMarker,
      readText: () => JSON.stringify({ ...JSON.parse(marker), patchsetRevision: 'wrong' })
    }),
    /marker/i
  )
})

test('prepared Electron distribution follows the official runtime inventory and excludes GN build output', async (t) => {
  assert.equal(typeof electronDistPreparer.preparePatchedElectronDist, 'function')
  const directory = await mkdtemp(join(tmpdir(), 'vast-patched-electron-dist-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  const stock = join(directory, 'stock')
  const output = join(directory, 'output')
  await mkdir(join(source, 'locales'), { recursive: true })
  await mkdir(join(source, 'resources'), { recursive: true })
  await mkdir(join(source, 'obj'), { recursive: true })
  await mkdir(join(stock, 'locales'), { recursive: true })
  await mkdir(join(stock, 'resources'), { recursive: true })
  await writeFile(join(source, 'electron.exe'), 'patched-electron')
  await writeFile(join(source, 'runtime.dll'), 'patched-runtime')
  await writeFile(join(source, 'locales', 'en-US.pak'), 'patched-locale')
  await writeFile(join(source, 'resources', 'default_app.asar'), 'patched-resource')
  await writeFile(join(source, 'obj', 'huge.pdb'), 'must-not-ship')
  await writeFile(join(stock, 'electron.exe'), 'stock-electron')
  await writeFile(join(stock, 'runtime.dll'), 'stock-runtime')
  await writeFile(join(stock, 'LICENSE'), 'stock-license')
  await writeFile(join(stock, 'version'), '44.3.0')
  await writeFile(join(stock, 'locales', 'en-US.pak'), 'stock-locale')
  await writeFile(join(stock, 'resources', 'default_app.asar'), 'stock-resource')

  const binary = await readFile(join(source, 'electron.exe'))
  const fixtureManifest = {
    electron: {
      version: '44.3.0',
      patchsetRevision: 'fixture-r1',
      patchsetSha256: 'a'.repeat(64),
      binary: {
        fileName: 'electron.exe',
        size: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex')
      }
    }
  }

  const result = electronDistPreparer.preparePatchedElectronDist({ source, stock, output, manifest: fixtureManifest })
  assert.equal(result.output, resolve(output))
  assert.deepEqual((await readdir(output)).sort(), [
    '.vast-electron-dist.json',
    'LICENSE',
    'electron.exe',
    'locales',
    'resources',
    'runtime.dll',
    'version'
  ])
  assert.equal(await readFile(join(output, 'electron.exe'), 'utf8'), 'patched-electron')
  assert.equal(await readFile(join(output, 'runtime.dll'), 'utf8'), 'patched-runtime')
  assert.equal(await readFile(join(output, 'LICENSE'), 'utf8'), 'stock-license')
  assert.equal(await readFile(join(output, 'locales', 'en-US.pak'), 'utf8'), 'patched-locale')
  assert.equal(await readFile(join(output, 'resources', 'default_app.asar'), 'utf8'), 'patched-resource')
  await assert.rejects(readFile(join(output, 'obj', 'huge.pdb')), /ENOENT/)
})

test('prepared Electron distribution refuses an output path that contains either input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vast-patched-electron-overlap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  const stock = join(directory, 'stock')
  await mkdir(source, { recursive: true })
  await mkdir(stock, { recursive: true })
  await writeFile(join(source, 'electron.exe'), 'patched-electron')
  await writeFile(join(stock, 'electron.exe'), 'stock-electron')
  const binary = await readFile(join(source, 'electron.exe'))
  const fixtureManifest = {
    electron: {
      version: '44.3.0',
      patchsetRevision: 'fixture-r1',
      patchsetSha256: 'a'.repeat(64),
      binary: {
        fileName: 'electron.exe',
        size: binary.length,
        sha256: createHash('sha256').update(binary).digest('hex')
      }
    }
  }

  assert.throws(
    () => electronDistPreparer.preparePatchedElectronDist({ source, stock, output: directory, manifest: fixtureManifest }),
    /unsafe Electron distribution output path/
  )
})

test('release fingerprint writer records only a verified clean release result', async (t) => {
  assert.equal(typeof verifier.writeRuntimeFingerprint, 'function')
  const directory = await mkdtemp(join(tmpdir(), 'vast-extension-runtime-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'fingerprint.json')
  const verified = verifiedFingerprint()

  verifier.writeRuntimeFingerprint(output, verified)
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), verified)
  assert.throws(
    () => verifier.writeRuntimeFingerprint(output, { ...verified, releaseMode: false }),
    /verified release result/i
  )
  assert.throws(
    () => verifier.writeRuntimeFingerprint(output, { ...verified, vastDirty: true }),
    /verified release result/i
  )
})

test('packaged runtime provenance must match every approved hash and the exact release commit', () => {
  assert.equal(typeof verifier.validateRuntimeFingerprint, 'function')
  const verified = verifiedFingerprint()
  assert.deepEqual(verifier.validateRuntimeFingerprint({
    fingerprint: verified,
    manifest,
    expectedSourceCommit: COMMIT
  }), verified)
  assert.throws(() => verifier.validateRuntimeFingerprint({
    fingerprint: { ...verified, electronBinarySha256: 'f'.repeat(64) },
    manifest,
    expectedSourceCommit: COMMIT
  }), /Electron binary fingerprint/i)
  assert.throws(() => verifier.validateRuntimeFingerprint({
    fingerprint: { ...verified, vastSourceCommit: 'b'.repeat(40) },
    manifest,
    expectedSourceCommit: COMMIT
  }), /source commit/i)
  assert.throws(() => verifier.validateRuntimeFingerprint({
    fingerprint: { ...verified, eceRuntimeSha256: 'f'.repeat(64) },
    manifest,
    expectedSourceCommit: COMMIT
  }), /ECE runtime fingerprint/i)
})

test('source-controlled manifest delegates the non-self-referential source SHA to the release attestation', () => {
  assert.equal(manifest.schemaVersion, 2)
  assert.deepEqual(manifest.vastSource, { mode: 'release-env-must-match-head' })
  assert.equal(manifest.vastSourceCommit, undefined)
})

test('every Electron builder route consumes the explicitly approved runtime directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vast-approved-electron-dist-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, manifest.electron.binary.fileName), 'fixture', 'utf8')
  await writeFile(join(directory, '.vast-electron-dist.json'), JSON.stringify({
    schemaVersion: 1,
    electronVersion: manifest.electron.version,
    patchsetRevision: manifest.electron.patchsetRevision,
    patchsetSha256: manifest.electron.patchsetSha256,
    electronBinarySha256: manifest.electron.binary.sha256
  }), 'utf8')
  const configs = [
    ['scripts/electron-builder-with-capabilities.cjs', {}],
    ['scripts/electron-builder-private-unsigned.cjs', {
      VAST_PRIVATE_BUILD: '1',
      VAST_ALLOW_UNSIGNED_PRIVATE_BUILD: '1'
    }],
    ['scripts/electron-builder-public-unsigned-release.cjs', {
      VAST_RELEASE_CHANNEL: 'stable',
      VAST_PRIVATE_BUILD: '0',
      VAST_PUBLIC_UNSIGNED_RELEASE: '1',
      VAST_UNSIGNED_RELEASE_ACK: 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
    }],
    ['scripts/electron-builder-store.cjs', {
      VAST_DISTRIBUTION_CHANNEL: 'microsoft-store',
      VAST_UPDATE_ENABLED: '0'
    }]
  ] as const

  for (const [config, extraEnv] of configs) {
    const result = spawnSync(process.execPath, [
      '-e',
      'const config = require(process.argv[1]); process.stdout.write(JSON.stringify({ electronDist: config.electronDist, win: config.win }))',
      resolve(config)
    ], {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...extraEnv, VAST_PATCHED_ELECTRON_DIST: directory }
    })
    assert.equal(result.status, 0, result.stderr)
    const builderConfig = JSON.parse(result.stdout)
    assert.equal(builderConfig.electronDist, resolve(directory), config)
    if (config === 'scripts/electron-builder-public-unsigned-release.cjs') {
      assert.equal(builderConfig.win.signAndEditExecutable, true, 'unsigned Vast must retain its Windows product name and version metadata')
      assert.equal(builderConfig.win.signExecutable, false, 'public unsigned Vast must not be signed')
    }
  }
})

test('release orchestration writes the verified runtime fingerprint before build metadata and packaging', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
  const direct = await readFile('scripts/build-release.cjs', 'utf8')
  const store = await readFile('scripts/build-store-msix.cjs', 'utf8')
  const script = packageJson.scripts['extension:compat:runtime:release-check'] as string

  assert.match(script, /--release/)
  assert.match(script, /--write out\/extension-compatibility-runtime-fingerprint\.json/)
  const directBuild = direct.indexOf("'build:obfuscated'")
  const directPrepareDist = direct.indexOf("run('node', ['scripts/prepare-patched-electron-dist.cjs'])")
  const directFingerprint = direct.indexOf("'extension:compat:runtime:release-check'")
  const directMetadata = direct.indexOf('write-release-build-metadata.cjs')
  const directPackaging = direct.indexOf('electronBuilderArgs(windowsTarget)')
  assert.ok(directPrepareDist >= 0 && directPrepareDist < directFingerprint && directFingerprint < directBuild)
  assert.ok(directBuild < directMetadata && directMetadata < directPackaging)

  const storeBuild = store.indexOf("['scripts/build-app.cjs']")
  const storePrepareDist = store.indexOf("['scripts/prepare-patched-electron-dist.cjs']")
  const storeFingerprint = store.indexOf("'scripts/verify-extension-compat-runtime.cjs'")
  const storePackaging = store.indexOf("require.resolve('electron-builder/cli.js')")
  assert.ok(storePrepareDist >= 0 && storePrepareDist < storeFingerprint && storeFingerprint < storeBuild && storeBuild < storePackaging)
})

test('release metadata and packaged-ASAR verification bind the embedded fingerprint to the release commit', async () => {
  const writer = await readFile('scripts/write-release-build-metadata.cjs', 'utf8')
  const packageVerifier = await readFile('scripts/verify-release-package.cjs', 'utf8')
  const releaseAudit = await readFile('scripts/release-audit.cjs', 'utf8')
  const publicReleaseAudit = await readFile('scripts/public-release-audit.cjs', 'utf8')

  assert.match(writer, /extension-compatibility-runtime-fingerprint\.json/)
  assert.match(writer, /validateRuntimeFingerprint/)
  assert.match(writer, /extensionCompatibilityRuntime/)
  assert.match(writer, /VAST_EXTENSION_COMPATIBILITY_FINGERPRINT_REQUIRED/)
  assert.match(packageVerifier, /readPackagedAsarFile\('out\/extension-compatibility-runtime-fingerprint\.json'\)/)
  assert.match(packageVerifier, /assertPackagedEceRuntime\(\)/)
  assert.match(packageVerifier, /validateRuntimeFingerprint/)
  assert.match(packageVerifier, /metadata\.extensionCompatibilityRuntime/)
  assert.match(releaseAudit, /extension compatibility runtime provenance is packaged and verified/)
  assert.match(publicReleaseAudit, /scripts\/prepare-patched-electron-dist\.cjs/)
})

test('GPL corresponding-source gate requires every Electron patch named by the runtime manifest', () => {
  const compliance = require('../../scripts/check-gpl-release-compliance.cjs').report as {
    checks: Array<{ name: string; pass: boolean }>
  }
  for (const patch of manifest.electron.patches as Array<{ path: string }>) {
    const check = compliance.checks.find((entry) => entry.name === `Electron patch published: ${patch.path}`)
    assert.equal(check?.pass, true, patch.path)
  }
})
