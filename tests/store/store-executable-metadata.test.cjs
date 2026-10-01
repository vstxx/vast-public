const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')

const manifest = require('../../patches/extension-compatibility-runtime.json')

test('unsigned Store build edits Vast.exe product metadata without signing it', () => {
  const dist = mkdtempSync(join(tmpdir(), 'vast-store-builder-'))
  const binary = join(dist, manifest.electron.binary.fileName)
  const priorEnv = {
    VAST_DISTRIBUTION_CHANNEL: process.env.VAST_DISTRIBUTION_CHANNEL,
    VAST_UPDATE_ENABLED: process.env.VAST_UPDATE_ENABLED,
    VAST_PATCHED_ELECTRON_DIST: process.env.VAST_PATCHED_ELECTRON_DIST
  }
  try {
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, '')
    writeFileSync(join(dist, '.vast-electron-dist.json'), JSON.stringify({
      schemaVersion: 1,
      electronVersion: manifest.electron.version,
      patchsetRevision: manifest.electron.patchsetRevision,
      patchsetSha256: manifest.electron.patchsetSha256,
      electronBinarySha256: manifest.electron.binary.sha256
    }))
    process.env.VAST_DISTRIBUTION_CHANNEL = 'microsoft-store'
    process.env.VAST_UPDATE_ENABLED = '0'
    process.env.VAST_PATCHED_ELECTRON_DIST = dist

    const config = require('../../scripts/electron-builder-store.cjs')
    assert.equal(config.win.signAndEditExecutable, true)
    assert.equal(config.win.signExecutable, false)
    assert.equal(config.forceCodeSigning, false)
  } finally {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dist, { recursive: true, force: true })
  }
})
