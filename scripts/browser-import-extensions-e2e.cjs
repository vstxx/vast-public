const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectRenderer, waitFor } = require('./performance-suite.cjs')

const project = path.resolve(__dirname, '..')
const executable = process.env.VAST_PATCHED_ELECTRON_DIST && path.join(process.env.VAST_PATCHED_ELECTRON_DIST, 'electron.exe')
if (!executable || !fs.existsSync(executable)) throw new Error('Set VAST_PATCHED_ELECTRON_DIST to the verified patched Electron dist; stock Electron is not an acceptable compatibility E2E.')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-import-extensions-e2e-'))
const userData = path.join(root, 'Vast')
const local = path.join(root, 'Local')
const roaming = path.join(root, 'Roaming')
const chromeProfile = path.join(local, 'Google', 'Chrome', 'User Data', 'Default')
const key = Buffer.alloc(128, 11).toString('base64')
const id = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
  .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
const port = 11000 + Math.floor(Math.random() * 500)
let child
let cdp

async function launch() {
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userData, LOCALAPPDATA: local, APPDATA: roaming,
    VAST_EXTENSION_COMPATIBILITY: '1', VAST_PATCHED_ELECTRON_COMPAT: '1',
    VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1', VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, project], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  cdp = await connectRenderer(port)
  await waitFor(cdp, 'Boolean(window.vast?.importer?.prepareExtension)', 30_000)
}

async function stop() {
  if (!child || !cdp) return
  const process = child
  const session = cdp
  child = undefined
  cdp = undefined
  const close = await session.evaluate('window.vast.app.window.close()')
  assert.equal(close.ok, true, 'Vast rejected the window close request')
  const exited = process.exitCode !== null || process.signalCode !== null || await new Promise((resolve) => {
    const timer = setTimeout(() => { process.removeListener('exit', onExit); resolve(false) }, 15_000)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    process.once('exit', onExit)
  })
  session.close()
  assert.equal(exited, true, 'Vast did not exit cleanly')
}

function fixture() {
  const content = path.join(chromeProfile, 'Extensions', id, '1.0.0_0')
  fs.mkdirSync(content, { recursive: true })
  fs.mkdirSync(roaming, { recursive: true })
  fs.writeFileSync(path.join(local, 'Google', 'Chrome', 'User Data', 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Controlled Chrome' } } } }))
  fs.writeFileSync(path.join(chromeProfile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [
    { id: '1', type: 'url', name: 'Controlled', url: 'https://example.com/' }
  ] }, other: { children: [] }, synced: { children: [] } } }))
  fs.writeFileSync(path.join(chromeProfile, 'Preferences'), JSON.stringify({ extensions: { settings: {
    [id]: { state: 1, manifest: { version: '1.0.0' } }
  } } }))
  fs.writeFileSync(path.join(content, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Controlled Chromium Import', version: '1.0.0', key,
    permissions: ['storage'], host_permissions: ['https://example.com/*'],
    content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }] }))
  fs.writeFileSync(path.join(content, 'content.js'), 'globalThis.vastControlledImport = true')
  fs.mkdirSync(path.join(content, '_metadata'))
  fs.writeFileSync(path.join(content, '_metadata', 'verified_contents.json'), '{"controlled":true}')
  const privateStorage = path.join(chromeProfile, 'Local Extension Settings', id)
  fs.mkdirSync(privateStorage, { recursive: true })
  fs.writeFileSync(path.join(privateStorage, 'controlled-private-marker'), 'must-not-copy')
}

async function main() {
  try {
    fixture()
    await launch()
    const preview = await cdp.evaluate(`window.vast.importer.prepare({sourceId:'chrome',profileId:'Default',types:['bookmarks','extensions']})`)
    assert.equal(preview.detectedExtensions[0].id, id)
    const receipt = await cdp.evaluate(`window.vast.importer.commit({token:${JSON.stringify(preview.token)},acceptPartial:false,selectedExtensionIds:[${JSON.stringify(id)}]})`)
    const before = await cdp.evaluate('window.vast.extensions.list()')
    assert.equal(before.extensions?.some((item) => item.id === id), false, 'code activated before permission consent')
    assert.equal(typeof receipt.operationId, 'string')
    await cdp.evaluate('location.reload()').catch(() => undefined)
    await waitFor(cdp, 'Boolean(document.querySelector("[data-testid=onboarding-extension-consent] button:last-child"))', 15_000)
    await cdp.evaluate('document.querySelector("[data-testid=onboarding-extension-consent] button:last-child").click()')
    await waitFor(cdp, 'document.querySelector("[data-testid=onboarding-extension-consent]")?.innerText.includes("Local / Unverified")', 15_000)
    const consentText = await cdp.evaluate('document.querySelector("[data-testid=onboarding-extension-consent]").innerText')
    assert.match(consentText, /Required Chrome permissions: storage/)
    assert.match(consentText, /Vast Native permissions: none/)
    assert.match(consentText, new RegExp(id))
    assert.equal((await cdp.evaluate('window.vast.extensions.list()')).extensions.some((item) => item.id === id), false)
    await cdp.evaluate('document.querySelector("[data-testid=onboarding-extension-consent] button:last-child").click()')
    await waitFor(cdp, 'window.vast.importer.status().then(status => status.pendingExtensionIds.length === 0)', 15_000)
    const installed = (await cdp.evaluate('window.vast.extensions.list()')).extensions.find((item) => item.id === id)
    assert.equal(installed.source, 'local-chromium')
    assert.equal(installed.trust, 'local')
    assert.equal(installed.enabled, true)
    assert.equal(installed.runtimeState, 'loaded')
    assert.equal(fs.existsSync(path.join(installed.path, 'controlled-private-marker')), false)
    assert.equal(fs.existsSync(path.join(installed.path, 'content.js')), true)
    assert.equal(fs.existsSync(path.join(installed.path, '_metadata')), false)
    const statusAfterInstall = await cdp.evaluate('window.vast.importer.status()')
    assert.deepEqual(statusAfterInstall.pendingExtensionIds, [], `pending import persisted incorrectly: ${JSON.stringify(statusAfterInstall)}`)
    // The test invoked trusted IPC directly; reload so onboarding reads the
    // persisted receipt just as it does after a real interrupted session.
    await cdp.evaluate('location.reload()').catch(() => undefined)
    await waitFor(cdp, 'Boolean(document.querySelector("[data-testid=onboarding-enter-vast]:not(:disabled)"))', 15_000)
    await cdp.evaluate('document.querySelector("[data-testid=onboarding-enter-vast]").click()')
    await waitFor(cdp, '!document.querySelector("[data-testid=onboarding-page]")', 15_000)
    await stop()
    await launch()
    const persisted = (await cdp.evaluate('window.vast.extensions.list()')).extensions.find((item) => item.id === id)
    assert.equal(persisted?.source, 'local-chromium')
    assert.equal(persisted?.runtimeState, 'loaded')
    assert.equal((await cdp.evaluate('window.vast.importer.status()')).pendingExtensionIds.length, 0)
    await waitFor(cdp, 'Boolean(document.querySelector(".app-shell"))', 10_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await stop()
    console.log('PASS controlled Chrome local extension consent, original ID, runtime load, private-storage exclusion and restart')
  } finally {
    if (child?.pid) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    }
    cdp?.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vast-import-extensions-e2e-'))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
