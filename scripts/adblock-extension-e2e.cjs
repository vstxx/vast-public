const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourceFixturePath = path.resolve(root, 'tests/fixtures/extensions/content-script-basic')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-adblock-extension-e2e-'))
const fixturePath = path.join(userDataDir, 'extension-fixture')
const artifactsDirectory = path.join(root, '.vast-test-artifacts')
const packagedExecutable = process.env.VAST_E2E_EXECUTABLE ? path.resolve(process.env.VAST_E2E_EXECUTABLE) : undefined
const electronExecutable = packagedExecutable ?? require('electron')
let appProcess
let pageServer

const assertionTimeout = process.env.CI === 'true' ? 60_000 : 20_000

const fixtureId = 'ighghepofocdonohadbmkbgmphppdagk'
function seedRegistry() {
  const registryDirectory = path.join(userDataDir, 'Extensions')
  const now = Date.now()
  fs.mkdirSync(registryDirectory, { recursive: true })
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: fixtureId,
      name: 'Adblocker for Vast',
      version: '1.0.0',
      description: 'Deterministic unpacked extension fixture for Vast runtime tests.',
      path: fixturePath,
      enabled: true,
      source: 'unpacked',
      runtime: 'chrome',
      manifestVersion: 2,
      installedAt: now,
      updatedAt: now,
      allowFileAccess: false
    }]
  }, null, 2)}\n`, 'utf8')
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function fetchJson(url, retries = 80) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Wait for the remote debugger.
    }
    await wait(250)
  }
  throw new Error(`Could not connect to ${url}`)
}

class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const session = new CdpSession(socket)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out.`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result.value
  }

  close() {
    this.socket.close()
  }

  async screenshot(fileName) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.mkdirSync(artifactsDirectory, { recursive: true })
    const outputPath = path.join(artifactsDirectory, fileName)
    fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'))
    return outputPath
  }
}

async function connectToRenderer(remotePort) {
  let target
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
    target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'))
    if (target) break
    await wait(250)
  }
  assert(target, 'No Vast renderer target was exposed by Electron.')
  return CdpSession.connect(target.webSocketDebuggerUrl)
}

async function waitFor(session, expression, label, timeout = assertionTimeout) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await session.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await wait(250)
  }
  const body = await session.evaluate('document.body.innerText').catch(() => '')
  throw new Error(`Timed out waiting for ${label}. Body: ${String(body).slice(0, 800)}`)
}

async function setAddress(session, value) {
  await session.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === 'Search or enter address');
    if (!input?.form) throw new Error('Address bar was not found.');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`)
}

async function executeInActiveWebview(session, expression) {
  return session.evaluate(`(() => {
    const webview = [...document.querySelectorAll('webview.browser-webview')].find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!webview) throw new Error('Active website webview was not found.');
    return webview.executeJavaScript(${JSON.stringify(expression)}, true);
  })()`)
}

async function guestMatches(session, expression, timeout) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await executeInActiveWebview(session, expression).catch(() => false)) return true
    await wait(250)
  }
  return false
}

async function waitForGuest(session, expression, label, timeout = assertionTimeout) {
  if (await guestMatches(session, expression, timeout)) return
  const state = await executeInActiveWebview(
    session,
    `({ href: location.href, readyState: document.readyState, dataset: { ...document.documentElement.dataset }, body: document.body?.innerText?.slice(0, 400) ?? '' })`
  ).catch((error) => ({ inspectionError: String(error) }))
  throw new Error(`Timed out waiting for website assertion: ${label}. State: ${JSON.stringify(state)}`)
}

async function executeInExtensionSurface(session, expression) {
  return session.evaluate(`(() => {
    const webview = document.querySelector('webview.extension-toolbar-surface');
    if (!webview) throw new Error('Extension toolbar surface was not found.');
    return webview.executeJavaScript(${JSON.stringify(expression)}, true);
  })()`)
}

async function waitForExtensionSurface(session, expression, label, timeout = assertionTimeout) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await executeInExtensionSurface(session, expression).catch(() => false)) return
    await wait(200)
  }
  throw new Error(`Timed out waiting for extension toolbar assertion: ${label}`)
}

async function waitForStorage(session, predicate, label, timeout = assertionTimeout) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const matched = await session.evaluate(`window.vast.storage.load().then((data) => Boolean((${predicate})(data)))`).catch(() => false)
    if (matched) return
    await wait(250)
  }
  throw new Error(`Timed out waiting for stored browser state: ${label}`)
}

function launch(remotePort, hubOrigin) {
  const stdout = []
  const stderr = []
  const launchEnvironment = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: userDataDir,
    VAST_RELAY_ENABLED: '0',
    VAST_RELAY_TEST_OFFLINE: '1',
    VAST_EXTENSIONS_HUB_ORIGIN: hubOrigin
  }
  delete launchEnvironment.ELECTRON_RUN_AS_NODE
  const launchArgs = packagedExecutable ? [`--remote-debugging-port=${remotePort}`] : [`--remote-debugging-port=${remotePort}`, root]
  const child = spawn(electronExecutable, launchArgs, {
    cwd: root,
    windowsHide: true,
    env: launchEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  appProcess = child
  return { child, stdout, stderr }
}

async function stop(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // Process may have closed between the check and taskkill.
    }
  } else {
    child.kill('SIGTERM')
  }
  await new Promise((resolve) => child.once('exit', resolve))
  if (appProcess === child) appProcess = undefined
}


async function run() {
  const { parseVextPackage } = await import('../src/shared/vext-format.ts')
  const parsed = await parseVextPackage(new Uint8Array(fs.readFileSync(path.join(root,'artifacts/Adblocker-for-Vast-1.0.0.vext'))))
  assert(parsed.metadata.extension_id===fixtureId,'Package identity mismatch')
  for(const [name,bytes] of parsed.files){ const target=path.resolve(fixturePath,name); assert(target.startsWith(fixturePath+path.sep),'Unsafe archive path'); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes) }
  seedRegistry()
  pageServer = http.createServer((request,response) => { response.setHeader('Content-Type',request.url.includes('.js')?'application/javascript':'text/html'); response.end(request.url.includes('.js') ? 'window.adLoaded=true' : '<!doctype html><title>Adblock fixture</title><h1>Normal content</h1><div class="vast-fixture-ad">Advertisement</div><script src="/vast-block-me.js"></script>') })
  await new Promise(resolve => pageServer.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${pageServer.address().port}`, remotePort=9820+Math.floor(Math.random()*100)
  let launched = launch(remotePort,origin)
  try {
    let session = await connectToRenderer(remotePort)
    await waitFor(session,'Boolean(window.vast?.extensions)','extensions API')
    await waitFor(session,`window.vast.extensions.list().then(r=>r.extensions.some(e=>e.id==='${fixtureId}'&&e.runtimeState==='loaded'))`,'extension loaded')
    await waitFor(session, `Boolean(document.querySelector('input[placeholder="Search or enter address"]'))`, 'address bar')
    await setAddress(session, origin+'/fixture')
    await waitForGuest(session, `document.title==='Adblock fixture'`, 'fixture navigation')
    await waitFor(session, `!document.querySelector('.vast-opening-overlay')`, 'opening overlay')
    if(await session.evaluate(`Boolean(document.querySelector('[data-testid="relay-notice-dismiss"]'))`)) await session.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)
    const popup = async () => {
    await session.evaluate(`document.querySelector('[data-testid="extensions-toolbar-button"]').click()`)
    await waitFor(session, `document.querySelector('[data-testid="extensions-toolbar-menu"]')?.innerText.includes('Adblocker for Vast')`, 'toolbar row')
    await session.evaluate(`([...document.querySelectorAll('[data-testid="extensions-toolbar-menu"] [role="menuitem"]')].find(e=>e.textContent.includes('Adblocker for Vast'))).click()`)
    await waitForExtensionSurface(session, `Boolean(document.body)`, 'popup')
    assert(await executeInExtensionSurface(session,'innerHeight >= 350'), 'Extension viewport did not fill popup container')
    await waitForExtensionSurface(session, `document.querySelector('#hostname')?.textContent==='127.0.0.1'`, 'popup hostname')
    await wait(300)
    await session.screenshot('adblock-extension-popup.png')
    }
    await popup()
    const status = () => executeInExtensionSurface(session, `chrome.runtime.sendMessage({type:'status'})`)
    let state
    for(let i=0;i<100;i++){ state=await status(); if(state.value?.ready||state.value?.error) break; await wait(250) }
    console.log('Cold initialization (ms)', state.value?.performance?.initializationMs)
    assert(state.ok && state.value.ready,'Engine did not initialize: '+state.value?.error)
    const next={...state.value.settings,autoUpdate:false,customFilters:'/vast-block-me.js$script\n127.0.0.1##.vast-fixture-ad'}
    assert((await executeInExtensionSurface(session, `chrome.runtime.sendMessage(${JSON.stringify({type:'settings',settings:next})})`)).ok, 'Custom settings failed to save')
    await executeInActiveWebview(session, 'location.reload();true').catch(()=>{})
    await waitForGuest(session, `document.title==='Adblock fixture' && getComputedStyle(document.querySelector('.vast-fixture-ad')).display==='none'`, 'cosmetic filtering')
    assert(await executeInActiveWebview(session,'window.adLoaded!==true'),'Network request was not blocked')
    assert((await status()).value.pageBlocked >= 1, 'Blocked statistics did not advance')
    const send = input => executeInExtensionSurface(session, `chrome.runtime.sendMessage(${JSON.stringify(input)})`)
    state = await status()
    assert(!(await send({type:'site',tabId:state.value.tabId,url:origin+'/stale',enabled:false})).ok, 'Stale site identity accepted')
    assert((await send({type:'site',tabId:state.value.tabId,url:state.value.url,enabled:false})).ok, 'Site disable failed')
    await waitForGuest(session, `getComputedStyle(document.querySelector('.vast-fixture-ad')).display!=='none'`, 'site cosmetic cleanup')
    await executeInActiveWebview(session, 'location.reload();true').catch(()=>{})
    await waitForGuest(session, 'window.adLoaded===true', 'allowlisted network')
    state = await status()
    assert((await send({type:'site',tabId:state.value.tabId,url:state.value.url,enabled:true})).ok, 'Site enable failed')
    await waitForGuest(session, `getComputedStyle(document.querySelector('.vast-fixture-ad')).display==='none'`, 'site cosmetic restoration')
    assert(!(await send({type:'settings',settings:{...next,customFilters:'127.0.0.1##+js(set-constant, x, true)'}})).ok, 'Unsupported custom scriptlet was accepted')
    assert((await status()).value.settings.customFilters===next.customFilters, 'Failed custom edit replaced working rules')
    const before = performance.now()
    await executeInActiveWebview(session, `Promise.all(Array.from({length:100},(_,i)=>fetch('/allowed-'+i+'.txt'))).then(()=>true)`)
    console.log('100 allowed local requests (ms)', performance.now()-before)
    assert((await session.evaluate(`window.vast.extensions.disable('${fixtureId}')`)).ok, 'Hub disable failed')
    await waitForGuest(session, `getComputedStyle(document.querySelector('.vast-fixture-ad')).display!=='none'`, 'extension unload cosmetic cleanup')
    await executeInActiveWebview(session, 'location.reload();true').catch(()=>{})
    await waitForGuest(session, 'window.adLoaded===true', 'extension unload network cleanup')
    assert((await session.evaluate(`window.vast.extensions.enable('${fixtureId}')`)).ok, 'Hub enable failed')
    await setAddress(session, origin+'/fixture?enabled')
    await waitForGuest(session, `document.title==='Adblock fixture' && getComputedStyle(document.querySelector('.vast-fixture-ad')).display==='none'`, 'cache restoration after enable')
    await executeInActiveWebview(session, 'location.reload();true').catch(()=>{})
    await waitForGuest(session, `document.title==='Adblock fixture' && getComputedStyle(document.querySelector('.vast-fixture-ad')).display==='none'`, 'ready engine reload')
    assert(await executeInActiveWebview(session,'window.adLoaded!==true'), 'Re-enabled network did not block')
    session.close(); await stop(launched.child)
    launched = launch(remotePort+1,origin); session = await connectToRenderer(remotePort+1)
    await waitFor(session, `Boolean(document.querySelector('input[placeholder="Search or enter address"]'))`, 'restart UI')
    await setAddress(session, origin+'/fixture?restart')
    await waitForGuest(session, `document.title==='Adblock fixture'`, 'restart page')
    await waitFor(session, `!document.querySelector('.vast-opening-overlay')`, 'restart overlay')
    await popup()
    for(let i=0;i<100;i++){ state=await status(); if(state.value?.ready||state.value?.error) break; await wait(250) }
    assert(state.value.ready && state.value.performance.cacheHit, 'Browser restart did not restore compiled cache')
    assert(state.value.settings.customFilters===next.customFilters, 'Browser restart lost custom rules')
    console.log('Cached initialization (ms)',state.value.performance.initializationMs)
    assert((await session.evaluate(`window.vast.extensions.remove('${fixtureId}')`)).ok, 'Hub remove failed')
    await waitForGuest(session, `getComputedStyle(document.querySelector('.vast-fixture-ad')).display!=='none'`, 'uninstall cosmetic cleanup')
    assert(!(await session.evaluate('window.vast.extensions.list()')).extensions.some(e=>e.id===fixtureId), 'Uninstalled record survived')
    console.log('PASS standalone extension: worker, network, cosmetics, statistics, site controls, validation, lifecycle and cache')
    session.close()
  } finally { await stop(launched.child); fs.mkdirSync(artifactsDirectory,{recursive:true}); fs.writeFileSync(path.join(artifactsDirectory,'adblock-extension-e2e.log'),launched.stderr.join('')); await new Promise(resolve=>pageServer.close(resolve)); assert(path.dirname(userDataDir)===path.resolve(os.tmpdir())&&path.basename(userDataDir).startsWith('vast-adblock-extension-e2e-'),'Unsafe test cleanup'); fs.rmSync(userDataDir,{recursive:true,force:true}) }
}
run().catch(error=>{console.error(error);process.exitCode=1})
