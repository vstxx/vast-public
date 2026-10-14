const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { CdpSession, connectRenderer, waitFor, stopRun } = require('./performance-suite.cjs')

const root = path.resolve(__dirname, '..')
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
if (!dist) throw new Error('Set VAST_PATCHED_ELECTRON_DIST to the verified Electron distribution.')
const executable = path.join(path.resolve(dist), process.platform === 'win32' ? 'electron.exe' : 'electron')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-fullscreen-appearance-'))
const artifacts = path.join(root, '.vast-test-artifacts', 'fullscreen-appearance')
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Fullscreen fixture</title><h1>Fullscreen fixture</h1>')
})
let child
let renderer

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function key(session, code, keyValue, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', { type, code, key: keyValue, windowsVirtualKeyCode, modifiers })
  }
}

async function screenshot(name) {
  const result = await renderer.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(path.join(artifacts, name), Buffer.from(result.data, 'base64'))
}

async function openPalette() {
  await key(renderer, 'KeyK', 'k', 75, 2)
  await waitFor(renderer, `document.querySelector('.command-palette-panel')`, 10000)
}

async function openSettings() {
  await openPalette()
  await renderer.evaluate(`(() => {
    const button = [...document.querySelectorAll('.command-palette-item')].find((item) => item.textContent.includes('Open settings'));
    if (!button) throw new Error('Open settings command is missing');
    button.click();
  })()`)
  await waitFor(renderer, `document.querySelector('.settings-modal-shell')`, 10000)
}

async function chooseTheme(theme) {
  await renderer.evaluate(`(() => {
    const button = document.querySelector('[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(theme)}]');
    if (!button) throw new Error('Theme control is missing');
    button.click();
  })()`)
  await waitFor(renderer, `document.querySelector('.app-shell.${theme.toLowerCase()}-theme')`, 10000)
}

async function setGlass(value) {
  await renderer.evaluate(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((item) => item.querySelector('.settings-row-label')?.textContent.includes('Glassiness'));
    const input = row?.querySelector('input[type="range"]');
    if (!input) throw new Error('Glassiness control is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(renderer, `document.querySelector('.app-shell').style.getPropertyValue('--vast-dialog-opacity') === '${(100 - value * 0.18).toFixed(1)}%'`, 10000)
}

async function setBlur(value) {
  await renderer.evaluate(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((item) => item.querySelector('.settings-row-label')?.textContent.trim() === 'Blur');
    const input = row?.querySelector('input[type="range"]');
    if (!input) throw new Error('Blur control is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(renderer, `document.querySelector('.app-shell').style.getPropertyValue('--vast-dialog-blur') === '${Math.round(value * 0.4)}px'`, 10000)
}

async function surface(selector) {
  return renderer.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Surface missing: ${selector}');
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, blur: style.backdropFilter, themeSurface: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--vast-dialog-surface').trim(), localSurface: style.getPropertyValue('--vast-dialog-surface').trim(), overlayAlpha: style.getPropertyValue('--vast-dialog-overlay-alpha').trim() };
  })()`)
}

function redChannel(color) {
  const srgb = /^color\(srgb ([\d.]+)/.exec(color)
  if (srgb) return Number.parseFloat(srgb[1]) * 255
  const rgb = /^rgba?\(([\d.]+)/.exec(color)
  if (rgb) return Number.parseFloat(rgb[1])
  throw new Error(`Unsupported computed background color: ${color}`)
}

async function closeSettings() {
  await renderer.evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`)
  await waitFor(renderer, `!document.querySelector('.settings-modal-shell')`, 10000)
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const data = structuredClone((await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.layoutMode = 'horizontal'
  data.settings.advanced.experimentalFeatures = true
  data.settings.openingAnimation = false
  data.onboarding.completed = true
  const workspace = data.workspaces[0]
  workspace.activeTabId = 'fullscreen-fixture'
  data.activeWorkspaceId = workspace.id
  data.tabs = [{ id: 'fullscreen-fixture', workspaceId: workspace.id, title: 'Fullscreen fixture', url: origin, pinned: false, status: 'idle', lifecycle: 'active', progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: Date.now(), lastAccessedAt: Date.now() }]
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))

  const port = 11700 + Math.floor(Math.random() * 200)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0', VAST_RELAY_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, root], { cwd: root, env, stdio: 'ignore', windowsHide: true })
  renderer = await connectRenderer(port)
  await waitFor(renderer, `document.querySelector('.horizontal-chrome') && [...document.querySelectorAll('webview.browser-webview')].some((view) => view.getURL().startsWith(${JSON.stringify(origin)}))`, 20000)

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const guestTarget = targets.find((target) => target.url.startsWith(origin))
  assert.ok(guestTarget, 'Active guest CDP target was not found')
  const guest = await CdpSession.connect(guestTarget.webSocketDebuggerUrl)
  try {
    await key(guest, 'F11', 'F11', 122)
    await waitFor(renderer, `window.vast.app.window.state().then((state) => state.fullscreen && !document.querySelector('.horizontal-chrome'))`, 10000)
    assert.equal(await renderer.evaluate(`Boolean(document.querySelector('.browser-stage'))`), true)
    await key(guest, 'F11', 'F11', 122)
    await waitFor(renderer, `window.vast.app.window.state().then((state) => !state.fullscreen && Boolean(document.querySelector('.horizontal-chrome')))`, 10000)
  } finally {
    guest.close()
  }
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => state.fullscreen && !document.querySelector('.horizontal-chrome'))`, 10000)
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => !state.fullscreen && Boolean(document.querySelector('.horizontal-chrome')))`, 10000)
  console.log('PASS F11 from guest and browser chrome hides tabs and restores them.')

  const expectedSurface = { Dark: '#0b0b0d', Dim: '#242424', Light: '#f8fafc' }
  for (const theme of ['Dark', 'Dim', 'Light']) {
    await openSettings()
    await chooseTheme(theme)
    await setBlur(0)
    await setGlass(0)
    const solidSettings = await surface('.settings-modal-shell')
    const solidSettingsOverlay = await surface('.settings-modal-overlay')
    const solidSettingsCard = await surface('.settings-card')
    await setGlass(100)
    const glassSettings = await surface('.settings-modal-shell')
    const glassSettingsOverlay = await surface('.settings-modal-overlay')
    const glassSettingsCard = await surface('.settings-card')
    assert.equal(glassSettings.themeSurface, expectedSurface[theme])
    if (theme === 'Dark') {
      assert.equal(glassSettings.localSurface, '#050507', 'Dark Settings surface should be near black')
      assert.equal(Number.parseFloat(glassSettingsOverlay.overlayAlpha), 0.62, 'Dark Settings backdrop should keep the window dark')
      const sectionTone = redChannel(glassSettingsCard.background)
      assert.ok(sectionTone > redChannel(glassSettings.background) + 12 && sectionTone < 22, 'Dark Settings sections should be barely lighter than the window')
      const colorItem = await surface('.settings-color-item')
      assert.ok(redChannel(colorItem.background) < 20 && redChannel(colorItem.background) <= sectionTone, 'Dark Settings color rows should remain restrained')
    }
    assert.notEqual(solidSettings.background, glassSettings.background, `${theme} Settings did not react to Glassiness`)
    assert.notEqual(solidSettingsCard.background, glassSettingsCard.background, `${theme} Settings cards did not react to Glassiness`)
    assert.equal(solidSettings.blur, glassSettings.blur, `${theme} Glassiness changed Settings blur`)
    assert.deepEqual(solidSettingsOverlay, glassSettingsOverlay, `${theme} Glassiness changed the Settings overlay`)
    await setBlur(100)
    const blurredSettings = await surface('.settings-modal-shell')
    const blurredSettingsOverlay = await surface('.settings-modal-overlay')
    assert.equal(glassSettings.background, blurredSettings.background, `${theme} Blur changed Settings transparency`)
    assert.notEqual(glassSettings.blur, blurredSettings.blur, `${theme} Blur did not change Settings backdrop filtering`)
    assert.equal(glassSettingsOverlay.background, blurredSettingsOverlay.background, `${theme} Blur changed Settings overlay opacity`)
    assert.notEqual(glassSettingsOverlay.blur, blurredSettingsOverlay.blur, `${theme} Blur did not change Settings overlay filtering`)
    await screenshot(`${theme.toLowerCase()}-settings-glass100.png`)
    await closeSettings()

    await openPalette()
    const blurredPalette = await surface('.command-palette-panel')
    const blurredPaletteOverlay = await surface('.command-palette-shell')
    await screenshot(`${theme.toLowerCase()}-palette-glass100.png`)
    await renderer.evaluate(`document.querySelector('button[aria-label="Close command palette"]').click()`)
    await waitFor(renderer, `!document.querySelector('.command-palette-panel')`, 10000)
    await openSettings()
    await setGlass(0)
    await closeSettings()
    await openPalette()
    const solidPalette = await surface('.command-palette-panel')
    const solidPaletteOverlay = await surface('.command-palette-shell')
    assert.equal(blurredPalette.themeSurface, expectedSurface[theme])
    assert.notEqual(solidPalette.background, blurredPalette.background, `${theme} palette did not react to Glassiness`)
    assert.equal(solidPalette.blur, blurredPalette.blur, `${theme} Glassiness changed palette blur`)
    assert.deepEqual(solidPaletteOverlay, blurredPaletteOverlay, `${theme} Glassiness changed the palette overlay`)
    await renderer.evaluate(`document.querySelector('button[aria-label="Close command palette"]').click()`)
    await waitFor(renderer, `!document.querySelector('.command-palette-panel')`, 10000)
    await openSettings()
    await setGlass(100)
    await setBlur(0)
    await closeSettings()
    await openPalette()
    const clearPalette = await surface('.command-palette-panel')
    const clearPaletteOverlay = await surface('.command-palette-shell')
    assert.equal(clearPalette.background, blurredPalette.background, `${theme} Blur changed palette transparency`)
    assert.notEqual(clearPalette.blur, blurredPalette.blur, `${theme} Blur did not change palette filtering`)
    assert.equal(clearPaletteOverlay.background, blurredPaletteOverlay.background, `${theme} Blur changed palette overlay opacity`)
    assert.notEqual(clearPaletteOverlay.blur, blurredPaletteOverlay.blur, `${theme} Blur did not change palette overlay filtering`)
    await renderer.evaluate(`document.querySelector('button[aria-label="Close command palette"]').click()`)
    await waitFor(renderer, `!document.querySelector('.command-palette-panel')`, 10000)
    console.log(`PASS ${theme} Glassiness changes transparency; Blur independently changes backdrop filtering.`)
  }
  await openSettings()
  await renderer.evaluate(`document.querySelector('[role="group"][aria-label="Layout"] button[aria-label="Vertical"]').click()`)
  await closeSettings()
  await waitFor(renderer, `document.querySelector('.app-shell.layout-vertical aside') && document.querySelector('.address-bar-row')`, 10000)
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => state.fullscreen && !document.querySelector('.app-shell.layout-vertical aside') && !document.querySelector('.address-bar-row'))`, 10000)
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => !state.fullscreen && Boolean(document.querySelector('.app-shell.layout-vertical aside')) && Boolean(document.querySelector('.address-bar-row')))`, 10000)
  console.log('PASS F11 hides and restores vertical tabs and address bar.')
  await openSettings()
  await renderer.evaluate(`document.querySelector('[role="group"][aria-label="Layout"] button[aria-label="Purist"]').click()`)
  await closeSettings()
  await waitFor(renderer, `document.querySelector('.app-shell.layout-purist .purist-tab-bar')`, 10000)
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => state.fullscreen && !document.querySelector('.purist-chrome'))`, 10000)
  await key(renderer, 'F11', 'F11', 122)
  await waitFor(renderer, `window.vast.app.window.state().then((state) => !state.fullscreen && Boolean(document.querySelector('.purist-tab-bar')))`, 10000)
  console.log('PASS F11 hides and restores Purist tabs.')
  console.log(`Screenshots: ${artifacts}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (renderer && child) await stopRun(child, renderer)
  await new Promise((resolve) => server.close(resolve))
  console.log(`Isolated profile: ${profile}`)
})
