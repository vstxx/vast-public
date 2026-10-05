#!/usr/bin/env node
// Functional audit of guest reloads in a packaged Vast with local pages only.
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { seedBenchmarkProfile } = require('./guest-scroll-profile.cjs')

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([^=]+)=(.+)$/.exec(argument)
  if (!match) throw new Error(`Invalid argument: ${argument}`)
  return [match[1], match[2]]
}))
if (!options.executable || !options.output) {
  throw new Error('Usage: node scripts/tab-reload-audit.cjs --executable=<packaged Vast.exe> --output=<directory>')
}
const executable = path.resolve(options.executable)
const output = path.resolve(options.output)
if (!fs.statSync(executable).isFile()) throw new Error('Executable not found')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
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
    return new Cdp(socket)
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.socket.close() }
}

async function waitFor(cdp, expression, description) {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    if (await cdp.evaluate(expression).catch(() => false)) return
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function activePage(cdp) {
  const result = await cdp.evaluate(`(async () => {
    const webview = document.querySelector('.browser-stage-pane[data-active="true"] webview');
    if (!webview || webview.isLoading()) return null;
    try {
      return { id: webview.getWebContentsId(), url: webview.getURL(),
        marker: await webview.executeJavaScript('window.__vastReloadAuditMarker') };
    } catch { return null; }
  })()`)
  return result || null
}

async function waitActivePage(cdp, suffix) {
  let page
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    page = await activePage(cdp).catch(() => null)
    if (page?.url.endsWith(suffix) && page.marker) return page
    await wait(60)
  }
  throw new Error(`Active page ${suffix} did not become ready`)
}

async function click(cdp, expression, description) {
  assert.equal(await cdp.evaluate(`(() => { const button = ${expression}; if (!button) return false; button.click(); return true })()`), true, description)
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><title>Local reload audit</title><main>${request.url}</main><script>window.__vastReloadAuditMarker=crypto.randomUUID()</script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const constants = await import(pathToFileURL(path.join(__dirname, '../src/shared/constants.ts')).href)
  const data = seedBenchmarkProfile(constants.DEFAULT_DATA, `${base}/a`)
  data.tabs[0].id = 'audit-a'
  data.tabs[0].title = 'Audit A'
  data.tabs.push({ ...data.tabs[0], id: 'audit-b', title: 'Audit B', url: `${base}/b`, lifecycle: 'sleeping' })
  data.workspaces[0].activeTabId = 'audit-a'
  data.settings.hibernateInactiveTabs = false
  const profile = fs.mkdtempSync(path.join(output, 'profile-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))
  const port = 10_000 + Math.floor(Math.random() * 30_000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' })
  let cdp
  try {
    const started = Date.now()
    let target
    while (Date.now() - started < 60_000) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json()).catch(() => [])
      target = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
      await wait(100)
    }
    if (!target) throw new Error('Host CDP target not found')
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    const aBefore = await waitActivePage(cdp, '/a')
    await click(cdp, `document.querySelector('[data-tab-motion-id="audit-b"]')`, 'switch to B')
    const bBefore = await waitActivePage(cdp, '/b')
    await click(cdp, `document.querySelector('[data-tab-motion-id="audit-a"]')`, 'switch to A')
    const aAfterSwitch = await waitActivePage(cdp, '/a')
    await click(cdp, `document.querySelector('button[title="More browser tools"]')`, 'open tools')
    await click(cdp, `[...document.querySelectorAll('.browser-tools-menu button')].find((item) => item.textContent.trim() === 'Settings')`, 'open Settings')
    await waitFor(cdp, `Boolean(document.querySelector('.settings-modal-shell'))`, 'Settings')
    await click(cdp, `document.querySelector('button[title="Close settings"]')`, 'close Settings')
    await waitFor(cdp, `!document.querySelector('.settings-modal-shell')`, 'Settings close')
    await click(cdp, `document.querySelector('button[title="Show sidebar"]')`, 'open side panel')
    await waitFor(cdp, `Boolean(document.querySelector('.side-panel-slot.is-open'))`, 'side panel')
    await click(cdp, `document.querySelector('button[title="Hide sidebar"]')`, 'close side panel')
    const aAfterUi = await waitActivePage(cdp, '/a')
    await click(cdp, `document.querySelector('button[title="More browser tools"]')`, 'open tools')
    await click(cdp, `[...document.querySelectorAll('.browser-tools-menu button')].find((item) => item.textContent.trim() === 'Smart unload')`, 'open Smart unload')
    await waitFor(cdp, `Boolean(document.querySelector('.smart-unload-panel'))`, 'Smart unload')
    await click(cdp, `[...document.querySelectorAll('.smart-unload-panel button')].find((item) => item.textContent.includes('Sleep inactive tabs'))`, 'sleep inactive tabs')
    const autoAfterSleep = await cdp.evaluate(`Boolean([...document.querySelectorAll('.smart-unload-panel button')].find((item) => item.textContent.includes('Enable automatic hibernation')))`)
    await click(cdp, `document.querySelector('.smart-unload-close')`, 'close Smart unload')
    await click(cdp, `document.querySelector('[data-tab-motion-id="audit-b"]')`, 'switch to sleeping B')
    const bAfterSleep = await waitActivePage(cdp, '/b')
    await click(cdp, `document.querySelector('button[title="More browser tools"]')`, 'open tools')
    await click(cdp, `[...document.querySelectorAll('.browser-tools-menu button')].find((item) => item.textContent.trim() === 'Smart unload')`, 'open Smart unload')
    await click(cdp, `[...document.querySelectorAll('.smart-unload-panel button')].find((item) => item.textContent.includes('Deep discard inactive tabs'))`, 'discard inactive A')
    const autoAfterDiscard = await cdp.evaluate(`Boolean([...document.querySelectorAll('.smart-unload-panel button')].find((item) => item.textContent.includes('Enable automatic hibernation')))`)
    await click(cdp, `document.querySelector('.smart-unload-close')`, 'close Smart unload')
    await click(cdp, `document.querySelector('[data-tab-motion-id="audit-a"]')`, 'restore discarded A')
    const aAfterDiscard = await waitActivePage(cdp, '/a')
    const observations = { aBefore, bBefore, aAfterSwitch, aAfterUi, bAfterSleep, aAfterDiscard, autoAfterSleep, autoAfterDiscard }
    const checks = {
      ordinarySwitchPreserved: aBefore.id === aAfterSwitch.id && aBefore.marker === aAfterSwitch.marker,
      settingsAndSidebarPreserved: aAfterSwitch.id === aAfterUi.id && aAfterSwitch.marker === aAfterUi.marker,
      manualSleepPreserved: bBefore.id === bAfterSleep.id && bBefore.marker === bAfterSleep.marker,
      manualSleepDidNotEnableAutomaticHibernation: autoAfterSleep,
      deepDiscardReloadedOnlyOnActivation: aAfterUi.marker !== aAfterDiscard.marker,
      deepDiscardDidNotEnableAutomaticHibernation: autoAfterDiscard
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ schemaVersion: 1, executable, checks, observations }, null, 2))
    for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name)
    console.log(checks)
  } finally {
    await cdp?.evaluate('window.vast.app.window.close()').catch(() => undefined)
    await wait(1000)
    if (child.exitCode === null) try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    cdp?.close()
    server.close()
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
