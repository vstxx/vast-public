// Controlled Electron E2E with a live, uncheckpointed Firefox Places WAL.
// The source and destination are both unique temporary profiles.
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { connectRenderer, waitFor } = require('./performance-suite.cjs')

const project = path.resolve(__dirname, '..')
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
const executable = dist && path.join(dist, 'electron.exe')
if (!executable || !fs.existsSync(executable)) throw new Error('Set VAST_PATCHED_ELECTRON_DIST to the patched Electron binary')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-import-firefox-e2e-'))
const userData = path.join(root, 'Vast')
const roaming = path.join(root, 'Roaming')
const firefoxRoot = path.join(roaming, 'Mozilla', 'Firefox')
const profile = path.join(firefoxRoot, 'Profiles', 'controlled.default-release')
const places = path.join(profile, 'places.sqlite')
const port = 12500 + Math.floor(Math.random() * 500)
let writer
let child
let cdp
let phase = 'fixture'

function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }

function fixture() {
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
    '[Profile0]\nName=Controlled Firefox\nIsRelative=1\nPath=Profiles/controlled.default-release\nDefault=1\n')
  writer = new DatabaseSync(places)
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER DEFAULT 0);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, title TEXT, fk INTEGER, parent INTEGER);
    CREATE TABLE moz_bookmarks_roots (root_name TEXT, folder_id INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    INSERT INTO moz_places VALUES (1, 'https://controlled.example/', 'Visited', 1, 1700000000000000, 0);
    INSERT INTO moz_places VALUES (2, 'https://bookmark-only.example/', 'Bookmark only', 0, NULL, 0);
    INSERT INTO moz_bookmarks VALUES (1, 2, 'root', NULL, 0);
    INSERT INTO moz_bookmarks VALUES (2, 2, 'toolbar', NULL, 1);
    INSERT INTO moz_bookmarks VALUES (3, 2, 'folder', NULL, 2);
    INSERT INTO moz_bookmarks VALUES (4, 1, 'Visited', 1, 3);
    INSERT INTO moz_bookmarks VALUES (5, 1, 'Bookmark only', 2, 2);
    INSERT INTO moz_bookmarks_roots VALUES ('toolbar', 2);
    INSERT INTO moz_historyvisits VALUES (1, 1, 1700000000000000);`)
  assert.ok(fs.statSync(`${places}-wal`).size > 0, 'fixture must retain an uncheckpointed WAL')
}

async function launch() {
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userData, APPDATA: roaming,
    LOCALAPPDATA: path.join(root, 'Local'), VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1',
    VAST_UPDATE_ENABLED: '0', VAST_EXTENSION_COMPATIBILITY: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, project],
    { cwd: project, env, windowsHide: true, stdio: 'ignore' })
  cdp = await connectRenderer(port)
  await waitFor(cdp, 'Boolean(window.vast?.importer?.prepare)', 30_000)
}

async function close() {
  const process = child
  const session = cdp
  const response = await session.evaluate('window.vast.app.window.close()')
  assert.equal(response.ok, true)
  const exited = process.exitCode !== null || process.signalCode !== null || await new Promise((resolve) => {
    const timer = setTimeout(() => { process.removeListener('exit', onExit); resolve(false) }, 15_000)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    process.once('exit', onExit)
  })
  session.close()
  assert.equal(exited, true, 'Vast did not close cleanly')
  child = undefined
  cdp = undefined
}

async function main() {
  let originalError
  let passed = false
  try {
    fixture()
    const sourceBefore = { db: sha256(places), wal: sha256(`${places}-wal`) }
    phase = 'first launch'
    await launch()
    phase = 'discovery'
    const catalog = await cdp.evaluate('window.vast.importer.discover()')
    const profileId = catalog.sources.find((source) => source.id === 'firefox')?.profiles[0]?.id
    assert.equal(typeof profileId, 'string', 'controlled Firefox profile not discovered')
    phase = 'prepare'
    const preview = await cdp.evaluate(`window.vast.importer.prepare(${JSON.stringify({
      sourceId: 'firefox', profileId, types: ['bookmarks', 'history'] })})`)
    assert.equal(preview.categories.bookmarks.status, 'ready')
    assert.equal(preview.categories.history.status, 'ready')
    assert.equal(preview.detected.bookmarks, 2)
    assert.equal(preview.detected.history, 1, 'bookmark-only Places row must not become history')
    const before = await cdp.evaluate('window.vast.storage.load().then(data => ({bookmarks:data.bookmarks.length,history:data.history.length}))')
    assert.deepEqual(before, { bookmarks: 0, history: 0 }, 'Prepare must not persist source data')
    phase = 'commit'
    const receipt = await cdp.evaluate(`window.vast.importer.commit(${JSON.stringify({
      token: preview.token, acceptPartial: false, selectedExtensionIds: [] })})`)
    assert.equal(receipt.counts.bookmarks.added, 2)
    assert.equal(receipt.counts.history.added, 1)
    const sourceAfter = { db: sha256(places), wal: sha256(`${places}-wal`) }
    assert.deepEqual(sourceAfter, sourceBefore, 'import changed the open source database or WAL')
    // Direct IPC Commit bypasses the onboarding component's normal store
    // hydration. Reload before the close barrier flushes renderer state.
    await cdp.evaluate('location.reload()').catch(() => undefined)
    await waitFor(cdp, 'Boolean(document.querySelector("[data-testid=onboarding-page]"))', 15_000)
    phase = 'first close'
    await close()
    phase = 'restart'
    await launch()
    phase = 'persistence check'
    const persisted = await cdp.evaluate('window.vast.storage.load().then(data => ({bookmarks:data.bookmarks.length,history:data.history.length}))')
    const status = await cdp.evaluate('window.vast.importer.status()')
    assert.deepEqual(persisted, { bookmarks: 2, history: 1 })
    assert.equal(status.receipt?.operationId, receipt.operationId)
    phase = 'final close'
    await close()
    passed = true
  } catch (error) {
    originalError = error
    throw error
  } finally {
    cdp?.close()
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    }
    writer?.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vast-import-firefox-e2e-'))
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }) }
    catch (error) {
      if (!originalError) throw error
      console.error(`Controlled test profile cleanup also failed: ${error instanceof Error ? error.code : 'unknown'}`)
    }
  }
  if (passed) console.log('PASS controlled Firefox open-WAL Prepare/Commit, source unchanged, restart persistence')
}

main().catch((error) => { console.error(`Controlled Firefox E2E failed in ${phase}: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
