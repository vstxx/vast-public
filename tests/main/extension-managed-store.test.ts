import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtensionManagedStore } from '../../src/main/extensions/extension-managed-store.ts'
import { stageLocalChromiumDirectory } from '../../src/main/extensions/local-chromium-stage.ts'
import { createEd25519Signer, createVextPackage, type VextTrustedKey } from '../../src/shared/vext-format.ts'

const id = 'abcdefghijklmnopabcdefghijklmnop'
const encoder = new TextEncoder()

async function packageFor(version: string, signer?: Awaited<ReturnType<typeof createEd25519Signer>>): Promise<Uint8Array> {
  return createVextPackage({
    extensionId: id,
    version,
    publisherId: signer ? 'publisher_0123456789abcdef' : null,
    files: new Map([
      ['background.js', encoder.encode(`globalThis.version=${JSON.stringify(version)}`)],
      ['manifest.json', encoder.encode(JSON.stringify({ manifest_version: 3, name: 'Managed fixture', version, vast: { api_version: 1, extension_id: id, background: 'background.js', permissions: [] } }))]
    ]),
    ...(signer ? { signer } : {})
  })
}

async function testKey(): Promise<{ signer: Awaited<ReturnType<typeof createEd25519Signer>>; trusted: VextTrustedKey }> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const privateKey = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey)
  const keyId = 'vast-managed-test'
  return { signer: await createEd25519Signer(keyId, Buffer.from(privateKey).toString('base64')), trusted: { keyId, algorithm: 'Ed25519', publicKeySpkiBase64: Buffer.from(publicKey).toString('base64'), status: 'test' } }
}

test('stages only verified files and atomically activates a stable managed identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-store-'))
  try {
    const store = new ExtensionManagedStore(root)
    await store.initialize()
    const staged = await store.stagePackage(await packageFor('1.0.0'), 'local-vext', [])
    assert.equal(await stat(join(staged.contentRoot, 'manifest.json')).then((value) => value.isFile()), true)
    const installedPath = await store.commit(staged)
    const transaction = await store.prepareRuntime(id, '1.0.0')
    const runtimePath = await store.swapRuntime(transaction)
    const state = await store.activate(staged)
    await store.commitRuntime(transaction)
    assert.equal(state.extensionId, id)
    assert.equal(state.activeVersion, '1.0.0')
    assert.equal(installedPath, store.versionRoot(id, '1.0.0'))
    assert.equal(runtimePath, store.currentRoot(id))
    assert.equal(await stat(join(runtimePath, 'manifest.json')).then((value) => value.isFile()), true)
    assert.equal((await store.readState(id))?.activeVersion, '1.0.0')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('persists a distinct local Chromium source without manufacturing a vext package or update channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-chromium-'))
  try {
    const source = join(root, 'Chrome', 'Default', 'Extensions', id, '1.0.0_0')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Controlled', version: '1.0.0' }))
    const store = new ExtensionManagedStore(join(root, 'Vast'))
    await store.initialize()
    const local = await stageLocalChromiumDirectory({ sourceRoot: source, sourceExtensionId: id,
      expectedVersion: '1.0.0', stagingRoot: store.stagingRoot }, new AbortController().signal)
    const staged = store.adoptLocalChromiumStage(local)
    assert.equal(staged.format, 'local-chromium')
    const release = await store.commit(staged)
    const transaction = await store.prepareRuntime(id, '1.0.0')
    await store.swapRuntime(transaction)
    const state = await store.activate(staged)
    await store.commitRuntime(transaction)
    assert.equal(state.source, 'local-chromium')
    assert.equal(state.publisherId, undefined)
    assert.equal(state.versions[0].packageSha256, local.fingerprint)
    assert.equal(await readFile(join(release, 'manifest.json'), 'utf8'), await readFile(join(source, 'manifest.json'), 'utf8'))
    assert.equal((await new ExtensionManagedStore(join(root, 'Vast')).readState(id))?.source, 'local-chromium')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('keeps a rollback version, prunes stale immutable versions, and removes managed data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-rollback-'))
  try {
    const store = new ExtensionManagedStore(root)
    await store.initialize()
    for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
      const staged = await store.stagePackage(await packageFor(version), 'local-vext', [])
      await store.commit(staged)
      await store.activate(staged)
    }
    const state = await store.readState(id)
    assert.equal(state?.activeVersion, '1.3.0')
    assert.equal(state?.previousVersion, '1.2.0')
    assert.deepEqual(state?.versions.map((version) => version.version), ['1.3.0', '1.2.0', '1.1.0'])
    assert.deepEqual((await readdir(join(store.managedRoot, id, 'releases'))).sort(), ['1.1.0', '1.2.0', '1.3.0'])
    assert.equal((await store.restoreActive(id, '1.2.0'))?.activeVersion, '1.2.0')
    await store.remove(id)
    await assert.rejects(stat(join(store.managedRoot, id)), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('startup recovers an interrupted runtime swap according to the atomically committed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-runtime-recovery-'))
  try {
    const store = new ExtensionManagedStore(root)
    await store.initialize()
    const v1 = await store.stagePackage(await packageFor('1.0.0'), 'local-vext', [])
    await store.commit(v1)
    const first = await store.prepareRuntime(id, '1.0.0')
    await store.swapRuntime(first)
    await store.activate(v1)
    await store.commitRuntime(first)

    const v2 = await store.stagePackage(await packageFor('2.0.0'), 'local-vext', [])
    await store.commit(v2)
    const interrupted = await store.prepareRuntime(id, '2.0.0')
    await store.swapRuntime(interrupted)
    await new ExtensionManagedStore(root).initialize()
    const rolledBack = JSON.parse(await readFile(join(store.currentRoot(id), 'manifest.json'), 'utf8')) as { version: string }
    assert.equal(rolledBack.version, '1.0.0')

    const committed = await store.prepareRuntime(id, '2.0.0')
    await store.swapRuntime(committed)
    await store.activate(v2)
    await new ExtensionManagedStore(root).initialize()
    const retained = JSON.parse(await readFile(join(store.currentRoot(id), 'manifest.json'), 'utf8')) as { version: string }
    assert.equal(retained.version, '2.0.0')
    await assert.rejects(stat(join(store.managedRoot, id, 'current.previous')), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('keyless legacy installs keep their original physical runtime path across updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-legacy-runtime-'))
  try {
    const store = new ExtensionManagedStore(root)
    await store.initialize()
    const v1 = await store.stagePackage(await packageFor('1.0.0'), 'local-vext', [])
    const releaseV1 = await store.commit(v1)
    const legacyRuntime = join(store.managedRoot, id, 'versions', '1.0.0')
    await mkdir(join(store.managedRoot, id, 'versions'), { recursive: true })
    await rename(releaseV1, legacyRuntime)
    await store.activate(v1)
    assert.equal(await store.adoptLegacyRuntimePath(id, legacyRuntime), legacyRuntime)

    const v2 = await store.stagePackage(await packageFor('2.0.0'), 'local-vext', [])
    await store.commit(v2)
    const update = await store.prepareRuntime(id, '2.0.0')
    assert.equal(update.currentRoot, legacyRuntime)
    assert.equal(await store.swapRuntime(update), legacyRuntime)
    await store.activate(v2)
    await store.commitRuntime(update)
    const manifest = JSON.parse(await readFile(join(legacyRuntime, 'manifest.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '2.0.0')
    assert.equal(await stat(store.versionRoot(id, '1.0.0')).then((entry) => entry.isDirectory()), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('requires a trusted Hub signature and cleans abandoned staging directories on startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-managed-trust-'))
  try {
    const store = new ExtensionManagedStore(root)
    await mkdir(join(store.stagingRoot, 'abandoned', 'content'), { recursive: true })
    await writeFile(join(store.stagingRoot, 'abandoned', 'content', 'partial'), 'partial')
    await store.initialize()
    assert.deepEqual(await readdir(store.stagingRoot), [])
    await assert.rejects(store.stagePackage(await packageFor('1.0.0'), 'hub', []), /Could not verify/)
    const { signer, trusted } = await testKey()
    const staged = await store.stagePackage(await packageFor('1.0.0', signer), 'hub', [trusted])
    assert.equal(staged.parsed.verifiedKeyId, trusted.keyId)
    await store.discard(staged)
  } finally { await rm(root, { recursive: true, force: true }) }
})
