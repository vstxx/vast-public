import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtensionManagedStore } from '../../src/main/extensions/extension-managed-store.ts'
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
    const state = await store.activate(staged)
    assert.equal(state.extensionId, id)
    assert.equal(state.activeVersion, '1.0.0')
    assert.equal(installedPath, store.versionRoot(id, '1.0.0'))
    assert.equal((await store.readState(id))?.activeVersion, '1.0.0')
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
    assert.deepEqual((await readdir(join(store.managedRoot, id, 'versions'))).sort(), ['1.1.0', '1.2.0', '1.3.0'])
    assert.equal((await store.restoreActive(id, '1.2.0'))?.activeVersion, '1.2.0')
    await store.remove(id)
    await assert.rejects(stat(join(store.managedRoot, id)), /ENOENT/)
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
