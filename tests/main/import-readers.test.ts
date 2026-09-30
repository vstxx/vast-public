import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { readChromiumBookmarks, readFirefoxBookmarks } from '../../src/main/import/bookmark-reader.ts'
import { readChromiumHistory, readFirefoxHistory } from '../../src/main/import/history-reader.ts'

test('a missing Chromium Bookmarks file is unavailable, not a generic read failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-reader-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await readChromiumBookmarks(root)
  assert.match(result.error ?? '', /could not be found/i)
  assert.deepEqual(result.items, [])
})

test('Chromium retains root identity, folder IDs and same-URL bookmarks in different folders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-reader-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { children: [
      { id: '11', type: 'folder', name: 'A', children: [{ id: '12', type: 'url', name: 'One', url: 'https://example.test/' }] },
      { id: '41', type: 'folder', name: '', children: [{ id: '42', type: 'url', name: 'Unnamed', url: 'https://unnamed.test/' }] }
    ] },
    other: { children: [{ id: '21', type: 'folder', name: 'A', children: [{ id: '22', type: 'url', name: 'Two', url: 'https://example.test/' }] }] },
    synced: { children: [{ id: '31', type: 'url', name: 'Mobile', url: 'https://m.example.test/' }] }
  } }))
  const result = await readChromiumBookmarks(root)
  assert.equal(result.error, undefined)
  assert.equal(result.items.length, 4)
  assert.deepEqual(result.items.map((item) => [item.root, item.sourceItemId, item.folderPath, item.folderSourceIds]), [
    ['bar', '12', ['A'], ['11']],
    ['bar', '42', ['Untitled folder'], ['41']],
    ['other', '22', ['A'], ['21']],
    ['mobile', '31', [], []]
  ])
})

test('Chromium rejects oversized files and skips excessive folder depth without recursion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-reader-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const deep = { id: 'deep', type: 'url', name: 'Deep', url: 'https://deep.example/' } as Record<string, unknown>
  for (let level = 0; level < 20; level += 1) {
    const next = { id: `f${level}`, type: 'folder', name: `Level ${level}`, children: [structuredClone(deep)] }
    Object.assign(deep, next)
  }
  await writeFile(join(root, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [deep] } } }))
  const result = await readChromiumBookmarks(root)
  assert.equal(result.items.length, 0)
  assert.ok(result.skipped >= 1)

  await writeFile(join(root, 'Bookmarks'), 'x'.repeat(32 * 1024 * 1024 + 1))
  const oversized = await readChromiumBookmarks(root)
  assert.ok(oversized.error)
  assert.deepEqual(oversized.items, [])
})

test('Chromium skips items without stable IDs rather than inventing positional provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vast-reader-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [
    { type: 'url', url: 'https://missing-id.test/' },
    { type: 'folder', name: 'Missing ID', children: [
      { id: '77', type: 'url', url: 'https://nested.test/' },
      { id: '78', type: 'url', url: 'https://nested2.test/' }
    ] }
  ] } } }))
  const result = await readChromiumBookmarks(root)
  assert.deepEqual(result.items, [])
  assert.equal(result.skipped, 3)
})

test('Firefox uses Places root IDs, not a toolbar name, and skips cyclic ancestors', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, title TEXT, fk INTEGER, parent INTEGER);
      CREATE TABLE moz_bookmarks_roots (root_name TEXT, folder_id INTEGER);
      INSERT INTO moz_bookmarks VALUES (1,2,'places',NULL,0),(2,2,'toolbar',NULL,1),(3,2,'menu',NULL,1),(4,2,'Work',NULL,2),(5,1,'A',10,4),(6,1,'B',10,3),(7,2,'Cycle',NULL,7),(8,1,'Bad',10,7);
      INSERT INTO moz_bookmarks_roots VALUES ('toolbar',2),('menu',3);
      INSERT INTO moz_places VALUES (10,'https://example.test/');`)
    const result = readFirefoxBookmarks(db)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items.map((item) => [item.root, item.sourceItemId, item.folderPath, item.folderSourceIds]), [
      ['bar', '5', ['Work'], ['4']],
      ['menu', '6', [], []]
    ])
    assert.ok(result.skipped >= 1)
  } finally { db.close() }
})

test('Firefox folder inventory is capped before unbounded traversal', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, title TEXT, fk INTEGER, parent INTEGER);
      CREATE TABLE moz_bookmarks_roots (root_name TEXT, folder_id INTEGER);
      INSERT INTO moz_bookmarks VALUES (1,2,'toolbar',NULL,0);
      INSERT INTO moz_bookmarks_roots VALUES ('toolbar',1);`)
    const insert = db.prepare('INSERT INTO moz_bookmarks VALUES (?, 2, ?, NULL, 1)')
    db.exec('BEGIN')
    for (let id = 2; id <= 1003; id += 1) insert.run(id, `Folder ${id}`)
    db.exec('COMMIT')
    const result = readFirefoxBookmarks(db)
    assert.ok(result.error?.includes('folder limit'))
    assert.deepEqual(result.items, [])
  } finally { db.close() }
})

test('Firefox history requires actual visits and sorts equal timestamps deterministically', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER, visit_count INTEGER, last_visit_date INTEGER);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
      INSERT INTO moz_places VALUES (1,'https://bookmark-only.test/','Bookmark',0,0,NULL),(2,'https://second.test/','Second',0,5,1700000000000000),(3,'https://third.test/','Third',0,0,NULL);
      INSERT INTO moz_historyvisits VALUES (10,2,1700000000000000),(11,3,1700000000000000);`)
    const result = readFirefoxHistory(db)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.items.map((item) => item.url), ['https://third.test/', 'https://second.test/'])
    assert.deepEqual(result.items.map((item) => item.visitCount), [1, 1])
    assert.deepEqual(result.items.map((item) => item.lastVisitedAt), [1700000000000, 1700000000000])
  } finally { db.close() }
})

test('Chromium history handles invalid times and caps retained rows at 1000', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)')
    const insert = db.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, ?, ?)')
    const base = 11_644_473_600_000_000n + 1_700_000_000_000_000n
    db.exec('BEGIN')
    for (let id = 1; id <= 1002; id += 1) insert.run(id, `https://site${id}.test/`, `Site ${id}`, id, base + BigInt(id) * 1000n, 0)
    insert.run(1003, 'https://null.test/', 'Null', 1, null, 0)
    insert.run(1004, 'https://negative.test/', 'Negative', 1, -1, 0)
    db.exec('COMMIT')
    const result = readChromiumHistory(db)
    assert.equal(result.items.length, 1000)
    assert.equal(result.items[0]?.url, 'https://site1002.test/')
    assert.equal(result.items.at(-1)?.url, 'https://site3.test/')
    assert.equal(result.skipped, 4, 'two invalid timestamps and two older valid entries were not retained')
    assert.ok(!result.items.some((item) => item.lastVisitedAt <= 0))
  } finally { db.close() }
})

test('a normal profile with more than 2000 visits still retains the newest 1000', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)')
    const insert = db.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, ?, 0)')
    const base = 11_644_473_600_000_000n + 1_700_000_000_000_000n
    db.exec('BEGIN')
    for (let id = 1; id <= 2100; id += 1) insert.run(id, `https://site${id}.test/`, '', 1, base + BigInt(id) * 1000n)
    db.exec('COMMIT')
    const result = readChromiumHistory(db)
    assert.equal(result.error, undefined)
    assert.equal(result.items.length, 1000)
    assert.equal(result.items[0]?.url, 'https://site2100.test/')
    assert.equal(result.skipped, 1100)
  } finally { db.close() }
})
