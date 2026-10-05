#!/usr/bin/env node
// Run against packaged Vast executables with disposable profiles. Never point
// this harness at an existing profile or an authenticated website.
const { spawn, execFile, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { summarizeIntervals, summarizeScrollTrace, summarizeValues } = require('./guest-scroll-metrics.cjs')
const { seedBenchmarkProfile } = require('./guest-scroll-profile.cjs')

const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const separator = arg.indexOf('=')
  return separator < 0 ? [arg.slice(2), true] : [arg.slice(2, separator), arg.slice(separator + 1)]
}))
if (!options.executable || !options.output || !options['refresh-hz']) {
  console.error('Usage: node scripts/guest-scroll-benchmark.cjs --executable=<packaged Vast.exe> --output=<directory> --refresh-hz=<measured Hz> [--app-root=<diagnostic Electron app>] [--template-root=<source checkout>] [--repetitions=3] [--fixtures=text,spa,nested,virtualized] [--input-mode=cdp-wheel|cdp-fixed|windows-wheel] [--cadence-ms=18] [--dom-probe-only] [--disable-compatible-extensions] [--disable-gpu]')
  process.exit(2)
}
const executable = path.resolve(options.executable)
const appRoot = options['app-root'] ? path.resolve(options['app-root']) : null
const output = path.resolve(options.output)
const sourceRoot = path.resolve(options['template-root'] || path.join(__dirname, '..'))
const refreshHz = Number(options['refresh-hz'])
const repetitions = Number(options.repetitions || 3)
const inputMode = options['input-mode'] || 'cdp-wheel'
const fixedCadenceMs = Number(options['cadence-ms'] || 18)
const domProbeOnly = options['dom-probe-only'] === true
const availableFixtures = ['text', 'spa', 'nested', 'virtualized']
const fixtures = options.fixtures ? String(options.fixtures).split(',') : availableFixtures
const diagnosticControls = {
  compatibleExtensionsDisabled: options['disable-compatible-extensions'] === true,
  gpuDisabled: options['disable-gpu'] === true
}
if (!fs.statSync(executable).isFile() || (appRoot && !fs.existsSync(path.join(appRoot, 'package.json'))) ||
    !Number.isFinite(refreshHz) || refreshHz < 30 || refreshHz > 500 ||
    !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 ||
    !['cdp-wheel', 'cdp-fixed', 'windows-wheel'].includes(inputMode) ||
    !Number.isFinite(fixedCadenceMs) || fixedCadenceMs < 5 || fixedCadenceMs > 100 ||
    (domProbeOnly && (fixtures.length !== 1 || fixtures[0] !== 'spa')) ||
    (inputMode === 'windows-wheel' && process.platform !== 'win32') ||
    fixtures.length === 0 || new Set(fixtures).size !== fixtures.length || fixtures.some((name) => !availableFixtures.includes(name)) ||
    (options['disable-compatible-extensions'] !== undefined && !diagnosticControls.compatibleExtensionsDisabled) ||
    (options['disable-gpu'] !== undefined && !diagnosticControls.gpuDisabled)) throw new Error('Invalid benchmark arguments')
const refreshIntervalMs = 1000 / refreshHz
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const progress = (message) => { if (options.verbose) console.log(`[benchmark] ${message}`) }

function fixture(name) {
  const style = '<style>html,body{margin:0;font:16px/1.45 system-ui;background:#fff;color:#111}*{box-sizing:border-box}.row{border-bottom:1px solid #ddd;padding:9px 16px}.box{overflow:auto;border:2px solid #444;height:540px;margin:20px}.inner{height:350px;margin:55px;border-color:#888}</style>'
  const repeated = Array.from({ length: 1800 }, (_, i) => `<p class="row">Paragraph ${i}: A long text fixture with repeated words and natural wrapping across the viewport. Chromium should scroll this content natively.</p>`).join('')
  if (name === 'text') return `<!doctype html><meta charset="utf-8"><title>Vast perf text</title>${style}<main data-wheel-target>${repeated}</main>`
  if (name === 'spa') return `<!doctype html><meta charset="utf-8"><title>Vast perf SPA</title>${style}<main data-wheel-target>${repeated}<div id="status"></div></main><script>let n=0;setInterval(()=>{document.querySelector('#status').textContent='Update '+(++n);for(const item of document.querySelectorAll('.row:nth-child(50n)'))item.style.background=n%2?'#fafafa':'#fff'},50)</script>`
  if (name === 'nested') return `<!doctype html><meta charset="utf-8"><title>Vast perf nested</title>${style}<div class="box"><div class="box inner" data-wheel-target>${repeated}</div>${repeated}</div>${repeated}`
  if (name === 'virtualized') return `<!doctype html><meta charset="utf-8"><title>Vast perf virtualized</title>${style}<div class="box" data-wheel-target id="list"><div style="height:1600000px;position:relative" id="space"></div></div><script>const list=document.querySelector('#list'),space=document.querySelector('#space');const pool=Array.from({length:45},()=>{const row=document.createElement('div');row.className='row';row.style.cssText='position:absolute;height:40px;width:100%';space.append(row);return row});function render(){const first=Math.floor(list.scrollTop/40);pool.forEach((row,i)=>{const index=first+i;row.style.top=(index*40)+'px';row.textContent='Conversation '+index+' — preview text with labels, timestamps, and a short summary'})}list.addEventListener('scroll',render,{passive:true});render()</script>`
  throw new Error(`Unknown fixture ${name}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params)
      }
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
  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, listener) {
    const set = this.listeners.get(method) || new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => set.delete(listener)
  }
  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`CDP event timeout: ${method}`)) }, timeoutMs)
      const off = this.on(method, (params) => { clearTimeout(timer); off(); resolve(params) })
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.socket.close() }
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(700) })
  return response.json()
}
async function waitTarget(port, predicate, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const target = (await targets(port).catch(() => [])).find(predicate)
    if (target) return target
    await wait(100)
  }
  throw new Error('Timed out waiting for the requested CDP target')
}
async function waitFor(cdp, expression, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await cdp.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
function metricsMap(response) { return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value])) }
function metricDelta(before, after) {
  const fields = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize']
  return Object.fromEntries(fields.map((field) => [field, (after[field] ?? 0) - (before[field] ?? 0)]))
}
function processInventory() {
  const escaped = executable.replace(/'/g, "''")
  const command = `$rows=Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq '${escaped}'; @($rows|ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;kind=([regex]::Match($_.CommandLine,'--type=([^ ]+)').Groups[1].Value);cpu=(Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CPU} })|ConvertTo-Json -Compress`
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim()
  const parsed = raw ? JSON.parse(raw) : []
  return Array.isArray(parsed) ? parsed : [parsed]
}
function processDelta(before, after) {
  return after.map((row) => ({ pid: row.pid, kind: row.kind || 'browser', cpuSeconds: Math.max(0, (row.cpu || 0) - (before.find((entry) => entry.pid === row.pid)?.cpu || 0)) }))
}

async function sendWindowsWheel({ pid, screenX, screenY }) {
  const script = path.join(__dirname, 'windows-wheel-input.ps1')
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-TargetPid', String(pid), '-ExpectedExecutable', executable,
    '-ScreenX', String(screenX), '-ScreenY', String(screenY),
    '-Count', '90', '-IntervalMs', '18', '-WheelDelta', '-120']
  const stdout = await new Promise((resolve, reject) => {
    execFile('powershell', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (error, output, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()))
      else resolve(output)
    })
  })
  const result = JSON.parse(stdout.trim())
  if (result.ok !== true || result.sent !== 90) throw new Error('Windows wheel input was incomplete')
  return result
}

async function captureTrace(cdp, action, file) {
  await cdp.send('Tracing.start', { categories: 'blink,cc,gpu,viz,devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReturnAsStream' })
  await action()
  const complete = cdp.once('Tracing.tracingComplete', 90000)
  await cdp.send('Tracing.end')
  const { stream } = await complete
  const chunks = []
  while (true) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1024 * 1024 })
    chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data)
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  fs.writeFileSync(file, chunks.join(''))
  return JSON.parse(chunks.join('')).traceEvents || []
}

async function measureFixture({ host, browser, port, debugPort, childPid, name, repetition }) {
  const url = `http://127.0.0.1:${port}/fixture/${name}?run=${repetition}`
  await host.evaluate(`document.querySelector('webview').loadURL(${JSON.stringify(url)})`)
  const guestTarget = await waitTarget(debugPort, (target) => target.url === url)
  const guest = await Cdp.connect(guestTarget.webSocketDebuggerUrl)
  await guest.send('Runtime.enable')
  try {
  await guest.send('Page.bringToFront')
  await waitFor(guest, `location.href === ${JSON.stringify(url)} && Boolean(document.querySelector('[data-wheel-target]'))`)
  await wait(1200)
  const domProbe = domProbeOnly && name === 'spa' ? await guest.evaluate(`(() => {
    const queryMs=[],classQueryMs=[],styleAndLayoutMs=[];
    for(let i=0;i<30;i++){
      let start=performance.now();
      document.querySelectorAll('.row');
      classQueryMs.push(performance.now()-start);
      start=performance.now();
      const rows=document.querySelectorAll('.row:nth-child(50n)');
      queryMs.push(performance.now()-start);
      start=performance.now();
      for(const row of rows)row.style.background=i%2?'#fafafa':'#fff';
      for(const row of rows)void row.offsetTop;
      styleAndLayoutMs.push(performance.now()-start);
    }
    return {matchedRows:document.querySelectorAll('.row:nth-child(50n)').length,queryMs,classQueryMs,styleAndLayoutMs};
  })()`) : null
  if (domProbeOnly) return {
    name, repetition, url,
    domProbe: {
      matchedRows: domProbe.matchedRows,
      queryMs: summarizeValues(domProbe.queryMs),
      classQueryMs: summarizeValues(domProbe.classQueryMs),
      styleAndLayoutMs: summarizeValues(domProbe.styleAndLayoutMs)
    }
  }
  await guest.send('Performance.enable')
  const preparation = `(() => { const target=document.querySelector('[data-wheel-target]'); target.scrollTop=0; window.scrollTo(0,0); window.__vastScroll={frames:[],wheel:[],wheelDeltaY:0,scroll:[],longTasks:[]};let active=false;function frame(now){if(!active)return;window.__vastScroll.frames.push(now);requestAnimationFrame(frame)}window.__vastStartFrames=()=>{if(active)return;active=true;requestAnimationFrame(frame)};window.__vastStopFrames=()=>{active=false};document.addEventListener('wheel',e=>{window.__vastScroll.wheel.push(performance.now());window.__vastScroll.wheelDeltaY+=e.deltaY},{passive:true,capture:true});document.addEventListener('scroll',()=>window.__vastScroll.scroll.push(performance.now()),{passive:true,capture:true});new PerformanceObserver(list=>window.__vastScroll.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});return {rect:target.getBoundingClientRect().toJSON(),dpr:devicePixelRatio,width:innerWidth,height:innerHeight}})()`
  const page = await guest.evaluate(preparation)
  const visibilityAtStart = await guest.evaluate('document.visibilityState')
  if (visibilityAtStart !== 'visible') throw new Error(`Guest is backgrounded before input: ${visibilityAtStart}`)
  progress(`${name} ${repetition}: guest prepared`)
  const beforeProcesses = processInventory()
  const beforeMetrics = metricsMap(await guest.send('Performance.getMetrics'))
  await guest.evaluate('window.__vastStartFrames()')
  progress(`${name} ${repetition}: metrics captured, tracing next`)
  const x = Math.round(Math.max(5, Math.min(page.width - 5, page.rect.x + page.rect.width / 2)))
  const y = Math.round(Math.max(5, Math.min(page.height - 5, page.rect.y + Math.min(page.rect.height / 2, 250))))
  const tracePath = path.join(output, `${name}-${repetition}.trace.json`)
  let measurements
  let afterMetrics
  let windowsInput = null
  let inputDrainAfterSettleMs = 0
  const dispatchRoundTrips = []
  const cdpSendTimes = []
  const events = await captureTrace(browser, async () => {
    if (inputMode === 'windows-wheel') {
      const point = await host.evaluate(`(() => {const r=document.querySelector('webview').getBoundingClientRect();return {x:Math.round(window.screenX+r.x+${x}),y:Math.round(window.screenY+r.y+${y})}})()`)
      progress(`${name} ${repetition}: Windows wheel input at ${point.x},${point.y}`)
      windowsInput = await sendWindowsWheel({ pid: childPid, screenX: point.x, screenY: point.y })
    } else if (inputMode === 'cdp-fixed') {
      const start = performance.now()
      const pending = []
      for (let index = 0; index < 90; index += 1) {
        if (index % 30 === 0) progress(`${name} ${repetition}: wheel ${index + 1}`)
        await wait(Math.max(0, start + index * fixedCadenceMs - performance.now()))
        const sentAt = performance.now()
        cdpSendTimes.push(sentAt)
        pending.push(guest.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 100, pointerType: 'mouse' })
          .then(() => ({ roundTripMs: performance.now() - sentAt }), (error) => ({ error })))
      }
      const acknowledgments = await Promise.all(pending)
      const failed = acknowledgments.find((result) => result.error)
      if (failed) throw failed.error
      dispatchRoundTrips.push(...acknowledgments.map((result) => result.roundTripMs))
    } else {
      for (let index = 0; index < 90; index += 1) {
        if (index % 30 === 0) progress(`${name} ${repetition}: wheel ${index + 1}`)
        const sentAt = performance.now()
        cdpSendTimes.push(sentAt)
        await guest.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 100, pointerType: 'mouse' })
        dispatchRoundTrips.push(performance.now() - sentAt)
        await wait(18)
      }
    }
    progress(`${name} ${repetition}: 90 wheel dispatches acknowledged`)
    await wait(300)
    if (inputMode === 'cdp-fixed' && await guest.evaluate('window.__vastScroll.wheelDeltaY') < 9000) {
      const drainStarted = performance.now()
      await waitFor(guest, 'window.__vastScroll.wheelDeltaY >= 9000', 5000)
      inputDrainAfterSettleMs = Math.round((performance.now() - drainStarted) * 100) / 100
    }
    measurements = await guest.evaluate(`(() => {window.__vastStopFrames();const m=window.__vastScroll;return {...m,visibilityState:document.visibilityState,scrollTop:document.querySelector('[data-wheel-target]').scrollTop||document.scrollingElement.scrollTop}})()`)
    if (visibilityAtStart !== 'visible' || measurements.visibilityState !== 'visible') {
      throw new Error(`Guest was backgrounded: ${visibilityAtStart} -> ${measurements.visibilityState}`)
    }
    if (Math.abs(measurements.wheelDeltaY - 9000) > 0.01 || Math.abs(measurements.scrollTop - 9000) > 1) {
      throw new Error(`Guest wheel input incomplete: ${measurements.wheel.length} events, deltaY ${measurements.wheelDeltaY}, scrollTop ${measurements.scrollTop}`)
    }
    afterMetrics = metricsMap(await guest.send('Performance.getMetrics'))
  }, tracePath)
  progress(`${name} ${repetition}: trace captured`)
  const afterProcesses = processInventory()
  const scrollTrace = summarizeScrollTrace(events, refreshIntervalMs)
  const gpuDisplayIntervals = summarizeIntervals(events.filter((event) => event.name === 'Display::FrameDisplayed').map((event) => event.ts / 1000), refreshIntervalMs)
  const eventNames = [...new Set(events.map((event) => event.name).filter((item) => /present|frame/i.test(item)))].slice(0, 100)
  return {
    name, repetition, url, viewport: page, domProbe: domProbe ? {
      matchedRows: domProbe.matchedRows,
      queryMs: summarizeValues(domProbe.queryMs),
      styleAndLayoutMs: summarizeValues(domProbe.styleAndLayoutMs)
    } : null, visibilityAtStart, visibilityAtEnd: measurements.visibilityState, wheelCount: measurements.wheel.length, wheelDeltaY: measurements.wheelDeltaY,
    scrollEventCount: measurements.scroll.length, scrollTop: measurements.scrollTop,
    cdpWheelDispatchRoundTripMs: summarizeValues(dispatchRoundTrips),
    cdpWheelSendIntervals: summarizeIntervals(cdpSendTimes, refreshIntervalMs),
    cdpWheelSendSpanMs: cdpSendTimes.length > 1 ? Math.round((cdpSendTimes.at(-1) - cdpSendTimes[0]) * 100) / 100 : null,
    inputDrainAfterSettleMs,
    windowsInput: windowsInput ? { sent: windowsInput.sent, elapsedMs: windowsInput.elapsedMs, sendIntervals: summarizeIntervals(windowsInput.timesMs, refreshIntervalMs) } : null,
    guestWheelArrivalIntervals: summarizeIntervals(measurements.wheel, refreshIntervalMs),
    guestWheelArrivalSpanMs: measurements.wheel.length > 1 ? Math.round((measurements.wheel.at(-1) - measurements.wheel[0]) * 100) / 100 : null,
    guestRafIntervals: summarizeIntervals(measurements.frames, refreshIntervalMs),
    guestLongTasks: { count: measurements.longTasks.length, totalMs: measurements.longTasks.reduce((sum, value) => sum + value, 0), maxMs: Math.max(0, ...measurements.longTasks) },
    guestPerformance: metricDelta(beforeMetrics, afterMetrics), processCpu: processDelta(beforeProcesses, afterProcesses),
    scrollTrace, gpuDisplayIntervals,
    presentationEvidence: scrollTrace?.presentedUpdates ? `${scrollTrace.gpuDisplayedPresentations}/${scrollTrace.presentedUpdates} guest scroll Presentation events share a timestamp with Viz Display::FrameDisplayed; physical scanout was not captured` : 'unavailable',
    traceEventCount: events.length, frameRelatedTraceNames: eventNames, tracePath
  }
  } finally {
    guest.close()
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    const name = /^\/fixture\/(text|spa|nested|virtualized)$/.exec(pathname)?.[1]
    if (!name) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(fixture(name))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const sourceTemplate = (await import(pathToFileURL(path.join(sourceRoot, 'src/shared/constants.ts')).href)).DEFAULT_DATA
  const template = seedBenchmarkProfile(sourceTemplate, `http://127.0.0.1:${port}/fixture/text`)
  const profile = fs.mkdtempSync(path.join(output, 'profile-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(template))
  const debugPort = 10000 + Math.floor(Math.random() * 30000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0', VAST_SCROLL_FIXTURE_ORIGIN: `http://127.0.0.1:${port}` }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VAST_EXTENSION_COMPATIBILITY_DISABLE
  if (diagnosticControls.compatibleExtensionsDisabled) env.VAST_EXTENSION_COMPATIBILITY_DISABLE = '1'
  const launchArgs = [`--remote-debugging-port=${debugPort}`]
  if (diagnosticControls.gpuDisabled) launchArgs.push('--disable-gpu')
  if (appRoot) launchArgs.push(appRoot)
  const child = spawn(executable, launchArgs, { env, windowsHide: inputMode !== 'windows-wheel', stdio: 'ignore' })
  let host, browser
  try {
    const hostTarget = await waitTarget(debugPort, (target) => target.type === 'page' && target.url.includes('index.html'))
    host = await Cdp.connect(hostTarget.webSocketDebuggerUrl)
    await host.send('Runtime.enable')
    await waitFor(host, `document.querySelector('webview')?.getURL().includes('/fixture/text')`, 60000)
    await waitFor(host, `!document.querySelector('webview').isLoading()`, 60000)
    const browserInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
    browser = await Cdp.connect(browserInfo.webSocketDebuggerUrl)
    const gpuInfo = await browser.send('SystemInfo.getInfo').catch((error) => ({ unavailable: error.message }))
    await host.evaluate('window.resizeTo(1280,800)')
    await host.send('Page.bringToFront')
    const results = []
    for (const name of fixtures) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        console.log(`${name} ${repetition}/${repetitions}`)
        const result = await measureFixture({ host, browser, port, debugPort, childPid: child.pid, name, repetition })
        results.push(result)
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ schemaVersion: domProbeOnly ? 7 : inputMode === 'cdp-fixed' ? 8 : 6, executable, appRoot, sourceRoot, refreshHz, port, platform: os.platform(), diagnosticControls, gpuInfo, fixtures, inputMode, fixedCadenceMs: inputMode === 'cdp-fixed' ? fixedCadenceMs : null, inputCadence: domProbeOnly ? 'no input; synchronous DOM probe only' : inputMode === 'windows-wheel' ? '90 Win32 SendInput mouse-wheel events scheduled 18 ms apart; foreground verified before each event' : inputMode === 'cdp-fixed' ? `90 CDP mouseWheel commands scheduled ${fixedCadenceMs} ms apart without waiting for each acknowledgment; actual send and guest arrival cadence are recorded` : '90 CDP mouseWheel commands; wait for each acknowledgement, then pause 18 ms; actual guest arrival cadence is recorded', measurementWindow: domProbeOnly ? '30 synchronous selector and style/layout samples after guest warm-up' : 'Guest rAF and Performance metrics bracket synthetic wheel input and 300 ms settle; process CPU includes trace serialization', createdAt: new Date().toISOString(), results }, null, 2))
      }
    }
  } finally {
    await host?.evaluate('window.vast.app.window.close()').catch(() => undefined)
    await wait(1000)
    if (child.exitCode === null) try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    host?.close(); browser?.close(); server.close()
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
