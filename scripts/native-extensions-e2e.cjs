const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourceFixture = path.join(root, 'tests/fixtures/extensions/vast-native-basic')
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-native-extension-e2e-'))
const fixturePath = path.join(testRoot, 'extension')
const userDataDir = path.join(testRoot, 'profile')
const electronExecutable = require('electron')
let child
let probeServer
let probeHits = 0

function idFor(extensionPath) {
  const input = Buffer.from(process.platform === 'win32' ? extensionPath.toLowerCase() : extensionPath)
  const digest = createHash('sha256').update(input).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}
function assert(value, message) { if (!value) throw new Error(message) }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function json(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return response.json() } catch {}
    await wait(200)
  }
  throw new Error(`Could not connect to ${url}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 1; this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data); const pending = this.pending.get(message.id); if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result)
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    const cdp = new Cdp(socket); await cdp.send('Runtime.enable'); return cdp
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.next++; const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, 20_000)
      this.pending.set(id, { resolve, reject, timeout }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.socket.close() }
}

async function target(port, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = (await json(`http://127.0.0.1:${port}/json/list`)).find(predicate)
    if (found) return Cdp.connect(found.webSocketDebuggerUrl)
    await wait(200)
  }
  throw new Error('Expected Electron target was not exposed.')
}

async function until(operation, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const value = await operation().catch(() => undefined); if (predicate(value)) return value; await wait(200) }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function stop() {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {} }
  else child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve)); child = undefined
}

async function main() {
  probeServer = http.createServer((_request, response) => { probeHits += 1; response.end('unexpected') })
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
  const probePort = probeServer.address().port
  fs.cpSync(sourceFixture, fixturePath, { recursive: true })
  const manifestPath = path.join(fixturePath, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.vast.popup = 'popup.html'
  manifest.vast.options = 'options.html'
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(fixturePath, 'popup.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Native popup</title><style>body{margin:0;padding:18px;background:#0b0c11;color:#f5f7fa;font:14px system-ui}</style></head><body data-native-popup="ready"><strong>Native custom popup</strong><p id="state">Loading</p><script type="module" src="popup.js"></script></body></html>', 'utf8')
  fs.writeFileSync(path.join(fixturePath, 'popup.js'), "const state = await vast.storage.local.get('started'); document.querySelector('#state').textContent = state.started ? 'Storage connected' : 'Storage unavailable'\n", 'utf8')
  fs.writeFileSync(path.join(fixturePath, 'options.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Native options</title></head><body data-native-options="ready">Native options</body></html>', 'utf8')
  fs.appendFileSync(path.join(fixturePath, 'vast-background.js'), `\nlet networkBlocked=false;try{await fetch('http://127.0.0.1:${probePort}/probe')}catch{networkBlocked=true}\nawait vast.storage.local.set({sandbox:{requireType:typeof globalThis.require,processType:typeof globalThis.process,ipcRendererType:typeof globalThis.ipcRenderer},networkBlocked,popupBlocked:window.open('https://example.com')===null})\n`)
  const extensionId = idFor(fixturePath); const now = Date.now(); const registryDir = path.join(userDataDir, 'Extensions')
  fs.mkdirSync(registryDir, { recursive: true })
  fs.writeFileSync(path.join(registryDir, 'registry.json'), `${JSON.stringify({ schemaVersion: 2, extensions: [{ id: extensionId, name: 'Vast Native Basic', version: '1.0.0', description: 'Deterministic Vast Native API v1 fixture.', path: fixturePath, enabled: true, source: 'unpacked', runtime: 'vast', manifestVersion: 3, installedAt: now, updatedAt: now, allowFileAccess: false, grantedPermissions: ['vast.storage','vast.theme','vast.toolbar','vast.sidebar','vast.commands','vast.contextMenus','vast.notifications'] }] }, null, 2)}\n`)
  const port = 10040 + Math.floor(Math.random() * 200); const stdout = []; const stderr = []; const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userDataDir, VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1' }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electronExecutable, [`--remote-debugging-port=${port}`, root], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => stdout.push(String(data))); child.stderr.on('data', (data) => stderr.push(String(data)))
  const renderer = await target(port, (item) => item.type === 'page' && item.url.includes('index.html'))
  const info = await until(() => renderer.eval('window.vast.extensions.list()'), (value) => value?.extensions?.some((extension) => extension.id === extensionId && extension.native?.state === 'running'), 'native runtime')
  const nativeExtension = info.extensions.find((extension) => extension.id === extensionId)
  assert(nativeExtension.kind === 'vast', 'Native extension kind was not exposed.')
  assert(nativeExtension.ui.popup && nativeExtension.ui.options, 'Native custom popup and options surfaces were not exposed.')
  const contributions = await until(() => renderer.eval('window.vast.extensions.contributions()'), (value) => value?.contributions?.toolbar?.length === 1 && value?.contributions?.sidebar?.length === 1 && value?.contributions?.commands?.length === 1, 'native contributions')
  assert(contributions.contributions.theme.tokens.accentColor === '#8b5cf6', 'Theme overlay was not registered.')
  const storageFile = path.join(userDataDir, 'Extensions', 'Data', extensionId, 'storage.json')
  const stored = await until(async () => JSON.parse(fs.readFileSync(storageFile, 'utf8')), (value) => value?.sandbox?.requireType === 'undefined' && value?.networkBlocked === true && value?.popupBlocked === true, 'sandbox evidence')
  assert(stored.sandbox.processType === 'undefined' && stored.sandbox.ipcRendererType === 'undefined', 'Node or raw IPC leaked into the extension global.')
  assert(probeHits === 0, 'Native extension network request reached the local probe server.')
  const host = await target(port, (item) => item.type === 'page' && item.url.startsWith(`vast-extension://${extensionId}/`))
  assert(await host.eval("typeof require === 'undefined' && typeof process === 'undefined' && typeof ipcRenderer === 'undefined'"), 'Sandbox target exposed privileged globals.')
  const surfaceCheck = await renderer.eval(`(async () => {
    const contributions = await window.vast.extensions.contributions();
    const key = contributions.contributions.sidebar[0].key;
    const prepared = await window.vast.extensions.prepareSidebar(key);
    if (!prepared.ok) throw new Error(prepared.error);
    const view = document.createElement('webview');
    view.id = 'native-e2e-sidebar'; view.setAttribute('src', prepared.surface.src); view.setAttribute('partition', prepared.surface.partition);
    view.style.width = '320px'; view.style.height = '400px'; document.body.appendChild(view);
    await new Promise((resolve, reject) => { const timeout=setTimeout(()=>reject(new Error('sidebar timeout')),10000); view.addEventListener('dom-ready',()=>{clearTimeout(timeout);resolve()}, {once:true}); });
    return view.executeJavaScript("(async()=>{for(let attempt=0;attempt<100;attempt+=1){if(typeof globalThis.vast?.storage?.local?.get==='function')return globalThis.vast.storage.local.get('started').then(data=>({title:document.title,requireType:typeof require,processType:typeof process,hasVast:true,sharedOwnerStorage:data.started===true}));await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Vast sidebar API was not ready')})()", true);
  })()`)
  assert(surfaceCheck.title === 'Native example' && surfaceCheck.requireType === 'undefined' && surfaceCheck.processType === 'undefined' && surfaceCheck.hasVast && surfaceCheck.sharedOwnerStorage, 'Sidebar surface was not isolated, authenticated, or did not receive its bounded Vast API.')
  const popupCheck = await renderer.eval(`(async () => {
    const prepared = await window.vast.extensions.prepareSurface('${extensionId}', 'popup', 'persist:vast-workspace-workspace-default');
    if (!prepared.ok) throw new Error(prepared.error);
    const view = document.createElement('webview');
    view.id = 'native-e2e-popup'; view.setAttribute('src', prepared.surface.src); view.setAttribute('partition', prepared.surface.partition);
    view.style.width = '360px'; view.style.height = '400px'; document.body.appendChild(view);
    await new Promise((resolve, reject) => { const timeout=setTimeout(()=>reject(new Error('popup timeout')),10000); view.addEventListener('dom-ready',()=>{clearTimeout(timeout);resolve()}, {once:true}); });
    return view.executeJavaScript("(async()=>{for(let attempt=0;attempt<100;attempt+=1){const storage=document.querySelector('#state')?.textContent;if(typeof globalThis.vast?.storage?.local?.get==='function'&&document.body.dataset.nativePopup==='ready'&&storage==='Storage connected')return {ready:true,storage,hasVast:true,requireType:typeof require};await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Vast popup API was not ready')})()", true);
  })()`)
  assert(popupCheck.ready && popupCheck.storage === 'Storage connected' && popupCheck.hasVast && popupCheck.requireType === 'undefined', 'Native toolbar popup was not isolated, authenticated, or connected to owner storage.')
  await renderer.eval(`window.vast.extensions.disable('${extensionId}')`)
  await until(() => renderer.eval('window.vast.extensions.contributions()'), (value) => value?.contributions?.toolbar?.length === 0 && !value?.contributions?.theme, 'contribution cleanup')
  await renderer.eval(`window.vast.extensions.remove('${extensionId}')`)
  assert(!fs.existsSync(path.dirname(storageFile)), 'Uninstall did not remove native extension storage.')
  assert(fs.existsSync(fixturePath), 'Uninstall deleted the unpacked source directory.')
  host.close(); renderer.close(); await stop()
  assert(!stderr.some((line) => /uncaught|unhandled rejection/i.test(line)), `Unexpected Electron stderr: ${stderr.join('')}`)
  console.log('PASS Vast native extensions Electron E2E: isolated host/sidebar/custom popup, authenticated API storage, contributions, network/popup blocking, sandbox globals, disable cleanup, and uninstall cleanup.')
}

async function cleanup() {
  if (probeServer) await new Promise((resolve) => probeServer.close(resolve))
  await stop()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 19) throw error
      await wait(200)
    }
  }
}
main().then(cleanup, async (error) => { console.error(error); await cleanup(); process.exitCode = 1 })
