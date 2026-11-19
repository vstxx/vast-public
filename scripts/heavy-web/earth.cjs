#!/usr/bin/env node
// Real-world scenario: Google Earth (network-dependent). Loads the globe, then
// pans it in stop-and-go strokes and records the page's rAF cadence, displayed
// frames, long tasks, GPU/CPU load and same-document URL updates. Load
// network traffic is counted from the page target (worker fetches are not
// visible there, so the interaction phase reports no network figures).
// Usage: node scripts/heavy-web/earth.cjs --out=<dir> [--targets=vast:before,chrome,min-webview] [--reps=2] [--seconds=12]
const fs = require('node:fs')
const path = require('node:path')
const { close, frameStats, hostMetrics, hostMetricsDelta, launch, percentile, startSampler, startTrace, summarizeSamples, summarizeTrace, wait } = require('./lib.cjs')

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=')] }))
const targets = (args.targets || 'vast:before,chrome,min-webview').split(',')
const reps = Number(args.reps || 2)
const seconds = Number(args.seconds || 12)
const out = path.resolve(args.out || 'heavy-web-earth')
const label = args.label || 'earth'
const viewport = { width: 1480, height: 853 }
const URL_START = 'https://earth.google.com/web/@52.2297,21.0122,120a,4500d,35y,0h,60t,0r'
fs.mkdirSync(out, { recursive: true })

// Installed before any page script: timestamps every rAF callback batch and
// collects long tasks, so the page's own render loop is measured unchanged.
const INSTRUMENT = `(() => {
  const state = window.__earth = { frames: [], longTasks: [], recording: false };
  const original = window.requestAnimationFrame.bind(window);
  let last = -1;
  window.requestAnimationFrame = (callback) => original((now) => { if (state.recording && now !== last) { last = now; state.frames.push(now) } return callback(now) });
  try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (state.recording) state.longTasks.push(entry.duration) }).observe({ type: 'longtask' }) } catch {}
})()`

async function runOne(target) {
  const [kind, buildLabel] = target.split(':')
  const executable = kind === 'vast' && buildLabel ? path.resolve(__dirname, '../../.vast-build/heavy-web', buildLabel, 'win-unpacked/Vast.exe') : undefined
  const handle = await launch(kind, 'https://earth.google.com/', {
    viewport, executable,
    args: kind === 'vast' ? [`--vast-performance-report=${path.join(out, `${label}-${target.replace(':', '-')}-perf.json`)}`] : []
  }).catch(async (error) => { throw error })
  const result = { target, product: handle.version.Browser }
  try {
    const page = handle.page
    await page.send('Page.enable')
    await page.send('Network.enable')
    await page.send('Network.setCacheDisabled', { cacheDisabled: true })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    let sameDocument = 0
    page.on('Page.navigatedWithinDocument', () => { sameDocument += 1 })
    let requests = 0
    let bytes = 0
    page.on('Network.requestWillBeSent', () => { requests += 1 })
    page.on('Network.loadingFinished', (event) => { bytes += event.encodedDataLength || 0 })

    // Load: navigation to a fixed camera, cold HTTP cache.
    const started = Date.now()
    await page.send('Page.navigate', { url: URL_START })
    let canvasAt = null
    let quietSince = Date.now()
    let lastRequests = 0
    while (Date.now() - started < 60000) {
      await wait(250)
      if (!canvasAt && await page.evaluate("!!document.querySelector('canvas') || !!document.querySelector('earth-app')?.shadowRoot").catch(() => false)) canvasAt = Date.now() - started
      if (requests !== lastRequests) { lastRequests = requests; quietSince = Date.now() }
      if (canvasAt && Date.now() - quietSince > 2500) break
    }
    result.load = {
      appShellMs: canvasAt, networkQuietMs: quietSince - started, requests, transferredMB: +(bytes / 1048576).toFixed(1),
      navigation: await page.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; const r = performance.getEntriesByType('resource'); return n ? { responseEnd: Math.round(n.responseEnd), domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), resources: r.length, lastResourceEnd: Math.round(Math.max(0, ...r.map((e) => e.responseEnd))) } : null })()`).catch(() => null)
    }
    // Earth flies in from space after loading and ignores drags until the
    // camera settles at the requested view; start only after that.
    // Earth sometimes opens a promotional dialog that blocks the fly-in;
    // a second navigation to the same camera gets past it (Escape cannot be
    // used: it opens Earth's project panel). Runs whose camera never moved
    // are marked invalid and excluded from comparisons.
    const settleStarted = Date.now()
    let settledUrl = ''
    while (Date.now() - settleStarted < 45000) {
      const href = await page.evaluate('location.href').catch(() => '')
      if (/@52.22/.test(href) && href === settledUrl) break
      settledUrl = href
      await wait(1000)
    }
    if (!/@52.22/.test(settledUrl)) {
      result.load.renavigated = true
      await page.send('Page.navigate', { url: URL_START })
      await wait(12000)
    }
    await wait(3000)
    result.load.settledMs = Date.now() - started
    result.load.settledAtTarget = /@52.2/.test(await page.evaluate('location.href').catch(() => ''))
    result.hardwareConcurrency = await page.evaluate('navigator.hardwareConcurrency').catch(() => null)
    result.crossOriginIsolated = await page.evaluate('self.crossOriginIsolated').catch(() => null)

    // Interaction: drag the globe in a slow circle for a fixed time.
    const sampler = startSampler(handle.child.pid, path.join(out, `${label}-${target.replace(':', '-')}-samples.jsonl`))
    await wait(1200)
    const trace = await startTrace(handle.browser)
    const hostBefore = await hostMetrics(handle.host).catch(() => null)
    const probeBefore = kind === 'vast' && handle.host ? await handle.host.evaluate('window.vast.app.performanceCounters()').catch(() => null) : null
    sameDocument = 0
    await page.evaluate('window.__earth && (window.__earth.frames = [], window.__earth.longTasks = [], window.__earth.recording = true)')
    // Explore: pan steadily in one direction in ~1.3 s strokes, as a user
    // flying over a city does, so new tiles stream and the camera keeps moving.
    const cx = viewport.width / 2
    const cy = viewport.height / 2
    const hrefBefore = await page.evaluate('location.href').catch(() => '')
    const dragStarted = Date.now()
    let step = 0
    while (Date.now() - dragStarted < seconds * 1000) {
      const x0 = Math.round(cx + 200)
      const y0 = Math.round(cy + (step % 3 - 1) * 40)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 })
      for (let i = 1; i <= 80; i += 1) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - i * 5, y: y0, button: 'left', buttons: 1 })
        await wait(16)
      }
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 - 400, y: y0, button: 'left', buttons: 0, clickCount: 1 })
      // Pause like a user looking around; Earth writes the camera into the
      // URL (history.replaceState) only once the camera comes to rest.
      await wait(900)
      step += 1
    }
    const measuredSeconds = (Date.now() - dragStarted) / 1000
    result.cameraMoved = hrefBefore !== await page.evaluate('location.href').catch(() => '')
    result.strokes = step
    const earth = await page.evaluate('(() => { const s = window.__earth; if (!s) return null; s.recording = false; return { frames: s.frames, longTasks: s.longTasks } })()').catch(() => null)
    result.host = hostMetricsDelta(hostBefore, await hostMetrics(handle.host).catch(() => null), measuredSeconds)
    const probeAfter = probeBefore ? await handle.host.evaluate('window.vast.app.performanceCounters()').catch(() => null) : null
    if (probeBefore && probeAfter) result.main = { storageWrites: probeAfter.storageWrites - probeBefore.storageWrites, storageWriteMs: +(probeAfter.storageWriteDurationMs - probeBefore.storageWriteDurationMs).toFixed(1), mainEventLoopDelayP99Ms: probeAfter.eventLoopDelayP99Ms, mainEventLoopDelayMaxMs: probeAfter.eventLoopDelayMaxMs }
    const events = await trace.stop()
    let traceEnd = 0
    for (const event of events) if (event.ts > traceEnd) traceEnd = event.ts
    result.trace = summarizeTrace(events, traceEnd - measuredSeconds * 1e6, traceEnd)
    result.resources = summarizeSamples(await sampler.stop())
    result.interaction = {
      seconds: +measuredSeconds.toFixed(1),
      frames: earth ? frameStats(earth.frames, 144) : null,
      longTasks: earth ? { count: earth.longTasks.length, totalMs: Math.round(earth.longTasks.reduce((a, b) => a + b, 0)), p95: percentile(earth.longTasks, 0.95) } : null,
      sameDocumentNavigations: sameDocument, sameDocumentPerSecond: +(sameDocument / measuredSeconds).toFixed(1)
    }
    if (kind === 'vast' && handle.host) {
      await wait(1500)
      result.history = await handle.host.evaluate("window.vast.storage.load().then((data) => ({ entries: data.history.length, earth: data.history.filter((entry) => entry.url.includes('earth.google.com')).length, seededRemaining: data.history.filter((entry) => entry.id.startsWith('history-seed-')).length }))").catch((error) => ({ error: error.message }))
    }
    return result
  } finally {
    await close(handle)
  }
}

async function main() {
  const results = []
  const file = path.join(out, `${label}.json`)
  for (let rep = 0; rep < reps; rep += 1) {
    const order = targets.map((_, index) => targets[(index + rep) % targets.length])
    for (const target of order) {
      try {
        const result = await runOne(target)
        result.rep = rep
        results.push(result)
        const f = result.interaction.frames
        console.log(`[${rep}] ${target}${result.cameraMoved ? '' : ' (INVALID: camera did not move)'}: load shell ${result.load.appShellMs}ms quiet ${result.load.networkQuietMs}ms settled ${result.load.settledMs}ms ${result.load.transferredMB}MB | drag fps ${f?.fps} p95 ${f?.p95} p99 ${f?.p99} long ${f?.longFramesOver2Vsync} | longtasks ${result.interaction.longTasks?.count}/${result.interaction.longTasks?.totalMs}ms | sameDoc/s ${result.interaction.sameDocumentPerSecond} | moved ${result.cameraMoved} strokes ${result.strokes} | cpu ${result.resources?.totalCpuPercentOfOneCore}% gpu ${JSON.stringify(result.resources?.gpuEngineBusyPercent)}${result.host ? ` | host busy ${result.host.mainThreadBusyPercent}%` : ''}${result.main ? ` | saves ${result.main.storageWrites} ELD p99 ${result.main.mainEventLoopDelayP99Ms?.toFixed(1)}` : ''}${result.history ? ` | history ${JSON.stringify(result.history)}` : ''} | hc ${result.hardwareConcurrency} coi ${result.crossOriginIsolated}`)
      } catch (error) {
        console.log(`[${rep}] ${target}: ERROR ${error.message}`)
        results.push({ target, rep, error: error.message })
      }
      fs.writeFileSync(file, JSON.stringify({ label, createdAt: new Date().toISOString(), url: URL_START, viewport, seconds, results }, null, 2))
    }
  }
  console.log(`wrote ${file}`)
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
