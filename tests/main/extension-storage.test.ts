import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtensionStorage, EXTENSION_STORAGE_QUOTA_BYTES } from '../../src/main/extensions/extension-storage.ts'

test('Vast extension storage is isolated, persistent, JSON-only, and removable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-storage-'))
  try {
    const first = new ExtensionStorage(root)
    await first.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { value: 'A', nested: { ok: true } })
    assert.deepEqual(await first.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null), { value: 'A', nested: { ok: true } })
    assert.deepEqual(await first.get('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'value'), {})
    await assert.rejects(first.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { bad: undefined }), /JSON-compatible/)
    await assert.rejects(first.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', JSON.parse('{"__proto__":{"polluted":true}}')), /invalid key/)
    const restored = new ExtensionStorage(root)
    assert.deepEqual(await restored.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ['value']), { value: 'A' })
    await restored.removeAll('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.deepEqual(await restored.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {})
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Vast extension storage enforces the 5 MB quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-extension-storage-quota-'))
  try {
    const storage = new ExtensionStorage(root)
    await assert.rejects(storage.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { huge: 'x'.repeat(EXTENSION_STORAGE_QUOTA_BYTES) }), /quota exceeded/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
