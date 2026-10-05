import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverImportSources } from '../../src/main/browser-import.ts'
import * as profileDiscovery from '../../src/main/import/profile-discovery.ts'

let root = ''
let local = ''
let roaming = ''
let previousLocal: string | undefined
let previousRoaming: string | undefined

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vast-profile-discovery-'))
  local = join(root, 'Local')
  roaming = join(root, 'Roaming')
  previousLocal = process.env.LOCALAPPDATA
  previousRoaming = process.env.APPDATA
  process.env.LOCALAPPDATA = local
  process.env.APPDATA = roaming
  await mkdir(local, { recursive: true })
  await mkdir(roaming, { recursive: true })
})

test.afterEach(async () => {
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = previousLocal
  if (previousRoaming === undefined) delete process.env.APPDATA
  else process.env.APPDATA = previousRoaming
  await rm(root, { recursive: true, force: true })
})

test('discovers configured Firefox relative and absolute profiles by name without exposing paths', async () => {
  const firefoxRoot = join(roaming, 'Mozilla', 'Firefox')
  const relativeProfile = join(firefoxRoot, 'Profiles', 'alpha.default-release')
  const absoluteProfile = join(root, 'Custom Firefox Profile')
  await mkdir(relativeProfile, { recursive: true })
  await mkdir(absoluteProfile, { recursive: true })
  await writeFile(join(relativeProfile, 'places.sqlite'), '')
  await writeFile(join(absoluteProfile, 'places.sqlite'), '')
  await writeFile(join(firefoxRoot, 'profiles.ini'), [
    '[Profile0]', 'Name=Personal', 'IsRelative=1', 'Path=Profiles/alpha.default-release', '',
    '[Profile1]', 'Name=Work', 'IsRelative=0', `Path=${absoluteProfile}`, '',
    '[Profile2]', 'Name=Duplicate', 'IsRelative=1', 'Path=Profiles/alpha.default-release'
  ].join('\n'))

  const firefox = (await discoverImportSources()).sources.find((source) => source.id === 'firefox')
  assert.deepEqual(firefox?.profiles.map((profile) => profile.name), ['Personal', 'Work'])
  assert.equal(new Set(firefox?.profiles.map((profile) => profile.id)).size, 2)
  for (const profile of firefox?.profiles ?? []) {
    assert.equal(profile.id.includes(root), false, 'opaque ID must not reveal a filesystem path')
    assert.equal(profile.id.includes('/') || profile.id.includes('\\'), false)
  }
})

test('falls back to directory names when Chromium Local State is oversized', async () => {
  const userData = join(local, 'Google', 'Chrome', 'User Data')
  const profile = join(userData, 'Default')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'Bookmarks'), '{"roots":{}}')
  await writeFile(join(userData, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'X'.repeat(4 * 1024 * 1024) } } } }))

  const chrome = (await discoverImportSources()).sources.find((source) => source.id === 'chrome')
  assert.deepEqual(chrome?.profiles, [{ id: 'Default', name: 'Default' }])
})

test('rejects configured relative Firefox traversal even when a database exists outside Firefox root', async () => {
  const firefoxRoot = join(roaming, 'Mozilla', 'Firefox')
  const outside = join(roaming, 'Mozilla', 'outside')
  await mkdir(firefoxRoot, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'places.sqlite'), '')
  await writeFile(join(firefoxRoot, 'profiles.ini'), '[Profile0]\nName=Escaped\nIsRelative=1\nPath=../outside\n')

  const firefox = (await discoverImportSources()).sources.find((source) => source.id === 'firefox')
  assert.deepEqual(firefox?.profiles, [])
})

test('does not discover a Chromium profile junction that leaves its User Data root', async (t) => {
  const userData = join(local, 'Microsoft', 'Edge', 'User Data')
  const outside = join(root, 'outside-edge')
  await mkdir(userData, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'Bookmarks'), '{"roots":{}}')
  try {
    await symlink(outside, join(userData, 'Profile 1'), 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('junction creation is unavailable')
    throw error
  }
  assert.notEqual(await realpath(join(userData, 'Profile 1')), await realpath(userData))

  const edge = (await discoverImportSources()).sources.find((source) => source.id === 'edge')
  assert.deepEqual(edge?.profiles, [])
  assert.ok(await readFile(join(outside, 'Bookmarks'), 'utf8'), 'the source was not modified')
})

test('resolves only discovered profile IDs and revalidates the canonical source directory', async () => {
  const userData = join(local, 'Google', 'Chrome', 'User Data')
  const profile = join(userData, 'Default')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'Bookmarks'), '{"roots":{}}')

  assert.equal(typeof profileDiscovery.resolveImportProfile, 'function')
  const resolved = await profileDiscovery.resolveImportProfile('chrome', 'Default')
  assert.deepEqual(resolved, { sourceId: 'chrome', profileId: 'Default', canonicalPath: await realpath(profile) })
  await assert.rejects(profileDiscovery.resolveImportProfile('chrome', '../Default'), /profile/i)
  await assert.rejects(profileDiscovery.resolveImportProfile('firefox', 'Default'), /profile/i)

  await rm(profile, { recursive: true })
  await assert.rejects(profileDiscovery.resolveImportProfile('chrome', 'Default'), /profile/i)
})

test('resolves a configured absolute Firefox profile through its opaque ID', async () => {
  const firefoxRoot = join(roaming, 'Mozilla', 'Firefox')
  const custom = join(root, 'elsewhere', 'firefox-work')
  await mkdir(firefoxRoot, { recursive: true })
  await mkdir(custom, { recursive: true })
  await writeFile(join(custom, 'places.sqlite'), '')
  await writeFile(join(firefoxRoot, 'profiles.ini'), `[Profile0]\nName=Work\nIsRelative=0\nPath=${custom}\n`)

  const profile = (await discoverImportSources()).sources.find((source) => source.id === 'firefox')?.profiles[0]
  assert.ok(profile)
  assert.equal(typeof profileDiscovery.resolveImportProfile, 'function')
  const resolved = await profileDiscovery.resolveImportProfile('firefox', profile.id)
  assert.equal(resolved.canonicalPath, await realpath(custom))
  assert.equal(resolved.profileId, profile.id)
})

test('rejects an absolute Firefox profile reached through a directory link', async (t) => {
  const firefoxRoot = join(roaming, 'Mozilla', 'Firefox')
  const actual = join(root, 'actual-firefox')
  const alias = join(root, 'alias-firefox')
  await mkdir(firefoxRoot, { recursive: true })
  await mkdir(actual, { recursive: true })
  await writeFile(join(actual, 'places.sqlite'), '')
  try { await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('directory links unavailable')
    throw error
  }
  await writeFile(join(firefoxRoot, 'profiles.ini'), `[Profile0]\nName=Linked\nIsRelative=0\nPath=${alias}\n`)
  const firefox = (await discoverImportSources()).sources.find((source) => source.id === 'firefox')
  assert.deepEqual(firefox?.profiles, [])
})
