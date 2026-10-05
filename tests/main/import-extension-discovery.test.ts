import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverChromiumExtensions, resolveChromiumExtensionDirectory } from '../../src/main/import/chromium-extension-discovery.ts'

const firstId = 'a'.repeat(32)
const secondId = 'b'.repeat(32)

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vast-extension-discovery-'))
}

async function extension(profile: string, id: string, folder: string, manifest: object): Promise<void> {
  const root = join(profile, 'Extensions', id, folder)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

test('reads source enabled state, matching version and localized display name without private storage', async () => {
  const profile = await fixture()
  try {
    await extension(profile, firstId, '1.2.3_0', { manifest_version: 3, version: '1.2.3', name: '__MSG_appName__', default_locale: 'en' })
    await mkdir(join(profile, 'Extensions', firstId, '1.2.3_0', '_locales', 'en'), { recursive: true })
    await writeFile(join(profile, 'Extensions', firstId, '1.2.3_0', '_locales', 'en', 'messages.json'), JSON.stringify({ appName: { message: 'Real Extension Name' } }))
    await extension(profile, secondId, '2.0.0_0', { manifest_version: 2, version: '2.0.0', name: 'Disabled Extension' })
    await mkdir(join(profile, 'Local Extension Settings', firstId), { recursive: true })
    await writeFile(join(profile, 'Local Extension Settings', firstId, 'vault-secret'), 'never-read-me')
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [firstId]: { state: 1, manifest: { version: '1.2.3' } },
      [secondId]: { state: 0, manifest: { version: '2.0.0' } }
    } } }))
    const found = await discoverChromiumExtensions(profile)
    assert.equal(found.length, 2)
    assert.deepEqual(found[0], {
      id: firstId, name: 'Real Extension Name', version: '1.2.3', sourceEnabled: true,
      manifestVersion: 3, state: 'detected', limitationCodes: [],
      fingerprint: found[0].fingerprint
    })
    assert.equal(found[0].fingerprint.length, 64)
    assert.equal(found[1].sourceEnabled, false)
    assert.deepEqual(found[1].limitationCodes, ['SOURCE_DISABLED'])
    assert.equal((await readFile(join(profile, 'Local Extension Settings', firstId, 'vault-secret'), 'utf8')), 'never-read-me')
    assert.equal(JSON.stringify(found).includes('never-read-me'), false)
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('marks a stale Preferences version as failed rather than silently choosing another directory', async () => {
  const profile = await fixture()
  try {
    await extension(profile, firstId, '2.0.0_0', { manifest_version: 3, version: '2.0.0', name: 'Wrong Version' })
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [firstId]: { state: 1, manifest: { version: '1.0.0' } }
    } } }))
    const [found] = await discoverChromiumExtensions(profile)
    assert.equal(found.state, 'failed')
    assert.deepEqual(found.limitationCodes, ['VERSION_OR_MANIFEST_MISMATCH'])
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('prefers Chromium Secure Preferences and preserves source state during resolution', async () => {
  const profile = await fixture()
  try {
    await extension(profile, firstId, '3.0.0_0', { manifest_version: 3, version: '3.0.0', name: 'Secure' })
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: {
      [firstId]: { state: 0, manifest: { version: '1.0.0' } }
    } } }))
    await writeFile(join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: {
      [firstId]: { state: 1, manifest: { version: '3.0.0' } }
    } } }))
    const [found] = await discoverChromiumExtensions(profile)
    assert.equal(found.state, 'detected')
    assert.equal(found.sourceEnabled, true)
    assert.equal(found.version, '3.0.0')
    assert.equal(await resolveChromiumExtensionDirectory(profile, firstId, found.version, found.fingerprint),
      await realpath(join(profile, 'Extensions', firstId, '3.0.0_0')))
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('ignores browser component entries without original extension directories', async () => {
  const profile = await fixture()
  try {
    await extension(profile, firstId, '1.0.0_0', { manifest_version: 3, version: '1.0.0', name: 'Local' })
    await writeFile(join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: {
      [firstId]: { state: 1, manifest: { version: '1.0.0' } },
      [secondId]: { state: 1, location: 5, manifest: { version: '1.0.0' } }
    } } }))
    const found = await discoverChromiumExtensions(profile)
    assert.deepEqual(found.map((item) => item.id), [firstId])
  } finally { await rm(profile, { recursive: true, force: true }) }
})

test('rejects malformed or oversized Preferences and refuses to truncate a large extension inventory', async () => {
  const profile = await fixture()
  try {
    await mkdir(join(profile, 'Extensions'))
    await writeFile(join(profile, 'Preferences'), '{')
    await assert.rejects(discoverChromiumExtensions(profile), SyntaxError)
    await writeFile(join(profile, 'Preferences'), 'x'.repeat(32 * 1024 * 1024 + 1))
    await assert.rejects(discoverChromiumExtensions(profile), /limit/i)
    const settings: Record<string, object> = {}
    for (let index = 0; index < 201; index++) {
      let number = index
      let id = ''
      for (let digit = 0; digit < 32; digit++) { id = String.fromCharCode(97 + number % 16) + id; number = Math.floor(number / 16) }
      settings[id] = { state: 1, manifest: { version: '1.0' } }
      await mkdir(join(profile, 'Extensions', id))
    }
    await writeFile(join(profile, 'Preferences'), JSON.stringify({ extensions: { settings } }))
    await assert.rejects(discoverChromiumExtensions(profile), /count exceeds/i)
  } finally { await rm(profile, { recursive: true, force: true }) }
})
