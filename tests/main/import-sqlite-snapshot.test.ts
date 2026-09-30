import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { cleanupStaleSnapshots, withSqliteSnapshot } from '../../src/main/import/sqlite-snapshot.ts'

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

test('online snapshot includes uncheckpointed WAL rows without changing source files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  const source = join(root, 'places.sqlite')
  const stagingRoot = join(root, 'staging')
  const writer = new DatabaseSync(source)
  t.after(async () => {
    writer.close()
    await rm(root, { recursive: true, force: true })
  })
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE visits (url TEXT)')
  writer.prepare('INSERT INTO visits VALUES (?)').run('https://example.test/')
  assert.ok((await stat(`${source}-wal`)).size > 0)
  const dbHash = await digest(source)
  const walHash = await digest(`${source}-wal`)

  const urls = await withSqliteSnapshot(source, (db) => db.prepare('SELECT url FROM visits').all(), { stagingRoot })
  assert.deepEqual(urls.map((row) => row.url), ['https://example.test/'])
  assert.equal(await digest(source), dbHash)
  assert.equal(await digest(`${source}-wal`), walHash)
  assert.deepEqual(await readdir(stagingRoot), [])
})

test('corrupt source fails closed and leaves no snapshot behind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'places.sqlite')
  const stagingRoot = join(root, 'staging')
  await writeFile(source, Buffer.alloc(4096, 0x5a))
  await assert.rejects(withSqliteSnapshot(source, () => true, { stagingRoot }))
  assert.deepEqual(await readdir(stagingRoot), [])
})

test('source file cap rejects before backup and does not mutate source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'History')
  const stagingRoot = join(root, 'staging')
  const writer = new DatabaseSync(source)
  writer.exec('CREATE TABLE visits (url TEXT)')
  writer.close()
  const original = await digest(source)
  await assert.rejects(withSqliteSnapshot(source, () => true, { stagingRoot, maxSourceBytes: 1024 }), /size|large|limit/i)
  assert.equal(await digest(source), original)
  await assert.rejects(readdir(stagingRoot), { code: 'ENOENT' })
})

test('checkpointed WAL database without a sidecar is readable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'History')
  const writer = new DatabaseSync(source)
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE visits (id INTEGER); INSERT INTO visits VALUES (7)')
  writer.close()
  await assert.rejects(stat(`${source}-wal`), { code: 'ENOENT' })
  const count = await withSqliteSnapshot(source, (db) => db.prepare('SELECT count(*) AS n FROM visits').get()?.n, {
    stagingRoot: join(root, 'staging')
  })
  assert.equal(count, 1n)
})

test('malformed WAL sidecar fails closed rather than returning a stale snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'History')
  const writer = new DatabaseSync(source)
  writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE visits (id INTEGER)')
  writer.close()
  await writeFile(`${source}-wal`, Buffer.alloc(64, 0x5a))
  await assert.rejects(withSqliteSnapshot(source, () => true, { stagingRoot: join(root, 'staging') }))
})

test('locked source never exposes an uncommitted row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  const source = join(root, 'History')
  const writer = new DatabaseSync(source)
  t.after(async () => {
    writer.exec('ROLLBACK')
    writer.close()
    await rm(root, { recursive: true, force: true })
  })
  writer.exec('CREATE TABLE visits (id INTEGER); INSERT INTO visits VALUES (1); BEGIN EXCLUSIVE; INSERT INTO visits VALUES (2)')
  try {
    const count = await withSqliteSnapshot(source, (db) => db.prepare('SELECT count(*) AS n FROM visits').get()?.n, {
      stagingRoot: join(root, 'staging')
    })
    assert.equal(count, 1)
  } catch (error) {
    assert.match(String(error), /locked|busy|backup|database/i)
  }
})

test('startup cleanup removes only prior snapshot directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stagingRoot = join(root, 'staging')
  await mkdir(join(stagingRoot, 'snapshot-abandoned'), { recursive: true })
  await writeFile(join(stagingRoot, 'snapshot-abandoned', 'db.sqlite'), 'old')
  await mkdir(join(stagingRoot, 'unrelated'), { recursive: true })
  await cleanupStaleSnapshots(stagingRoot)
  assert.deepEqual(await readdir(stagingRoot), ['unrelated'])
})

test('cleanup refuses a junction or symlink staging root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'target')
  await mkdir(join(target, 'snapshot-keep'), { recursive: true })
  const alias = join(root, 'ImportStaging')
  await symlink(target, alias, 'junction')
  await assert.rejects(cleanupStaleSnapshots(alias), /symlink|junction|staging/i)
  assert.deepEqual(await readdir(target), ['snapshot-keep'])
})

test('DB and WAL are bounded by one aggregate source budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-sqlite-test-'))
  const source = join(root, 'History')
  const writer = new DatabaseSync(source)
  t.after(async () => {
    writer.close()
    await rm(root, { recursive: true, force: true })
  })
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE visits (payload BLOB)')
  writer.prepare('INSERT INTO visits VALUES (?)').run(Buffer.alloc(64 * 1024, 0x31))
  const dbSize = (await stat(source)).size
  const walSize = (await stat(`${source}-wal`)).size
  const limit = Math.max(dbSize, walSize) + 1024
  assert.ok(dbSize < limit && walSize < limit && dbSize + walSize > limit)
  await assert.rejects(withSqliteSnapshot(source, () => true, {
    stagingRoot: join(root, 'staging'), maxSourceBytes: limit
  }), /limit|size/i)
})
