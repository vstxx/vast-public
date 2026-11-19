#!/usr/bin/env node
// Native extension runtime overhead: hidden host windows, processes, private
// memory, idle CPU, startup, Native tab-event IPC during ordinary browsing,
// contribution dispatch latency and enable/disable cleanup.
// Usage: node scripts/native-extensions-bench.cjs --out=<dir> [--label=after] [--reps=3]
//   [--scenarios=none,legacy1,legacy5,decl1,decl5,hybrid] [--electron=<dir with electron.exe>]
// Requires a built app (npm run build). Runs isolated temporary profiles only.
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { CdpSession, connectRenderer, waitFor } = require('./performance-suite.cjs')

const root = path.resolve(__dirname, '..')
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=')] }))
const label = args.label || 'run'
const reps = Number(args.reps || 3)
const scenarios = (args.scenarios || 'none,legacy1,legacy5,decl1,decl5,hybrid').split(',')
const out = path.resolve(args.out || path.join(os.tmpdir(), 'vast-native-extensions-bench'))
const electronDir = path.resolve(args.electron || process.env.VAST_PATCHED_ELECTRON_DIST || require('./prepare-patched-electron-dist.cjs').defaultOutputPath(require('../patches/extension-compatibility-runtime.json')))
const executable = path.join(electronDir, process.platform === 'win32' ? 'electron.exe' : 'electron')
const IDLE_SECONDS = 10
const TRAFFIC_SECONDS = 10
fs.mkdirSync(out, { recursive: true })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values) => { const list = values.filter(Number.isFinite).sort((a, b) => a - b); if (!list.length) return null; const m = Math.floor(list.length / 2); return list.length % 2 ? list[m] : (list[m - 1] + list[m]) / 2 }
const percentile = (values, p) => { const list = values.filter(Number.isFinite).sort((a, b) => a - b); return list.length ? list[Math.min(list.length - 1, Math.ceil(p * list.length) - 1)] : null }
function idFor(extensionPath) {
  const digest = createHash('sha256').update(Buffer.from(process.platform === 'win32' ? extensionPath.toLowerCase() : extensionPath)).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#7c3aed"/></svg>'
const POPUP = '<!doctype html><html><head><meta charset="utf-8"><title>Popup</title></head><body>Popup</body></html>'
// A dynamic (legacy) Native extension: background registers UI at runtime and
// listens to clicks and tab events, as Native API v1 requires.
const LEGACY_BACKGROUND = `globalThis.__bench = { clicks: [], tabEvents: 0 }
await vast.toolbar.create({ id: 'act', title: 'Bench action', icon: 'icon.svg' })
await vast.commands.register({ id: 'cmd', title: 'Bench command' })
await vast.contextMenus.create({ id: 'menu', title: 'Bench menu' })
vast.toolbar.onClicked.addListener(() => { globalThis.__bench.clicks.push(Date.now()) })
for (const name of ['onCreated', 'onUpdated', 'onActivated', 'onRemoved']) vast.tabs[name].addListener(() => { globalThis.__bench.tabEvents += 1 })
`

function writeExtension(dir, kind, index) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'icon.svg'), ICON)
  fs.writeFileSync(path.join(dir, 'popup.html'), POPUP)
  const name = `Bench ${kind} ${index}`
  let manifest
  if (kind === 'legacy' || kind === 'timer') {
    // timer: a background that also polls every 16 ms, to measure hidden-host throttling.
    fs.writeFileSync(path.join(dir, 'background.js'), LEGACY_BACKGROUND + (kind === 'timer' ? 'setInterval(() => { let x = 0; for (let i = 0; i < 2000000; i += 1) x += i; globalThis.__bench.ticks = (globalThis.__bench.ticks ?? 0) + 1 }, 16)\n' : ''))
    manifest = { manifest_version: 3, name, version: '1.0.0', vast: { api_version: 1, background: 'background.js', permissions: ['vast.toolbar', 'vast.commands', 'vast.contextMenus', 'vast.tabs.read'] } }
  } else if (kind === 'decl') {
    manifest = { manifest_version: 3, name, version: '1.0.0', vast: { api_version: 1, popup: 'popup.html', permissions: ['vast.toolbar', 'vast.commands'], contributes: {
      toolbar: [{ id: 'act', title: 'Bench action', icon: 'icon.svg', action: 'popup' }],
      commands: [{ id: 'cmd', title: 'Bench command', action: 'popup' }]
    } } }
  } else {
    fs.writeFileSync(path.join(dir, 'content.js'), 'document.documentElement.dataset.benchHybrid = "1"\n')
    fs.writeFileSync(path.join(dir, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {})\n')
    manifest = { manifest_version: 3, name, version: '1.0.0', background: { service_worker: 'worker.js' }, action: { default_popup: 'popup.html' },
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
      vast: { api_version: 1, permissions: ['vast.toolbar'], contributes: { toolbar: [{ id: 'act', title: 'Bench action', icon: 'icon.svg', action: 'popup' }] } } }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { id: idFor(dir), name, path: dir, runtime: kind === 'hybrid' ? 'hybrid' : 'vast', grantedPermissions: manifest.vast.permissions }
}

function scenarioExtensions(scenario) {
  const match = /^(legacy|decl|timer)(\d+)$/.exec(scenario)
  if (match) return Array.from({ length: Number(match[2]) }, (_, index) => [match[1], index])
  if (scenario === 'hybrid') return [['hybrid', 0]]
  return []
}

// Private bytes are per process and not shared, so summing them across the
// tree does not double count shared pages the way working sets would.
function processTree(pid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,KernelModeTime,UserModeTime,CommandLine
$ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${pid}); $changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } }
$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; privateBytes = [double]$_.PrivatePageCount; cpu100ns = [double]$_.KernelModeTime + [double]$_.UserModeTime; type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' } } } | ConvertTo-Json -Compress`
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
  const list = raw ? JSON.parse(raw) : []
  return Array.isArray(list) ? list : [list]
}

function treeSummary(tree) {
  const byType = {}
  for (const item of tree) byType[item.type] = (byType[item.type] || 0) + 1
  return { processes: tree.length, byType, privateMB: +(tree.reduce((sum, item) => sum + item.privateBytes, 0) / 1048576).toFixed(1) }
}

async function hostTargets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list.filter((item) => item.type === 'page' && item.url.endsWith('/__vast_background__.html'))
}

async function counters(renderer) { return renderer.evaluate('window.vast.app.performanceCounters()') }
function counterDelta(before, after) {
  const result = {}
  for (const key of ['extensionTabEventIpc', 'nativeExtensionEvents', 'nativeHostsCreated', 'nativeHostsDestroyed']) result[key] = (after?.[key] ?? 0) - (before?.[key] ?? 0)
  return result
}

async function runScenario(scenario, rep, origin) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `vast-native-bench-${scenario}-`))
  const extensionRoot = path.join(profile, 'fixtures')
  const extensions = scenarioExtensions(scenario).map(([kind, index]) => writeExtension(path.join(extensionRoot, `${kind}-${index}`), kind, index))
  const now = Date.now()
  fs.mkdirSync(path.join(profile, 'Extensions'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'Extensions', 'registry.json'), JSON.stringify({ schemaVersion: 2, extensions: extensions.map((extension) => ({
    id: extension.id, name: extension.name, version: '1.0.0', path: extension.path, enabled: true, source: 'unpacked', trust: 'developer', updateState: 'not-applicable',
    runtime: extension.runtime, manifestVersion: 3, installedAt: now, updatedAt: now, allowFileAccess: false,
    grantedPermissions: extension.grantedPermissions, grantedChromePermissions: [], grantedChromeOrigins: []
  })) }, null, 2))
  // Six ordinary tabs whose titles change twice per second: tab metadata
  // churn of the kind every page with a live title or loading state produces.
  const data = structuredClone((await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.onboarding.completed = true
  data.settings.openingAnimation = false
  data.settings.layoutMode = 'horizontal'
  const workspace = data.workspaces[0]
  const tabIds = Array.from({ length: 6 }, (_, index) => `bench-tab-${index}`)
  workspace.activeTabId = tabIds[0]
  data.activeWorkspaceId = workspace.id
  data.tabs = tabIds.map((id, index) => ({ id, workspaceId: workspace.id, title: id, url: `${origin}/page/${id}`, pinned: false, status: 'idle', lifecycle: 'active', progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: now, lastAccessedAt: now - index }))
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))

  const port = 13000 + Math.floor(Math.random() * 2000)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_UPDATE_ENABLED: '0', VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const started = Date.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--vast-performance-report=${path.join(profile, 'probe.json')}`, root], { cwd: root, env, stdio: 'ignore', windowsHide: true })
  const result = { label, scenario, rep, extensions: extensions.length }
  let renderer
  try {
    renderer = await connectRenderer(port)
    await waitFor(renderer, 'window.vast?.extensions && document.querySelector(".address-bar-row")', 30000)
    // Ready: every extension reports a settled Native state and its toolbar
    // contribution is visible to the browser UI.
    const settled = `(async () => { const list = await window.vast.extensions.list(); const c = await window.vast.extensions.contributions();
      return list.ok && list.extensions.length === ${extensions.length} && list.extensions.every((e) => !['starting', 'pending-permission'].includes(e.native.state)) && c.contributions.toolbar.length === ${extensions.length} })()`
    const readyAt = await waitFor(renderer, settled, 30000).catch(() => null)
    result.startupMs = readyAt ? readyAt - started : null
    const list = await renderer.evaluate('window.vast.extensions.list()')
    result.nativeStates = list.extensions.map((extension) => extension.native.state)
    await wait(5000)

    // Idle: no interaction for IDLE_SECONDS.
    const idleBefore = processTree(child.pid)
    const countersBefore = await counters(renderer)
    await wait(IDLE_SECONDS * 1000)
    const idleAfter = processTree(child.pid)
    const cpuBefore = new Map(idleBefore.map((item) => [item.pid, item.cpu100ns]))
    result.idle = { ...treeSummary(idleAfter), cpuPercentOfOneCore: +(idleAfter.reduce((sum, item) => sum + Math.max(0, item.cpu100ns - (cpuBefore.get(item.pid) ?? item.cpu100ns)), 0) / 1e5 / IDLE_SECONDS).toFixed(2) }
    result.idle.counters = counterDelta(countersBefore, await counters(renderer))
    result.hostWindows = (await hostTargets(port)).length

    // Ordinary browsing: live titles plus one tab switch per second.
    const trafficBefore = await counters(renderer)
    for (let second = 0; second < TRAFFIC_SECONDS; second += 1) {
      await renderer.evaluate(`document.querySelector('[data-tab-motion-id="${tabIds[second % tabIds.length]}"]')?.click()`)
      await wait(1000)
    }
    result.browsing = counterDelta(trafficBefore, await counters(renderer))
    result.browsing.ipcPerSecond = +(result.browsing.extensionTabEventIpc / TRAFFIC_SECONDS).toFixed(1)

    // Dispatch: 30 toolbar activations of the first extension.
    if (extensions.length) {
      const host = extensions[0].runtime === 'vast' && /^(legacy|timer)/.test(scenario) ? (await hostTargets(port)).find((item) => item.url.includes(extensions[0].id)) : undefined
      const hostSession = host ? await CdpSession.connect(host.webSocketDebuggerUrl) : undefined
      const timings = []
      const handled = []
      const failures = []
      for (let index = 0; index < 30; index += 1) {
        const sample = await renderer.evaluate(`(async () => { const c = await window.vast.extensions.contributions(); const key = c.contributions.toolbar.find((item) => item.extensionId === '${extensions[0].id}').key; const t0 = Date.now(); const r = await window.vast.extensions.dispatchContribution(key); return { t0, rtt: Date.now() - t0, ok: r.ok, error: r.error } })()`)
        timings.push(sample.rtt)
        if (!sample.ok) failures.push(sample.error)
        if (hostSession) {
          await wait(30)
          const clicks = await hostSession.evaluate('globalThis.__bench.clicks')
          const received = clicks.find((time) => time >= sample.t0)
          if (received) handled.push(received - sample.t0)
        }
        // Close any popup the action opened before the next activation.
        await renderer.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
        await wait(60)
      }
      hostSession?.close()
      result.dispatch = { n: timings.length, rttMedianMs: median(timings), rttP95Ms: percentile(timings, 0.95), handledMedianMs: median(handled), handledP95Ms: percentile(handled, 0.95), handled: handled.length, failures: failures.length, firstFailure: failures[0] }
    }

    // Enable/disable loop on the first extension: hosts must not leak.
    if (extensions.length && rep === 0) {
      const id = extensions[0].id
      const loopBefore = await counters(renderer)
      for (let index = 0; index < 20; index += 1) {
        await renderer.evaluate(`window.vast.extensions.disable('${id}')`)
        await renderer.evaluate(`window.vast.extensions.enable('${id}')`)
      }
      // A redundant enable must not restart a running host.
      for (let index = 0; index < 5; index += 1) await renderer.evaluate(`window.vast.extensions.enable('${id}')`)
      await wait(3000)
      result.toggleLoop = { ...counterDelta(loopBefore, await counters(renderer)), hostWindowsAfter: (await hostTargets(port)).length, ...treeSummary(processTree(child.pid)) }
    }
  } finally {
    renderer?.close?.()
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve))
    await wait(500)
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return result
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Electron runtime not found: ${executable}`)
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><title>start</title><script>let n = 0; setInterval(() => { document.title = location.pathname + ' ' + (++n) }, 500)</script><p>${request.url}</p>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const file = path.join(out, `${label}.json`)
  const results = []
  try {
    for (let rep = 0; rep < reps; rep += 1) {
      for (const scenario of scenarios) {
        try {
          const result = await runScenario(scenario, rep, origin)
          results.push(result)
          console.log(`[${label} ${rep}] ${scenario}: startup ${result.startupMs}ms states ${result.nativeStates.join(',') || '-'} | hosts ${result.hostWindows} procs ${result.idle.processes} ${JSON.stringify(result.idle.byType)} private ${result.idle.privateMB}MB idle cpu ${result.idle.cpuPercentOfOneCore}% | browsing ipc/s ${result.browsing.ipcPerSecond} nativeEvents ${result.browsing.nativeExtensionEvents}${result.dispatch ? ` | dispatch rtt ${result.dispatch.rttMedianMs}/${result.dispatch.rttP95Ms}ms handled ${result.dispatch.handled} ${result.dispatch.handledMedianMs}/${result.dispatch.handledP95Ms}ms fail ${result.dispatch.failures}` : ''}${result.toggleLoop ? ` | toggle created ${result.toggleLoop.nativeHostsCreated} destroyed ${result.toggleLoop.nativeHostsDestroyed} hostsAfter ${result.toggleLoop.hostWindowsAfter}` : ''}`)
        } catch (error) {
          console.log(`[${label} ${rep}] ${scenario}: ERROR ${error.message}`)
          results.push({ label, scenario, rep, error: error.message })
        }
        fs.writeFileSync(file, JSON.stringify({ label, createdAt: new Date().toISOString(), executable, results }, null, 2))
      }
    }
  } finally {
    server.close()
  }
  console.log(`wrote ${file}`)
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
