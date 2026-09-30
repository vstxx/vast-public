import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readBrowserSource, resolveBundledImportWorkerPath } from '../../src/main/import/worker-client.ts'
import type { ResolvedImportSource } from '../../src/main/import/profile-discovery.ts'

const workerPath = fileURLToPath(new URL('../../src/main/import/source-worker.ts', import.meta.url))
const hangingWorkerPath = fileURLToPath(new URL('../fixtures/import-hanging-worker.cjs', import.meta.url))

test('bundled import worker resolves both main and code-split chunk layouts', () => {
  const main = join('C:', 'Vast', 'out', 'main')
  const chunk = join(main, 'chunks')
  const expected = join(main, 'browser-import-worker.js')
  assert.equal(resolveBundledImportWorkerPath(main, (path) => path === expected), expected)
  assert.equal(resolveBundledImportWorkerPath(chunk, (path) => path === expected), expected)
  assert.throws(() => resolveBundledImportWorkerPath(chunk, () => false), /missing/i)
})

test('worker reads Firefox bookmarks and WAL history from one source snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  const db = new DatabaseSync(join(profile, 'places.sqlite'))
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER DEFAULT 0);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, title TEXT, fk INTEGER, parent INTEGER);
    CREATE TABLE moz_bookmarks_roots (root_name TEXT, folder_id INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    INSERT INTO moz_places VALUES (1, 'https://example.test/', 'Example', 2, 1700000000000000, 0);
    INSERT INTO moz_bookmarks VALUES (1, 2, 'root', NULL, 0);
    INSERT INTO moz_bookmarks VALUES (2, 1, 'Example', 1, 1);
    INSERT INTO moz_bookmarks_roots VALUES ('toolbar',1);
    INSERT INTO moz_historyvisits VALUES (1,1,1700000000000000);`)
  const source: ResolvedImportSource = { sourceId: 'firefox', profileId: 'opaque-test', canonicalPath: profile }

  const result = await readBrowserSource(source, ['bookmarks', 'history'], new AbortController().signal, {
    workerPath,
    stagingRoot: join(root, 'staging')
  })
  assert.equal(result.categories.bookmarks.status, 'ready')
  assert.equal(result.categories.history.status, 'ready')
  assert.equal(result.bookmarks[0]?.url, 'https://example.test/')
  assert.equal(result.history[0]?.url, 'https://example.test/')
  assert.equal(result.categories.extensions.status, 'empty')
})

test('worker cancellation and timeout terminate an unresponsive reader', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source: ResolvedImportSource = { sourceId: 'chrome', profileId: 'test', canonicalPath: root }
  const stagingRoot = join(root, 'staging')
  const controller = new AbortController()
  const pending = readBrowserSource(source, ['history'], controller.signal, {
    workerPath: hangingWorkerPath,
    timeoutMs: 2000,
    stagingRoot
  })
  let staged = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const files = await readdir(stagingRoot, { recursive: true }).catch(() => [])
    if (files.some((file) => file.endsWith('marker'))) { staged = true; break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(staged, true, 'the worker must actually stage a file before cancellation')
  controller.abort()
  await assert.rejects(pending, /abort|cancel/i)
  assert.deepEqual(await readdir(stagingRoot), [], 'cancellation must remove the private staging directory before settling')
  await assert.rejects(
    readBrowserSource(source, ['history'], new AbortController().signal, {
      workerPath: hangingWorkerPath,
      timeoutMs: 200,
      stagingRoot
    }),
    /timeout|timed out/i
  )
  assert.deepEqual(await readdir(stagingRoot), [], 'timeout must also remove staged files')
})

test('worker reports a failed category instead of partial success for a corrupt SQLite source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'History'), Buffer.alloc(4096, 0x77))
  const source: ResolvedImportSource = { sourceId: 'chrome', profileId: 'test', canonicalPath: root }
  const result = await readBrowserSource(source, ['history'], new AbortController().signal, {
    workerPath,
    stagingRoot: join(root, 'staging')
  })
  assert.equal(result.categories.history.status, 'failed')
  assert.equal(result.categories.history.code, 'SOURCE_READ_FAILED')
  assert.deepEqual(result.history, [])
})

test('worker distinguishes absent Bookmarks from a damaged source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source: ResolvedImportSource = { sourceId: 'chrome', profileId: 'test', canonicalPath: root }
  const result = await readBrowserSource(source, ['bookmarks'], new AbortController().signal, {
    workerPath, stagingRoot: join(root, 'staging')
  })
  assert.equal(result.categories.bookmarks.status, 'unavailable')
  assert.equal(result.categories.bookmarks.code, 'SOURCE_UNAVAILABLE')
  assert.deepEqual(result.bookmarks, [])
})

test('one broken Firefox category does not hide a successful category from the same snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new DatabaseSync(join(root, 'places.sqlite'))
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    INSERT INTO moz_places VALUES (1, 'https://example.test/', 'Example', 1, 1700000000000000, 0);
    INSERT INTO moz_historyvisits VALUES (1,1,1700000000000000);`)
  db.close()
  const source: ResolvedImportSource = { sourceId: 'firefox', profileId: 'test', canonicalPath: root }
  const result = await readBrowserSource(source, ['bookmarks', 'history'], new AbortController().signal, {
    workerPath,
    stagingRoot: join(root, 'staging')
  })
  assert.equal(result.categories.bookmarks.status, 'failed')
  assert.equal(result.categories.history.status, 'ready')
  assert.equal(result.history[0]?.url, 'https://example.test/')
})

test('bundled worker starts from the packaged output path and reads Chromium history', async (t) => {
  const bundledWorker = join(process.cwd(), 'out/main/browser-import-worker.js')
  if (!existsSync(bundledWorker)) {
    if (process.env.VAST_REQUIRE_BUILT_WORKER === '1') assert.fail('Bundled import worker is missing')
    t.skip('build output not present')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'vast-worker-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new DatabaseSync(join(root, 'History'))
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)')
  const when = Date.UTC(2023, 0, 1)
  db.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, ?, ?)').run(1, 'https://example.test/', 'Example', 3, BigInt(when) * 1000n + 11_644_473_600_000_000n, 0)
  db.close()
  const source: ResolvedImportSource = { sourceId: 'chrome', profileId: 'test', canonicalPath: root }
  const result = await readBrowserSource(source, ['history'], new AbortController().signal, {
    workerPath: bundledWorker,
    stagingRoot: join(root, 'staging')
  })
  assert.equal(result.categories.history.status, 'ready')
  assert.equal(result.history[0]?.lastVisitedAt, when)
})
