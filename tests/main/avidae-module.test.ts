import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { AvidaeModuleManager, type AvidaeModuleEnvironment } from '../../src/main/avidae-module.ts'
import { extractModuleArchive, validateModuleRelativePath } from '../../src/main/avidae-module-archive.ts'
import { signedModuleBytes, verifyModuleReleaseManifest, type AvidaeModuleTrustedKey } from '../../src/main/avidae-module-manifest.ts'
import { verifyAvidaeRuntime } from '../../src/main/avidae-runtime.ts'
import type { AvidaeModuleStatus } from '../../src/shared/types.ts'

const require = createRequire(import.meta.url)
const { writeModuleArchive, header, BLOCK } = require('../../scripts/avidae-module-archive.cjs') as {
  writeModuleArchive: (entries: { path: string; data?: Buffer; source?: string; size: number }[], output: string, options?: { level?: number }) => Promise<void>
  header: (name: string, size: number, type: string) => Buffer
  BLOCK: number
}

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

interface Keys { privateKey: KeyObject; trusted: AvidaeModuleTrustedKey }

function keys(keyId = 'test-key', status: AvidaeModuleTrustedKey['status'] = 'current'): Keys {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    trusted: { keyId, algorithm: 'Ed25519', status, publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  }
}

interface Fixture {
  archive: Buffer
  runtimeManifest: Buffer
  files: Map<string, Buffer>
  unpackedSize: number
  fileCount: number
}

// A tiny but structurally complete runtime: the same records the backend
// verifies before launch, plus filler files to exercise streaming.
async function runtimeFixture(version: string, workDir: string, extra: Record<string, Buffer> = {}): Promise<Fixture> {
  const files = new Map<string, Buffer>([
    ['VastVideoAudio/VastVideoAudio.exe', Buffer.from(`runtime ${version}`)],
    ['VastVideoAudio/_internal/base_library.zip', Buffer.alloc(300_000, 7)],
    ['media/ffmpeg.exe', Buffer.from('ffmpeg')],
    ['media/ffprobe.exe', Buffer.from('ffprobe')],
    ['avidae-ffmpeg-capabilities.json', Buffer.from('{"ok":true}')],
    ['ms-playwright/chromium-1/chrome-win/chrome.exe', Buffer.from('chromium')],
    ['licenses/FFmpeg-README.txt', Buffer.from('license')],
    [`deep/${'a'.repeat(60)}/${'b'.repeat(60)}/long-name.bin`, Buffer.from('long path')],
    ...Object.entries(extra)
  ])
  const sourceBundle = { fileName: 'ffmpeg-corresponding-source-win64.tar.zst', sha256: sha('source'), size: 6 }
  files.set('ffmpeg-build-provenance.json', Buffer.from(JSON.stringify({
    licenseMode: 'gpl-3.0-or-later',
    ffmpeg: { sha256: sha(files.get('media/ffmpeg.exe')!) },
    ffprobe: { sha256: sha(files.get('media/ffprobe.exe')!) },
    capabilityReport: { sha256: sha(files.get('avidae-ffmpeg-capabilities.json')!), size: files.get('avidae-ffmpeg-capabilities.json')!.length },
    sourceBundle
  })))
  const record = (path: string): { path: string; sha256: string; size: number } => ({ path, sha256: sha(files.get(path)!), size: files.get(path)!.length })
  const inventory = [...files.keys()].sort().map(record)
  const runtimeManifest = Buffer.from(JSON.stringify({
    schemaVersion: 4,
    moduleId: 'vast-video-audio',
    moduleVersion: version,
    hostApi: 1,
    runtimeVersion: `${version}-python-3.13`,
    executable: record('VastVideoAudio/VastVideoAudio.exe'),
    ffmpeg: record('media/ffmpeg.exe'),
    ffprobe: record('media/ffprobe.exe'),
    ffmpegProvenance: record('ffmpeg-build-provenance.json'),
    ffmpegCapabilities: record('avidae-ffmpeg-capabilities.json'),
    ffmpegSourceBundle: sourceBundle,
    browser: { engine: 'chromium', distribution: 'playwright-chromium', headlessMode: 'new', executable: record('ms-playwright/chromium-1/chrome-win/chrome.exe') },
    playwrightBrowsersPath: 'ms-playwright',
    files: inventory
  }))
  const output = join(workDir, `module-${version}.tar.zst`)
  await writeModuleArchive([
    { path: 'runtime-manifest.json', data: runtimeManifest, size: runtimeManifest.length },
    ...inventory.map((item) => ({ path: item.path, data: files.get(item.path)!, size: item.size }))
  ], output, { level: 3 })
  const unpackedSize = runtimeManifest.length + inventory.reduce((total, item) => total + item.size, 0)
  return { archive: await readFile(output), runtimeManifest, files, unpackedSize, fileCount: inventory.length + 1 }
}

function signedManifest(signer: Keys, fixture: Fixture, baseUrl: string, overrides: Record<string, unknown> = {}): string {
  const payload = {
    schemaVersion: 1,
    moduleId: 'vast-video-audio',
    moduleVersion: '1.0.0',
    sequence: 1,
    platform: 'win32',
    arch: 'x64',
    hostApi: 1,
    minVastVersion: '0.5.0',
    publishedAt: '2026-10-27T00:00:00.000Z',
    archive: {
      url: `${baseUrl}/module.tar.zst`,
      fileName: 'VastVideoAudio-1.0.0-win-x64.tar.zst',
      format: 'tar.zst',
      size: fixture.archive.length,
      sha256: sha(fixture.archive),
      unpackedSize: fixture.unpackedSize,
      fileCount: fixture.fileCount
    },
    runtimeManifest: { sha256: sha(fixture.runtimeManifest), size: fixture.runtimeManifest.length },
    runtime: { runtimeVersion: '1.0.0-python-3.13', python: 'Python 3.13', playwright: '1.62.0', pyinstaller: '6', ffmpegVersion: 'ffmpeg 9.0.1' },
    ffmpegSource: { fileName: 'ffmpeg-corresponding-source-win64.tar.zst', url: `${baseUrl}/source.tar.zst`, sha256: sha('source'), size: 6 },
    revokedModuleVersions: [],
    ...overrides
  }
  const signature = sign(null, signedModuleBytes(payload), signer.privateKey).toString('base64')
  return JSON.stringify({ format: 'vast-avidae-module-manifest', keyId: signer.trusted.keyId, signature, payload })
}

interface ReleaseServer {
  url: string
  manifest: string | null
  archive: Buffer
  requests: { path: string; range?: string }[]
  // Number of archive responses to cut off half-way.
  dropArchiveResponses: number
  ignoreRange: boolean
  server: Server
}

async function releaseServer(archive: Buffer): Promise<ReleaseServer> {
  const state = { manifest: null as string | null, archive, requests: [] as { path: string; range?: string }[], dropArchiveResponses: 0, ignoreRange: false }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    state.requests.push({ path: request.url ?? '', range: request.headers.range })
    if (request.url === '/manifest.json') {
      if (state.manifest === null) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(state.manifest)
      return
    }
    if (request.url === '/module.tar.zst') {
      const total = state.archive.length
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
      const start = range && !state.ignoreRange ? Number(range[1]) : 0
      const body = state.archive.subarray(start)
      const headers: Record<string, string | number> = { 'content-length': body.length, 'accept-ranges': 'bytes' }
      if (start > 0) headers['content-range'] = `bytes ${start}-${total - 1}/${total}`
      response.writeHead(start > 0 ? 206 : 200, headers)
      if (state.dropArchiveResponses > 0) {
        state.dropArchiveResponses -= 1
        response.write(body.subarray(0, Math.floor(body.length / 2)), () => response.socket?.destroy())
        return
      }
      response.end(body)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return Object.assign(state, { url: `http://127.0.0.1:${address.port}`, server }) as ReleaseServer
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vast-avidae-module-'))
}

function manager(root: string, server: ReleaseServer, trusted: AvidaeModuleTrustedKey[], overrides: Partial<AvidaeModuleEnvironment> = {}): AvidaeModuleManager {
  return new AvidaeModuleManager({
    root,
    manifestUrl: `${server.url}/manifest.json`,
    trustedKeys: trusted,
    revokedModuleVersions: [],
    vastVersion: '0.6.0',
    platform: 'win32',
    arch: 'x64',
    allowLoopbackHttp: true,
    fetch: (input, init) => fetch(input, init),
    freeBytes: async () => 100 * 1024 ** 3,
    retryDelaysMs: [10, 10],
    stallTimeoutMs: 2_000,
    ...overrides
  })
}

test('module paths reject traversal, devices, alternate streams and Windows aliases', () => {
  for (const unsafe of ['../evil', 'a/../../b', '/abs', 'C:/x', 'a\\b', 'a//b', 'con', 'dir/NUL.txt', 'file.', 'name ', 'a:stream', 'x\u0001']) {
    assert.throws(() => validateModuleRelativePath(unsafe), /unsafe|invalid/i, unsafe)
  }
  assert.equal(validateModuleRelativePath('ms-playwright/chromium-1/chrome.exe'), 'ms-playwright/chromium-1/chrome.exe')
})

test('signed module manifests verify only with pinned, unrevoked keys and compatible hosts', async () => {
  const dir = await workspace()
  try {
    const signer = keys()
    const fixture = await runtimeFixture('1.0.0', dir)
    const raw = signedManifest(signer, fixture, 'https://example.invalid')
    const options = { trustedKeys: [signer.trusted], vastVersion: '0.6.0', platform: 'win32', arch: 'x64' }
    assert.equal(verifyModuleReleaseManifest(raw, options).payload.moduleVersion, '1.0.0')
    assert.throws(() => verifyModuleReleaseManifest(raw, { ...options, trustedKeys: [keys('other-key').trusted] }), /untrusted key/)
    assert.throws(() => verifyModuleReleaseManifest(raw, { ...options, trustedKeys: [{ ...signer.trusted, status: 'revoked' }] }), /untrusted key/)
    const tampered = JSON.parse(raw)
    tampered.payload.archive.size += 1
    assert.throws(() => verifyModuleReleaseManifest(JSON.stringify(tampered), options), /signature is invalid/)
    assert.throws(() => verifyModuleReleaseManifest(raw, { ...options, arch: 'arm64' }), /different platform/)
    assert.throws(() => verifyModuleReleaseManifest(raw, { ...options, vastVersion: '0.4.9' }), /different version of Vast/)
    assert.throws(() => verifyModuleReleaseManifest(signedManifest(signer, fixture, 'https://example.invalid', { hostApi: 2 }), options), /different version of Vast/)
    // Plain HTTP is accepted only for loopback test servers.
    assert.throws(() => verifyModuleReleaseManifest(signedManifest(signer, fixture, 'http://127.0.0.1:1'), options), /archive metadata is invalid/)
    assert.equal(verifyModuleReleaseManifest(signedManifest(signer, fixture, 'http://127.0.0.1:1'), { ...options, allowLoopbackHttp: true }).keyId, 'test-key')
    assert.throws(() => verifyModuleReleaseManifest(signedManifest(signer, fixture, 'http://example.com'), { ...options, allowLoopbackHttp: true }), /archive metadata is invalid/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function rawTar(entries: { name: string; type?: string; body?: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0)
    parts.push(header(entry.name, body.length, entry.type ?? '0'), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return zstdCompressSync(Buffer.concat(parts))
}

test('archive extraction rejects every unsafe or unlisted entry before it can be used', async () => {
  const dir = await workspace()
  try {
    const manifestFiles = [{ path: 'ok.bin', size: 2, sha256: sha('ok') }]
    const runtimeManifest = Buffer.from(JSON.stringify({ files: manifestFiles }))
    const limits = { runtimeManifestSha256: sha(runtimeManifest), runtimeManifestSize: runtimeManifest.length, unpackedSize: runtimeManifest.length + 2, fileCount: 2 }
    const manifestEntry = { name: 'runtime-manifest.json', body: runtimeManifest }
    const cases: [string, Buffer, RegExp][] = [
      ['valid', rawTar([manifestEntry, { name: 'ok.bin', body: Buffer.from('ok') }]), /^$/],
      ['traversal', rawTar([manifestEntry, { name: '../ok.bin', body: Buffer.from('ok') }]), /unsafe/],
      ['symlink', rawTar([manifestEntry, { name: 'ok.bin', type: '2' }]), /unsupported entry type/],
      ['hardlink', rawTar([manifestEntry, { name: 'ok.bin', type: '1' }]), /unsupported entry type/],
      ['unlisted', rawTar([manifestEntry, { name: 'other.bin', body: Buffer.from('ok') }]), /outside the runtime inventory/],
      ['wrong hash', rawTar([manifestEntry, { name: 'ok.bin', body: Buffer.from('no') }]), /integrity/],
      ['wrong size', rawTar([manifestEntry, { name: 'ok.bin', body: Buffer.from('okk') }]), /size does not match/],
      ['duplicate', rawTar([manifestEntry, { name: 'ok.bin', body: Buffer.from('ok') }, { name: 'OK.bin', body: Buffer.from('ok') }]), /duplicate/],
      ['manifest not first', rawTar([{ name: 'ok.bin', body: Buffer.from('ok') }, manifestEntry]), /must start with/],
      ['missing file', rawTar([manifestEntry]), /missing runtime files/],
      ['truncated', zstdCompressSync(Buffer.concat([header('runtime-manifest.json', runtimeManifest.length, '0'), runtimeManifest.subarray(0, 4)])), /ended unexpectedly/]
    ]
    for (const [name, archive, expected] of cases) {
      const archivePath = join(dir, `${name}.tar.zst`)
      const target = join(dir, `out-${name.replace(/\s/g, '-')}`)
      await writeFile(archivePath, archive)
      await mkdir(target)
      if (name === 'valid') {
        const result = await extractModuleArchive(archivePath, target, limits)
        assert.equal(result.files, 2)
        assert.equal(await readFile(join(target, 'ok.bin'), 'utf8'), 'ok')
      } else {
        await assert.rejects(() => extractModuleArchive(archivePath, target, limits), expected, name)
        assert.equal(existsSync(join(dir, 'ok.bin')), false, `${name} wrote outside its destination`)
      }
    }
    // A tampered runtime manifest is rejected even if its inventory is consistent.
    const forged = Buffer.from(JSON.stringify({ files: [{ path: 'ok.bin', size: 2, sha256: sha('no') }] }))
    const forgedPath = join(dir, 'forged.tar.zst')
    await writeFile(forgedPath, rawTar([{ name: 'runtime-manifest.json', body: forged }, { name: 'ok.bin', body: Buffer.from('no') }]))
    await mkdir(join(dir, 'out-forged'))
    await assert.rejects(() => extractModuleArchive(forgedPath, join(dir, 'out-forged'), { ...limits, runtimeManifestSize: forged.length }), /signed digest/)
    // Decompression output is bounded by the signed sizes.
    const bombPath = join(dir, 'bomb.tar.zst')
    await writeFile(bombPath, zstdCompressSync(Buffer.alloc(64 * 1024 * 1024)))
    await mkdir(join(dir, 'out-bomb'))
    await assert.rejects(() => extractModuleArchive(bombPath, join(dir, 'out-bomb'), limits), /empty|end marker|expands beyond/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verified module installs atomically, persists, and launches only from verified files', async () => {
  const dir = await workspace()
  const signer = keys()
  const fixture = await runtimeFixture('1.0.0', dir)
  const server = await releaseServer(fixture.archive)
  try {
    server.manifest = signedManifest(signer, fixture, server.url)
    const root = join(dir, 'modules')
    const first = manager(root, server, [signer.trusted])
    const seen: AvidaeModuleStatus['state'][] = []
    first.onChange((status) => { if (seen.at(-1) !== status.state) seen.push(status.state) })
    const checked = await first.refresh({ checkRelease: true })
    assert.equal(checked.state, 'not-installed')
    assert.equal(checked.downloadSize, fixture.archive.length)
    assert.equal(server.requests.filter((item) => item.path === '/module.tar.zst').length, 0, 'checking availability must not download the archive')
    await assert.rejects(() => first.activeRuntime(), /not installed/)

    const installed = await first.install()
    assert.equal(installed.state, 'ready', installed.error)
    assert.deepEqual(seen.filter((state) => state !== 'checking').slice(-4), ['downloading', 'verifying', 'installing', 'ready'])
    const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))
    assert.equal(active.moduleVersion, '1.0.0')
    assert.equal(active.keyId, 'test-key')
    assert.deepEqual((await readdir(root)).filter((name) => !name.startsWith('.')).sort(), ['1.0.0-' + sha(fixture.archive).slice(0, 12), 'active.json', 'trust.json'].sort())
    assert.deepEqual(await readdir(join(root, '.downloads')), [])

    // A new process sees the installation without downloading again.
    const restarted = manager(root, server, [signer.trusted])
    assert.equal((await restarted.refresh()).state, 'ready')
    const runtime = await restarted.activeRuntime()
    const verified = await verifyAvidaeRuntime(runtime.root, runtime)
    assert.match(verified.executable, /VastVideoAudio\.exe$/)
    const requestsBefore = server.requests.length
    assert.equal((await restarted.install()).state, 'ready')
    assert.equal(server.requests.slice(requestsBefore).filter((item) => item.path === '/module.tar.zst').length, 0)

    // Damaged files are caught before launch and require repair.
    await writeFile(join(runtime.root, 'media', 'ffmpeg.exe'), 'FFMPEG')
    await assert.rejects(() => verifyAvidaeRuntime(runtime.root, runtime), /integrity/)
    await rm(join(runtime.root, 'licenses', 'FFmpeg-README.txt'))
    await assert.rejects(() => verifyAvidaeRuntime(runtime.root, runtime), /missing or changed/)
    await rm(join(runtime.root, 'runtime-manifest.json'))
    assert.equal((await restarted.refresh()).state, 'repair-required')
    assert.equal((await restarted.install()).state, 'ready')
    await verifyAvidaeRuntime((await restarted.activeRuntime()).root, runtime)
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('interrupted downloads resume with a validated range and fall back when ranges are ignored', async () => {
  const dir = await workspace()
  const signer = keys()
  const fixture = await runtimeFixture('1.0.0', dir, { 'filler.bin': randomBytes(2_000_000) })
  const server = await releaseServer(fixture.archive)
  try {
    server.manifest = signedManifest(signer, fixture, server.url)
    server.dropArchiveResponses = 1
    const result = await manager(join(dir, 'a'), server, [signer.trusted]).install()
    assert.equal(result.state, 'ready', result.error)
    const archiveRequests = server.requests.filter((item) => item.path === '/module.tar.zst')
    assert.equal(archiveRequests.length, 2)
    assert.match(archiveRequests[1].range ?? '', /^bytes=\d+-$/)

    server.requests.length = 0
    server.dropArchiveResponses = 1
    server.ignoreRange = true
    const restarted = await manager(join(dir, 'b'), server, [signer.trusted]).install()
    assert.equal(restarted.state, 'ready', restarted.error)
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('installation failures are typed, leave nothing ready and never install unverified bytes', async () => {
  const dir = await workspace()
  const signer = keys()
  const fixture = await runtimeFixture('1.0.0', dir)
  const server = await releaseServer(fixture.archive)
  try {
    const root = (name: string): string => join(dir, name)
    // Release not published.
    const missing = await manager(root('missing'), server, [signer.trusted]).install()
    assert.equal(missing.state, 'failed')
    assert.equal(missing.errorCode, 'not-published')
    // Status refreshes keep showing the failure until the user retries.
    const missingManager = manager(root('missing-2'), server, [signer.trusted])
    await missingManager.install()
    const refreshed = await missingManager.refresh({ checkRelease: true })
    assert.equal(refreshed.state, 'failed')
    assert.equal(refreshed.errorCode, 'not-published')
    // Offline.
    server.manifest = signedManifest(signer, fixture, server.url)
    const offline = await manager(root('offline'), server, [signer.trusted], { isOnline: () => false }).install()
    assert.equal(offline.errorCode, 'offline')
    // Signed by a key Vast does not trust.
    const untrusted = await manager(root('untrusted'), server, [keys('other-key').trusted]).install()
    assert.equal(untrusted.errorCode, 'signature')
    // Missing signature.
    const unsigned = JSON.parse(server.manifest)
    delete unsigned.signature
    server.manifest = JSON.stringify(unsigned)
    assert.equal((await manager(root('unsigned'), server, [signer.trusted]).install()).errorCode, 'signature')
    // Corrupted archive bytes with a valid signature over the real digest.
    server.manifest = signedManifest(signer, fixture, server.url)
    const corrupt = Buffer.from(fixture.archive)
    corrupt[corrupt.length - 20] ^= 0xff
    server.archive = corrupt
    const corrupted = await manager(root('corrupt'), server, [signer.trusted]).install()
    assert.equal(corrupted.errorCode, 'integrity')
    assert.equal(existsSync(join(root('corrupt'), 'active.json')), false)
    assert.deepEqual(await readdir(join(root('corrupt'), '.downloads')), [])
    server.archive = fixture.archive
    // Wrong signed size.
    server.manifest = signedManifest(signer, fixture, server.url, { archive: { ...JSON.parse(signedManifest(signer, fixture, server.url)).payload.archive, size: fixture.archive.length - 1 } })
    assert.equal((await manager(root('size'), server, [signer.trusted]).install()).errorCode, 'integrity')
    // Not enough disk space.
    server.manifest = signedManifest(signer, fixture, server.url)
    const full = await manager(root('disk'), server, [signer.trusted], { freeBytes: async () => 1024 }).install()
    assert.equal(full.errorCode, 'disk-space')
    // Incompatible host.
    server.manifest = signedManifest(signer, fixture, server.url, { minVastVersion: '9.0.0' })
    assert.equal((await manager(root('incompatible'), server, [signer.trusted]).install()).errorCode, 'incompatible')
    // Build that must never download.
    const store = await manager(root('store'), server, [signer.trusted], { unavailableReason: 'Not in this edition.' }).refresh({ checkRelease: true })
    assert.equal(store.state, 'unavailable')
    assert.equal(server.requests.some((item) => item.path === '/module.tar.zst' && false), false)
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancel discards partial work and concurrent installers are serialized', async () => {
  const dir = await workspace()
  const signer = keys()
  const fixture = await runtimeFixture('1.0.0', dir, { 'filler.bin': randomBytes(3_000_000) })
  const server = await releaseServer(fixture.archive)
  try {
    server.manifest = signedManifest(signer, fixture, server.url)
    const root = join(dir, 'modules')
    // Slow the archive stream so the cancel lands mid-download.
    const slowFetch: AvidaeModuleEnvironment['fetch'] = async (input, init) => {
      const response = await fetch(input, init)
      if (!String(input).endsWith('.tar.zst') || !response.body) return response
      const reader = response.body.getReader()
      const slow = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel: (reason) => reader.cancel(reason)
      })
      return new Response(slow, { status: response.status, headers: response.headers })
    }
    const first = manager(root, server, [signer.trusted], { fetch: slowFetch })
    const second = manager(root, server, [signer.trusted])
    const pending = first.install()
    await new Promise<void>((resolve) => {
      const stop = first.onChange((status) => {
        if (status.state === 'downloading') { stop(); resolve() }
      })
    })
    const blocked = await second.install()
    assert.equal(blocked.errorCode, 'busy')
    // The same manager coalesces repeated clicks into one installation.
    assert.equal(first.install(), first.install())
    first.cancel()
    const cancelled = await pending
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(existsSync(join(root, 'active.json')), false)
    assert.equal(existsSync(join(root, '.install.lock')), false)
    assert.deepEqual(await readdir(join(root, '.downloads')), [])
    // After the lock is released another window can install.
    assert.equal((await second.install()).state, 'ready')
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stale locks and interrupted extractions are recovered without reporting a partial install', async () => {
  const dir = await workspace()
  const signer = keys()
  const fixture = await runtimeFixture('1.0.0', dir)
  const server = await releaseServer(fixture.archive)
  try {
    server.manifest = signedManifest(signer, fixture, server.url)
    const root = join(dir, 'modules')
    await mkdir(join(root, '.staging', 'abandoned', 'payload'), { recursive: true })
    await writeFile(join(root, '.staging', 'abandoned', 'payload', 'half.bin'), 'x')
    // Promoted directory from a crash between rename and active.json.
    await mkdir(join(root, '0.9.0-aaaaaaaaaaaa'))
    await writeFile(join(root, '.install.lock'), JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }))
    const recovering = manager(root, server, [signer.trusted])
    assert.equal((await recovering.refresh()).state, 'not-installed')
    assert.equal((await recovering.install()).state, 'ready')
    assert.equal(existsSync(join(root, '.staging')), false)
    assert.equal(existsSync(join(root, '0.9.0-aaaaaaaaaaaa')), false)
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('updates are transactional, keep the last known good version and reject replayed manifests', async () => {
  const dir = await workspace()
  const signer = keys()
  const v1 = await runtimeFixture('1.0.0', dir)
  const v2 = await runtimeFixture('1.1.0', dir)
  const server = await releaseServer(v1.archive)
  try {
    const root = join(dir, 'modules')
    server.manifest = signedManifest(signer, v1, server.url)
    assert.equal((await manager(root, server, [signer.trusted]).install()).state, 'ready')
    const v1Dir = `1.0.0-${sha(v1.archive).slice(0, 12)}`

    // A failed update keeps 1.0.0 usable.
    const v2Manifest = signedManifest(signer, v2, server.url, { moduleVersion: '1.1.0', sequence: 2 })
    server.manifest = v2Manifest
    server.archive = Buffer.from(v2.archive)
    server.archive[100] ^= 0xff
    const failedUpdate = manager(root, server, [signer.trusted])
    const refreshed = await failedUpdate.refresh({ checkRelease: true })
    assert.equal(refreshed.state, 'ready')
    assert.equal(refreshed.updateAvailable, true)
    const failed = await failedUpdate.install()
    assert.equal(failed.state, 'ready')
    assert.equal(failed.errorCode, 'integrity')
    assert.equal((await failedUpdate.activeRuntime()).moduleVersion, '1.0.0')

    server.archive = v2.archive
    const updated = await manager(root, server, [signer.trusted]).install()
    assert.equal(updated.state, 'ready', updated.error)
    assert.equal(updated.installedVersion, '1.1.0')
    const active = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))
    assert.equal(active.previousDirectory, v1Dir)
    assert.ok(existsSync(join(root, v1Dir)), 'last known good version is retained')

    // An attacker replaying the older signed manifest cannot roll back.
    server.manifest = signedManifest(signer, v1, server.url)
    server.archive = v1.archive
    const replay = await manager(root, server, [signer.trusted]).install()
    assert.equal(replay.state, 'ready')
    assert.equal(replay.errorCode, 'signature')
    assert.equal(replay.installedVersion, '1.1.0')

    // A revoked installed version must be replaced before it runs again.
    const revoked = manager(root, server, [signer.trusted], { revokedModuleVersions: ['1.1.0'] })
    assert.equal((await revoked.refresh()).state, 'update-required')
    await assert.rejects(() => revoked.activeRuntime(), /not installed/)
    assert.ok((await stat(join(root, 'trust.json'))).isFile())
  } finally {
    server.server.closeAllConnections()
    server.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
