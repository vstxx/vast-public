// End-to-end checks for onboarding dismissal and repair, history deletion and
// the command palette search, driven over CDP against the built app (out/)
// with isolated temporary profiles.
//
// Usage: build with the isolated test environment of scripts/run-app-test.cjs
// (npm run build), then node scripts/history-palette-onboarding-e2e.cjs
const { spawn, execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const electron = require('electron')
const executable = process.env.VAST_E2E_EXECUTABLE ? path.resolve(process.env.VAST_E2E_EXECUTABLE) : undefined
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const record = (name, detail) => { results.push(name); console.log(`PASS ${name}: ${detail}`) }

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = message.id && this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const session = new Cdp(ws)
    await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
  }

  async type(text) {
    await this.send('Input.insertText', { text })
  }
}

async function waitFor(session, expression, label, timeout = 15_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    try { last = await session.evaluate(expression); if (last) return last } catch (error) { last = error.message }
    await wait(150)
  }
  throw new Error(`Timed out waiting for ${label} (${JSON.stringify(last)})`)
}

const stored = (session, expression) => session.evaluate(`window.vast.storage.load().then((data) => (${expression})(data))`)

const running = new Set()

async function launch(profile, port) {
  const args = executable ? [`--remote-debugging-port=${port}`] : [root, `--remote-debugging-port=${port}`]
  const child = spawn(executable ?? electron, args, {
    cwd: root,
    env: (() => {
      const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_RELAY_TEST_OFFLINE: '1' }
      delete env.ELECTRON_RUN_AS_NODE
      return env
    })(),
    stdio: 'ignore'
  })
  running.add(child)
  child.once('exit', () => running.delete(child))
  let target
  for (let attempt = 0; attempt < 240 && !target; attempt += 1) {
    await wait(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((item) => item.type === 'page' && !item.url.startsWith('devtools') && !item.url.startsWith('vast-guest'))
    } catch { /* starting */ }
  }
  assert(target, 'Vast window did not appear.')
  const session = await Cdp.connect(target.webSocketDebuggerUrl)
  await waitFor(session, 'Boolean(window.vast) && document.readyState === "complete" && document.body.innerText.length > 0', 'Vast UI', 60_000)
  await wait(1_000)
  return { child, session }
}

async function quit(app) {
  app.session.ws.close()
  try { execFileSync('taskkill.exe', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  await wait(1_500)
}

async function clickButton(session, predicate, label) {
  const clicked = await session.evaluate(`(() => {
    const element = [...document.querySelectorAll('button,[role="menuitem"]')].find((item) => (${predicate})(item) && !item.disabled);
    if (!element) return false;
    element.click();
    return true;
  })()`)
  assert(clicked, `Could not click ${label}`)
}

async function main() {
  const { DEFAULT_DATA } = await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)
  const work = mkdtempSync(path.join(tmpdir(), 'vast-history-palette-e2e-'))
  const seed = (directory, mutate) => {
    mkdirSync(directory, { recursive: true })
    const data = structuredClone(DEFAULT_DATA)
    mutate(data)
    writeFileSync(path.join(directory, 'vast-data.json'), JSON.stringify(data))
    return directory
  }
  const now = Date.now()
  const page = (id, url, title, minutesAgo, workspaceId = 'workspace-default') => ({ id, url, title, visitCount: 1, lastVisitedAt: now - minutesAgo * 60_000, workspaceId })
  let port = 9451
  try {
    // 1. Fresh profile: onboarding appears once; Skip setup ends it for good.
    let profile = path.join(work, 'fresh')
    let app = await launch(profile, port++)
    await waitFor(app.session, 'Boolean(document.querySelector("[data-testid=onboarding-page]"))', 'onboarding on a fresh profile')
    await clickButton(app.session, '(item) => item.dataset.testid === "onboarding-skip"', 'Skip setup')
    await waitFor(app.session, 'window.vast.storage.load().then((d) => d.onboarding?.completed === true)', 'skip persisted')
    await waitFor(app.session, '!document.querySelector("[data-testid=onboarding-page]")', 'onboarding closed')
    await quit(app)
    app = await launch(profile, port++)
    await wait(2_500)
    assert(!(await app.session.evaluate('Boolean(document.querySelector("[data-testid=onboarding-page]"))')), 'Onboarding returned after Skip setup.')
    record('onboarding skip', 'Skip setup persists and onboarding does not return on the next launch')
    await quit(app)

    // 2. Closing the onboarding tab dismisses it.
    profile = path.join(work, 'close')
    app = await launch(profile, port++)
    await waitFor(app.session, 'Boolean(document.querySelector("[data-testid=onboarding-page]"))', 'onboarding before close')
    await app.session.key('w', 'KeyW', 87, 2)
    await waitFor(app.session, 'window.vast.storage.load().then((d) => d.onboarding?.completed === true)', 'close persisted')
    await quit(app)
    app = await launch(profile, port++)
    await wait(2_500)
    assert(!(await app.session.evaluate('Boolean(document.querySelector("[data-testid=onboarding-page]"))')), 'Onboarding returned after closing its tab.')
    record('onboarding close', 'closing the onboarding tab dismisses it permanently')
    await quit(app)

    // 3. A profile stuck by an older build is repaired.
    profile = seed(path.join(work, 'stuck'), (data) => {
      data.onboarding = { completed: false }
      data.history = Array.from({ length: 30 }, (_, index) => page(`s${index}`, `https://site${index}.test/`, `Site ${index}`, index * 10))
      data.tabs = data.tabs.map((tab) => ({ ...tab, url: 'vast://onboarding', title: 'Onboarding' }))
    })
    app = await launch(profile, port++)
    await wait(2_500)
    assert(!(await app.session.evaluate('Boolean(document.querySelector("[data-testid=onboarding-page]"))')), 'Stuck profile still shows onboarding.')
    const repaired = await stored(app.session, '(d) => d.onboarding')
    assert(repaired.completed === true && repaired.revision === 1, `Unexpected onboarding state ${JSON.stringify(repaired)}`)
    record('onboarding repair', 'an established profile stuck in onboarding opens normally')
    await quit(app)

    // 4. History deletion.
    profile = seed(path.join(work, 'history'), (data) => {
      data.onboarding = { completed: true, revision: 1 }
      data.sidePanelOpen = true
      data.activeSidePanel = 'history'
      data.workspaces.push({ ...data.workspaces[0], id: 'workspace-work', name: 'Work', activeTabId: undefined })
      data.history = [
        page('h1', 'https://www.example.com/one', 'Example one', 5),
        page('h2', 'https://example.com/two', 'Example two', 20),
        page('h3', 'https://news.test/story', 'Breaking news', 90),
        page('h4', 'https://docs.test/guide', 'Docs guide', 60 * 30, 'workspace-work'),
        page('h5', 'https://github.com/vstxx/vast', 'Vast repository', 60 * 24 * 3)
      ]
    })
    const backups = path.join(profile, 'storage-backups')
    mkdirSync(backups, { recursive: true })
    writeFileSync(path.join(backups, 'rolling-17000000000001.json'), JSON.stringify({ schemaVersion: 9, history: [page('old', 'https://secret.test/', 'Secret', 99)] }))
    app = await launch(profile, port++)
    const ids = () => stored(app.session, '(d) => d.history.map((entry) => entry.id).join(",")')
    await waitFor(app.session, 'document.body.innerText.includes("Clear history")', 'history panel')

    await clickButton(app.session, '(item) => item.getAttribute("aria-label") === "Remove Example one from history"', 'row remove')
    await waitFor(app.session, `window.vast.storage.load().then((d) => !d.history.some((e) => e.id === 'h1'))`, 'row removal persisted')
    await waitFor(app.session, 'document.body.innerText.includes("History deleted")', 'undo toast')
    await clickButton(app.session, '(item) => item.innerText.trim() === "Undo"', 'Undo')
    await waitFor(app.session, `window.vast.storage.load().then((d) => d.history.some((e) => e.id === 'h1'))`, 'undo persisted')
    record('history row delete + undo', 'one page removed, saved immediately, and restored by Undo')

    await app.session.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="Search history"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'news');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await waitFor(app.session, 'document.body.innerText.includes("Delete 1 matching page")', 'matching delete button')
    await clickButton(app.session, '(item) => item.innerText.includes("Delete 1 matching page")', 'delete matching')
    await waitFor(app.session, `window.vast.storage.load().then((d) => !d.history.some((e) => e.id === 'h3'))`, 'matching delete persisted')
    await app.session.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="Search history"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    record('history delete matching', 'search results are deleted as shown')

    await clickButton(app.session, '(item) => item.innerText.includes("Clear history…")', 'Clear history menu')
    await waitFor(app.session, 'document.body.innerText.includes("Last 24 hours")', 'range menu')
    await clickButton(app.session, '(item) => item.innerText.trim() === "Last hour"', 'Last hour')
    await waitFor(app.session, `window.vast.storage.load().then((d) => d.history.map((e) => e.id).join(',') === 'h4,h5')`, 'last hour cleared')
    record('history time range', `Last hour removed recent pages only (left: ${await ids()})`)

    await clickButton(app.session, '(item) => item.innerText.includes("Clear history…")', 'Clear history menu')
    await waitFor(app.session, 'document.body.innerText.includes("All time")', 'all time option')
    await clickButton(app.session, '(item) => item.innerText.trim() === "All time"', 'All time')
    await waitFor(app.session, 'document.body.innerText.includes("Clear all history?")', 'confirmation')
    await clickButton(app.session, '(item) => item.innerText.trim() === "Clear history" && item.closest("[role=dialog]")', 'confirm clear')
    await waitFor(app.session, 'window.vast.storage.load().then((d) => d.history.length === 0)', 'all history cleared')
    await waitFor(app.session, 'Promise.resolve(true)', 'settle')
    await wait(1_000)
    const backup = JSON.parse(readFileSync(path.join(backups, 'rolling-17000000000001.json'), 'utf8'))
    assert(Array.isArray(backup.history) && backup.history.length === 0, 'Backup still contains history.')
    record('history clear all', 'confirmation, everything removed, and storage backups scrubbed')
    await quit(app)

    // 5. Command palette search.
    profile = seed(path.join(work, 'palette'), (data) => {
      data.onboarding = { completed: true, revision: 1 }
      data.history = [
        page('p1', 'https://github.com/vstxx/vast', 'vstxx/vast: Vast browser', 30),
        page('p2', 'https://news.ycombinator.com/', 'Hacker News', 60),
        page('p3', 'https://pl.wikipedia.org/wiki/Źródło', 'Źródło – Wikipedia', 120),
        ...Array.from({ length: 200 }, (_, index) => page(`f${index}`, `https://filler${index}.test/`, `Filler ${index}`, 300 + index))
      ]
      data.bookmarks = [{ id: 'b1', title: 'GitHub', url: 'https://github.com/', createdAt: now, updatedAt: now }]
    })
    app = await launch(profile, port++)
    const query = async (text) => {
      await app.session.evaluate(`(() => {
        const input = document.querySelector('input[placeholder="Command, tab, bookmark, history, or search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
      await wait(400)
      return app.session.evaluate('[...document.querySelectorAll(".command-palette-item")].map((item) => item.querySelector(".text-sm.font-semibold")?.textContent ?? "")')
    }
    await app.session.key('k', 'KeyK', 75, 2)
    await waitFor(app.session, 'Boolean(document.querySelector("input[placeholder=\\"Command, tab, bookmark, history, or search\\"]"))', 'palette')
    let titles = await query('github.com')
    assert(titles[0] === 'Open github.com', `Expected Open github.com first, got ${titles.slice(0, 3)}`)
    titles = await query('zrodlo')
    assert(titles[0] === 'Źródło – Wikipedia', `Diacritic search failed: ${titles.slice(0, 3)}`)
    titles = await query('Filler 199')
    assert(titles.includes('Filler 199'), 'Old history entries are not searchable.')
    titles = await query('@history hacker')
    assert(titles[0] === 'Hacker News' && titles.every((title) => !title.startsWith('Search ')), `Scoped search failed: ${titles}`)
    titles = await query('github')
    assert(titles.filter((title) => title === 'GitHub').length === 1, 'Bookmark duplicated by history.')
    record('palette search', 'URL action, diacritics, full history, @history scope and page dedupe')
    await query('hacker')
    await app.session.key('Delete', 'Delete', 46, 8)
    await waitFor(app.session, `window.vast.storage.load().then((d) => !d.history.some((e) => e.id === 'p2'))`, 'Shift+Delete removal')
    record('palette Shift+Delete', 'removes the highlighted history entry')
    await quit(app)

    console.log(JSON.stringify({ ok: true, passed: results }))
  } finally {
    for (const child of running) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
    }
    await wait(1_500)
    try { rmSync(work, { recursive: true, force: true }) } catch (error) { console.warn(`cleanup: ${error.message}`) }
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
