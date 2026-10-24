import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createVisualProfileLibrary, VISUAL_PROFILE_LIMIT, type NewTabBackgroundStore } from '../../src/main/visual-profile-library.ts'
import { DEFAULT_VISUAL_PROFILE_VALUES, VISUAL_PROFILE_MAX_IMAGE_BYTES, type VisualProfileValues } from '../../src/shared/visual-profile.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const OTHER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6])

// Stand-ins for nativeImage: header checks only; prepare keeps the bytes.
const images = {
  inspect(bytes: Buffer) {
    if (bytes.subarray(0, 8).equals(PNG.subarray(0, 8))) return 'image/png' as const
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg' as const
    throw new Error('not an image')
  },
  prepare(bytes: Buffer) {
    return { bytes, type: images.inspect(bytes) }
  }
}

function memoryBackground(initial?: Buffer): NewTabBackgroundStore & { bytes?: Buffer } {
  const store: NewTabBackgroundStore & { bytes?: Buffer } = {
    bytes: initial,
    read: async () => store.bytes,
    write: async (bytes) => { store.bytes = Buffer.from(bytes); return `data:${images.inspect(bytes)};base64,${bytes.toString('base64')}` },
    clear: async () => { store.bytes = undefined }
  }
  return store
}

function setup(initialBackground?: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'vast-visual-profiles-'))
  const background = memoryBackground(initialBackground)
  let clock = 1_000
  const make = () => createVisualProfileLibrary({ directory, images, background, now: () => ++clock })
  return { directory, background, library: make(), reopen: make, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

const custom: VisualProfileValues = { ...DEFAULT_VISUAL_PROFILE_VALUES, newTabBackground: 'custom', accentColor: '#123456' }
const ocean: VisualProfileValues = { ...DEFAULT_VISUAL_PROFILE_VALUES, theme: 'light', accentColor: '#0077ff' }

test('saving snapshots the look, marks it applied and survives a restart', async () => {
  const { library, reopen, cleanup } = setup()
  try {
    assert.deepEqual(await library.list(), { profiles: [], appliedId: null })
    const saved = await library.save('  Ocean ', ocean)
    assert.equal(saved.appliedId, saved.id)
    assert.equal(saved.profiles[0].name, 'Ocean')
    assert.deepEqual(saved.profiles[0].values, ocean)
    assert.equal(saved.profiles[0].hasImage, false)
    const reloaded = await reopen().list()
    assert.deepEqual(reloaded, { profiles: saved.profiles, appliedId: saved.id })
  } finally { cleanup() }
})

test('a Custom background profile keeps its own copy of the New Tab image', async () => {
  const { library, background, directory, cleanup } = setup(PNG)
  try {
    const { id, profiles } = await library.save('Photo', custom)
    assert.equal(profiles[0].hasImage, true)
    assert.deepEqual(readFileSync(join(directory, `${id}.image`)), PNG)
    // A look without the Custom background never stores an image.
    const plain = await library.save('Plain', ocean)
    assert.equal(existsSync(join(directory, `${plain.id}.image`)), false)
    // Changing the live background later does not change the snapshot.
    background.bytes = OTHER_PNG
    assert.deepEqual(readFileSync(join(directory, `${id}.image`)), PNG)
  } finally { cleanup() }
})

test('applying an image is undoable, both over an image and over none', async () => {
  const { library, background, cleanup } = setup(PNG)
  try {
    const { id } = await library.save('Photo', custom)
    background.bytes = OTHER_PNG
    await library.applyImage(id)
    assert.deepEqual(background.bytes, PNG)
    await library.restoreImage()
    assert.deepEqual(background.bytes, OTHER_PNG)
    await assert.rejects(library.restoreImage(), /nothing|no image switch/i)

    background.bytes = undefined
    await library.applyImage(id)
    assert.deepEqual(background.bytes, PNG)
    assert.deepEqual(await library.restoreImage(), { dataUrl: undefined })
    assert.equal(background.bytes, undefined)
  } finally { cleanup() }
})

test('a tampered profile image is refused instead of being installed', async () => {
  const { library, background, directory, cleanup } = setup(PNG)
  try {
    const { id } = await library.save('Photo', custom)
    writeFileSync(join(directory, `${id}.image`), Buffer.from('<svg onload=alert(1)>'))
    background.bytes = OTHER_PNG
    await assert.rejects(library.applyImage(id), /not an image|damaged/)
    assert.deepEqual(background.bytes, OTHER_PNG)
  } finally { cleanup() }
})

test('update, rename and delete keep names unique and clean up files', async () => {
  const { library, directory, cleanup } = setup(PNG)
  try {
    const first = await library.save('Ocean', ocean)
    const second = await library.save('Ocean', custom)
    assert.equal(second.profiles[1].name, 'Ocean 2')
    const renamed = await library.rename(second.id, 'ocean')
    assert.equal(renamed.profiles[1].name, 'ocean 2')
    const updated = await library.update(first.id, { ...ocean, cornerRadius: 10 })
    assert.equal(updated.profiles[0].values.cornerRadius, 10)
    assert.equal(updated.appliedId, first.id)
    assert.ok(updated.profiles[0].updatedAt > updated.profiles[0].createdAt)
    const removed = await library.remove(second.id)
    assert.equal(removed.profiles.length, 1)
    assert.equal(existsSync(join(directory, `${second.id}.image`)), false)
    await assert.rejects(library.rename(second.id, 'x'), /no longer exists/)
    await assert.rejects(library.setApplied('vp-0000000000000000'), /no longer exists/)
    await assert.rejects(library.setApplied('../../profiles'), /no longer exists/)
    assert.deepEqual((await library.setApplied(null)).appliedId, null)
  } finally { cleanup() }
})

test('the library is bounded', async () => {
  const { library, cleanup } = setup()
  try {
    for (let index = 0; index < VISUAL_PROFILE_LIMIT; index += 1) await library.save(`Look ${index}`, ocean)
    await assert.rejects(library.save('One more', ocean), /up to 50/)
  } finally { cleanup() }
})

test('export and import round-trip a profile, image included, without applying it', async () => {
  const source = setup(PNG)
  const target = setup(OTHER_PNG)
  try {
    const { id } = await source.library.save('Photo', custom)
    const { text } = await source.library.exportDocument(id)
    assert.doesNotMatch(text, /[A-Z]:\\|\/Users\/|vast-visual-profiles/, 'no local paths in the file')
    const imported = await target.library.importDocument(text)
    assert.equal(imported.appliedId, null)
    assert.deepEqual(imported.profiles[0].values, custom)
    assert.equal(imported.profiles[0].hasImage, true)
    assert.deepEqual(target.background.bytes, OTHER_PNG, 'importing never touches the live background')
    await target.library.applyImage(imported.id)
    assert.deepEqual(target.background.bytes, PNG)
  } finally { source.cleanup(); target.cleanup() }
})

test('imports with lying, oversized or hostile content are rejected and leave the library as it was', async () => {
  const { library, cleanup } = setup()
  try {
    const base = { format: 'vast.visual-profile', version: 1, name: 'Evil', appearance: custom }
    const hostile = [
      { ...base, image: { type: 'image/png', data: JPEG.toString('base64') } },
      { ...base, image: { type: 'image/png', data: Buffer.from('<script>alert(1)</script>').toString('base64') } },
      { ...base, appearance: { ...custom, privacy: { blockTrackers: false } } },
      { ...base, security: { permissionCamera: 'allow' } },
      { ...base, version: 99 }
    ]
    for (const document of hostile) await assert.rejects(library.importDocument(JSON.stringify(document)))
    await assert.rejects(library.importDocument(JSON.stringify({ ...base, image: { type: 'image/png', data: Buffer.alloc(VISUAL_PROFILE_MAX_IMAGE_BYTES + 3).toString('base64') } })))
    assert.deepEqual((await library.list()).profiles, [])
  } finally { cleanup() }
})

test('a damaged index is set aside; invalid entries are dropped while valid ones load', async () => {
  const { directory, reopen, cleanup } = setup()
  try {
    writeFileSync(join(directory, 'profiles.json'), '{not json')
    assert.deepEqual(await reopen().list(), { profiles: [], appliedId: null })
    assert.ok(readdirSync(directory).some((name) => name.startsWith('profiles.json.unreadable-')))

    const good = { id: 'vp-0123456789abcdef', name: 'Good', createdAt: 1, updatedAt: 1, values: ocean }
    writeFileSync(join(directory, 'profiles.json'), JSON.stringify({
      format: 'vast.visual-profiles',
      version: 1,
      appliedId: 'vp-ffffffffffffffff',
      profiles: [
        good,
        { ...good, id: 'vp-1111111111111111', values: { ...ocean, labs: { automation: true } } },
        { ...good, id: '../escape', name: 'Path' },
        { ...good, id: 'vp-2222222222222222', image: 'image/png' },
        { ...good }
      ]
    }))
    const listing = await reopen().list()
    assert.deepEqual(listing.profiles.map((profile) => profile.id), [good.id])
    assert.equal(listing.appliedId, null)
  } finally { cleanup() }
})
