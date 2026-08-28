import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExtensionRegistry } from '../../src/main/extensions/extension-registry.ts'
import type { InstalledExtensionRecord } from '../../src/main/extensions/extension-types.ts'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'

async function temporaryProfile(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vast-extension-registry-'))
}

function record(path: string): InstalledExtensionRecord {
  return {
    id: extensionId,
    name: 'Registry fixture',
    version: '1.0.0',
    path,
    enabled: true,
    source: 'unpacked',
    trust: 'developer',
    updateState: 'not-applicable',
    runtime: 'chrome',
    manifestVersion: 3,
    installedAt: 1,
    updatedAt: 1,
    allowFileAccess: false,
    grantedPermissions: []
  }
}

test('persists enabled state atomically and restores it in a new registry instance', async () => {
  const root = await temporaryProfile()
  const extensionPath = join(root, 'unpacked')
  try {
    const first = new ExtensionRegistry(root)
    await first.load()
    await first.upsert(record(extensionPath))
    await first.setEnabled(extensionId, false)
    await first.setGrantedPermissions(extensionId, ['vast.storage'])

    const restored = new ExtensionRegistry(root)
    assert.equal((await restored.load())[0]?.enabled, false)
    assert.deepEqual(restored.get(extensionId)?.grantedPermissions, ['vast.storage'])
    const persisted = JSON.parse(await readFile(restored.filePath, 'utf8')) as { schemaVersion: number }
    assert.equal(persisted.schemaVersion, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('quarantines a malformed registry without crashing startup', async () => {
  const root = await temporaryProfile()
  const directory = join(root, 'Extensions')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'registry.json'), '{ definitely broken', 'utf8')

    const registry = new ExtensionRegistry(root)
    assert.deepEqual(await registry.load(), [])
    const entries = await readdir(directory)
    assert.equal(entries.some((entry) => /^registry\.corrupt-\d+\.json$/.test(entry)), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sanitizes invalid and duplicate records while retaining a valid installation', async () => {
  const root = await temporaryProfile()
  const directory = join(root, 'Extensions')
  const valid = record(join(root, 'valid-unpacked'))
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      extensions: [
        valid,
        { ...valid, id: 'not-an-extension-id' },
        { ...valid, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      ]
    }), 'utf8')

    const registry = new ExtensionRegistry(root)
    assert.deepEqual(await registry.load(), [valid])
    const persisted = JSON.parse(await readFile(registry.filePath, 'utf8')) as { extensions: unknown[] }
    assert.equal(persisted.extensions.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
