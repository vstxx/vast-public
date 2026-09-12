const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { connectRenderer, stopRun } = require('./performance-suite.cjs')
const root = path.resolve(__dirname, '..')
const executable = path.resolve(process.env.VAST_E2E_EXECUTABLE || path.join(root, 'release/win-unpacked/Vast.exe'))
const output = path.join(root, 'performance-results')
fs.mkdirSync(output, {recursive:true})
const profile = fs.mkdtempSync(path.join(output, 'production-pass-e2e-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { profile, executable, checks: [], radius: [], authenticatedRequests: [] }
let child, cdp, origin
const server = http.createServer((request, response) => {
  const url = new URL(request.url, origin || 'http://127.0.0.1')
  if (url.pathname === '/file') {
    const name = url.searchParams.get('name') || 'sample'
    const auth = url.searchParams.get('auth')
    report.authenticatedRequests.push({ name, cookie: request.headers.cookie || '' })
    if (auth && !request.headers.cookie?.includes(`identity=${auth}`)) { response.writeHead(403); response.end('Unauthorized'); return }
    const chunks = Number(url.searchParams.get('chunks') || 50)
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}.bin"`, 'Content-Length': chunks * 32768 })
    let sent = 0
    const timer = setInterval(() => { response.write(Buffer.alloc(32768, 65)); if (++sent >= chunks) { clearInterval(timer); response.end() } }, 100)
    response.on('close', () => clearInterval(timer))
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Set-Cookie': `identity=${url.searchParams.get('identity') || 'A'}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax` })
  response.end('<!doctype html><title>Production fixture</title><main>Authenticated download fixture</main><input autocomplete="username"><input type="password" autocomplete="current-password">')
})
async function until(expression, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { const result = await cdp.evaluate(`(async () => Boolean(await (${expression})))()`); if (result) return } catch (error) { last = error }
    await wait(80)
  }
  throw new Error(`Timed out: ${expression}${last ? '\n' + last : ''}`)
}
function check(name) { report.checks.push(name); console.log('PASS', name) }
async function launch() {
  const port = 10200 + Math.floor(Math.random() * 400)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_TEST_DOWNLOAD_DIR: path.join(profile, 'downloads'), VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(env.VAST_TEST_DOWNLOAD_DIR, { recursive: true })
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--vast-performance-report=${path.join(profile, 'probe.json')}`], { env, stdio: 'ignore', windowsHide: true })
  cdp = await connectRenderer(port)
  await until('window.vast?.downloads?.listCurrent && document.querySelector(".app-shell")')
}
async function stop() {
  if (child && cdp) {
    const closingChild = child, closingCdp = cdp
    child = cdp = undefined
    const result = await stopRun(closingChild, closingCdp)
    ;(report.closes ??= []).push(result)
    assert.ok(result.graceful, 'Application did not exit after closing its last browser window with enabled extensions')
  }
  await wait(800)
}
const current = () => cdp.evaluate('window.vast.downloads.listCurrent()')
const guest = () => `[...document.querySelectorAll('webview')].find(v => v.getBoundingClientRect().width > 0 && v.getBoundingClientRect().height > 0)`
async function download(name, chunks = 50, auth) {
  const url = `${origin}/file?name=${name}&chunks=${chunks}${auth ? '&auth=' + auth : ''}`
  await cdp.evaluate(`${guest()}.executeJavaScript(${JSON.stringify(`(() => { const a=document.createElement('a'); a.href=${JSON.stringify(url)}; a.download=''; document.body.append(a); a.click(); a.remove(); })()`)})`)
  await until(`window.vast.downloads.listCurrent().then(items => items.some(v => v.filename === '${name}.bin'))`)
  return (await current()).find((v) => v.filename === `${name}.bin`)
}
async function switchWorkspace(name) {
  await cdp.evaluate(`document.querySelector('button[title="Switch workspace"]').click()`)
  await until(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('${name}') && !b.title)`)
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('${name}') && !b.title).click()`)
  await until(`document.querySelector('button[title="Switch workspace"]').getAttribute('aria-label') === 'Switch workspace. Current: ${name}'`)
}
async function navigate(url) {
  await cdp.evaluate(`(() => { const input=document.querySelector('input[placeholder="Search or enter address"]'); input.focus(); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,${JSON.stringify(url)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await cdp.evaluate(`document.querySelector('input[placeholder="Search or enter address"]').form.requestSubmit()`)
  await until(`${guest()}?.executeJavaScript(${JSON.stringify('location.href === ' + JSON.stringify(url))})`)
}
async function radiusChecks() {
  await cdp.evaluate(`document.querySelector('button[aria-label="Dismiss Vast message"]')?.click()`)
  await cdp.evaluate(`document.querySelector('button[title="More browser tools"]').click()`)
  await until(`document.querySelector('.browser-tools-menu')`)
  await cdp.evaluate(`[...document.querySelectorAll('.browser-tools-menu button')].find(b=>b.textContent.trim()==='Settings').click()`)
  await until('document.querySelector(".settings-nav-item")')
  await cdp.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find(b => b.textContent.includes('Appearance')).click()`)
  await until(`[...document.querySelectorAll('label')].some(l=>l.textContent.startsWith('Corner radius'))`)
  await cdp.evaluate(`${guest()}.send('vast:password-autofill-config', {enabled:true,suggestions:[{id:'test',username:'radius-fixture',title:'Fixture'}],theme:'dark',accent:'#aabbcc',radius:21})`)
  await until(`${guest()}?.executeJavaScript('Boolean(document.getElementById("__vast_af_root"))')`)
  const guestIds = await cdp.evaluate(`[...document.querySelectorAll('webview')].map(v => v.getWebContentsId())`)
  const factors = { micro: .16, checkbox: .28, swatch: .28, control: .54, card: 1, panel: 1.15, modal: 1.3 }
  for (const radius of [6, 21, 36]) {
    await cdp.evaluate(`(() => { const input=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('Corner radius')).querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${radius}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await until(`getComputedStyle(document.documentElement).getPropertyValue('--vast-radius-base').trim() === '${radius}px'`)
    const samples = await cdp.evaluate(`(() => {
      const shell=document.querySelector('.app-shell');
      const results={};
      for (const token of ${JSON.stringify(Object.keys(factors))}) {
        const sample=document.createElement('div'); sample.className='rounded-'+token; sample.style.borderRadius='var(--vast-radius-'+token+')'; sample.style.cssText+='position:fixed;width:300px;height:300px;visibility:hidden'; shell.append(sample); results[token]=parseFloat(getComputedStyle(sample).borderTopLeftRadius); sample.remove();
      }
      results.iconButton=parseFloat(getComputedStyle(document.querySelector('button[title="Switch workspace"]')).borderTopLeftRadius);
      results.modal=parseFloat(getComputedStyle(document.querySelector('[role="dialog"]')).borderTopLeftRadius);
      return results;
    })()`)
    // Checkbox semantic probe is measured separately from browser-specific slider pseudo styles.
    for (const [token, factor] of Object.entries(factors)) assert.ok(Math.abs(samples[token] - radius * factor) < .06, `${token} at ${radius}: ${samples[token]}`)
    assert.ok(Math.abs(samples.iconButton - radius * .54) < .06)
    const autofill = await cdp.evaluate(`${guest()}.executeJavaScript('(() => { const root=document.getElementById("__vast_af_root"); return {radius:parseFloat(getComputedStyle(root).borderTopLeftRadius),closed:root.shadowRoot === null}; })()')`)
    assert.ok(autofill.closed && Math.abs(autofill.radius - radius * .54) < .06, 'Closed autofill host did not follow radius bridge')
    report.radius.push({ radius, samples, autofill })
    const screenshot = await cdp.send('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(output, `production-radius-${radius}.png`), Buffer.from(screenshot.data,'base64'))
    assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('webview')].map(v => v.getWebContentsId())`), guestIds, 'Changing radius recreated a guest')
  }
  check('computed semantic/control/modal styles at 6 / 21 / 36; no guest recreation')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const data = structuredClone((await import(require('node:url').pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.openingAnimation = false
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.settings.security.warnDangerousDownloads = false
  data.settings.appearance.cornerRadius = 21
  data.activeSidePanel = 'downloads'; data.sidePanelOpen = true; data.downloads = []
  const base = data.workspaces[0], now = Date.now()
  data.workspaces = ['Isolated A', 'Isolated B', 'Shared', 'Private'].map((name, i) => ({ ...base, id: `pass-${i}`, name, order: i, isPrivate: i === 3, activeTabId: `pass-tab-${i}`, identity: { ...base.identity, sessionMode: i === 3 ? 'ephemeral' : i === 2 ? 'shared' : 'isolated' } }))
  data.activeWorkspaceId = data.workspaces[0].id
  data.tabs = data.workspaces.filter(w => !w.isPrivate).map((w, i) => ({ id: `pass-tab-${i}`, workspaceId: w.id, title: w.name, url: `${origin}/?identity=${i === 1 ? 'B' : 'A'}`, pinned: false, status: 'idle', lifecycle: i ? 'discarded' : 'active', progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: now, lastAccessedAt: now }))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))
  fs.mkdirSync(path.join(profile, 'Extensions'))
  fs.writeFileSync(path.join(profile, 'Extensions/registry.json'), JSON.stringify({ schemaVersion: 1, extensions: [{ id: 'ighghepofocdonohadbmkbgmphppdagk', name: 'Vast Content Script Fixture', version: '1.0.0', path: path.join(root, 'tests/fixtures/extensions/content-script-basic'), enabled: true, source: 'unpacked', runtime: 'chrome', manifestVersion: 3, installedAt: now, updatedAt: now, allowFileAccess: false }] }))
  const nativePath = path.join(root, 'tests/fixtures/extensions/vast-native-basic')
  const nativeId = require('node:crypto').createHash('sha256').update(nativePath.toLowerCase()).digest('hex').slice(0,32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n,16)))
  const registryPath = path.join(profile, 'Extensions/registry.json')
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  registry.schemaVersion = 2
  registry.extensions.push({ id: nativeId, name: 'Vast Native Basic', version: '1.0.0', path: nativePath, enabled: true, source: 'unpacked', runtime: 'vast', manifestVersion: 3, installedAt: now, updatedAt: now, allowFileAccess: false, grantedPermissions: ['vast.storage','vast.theme','vast.toolbar','vast.sidebar','vast.commands','vast.contextMenus','vast.notifications'] })
  fs.writeFileSync(registryPath, JSON.stringify(registry))
  try {
    await launch()
    await until(`${guest()}?.executeJavaScript('document.documentElement.dataset.vastExtensionFixture === "content-script-loaded"')`)
    check('enabled startup extension loaded in isolated workspace before download')
    await until('window.vast.extensions.contributions().then(r => r.contributions?.theme?.tokens?.cornerRadius === 18)')
    check('native theme is active; global user radius takes precedence over its radius token')
    await until(`getComputedStyle(document.documentElement).getPropertyValue('--vast-radius-base').trim() === '21px'`)
    await switchWorkspace('Private'); await navigate(`${origin}/?identity=P`)
    const privateItem = await download('private', 35, 'P')
    await until(`window.vast.downloads.listCurrent().then(items => items.some(v => v.id === '${privateItem.id}' && v.state === 'completed'))`)
    await switchWorkspace('Isolated A')
    await until(`${guest()}?.executeJavaScript('document.title === "Production fixture"')`)
    const a = await download('auth-retry', 180, 'A')
    await until(`window.vast.downloads.listCurrent().then(items => items.some(v => v.id === '${a.id}' && v.receivedBytes > 0))`)
    assert.equal((await cdp.evaluate(`window.vast.downloads.cancel('${a.id}')`)).ok, true)
    await until(`window.vast.downloads.listCurrent().then(items => items.some(v => v.id === '${a.id}' && v.state === 'cancelled'))`)
    await switchWorkspace('Isolated B')
    await until(`${guest()}?.executeJavaScript('document.title === "Production fixture"')`)
    assert.equal((await cdp.evaluate(`window.vast.downloads.retry('${a.id}')`)).ok, true)
    const b = await download('isolated-b', 180, 'B')
    for (let i = 0; i < 3; i++) await download(`parallel-${i}`, 180, 'B')
    await until(`window.vast.downloads.listCurrent().then(items => items.filter(v => v.state === 'progressing' && v.receivedBytes > 0).length >= 5)`)
    await until(`document.querySelector('.side-panel')?.innerText.includes('isolated-b.bin')`)
    check('five simultaneous live downloads and sidebar progress; retry preserves A authentication while B is active')
    // A stale renderer durable save must not erase transfers or persist private history.
    const stale = structuredClone(data); stale.downloads = []
    assert.equal((await cdp.evaluate(`window.vast.storage.save(${JSON.stringify(stale)})`)).ok, true)
    await cdp.send('Page.reload')
    await until('window.vast?.downloads?.listCurrent && document.querySelector(".app-shell")')
    await until(`document.querySelector('.side-panel')?.innerText.includes('isolated-b.bin')`)
    assert.ok((await current()).some(v => v.id === b.id && v.state === 'progressing'))
    check('renderer reload restores active progress and sidebar history from main snapshot')
    await until(`window.vast.downloads.listCurrent().then(items => items.filter(v=>v.state === 'progressing').length === 0)`, 45000)
    const completed = (await current()).filter(v => v.state === 'completed' && v.filename !== 'private.bin')
    assert.equal(completed.length, 5)
    const persistent = JSON.parse(fs.readFileSync(path.join(profile, 'vast-data.json'), 'utf8')).downloads
    assert.equal(persistent.filter(v => v.state === 'completed').length, 5)
    assert.ok(!persistent.some(v => v.filename === 'private.bin'))
    check('all simultaneous completions durable; private transfer absent from disk after renderer save')
    await radiusChecks()
    await stop(); await launch()
    await until(`getComputedStyle(document.documentElement).getPropertyValue('--vast-radius-base').trim() === '36px'`)
    const restored = await current()
    assert.equal(restored.filter(v => v.state === 'completed').length, 5)
    assert.ok(!restored.some(v => v.filename === 'private.bin'))
    await until(`document.querySelector('.side-panel')?.innerText.includes('isolated-b.bin')`)
    assert.equal((await cdp.evaluate(`window.vast.downloads.retry('${a.id}')`)).ok, true)
    await until(`window.vast.downloads.listCurrent().then(items => items.some(v=>v.filename === 'auth-retry.bin' && v.state === 'progressing'))`)
    const retry = (await current()).find(v=>v.filename === 'auth-retry.bin' && v.state === 'progressing')
    await cdp.evaluate(`window.vast.downloads.cancel('${retry.id}')`)
    check('restart retains history and radius; authenticated retry reopens original persistent partition')
    await switchWorkspace('Shared')
    await until(`${guest()}?.executeJavaScript('document.title === "Production fixture"')`)
    const shared = await download('shared', 10, 'A')
    assert.equal(shared.sourcePartition, 'persist:vast-default')
    await until(`window.vast.downloads.listCurrent().then(items => items.some(v=>v.id === '${shared.id}' && v.state === 'completed'))`)
    check('shared workspace download completes through same service')
    await stop()
  } catch (error) {
    report.failure = { message: error.message, ui: await cdp?.evaluate(`({text:document.body.innerText.slice(0,2000),views:[...document.querySelectorAll('webview')].map(v=>({partition:v.partition,url:v.getURL(),width:v.getBoundingClientRect().width}))})`).catch(()=>undefined) };
    throw error
  } finally {
    await stop().catch(() => {})
    server.closeAllConnections(); server.close()
    fs.writeFileSync(path.join(output, 'production-pass-e2e.json'), JSON.stringify(report, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
