import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stageLocalChromiumDirectory, verifyLocalChromiumCopy } from '../../src/main/extensions/local-chromium-stage.ts'

const id = 'a'.repeat(32)

async function fixture(): Promise<{ root: string; source: string; staging: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vast-local-stage-'))
  const source = join(root, 'Chrome', 'Default', 'Extensions', id, '1.0.0_0')
  const staging = join(root, 'Vast', 'Staging')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Controlled', version: '1.0.0' }))
  return { root, source, staging }
}

test('stages byte-identical original files but never adjacent Chromium private storage', async () => {
  const data = await fixture()
  try {
    await mkdir(join(data.source, 'assets'))
    await writeFile(join(data.source, 'assets', 'script.js'), 'globalThis.fixture = true')
    await mkdir(join(data.source, '_metadata'))
    await writeFile(join(data.source, '_metadata', 'verified_contents.json'), '{"controlled":true}')
    const privateRoot = join(data.root, 'Chrome', 'Default', 'Local Extension Settings', id)
    await mkdir(privateRoot, { recursive: true })
    await writeFile(join(privateRoot, 'vault'), 'controlled-private-data')
    const staged = await stageLocalChromiumDirectory({
      sourceRoot: data.source, sourceExtensionId: id, expectedVersion: '1.0.0', stagingRoot: data.staging
    }, new AbortController().signal)
    assert.equal(staged.fileCount, 2)
    assert.equal(staged.fingerprint.length, 64)
    assert.deepEqual(await readFile(join(staged.contentRoot, 'assets', 'script.js')), await readFile(join(data.source, 'assets', 'script.js')))
    assert.deepEqual((await readdir(staged.contentRoot)).sort(), ['assets', 'manifest.json'])
    await verifyLocalChromiumCopy(staged.contentRoot, staged.fingerprint, new AbortController().signal)
    assert.equal(await readFile(join(data.source, '_metadata', 'verified_contents.json'), 'utf8'), '{"controlled":true}')
    await mkdir(join(staged.contentRoot, '_metadata'))
    await assert.rejects(verifyLocalChromiumCopy(staged.contentRoot, staged.fingerprint, new AbortController().signal), /metadata/i)
    assert.equal(await readFile(join(privateRoot, 'vault'), 'utf8'), 'controlled-private-data')
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('rejects links to files outside source before copying any content', async (t) => {
  const data = await fixture()
  try {
    const privateFile = join(data.root, 'private-vault')
    await writeFile(privateFile, 'do-not-read')
    try { await symlink(privateFile, join(data.source, 'vault-link')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symlinks unavailable')
      throw error
    }
    await assert.rejects(stageLocalChromiumDirectory({
      sourceRoot: data.source, sourceExtensionId: id, expectedVersion: '1.0.0', stagingRoot: data.staging
    }, new AbortController().signal), /link|escap/i)
    assert.equal(await readFile(privateFile, 'utf8'), 'do-not-read')
  } finally { await rm(data.root, { recursive: true, force: true }) }
})

test('rejects cancelled, private-path, oversized and mismatched-version sources without permanent copies', async () => {
  const data = await fixture()
  try {
    const args = { sourceRoot: data.source, sourceExtensionId: id, expectedVersion: '1.0.0', stagingRoot: data.staging }
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(stageLocalChromiumDirectory(args, cancelled.signal), /cancelled/i)
    await mkdir(join(data.source, 'IndexedDB'))
    await assert.rejects(stageLocalChromiumDirectory(args, new AbortController().signal), /private/i)
    await rm(join(data.source, 'IndexedDB'), { recursive: true })
    await writeFile(join(data.source, 'too-large.bin'), Buffer.alloc(32 * 1024 * 1024 + 1))
    await assert.rejects(stageLocalChromiumDirectory(args, new AbortController().signal), /limit/i)
    await rm(join(data.source, 'too-large.bin'))
    await assert.rejects(stageLocalChromiumDirectory({ ...args, expectedVersion: '2.0.0' }, new AbortController().signal), /version/i)
    assert.deepEqual(await readdir(data.staging), [])
  } finally { await rm(data.root, { recursive: true, force: true }) }
})
