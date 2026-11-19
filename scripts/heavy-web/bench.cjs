#!/usr/bin/env node
// Heavy-website A/B benchmark. Each (scenario, target) pair runs in a fresh
// process with a disposable profile, interleaved across repetitions so drift
// (thermals, background load) spreads over all targets.
// Usage: node scripts/heavy-web/bench.cjs --out=<dir> [--targets=vast,chrome,min-window,min-webview]
//   [--scenarios=webgl-light,webgl-gpu,webgl-replace,webgpu,workers,input] [--reps=3] [--seconds=8]
//   [--vast=<Vast.exe>] [--label=<name>] [--trace=1] [--hz=144]
const fs = require('node:fs')
const path = require('node:path')
const { close, frameStats, hostMetrics, hostMetricsDelta, launch, percentile, startFixtureServer, startSampler, startTrace, summarizeSamples, summarizeTrace, wait } = require('./lib.cjs')

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=')] }))
const targets = (args.targets || 'vast,chrome,min-window,min-webview').split(',')
const scenarios = (args.scenarios || 'webgl-light,webgl-gpu,webgl-replace,webgpu,workers,tiles,input').split(',')
const reps = Number(args.reps || 3)
const seconds = Number(args.seconds || 8)
const refreshHz = Number(args.hz || 144)
const out = path.resolve(args.out || 'heavy-web-results')
const label = args.label || 'run'
fs.mkdirSync(out, { recursive: true })

const SCENARIOS = {
  'webgl-light': { page: 'webgl.html?steps=12&instances=2000' },
  'webgl-gpu': { page: 'webgl.html?steps=96&instances=20000' },
  'webgl-replace': { page: 'webgl.html?steps=12&instances=2000&replace=10' },
  webgpu: { page: 'webgpu.html?particles=1000000' },
  workers: { page: 'workers.html', workers: true },
  tiles: { page: 'tiles.html', tiles: true },
  input: { page: 'webgl.html?steps=12&instances=2000', input: true }
}

async function waitFixture(page) {
  for (let i = 0; i < 200; i += 1) {
    const state = await page.evaluate('window.__fixture ? { ready: window.__fixture.kind !== "webgpu" || window.__fixture.ready, error: window.__fixture.error } : null').catch(() => null)
    if (state?.error) throw new Error(state.error)
    if (state?.ready) return
    await wait(100)
  }
  throw new Error('fixture did not become ready')
}

// "vast" is the packaged Store candidate (or --vast); "vast:<label>" is a
// build from package-bench.cjs.
function vastExecutable(target) {
  const label = target.split(':')[1]
  return label ? path.resolve(__dirname, '../../.vast-build/heavy-web', label, 'win-unpacked/Vast.exe') : args.vast
}

async function runOne(scenarioName, target, base, viewport) {
  const scenario = SCENARIOS[scenarioName]
  const kind = target.split(':')[0]
  const handle = await launch(kind, `${base}/${scenario.page}`, { viewport, executable: kind === 'vast' ? vastExecutable(target) : undefined, requireVisible: !(scenario.workers || scenario.tiles),
    // Vast's built-in probe: profile-save counters and main-process event-loop delay.
    args: kind === 'vast' ? [`--vast-performance-report=${path.join(out, `${label}-${scenarioName}-perf.json`)}`] : [] })
  // Counters are cumulative; the event-loop delay resets on each read.
  const probe = () => kind === 'vast' && handle.host ? handle.host.evaluate('window.vast.app.performanceCounters()').catch(() => null) : null
  const probeDelta = (before, after) => before && after ? {
    storageWrites: after.storageWrites - before.storageWrites, storageMB: +((after.storageBytes - before.storageBytes) / 1048576).toFixed(2),
    storageWriteMs: +(after.storageWriteDurationMs - before.storageWriteDurationMs).toFixed(1),
    mainEventLoopDelayP95Ms: after.eventLoopDelayP95Ms, mainEventLoopDelayP99Ms: after.eventLoopDelayP99Ms, mainEventLoopDelayMaxMs: after.eventLoopDelayMaxMs
  } : null
  const result = { scenario: scenarioName, target, product: handle.version.Browser }
  try {
    await waitFixture(handle.page)
    result.viewport = await handle.page.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState })')
    await wait(4000)
    const samplerFile = path.join(out, `${label}-${scenarioName}-${kind}-samples.jsonl`)
    const sampler = startSampler(handle.child.pid, samplerFile)
    await wait(1200)
    if (scenario.tiles) {
      await handle.page.evaluate('runTiles(300)', 120000)
      const before = await probe()
      result.tiles = []
      for (let i = 0; i < 3; i += 1) result.tiles.push(await handle.page.evaluate('runTiles()', 120000))
      result.main = probeDelta(before, await probe())
      result.resources = summarizeSamples(await sampler.stop())
      return result
    }
    if (scenario.workers) {
      result.workers = []
      for (let i = 0; i < 3; i += 1) result.workers.push(await handle.page.evaluate('runWorkerJob()', 120000))
      result.resources = summarizeSamples(await sampler.stop())
      return result
    }
    const trace = args.trace === '1' ? await startTrace(handle.browser) : null
    const clockUs = async () => (await handle.page.evaluate('performance.timeOrigin + performance.now()')) * 1000
    await handle.page.evaluate('window.__fixture.frames = []; window.__fixture.events = []; window.__fixture.recording = true; window.__fixture.replacedAtStart = window.__fixture.replaced')
    const hostBefore = await hostMetrics(handle.host).catch(() => null)
    const probeBefore = await probe()
    const startedWall = Date.now()
    if (scenario.input) {
      const { width, height } = result.viewport
      for (let i = 0; i < 20; i += 1) {
        const x = Math.round(width * (0.3 + 0.02 * i))
        const y = Math.round(height / 2)
        await handle.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await handle.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await wait(seconds * 1000 / 22)
      }
    }
    const remaining = seconds * 1000 - (Date.now() - startedWall)
    if (remaining > 0) await wait(remaining)
    const fixture = await handle.page.evaluate('(() => { const f = window.__fixture; f.recording = false; return { backing: f.viewport && f.viewport.backing, frames: f.frames, events: f.events, replaced: (f.replaced || 0) - (f.replacedAtStart || 0), renderer: f.renderer, adapters: f.adapters, clicks: document.body.dataset.clicks } })()')
    result.host = hostMetricsDelta(hostBefore, await hostMetrics(handle.host).catch(() => null), (Date.now() - startedWall) / 1000)
    result.main = probeDelta(probeBefore, await probe())
    if (scenarioName === 'webgl-replace' && kind === 'vast') {
      // What the URL churn did to the user's history (after the save debounce).
      await wait(1500)
      result.history = await handle.host.evaluate(`window.vast.storage.load().then((data) => ({ entries: data.history.length, fromFixture: data.history.filter((entry) => entry.url.includes('/webgl.html')).length, seededRemaining: data.history.filter((entry) => entry.id.startsWith('history-seed-')).length }))`).catch((error) => ({ error: error.message }))
    }
    result.resources = summarizeSamples(await sampler.stop())
    result.frames = frameStats(fixture.frames, refreshHz)
    result.backing = fixture.backing
    result.renderer = fixture.renderer || fixture.adapters?.default?.description
    if (scenarioName === 'webgl-replace') result.replaceStateCalls = fixture.replaced
    if (scenario.input) {
      const pointer = fixture.events.filter((event) => event.name === 'pointerdown' || event.name === 'mousedown')
      result.input = { observed: pointer.length, clicks: Number(fixture.clicks || 0), durationP50: percentile(pointer.map((e) => e.duration), 0.5), durationP95: percentile(pointer.map((e) => e.duration), 0.95), delayP95: percentile(pointer.map((e) => e.delay), 0.95) }
    }
    if (trace) {
      const end = await clockUs()
      const events = await trace.stop()
      // performance.timeOrigin is wall-clock; the trace clock is monotonic.
      // Use the recorded frames' span instead: the last N seconds of the trace.
      let traceEnd = 0
      for (const event of events) if (event.ts > traceEnd) traceEnd = event.ts
      result.trace = summarizeTrace(events, traceEnd - seconds * 1e6, traceEnd)
      result.trace.wallEndUs = end
    }
    return result
  } finally {
    await close(handle)
  }
}

async function main() {
  const { server, base } = await startFixtureServer()
  const results = []
  const file = path.join(out, `${label}.json`)
  let viewport = args.viewport ? { width: Number(args.viewport.split('x')[0]), height: Number(args.viewport.split('x')[1]) } : null
  try {
    if (!viewport) {
      // Reference viewport: the guest area of a default Vast window.
      const probe = await launch('vast', `${base}/workers.html`, { executable: args.vast })
      viewport = await probe.page.evaluate('({ width: innerWidth, height: innerHeight })')
      await close(probe)
    }
    console.log(`viewport ${viewport.width}x${viewport.height}`)
    for (let rep = 0; rep < reps; rep += 1) {
      for (const scenario of scenarios) {
        // Rotate the target order every repetition.
        const order = targets.map((_, index) => targets[(index + rep) % targets.length])
        for (const kind of order) {
          try {
            // One relaunch if the window never became visible: a measurement
            // is taken only from a visible, unoccluded window.
            const result = await runOne(scenario, kind, base, viewport).catch(async (error) => {
              if (!/never became visible/.test(error.message)) throw error
              console.log(`[${rep}] ${scenario} ${kind}: relaunching (${error.message})`)
              const retried = await runOne(scenario, kind, base, viewport)
              retried.relaunched = true
              return retried
            })
            result.rep = rep
            results.push(result)
            const f = result.frames
            console.log(`[${rep}] ${scenario} ${kind}: ${f ? `fps ${f.fps} p95 ${f.p95} p99 ${f.p99} long ${f.longFramesOver2Vsync}` : ''}${result.workers ? `workers ${result.workers.map((w) => w.elapsedMs.toFixed(0)).join('/')} ms pool ${result.workers[0].poolSize}` : ''}${result.input ? ` input p95 ${result.input.durationP95}` : ''}${result.tiles ? `tiles ${result.tiles.map((t) => t.requestsPerSecond).join('/')} req/s p95 ${result.tiles.map((t) => t.p95).join('/')}` : ''}${result.host ? ` host busy ${result.host.mainThreadBusyPercent}% layouts/s ${result.host.layoutsPerSecond}` : ''}${result.main ? ` main ELD p99 ${result.main.mainEventLoopDelayP99Ms?.toFixed(1)}ms saves ${result.main.storageWrites} (${result.main.storageWriteMs}ms)` : ''}${result.history ? ` history ${JSON.stringify(result.history)}` : ''} cpu ${result.resources?.totalCpuPercentOfOneCore}% gpu ${JSON.stringify(result.resources?.gpuEngineBusyPercent)} ${result.trace ? `swaps ${JSON.stringify(result.trace.displaySwapsPerSecond)}` : ''}`)
          } catch (error) {
            console.log(`[${rep}] ${scenario} ${kind}: ERROR ${error.message}`)
            results.push({ scenario, target: kind, rep, error: error.message })
          }
          fs.writeFileSync(file, JSON.stringify({ label, createdAt: new Date().toISOString(), viewport, refreshHz, seconds, reps, results }, null, 2))
        }
      }
    }
  } finally {
    server.close()
  }
  console.log(`wrote ${file}`)
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
