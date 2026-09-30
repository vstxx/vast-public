import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { discoverImportSources, runBrowserImport } from '../../src/main/browser-import.ts'
import type { BrowserImportSourceId } from '../../src/shared/browser-import.ts'

const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000 // microseconds between 1601 and 1970

interface TestContext {
  root: string
  localAppData: string
  roamingAppData: string
  previousLocal: string | undefined
  previousRoaming: string | undefined
}

async function writeChromiumFixture(
  ctx: TestContext,
  browserDir: 'Google/Chrome' | 'Microsoft/Edge',
  profileId: string,
  profileName: string,
  options: { withExtensions?: boolean } = {}
): Promise<string> {
  const userData = join(ctx.localAppData, browserDir, 'User Data')
  const profileDir = join(userData, profileId)
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(userData, 'Local State'), JSON.stringify({
    profile: { info_cache: { [profileId]: { name: profileName } } }
  }), 'utf8')
  await writeFile(join(profileDir, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: {
        children: [
          { id: '10', type: 'url', name: 'Vast Docs', url: 'https://docs.vastbrowser.com/' },
          {
            id: '11',
            type: 'folder',
            name: 'Dev',
            children: [
              { id: '12', type: 'url', name: 'GitHub', url: 'https://github.com/' },
              { id: '13', type: 'url', name: 'Duplicate', url: 'https://github.com/' }
            ]
          },
          { id: '14', type: 'url', name: 'Bad scheme', url: 'javascript:void 0' },
          { id: '15', type: 'folder', name: 'Dev', children: [{ id: '16', type: 'url', name: 'Nested Dev', url: 'https://gitlab.com/' }] }
        ]
      },
      other: { children: [{ id: '17', type: 'url', name: 'Other Bookmarks', url: 'https://example.org/' }] },
      synced: {}
    }
  }), 'utf8')

  const dbPath = join(profileDir, 'History')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)')
  const insert = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)')
  const now = Date.now()
  insert.run('https://example.com/', 'Example', 4, (now - 1_000) * 1_000 + CHROME_EPOCH_OFFSET_US, 0)
  insert.run('https://news.ycombinator.com/', 'Hacker News', 12, (now - 2_000) * 1_000 + CHROME_EPOCH_OFFSET_US, 0)
  insert.run('chrome://settings/', 'Settings', 9, now * 1_000 + CHROME_EPOCH_OFFSET_US, 0)
  insert.run('https://hidden.example/', 'Hidden', 1, now * 1_000 + CHROME_EPOCH_OFFSET_US, 1)
  db.close()

  if (options.withExtensions) {
    const extensionId = 'a'.repeat(32)
    const extensionsDir = join(profileDir, 'Extensions', extensionId, '1.2.0_0')
    await mkdir(extensionsDir, { recursive: true })
    await writeFile(join(extensionsDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Nice Extension',
      version: '1.2.0',
      default_locale: 'en'
    }), 'utf8')
    await writeFile(join(profileDir, 'Preferences'), JSON.stringify({
      extensions: { settings: { [extensionId]: { state: 1, manifest: { version: '1.2.0' } } } }
    }), 'utf8')
  }
  return profileDir
}

async function writeFirefoxFixture(ctx: TestContext, profileId: string): Promise<string> {
  const profileDir = join(ctx.roamingAppData, 'Mozilla', 'Firefox', 'Profiles', profileId)
  await mkdir(profileDir, { recursive: true })
  const db = new DatabaseSync(join(profileDir, 'places.sqlite'))
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0, visit_count INTEGER DEFAULT 0, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, title TEXT, fk INTEGER, parent INTEGER);
    CREATE TABLE moz_bookmarks_roots (root_name TEXT, folder_id INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
  `)
  const now = Date.now()
  const insertPlace = db.prepare('INSERT INTO moz_places (url, title, hidden, visit_count, last_visit_date) VALUES (?, ?, ?, ?, ?)')
  insertPlace.run('https://mozilla.org/', 'Mozilla', 0, 3, (now - 5_000) * 1_000)
  insertPlace.run('https://example.net/', 'Net Example', 0, 1, (now - 6_000) * 1_000)
  const insertBookmark = db.prepare('INSERT INTO moz_bookmarks (type, title, fk, parent) VALUES (?, ?, ?, ?)')
  const toolbarRoot = insertBookmark.run(2, 'toolbar', null, 0)
  db.prepare('INSERT INTO moz_bookmarks_roots VALUES (?, ?)').run('toolbar', Number(toolbarRoot.lastInsertRowid))
  const devFolder = insertBookmark.run(2, 'Firefox Dev', null, Number(toolbarRoot.lastInsertRowid))
  const mozillaPlaceId = (db.prepare('SELECT id FROM moz_places WHERE url = ?').get('https://mozilla.org/') as { id: number }).id
  insertBookmark.run(1, 'Mozilla', mozillaPlaceId, Number(devFolder.lastInsertRowid))
  const netPlaceId = (db.prepare('SELECT id FROM moz_places WHERE url = ?').get('https://example.net/') as { id: number }).id
  insertBookmark.run(1, 'Net Example', netPlaceId, Number(toolbarRoot.lastInsertRowid))
  db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)').run(mozillaPlaceId, (now - 5_000) * 1_000)
  db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)').run(netPlaceId, (now - 6_000) * 1_000)
  db.close()
  return profileDir
}

let currentContext: TestContext | null = null

test.beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'vast-browser-import-test-'))
  const context: TestContext = {
    root,
    localAppData: join(root, 'LocalAppData'),
    roamingAppData: join(root, 'RoamingAppData'),
    previousLocal: process.env.LOCALAPPDATA,
    previousRoaming: process.env.APPDATA
  }
  await mkdir(context.localAppData, { recursive: true })
  await mkdir(context.roamingAppData, { recursive: true })
  process.env.LOCALAPPDATA = context.localAppData
  process.env.APPDATA = context.roamingAppData
  currentContext = context
})

test.afterEach(async () => {
  const context = currentContext
  currentContext = null
  if (!context) return
  if (context.previousLocal === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = context.previousLocal
  if (context.previousRoaming === undefined) delete process.env.APPDATA
  else process.env.APPDATA = context.previousRoaming
  await rm(context.root, { recursive: true, force: true })
})

function ctx(): TestContext {
  if (!currentContext) throw new Error('Test context missing')
  return currentContext
}

test('discovers installed Chromium and Firefox profiles with human names', async () => {
  await writeChromiumFixture(ctx(), 'Google/Chrome', 'Default', 'Personal')
  await writeFirefoxFixture(ctx(), 'abcd1234.default-release')

  const catalog = await discoverImportSources()
  const chrome = catalog.sources.find((source) => source.id === 'chrome')
  const edge = catalog.sources.find((source) => source.id === 'edge')
  const firefox = catalog.sources.find((source) => source.id === 'firefox')

  assert.equal(chrome?.available, true)
  assert.deepEqual(chrome?.profiles, [{ id: 'Default', name: 'Personal' }])
  assert.equal(edge?.available, false)
  assert.deepEqual(edge?.profiles, [])
  assert.equal(firefox?.available, true)
  assert.deepEqual(firefox?.profiles, [{ id: 'abcd1234.default-release', name: 'abcd1234.default-release' }])
})

test('discovers nothing when no browsers are installed', async () => {
  const catalog = await discoverImportSources()
  for (const source of catalog.sources) {
    assert.equal(source.available, false)
    assert.deepEqual(source.profiles, [])
  }
})

test('imports Chromium bookmarks with folder structure and normalized urls', async () => {
  await writeChromiumFixture(ctx(), 'Google/Chrome', 'Default', 'Personal')
  const result = await runBrowserImport({ sourceId: 'chrome', profileId: 'Default', types: ['bookmarks'] })

  assert.equal(result.ok, true)
  assert.equal(result.categories.bookmarks.status, 'imported')
  const urls = result.bookmarks.map((bookmark) => bookmark.url)
  assert.ok(urls.includes('https://docs.vastbrowser.com/'))
  assert.ok(urls.includes('https://github.com/'))
  assert.ok(urls.includes('https://gitlab.com/'))
  assert.ok(urls.includes('https://example.org/'))
  assert.equal(urls.filter((url) => url === 'https://github.com/').length, 2, 'distinct bookmark items retain the same URL')
  assert.equal(urls.includes('javascript:void 0'), false, 'non-http schemes are dropped')

  const github = result.bookmarks.find((bookmark) => bookmark.url === 'https://github.com/')
  assert.deepEqual(github?.folderPath, ['Dev'])
  const nested = result.bookmarks.find((bookmark) => bookmark.url === 'https://gitlab.com/')
  assert.equal(nested?.folderPath[0], 'Dev')
  assert.notEqual(nested?.folderSourceIds[0], github?.folderSourceIds[0], 'same-named folders keep separate source identity')
  const topLevel = result.bookmarks.find((bookmark) => bookmark.url === 'https://docs.vastbrowser.com/')
  assert.deepEqual(topLevel?.folderPath, [], 'bookmarks-bar roots land at top level')
})

test('imports Chromium history through an online snapshot and never mutates the source profile', async () => {
  const profileDir = await writeChromiumFixture(ctx(), 'Google/Chrome', 'Default', 'Personal')
  const historyPath = join(profileDir, 'History')
  const before = await readFile(historyPath)
  const tmpBefore = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith('vast-import-')))

  const result = await runBrowserImport({ sourceId: 'chrome', profileId: 'Default', types: ['history'] })

  assert.deepEqual(before, await readFile(historyPath), 'the source History database is byte-identical after import')
  const tmpAfter = (await readdir(tmpdir())).filter((entry) => entry.startsWith('vast-import-') && !tmpBefore.has(entry))
  assert.deepEqual(tmpAfter, [], 'temporary snapshot directories are cleaned up')
  assert.equal(result.ok, true)
  assert.equal(result.categories.history.status, 'imported')
  assert.equal(result.history.length, 2, 'chrome:// and hidden rows are excluded')
  const example = result.history.find((entry) => entry.url === 'https://example.com/')
  assert.equal(example?.visitCount, 4)
  assert.ok(example && example.lastVisitedAt > 1_600_000_000_000, 'chrome timestamps convert to epoch ms')
})

test('detects Chromium extensions including plain manifest names', async () => {
  await writeChromiumFixture(ctx(), 'Microsoft/Edge', 'Profile 1', 'Work', { withExtensions: true })
  const result = await runBrowserImport({ sourceId: 'edge', profileId: 'Profile 1', types: ['extensions'] })

  assert.equal(result.ok, true)
  assert.equal(result.extensions.length, 1)
  assert.equal(result.extensions[0]?.name, 'Nice Extension')
  assert.equal(result.extensions[0]?.version, '1.2.0')
  assert.equal(result.extensions[0]?.sourceEnabled, true)
  assert.equal(result.extensions[0]?.manifestVersion, 3)
})

test('empty extension detection is reported honestly', async () => {
  await writeChromiumFixture(ctx(), 'Google/Chrome', 'Default', 'Personal')
  const result = await runBrowserImport({ sourceId: 'chrome', profileId: 'Default', types: ['extensions'] })

  assert.equal(result.ok, true)
  assert.deepEqual(result.extensions, [])
  assert.equal(result.categories.extensions.status, 'empty')
  assert.ok(result.categories.extensions.message)
})

test('imports Firefox bookmarks and history in native places.sqlite format', async () => {
  await writeFirefoxFixture(ctx(), 'abcd1234.default-release')
  const result = await runBrowserImport({ sourceId: 'firefox', profileId: 'abcd1234.default-release', types: ['bookmarks', 'history'] })

  assert.equal(result.ok, true)
  const mozilla = result.bookmarks.find((bookmark) => bookmark.url === 'https://mozilla.org/')
  assert.deepEqual(mozilla?.folderPath, ['Firefox Dev'], 'folder chains exclude the browser root folder')
  const net = result.bookmarks.find((bookmark) => bookmark.url === 'https://example.net/')
  assert.deepEqual(net?.folderPath, [], 'direct root children land at top level')
  assert.equal(result.history.length, 2)
  assert.equal(result.history[0]?.url, 'https://mozilla.org/', 'history is ordered by recency')
})

test('Firefox extension detection is honestly unavailable instead of faked', async () => {
  await writeFirefoxFixture(ctx(), 'abcd1234.default-release')
  const result = await runBrowserImport({ sourceId: 'firefox', profileId: 'abcd1234.default-release', types: ['extensions'] })

  assert.equal(result.ok, true)
  assert.deepEqual(result.extensions, [])
  assert.equal(result.categories.extensions.status, 'unavailable')
  assert.ok(result.categories.extensions.message)
})

test('import refuses unknown sources, empty profiles, and path traversal', async () => {
  const attacks: Array<{ sourceId: BrowserImportSourceId; profileId: string; types: Array<'bookmarks'> }> = [
    { sourceId: 'chrome', profileId: '../../etc', types: ['bookmarks'] },
    { sourceId: 'chrome', profileId: '', types: ['bookmarks'] },
    { sourceId: 'opera' as BrowserImportSourceId, profileId: 'Default', types: ['bookmarks'] }
  ]
  for (const request of attacks) {
    const result = await runBrowserImport(request)
    assert.equal(result.ok, false, `request must be rejected: ${JSON.stringify(request)}`)
    assert.ok(result.error)
    assert.deepEqual(result.bookmarks, [])
    assert.deepEqual(result.history, [])
  }
})

test('import of an absent profile fails safely with empty collections', async () => {
  const result = await runBrowserImport({ sourceId: 'chrome', profileId: 'Missing Profile', types: ['bookmarks', 'history'] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.bookmarks, [])
  assert.deepEqual(result.history, [])
})
