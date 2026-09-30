const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectRenderer, stopRun, waitFor } = require('./performance-suite.cjs')

const project = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-import-data-e2e-'))
const vastProfile = path.join(root, 'vast-profile')
const localAppData = path.join(root, 'local')
const roamingAppData = path.join(root, 'roaming')
const chromeProfile = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default')
const dataFile = path.join(vastProfile, 'vast-data.json')
const port = 10500 + Math.floor(Math.random() * 500)
let child
let cdp

function readData() { return JSON.parse(fs.readFileSync(dataFile, 'utf8')) }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function until(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function click(expression) {
  const clicked = await cdp.evaluate(`(() => { const element = ${expression}; if (!element) return false; element.click(); return true })()`)
  assert.equal(clicked, true, `missing clickable control: ${expression}`)
}

function fixture() {
  fs.mkdirSync(chromeProfile, { recursive: true })
  fs.mkdirSync(roamingAppData, { recursive: true })
  fs.writeFileSync(path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Controlled Chrome' } } }
  }))
  fs.writeFileSync(path.join(chromeProfile, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { type: 'folder', id: '1', name: 'Bookmarks bar', children: [
      { type: 'url', id: '10', name: 'Controlled bar', url: 'https://controlled.example/' }
    ] },
    other: { type: 'folder', id: '2', name: 'Other bookmarks', children: [
      { type: 'folder', id: '20', name: 'Research', children: [
        { type: 'url', id: '21', name: 'Controlled duplicate', url: 'https://controlled.example/' }
      ] }
    ] },
    synced: { type: 'folder', id: '3', name: 'Mobile bookmarks', children: [] }
  } }))
}

async function launch(expectOnboarding = true) {
  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: vastProfile,
    VAST_RELAY_TEST_OFFLINE: '1',
    VAST_UPDATE_ENABLED: '0',
    VAST_EXTENSION_COMPATIBILITY: '0',
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electronExe = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe')
  assert.ok(fs.existsSync(electronExe), 'Local Electron binary is missing; E2E will not download one')
  child = spawn(electronExe, [project, `--remote-debugging-port=${port}`], {
    cwd: project, env, windowsHide: true, stdio: 'ignore'
  })
  cdp = await connectRenderer(port)
  await waitFor(cdp, expectOnboarding
    ? 'Boolean(document.querySelector("[data-testid=onboarding-page]"))'
    : 'Boolean(document.querySelector(".app-shell"))', 30_000)
}

async function stop() {
  if (!child || !cdp) return
  const currentChild = child
  const currentCdp = cdp
  child = undefined
  cdp = undefined
  const result = await stopRun(currentChild, currentCdp)
  assert.equal(result.graceful, true, 'Vast did not exit cleanly')
}

async function main() {
  try {
    fixture()
    await launch()
    await click('document.querySelector("[data-testid=onboarding-configure]")')
    await waitFor(cdp, 'document.querySelector(".onboarding-page")?.dataset.onboardingStep === "1"', 10_000)
    await click('document.querySelector(".onboarding-nav button:last-child")')
    await waitFor(cdp, 'document.querySelector(".onboarding-page")?.dataset.onboardingStep === "2"', 10_000)
    await click('document.querySelector(".onboarding-nav button:last-child")')
    await waitFor(cdp, 'document.querySelector(".onboarding-page")?.dataset.onboardingStep === "3"', 10_000)
    await until(async () => cdp.evaluate('Boolean([...document.querySelectorAll("[role=radio]")].find(e => e.textContent.trim() === "Chrome" && !e.disabled))'), 'Chrome profile discovery')
    await click('[...document.querySelectorAll("[role=radio]")].find(e => e.textContent.trim() === "Chrome")')
    await click('[...document.querySelectorAll("[role=checkbox]")].find(e => e.textContent.trim() === "History")')
    assert.equal(readData().bookmarks.length, 0)

    const bookmarkFile = path.join(chromeProfile, 'Bookmarks')
    const hiddenBookmarkFile = path.join(chromeProfile, 'Bookmarks.e2e-hidden')
    fs.renameSync(bookmarkFile, hiddenBookmarkFile)
    await click('document.querySelector(".onboarding-nav button:last-child")')
    await waitFor(cdp, 'document.querySelector(".onboarding-content [role=alert]")', 10_000)
    assert.equal(readData().bookmarks.length, 0, 'Failed Prepare wrote imported data')
    fs.renameSync(hiddenBookmarkFile, bookmarkFile)

    await click('document.querySelector(".onboarding-nav button:last-child")')
    try {
      await waitFor(cdp, 'document.querySelector("[data-testid=onboarding-import-preview]")', 30_000)
    } catch (error) {
      const alert = await cdp.evaluate('document.querySelector(".onboarding-content [role=alert]")?.textContent?.slice(0, 300) ?? ""').catch(() => '')
      throw new Error(`Import preview unavailable; controlled fixture UI alert: ${JSON.stringify(alert)}`, { cause: error })
    }
    assert.equal(await cdp.evaluate('document.querySelector("[data-testid=onboarding-import-preview]").textContent.includes("2 bookmarks")'), true)
    assert.equal(readData().bookmarks.length, 0, 'Prepare wrote imported data before approval')

    await click('document.querySelector(".onboarding-nav button:first-child")')
    await waitFor(cdp, 'document.querySelector(".onboarding-page")?.dataset.onboardingStep === "2"', 10_000)
    assert.equal(readData().bookmarks.length, 0, 'Back wrote imported data')
    await click('document.querySelector(".onboarding-nav button:last-child")')
    await waitFor(cdp, 'document.querySelector(".onboarding-page")?.dataset.onboardingStep === "3"', 10_000)
    await click('document.querySelector(".onboarding-nav button:last-child")')
    await waitFor(cdp, 'document.querySelector("[data-testid=onboarding-import-preview]")', 30_000)
    assert.equal(readData().bookmarks.length, 0, 'Retry wrote imported data')
    for (const expected of [4, 5, 6]) {
      await click('document.querySelector(".onboarding-nav button:last-child")')
      await waitFor(cdp, `document.querySelector(".onboarding-page")?.dataset.onboardingStep === "${expected}"`, 10_000)
    }
    assert.equal(readData().bookmarks.length, 0, 'Next wrote imported data')
    await click('document.querySelector("[data-testid=onboarding-enter-vast]")')
    await until(async () => readData().onboarding?.completed === true && readData().bookmarks.length === 2, 'committed import')
    const committed = readData()
    assert.equal(new Set(committed.bookmarks.map((item) => item.id)).size, 2)
    assert.equal(committed.importState.receipt.counts.bookmarks.added, 2)
    await stop()

    await launch(false)
    const persisted = readData()
    assert.equal(persisted.bookmarks.length, 2)
    assert.equal(persisted.onboarding.completed, true)
    assert.equal(persisted.importState.receipt.counts.bookmarks.added, 2)
    console.log('PASS controlled Chrome failed Prepare/Retry → Preview → Commit, Back/Retry, restart persistence')
    await stop()
  } finally {
    if (child?.pid) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
      child = undefined
    }
    cdp?.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vast-import-data-e2e-'))
    await wait(1_000)
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }) }
    catch (cleanupError) { console.warn('Isolated E2E profile cleanup deferred:', cleanupError.message) }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
