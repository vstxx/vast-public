// Translator for Vast benchmark in the real patched runtime. Each run uses a fresh isolated profile.
//   baseline       Vast without the extension
//   installed      extension installed, never used (idle footprint)
//   popup          popup opened and closed
//   workflow       models present; cold and warm engine, selection latency, page translation of
//                  medium, large and table-heavy fixtures, long tasks and frame times while
//                  scrolling, memory before/peak/after idle release
// Memory comes from app.getAppMetrics() in the main process (private bytes, Windows). Run:
//   node scripts/translator-bench.cjs [--runs 3] [--out report.json]
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'resources/first-party-extensions/translator-for-vast/dist')
const electronDist = process.env.VAST_PATCHED_ELECTRON_DIST ? path.resolve(process.env.VAST_PATCHED_ELECTRON_DIST) : require('./prepare-patched-electron-dist.cjs').defaultOutputPath(require('../patches/extension-compatibility-runtime.json'))
const electron = path.join(electronDist, 'electron.exe')
const args = process.argv.slice(2)
const runs = Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 3)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const session = new Cdp(socket)
    await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    try { this.socket.close() } catch {}
  }
}

async function json(url) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {}
    await wait(200)
  }
  throw new Error(`No debugger at ${url}`)
}

async function until(check, label, ms = 60_000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await wait(100)
  }
  throw new Error(`Timed out: ${label}`)
}

function unpackedId(directory) {
  const digest = createHash('sha256').update(Buffer.from(directory.toLowerCase())).digest().subarray(0, 16)
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
}

function paragraphs(count, words) {
  const vocabulary = 'the city council agreed on a new plan to improve public transport and build safer cycling routes while residents asked for more green spaces near schools and quieter streets in the evening'.split(' ')
  return Array.from({ length: count }, (_, index) => `<p>${Array.from({ length: words }, (_, word) => vocabulary[(index * 7 + word * 3) % vocabulary.length]).join(' ')}. Paragraph ${index + 1} ends <a href="#p${index}">here</a>.</p>`).join('\n')
}

const fixtures = {
  '/medium': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Medium article</title></head><body style="font:16px/1.6 system-ui;max-width:760px;margin:auto"><h1>City plans new routes</h1>${paragraphs(40, 45)}</body></html>`,
  '/large': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Large article</title></head><body style="font:16px/1.6 system-ui;max-width:760px;margin:auto"><h1>Annual report</h1>${paragraphs(600, 45)}</body></html>`,
  '/table': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timetable</title></head><body><table>${Array.from({ length: 300 }, (_, index) => `<tr><td>Route ${index}</td><td>Leaves from the main station every <b>ten</b> minutes</td><td><a href="#r${index}">Show the full timetable</a></td></tr>`).join('')}</table></body></html>`
}

async function launchApp({ extension, userDataDir, captureLogs = false }) {
  userDataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'vast-tfv-bench-'))
  const registryDirectory = path.join(userDataDir, 'Extensions')
  if (extension && !fs.existsSync(path.join(registryDirectory, 'registry.json'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'))
    const now = Date.now()
    fs.mkdirSync(registryDirectory, { recursive: true })
    fs.writeFileSync(path.join(registryDirectory, 'registry.json'), JSON.stringify({ schemaVersion: 1, extensions: [{ id: unpackedId(dist), name: manifest.name, version: manifest.version, description: manifest.description, path: dist, enabled: true, source: 'unpacked', runtime: 'hybrid', manifestVersion: 3, installedAt: now, updatedAt: now, allowFileAccess: false, grantedPermissions: manifest.vast.permissions }] }))
  }
  const port = 9300 + Math.floor(Math.random() * 300)
  const inspect = port + 400
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userDataDir, VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1', VAST_EXTENSIONS_HUB_ORIGIN: 'http://127.0.0.1:9', VAST_EXTENSION_COMPATIBILITY: '1', VAST_PATCHED_ELECTRON_COMPAT: '1', VAST_PATCHED_ELECTRON_DIST: electronDist }
  delete env.ELECTRON_RUN_AS_NODE
  const started = Date.now()
  const child = spawn(electron, [`--remote-debugging-port=${port}`, `--inspect=${inspect}`, root], { cwd: root, env, windowsHide: true, stdio: captureLogs ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
  const logs = []
  if (captureLogs) for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => logs.push(String(chunk)))
  const targets = () => json(`http://127.0.0.1:${port}/json/list`)
  const page = await until(async () => (await targets()).find((target) => target.type === 'page' && target.url.includes('index.html')), 'window')
  const ui = await Cdp.connect(page.webSocketDebuggerUrl)
  await until(() => ui.evaluate(`Boolean(document.querySelector('[data-testid="onboarding-page"]') || [...document.querySelectorAll('input')].some((i) => i.placeholder === 'Search or enter address'))`), 'first route')
  if (await ui.evaluate(`Boolean(document.querySelector('[data-testid="onboarding-page"]'))`)) {
    await ui.evaluate(`document.querySelector('[data-testid="onboarding-use-defaults"]').click()`)
    await until(() => ui.evaluate(`Boolean(document.querySelector('[data-testid="onboarding-enter-vast"]'))`), 'onboarding')
    await ui.evaluate(`document.querySelector('[data-testid="onboarding-enter-vast"]').click()`)
  }
  const readyMs = Date.now() - started
  const main = await Cdp.connect((await json(`http://127.0.0.1:${inspect}/json/list`))[0].webSocketDebuggerUrl)
  const visible = `[...document.querySelectorAll('webview.browser-webview')].find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 })`
  const app = {
    child, ui, main, userDataDir, readyMs, targets, logs,
    async metrics() {
      return main.evaluate(`(() => { const { app, webContents } = process.mainModule.require('electron'); const urls = {}; for (const contents of webContents.getAllWebContents()) { try { urls[contents.getOSProcessId()] = [...(urls[contents.getOSProcessId()] ?? []), contents.getURL().slice(0, 80)] } catch {} } return app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, privateKb: metric.memory.privateBytes ?? 0, workingKb: metric.memory.workingSetSize, cpu: metric.cpu.percentCPUUsage, urls: urls[metric.pid] ?? [] })) })()`)
    },
    navigate(url) {
      return ui.evaluate(`(() => { const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Search or enter address'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit() })()`)
    },
    guest(expression) {
      return ui.evaluate(`(() => { const w = ${visible}; if (!w) throw new Error('no webview'); return w.executeJavaScript(${JSON.stringify(expression)}, true) })()`)
    },
    async worker() {
      const target = await until(async () => (await targets()).find((entry) => entry.type === 'service_worker' && entry.url.endsWith('/background.js')), 'service worker')
      return Cdp.connect(target.webSocketDebuggerUrl)
    },
    async stop() {
      ui.close()
      main.close()
      if (child.exitCode !== null) return
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  return app
}

function summarize(metrics) {
  const total = metrics.reduce((sum, metric) => sum + metric.privateKb, 0)
  const extension = metrics.filter((metric) => metric.urls.some((url) => url.startsWith('chrome-extension://')))
  return { processes: metrics.length, privateMb: Math.round(total / 1024), extensionProcesses: extension.length, extensionPrivateMb: Math.round(extension.reduce((sum, metric) => sum + metric.privateKb, 0) / 1024) }
}

async function idleCpu(app, seconds = 20) {
  await app.metrics()
  const samples = []
  for (let second = 0; second < seconds; second += 1) {
    await wait(1000)
    samples.push((await app.metrics()).reduce((sum, metric) => sum + metric.cpu, 0))
  }
  samples.sort((a, b) => a - b)
  return { medianPercent: Number(samples[Math.floor(samples.length / 2)].toFixed(2)), maxPercent: Number(samples.at(-1).toFixed(2)) }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null
}

async function settleIdle(app) {
  await app.navigate('about:blank').catch(() => undefined)
  await wait(12_000)
}

async function footprint(extension) {
  const app = await launchApp({ extension })
  try {
    await settleIdle(app)
    const memory = summarize(await app.metrics())
    const cpu = await idleCpu(app)
    const offscreen = (await app.targets()).some((target) => target.url.endsWith('/offscreen.html'))
    return { readyMs: app.readyMs, ...memory, cpu, engineDocument: offscreen }
  } finally {
    await app.stop()
  }
}

async function popupCycle(server) {
  const app = await launchApp({ extension: true })
  try {
    await app.navigate(`${server}/medium`)
    await until(() => app.guest(`Boolean(document.querySelector('p'))`), 'page')
    await wait(3000)
    const before = summarize(await app.metrics())
    const snapshot = await app.ui.evaluate('window.vast.extensions.contributions().then((reply) => reply.contributions)')
    const key = snapshot.toolbar.find((entry) => entry.title === 'Translate').key
    const opened = Date.now()
    await app.ui.evaluate(`window.vast.extensions.dispatchContribution(${JSON.stringify(key)})`)
    await until(() => app.ui.evaluate(`(() => { const w = document.querySelector('webview.extension-toolbar-surface'); return w ? w.executeJavaScript("document.getElementById('source')?.options.length > 1", true) : false })()`), 'popup ready')
    const popupReadyMs = Date.now() - opened
    const during = summarize(await app.metrics())
    await app.ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await wait(1500)
    await app.ui.evaluate(`document.querySelector('[data-testid="extensions-toolbar-button"]')?.click()`).catch(() => undefined)
    await wait(300)
    await app.ui.evaluate(`document.querySelector('[data-testid="extensions-toolbar-button"]')?.click()`).catch(() => undefined)
    await wait(5000)
    const after = summarize(await app.metrics())
    const engineDocument = (await app.targets()).some((target) => target.url.endsWith('/offscreen.html'))
    return { popupReadyMs, before, during, after, engineDocument }
  } finally {
    await app.stop()
  }
}

async function measurePage(app, sw, tabId, url, label) {
  await app.navigate(url)
  await until(() => app.guest(`document.readyState === 'complete' && Boolean(document.querySelector('p, td'))`), label)
  await wait(500)
  // Instrument the page before translation: long tasks, first and last translated unit, and frame
  // times while the page scrolls continuously.
  await app.guest(`(() => {
    window.__bench = { longTasks: [], first: 0, last: 0, frames: [], start: 0 }
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__bench.longTasks.push(entry.duration) }).observe({ type: 'longtask' })
    new MutationObserver((records) => { for (const record of records) if (record.attributeName === 'data-tfv-unit' && record.target.getAttribute('data-tfv-unit') === 'replaced') { const now = performance.now(); if (!window.__bench.first) window.__bench.first = now; window.__bench.last = now } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tfv-unit'] })
    let previous = 0
    const tick = (time) => { if (previous) window.__bench.frames.push(time - previous); previous = time; if (window.__bench.scrolling) { scrollBy(0, 3); requestAnimationFrame(tick) } }
    window.__bench.scrolling = true
    requestAnimationFrame(tick)
    window.__bench.start = performance.now()
    return true
  })()`)
  const started = Date.now()
  await sw.evaluate(`translatorDebug.startPageTranslation(${tabId}, 'en', 'pl')`)
  const state = await until(async () => {
    const value = await sw.evaluate(`translatorDebug.pageCommand(${tabId}, { type: 'page:state' })`)
    return value.status === 'translated' || value.status === 'error' ? value : null
  }, `${label} translated`, 600_000)
  const wallMs = Date.now() - started
  const bench = await app.guest(`(() => { window.__bench.scrolling = false; const b = window.__bench; const chars = [...document.querySelectorAll('[data-tfv-unit]')].reduce((sum, e) => sum + e.textContent.length, 0); return { first: b.first - b.start, last: b.last - b.start, longTasks: b.longTasks, frames: b.frames, chars } })()`)
  await sw.evaluate(`translatorDebug.pageCommand(${tabId}, { type: 'page:restore' })`)
  const frames = bench.frames.filter((frame) => frame > 0)
  return {
    units: state.done,
    status: state.status,
    firstVisibleMs: Math.round(bench.first),
    completeMs: Math.round(bench.last),
    wallMs,
    charsPerSecond: Math.round(bench.chars / (bench.last / 1000)),
    longTasks: bench.longTasks.length,
    longestTaskMs: Math.round(Math.max(0, ...bench.longTasks)),
    frameP50Ms: Number(median(frames)?.toFixed(1)),
    frameP95Ms: Number(p95(frames)?.toFixed(1)),
    framesOver50Ms: frames.filter((frame) => frame > 50).length
  }
}

async function workflow(server) {
  // Models are prepared in a first session, then the measured session starts cold.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-tfv-bench-'))
  let app = await launchApp({ extension: true, userDataDir })
  try {
    await app.navigate(`${server}/medium`)
    const sw = await app.worker()
    await sw.evaluate(`translatorDebug.engine({ type: 'engine:download', source: 'en', target: 'pl' })`)
    sw.close()
  } finally {
    await app.stop()
  }
  app = await launchApp({ extension: true, userDataDir })
  try {
    await app.navigate(`${server}/medium`)
    await until(() => app.guest(`Boolean(document.querySelector('p'))`), 'page')
    await wait(4000)
    const idle = summarize(await app.metrics())
    const sw = await app.worker()
    await sw.evaluate(`chrome.storage.local.set({ settings: { targetLanguage: 'pl', idleSeconds: 15 } }).then(() => translatorDebug.applySettings())`)
    const tab = await sw.evaluate('translatorDebug.tabInfo()')
    // Selection path: cold first request (engine start + model load), then warm repeats.
    const engine = (fragments, priority = 'selection') => sw.evaluate(`(async () => { const t = performance.now(); const r = await translatorDebug.engine({ type: 'engine:translate', source: 'en', target: 'pl', fragments: ${JSON.stringify(fragments)}, priority: '${priority}', tag: 'bench' }); return { ms: performance.now() - t, inferenceMs: r.inferenceMs, out: r.fragments } })()`)
    let peakPrivateMb = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        peakPrivateMb = Math.max(peakPrivateMb, summarize(await app.metrics()).privateMb)
        await wait(200)
      }
    })()
    const cold = await engine(['weather'])
    const status = await sw.evaluate(`translatorDebug.engine({ type: 'engine:status' })`)
    const warmWord = []
    const warmSentence = []
    for (let index = 0; index < 20; index += 1) warmWord.push((await engine(['library'])).ms)
    for (let index = 0; index < 20; index += 1) warmSentence.push((await engine(['The city council agreed on a new plan to improve public transport and build safer cycling routes.'])).ms)
    const pages = {}
    for (const [route, label] of [['/medium', 'medium'], ['/table', 'table'], ['/large', 'large']]) pages[label] = await measurePage(app, sw, tab.tabId, `${server}${route}`, label)
    const loaded = summarize(await app.metrics())
    sampling = false
    await sampler
    const releaseStarted = Date.now()
    await until(async () => !(await app.targets()).some((target) => target.url.endsWith('/offscreen.html')), 'idle release', 120_000)
    const releasedAfterMs = Date.now() - releaseStarted
    await wait(2000)
    const released = summarize(await app.metrics())
    sw.close()
    return {
      idleBeforeUse: idle,
      engine: { coldFirstRequestMs: Math.round(cold.ms), engineInitMs: Math.round(status.metrics.lastInitMs), modelLoadMs: Math.round(status.metrics.lastRouteLoadMs), heapMb: Math.round(status.heapBytes / 1048576), coldOutput: cold.out[0] },
      selection: { wordMedianMs: Math.round(median(warmWord)), wordP95Ms: Math.round(p95(warmWord)), sentenceMedianMs: Math.round(median(warmSentence)), sentenceP95Ms: Math.round(p95(warmSentence)) },
      pages,
      memory: { idleBeforeUseMb: idle.privateMb, peakDuringUseMb: peakPrivateMb, loadedMb: loaded.privateMb, afterReleaseMb: released.privateMb, releasedAfterMs, processesLoaded: loaded.processes, processesAfterRelease: released.processes }
    }
  } finally {
    await app.stop()
  }
}

async function main() {
  const server = http.createServer((request, response) => {
    const page = fixtures[request.url.split('?')[0]]
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(page ?? '<!doctype html><title>blank</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const report = { date: new Date().toISOString(), machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) }, runs, scenarios: {} }
  const scenarios = { baseline: () => footprint(false), installed: () => footprint(true), popup: () => popupCycle(origin), workflow: () => workflow(origin) }
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue
    report.scenarios[name] = []
    for (let index = 0; index < runs; index += 1) {
      const result = await run()
      report.scenarios[name].push(result)
      console.log(name, index + 1, JSON.stringify(result))
    }
  }
  server.close()
  if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  module.exports = { Cdp, launchApp, summarize, until, wait }
}
