const assert = require('node:assert/strict')
const test = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')
const manifest = require('../../patches/extension-compatibility-runtime.json')
const descriptor = require('../../third_party/electron/electron-ci-cache.json')
const { assertSafeArchiveEntries, validateDescriptor, moveVerifiedCache } = require('../../scripts/restore-patched-electron-cache.cjs')

test('verified cache move retries transient Windows file locks without overwriting an existing destination', async () => {
  let attempts = 0
  await moveVerifiedCache('temporary', 'destination', {
    renameSync() {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    },
    existsSync() { return false }
  }, 1)
  assert.equal(attempts, 3)
  await assert.rejects(moveVerifiedCache('temporary', 'destination', {
    renameSync() { throw Object.assign(new Error('busy'), { code: 'EPERM' }) },
    existsSync() { return true }
  }, 1), /destination already exists/)
})

test('private Electron cache is pinned to the approved patchset and binary', () => {
  assert.equal(validateDescriptor(descriptor, manifest).patchsetRevision, manifest.electron.patchsetRevision)
  assert.equal(descriptor.binarySha256, manifest.electron.binary.sha256)
  assert.equal(descriptor.releaseTag, `ci-cache-electron-${manifest.electron.binary.sha256.slice(0, 16)}`)
  assert.match(descriptor.archiveSha256, /^[a-f0-9]{64}$/)
})

test('Electron cache extraction rejects traversal, absolute paths and duplicate names', () => {
  assert.deepEqual(assertSafeArchiveEntries('./\n./.vast-electron-dist.json\n./electron.exe\n./locales/en-US.pak\n'), ['.vast-electron-dist.json', 'electron.exe', 'locales/en-US.pak'])
  for (const path of ['../escape', './../escape', '/absolute', 'C:/absolute', '.\\escape', './electron.exe/../escape']) {
    assert.throws(() => assertSafeArchiveEntries(`./\n${path}\n`), /unsafe|invalid/i, path)
  }
  assert.throws(() => assertSafeArchiveEntries('./electron.exe\n./electron.exe\n'), /duplicate/i)
})

test('release workflows restore the pinned runtime before native and packaging gates', () => {
  for (const workflow of ['windows-ci.yml', 'public-unsigned-beta.yml', 'store-release.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8')
    assert.match(text, /\.\/\.github\/actions\/prepare-patched-electron/)
  }
})
