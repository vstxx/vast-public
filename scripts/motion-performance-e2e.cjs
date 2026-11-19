// Motion performance benchmark: drives the built app (out/) over CDP in
// isolated, seeded heavy profiles and measures every animated surface —
// open/close latency, frame pacing during the motion, layout/style work,
// webview resizes, idle CPU, memory, compositor layers and startup — for each
// requested motion mode.
//
// Usage: npm run build, then
//   node scripts/motion-performance-e2e.cjs --label=baseline --modes=legacy
//   node scripts/motion-performance-e2e.cjs --label=final --modes=off,standard,enhanced
// Results: performance-results/motion-<label>.json (summary printed as JSON lines).
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const electron = require('electron')
const arg = (name, fallback) => (process.argv.find((value) => value.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split('=')[1]
const label = arg('label', 'run')
const modes = arg('modes', 'off,standard,enhanced').split(',')
const reps = Number(arg('reps', '7'))
const startupRuns = Number(arg('startup', '5'))
// Optional comma-separated operation filter for focused re-measurement.
const only = arg('ops', '') ? arg('ops', '').split(',') : null
const wanted = (name) => !only || only.some((op) => name.startsWith(op))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const serverPort = 9910 + Math.floor(Math.random() * 60)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) { for (const listener of this.listeners) listener(message); return }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const session = new Cdp(ws)
    await session.send('Runtime.enable')
    await session.send('Performance.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  async key(key, code, keyCode, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
  }

  async click(expression, button = 'left') {
    const point = await this.evaluate(`(() => { const e=${expression}; if(!e) throw new Error('Missing click target'); e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
  }
}

const CTRL = 2
const keys = {
  palette: (cdp) => cdp.key('k', 'KeyK', 75, CTRL),
  find: (cdp) => cdp.key('f', 'KeyF', 70, CTRL),
  newTab: (cdp) => cdp.key('t', 'KeyT', 84, CTRL),
  closeTab: (cdp) => cdp.key('w', 'KeyW', 87, CTRL),
  sidebar: (cdp) => cdp.key('b', 'KeyB', 66, CTRL),
  address: (cdp) => cdp.key('l', 'KeyL', 76, CTRL),
  escape: (cdp) => cdp.key('Escape', 'Escape', 27)
}

// A surface counts as shown once present and not exiting; as dismissed once
// it is gone or exiting (inert, pointer-transparent, never focusable).
const shown = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => !e.closest('[data-motion-exiting]'))`
const dismissed = (selector) => `!(${shown(selector)})`

// In-page recorder: rAF intervals plus a MutationObserver/rAF readiness probe,
// timed from a mark set immediately before the input is dispatched.
const RECORDER = `window.__mp = {
  start(ready, windowMs) {
    const state = { frames: [], t0: null, ready: null, settled: null, resizes: 0 }
    const check = () => { if (state.ready === null && state.t0 !== null) { try { if (ready()) state.ready = performance.now() } catch {} } }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    const webview = [...document.querySelectorAll('webview')].find((v) => v.getBoundingClientRect().width > 0)
    let lastSize = webview ? webview.clientWidth + 'x' + webview.clientHeight : ''
    const resize = webview ? new ResizeObserver(() => { const size = webview.clientWidth + 'x' + webview.clientHeight; if (size !== lastSize) { lastSize = size; state.resizes += 1 } }) : null
    resize?.observe(webview)
    const started = performance.now()
    let last = started
    state.done = new Promise((resolve) => {
      const tick = (now) => {
        if (state.t0 !== null) state.frames.push(now - last)
        last = now
        check()
        if (state.t0 !== null && state.ready !== null && state.settled === null) {
          const running = document.getAnimations().filter((a) => a.playState === 'running').length
          const transitioning = document.querySelector('.is-sidebar-resizing')
          if (!running && !transitioning) state.settled = now
        }
        const base = state.t0 ?? started
        if (now - started > 6000 || (state.t0 !== null && state.ready !== null && now - base >= windowMs)) {
          observer.disconnect(); resize?.disconnect()
          resolve({ frames: state.frames, latencyMs: state.ready === null ? null : state.ready - state.t0, settleMs: state.settled === null ? null : state.settled - state.t0, webviewResizes: state.resizes })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // A window that stops producing frames (occluded) must not hang the run.
      setTimeout(() => resolve({ frames: state.frames, latencyMs: state.ready === null ? null : state.ready - state.t0, settleMs: null, webviewResizes: state.resizes, stalled: true }), 7000)
    })
    window.__mpState = state
  },
  // The trigger is sent right after this mark; shortcuts reach the renderer
  // through the main process, so a renderer input event cannot be the origin.
  mark() { window.__mpState.t0 = performance.now() },
  finish() { return window.__mpState.done }
}`

const METRICS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']
async function metrics(cdp) {
  const result = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(result.metrics.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value]))
}

let refreshMs = 16.67
async function measure(cdp, readyExpr, trigger, windowMs = 450) {
  await cdp.evaluate(`window.__mp.start(() => (${readyExpr}), ${windowMs})`)
  const before = await metrics(cdp)
  await cdp.evaluate('window.__mp.mark()')
  await trigger()
  const sample = await cdp.evaluate('window.__mp.finish()')
  const after = await metrics(cdp)
  const delta = Object.fromEntries(METRICS.map((key) => [key, after[key] - before[key]]))
  const frames = sample.frames.slice(1)
  return {
    latencyMs: sample.latencyMs,
    settleMs: sample.settleMs,
    longFrames: frames.filter((f) => f > refreshMs * 1.5).length,
    maxFrameMs: frames.length ? Math.max(...frames) : 0,
    p95FrameMs: percentile(frames, 0.95),
    layouts: delta.LayoutCount,
    styleRecalcs: delta.RecalcStyleCount,
    layoutMs: delta.LayoutDuration * 1000,
    styleMs: delta.RecalcStyleDuration * 1000,
    scriptMs: delta.ScriptDuration * 1000,
    webviewResizes: sample.webviewResizes
  }
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarize(samples) {
  const keysOf = Object.keys(samples[0] ?? {})
  const out = { n: samples.length }
  for (const key of keysOf) {
    const values = samples.map((s) => s[key]).filter((v) => typeof v === 'number')
    if (!values.length) { out[key] = null; continue }
    out[key] = { median: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)) }
  }
  out.missing = samples.filter((s) => s.latencyMs === null).length
  return out
}
const round = (v) => v === null ? null : Math.round(v * 100) / 100

function treeStats(pid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); $added = $true; while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }; $ps = Get-Process -Id $ids -ErrorAction SilentlyContinue; @{ cpu = ($ps | Measure-Object CPU -Sum).Sum; ws = ($ps | Measure-Object WorkingSet64 -Sum).Sum; priv = ($ps | Measure-Object PrivateMemorySize64 -Sum).Sum } | ConvertTo-Json -Compress`], { encoding: 'utf8' })
  return JSON.parse(out)
}

function seed(template, { layout, mode }) {
  const data = structuredClone(template)
  const workspace = data.workspaces.find((item) => !item.isPrivate) || data.workspaces[0]
  const now = Date.now()
  data.onboarding = { completed: true, revision: 1 }
  data.settings.openingAnimation = false
  data.settings.hibernateInactiveTabs = true
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.settings.advanced.experimentalFeatures = layout === 'purist'
  data.settings.layoutMode = layout
  data.settings.animations = mode !== 'off'
  if (mode === 'standard' || mode === 'enhanced') data.settings.motionLevel = mode
  data.tabGroups = [
    { id: 'perf-group-large', workspaceId: workspace.id, name: 'Large group', color: '#74e7ff', collapsed: false, order: 0 },
    { id: 'perf-group-small', workspaceId: workspace.id, name: 'Small group', color: '#b7a7ff', collapsed: false, order: 1 }
  ]
  data.tabs = Array.from({ length: 70 }, (_, index) => ({
    id: `perf-tab-${index}`,
    workspaceId: workspace.id,
    title: `Perf Tab ${index}`,
    url: `http://127.0.0.1:${serverPort}/page/${index}`,
    displayUrl: `127.0.0.1:${serverPort}/page/${index}`,
    pinned: index === 1,
    groupId: index >= 10 && index < 50 ? 'perf-group-large' : index >= 50 && index < 54 ? 'perf-group-small' : undefined,
    status: 'idle',
    lifecycle: index === 0 ? 'active' : 'sleeping',
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    createdAt: now - 70 + index,
    lastAccessedAt: index === 0 ? now : now - index * 1000
  }))
  workspace.activeTabId = data.tabs[0].id
  data.activeWorkspaceId = workspace.id
  data.splitView = { enabled: false }
  data.history = Array.from({ length: 1000 }, (_, index) => ({
    id: `perf-history-${index}`, title: `Perf history page ${index}`, url: `http://127.0.0.1:${serverPort}/history/${index}`,
    visitCount: 1 + (index % 7), lastVisitedAt: now - index * 60_000
  }))
  data.bookmarks = Array.from({ length: 300 }, (_, index) => ({
    id: `perf-bookmark-${index}`, title: `Perf bookmark ${index}`, url: `http://127.0.0.1:${serverPort}/bookmark/${index}`, createdAt: now, updatedAt: now
  }))
  return data
}

async function launch(profile, port) {
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_RELAY_TEST_OFFLINE: '1', VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const spawnedAt = performance.now()
  const child = spawn(electron, [root, `--remote-debugging-port=${port}`, '--force-device-scale-factor=1', '--window-size=1600,1000'], { env, stdio: 'ignore' })
  let cdp
  for (let attempt = 0; attempt < 600 && !cdp; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = list.find((item) => item.type === 'page' && item.url.includes('index.html'))
      if (target) cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    } catch {}
    if (!cdp) await wait(50)
  }
  assert(cdp, 'renderer did not start')
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await cdp.evaluate(`Boolean(document.querySelector('.app-shell'))`).catch(() => false)) break
    await wait(25)
  }
  return { child, cdp, shellMs: performance.now() - spawnedAt }
}

async function close(child, cdp) {
  await cdp.evaluate('window.vast.app.window.close()').catch(() => undefined)
  const exited = await new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 10_000); child.once('exit', () => { clearTimeout(timer); resolve(true) }) })
  if (!exited) try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
  await wait(1200)
}

async function until(cdp, expression, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await cdp.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await wait(40)
  }
  throw new Error(`Timed out: ${expression}`)
}

async function repeat(name, results, count, body) {
  if (!wanted(name)) return
  try { await repeatUnsafe(name, results, count, body) } catch (error) {
    results[name] = { error: error.message.slice(0, 300) }
    console.log(JSON.stringify({ op: name, error: results[name].error }))
  }
}

async function repeatUnsafe(name, results, count, body) {
  const samples = []
  for (let index = 0; index < count + 1; index += 1) {
    const sample = await body(index)
    if (index > 0) samples.push(sample) // first run is a warmup
  }
  results[name] = summarize(samples)
  console.log(JSON.stringify({ op: name, ...results[name] }))
}

async function openClose(...args) {
  const [cdp, results, name] = args
  if (!wanted(name)) return
  try { await openCloseUnsafe(...args) } catch (error) {
    results[name] = { error: error.message.slice(0, 300) }
    console.log(JSON.stringify({ op: name, error: results[name].error }))
    await keys.escape(cdp).catch(() => undefined)
  }
}

async function openCloseUnsafe(cdp, results, name, selector, open, closeAction, readyExtra = '', prepare = async () => {}) {
  if (process.env.MOTION_DEBUG) console.log('BEGIN', name)
  const openSamples = []
  const closeSamples = []
  for (let index = 0; index < reps + 1; index += 1) {
    await until(cdp, dismissed(selector))
    await prepare()
    const openSample = await measure(cdp, `${shown(selector)}${readyExtra}`, () => open())
    await until(cdp, shown(selector))
    await wait(120)
    const closeSample = await measure(cdp, dismissed(selector), () => closeAction())
    closeSample.removedFromDom = await cdp.evaluate(`!document.querySelector(${JSON.stringify(selector)})`)
    await wait(80)
    if (index > 0) { openSamples.push(openSample); closeSamples.push(closeSample) }
  }
  results[`${name}:open`] = summarize(openSamples)
  results[`${name}:close`] = summarize(closeSamples)
  results[`${name}:close`].removedFromDom = closeSamples.every((s) => s.removedFromDom)
  console.log(JSON.stringify({ op: `${name}:open`, ...results[`${name}:open`] }))
  console.log(JSON.stringify({ op: `${name}:close`, ...results[`${name}:close`] }))
}

// Purist keeps its tab strip and workspace button in a collapsible island.
async function expandIsland(cdp, layout) {
  if (layout !== 'purist' || await cdp.evaluate(`document.querySelector('.purist-chrome-surface')?.classList.contains('is-expanded')`)) return
  await cdp.click(`document.querySelector('.topbar-island-compact')`)
  await until(cdp, `document.querySelector('.purist-chrome-surface')?.classList.contains('is-expanded')`)
  await wait(400)
}

const tabCount = `document.querySelectorAll('[data-tab-motion-id]').length`

async function runLayout(template, layout, mode) {
  const profile = fs.mkdtempSync(path.join(tmpdir(), 'vast-motion-perf-'))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(seed(template, { layout, mode })))
  const { child, cdp } = await launch(profile, 9500 + Math.floor(Math.random() * 300))
  const results = {}
  try {
    await cdp.evaluate(RECORDER)
    await until(cdp, `[...document.querySelectorAll('webview')].some((v) => v.getBoundingClientRect().width > 0 && v.getURL().includes('/page/') && !v.isLoading())`, 30_000)
    await wait(2500)
    refreshMs = await cdp.evaluate(`new Promise((resolve) => { const f=[]; let l=performance.now(); const t=(n)=>{ f.push(n-l); l=n; f.length<60 ? requestAnimationFrame(t) : resolve(f.sort((a,b)=>a-b)[30]) }; requestAnimationFrame(t) })`)
    results.refreshMs = round(refreshMs)

    if (layout === 'vertical') {
      // Idle: CPU, running animations, memory, layers.
      await wait(2000)
      const a = treeStats(child.pid)
      const t0 = Date.now()
      const runningAnimations = await cdp.evaluate(`document.getAnimations().filter((x) => x.playState === 'running').length`)
      await wait(6000)
      const b = treeStats(child.pid)
      const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value
      let layers = null
      const layerEvent = new Promise((resolve) => { const listener = (message) => { if (message.method === 'LayerTree.layerTreeDidChange' && message.params.layers) { cdp.listeners.delete(listener); resolve(message.params.layers.length) } }; cdp.listeners.add(listener); setTimeout(() => resolve(null), 3000) })
      await cdp.send('LayerTree.enable').catch(() => undefined)
      await cdp.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
      layers = await layerEvent
      await cdp.send('LayerTree.disable').catch(() => undefined)
      results.idle = { cpuPercent: round((b.cpu - a.cpu) / ((Date.now() - t0) / 1000) * 100), workingSetMiB: round(b.ws / 1048576), privateMiB: round(b.priv / 1048576), jsHeapMiB: round(heap / 1048576), runningAnimations, compositedLayers: layers }
      console.log(JSON.stringify({ op: 'idle', ...results.idle }))

      await openClose(cdp, results, 'palette', '.command-palette-shell', () => keys.palette(cdp), () => keys.escape(cdp), ` && document.activeElement?.closest('.command-palette-shell')`)
      await openClose(cdp, results, 'more-menu', '.browser-tools-menu', () => cdp.click(`document.querySelector('button[title="More browser tools"]')`), () => cdp.click(`document.querySelector('button[title="More browser tools"]')`))
      await openClose(cdp, results, 'find', 'input[placeholder="Find in page"]', () => keys.find(cdp), () => keys.escape(cdp), ` && document.activeElement?.placeholder === 'Find in page'`)
      await openClose(cdp, results, 'context-menu', '[role="menu"]', () => cdp.click(`document.querySelector('[data-tab-motion-id="perf-tab-3"]')`, 'right'), () => keys.escape(cdp))
      await openClose(cdp, results, 'side-panel', '.side-panel', () => cdp.click(`document.querySelector('button[title="Show side panel"]')`), () => cdp.click(`document.querySelector('button[title="Hide side panel"]')`))
      await openClose(cdp, results, 'extensions-menu', '[data-testid="extensions-toolbar-menu"]', () => cdp.click(`document.querySelector('[data-testid="extensions-toolbar-button"]')`), () => cdp.click(`document.querySelector('[data-testid="extensions-toolbar-button"]')`))

      // Settings (opened from the More menu) and a dropdown inside it.
      const openSettings = async () => {
        await cdp.click(`document.querySelector('button[title="More browser tools"]')`)
        await until(cdp, shown('.browser-tools-menu'))
        await cdp.click(`[...document.querySelectorAll('.browser-tools-menu [role="menuitem"]')].find((e) => e.textContent.trim() === 'Settings')`)
      }
      await openClose(cdp, results, 'settings', '.settings-modal-overlay [role="dialog"]', openSettings, () => keys.escape(cdp))
      await openSettings()
      await until(cdp, shown('.settings-modal-overlay [role="dialog"]'))
      await wait(400)
      const selectTrigger = `[...document.querySelectorAll('.settings-modal-overlay [aria-haspopup="listbox"]')].find((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top > 0 && r.bottom < innerHeight })`
      if (await cdp.evaluate(`Boolean(${selectTrigger})`)) {
        await openClose(cdp, results, 'select', '[role="listbox"]', () => cdp.click(selectTrigger), () => keys.escape(cdp))
      }
      await keys.escape(cdp)
      await until(cdp, dismissed('.settings-modal-overlay [role="dialog"]'))
      await wait(400)

      // Address suggestions while typing quickly, then dismissal.
      const suggestions = `document.querySelector('[data-address-suggestions]') || [...document.querySelectorAll('form .vast-float')].find((e) => e.querySelector('button span')?.textContent)`
      await repeat('address-typing', results, reps, async () => {
        await keys.address(cdp)
        const sample = await measure(cdp, `document.activeElement?.tagName === 'INPUT' && (${suggestions})`, async () => {
          for (const char of 'perf history') { await cdp.send('Input.insertText', { text: char }); await wait(12) }
        }, 600)
        sample.finalValueOk = await cdp.evaluate(`document.activeElement?.value === 'perf history'`)
        await keys.escape(cdp); await keys.escape(cdp)
        await wait(250)
        return sample
      })

      // Rapid alternating input settles on the last requested state.
      await repeat('palette-rapid-toggle', results, 3, async () => {
        const sample = await measure(cdp, 'true', async () => { for (let i = 0; i < 11; i += 1) { await keys.palette(cdp); await wait(25) } }, 900)
        await wait(400)
        sample.finalOpen = await cdp.evaluate(shown('.command-palette-shell')) ? 1 : 0
        sample.leftoverAnimations = await cdp.evaluate(`document.getAnimations().length`)
        await keys.escape(cdp)
        await until(cdp, dismissed('.command-palette-shell'))
        await wait(300)
        return sample
      })

      // Overlay opening while the tab list scrolls.
      await repeat('scroll-while-palette-opens', results, reps, async () => {
        await cdp.evaluate(`(() => { const s=document.querySelector('[data-testid="vertical-tabs-list"]').parentElement; let i=0; const step=()=>{ s.scrollTop=(i*37)%s.scrollHeight; if(++i<40) requestAnimationFrame(step) }; requestAnimationFrame(step) })()`)
        const sample = await measure(cdp, shown('.command-palette-shell'), () => keys.palette(cdp), 600)
        await keys.escape(cdp)
        await until(cdp, dismissed('.command-palette-shell'))
        await wait(250)
        return sample
      })

      // Sidebar collapse/expand with active web content.
      await repeat('sidebar-toggle', results, reps, async (index) => {
        const wasCollapsed = await cdp.evaluate(`document.querySelector('[data-tab-sidebar]').getBoundingClientRect().width < 100`)
        const sample = await measure(cdp, `(document.querySelector('[data-tab-sidebar]').getBoundingClientRect().width < 100) !== ${wasCollapsed} || true`, () => keys.sidebar(cdp), 500)
        await wait(250)
        return sample
      })
      if (await cdp.evaluate(`document.querySelector('[data-tab-sidebar]').getBoundingClientRect().width < 100`)) { await keys.sidebar(cdp); await wait(500) }

      // Tab switching.
      await repeat('tab-switch', results, reps, async (index) => {
        const id = `perf-tab-${index % 2 === 0 ? 2 : 0}`
        return measure(cdp, `document.querySelector('.vast-tab-active')?.closest('[data-tab-motion-id]')?.dataset.tabMotionId === '${id}'`, () => cdp.click(`document.querySelector('[data-tab-motion-id="${id}"]')`), 300)
      })
    }

    if (layout !== 'vertical') {
      const button = `document.querySelector('button[aria-label^="Switch workspace"]')`
      const prepare = () => expandIsland(cdp, layout)
      await openClose(cdp, results, 'workspace-menu', '[data-testid="workspace-popover"]', () => cdp.click(button), () => keys.escape(cdp).then(async () => { if (await cdp.evaluate(shown('[data-testid="workspace-popover"]'))) await cdp.click(button) }), '', prepare)
    }

    // Tab create/close and pin (reorder) in every layout.
    await repeat('tab-create', results, reps, async () => {
      const before = await cdp.evaluate(tabCount)
      return measure(cdp, `${tabCount} > ${before}`, () => keys.newTab(cdp), 400)
    })
    await repeat('tab-close', results, reps, async () => {
      const before = await cdp.evaluate(tabCount)
      return measure(cdp, `${tabCount} < ${before}`, () => keys.closeTab(cdp), 400)
    })
    await repeat('tab-pin-reorder', results, reps, async (index) => {
      const target = `document.querySelector('[data-tab-motion-id="perf-tab-${index % 2 === 0 ? 4 : 1}"]')`
      await expandIsland(cdp, layout)
      const pinnedBefore = await cdp.evaluate(`${target}.getBoundingClientRect().top + ',' + ${target}.getBoundingClientRect().left`)
      await cdp.click(target, 'right')
      await until(cdp, shown('[role="menu"]'))
      const item = `[...document.querySelectorAll('[role="menuitem"]')].find((e) => /^(Pin|Unpin) tab$/.test(e.textContent.trim()))`
      if (!await cdp.evaluate(`Boolean(${item})`)) { await keys.escape(cdp); return { latencyMs: null } }
      const sample = await measure(cdp, `(() => { const r=${target}.getBoundingClientRect(); return r.top + ',' + r.left !== ${JSON.stringify(pinnedBefore)} })()`, () => cdp.click(item), 400)
      await wait(150)
      return sample
    })
  } finally {
    await close(child, cdp)
    fs.rmSync(profile, { recursive: true, force: true })
  }
  return results
}

async function startup(template, mode) {
  const samples = []
  for (let index = 0; index < startupRuns; index += 1) {
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'vast-motion-startup-'))
    const data = seed(template, { layout: 'vertical', mode })
    data.tabs = data.tabs.slice(0, 10).map((tab) => ({ ...tab, groupId: undefined }))
    data.tabGroups = []
    fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))
    const { child, cdp, shellMs } = await launch(profile, 9850 + index)
    samples.push({ shellMs })
    await close(child, cdp)
    fs.rmSync(profile, { recursive: true, force: true })
  }
  const result = { n: samples.length, shellMs: { median: round(percentile(samples.map((s) => s.shellMs), 0.5)), p95: round(percentile(samples.map((s) => s.shellMs), 0.95)) } }
  console.log(JSON.stringify({ op: 'startup', ...result }))
  return result
}

async function main() {
  assert(fs.existsSync(path.join(root, 'out', 'renderer', 'index.html')), 'Run npm run build first')
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><title>Perf ${request.url}</title><main style="height:4000px;font:16px system-ui">${request.url}</main>`)
  })
  await new Promise((resolve) => server.listen(serverPort, '127.0.0.1', resolve))
  const template = (await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA
  const report = { label, capturedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), modes: {} }
  try {
    for (const mode of modes) {
      console.log(`MODE ${mode}`)
      report.modes[mode] = {
        startup: await startup(template, mode),
        vertical: await runLayout(template, 'vertical', mode),
        horizontal: await runLayout(template, 'horizontal', mode),
        purist: await runLayout(template, 'purist', mode)
      }
    }
  } finally {
    server.close()
  }
  const output = path.join(root, 'performance-results', `motion-${label}.json`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Motion performance written to ${output}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
