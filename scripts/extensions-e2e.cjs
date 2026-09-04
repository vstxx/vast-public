const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourceFixturePath = path.resolve(root, 'tests/fixtures/extensions/content-script-basic')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-extension-e2e-profile-'))
const fixturePath = path.join(userDataDir, 'extension-fixture')
const artifactsDirectory = path.join(root, '.vast-test-artifacts')
const packagedExecutable = process.env.VAST_E2E_EXECUTABLE ? path.resolve(process.env.VAST_E2E_EXECUTABLE) : undefined
const electronExecutable = packagedExecutable ?? require('electron')
let appProcess
let pageServer

const assertionTimeout = process.env.CI === 'true' ? 60_000 : 20_000

fs.cpSync(sourceFixturePath, fixturePath, { recursive: true })
const fixtureManifestPath = path.join(fixturePath, 'manifest.json')
const fixtureManifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'))
fixtureManifest.action = { default_popup: 'popup.html' }
fixtureManifest.options_ui = { page: 'options.html', open_in_tab: false }
fs.writeFileSync(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(fixturePath, 'popup.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Fixture popup</title><style>body{margin:0;padding:20px;background:#0b0c11;color:#f5f7fa;font:14px system-ui}</style></head><body data-vast-toolbar-popup="ready"><strong>Custom extension popup</strong><p id="storage">Checking storage</p><script src="popup.js"></script></body></html>', 'utf8')
fs.writeFileSync(path.join(fixturePath, 'popup.js'), "chrome.storage.local.get('vastExtensionFixtureStorage', (value) => { document.querySelector('#storage').textContent = value.vastExtensionFixtureStorage === 'storage-round-trip' ? 'Storage connected' : 'Storage ready' })\n", 'utf8')
fs.writeFileSync(path.join(fixturePath, 'options.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Fixture options</title></head><body data-vast-toolbar-options="ready">Fixture options</body></html>', 'utf8')

function extensionId(extensionPath) {
  const input = Buffer.from(process.platform === 'win32' ? extensionPath.toLowerCase() : extensionPath)
  const digest = createHash('sha256').update(input).digest().subarray(0, 16)
  return [...digest].map((byte) => {
    return `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`
  }).join('')
}

const fixtureId = extensionId(fixturePath)
const iduPlusId = 'kbbfoeemomglhdhohnkcnfnpikedcoka'

function seedRegistry() {
  const registryDirectory = path.join(userDataDir, 'Extensions')
  const now = Date.now()
  fs.mkdirSync(registryDirectory, { recursive: true })
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: fixtureId,
      name: 'Vast Content Script Fixture',
      version: '1.0.0',
      description: 'Deterministic unpacked extension fixture for Vast runtime tests.',
      path: fixturePath,
      enabled: true,
      source: 'unpacked',
      runtime: 'chrome',
      manifestVersion: 3,
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

async function verifyRuntime(session, origin) {
  const expression = `document.documentElement.dataset.vastExtensionFixture === 'content-script-loaded' && document.documentElement.dataset.vastExtensionFixtureStorage === 'storage-round-trip'`
  await setAddress(session, `${origin}/extension-runtime`)
  if (await guestMatches(session, expression, 5_000)) return
  // Electron can report a cold unpacked extension as loaded just before its
  // content-script registry becomes active. A fresh document is required;
  // waiting on the already completed document cannot cause a missed
  // document_start script to run retroactively.
  await setAddress(session, `${origin}/extension-runtime?cold-registration-retry=1`)
  await waitForGuest(
    session,
    expression,
    'content script and chrome.storage.local'
  )
}

async function runFirstLaunch(origin) {
  const remotePort = 9700 + Math.floor(Math.random() * 200)
  const launchState = launch(remotePort, origin)
  const session = await connectToRenderer(remotePort)
  await waitFor(session, `Boolean(document.querySelector('[data-testid="new-tab-identity"]'))`, 'initial new tab')
  const welcomeVisible = await session.evaluate(`Boolean(document.querySelector('[data-testid="relay-notice-dismiss"]'))`)
  if (welcomeVisible) {
    await session.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)
    await waitFor(session, `!document.querySelector('[data-testid="relay-notice"]')`, 'welcome message dismissal')
  }

  const initial = await session.evaluate('window.vast.extensions.list()')
  const initialFixture = initial.extensions.find((extension) => extension.id === fixtureId)
  assert(initial.ok && initialFixture, 'Seeded extension was not restored by the main-process manager.')
  assert(initialFixture.runtimeState === 'loaded', 'Seeded extension did not load into the persistent workspace session.')
  assert(initialFixture.loadedSessionCount === 1, 'Extension loaded into an unexpected number of sessions.')
  assert(!initial.extensions.some((extension) => extension.source === 'bundled'), 'Bundled catalog content appeared as preinstalled software.')
  await verifyRuntime(session, origin)
  await waitFor(session, `!document.querySelector('.vast-opening-overlay')`, 'opening presentation to finish', 15_000)
  await wait(750)
  if (await session.evaluate(`Boolean(document.querySelector('[data-testid="relay-notice-dismiss"]'))`)) {
    await session.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)
    await waitFor(session, `!document.querySelector('[data-testid="relay-notice"]')`, 'welcome message dismissal')
  }


  await session.evaluate(`document.querySelector('[data-testid="extensions-toolbar-button"]').click()`)
  await waitFor(session, `Boolean(document.querySelector('[data-testid="extensions-toolbar-menu"]'))`, 'extensions toolbar menu')
  await waitFor(session, `document.querySelector('[data-testid="extensions-toolbar-menu"]')?.innerText.includes('Vast Content Script Fixture')`, 'extension toolbar row')
  await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="extensions-toolbar-menu"] [role="menuitem"]')].find((item) => item.textContent.includes('Vast Content Script Fixture'));
    if (!row) throw new Error('Extension toolbar row was not found.');
    row.click();
  })()`)
  await waitFor(session, `Boolean(document.querySelector('webview.extension-toolbar-surface'))`, 'custom extension popup webview')
  await waitForExtensionSurface(session, `document.body.dataset.vastToolbarPopup === 'ready' && typeof chrome?.storage?.local?.get === 'function'`, 'custom Chrome popup and extension API')
  assert(await executeInExtensionSurface(session, `document.querySelector('#storage')?.textContent === 'Storage connected'`), 'Custom popup did not share the extension workspace storage.')
  await session.screenshot('extensions-toolbar-popup.png')
  await session.evaluate(`document.querySelector('button[aria-label="Back to extensions"]').click()`)
  await waitFor(session, `!document.querySelector('webview.extension-toolbar-surface')`, 'return from custom extension popup')
  await session.evaluate(`document.querySelector('button[aria-label="More actions for Vast Content Script Fixture"]').click()`)
  await waitFor(session, `document.querySelector('[aria-label="Actions for Vast Content Script Fixture"]')?.innerText.includes('Disable extension')`, 'extension three-dot actions')
  await session.screenshot('extensions-toolbar-menu.png')
  await session.evaluate(`document.querySelector('[data-testid="extensions-toolbar-button"]').click()`)
  await waitFor(session, `!document.querySelector('[data-testid="extensions-toolbar-menu"]')`, 'extensions toolbar menu close')

  await session.evaluate(`(() => {
    const button = document.querySelector('button[title="More browser tools"]');
    if (!button) throw new Error('More browser tools button was not found.');
    button.click();
    return true;
  })()`)
  await waitFor(session, `document.body.innerText.includes('Extensions')`, 'Extensions browser menu entry')
  assert(await session.evaluate(`!document.body.innerText.includes('Reset zoom')`), 'The removed Reset zoom menu row is still visible.')
  await session.screenshot('extensions-menu.png')
  await session.evaluate(`(() => {
    const item = [...document.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Extensions');
    if (!item) throw new Error('Extensions menu item was not found.');
    item.click();
    return true;
  })()`)
  await waitFor(session, `Boolean(document.querySelector('[data-testid="extensions-page"]'))`, 'vast://extensions page')
  await waitFor(session, `document.querySelector('[data-extension-id]')?.textContent.includes('Vast Content Script Fixture')`, 'installed extension card')
  await wait(300)
  await session.screenshot('extensions-page.png')
  const extensionCardRect = await session.evaluate(`(() => {
    const card = document.querySelector('.extensions-flat-card');
    if (!card) throw new Error('Extension card was not found for hover verification.');
    const rect = card.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: extensionCardRect.x + extensionCardRect.width / 2,
    y: extensionCardRect.y + Math.min(48, extensionCardRect.height / 2)
  })
  await wait(200)
  await session.screenshot('extensions-page-hover.png')
  await session.evaluate(`[...document.querySelectorAll('[role="tab"]')].find((button) => button.textContent.trim() === 'Explore').click()`)
  await waitFor(session, `document.body.textContent.includes('Installed and local extensions continue to work offline.') || document.body.textContent.includes('No extensions found') || Boolean(document.querySelector('[aria-label="Vast Extensions catalog"]'))`, 'settled Explore state')
  assert(await session.evaluate(`document.querySelector('[aria-label="Vast Extensions catalog"]')?.innerText.includes('IDU+') && !document.body.innerText.includes('First-party')`), 'IDU+ Explore content or badge cleanup is incorrect.')
  await session.screenshot('extensions-explore-synced.png')
  await session.evaluate(`[...document.querySelectorAll('[role="tab"]')].find((button) => button.textContent.trim() === 'Installed').click()`)

  await session.evaluate(`document.querySelector('button[aria-label="Disable Vast Content Script Fixture"]').click()`)
  await waitFor(session, `document.querySelector('button[aria-label="Enable Vast Content Script Fixture"]')?.getAttribute('aria-checked') === 'false'`, 'disabled extension UI state')
  await setAddress(session, `${origin}/disabled-runtime`)
  await waitForGuest(session, `document.readyState === 'complete'`, 'disabled test page')
  assert(
    await executeInActiveWebview(session, `document.documentElement.dataset.vastExtensionFixture !== 'content-script-loaded'`),
    'Disabled extension still injected its content script.'
  )

  await setAddress(session, 'vast://extensions')
  const visibleExtensionsPage = `([...document.querySelectorAll('[data-testid="extensions-page"]')].find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }))`
  await waitFor(session, `Boolean(${visibleExtensionsPage})`, 'visible extensions page after disable')
  await session.evaluate(`(() => { const page = ${visibleExtensionsPage}; if (!page) throw new Error('Visible extensions page was not found.'); if (!page.querySelector('button[aria-label="Enable Vast Content Script Fixture"]')) [...page.querySelectorAll('[role="tab"]')].find((button) => button.textContent.trim() === 'Installed')?.click(); })()`)
  await waitFor(session, `Boolean(${visibleExtensionsPage}?.querySelector('button[aria-label="Enable Vast Content Script Fixture"]'))`, 'installed tab after disable')
  await session.evaluate(`${visibleExtensionsPage}.querySelector('button[aria-label="Enable Vast Content Script Fixture"]').click()`)
  await waitFor(session, `${visibleExtensionsPage}?.querySelector('button[aria-label="Disable Vast Content Script Fixture"]')?.getAttribute('aria-checked') === 'true'`, 'enabled extension UI state')
  await waitFor(session, `Boolean(${visibleExtensionsPage}?.querySelector('[data-testid="extensions-developer-mode"]'))`, 'developer mode control')
  await session.evaluate(`(() => { const control = ${visibleExtensionsPage}.querySelector('[data-testid="extensions-developer-mode"]'); if (control.getAttribute('aria-checked') !== 'true') control.click(); })()`)
  await waitFor(session, `${visibleExtensionsPage}?.querySelector('[data-testid="extensions-developer-mode"]')?.getAttribute('aria-checked') === 'true' && Boolean(${visibleExtensionsPage}?.querySelector('[data-extension-id="${fixtureId}"]')) && [...${visibleExtensionsPage}.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Reload')`, 'developer reload control')
  await session.evaluate(`(() => {
    const reload = [...${visibleExtensionsPage}.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Reload');
    if (!reload) throw new Error('Reload button was not found.');
    reload.click();
    return true;
  })()`)
  await waitFor(session, `window.vast.extensions.list().then((result) => { const extension = result.extensions.find((item) => item.id === ${JSON.stringify(fixtureId)}); return extension?.runtimeState === 'loaded' && extension?.loadedSessionCount === 1 })`, 'extension runtime after reload')
  await verifyRuntime(session, origin)

  await session.evaluate(`(() => {
    const button = document.querySelector('button[title="More browser tools"]');
    if (!button) throw new Error('More browser tools button was not found for Incognito.');
    button.click();
    return true;
  })()`)
  await waitFor(session, `document.body.innerText.includes('Incognito window')`, 'Incognito menu entry')
  await session.evaluate(`(() => {
    const item = [...document.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Incognito window');
    if (!item) throw new Error('Incognito menu item was not found.');
    item.click();
    return true;
  })()`)
  await waitForStorage(
    session,
    `(data) => { const workspace = data.workspaces.find((item) => item.name === 'Incognito'); return Boolean(workspace?.isPrivate && data.activeWorkspaceId === workspace.id); }`,
    'Incognito workspace activation'
  )
  await setAddress(session, `${origin}/private-runtime`)
  await waitForGuest(session, `document.readyState === 'complete'`, 'Incognito test page')
  assert(
    await executeInActiveWebview(session, `document.documentElement.dataset.vastExtensionFixture !== 'content-script-loaded'`),
    'Extension content script leaked into an Incognito workspace.'
  )
  const privateState = await session.evaluate('window.vast.extensions.list()')
  const privateFixture = privateState.extensions.find((extension) => extension.id === fixtureId)
  assert(privateFixture.loadedSessionCount === 1, 'Incognito created an extension-enabled runtime session.')
  assert(privateFixture.eligibleSessionCount === 1, 'Incognito was counted as an eligible persistent session.')
  await session.evaluate(`document.querySelector('button[title="Switch workspace"]').click()`)
  await waitFor(session, `document.body.innerText.includes('Workspace')`, 'workspace switcher after Incognito')
  await session.evaluate(`(() => {
    const item = [...document.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Workspace');
    if (!item) throw new Error('Persistent Workspace entry was not found.');
    item.click();
    return true;
  })()`)
  await waitForStorage(session, `(data) => data.activeWorkspaceId === 'workspace-default'`, 'return to persistent workspace')

  session.close()
  await stop(launchState.child)
  assert(!launchState.stderr.some((line) => /uncaught|unhandled rejection/i.test(line)), `Unexpected Electron stderr: ${launchState.stderr.join('')}`)
}

async function runRestart(origin) {
  const remotePort = 9900 + Math.floor(Math.random() * 80)
  const launchState = launch(remotePort, origin)
  const session = await connectToRenderer(remotePort)
  await waitFor(session, `typeof window.vast?.extensions?.list === 'function'`, 'extensions preload API after restart')
  const restored = await session.evaluate('window.vast.extensions.list()')
  const restoredFixture = restored.extensions.find((extension) => extension.id === fixtureId)
  assert(restored.ok && restoredFixture?.enabled, 'Enabled extension state was not restored after restart.')
  assert(restoredFixture.runtimeState === 'loaded', 'Extension runtime was not restored after restart.')
  await waitFor(session, `[...document.querySelectorAll('input')].some((input) => input.placeholder === 'Search or enter address')`, 'address bar after restart')
  await verifyRuntime(session, origin)

  await setAddress(session, 'vast://extensions')
  const visibleExtensionsPage = `([...document.querySelectorAll('[data-testid="extensions-page"]')].find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }))`
  await waitFor(session, `Boolean(${visibleExtensionsPage})`, 'visible extensions page before removal')
  await session.evaluate(`(() => { const page = ${visibleExtensionsPage}; if (!page) throw new Error('Visible extensions page was not found.'); const installed = [...page.querySelectorAll('[role="tab"]')].find((button) => button.textContent.trim() === 'Installed'); if (installed?.getAttribute('aria-selected') !== 'true') installed?.click(); })()`)
  await waitFor(session, `${visibleExtensionsPage}?.innerText.includes('Vast Content Script Fixture')`, 'extension card before removal')
  await session.evaluate(`(() => {
    const page = ${visibleExtensionsPage};
    const remove = [...page.querySelectorAll('button')].find((button) => button.innerText.trim() === 'Remove');
    if (!remove) throw new Error('Remove button was not found.');
    remove.click();
    return true;
  })()`)
  await waitFor(session, `document.querySelector('[role="dialog"]')?.innerText.includes('Remove Vast Content Script Fixture?')`, 'remove confirmation')
  await session.evaluate(`document.querySelector('[role="dialog"] form button[type="submit"]').click()`)
  await waitFor(session, `!${visibleExtensionsPage}?.innerText.includes('Vast Content Script Fixture') && ${visibleExtensionsPage}?.innerText.includes('No extensions installed')`, 'empty installed state after removal')
  const removed = await session.evaluate('window.vast.extensions.list()')
  assert(removed.ok && !removed.extensions.some((extension) => extension.id === fixtureId), 'Removed extension remained in the main-process registry.')
  await setAddress(session, `${origin}/removed-runtime`)
  await waitForGuest(session, `document.readyState === 'complete'`, 'page after extension removal')
  assert(
    await executeInActiveWebview(session, `document.documentElement.dataset.vastExtensionFixture !== 'content-script-loaded'`),
    'Removed extension still injected its content script.'
  )
  const catalogAfterRemoval = await session.evaluate(`window.vast.extensions.catalog({ page: 1 })`)
  const availableIdu = catalogAfterRemoval.catalog.items.find((item) => item.id === iduPlusId)
  assert(availableIdu && !availableIdu.installed, 'Hub-published IDU+ was not available as uninstalled Explore content.')
  session.close()
  await stop(launchState.child)
  const persistedRegistry = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Extensions', 'registry.json'), 'utf8'))
  assert(!persistedRegistry.extensions.some((extension) => extension.id === fixtureId), 'Removed extension remained in registry.json.')
  assert(!persistedRegistry.extensions.some((extension) => extension.source === 'bundled'), 'Removed IDU+ remained in registry.json.')
}

async function main() {
  seedRegistry()
  pageServer = http.createServer((_request, response) => {
    if (_request.url?.startsWith('/v1/catalog')) {
      const item = { id: iduPlusId, slug: 'idu-plus', name: 'IDU+', summary: 'Improves IDU school portals.', publisher: { id: 'publisher_vastbrowserofficial', name: 'Vast', verified: true }, category: 'Education', kind: 'chrome', version: '0.3.8', updatedAt: '2026-08-24T00:00:00.000Z', downloads: 0, installed: false }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ items: [item], page: 1, pageSize: 24, total: 1, featured: [item], categories: ['Education'] }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end('<!doctype html><html><head><title>Vast Extension Runtime</title></head><body><h1>Extension runtime fixture</h1></body></html>')
  })
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${pageServer.address().port}`

  await runFirstLaunch(origin)
  await runRestart(origin)
  console.log('PASS Vast extensions Electron E2E: restore, content script, storage, management UI, disable, enable, reload, Incognito isolation, restart persistence, and remove.')
}

async function cleanup() {
  if (pageServer) await new Promise((resolve) => pageServer.close(resolve))
  if (appProcess && appProcess.exitCode === null) await stop(appProcess)
  // Windows can retain Chromium profile handles briefly after the Electron
  // process exits. Retry the complete removal operation because Node's
  // internal rm retries do not cover every top-level EPERM directory lock.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      return
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 19) throw error
      await wait(200)
    }
  }
}

main().then(cleanup, async (error) => {
  console.error(error)
  await cleanup()
  process.exitCode = 1
})
