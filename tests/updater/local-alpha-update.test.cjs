const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  resolveDailyProfile,
  assertAlphaMetadata,
  assertOutside,
  createPayloadManifest,
  verifyPayloadManifest
} = require('../../scripts/local-alpha-update-utils.cjs')

test('local alpha uses the configured daily profile and rejects a missing custom profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'vast-alpha-profile-'))
  try {
    const appData = join(root, 'Roaming')
    const config = join(appData, 'Vast')
    const daily = join(root, 'Daily')
    mkdirSync(config, { recursive: true })
    mkdirSync(daily)
    writeFileSync(join(config, 'data-root.json'), JSON.stringify({ customDataRoot: daily }))
    assert.equal(resolveDailyProfile(appData), daily)
    rmSync(daily, { recursive: true })
    assert.throws(() => resolveDailyProfile(appData), /configured daily profile is missing/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local alpha refuses a public build or an enabled network updater', () => {
  const sourceCommit = 'a'.repeat(40)
  const valid = {
    version: '0.5.0-alpha.1', releaseChannel: 'alpha', distributionChannel: 'direct',
    privateBuild: true, updateEnabled: false, sourceCommit
  }
  assert.doesNotThrow(() => assertAlphaMetadata(valid, valid.version, sourceCommit))
  assert.throws(() => assertAlphaMetadata({ ...valid, updateEnabled: true }, valid.version, sourceCommit), /network updater/i)
  assert.throws(() => assertAlphaMetadata({ ...valid, privateBuild: false }, valid.version, sourceCommit), /private/i)
  assert.throws(() => assertAlphaMetadata(valid, valid.version, 'b'.repeat(40)), /source commit/i)
})

test('local alpha refuses a profile inside the installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'vast-alpha-paths-'))
  try {
    const profile = join(root, 'profile')
    mkdirSync(profile)
    assert.throws(() => assertOutside(profile, root, 'The daily profile'), /outside/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local alpha detects changed payload bytes and unsafe manifest paths before installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vast-alpha-payload-'))
  try {
    mkdirSync(join(root, 'resources'))
    writeFileSync(join(root, 'Vast.exe'), 'original runtime')
    writeFileSync(join(root, 'resources', 'app.asar'), 'original app')
    const manifest = await createPayloadManifest(root)
    await verifyPayloadManifest(root, manifest)
    writeFileSync(join(root, 'resources', 'app.asar'), 'changed app')
    await assert.rejects(verifyPayloadManifest(root, manifest), /hash mismatch/i)
    await assert.rejects(verifyPayloadManifest(root, { ...manifest, files: manifest.files.slice(0, 1) }), /inventory mismatch/i)
    await assert.rejects(verifyPayloadManifest(root, { ...manifest, files: [{ path: '../outside', sha256: '0'.repeat(64), bytes: 1 }] }), /unsafe payload path/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
