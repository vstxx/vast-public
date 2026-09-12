import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../../src/main/downloads.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const settle = () => new Promise((resolve) => setImmediate(resolve))

function harness(stored: any[] = []) {
  const app = Object.assign(new EventEmitter(), { isPackaged: true })
  const sessions = new Map<string, any>()
  const sent: any[] = []
  const writes: any[] = []
  const timers = new Map<object, () => void>()
  let scan: () => Promise<any> = async () => ({ status: 'clean', threats: [], warnings: [] })
  const owner = { isDestroyed: () => false, webContents: { send: (_channel: string, item: any) => sent.push(structuredClone(item)) } }
  function fromPartition(partition: string) {
    if (!sessions.has(partition)) {
      const target = Object.assign(new EventEmitter(), {
        isPersistent: () => !partition || partition.startsWith('persist:'),
        requests: [] as string[],
        downloadURL(url: string) { this.requests.push(url) }
      })
      sessions.set(partition, target)
      app.emit('session-created', target)
    }
    return sessions.get(partition)
  }
  const electronSession = { fromPartition, get defaultSession() { return fromPartition('') } }
  const exports: any = {}
  runInNewContext(compiled, {
    exports, process: { env: {}, versions: {} }, console, URL, Buffer,
    setTimeout: (fn: () => void) => { const id = {}; timers.set(id, fn); return id },
    clearTimeout: (id: object) => timers.delete(id),
    require: (id: string) => {
      if (id === 'electron/main') return { app, session: electronSession, BrowserWindow: { getAllWindows: () => [owner] }, dialog: {} }
      if (id === 'electron/common') return { shell: {} }
      if (id === '../shared/constants') return { DEFAULT_SETTINGS: { security: { warnDangerousDownloads: false } } }
      if (id === './storage') return {
        loadData: async () => ({ downloads: structuredClone(stored) }),
        upsertDownload: async (item: any) => { writes.push(structuredClone(item)); const index = stored.findIndex((v) => v.id === item.id); if (index >= 0) stored.splice(index, 1); stored.push(structuredClone(item)) },
        clearCompletedDownloads: async () => { stored.splice(0, stored.length, ...stored.filter((v) => !['completed', 'cancelled'].includes(v.state))) }
      }
      if (id === './scanner') return { scanDownloadedFile: () => scan(), alertScanResult: async () => {} }
      if (id === './performance-probe') return { performanceProbeEnabled: () => false, recordDownloadDurableWrite() {}, recordDownloadProgressEvent() {} }
      if (id === './windows/WindowRegistry') return { windowRegistry: { vastWindowForWebContents: () => owner } }
      if (id === './pdf-resources') return { claimPdfDownload: () => false }
      return require(id)
    }
  })
  function start(partition: string, savePath = '') {
    const target = fromPartition(partition)
    const item = Object.assign(new EventEmitter(), {
      bytes: 0, getFilename: () => 'test.bin', getURL: () => 'https://auth.test/download', getMimeType: () => 'application/octet-stream',
      getSavePath: () => savePath, getReceivedBytes() { return this.bytes }, getTotalBytes: () => 100, isPaused: () => false
    })
    target.emit('will-download', { preventDefault() {} }, item)
    return item
  }
  return { api: exports, app, sessions, fromPartition, sent, stored, writes, timers, start, scanWith: (fn: typeof scan) => { scan = fn } }
}

test('startup installs downloads before ExtensionManager pre-creates isolated sessions and before windows exist', () => {
  const h = harness()
  h.api.initializeDownloads(() => ({ security: { warnDangerousDownloads: false } }))
  // Exact 0.2.7 ordering: extension initialization creates the partition before window setup.
  const preCreated = h.fromPartition('persist:vast-workspace-one')
  assert.equal(preCreated.listenerCount('will-download'), 1)
  h.api.configureDownloadsForSession(preCreated, 'persist:vast-workspace-one')
  h.api.configureDownloadsForSession(preCreated) // did-attach-webview safety net, repeated
  assert.equal(preCreated.listenerCount('will-download'), 1)
  h.start('persist:vast-workspace-one')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].state, 'progressing')
  assert.equal(h.sent[0].sourcePartition, 'persist:vast-workspace-one')
  const main = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
  assert.match(main, /app\.whenReady\(\)\.then\(async \(\) => \{\s*initializeDownloads/)
  assert.ok(main.indexOf('initializeDownloads(()') < main.indexOf('new ExtensionManager'))
})

test('attachment repairs even a session created before service initialization without duplicate events', () => {
  const h = harness()
  const preCreated = h.fromPartition('persist:old')
  h.api.initializeDownloads()
  assert.equal(preCreated.listenerCount('will-download'), 0)
  h.api.configureDownloadsForSession(preCreated, 'persist:old')
  h.api.configureDownloadsForSession(preCreated)
  h.start('persist:old')
  assert.equal(h.sent.length, 1)
})

test('default, shared, isolated and ephemeral sessions all receive listeners', () => {
  const h = harness(); h.api.initializeDownloads()
  for (const partition of ['', 'persist:vast-default', 'persist:vast-workspace-one', 'vast-workspace-private']) {
    assert.equal(h.fromPartition(partition).listenerCount('will-download'), 1)
  }
})

test('start and terminal state persist immediately; live progress only schedules one checkpoint', async () => {
  const h = harness(); h.api.initializeDownloads()
  const item = h.start('persist:one')
  await settle()
  assert.equal(h.writes.length, 1)
  for (let index = 1; index < 100; index++) { item.bytes = index; item.emit('updated', {}, 'progressing') }
  assert.equal(h.writes.length, 1)
  assert.equal(h.timers.size, 1)
  item.emit('done', {}, 'completed'); await settle()
  assert.equal(h.writes.at(-1).state, 'completed')
  assert.equal(h.timers.size, 0)
})

test('completion survives a stalled security scan and scan result is a subsequent update', async () => {
  const h = harness(); h.api.initializeDownloads()
  let finish!: (value: any) => void
  h.scanWith(() => new Promise((resolve) => { finish = resolve }))
  const item = h.start('persist:one', fileURLToPath(new URL('../../package.json', import.meta.url)))
  item.emit('done', {}, 'completed')
  for (let i = 0; i < 30 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.stored.at(-1).state, 'completed')
  assert.equal(h.stored.at(-1).scanStatus, 'scanning')
  assert.ok(finish)
  finish({ status: 'clean', threats: [], warnings: [] }); await settle()
  assert.equal(h.stored.at(-1).scanStatus, 'clean')
  assert.equal(h.stored.at(-1).scannedSha256.length, 64)
})

test('snapshot recovers concurrent live progress after renderer reload; restart marks abandoned transfers interrupted', async () => {
  const h = harness(); h.api.initializeDownloads()
  for (let i = 0; i < 5; i++) { const item = h.start('persist:one'); item.bytes = 30 + i; item.emit('updated', {}, 'progressing') }
  const snapshot = await h.api.listCurrentDownloads()
  assert.equal(snapshot.length, 5)
  assert.ok(snapshot.every((v: any) => v.receivedBytes >= 30 && v.state === 'progressing'))
  const restarted = harness(h.stored)
  assert.ok((await restarted.api.listCurrentDownloads()).every((v: any) => v.state === 'interrupted'))
})

test('private progress, completion and retry remain in memory only', async () => {
  const h = harness(); h.api.initializeDownloads()
  const item = h.start('vast-private'); item.emit('done', {}, 'cancelled'); await settle()
  const snapshot = await h.api.listCurrentDownloads()
  await h.api.retryDownload(snapshot[0].id)
  assert.equal(h.fromPartition('vast-private').requests.length, 1)
  assert.equal(h.writes.length, 0)
  assert.equal(h.stored.length, 0)
})

test('retry after restart uses the recorded partition; legacy history never silently switches identity', async () => {
  const stored = [{ id: 'one', url: 'https://auth.test/file', state: 'interrupted', sourcePartition: 'persist:isolated' }, { id: 'legacy', url: 'https://auth.test/file', state: 'cancelled' }]
  const h = harness(stored); h.api.initializeDownloads()
  await h.api.retryDownload('one')
  assert.equal(h.fromPartition('persist:isolated').requests.length, 1)
  assert.equal(h.fromPartition('').requests.length, 0)
  await assert.rejects(h.api.retryDownload('legacy'), /original session is unknown/)
})
