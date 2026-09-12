// Exercises real Electron guest context events and renderer mouse dispatch in an isolated profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { CdpSession, connectRenderer, stopRun } = require('./performance-suite.cjs')
const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vast-menus-'))
const report = { checks: [] }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let cdp, child
const guest = `([...document.querySelectorAll('webview')].find(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0))`
async function until(expression) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    if (await cdp.evaluate(`(async () => Boolean(await (${expression})))()`).catch(() => false)) return
    await wait(100)
  }
  throw new Error('Timed out: ' + expression)
}
function check(name) { report.checks.push(name); console.log('PASS', name) }
async function click(expression, button = 'left') {
  const point = await cdp.evaluate(`(() => { const e=${expression}; if(!e)throw Error('Missing target'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
}
async function menu(extra = {}) {
  // The guest's context-menu payload is normally produced by Chromium. Keeping
  // it explicit also covers selection/media states without depending on fonts.
  await cdp.evaluate(`(() => { const v=${guest}; const event=new Event('context-menu'); event.params={x:120,y:100,...${JSON.stringify(extra)}}; v.dispatchEvent(event); })()`)
  await until(`document.querySelector('[role="menu"]')`)
}
async function action(label) {
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`)
  await until(`!document.querySelector('[role="menu"]')`)
}
async function dismiss() {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end(`<!doctype html><title>Menu fixture ${request.url}</title><p id="quote">Menu test selection</p><a href="/page-b">Next page</a><input id="edit" value="editable fixture"><p>Menu fixture content</p>`)
})
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const data = structuredClone((await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.layoutMode = 'horizontal'
  data.settings.openingAnimation = false
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.settings.advanced.developerMode = true
  const workspace = data.workspaces[0]
  workspace.activeTabId = 'menu-0'
  data.activeWorkspaceId = workspace.id
  data.tabs = Array.from({ length: 18 }, (_, i) => ({ id: `menu-${i}`, workspaceId: workspace.id, title: `Fixture ${i}`, url: `${origin}/page-${i}`, pinned: false, status: 'idle', lifecycle: i ? 'discarded' : 'active', progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: i + 1, lastAccessedAt: i + 1 }))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const port = 10600 + Math.floor(Math.random() * 300)
  child = spawn(require('electron'), [path.join(root, 'out/main/main.js'), `--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true })
  cdp = await connectRenderer(port)
  report.exceptions = []
  cdp.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') report.exceptions.push(message.params.exceptionDetails) })
  await until(`window.vast?.relay && document.querySelector('.horizontal-chrome')`)
  if (await cdp.evaluate('window.vast.relay.state().then(state => state.enabled)')) {
    await until(`document.querySelector('button[aria-label="Dismiss Vast message"]')`)
    await cdp.evaluate(`document.querySelector('button[aria-label="Dismiss Vast message"]').click()`)
    await until(`!document.querySelector('button[aria-label="Dismiss Vast message"]')`)
  }
  await until(`${guest}?.getURL().includes('/page-0')`)
  await wait(600)

  await click(`document.querySelector('button[title="More tabs"]')`)
  await until(`document.querySelector('[role="dialog"] input[placeholder="Search title or address"]')`)
  assert.ok(await cdp.evaluate(`(() => { const m=document.querySelector('[role="dialog"]'); const r=m.getBoundingClientRect(); return m.parentElement===document.body && r.bottom<=innerHeight && r.left>=0 && m.contains(document.elementFromPoint(r.left+20,r.top+20)) && getComputedStyle(m).webkitAppRegion==='no-drag'; })()`))
  await click(`document.querySelector('[role="dialog"] input')`)
  await cdp.send('Input.insertText', { text: 'Fixture 17' })
  await until(`document.querySelectorAll('[data-overflow-tab-id]').length === 1`)
  await click(`document.querySelector('[data-overflow-tab-id="menu-17"] button')`)
  await until(`${guest}?.getURL().includes('/page-17')`)
  await until(`!${guest}.isLoading()`)
  await until(`${guest}.executeJavaScript('document.body?.innerText.includes("Menu fixture content")')`)
  check('overflow portal: above chrome, bounded to viewport, searchable, activates discarded tab')

  // Dispatch into the guest's own CDP target; host CDP input does not reliably
  // cross Electron's native guest boundary on Windows.
  await cdp.evaluate(`${guest}.addEventListener('context-menu', () => { window.__menuEvents=(window.__menuEvents||0)+1 })`)
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find(t => t.url === origin + '/page-17')
  assert.ok(target, 'Guest debugging target must exist')
  const guestCdp = await CdpSession.connect(target.webSocketDebuggerUrl)
  try {
    await guestCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 180, y: 180, button: 'right', clickCount: 1 })
    await guestCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 180, y: 180, button: 'right', clickCount: 1 })
    await until(`document.querySelector('[role="menu"]')`)
    assert.ok(await cdp.evaluate('window.__menuEvents > 0'))
  } finally { guestCdp.close() }
  await dismiss()
  check('Chromium guest right click opens accessible menu')

  await cdp.evaluate(`${guest}.executeJavaScript('document.querySelector("a").click()')`)
  await until(`${guest}.getURL().endsWith('/page-b') && !${guest}.isLoading()`)
  await menu()
  await action('Back')
  await until(`${guest}.getURL().endsWith('/page-17') && !${guest}.isLoading()`)
  await menu()
  await action('Forward')
  await until(`${guest}.getURL().endsWith('/page-b') && !${guest}.isLoading()`)
  await cdp.evaluate(`${guest}.executeJavaScript('window.__reloadMarker = true')`)
  await menu()
  await action('ReloadCtrl/Cmd+R')
  await until(`${guest}.executeJavaScript('window.__reloadMarker !== true')`)
  await menu()
  await action('Back')
  await until(`${guest}.getURL().endsWith('/page-17') && !${guest}.isLoading()`)
  check('back, forward and reload navigate the original guest')

  await menu({ selectionText: 'Menu test selection' })
  await action('Copy selection')
  if (process.platform === 'win32') {
    const copied = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-Clipboard -Raw).Trim() -eq 'Menu test selection'"], { encoding: 'utf8', windowsHide: true })
    assert.equal(copied.trim(), 'True')
  }
  await menu()
  await action('Copy page URL')
  check('selection and page URL copy through trusted IPC')

  await menu()
  await action('Toggle bookmark')
  await until(`window.vast.storage.load().then(d=>d.bookmarks.some(b=>b.url===${JSON.stringify(origin + '/page-17')}))`)
  await menu()
  await action('Toggle bookmark')
  await until(`window.vast.storage.load().then(d=>!d.bookmarks.some(b=>b.url===${JSON.stringify(origin + '/page-17')}))`)
  check('bookmark adds and removes the menu page')

  await menu()
  await action('Find in pageCtrl/Cmd+F')
  await until(`document.querySelector('input[placeholder="Find in page"]')`)
  await click(`document.querySelector('input[placeholder="Find in page"]')`)
  await cdp.send('Input.insertText', { text: 'fixture' })
  await click(`document.querySelector('button[title="Close find"]')`)
  check('find opens, accepts text and closes')

  await menu()
  await action('Mute this site')
  assert.equal(await cdp.evaluate(`${guest}.isAudioMuted()`), true)
  await menu()
  await action('Unmute this site')
  assert.equal(await cdp.evaluate(`${guest}.isAudioMuted()`), false)
  check('mute and unmute affect the original guest')

  await menu({ selectionText: 'Saved quote fixture' })
  await action('Save quote')
  await until(`window.vast.storage.load().then(d=>d.notes.some(n=>n.body.includes('Saved quote fixture')))`)
  await menu()
  await action('Create note')
  await until(`window.vast.storage.load().then(d=>d.notes.some(n=>n.title.startsWith('Note for Menu fixture')))`)
  await menu()
  await action('Reading list')
  await until(`window.vast.storage.load().then(d=>d.readingList.some(n=>n.url===${JSON.stringify(origin + '/page-17')}))`)
  check('quote, page note and reading list persist and expose their side panel')

  await menu({ linkURL: origin + '/page-b' })
  await action('Copy link address')
  await menu({ isEditable: true, editFlags: { canUndo: false, canPaste: true } })
  assert.equal(await cdp.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='Undo').disabled`), true)
  await dismiss()
  check('link copy and editable capability flags')

  await cdp.evaluate(`window.vast.browser.writeClipboardText('Pasted by browser menu')`)
  await cdp.evaluate(`${guest}.executeJavaScript('document.querySelector("#edit").focus(); document.querySelector("#edit").select()')`)
  await menu({ isEditable: true })
  await action('Paste')
  await until(`${guest}.executeJavaScript('document.querySelector("#edit").value === "Pasted by browser menu"')`)
  await menu({ isEditable: true })
  await action('Select all')
  await menu({ isEditable: true })
  await action('Cut')
  await until(`${guest}.executeJavaScript('document.querySelector("#edit").value === ""')`)
  await menu({ isEditable: true })
  await action('Undo')
  await until(`${guest}.executeJavaScript('document.querySelector("#edit").value === "Pasted by browser menu"')`)
  await menu({ isEditable: true })
  await action('Redo')
  await until(`${guest}.executeJavaScript('document.querySelector("#edit").value === ""')`)
  check('paste, select all, cut, undo and redo edit the original input')

  await menu({ linkURL: 'javascript:alert(1)' })
  assert.equal(await cdp.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent.startsWith('Open link'))`), false)
  await dismiss()
  check('unsafe links cannot launch a new tab from the menu')

  await menu()
  await action('Inspect element')
  await until(`${guest}.isDevToolsOpened()`)
  await cdp.evaluate(`${guest}.closeDevTools()`)
  check('inspect opens guest developer tools')

  await menu({ linkURL: origin + '/new-link' })
  await click(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.startsWith('Open link in new tab'))`)
  await until(`${guest}.getURL().endsWith('/new-link')`)
  check('open link creates and activates a new tab')
}
main().catch(async error => {
  report.error = String(error.stack || error)
  if (cdp) {
    report.renderer = await cdp.evaluate(`({text:document.body.innerText.slice(-1200), guests:[...document.querySelectorAll('webview')].map(v=>({url:v.getURL(),rect:v.getBoundingClientRect().toJSON()}))})`).catch(() => undefined)
    report.guest = await cdp.evaluate(`${guest}.executeJavaScript('({url:location.href,html:document.documentElement.outerHTML.slice(0,1000)})')`).catch(error => String(error))
    const shot = await cdp.send('Page.captureScreenshot').catch(() => undefined)
    if (shot) fs.writeFileSync(path.join(root, 'performance-results/menus-failure.png'), Buffer.from(shot.data, 'base64'))
  }
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  if (child && cdp) await stopRun(child, cdp)
  else child?.kill()
  server.closeAllConnections(); server.close()
  fs.writeFileSync(path.join(root, 'performance-results/menus-e2e.json'), JSON.stringify(report, null, 2))
})
