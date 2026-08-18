import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { CatAddonManager, parseCatAddonArchive, validateCatAddonPackage } from '../../src/main/cat-addon.ts'
import { LazyCatAddonService } from '../../src/main/cat-addon-service.ts'
import { CAT_ADDON_ARCHIVE_SHA256, CAT_ADDON_BUNDLE_VERSION } from '../../src/shared/cat-addon-bundle.ts'
import type { CatAddonState } from '../../src/shared/types.ts'

const archivePath = resolve('resources/cat-addon/cat_addon.zip')

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2)
  result.writeUInt16LE(value, 0)
  return result
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value >>> 0, 0)
  return result
}

function zip(entries: Array<{
  path: string
  centralPath?: string
  data?: Uint8Array
  flags?: number
  externalAttributes?: number
}>): Buffer {
  let offset = 0
  const prepared = entries.map((entry) => {
    const data = Buffer.from(entry.data ?? '{}')
    const compressed = deflateRawSync(data)
    const next = { ...entry, data, compressed, crc: crc32(data), offset, flags: entry.flags ?? 0x0800 }
    offset += 30 + Buffer.byteLength(entry.path) + compressed.length
    return next
  })
  const locals = prepared.map((entry) => {
    const name = Buffer.from(entry.path)
    return Buffer.concat([
      u32(0x04034b50), u16(20), u16(entry.flags), u16(8), u16(0), u16(33), u32(entry.crc),
      u32(entry.compressed.length), u32(entry.data.length), u16(name.length), u16(0), name, entry.compressed
    ])
  })
  const centralOffset = locals.reduce((sum, item) => sum + item.length, 0)
  const central = prepared.map((entry) => {
    const name = Buffer.from(entry.centralPath ?? entry.path)
    return Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(entry.flags), u16(8), u16(0), u16(33), u32(entry.crc),
      u32(entry.compressed.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(entry.externalAttributes ?? (0o100644 << 16)), u32(entry.offset), name
    ])
  })
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  return Buffer.concat([
    ...locals,
    ...central,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(centralOffset), u16(0)
  ])
}

function manager(userDataRoot: string, overrides: Partial<ConstructorParameters<typeof CatAddonManager>[0]> = {}): CatAddonManager {
  return new CatAddonManager({
    archivePath,
    userDataRoot,
    expectedArchiveHash: CAT_ADDON_ARCHIVE_SHA256,
    bundledVersion: CAT_ADDON_BUNDLE_VERSION,
    vastVersion: '0.1.4',
    ...overrides
  })
}

test('disabled Cat Addon status stays lightweight until deferred cleanup or first mutation', async () => {
  let imports = 0
  let initialized = 0
  class FakeManager {
    private state: CatAddonState = { enabled: false, installed: false, phase: 'disabled' }
    private readonly changed?: (state: CatAddonState) => void

    constructor(options: { onStateChanged?: (state: CatAddonState) => void }) {
      this.changed = options.onStateChanged
    }

    getState(): CatAddonState { return { ...this.state } }
    async initialize(enabled: boolean): Promise<CatAddonState> {
      initialized += 1
      return enabled ? this.enable() : this.disable()
    }
    async enable(): Promise<CatAddonState> {
      this.state = { enabled: true, installed: true, phase: 'enabled', version: '2.0.0' }
      this.changed?.(this.getState())
      return this.getState()
    }
    async disable(): Promise<CatAddonState> {
      this.state = { enabled: false, installed: false, phase: 'disabled' }
      this.changed?.(this.getState())
      return this.getState()
    }
    async runtime(): Promise<never> { throw new Error('unused') }
  }
  const service = new LazyCatAddonService({
    archivePath: 'unused',
    userDataRoot: 'unused',
    expectedArchiveHash: 'unused',
    bundledVersion: '2.0.0',
    vastVersion: '0.1.4'
  }, async () => {
    imports += 1
    return { CatAddonManager: FakeManager } as unknown as typeof import('../../src/main/cat-addon.ts')
  })

  assert.deepEqual(service.getState(), { enabled: false, installed: false, phase: 'disabled' })
  assert.deepEqual(await service.initializeIfEnabled(false), { enabled: false, installed: false, phase: 'disabled' })
  assert.equal(imports, 0)
  assert.equal(initialized, 0)

  await service.cleanupDisabledInIdle()
  assert.equal(imports, 1)
  assert.equal(initialized, 1)
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false)
}

test('bundled Cat Addon archive contains only the canonical runtime atlas and metadata', async () => {
  const entries = await parseCatAddonArchive(await readFile(archivePath))
  const manifest = validateCatAddonPackage(entries, '0.1.4', '2.0.0')
  assert.deepEqual(entries.map((entry) => entry.path), [
    'animations/animations.json',
    'assets/cat_grey_white.png',
    'manifest.json'
  ])
  assert.equal(manifest.id, 'com.vast.cat-addon')
  assert.equal(manifest.canonical_character, 'Cat_Grey_White')
  assert.equal(manifest.assets[0].role, 'runtime-atlas')
  assert.equal(manifest.assets[0].frames, 294)
  assert.equal(manifest.assets[0].width, 512)
  assert.equal(manifest.assets[0].height, 608)
})

test('archive parser rejects traversal, absolute, mixed-separator, duplicate, executable and symlink entries', async () => {
  const invalidArchives: Array<[string, Buffer]> = [
    ['traversal', zip([{ path: '../bad.json' }])],
    ['absolute', zip([{ path: '/bad.json' }])],
    ['drive absolute', zip([{ path: 'C:/bad.json' }])],
    ['mixed separators', zip([{ path: 'bad\\file.json' }])],
    ['normalized duplicate', zip([{ path: 'A.json' }, { path: 'a.json' }])],
    ['unsupported extension', zip([{ path: 'payload.js' }])],
    ['symlink', zip([{ path: 'link.json', externalAttributes: 0o120777 << 16 }])]
  ]
  for (const [label, archive] of invalidArchives) {
    await assert.rejects(() => parseCatAddonArchive(archive), undefined, label)
  }
})

test('archive parser rejects encryption, local/central disagreement, excessive entries and extracted size', async () => {
  await assert.rejects(() => parseCatAddonArchive(zip([{ path: 'a.json', flags: 0x0801 }])), /unsupported ZIP features/)
  await assert.rejects(() => parseCatAddonArchive(zip([{ path: 'a.json', centralPath: 'b.json' }])), /disagree/)
  await assert.rejects(() => parseCatAddonArchive(zip(Array.from({ length: 9 }, (_, index) => ({ path: `f${index}.json` })))), /number of entries/)
  await assert.rejects(
    () => parseCatAddonArchive(zip(Array.from({ length: 5 }, (_, index) => ({ path: `large${index}.json`, data: Buffer.alloc(480 * 1024, index) })))),
    /total size limit/
  )
})

test('manifest validation rejects malformed JSON, unsupported API, missing assets and newer Vast requirements', async () => {
  const source = await parseCatAddonArchive(await readFile(archivePath))
  const replace = (path: string, data: Buffer): typeof source => source.map((entry) => entry.path === path ? { path, data } : { ...entry })
  assert.throws(() => validateCatAddonPackage(replace('manifest.json', Buffer.from('{')), '0.1.4', '2.0.0'), /JSON is invalid/)
  const manifest = JSON.parse(source.find((entry) => entry.path === 'manifest.json')!.data.toString('utf8'))
  assert.throws(() => validateCatAddonPackage(replace('manifest.json', Buffer.from(JSON.stringify({ ...manifest, api_version: 99 }))), '0.1.4', '2.0.0'), /API version/)
  assert.throws(() => validateCatAddonPackage(source.filter((entry) => entry.path !== 'assets/cat_grey_white.png'), '0.1.4', '2.0.0'), /missing or undeclared/)
  assert.throws(() => validateCatAddonPackage(replace('manifest.json', Buffer.from(JSON.stringify({ ...manifest, minimum_vast_version: '9.0.0' }))), '0.1.4', '2.0.0'), /newer Vast/)
})

test('enable verifies, extracts, validates and disable removes every installed asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-cat-addon-'))
  try {
    const phases: string[] = []
    const service = manager(root, { onStateChanged: (state) => phases.push(state.phase) })
    const enabled = await service.enable()
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.installed, true)
    assert.equal(enabled.version, '2.0.0')
    assert.equal('assets' in enabled, false)
    assert.equal(await exists(join(root, 'CatAddon', '2.0.0', 'manifest.json')), true)
    const runtime = await service.runtime()
    assert.match(runtime.atlasDataUrl, /^data:image\/png;base64,/)
    assert.equal(runtime.metadata.source.asset, 'Cat_Grey_White.aseprite')
    assert.equal(runtime.metadata.animations.length, 49)
    const disabled = await service.disable()
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.installed, false)
    assert.equal(await exists(join(root, 'CatAddon', '2.0.0')), false)
    await assert.rejects(() => service.runtime(), /not enabled/)
    assert.equal(phases.includes('enabling') && phases.includes('enabled') && phases.includes('disabling'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('separate data profiles remain isolated and enabled startup reuses a verified install', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'vast-cat-addon-profile-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'vast-cat-addon-profile-b-'))
  try {
    assert.equal((await manager(rootA).enable()).enabled, true)
    const restartedA = await manager(rootA).initialize(true)
    const initialB = await manager(rootB).initialize(false)
    assert.equal(restartedA.enabled, true)
    assert.equal(restartedA.installed, true)
    assert.equal(initialB.enabled, false)
    assert.equal(initialB.installed, false)
    assert.equal(await exists(join(rootA, 'CatAddon', '2.0.0')), true)
    assert.equal(await exists(join(rootB, 'CatAddon', '2.0.0')), false)
  } finally {
    await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })])
  }
})

test('missing archive and wrong hash leave Cat Addon disabled without partial installation', async () => {
  for (const overrides of [
    { archivePath: join(tmpdir(), 'missing-cat-addon.zip') },
    { expectedArchiveHash: '0'.repeat(64) }
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'vast-cat-addon-failure-'))
    try {
      const state = await manager(root, overrides).enable()
      assert.equal(state.enabled, false)
      assert.equal(state.phase, 'error')
      assert.equal(await exists(join(root, 'CatAddon', '2.0.0')), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('disable during extraction wins and leaves no active or staging directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-cat-addon-race-'))
  let releaseInstallation!: () => void
  let installationReached!: () => void
  const reached = new Promise<void>((resolveReached) => { installationReached = resolveReached })
  const hold = new Promise<void>((resolveHold) => { releaseInstallation = resolveHold })
  try {
    const service = manager(root, { beforeActivateForTests: async () => { installationReached(); await hold } })
    const enabling = service.enable()
    await reached
    const disabling = service.disable()
    releaseInstallation()
    const [enableResult, disableResult] = await Promise.all([enabling, disabling])
    assert.equal(enableResult.enabled, false)
    assert.equal(disableResult.enabled, false)
    assert.equal(await exists(join(root, 'CatAddon', '2.0.0')), false)
    const children = await readdir(join(root, 'CatAddon')).catch(() => [])
    assert.equal(children.some((name) => name.startsWith('.install-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startup repairs corrupted installs, removes stale staging and replaces old bundle versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-cat-addon-repair-'))
  try {
    const first = manager(root)
    assert.equal((await first.enable()).enabled, true)
    await writeFile(join(root, 'CatAddon', '2.0.0', 'assets', 'cat_grey_white.png'), 'corrupt')
    await mkdir(join(root, 'CatAddon', '.install-stale'))
    await mkdir(join(root, 'CatAddon', '0.9.0'))
    const repaired = await manager(root).initialize(true)
    assert.equal(repaired.enabled, true)
    assert.equal((await readFile(join(root, 'CatAddon', '2.0.0', 'assets', 'cat_grey_white.png'))).length, 26528)
    assert.equal(await exists(join(root, 'CatAddon', '.install-stale')), false)
    assert.equal(await exists(join(root, 'CatAddon', '0.9.0')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed cleanup is marked and a later disabled startup safely retries it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-cat-addon-cleanup-'))
  try {
    const service = manager(root, { beforeRemoveForTests: () => { throw new Error('simulated lock') } })
    assert.equal((await service.enable()).enabled, true)
    const disabled = await service.disable()
    assert.equal(disabled.enabled, false)
    assert.match(disabled.error ?? '', /retry on next launch/i)
    assert.equal(await exists(join(root, 'CatAddon', 'pending-cleanup.json')), true)
    const retried = await manager(root).initialize(false)
    assert.equal(retried.installed, false)
    assert.equal(await exists(join(root, 'CatAddon', '2.0.0')), false)
    assert.equal(await exists(join(root, 'CatAddon', 'pending-cleanup.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
