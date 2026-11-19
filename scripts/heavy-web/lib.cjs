// Shared harness for heavy-website A/B runs: Vast (packaged), Chrome, and a
// minimal Electron host on the same patched runtime. Every target gets a
// disposable profile and the same local fixtures and viewport.
const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '../..')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_PATHS = {
  vast: path.join(root, 'release/store-electron/win-unpacked/Vast.exe'),
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  electron: path.join(root, '.vast-build/electron-dist/electron-45.0.0-vast-r1-win32-x64/electron.exe')
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
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
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(listener)
  }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression, timeoutMs) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  close() { try { this.socket.close() } catch {} }
}

async function listTargets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json()).catch(() => [])
}

async function waitTarget(port, predicate, timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = (await listTargets(port)).find(predicate)
    if (found) return found
    await wait(150)
  }
  throw new Error('CDP target not found')
}

const TILE = Buffer.alloc(2048, 7)

function startFixtureServer() {
  const fixtures = path.join(__dirname, 'fixtures')
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/tile/')) {
      response.setHeader('Content-Type', 'application/octet-stream')
      response.setHeader('Cache-Control', 'no-store')
      return response.end(TILE)
    }
    // Map viewers rewrite the path (/webgl.html/@lat,lng); serve the same page.
    const name = url.pathname.split('/')[1] || 'index.html'
    const file = path.join(fixtures, path.basename(name))
    if (!file.startsWith(fixtures) || !fs.existsSync(file)) {
      response.statusCode = 404
      return response.end('Not found')
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.end(fs.readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

async function seededVastProfile(profile, url) {
  const constants = await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)
  const { seedBenchmarkProfile } = require(path.join(root, 'scripts/guest-scroll-profile.cjs'))
  const data = seedBenchmarkProfile(constants.DEFAULT_DATA, url)
  // A lived-in profile: a full history and site memory, so per-navigation
  // bookkeeping and profile saves cost what they cost for a real user.
  const now = Date.now()
  data.history = Array.from({ length: 1000 }, (_, index) => ({
    id: `history-seed-${index}`, title: `Seeded page ${index} - a typical page title of moderate length`,
    url: `https://site-${index % 250}.example.com/articles/${index}/a-reasonably-long-slug-for-a-real-page?ref=feed&id=${index}`,
    favicon: `https://site-${index % 250}.example.com/favicon.ico`, visitCount: 1 + (index % 7), lastVisitedAt: now - index * 60000
  }))
  data.siteMemory = Array.from({ length: 250 }, (_, index) => ({
    origin: `https://site-${index}.example.com`, hostname: `site-${index}.example.com`, title: `Site ${index}`,
    lastUrl: `https://site-${index}.example.com/articles/${index}`, visitCount: 3, lastUsedAt: now - index * 60000, updatedAt: now - index * 60000
  }))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))
  return data
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
}

/**
 * Launches one target at a URL and returns CDP handles for the page that runs
 * the workload (the guest for Vast and the webview host), plus the browser.
 */
// Applied to every target alike. Windows' native occlusion tracking can mark
// a focused, on-top window as hidden, which stops its frames; this only turns
// that heuristic off and leaves the rendering and presentation path untouched.
const HARNESS_ARGS = ['--disable-features=CalculateNativeWinOcclusion']

async function launch(kind, url, options = {}) {
  options = { ...options, args: [...HARNESS_ARGS, ...(options.args || [])] }
  const port = 10000 + Math.floor(Math.random() * 40000)
  const profile = fs.mkdtempSync(path.join(options.profileRoot || os.tmpdir(), `heavy-${kind}-`))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  let pageMatch = (item) => item.type === 'page' && item.url.startsWith(url.split('?')[0])
  const viewport = options.viewport
  if (kind === 'vast') {
    await seededVastProfile(profile, url)
    if (options.vastSettings) {
      const file = path.join(profile, 'vast-data.json')
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      options.vastSettings(data.settings)
      fs.writeFileSync(file, JSON.stringify(data))
    }
    Object.assign(env, { VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0' }, options.env || {})
    child = spawn(options.executable || DEFAULT_PATHS.vast, [`--remote-debugging-port=${port}`, ...(options.args || [])], { env, stdio: 'ignore' })
    pageMatch = (item) => item.type === 'webview' && item.url.startsWith(url.split('?')[0])
  } else if (kind === 'chrome') {
    const size = viewport ? `--window-size=${viewport.width + 16},${viewport.height + 100}` : '--window-size=1600,1000'
    child = spawn(options.executable || DEFAULT_PATHS.chrome, [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
      '--window-position=0,0', size, ...(options.args || []), url
    ], { env, stdio: 'ignore' })
  } else if (/^min-(window|webview)(-intercept)?$/.test(kind)) {
    Object.assign(env, { HEAVY_WEB_INTERCEPT: kind.endsWith('-intercept') ? '1' : '0' })
    Object.assign(env, {
      HEAVY_WEB_MODE: kind.startsWith('min-window') ? 'window' : 'webview', HEAVY_WEB_URL: url, HEAVY_WEB_PROFILE: profile,
      HEAVY_WEB_WIDTH: String(viewport?.width || 1280), HEAVY_WEB_HEIGHT: String(viewport?.height || 800)
    })
    child = spawn(options.executable || DEFAULT_PATHS.electron, [path.join(__dirname, 'min-host'), `--remote-debugging-port=${port}`, ...(options.args || [])], { env, stdio: 'ignore' })
    if (kind.startsWith('min-webview')) pageMatch = (item) => item.type === 'webview' && item.url.startsWith(url.split('?')[0])
  } else {
    throw new Error(`Unknown target ${kind}`)
  }
  const handle = { kind, port, child, profile, url }
  try {
    const target = await waitTarget(port, pageMatch)
    handle.page = await Cdp.connect(target.webSocketDebuggerUrl)
    await handle.page.send('Runtime.enable')
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())
    handle.browser = await Cdp.connect(version.webSocketDebuggerUrl)
    if (kind === 'vast' || kind.startsWith('min-webview')) {
      const hostTarget = (await listTargets(port)).find((item) => item.type === 'page' && (kind === 'vast' ? item.url.includes('index.html') : item.url.startsWith('data:')))
      if (hostTarget) {
        handle.host = await Cdp.connect(hostTarget.webSocketDebuggerUrl)
        await handle.host.send('Runtime.enable')
        await handle.host.send('Performance.enable')
      }
    }
    handle.version = version
    if (kind === 'chrome' && viewport) await matchChromeViewport(handle, viewport)
    await handle.page.send('Page.bringToFront').catch(() => undefined)
    // Occluded windows stop producing frames; never measure one. Scenarios
    // that do not render (workers, fetches) skip this and never take focus.
    for (let attempt = 0; options.requireVisible !== false; attempt += 1) {
      await raiseWindow(child.pid)
      await wait(400)
      if (await handle.page.evaluate('document.visibilityState').catch(() => '') === 'visible') break
      if (attempt >= 30) throw new Error('Page never became visible')
    }
    return handle
  } catch (error) {
    await close(handle)
    throw error
  }
}

async function raiseWindow(rootPid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'front.ps1'), '-RootPid', String(rootPid)], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      await wait(250)
    }
  }
  throw new Error('No visible window to raise')
}

// Chrome's window frame size differs from Electron's; nudge the window until
// the page viewport equals the reference viewport.
async function matchChromeViewport(handle, viewport) {
  const targets = await listTargets(handle.port)
  const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl === handle.page.socket.url) || targets.find((item) => item.type === 'page')
  const { windowId } = await handle.browser.send('Browser.getWindowForTarget', { targetId: page.id })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const inner = await handle.page.evaluate('({ width: innerWidth, height: innerHeight })')
    if (inner.width === viewport.width && inner.height === viewport.height) return
    const { bounds } = await handle.browser.send('Browser.getWindowBounds', { windowId })
    await handle.browser.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: bounds.width + viewport.width - inner.width, height: bounds.height + viewport.height - inner.height, windowState: 'normal' } })
    await wait(400)
  }
}

async function close(handle) {
  try { await handle.browser?.send('Browser.close', {}, 3000) } catch {}
  handle.page?.close()
  handle.host?.close()
  handle.browser?.close()
  if (handle.child && handle.child.exitCode === null) await Promise.race([new Promise((resolve) => handle.child.once('exit', resolve)), wait(4000)])
  killTree(handle.child)
  await wait(500)
  try { fs.rmSync(handle.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
}

function startSampler(rootPid, outFile, intervalMs = 1000) {
  const stopFile = `${outFile}.stop`
  try { fs.rmSync(stopFile, { force: true }); fs.rmSync(outFile, { force: true }) } catch {}
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sampler.ps1'), '-RootPid', String(rootPid), '-Output', outFile, '-StopFile', stopFile, '-IntervalMs', String(intervalMs)], { stdio: 'ignore', windowsHide: true })
  return {
    async stop() {
      fs.writeFileSync(stopFile, '')
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(8000)])
      if (child.exitCode === null) killTree(child)
      const lines = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean) : []
      fs.rmSync(stopFile, { force: true })
      return lines.map((line) => { try { return JSON.parse(line.replace(/^\uFEFF/, '')) } catch { return null } }).filter(Boolean)
    }
  }
}

// CPU seconds, GPU engine seconds per adapter and private memory between the
// first and last sample, grouped by Chromium process type.
function summarizeSamples(samples) {
  if (samples.length < 2) return { error: 'not enough samples', samples: samples.length }
  const first = samples[0]
  const last = samples.at(-1)
  const seconds = (last.t - first.t) / 1000
  const cpuByType = {}
  for (const [pid, proc] of Object.entries(last.processes)) {
    const before = first.processes[pid]?.cpu100ns ?? 0
    cpuByType[proc.type] = (cpuByType[proc.type] || 0) + (proc.cpu100ns - before) / 1e7
  }
  const cpuPercentOfOneCore = Object.fromEntries(Object.entries(cpuByType).map(([type, value]) => [type, +(100 * value / seconds).toFixed(1)]))
  const totalCpu = Object.values(cpuByType).reduce((sum, value) => sum + value, 0)
  const gpu = {}
  for (const [key, value] of Object.entries(last.gpuRunning100ns || {})) {
    const [, luid, engine] = key.split('|')
    const delta = (value - (first.gpuRunning100ns?.[key] ?? 0)) / 1e7
    if (delta <= 0) continue
    const label = `${luid}:${engine}`
    gpu[label] = +((gpu[label] || 0) + 100 * delta / seconds).toFixed(1)
  }
  const peakPrivate = Math.max(...samples.map((sample) => Object.values(sample.processes).reduce((sum, proc) => sum + proc.privateBytes, 0)))
  const lastPrivate = Object.values(last.processes).reduce((sum, proc) => sum + proc.privateBytes, 0)
  return {
    seconds: +seconds.toFixed(2),
    cpuPercentOfOneCore, totalCpuPercentOfOneCore: +(100 * totalCpu / seconds).toFixed(1),
    gpuEngineBusyPercent: gpu,
    privateMB: +(lastPrivate / 1048576).toFixed(0), peakPrivateMB: +(peakPrivate / 1048576).toFixed(0),
    processCount: Object.keys(last.processes).length
  }
}

const TRACE_CATEGORIES = ['benchmark', 'viz', 'gpu', 'cc', 'graphics.pipeline', 'disabled-by-default-devtools.timeline.frame', '__metadata']

async function startTrace(browser) {
  const events = []
  browser.on('Tracing.dataCollected', (params) => { for (const event of params.value) events.push(event) })
  const done = new Promise((resolve) => browser.on('Tracing.tracingComplete', resolve))
  await browser.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordContinuously', includedCategories: TRACE_CATEGORIES, excludedCategories: ['*'] } })
  return {
    async stop() {
      await browser.send('Tracing.end')
      await Promise.race([done, wait(30000)])
      return events
    }
  }
}

// Frames the display compositor actually drew and swapped, and the per-renderer
// pipeline outcome (presented vs dropped), from the trace.
function summarizeTrace(events, windowStartUs, windowEndUs) {
  const processNames = {}
  for (const event of events) if (event.ph === 'M' && event.name === 'process_name') processNames[event.pid] = event.args?.name
  const inWindow = (event) => event.ts >= windowStartUs && event.ts <= windowEndUs
  const swaps = {}
  const pipeline = {}
  for (const event of events) {
    if (!inWindow(event)) continue
    if (event.name === 'Display::DrawAndSwap' && (event.ph === 'X' || event.ph === 'B')) swaps[event.pid] = (swaps[event.pid] || 0) + 1
    // Forked reporters duplicate a frame for a second source; count each
    // compositor frame once.
    if (event.name === 'PipelineReporter' && event.ph === 'b' && event.args?.frame_reporter?.frame_type !== 'FORKED') {
      const state = event.args?.frame_reporter?.state ?? 'unknown'
      const key = `${event.pid}`
      pipeline[key] = pipeline[key] || {}
      pipeline[key][state] = (pipeline[key][state] || 0) + 1
    }
  }
  const seconds = (windowEndUs - windowStartUs) / 1e6
  return {
    displaySwapsPerSecond: Object.fromEntries(Object.entries(swaps).map(([pid, count]) => [`${processNames[pid] || 'pid'}:${pid}`, +(count / seconds).toFixed(1)])),
    pipelineByProcess: Object.fromEntries(Object.entries(pipeline).map(([pid, states]) => [`${processNames[pid] || 'pid'}:${pid}`, states])),
    eventCount: events.length
  }
}

const HOST_METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes']

async function hostMetrics(host) {
  if (!host) return null
  const { metrics } = await host.send('Performance.getMetrics')
  return Object.fromEntries(metrics.filter((metric) => HOST_METRICS.includes(metric.name)).map((metric) => [metric.name, metric.value]))
}

function hostMetricsDelta(before, after, seconds) {
  if (!before || !after) return null
  const perSecond = (name) => +((after[name] - before[name]) / seconds).toFixed(name.endsWith('Duration') ? 4 : 2)
  return {
    mainThreadBusyPercent: +(100 * (after.TaskDuration - before.TaskDuration) / seconds).toFixed(2),
    scriptMsPerSecond: +(1000 * perSecond('ScriptDuration')).toFixed(2),
    layoutsPerSecond: perSecond('LayoutCount'), styleRecalcsPerSecond: perSecond('RecalcStyleCount'),
    heapMB: +(after.JSHeapUsedSize / 1048576).toFixed(1), heapGrowthMB: +((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576).toFixed(1)
  }
}

function frameStats(timestamps, refreshHz) {
  if (timestamps.length < 3) return { frames: timestamps.length }
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]).sort((a, b) => a - b)
  const pick = (q) => intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))]
  const vsync = 1000 / refreshHz
  const span = (timestamps.at(-1) - timestamps[0]) / 1000
  // An interval covering n vsyncs means n-1 refreshes without a new frame.
  const missedVsyncs = intervals.reduce((sum, value) => sum + Math.max(0, Math.round(value / vsync) - 1), 0)
  return {
    frames: timestamps.length, fps: +((timestamps.length - 1) / span).toFixed(1),
    p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), p99: +pick(0.99).toFixed(2), max: +intervals.at(-1).toFixed(2),
    longFramesOver2Vsync: intervals.filter((value) => value > 2.5 * vsync).length,
    missedVsyncPercent: +(100 * missedVsyncs / (missedVsyncs + intervals.length)).toFixed(1)
  }
}

function percentile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1)
}

module.exports = { hostMetrics, hostMetricsDelta, Cdp, DEFAULT_PATHS, close, frameStats, launch, listTargets, percentile, root, startFixtureServer, startSampler, startTrace, summarizeSamples, summarizeTrace, wait, waitTarget }
