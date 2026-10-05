#!/usr/bin/env node
// Measures local guest navigations in a packaged Vast with a disposable profile.
// The server never redirects to an external or authenticated site.
const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { seedBenchmarkProfile } = require('./guest-scroll-profile.cjs')

function parseOptions(argv) {
  const result = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg)
    if (!match) throw new Error(`Invalid argument: ${arg}`)
    result[match[1]] = match[2]
  }
  if (!result.executable || !result.output) throw new Error('Usage: node scripts/guest-load-benchmark.cjs --executable=<packaged Vast.exe> --output=<directory> [--repetitions=3]')
  result.repetitions = Number(result.repetitions || 3)
  if (!Number.isInteger(result.repetitions) || result.repetitions < 1 || result.repetitions > 10) throw new Error('Invalid repetitions')
  return result
}
const options = parseOptions(process.argv.slice(2))
const executable = path.resolve(options.executable)
const output = path.resolve(options.output)
if (!fs.statSync(executable).isFile()) throw new Error('Executable not found')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
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
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  close() { this.socket.close() }
}

async function waitTarget(port, predicate) {
  const started = Date.now()
  while (Date.now() - started < 60000) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json()).catch(() => [])
    const found = list.find(predicate)
    if (found) return found
    await wait(100)
  }
  throw new Error('Guest CDP target not found')
}

function fixture(kind, run) {
  const css = kind === 'fanout' ? Array.from({ length: 24 }, (_, index) => `<link rel="stylesheet" href="/asset/${run}/style/${index}.css">`).join('') : ''
  const scripts = kind === 'fanout' ? Array.from({ length: 24 }, (_, index) => `<script defer src="/asset/${run}/script/${index}.js"></script>`).join('') : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vast load fixture</title>${css}${scripts}</head><body><main>Local first-visible-content fixture</main></body></html>`
}

async function runNavigation(guest, url, kind, repetition) {
  const started = performance.now()
  const navigation = await guest.send('Page.navigate', { url })
  if (navigation.errorText) throw new Error(navigation.errorText)
  let result
  while (performance.now() - started < 30000) {
    result = await guest.evaluate(`(() => {
      if (location.href !== ${JSON.stringify(url)} || document.readyState !== 'complete') return null;
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      if (!nav || !nav.loadEventEnd || !fcp) return null;
      return {
        navigationType: nav.type, responseStartMs: nav.responseStart,
        responseEndMs: nav.responseEnd, domInteractiveMs: nav.domInteractive,
        domContentLoadedMs: nav.domContentLoadedEventEnd,
        loadMs: nav.loadEventEnd, fcpMs: fcp.startTime,
        resourceCount: performance.getEntriesByType('resource').length,
        longTasks: globalThis.__vastLoadLongTasks || []
      };
    })()`).catch(() => null)
    if (result) break
    await wait(30)
  }
  if (!result) throw new Error(`Timed out waiting for navigation ${url}`)
  return { kind, repetition, ...result, cdpNavigateToObservedMs: performance.now() - started }
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const requests = new Map()
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const asset = /^\/asset\/([^/]+)\/(style|script)\/(\d+)\.(css|js)$/.exec(url.pathname)
    response.setHeader('Cache-Control', 'no-store')
    if (asset) {
      requests.set(asset[1], (requests.get(asset[1]) || 0) + 1)
      response.setHeader('Content-Type', asset[2] === 'style' ? 'text/css' : 'text/javascript')
      response.end(asset[2] === 'style' ? `main{border-bottom:${Number(asset[3]) % 2 + 1}px solid #ddd}` : `globalThis.__vastFixtureScripts=(globalThis.__vastFixtureScripts||0)+1`)
    } else if (url.pathname === '/ready') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>Ready</title><main>Ready</main>')
    } else if (url.pathname === '/simple' || url.pathname === '/fanout') {
      response.setHeader('Content-Type', 'text/html')
      response.end(fixture(url.pathname.slice(1), url.searchParams.get('run')))
    } else {
      response.statusCode = 404
      response.end('Not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const constants = await import(pathToFileURL(path.join(__dirname, '../src/shared/constants.ts')).href)
  const profile = fs.mkdtempSync(path.join(output, 'profile-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(seedBenchmarkProfile(constants.DEFAULT_DATA, `${base}/ready`)))
  const debugPort = 10000 + Math.floor(Math.random() * 30000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const childArgs = [`--remote-debugging-port=${debugPort}`]
  if (options.startupReport === '1') childArgs.push(`--vast-performance-report=${path.join(output, 'startup.json')}`)
  const child = spawn(executable, childArgs, { env, windowsHide: true, stdio: 'ignore' })
  let host, guest
  try {
    const hostTarget = await waitTarget(debugPort, (item) => item.type === 'page' && item.url.includes('index.html'))
    host = await Cdp.connect(hostTarget.webSocketDebuggerUrl)
    await host.send('Runtime.enable')
    const started = Date.now()
    while (Date.now() - started < 60000) {
      if (await host.evaluate(`document.querySelector('webview')?.getURL() === ${JSON.stringify(`${base}/ready`)} && !document.querySelector('webview').isLoading()`).catch(() => false)) break
      await wait(100)
    }
    if (Date.now() - started >= 60000) throw new Error('Initial guest did not finish loading')
    const target = await waitTarget(debugPort, (item) => item.url === `${base}/ready`)
    guest = await Cdp.connect(target.webSocketDebuggerUrl)
    await guest.send('Page.enable')
    await guest.send('Runtime.enable')
    await guest.send('Network.enable')
    await guest.send('Network.setCacheDisabled', { cacheDisabled: true })
    await guest.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__vastLoadLongTasks=[];new PerformanceObserver(list=>globalThis.__vastLoadLongTasks.push(...list.getEntries().map(entry=>({startMs:entry.startTime,durationMs:entry.duration})))).observe({type:'longtask',buffered:true})` })
    await wait(1200)
    const results = []
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const kind of ['simple', 'fanout']) {
        const run = `${kind}-${repetition}`
        const result = await runNavigation(guest, `${base}/${kind}?run=${run}`, kind, repetition)
        result.serverAssetRequests = requests.get(run) || 0
        result.expectedAssetRequests = kind === 'fanout' ? 48 : 0
        if (result.serverAssetRequests !== result.expectedAssetRequests) throw new Error(`Fixture request count mismatch: ${run}`)
        results.push(result)
        console.log(`${kind} ${repetition}/${options.repetitions}: FCP ${result.fcpMs.toFixed(1)} ms, DOM interactive ${result.domInteractiveMs.toFixed(1)} ms, load ${result.loadMs.toFixed(1)} ms`)
      }
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ schemaVersion: 1, executable, base, conditions: 'Packaged app, disposable profile, local HTTP fixtures, guest CDP Page.navigate, HTTP cache disabled, 1.2 s startup warm-up, no personal sites', limitations: 'Navigation Timing and FCP are guest renderer milestones, not first GPU presentation or full interaction readiness; localhost cannot model real network latency.', createdAt: new Date().toISOString(), results }, null, 2))
  } finally {
    await host?.evaluate('window.vast.app.window.close()').catch(() => undefined)
    if (child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(3000)])
    }
    if (child.exitCode === null) try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    host?.close()
    guest?.close()
    server.close()
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
