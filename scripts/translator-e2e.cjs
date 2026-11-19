// Translator for Vast end to end, in the patched Vast runtime with the Chromium compatibility layer:
// install through the real local .vext path, static toolbar contribution with no Native host,
// popup, on-demand model download from Mozilla's bucket (network required), page translation and
// restore, selection and single-word translation from the page menu, the "translate page" menu with
// a missing model, dynamic pages, service-worker restart, idle release, disable and removal.
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packagePath = path.join(root, 'artifacts', 'Translator-for-Vast-1.0.0.vext')
const translatorId = 'oaamgecaoemplhkceohcpahaeampndpj'
const dist = process.env.VAST_PATCHED_ELECTRON_DIST && path.resolve(process.env.VAST_PATCHED_ELECTRON_DIST)
const electron = dist && path.join(dist, 'electron.exe')
if (!electron || !fs.existsSync(electron)) throw new Error('Translator E2E requires a verified VAST_PATCHED_ELECTRON_DIST.')
if (!fs.existsSync(packagePath)) throw new Error('Build the package first: npm run extension:translator:pack')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-translator-e2e-'))
const timeout = process.env.CI === 'true' ? 90_000 : 45_000
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
let child

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pass(label, detail = '') {
  results.push(label)
  console.log(`PASS ${label}${detail ? ` (${detail})` : ''}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = message.id && this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url, runtime = true) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const session = new Cdp(socket)
    if (runtime) await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}, ms = 120_000) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, ms)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, ms) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, ms)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}

async function json(url) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Not listening yet.
    }
    await wait(250)
  }
  throw new Error(`No debugger at ${url}`)
}

async function until(check, label, ms = timeout) {
  const started = Date.now()
  let last
  while (Date.now() - started < ms) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await wait(200)
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`)
}

const pages = {
  '/article': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The weather this week</title></head><body>
<h1 id="h">The weather is changing quickly this week</h1>
<p id="p1">Scientists say that the next few days will bring <a id="link" href="#more">strong winds</a> and heavy rain to the northern coast.</p>
<p id="p2">Please <b>read the guide</b> before you travel, and check <code>status.json</code> for updates at https://example.com/status.</p>
<p id="brand" translate="no">Northwind Weather Service</p>
<label id="lab">Your name <input id="name" value="secret value"></label>
<input id="pw" type="password" value="hunter2" placeholder="Enter your password">
<div contenteditable="true" id="editor">Draft written by the user stays as it is.</div>
<table><tr><th>Day</th><th>Forecast</th></tr><tr><td>Monday</td><td id="cell">Sunny with a light breeze in the afternoon.</td></tr></table>
<ul><li id="li">Bring an umbrella and warm clothes.</li></ul>
</body></html>`,
  '/polski': `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Prognoza pogody</title></head><body>
<h1 id="h">Pogoda zmienia się w tym tygodniu bardzo szybko</h1>
<p id="p1">Naukowcy twierdzą, że najbliższe dni przyniosą silny wiatr i ulewny deszcz na północnym wybrzeżu kraju.</p>
<p id="p2">Przed podróżą przeczytaj przewodnik i sprawdzaj komunikaty lokalnych służb.</p>
</body></html>`,
  '/spa': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dynamic page</title></head><body>
<main id="app"><p id="first">The first message arrived this morning from the support team.</p><p id="counter">You have 3 new notifications waiting for you.</p></main>
<script>
window.addMessage = (text) => { const p = document.createElement('p'); p.className = 'late'; p.textContent = text; document.getElementById('app').append(p) };
window.rerender = () => { const c = document.getElementById('counter'); c.replaceChildren(document.createTextNode('You have 5 new notifications waiting for you.')) };
</script></body></html>`
}

function startServer() {
  const server = http.createServer((request, response) => {
    const page = pages[request.url.split('?')[0]]
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.statusCode = page ? 200 : 404
    response.end(page ?? 'missing')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function main() {
  const server = await startServer()
  const origin = `http://127.0.0.1:${server.address().port}`
  const port = 9600 + Math.floor(Math.random() * 150)
  const inspect = port + 200
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userDataDir, VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1', VAST_EXTENSIONS_HUB_ORIGIN: 'http://127.0.0.1:9', VAST_PATCHED_ELECTRON_DIST: dist }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [`--remote-debugging-port=${port}`, `--inspect=${inspect}`, root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  const targets = () => json(`http://127.0.0.1:${port}/json/list`)
  const pageTarget = await until(async () => (await targets()).find((target) => target.type === 'page' && target.url.includes('index.html')), 'browser window')
  const ui = await Cdp.connect(pageTarget.webSocketDebuggerUrl)
  const uiWait = (expression, label, ms) => until(() => ui.evaluate(`Boolean(${expression})`), label, ms)
  await uiWait(`document.querySelector('[data-testid="onboarding-page"]') || document.querySelector('[data-testid="new-tab-identity"]')`, 'first route', 60_000)
  if (await ui.evaluate(`Boolean(document.querySelector('[data-testid="onboarding-page"]'))`)) {
    await ui.evaluate(`document.querySelector('[data-testid="onboarding-use-defaults"]').click()`)
    await uiWait(`document.querySelector('[data-testid="onboarding-enter-vast"]')`, 'onboarding summary')
    await ui.evaluate(`document.querySelector('[data-testid="onboarding-enter-vast"]').click()`)
    await uiWait(`!document.querySelector('[data-testid="onboarding-page"]')`, 'onboarding done')
  }
  await uiWait(`!document.querySelector('.vast-opening-overlay')`, 'opening overlay', 20_000).catch(() => undefined)
  if (await ui.evaluate(`Boolean(document.querySelector('[data-testid="relay-notice-dismiss"]'))`)) await ui.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)

  // ---------- Install through the local .vext path ----------
  const mainTarget = (await json(`http://127.0.0.1:${inspect}/json/list`))[0]
  const mainProcess = await Cdp.connect(mainTarget.webSocketDebuggerUrl)
  await mainProcess.evaluate(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(packagePath)}] }); return true })()`)
  const prepared = await ui.evaluate('window.vast.extensions.installPackage()')
  assert(prepared.ok && prepared.preview, `Package preview failed: ${prepared.error}`)
  const preview = prepared.preview
  assert(preview.extensionId === translatorId && preview.name === 'Translator for Vast' && preview.kind === 'hybrid', `Preview identity is wrong: ${JSON.stringify({ id: preview.extensionId, name: preview.name, kind: preview.kind })}`)
  assert(preview.permissions.vast.includes('vast.toolbar') && preview.permissions.hosts.length > 0, 'Preview does not disclose the requested access.')
  const confirmed = await ui.evaluate(`window.vast.extensions.confirmInstall(${JSON.stringify(preview.token)})`)
  assert(confirmed.ok, `Install failed: ${confirmed.error}`)
  let installed = await until(async () => {
    const list = await ui.evaluate('window.vast.extensions.list()')
    const entry = list.extensions.find((extension) => extension.id === translatorId)
    return entry?.runtimeState === 'loaded' || entry?.runtimeState === 'pending-permission' ? entry : null
  }, 'translator loaded')
  if (installed.native?.state === 'pending-permission') {
    const approved = await ui.evaluate(`window.vast.extensions.approvePermissions(${JSON.stringify(translatorId)}, ['vast.toolbar'])`)
    assert(approved.ok, `Approval failed: ${approved.error}`)
    installed = await until(async () => (await ui.evaluate('window.vast.extensions.list()')).extensions.find((extension) => extension.id === translatorId && extension.native?.state === 'idle'), 'native layer idle')
  }
  assert(installed.kind === 'hybrid' && installed.source === 'local-vext', `Unexpected install record: ${installed.kind}/${installed.source}`)
  assert(installed.native.state === 'idle', `Static contributions must not start a Native host (state ${installed.native.state}).`)
  pass('install local .vext', `preview hosts=${(preview.permissions?.hosts ?? []).join(' ')}`)

  const contributions = await until(async () => {
    const snapshot = await ui.evaluate('window.vast.extensions.contributions().then((reply) => reply.contributions)')
    return snapshot.toolbar?.find((entry) => entry.extensionId === translatorId && entry.available) ? snapshot : null
  }, 'toolbar contribution')
  const toolbar = contributions.toolbar.find((entry) => entry.extensionId === translatorId)
  assert(toolbar.source === 'manifest' && toolbar.action === 'popup' && /^data:image\/svg\+xml/.test(toolbar.iconDataUrl ?? ''), 'Toolbar contribution is not the verified manifest icon.')
  assert(contributions.nativeTabEvents === false, 'A static extension created tab-event demand.')
  pass('static toolbar contribution, no Native host')

  // ---------- Helpers bound to the running app ----------
  const visible = `[...document.querySelectorAll('webview.browser-webview')].find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 })`
  const navigate = (url) => ui.evaluate(`(() => { const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Search or enter address'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit() })()`)
  const guest = (expression) => ui.evaluate(`(() => { const w = ${visible}; if (!w) throw new Error('no webview'); return w.executeJavaScript(${JSON.stringify(expression)}, true) })()`)
  const guestWait = (expression, label, ms) => until(() => guest(`Boolean(${expression})`), label, ms)
  const surface = (expression) => ui.evaluate(`(() => { const w = document.querySelector('webview.extension-toolbar-surface'); if (!w) throw new Error('no popup'); return w.executeJavaScript(${JSON.stringify(expression)}, true) })()`)
  const surfaceWait = (expression, label, ms) => until(() => surface(`Boolean(${expression})`), label, ms)
  const worker = async () => Cdp.connect((await until(async () => (await targets()).find((target) => target.type === 'service_worker' && target.url === `chrome-extension://${translatorId}/background.js`), 'service worker')).webSocketDebuggerUrl)
  const guestTarget = async (urlPart) => Cdp.connect((await until(async () => (await targets()).find((target) => target.type === 'webview' && target.url.includes(urlPart)), `guest target ${urlPart}`)).webSocketDebuggerUrl)
  const offscreenOpen = async () => (await targets()).some((target) => target.url === `chrome-extension://${translatorId}/offscreen.html`)

  // ---------- Popup: download on demand, translate, restore ----------
  await navigate(`${origin}/article`)
  await guestWait(`document.getElementById('p1')`, 'article')
  assert(!await offscreenOpen(), 'The engine document exists before any translation request.')
  await guest(`window.__before = document.body.innerHTML; window.__link = document.getElementById('link'); window.__clicks = 0; window.__link.addEventListener('click', (event) => { event.preventDefault(); window.__clicks += 1 }); scrollTo(0, 0); true`)
  const dispatched = await ui.evaluate(`window.vast.extensions.dispatchContribution(${JSON.stringify(toolbar.key)})`)
  assert(dispatched.ok && dispatched.outcome === 'popup', `Toolbar dispatch failed: ${JSON.stringify(dispatched)}`)
  await uiWait(`document.querySelector('webview.extension-toolbar-surface')`, 'popup surface')
  await surfaceWait(`document.getElementById('source')?.options.length > 1 && document.getElementById('source').options[0].textContent.includes('English')`, 'popup detected English')
  await surface(`(() => { const s = document.getElementById('target'); s.value = 'pl'; s.dispatchEvent(new Event('change')); return true })()`)
  await surfaceWait(`!document.getElementById('download').hidden && /MB/.test(document.getElementById('download-button').textContent)`, 'download offer with size')
  const offer = await surface(`document.getElementById('download-button').textContent`)
  const downloadStarted = Date.now()
  await surface(`document.getElementById('download-button').click(), true`)
  await surfaceWait(`!document.getElementById('action').disabled && document.getElementById('download').hidden`, 'model installed', 300_000)
  pass('model download from popup', `${offer}, ${Date.now() - downloadStarted} ms`)
  const translateStarted = Date.now()
  await surface(`document.getElementById('action').click(), true`)
  await guestWait(`document.getElementById('h').textContent !== 'The weather is changing quickly this week' && document.documentElement.lang === 'en'`, 'first translated block')
  const firstBlockMs = Date.now() - translateStarted
  await surfaceWait(`document.getElementById('action').textContent.length > 0 && !document.getElementById('action').classList.contains('primary')`, 'popup shows show-original')
  await guestWait(`document.getElementById('li').textContent !== 'Bring an umbrella and warm clothes.'`, 'all blocks translated')
  const after = await guest(`({ h1: document.getElementById('h').textContent, p1: document.getElementById('p1').textContent, sameLink: document.getElementById('link') === window.__link, href: document.getElementById('link').getAttribute('href'), brand: document.getElementById('brand').textContent, name: document.getElementById('name').value, pw: document.getElementById('pw').value, editor: document.getElementById('editor').textContent, code: document.querySelector('#p2 code')?.textContent, url: document.getElementById('p2').textContent.includes('https://example.com/status'), title: document.title, injected: document.querySelectorAll('script, iframe, object, embed, style:not([data-vast])').length, handlers: [...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))) })`)
  assert(/[ąćęłńóśźż]|pogod|tygod/i.test(after.h1), `Heading was not translated to Polish: ${after.h1}`)
  assert(after.sameLink && after.href === '#more', 'The page link was replaced instead of reused.')
  assert(after.brand === 'Northwind Weather Service', 'translate="no" content changed.')
  assert(after.name === 'secret value' && after.pw === 'hunter2', 'Form values changed.')
  assert(after.editor === 'Draft written by the user stays as it is.', 'An editable region was translated.')
  assert(after.code === 'status.json' && after.url, 'Protected code or URL changed.')
  assert(after.title !== 'The weather this week', 'Document title was not translated.')
  assert(after.injected === 0 && !after.handlers, 'Translation introduced executable markup.')
  await guest(`document.getElementById('link').click(), true`)
  assert(await guest('window.__clicks') === 1, 'Link handler stopped working after translation.')
  pass('page translation EN→PL', `first block ${firstBlockMs} ms; "${after.h1}"`)
  await surface(`document.getElementById('action').click(), true`)
  await guestWait(`document.body.innerHTML === window.__before`, 'byte-identical restore')
  pass('restore without reload')

  // Repeated cycles leave neither duplicates nor markers.
  const sw = await worker()
  const tab = await sw.evaluate('translatorDebug.tabInfo()')
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await sw.evaluate(`translatorDebug.startPageTranslation(${tab.tabId}, 'en', 'pl')`)
    await until(async () => (await sw.evaluate(`translatorDebug.pageCommand(${tab.tabId}, { type: 'page:state' })`)).status === 'translated', `cycle ${cycle} translated`)
    assert(await guest(`document.querySelectorAll('tfv-translation').length === 0 && document.getElementById('h').textContent !== 'The weather is changing quickly this week'`), 'Replace mode left copies on the page.')
    await sw.evaluate(`translatorDebug.pageCommand(${tab.tabId}, { type: 'page:restore' })`)
    await guestWait(`document.body.innerHTML === window.__before`, `cycle ${cycle} restored`)
  }
  pass('translate/restore cycles x3')

  await surface(`document.getElementById('open-settings').click(), true`)
  await surfaceWait(`document.body.classList.contains('options')`, 'settings opened from popup', 3_000)
  const optionsWidth = await surface(`({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth })`)
  assert(optionsWidth.scroll <= optionsWidth.viewport, `Settings overflow the Vast surface: ${JSON.stringify(optionsWidth)}`)
  pass('popup settings fit the Vast surface')

  // ---------- Selection and single word from the page menu ----------
  await ui.evaluate(`document.querySelector('webview.extension-toolbar-surface') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  const page = await guestTarget('/article')
  await page.send('DOM.enable')
  const wordBox = await guest(`(() => { const text = document.getElementById('h').firstChild; const at = text.data.indexOf('weather'); const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + 7); const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: wordBox.x, y: wordBox.y, button: 'left', clickCount: 1 })
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: wordBox.x, y: wordBox.y, button: 'left', clickCount: 2 })
  assert(await guest(`getSelection().toString().trim()`) === 'weather', 'Double-click did not select the word.')
  const guestId = await ui.evaluate(`${visible}.getWebContentsId()`)
  const menuItem = async (pattern) => until(async () => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wordBox.x, y: wordBox.y, button: 'right', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: wordBox.x, y: wordBox.y, button: 'right', clickCount: 1 })
    await wait(250)
    const menu = await ui.evaluate(`window.vast.extensions.chromeContextMenu(${guestId})`)
    return menu.ok ? menu.items.find((item) => pattern.test(item.label)) : null
  }, `menu item ${pattern}`)
  const selectionItem = await menuItem(/weather/)
  await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  assert((await ui.evaluate(`window.vast.extensions.clickChromeContextMenu(${guestId}, ${JSON.stringify(selectionItem.token)})`)).ok, 'Selection menu click failed.')
  const popupText = async () => {
    const { root: doc } = await page.send('DOM.getDocument', { depth: -1, pierce: true })
    const find = (node, predicate) => {
      if (predicate(node)) return node
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child, predicate)
        if (found) return found
      }
      return null
    }
    const host = find(doc, (node) => node.localName === 'tfv-ui')
    const body = host && find(host, (node) => node.localName === 'div' && /\bbody\b/.test((node.attributes ?? []).join(' ')))
    if (!body) return null
    const { object } = await page.send('DOM.resolveNode', { nodeId: body.nodeId })
    const value = await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return { text: this.textContent, kind: this.className, mode: this.getRootNode().mode } }', returnByValue: true })
    return value.result.value
  }
  const word = await until(async () => {
    const value = await popupText()
    return value && value.kind.trim() === 'body' ? value : null
  }, 'single-word translation in popup')
  assert(word.mode === 'closed' && word.text.trim().length > 0 && word.text.trim().toLowerCase() !== 'weather', `Word translation is wrong: ${JSON.stringify(word)}`)
  pass('single word via double-click + page menu', `weather → ${word.text.trim()}`)
  // Keys reach the page only while its webview has focus, as for a user.
  await ui.evaluate(`${visible}.focus()`)
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(async () => !await guest(`Boolean(document.querySelector('tfv-ui'))`), 'popup dismissed with Escape')
  await guest(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('p1')); getSelection().removeAllRanges(); getSelection().addRange(r); return true })()`)
  const sentenceBox = await guest(`(() => { const r = document.getElementById('p1').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
  Object.assign(wordBox, sentenceBox)
  const sentenceItem = await menuItem(/Scientists|Translate|Przetłumacz/)
  await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await ui.evaluate(`window.vast.extensions.clickChromeContextMenu(${guestId}, ${JSON.stringify(sentenceItem.token)})`)
  const sentence = await until(async () => {
    const value = await popupText()
    return value && value.kind.trim() === 'body' && value.text.length > 20 ? value : null
  }, 'selection translation')
  assert(/wiatr|deszcz|dni/i.test(sentence.text), `Selection translation is not plausible Polish: ${sentence.text}`)
  pass('selected text via page menu', sentence.text.trim().slice(0, 60))
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  page.close()

  // ---------- "Translate page" menu with a missing model (PL→EN) ----------
  await navigate(`${origin}/polski`)
  await guestWait(`document.getElementById('p1')`, 'Polish page')
  await sw.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'en' } })`)
  const polish = await guestTarget('/polski')
  const box = await guest(`(() => { const r = document.getElementById('p2').getBoundingClientRect(); return { x: r.left + 10, y: r.bottom + 30 } })()`)
  Object.assign(wordBox, box)
  await guest(`getSelection().removeAllRanges(), true`)
  const pageItem = await until(async () => {
    await polish.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'right', clickCount: 1 })
    await polish.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'right', clickCount: 1 })
    await wait(250)
    const menu = await ui.evaluate(`window.vast.extensions.chromeContextMenu(${guestId})`)
    return menu.ok ? menu.items.find((item) => item.label === 'Translate page') : null
  }, 'translate page menu item')
  await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await ui.evaluate(`window.vast.extensions.clickChromeContextMenu(${guestId}, ${JSON.stringify(pageItem.token)})`)
  await polish.send('DOM.enable')
  const button = await until(async () => {
    const { root: doc } = await polish.send('DOM.getDocument', { depth: -1, pierce: true })
    const stack = [doc]
    while (stack.length) {
      const node = stack.pop()
      if (node.localName === 'button' && (node.attributes ?? []).includes('primary')) return node
      stack.push(...(node.children ?? []), ...(node.shadowRoots ?? []))
    }
    return null
  }, 'download offer in page')
  const { model } = await polish.send('DOM.getBoxModel', { nodeId: button.nodeId })
  const [x1, y1, , , x3, y3] = model.content
  for (const type of ['mousePressed', 'mouseReleased']) await polish.send('Input.dispatchMouseEvent', { type, x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: 'left', clickCount: 1 })
  await guestWait(`/weather|wind|rain/i.test(document.body.textContent)`, 'Polish page translated to English after in-page download', 300_000)
  pass('page menu with missing model: in-page download then PL→EN', await guest(`document.getElementById('h').textContent`))
  polish.close()

  // ---------- Dynamic page ----------
  await sw.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'pl' } })`)
  await navigate(`${origin}/spa`)
  await guestWait(`document.getElementById('first')`, 'dynamic page')
  const spaTab = await sw.evaluate('translatorDebug.tabInfo()')
  await sw.evaluate(`translatorDebug.startPageTranslation(${spaTab.tabId}, 'en', 'pl')`)
  await guestWait(`document.getElementById('first').textContent !== 'The first message arrived this morning from the support team.'`, 'dynamic page translated')
  await guest(`addMessage('A new message about the delivery schedule was added later.'); rerender(); true`)
  await guestWait(`document.querySelector('.late')?.textContent !== 'A new message about the delivery schedule was added later.' && !/You have 5/.test(document.getElementById('counter').textContent)`, 'added and re-rendered content translated')
  await wait(800)
  const spa = await guest(`({ late: document.querySelectorAll('.late').length, copies: document.querySelectorAll('tfv-translation').length, counter: document.getElementById('counter').textContent })`)
  assert(spa.late === 1 && spa.copies === 0, `Dynamic content was duplicated: ${JSON.stringify(spa)}`)
  pass('dynamic content follow-up', spa.counter)
  await sw.evaluate(`translatorDebug.pageCommand(${spaTab.tabId}, { type: 'page:restore' })`)
  await guestWait(`/You have 5 new notifications/.test(document.getElementById('counter').textContent)`, 'dynamic page restored')

  // A pivot route needs two models. Switching to a third direction must release an old model,
  // rather than retaining three Marian workspaces in the same WASM heap.
  await sw.evaluate(`translatorDebug.engine({ type: 'engine:download', source: 'ru', target: 'pl' })`)
  const russian = await sw.evaluate(`translatorDebug.engine({ type: 'engine:translate', source: 'ru', target: 'pl', fragments: ['Поддержка пользователей доступна каждый день.'], priority: 'selection', tag: 'memory-regression' })`)
  assert(russian.fragments[0] && russian.fragments[0] !== 'Поддержка пользователей доступна каждый день.', 'Pivot route did not translate.')
  const pivotStatus = await sw.evaluate(`translatorDebug.engine({ type: 'engine:status' })`)
  assert(pivotStatus.routes.includes('ru-en|en-pl'), 'Pivot route was not loaded.')
  await sw.evaluate(`translatorDebug.engine({ type: 'engine:translate', source: 'pl', target: 'en', fragments: ['Pogoda zmienia się dzisiaj.'], priority: 'selection', tag: 'memory-regression' })`)
  const switchedStatus = await sw.evaluate(`translatorDebug.engine({ type: 'engine:status' })`)
  assert(!switchedStatus.routes.includes('ru-en|en-pl'), `A third model remained alongside the pivot route: ${JSON.stringify(switchedStatus.routes)}`)
  pass('pivot route releases a model before another direction', `${Math.round(pivotStatus.heapBytes / 1048576)} MB WASM heap`)

  // ---------- Service worker restart ----------
  const browserTarget = await json(`http://127.0.0.1:${port}/json/version`)
  const browser = await Cdp.connect(browserTarget.webSocketDebuggerUrl, false)
  const swInfo = (await browser.send('Target.getTargets')).targetInfos.find((target) => target.type === 'service_worker' && target.url.includes(translatorId))
  sw.close()
  await browser.send('Target.closeTarget', { targetId: swInfo.targetId })
  await until(async () => !(await targets()).some((target) => target.type === 'service_worker' && target.url.includes(translatorId)), 'service worker stopped', 15_000).catch(() => undefined)
  await navigate(`${origin}/article?again`)
  await guestWait(`document.getElementById('p1')`, 'article again')
  ui.evaluate(`window.vast.extensions.dispatchContribution(${JSON.stringify(toolbar.key)})`)
  await uiWait(`document.querySelector('webview.extension-toolbar-surface')`, 'popup after worker restart')
  await surfaceWait(`!document.getElementById('action').disabled`, 'popup ready after worker restart')
  await surface(`document.getElementById('action').click(), true`)
  await guestWait(`document.getElementById('h').textContent !== 'The weather is changing quickly this week'`, 'translation after worker restart')
  pass('service worker restart')
  await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")

  // ---------- Idle release ----------
  const sw2 = await worker()
  await sw2.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'pl', idleSeconds: 10 } }).then(() => translatorDebug.applySettings())`)
  await until(() => offscreenOpen(), 'engine document open')
  const released = await until(async () => !await offscreenOpen(), 'engine document released after idle', 60_000)
  pass('idle release closes engine document', String(released))
  sw2.close()

  // ---------- Update through the same local path ----------
  // The same package as version 1.0.1: an update preview without new permissions, and the
  // downloaded models survive (translation works without another download).
  const { parseVextPackage, createVextPackage } = await import('../src/shared/vext-format.ts')
  const current = await parseVextPackage(new Uint8Array(fs.readFileSync(packagePath)))
  const files = new Map(current.files)
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
  manifest.version = '1.0.1'
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
  const updatePath = path.join(userDataDir, 'Translator-for-Vast-1.0.1.vext')
  fs.writeFileSync(updatePath, await createVextPackage({ extensionId: translatorId, version: '1.0.1', publisherId: current.metadata.publisher_id, files }))
  await mainProcess.evaluate(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(updatePath)}] }); return true })()`)
  const update = await ui.evaluate('window.vast.extensions.installPackage()')
  assert(update.ok && update.preview.isUpdate, `Update preview failed: ${update.error ?? 'not an update'}`)
  const escalation = update.preview.permissionEscalation
  assert(!escalation.chrome.length && !escalation.hosts.length && !escalation.vast.length, `Update escalates permissions: ${JSON.stringify(escalation)}`)
  assert((await ui.evaluate(`window.vast.extensions.confirmInstall(${JSON.stringify(update.preview.token)})`)).ok, 'Update install failed.')
  await until(async () => (await ui.evaluate('window.vast.extensions.list()')).extensions.find((extension) => extension.id === translatorId && extension.version === '1.0.1' && extension.runtimeState === 'loaded'), 'updated extension loaded')
  const sw3 = await worker()
  const kept = await sw3.evaluate(`translatorDebug.engine({ type: 'engine:route', source: 'en', target: 'pl' })`)
  assert(kept.installed, 'The update lost the downloaded model.')
  await navigate(`${origin}/article?updated`)
  await guestWait(`document.getElementById('p1')`, 'article after update')
  const updatedTab = await sw3.evaluate('translatorDebug.tabInfo()')
  await sw3.evaluate(`translatorDebug.startPageTranslation(${updatedTab.tabId}, 'en', 'pl')`)
  await guestWait(`document.getElementById('h').textContent !== 'The weather is changing quickly this week'`, 'translation after update')
  pass('update 1.0.0 → 1.0.1 keeps models, no permission escalation')
  sw3.close()

  // ---------- Disable and remove ----------
  assert((await ui.evaluate(`window.vast.extensions.disable(${JSON.stringify(translatorId)})`)).ok, 'Disable failed.')
  await until(async () => !(await ui.evaluate('window.vast.extensions.contributions().then((reply) => reply.contributions)')).toolbar.some((entry) => entry.extensionId === translatorId && entry.available && entry.enabled !== false), 'toolbar gone or disabled')
  assert((await ui.evaluate(`window.vast.extensions.enable(${JSON.stringify(translatorId)})`)).ok, 'Enable failed.')
  await until(async () => (await ui.evaluate('window.vast.extensions.list()')).extensions.find((extension) => extension.id === translatorId)?.runtimeState === 'loaded', 'enabled again')
  assert((await ui.evaluate(`window.vast.extensions.remove(${JSON.stringify(translatorId)})`)).ok, 'Remove failed.')
  await until(async () => !(await ui.evaluate('window.vast.extensions.list()')).extensions.some((extension) => extension.id === translatorId), 'removed')
  assert(!(await ui.evaluate('window.vast.extensions.contributions().then((reply) => reply.contributions)')).toolbar.some((entry) => entry.extensionId === translatorId), 'Toolbar entry survived removal.')
  pass('disable, enable, remove')

  mainProcess.close()
  ui.close()
  server.close()
}

main().then(async () => {
  console.log(`Translator E2E passed: ${results.length} checks.`)
  await stop()
  process.exit(0)
}, async (error) => {
  console.error(error)
  console.error(`Passed before the failure: ${results.join(', ') || 'none'}`)
  await stop()
  process.exit(1)
})

async function stop() {
  if (!child || child.exitCode !== null) return
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } catch {
    // Already exited.
  }
  await new Promise((resolve) => child.once('exit', resolve))
}
