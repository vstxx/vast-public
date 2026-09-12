const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const phase = (process.argv.find((value) => value.startsWith('--phase=')) || '--phase=baseline').slice(8)
const startupOnly = process.argv.includes('--startup-only')
const executableValue = process.argv.find((value) => value.startsWith('--executable='))
const executable = executableValue
  ? path.resolve(executableValue.slice('--executable='.length))
  : path.join(root, 'release', 'win-unpacked', 'Vast.exe')
const resultsRoot = path.join(root, 'performance-results')
const profilesRoot = path.join(resultsRoot, 'profiles', phase)
const serverPort = 9760 + Math.floor(Math.random() * 150)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }

async function fetchJson(url, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) return response.json()
    } catch {}
    await wait(100)
  }
  throw new Error(`Could not fetch ${url}`)
}

class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed')); this.pending.clear() })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = message.id && this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
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
    const session = new CdpSession(socket)
    await session.send('Runtime.enable')
    await session.send('Performance.enable')
    return session
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timed out: '+method))},30000)
      this.pending.set(id, { resolve: value=>{clearTimeout(timer);resolve(value)}, reject: error=>{clearTimeout(timer);reject(error)} })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }
  close() { this.socket.close() }
}

async function connectRenderer(debugPort) {
  for (let index = 0; index < 120; index += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 2).catch(() => [])
    const target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'))
    if (target) return CdpSession.connect(target.webSocketDebuggerUrl)
    await wait(100)
  }
  throw new Error('Packaged renderer target did not appear')
}

async function waitFor(session, expression, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await session.evaluate(`Boolean(${expression})`).catch(() => false)) return Date.now()
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

function processSnapshot() {
  const escaped = executable.replace(/'/g, "''")
  const command = `$rows=Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq '${escaped}'; $out=@(); foreach($row in $rows){$p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue; if($p){$out += [pscustomobject]@{pid=$p.Id;cpu=[double]$p.CPU;workingSet=[double]$p.WorkingSet64;privateMemory=[double]$p.PrivateMemorySize64;handle=$p.MainWindowHandle.ToInt64();commandLine=$row.CommandLine}}}; @($out)|ConvertTo-Json -Compress`
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim()
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return (Array.isArray(parsed) ? parsed : [parsed]).map(({commandLine,...row}) => ({...row,type:/--type=([^ ]+)/.exec(commandLine)?.[1] || 'browser'}))
}

function aggregateProcesses(rows) {
  return {
    processCount: rows.length,
    workingSetBytes: rows.reduce((sum, row) => sum + row.workingSet, 0),
    privateMemoryBytes: rows.reduce((sum, row) => sum + row.privateMemory, 0),
    cpuSeconds: rows.reduce((sum, row) => sum + row.cpu, 0)
  }
}

async function idleCpuSample(durationMs = 3000) {
  const before = processSnapshot()
  const started = performance.now()
  await wait(durationMs)
  const after = processSnapshot()
  const elapsedSeconds = (performance.now() - started) / 1000
  const processes = after.map(row => ({pid:row.pid,type:row.type,cpuSeconds:Math.max(0,row.cpu-(before.find(p=>p.pid===row.pid)?.cpu || 0))}))
  return { percent: processes.reduce((sum,row)=>sum+row.cpuSeconds,0)/elapsedSeconds*100, elapsedSeconds, processes }
}

function setWindowState(showCommand) {
  const handle = processSnapshot().map((row) => row.handle).find((value) => value > 0)
  if (!handle) return false
  const command = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VastPerfWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }'; [VastPerfWindow]::ShowWindowAsync([IntPtr]${handle}, ${showCommand}) | Out-Null`
  execFileSync('powershell', ['-NoProfile', '-Command', command], { stdio: 'ignore' })
  return true
}

async function measureTabSwitch(session, title) {
  const targetIndex = title.split(' ').at(-1)
  const started = performance.now()
  const route = await session.evaluate(`(() => {
    const button = document.querySelector('[data-tab-motion-id="perf-tab-${targetIndex}"]');
    if (button) {
      button.click();
      return 'strip';
    }
    const overflow = document.querySelector('button[title="More tabs"]');
    if (!overflow) throw new Error('Missing tab and overflow button: ' + ${JSON.stringify(title)});
    overflow.click();
    return 'overflow';
  })()`)
  if (route === 'overflow') {
    const overflowTarget = `document.querySelector('[data-overflow-tab-id="perf-tab-${targetIndex}"] > button')`
    await waitFor(session, `Boolean(${overflowTarget})`, 5000)
    await session.evaluate(`${overflowTarget}?.click()`)
  }
  await waitFor(session, `[...document.querySelectorAll('webview')].some((view) => view.getBoundingClientRect().width > 0 && view.getAttribute('src')?.includes('/page/${targetIndex}'))`, 10000)
  return performance.now() - started
}

function seedTabs(template, tabCount, hibernateInactiveTabs = true) {
  const data = structuredClone(template)
  const workspace = data.workspaces.find((item) => !item.isPrivate) || data.workspaces[0]
  const now = Date.now()
  data.settings.openingAnimation = true
  data.settings.hibernateInactiveTabs = hibernateInactiveTabs
  data.settings.advanced.confirmBeforeClosingManyTabs = false
  data.tabs = Array.from({ length: tabCount }, (_, index) => ({
    id: `perf-tab-${index}`,
    workspaceId: workspace.id,
    title: `Perf Tab ${index}`,
    url: `http://127.0.0.1:${serverPort}/page/${index}`,
    displayUrl: `127.0.0.1:${serverPort}/page/${index}`,
    pinned: index === 1,
    status: 'idle',
    lifecycle: index === 0 ? 'active' : 'sleeping',
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    createdAt: now - tabCount + index,
    lastAccessedAt: index === 0 ? now : now - index * 1000
  }))
  workspace.activeTabId = data.tabs[0].id
  workspace.updatedAt = now
  data.activeWorkspaceId = workspace.id
  data.splitView = { enabled: false }
  return data
}

async function stopRun(child, session) {
  const started=Date.now()
  await session.evaluate('window.vast.app.window.close()').catch(() => undefined)
  const exited = child.exitCode !== null || child.signalCode !== null || await new Promise(resolve => {
    const onExit=()=>{clearTimeout(timer);resolve(true)}
    const timer=setTimeout(()=>{child.removeListener('exit',onExit);resolve(false)},30000)
    child.once('exit',onExit)
  })
  const result={graceful:exited,durationMs:Date.now()-started}
  if (!exited) {
    result.renderer = await session.evaluate('document.body.innerText.slice(-3000)').catch(error=>String(error))
    try { execFileSync('taskkill', ['/pid',String(child.pid),'/t','/f'], {stdio:'ignore'}) } catch {}
  }
  session.close()
  return result
}

async function readJsonEventually(filePath, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (fs.existsSync(filePath)) {
      try {
        const source = fs.readFileSync(filePath, 'utf8').trim()
        if (source) return JSON.parse(source)
      } catch {
        // The main process may still be replacing the performance report.
      }
    }
    await wait(100)
  }
  return null
}

async function runScenario(name, profileDir, options = {}) {
  console.log(`START ${name}`)
  const debugPort = 9400 + Math.floor(Math.random() * 500)
  const reportPath = path.join(resultsRoot, 'raw', phase, `${name}.json`)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.rmSync(reportPath, { force: true })
  const launchEpochMs = Date.now()
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profileDir, VAST_TEST_DOWNLOAD_DIR: path.join(profileDir, 'downloads'), VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--vast-performance-report=${reportPath}`], {
    env,
    stdio: 'ignore',
    windowsHide: true
  })
  const session = await connectRenderer(debugPort)
  const shellAt = await waitFor(session, "document.querySelector('.app-shell')")
  await session.evaluate(`(() => { window.__vastPerfLongTasks = []; window.__vastPerfObserver = new PerformanceObserver(list => window.__vastPerfLongTasks.push(...list.getEntries().map(e => e.duration))); window.__vastPerfObserver.observe({type:'longtask', buffered:true}); })()`)
  if (options.webviewCount) {
    await waitFor(session, `document.querySelectorAll('webview').length >= ${options.webviewCount}`, 60000)
    await waitFor(session, `[...document.querySelectorAll('webview')].every(v=>v.getURL().includes('/page/') && !v.isLoading())`, 60000)
  }
  await wait(options.settleMs ?? 1500)
  const paint = await session.evaluate(`Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime]))`)
  const longTaskDurations = await session.evaluate(`window.__vastPerfLongTasks`).catch(() => [])
  const rendererLongTasks = {
    count: longTaskDurations.length,
    totalDurationMs: longTaskDurations.reduce((sum, duration) => sum + duration, 0),
    maxDurationMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0
  }
  const metricsResult = await session.send('Performance.getMetrics')
  const rendererMetrics = Object.fromEntries(metricsResult.metrics.map((metric) => [metric.name, metric.value]))
  const memory = aggregateProcesses(processSnapshot())
  // Operation, idle and close measurements begin after the native opening reveal.
  await waitFor(session, `!document.querySelector('.vast-opening-overlay')`, 15000)
  if (options.verified) {
    await waitFor(session, `innerWidth >= 980 && document.visibilityState === 'visible'`, 15000)
    await wait(2000)
  }
  let idleCpu
  let idleRenderer
  if (options.idleCpu !== false) {
    if (options.idleCpuStates) await wait(3000)
    const idleBefore = await session.send('Performance.getMetrics')
    const idleLongTasksBefore = await session.evaluate('window.__vastPerfLongTasks.length')
    const idleAnimations = await session.evaluate(`document.getAnimations().filter(a=>a.playState==='running').map(a=>({name:a.animationName, target:a.effect?.target?.outerHTML?.slice(0,180), time:a.currentTime}))`)
    const visibleSample = await idleCpuSample()
    idleCpu = { visiblePercent: visibleSample.percent }
    const idleAfter = await session.send('Performance.getMetrics')
    const task = metrics => metrics.metrics.find(m=>m.name==='TaskDuration').value
    idleRenderer = { cpuSample: visibleSample, taskDurationSeconds: task(idleAfter)-task(idleBefore), longTaskDurations: await session.evaluate(`window.__vastPerfLongTasks.slice(${idleLongTasksBefore})`), animations: idleAnimations }

    if (options.idleCpuStates && setWindowState(6)) {
      await wait(500)
      idleCpu.minimizedPercent = (await idleCpuSample()).percent
      setWindowState(9)
      await wait(500)
      if (setWindowState(0)) {
        idleCpu.hiddenPercent = (await idleCpuSample()).percent
        setWindowState(5)
      }
    }
  }
  let tabSwitchMs
  if (options.tabSwitchTitles) {
    tabSwitchMs = {}
    for (const title of options.tabSwitchTitles) tabSwitchMs[title] = await measureTabSwitch(session, title)
  }
  let scrolling
  if (options.scrolling) {
    await session.evaluate(`document.querySelector('button[title="More tabs"]').click()`)
    await waitFor(session, `document.querySelector('[role="dialog"]')`)
    scrolling = await session.evaluate(`(async () => {
      const scroller=[...document.querySelectorAll('[role="dialog"] *')].find(e => e.scrollHeight > e.clientHeight + 100 && ['auto','scroll'].includes(getComputedStyle(e).overflowY));
      if (!scroller) throw new Error('Missing scrollable tab list');
      const frames=[]; let last=performance.now();
      for(let i=0;i<90;i++){ await new Promise(requestAnimationFrame); const now=performance.now(); frames.push(now-last); last=now; scroller.scrollTop = (i*90) % scroller.scrollHeight; }
      frames.sort((a,b)=>a-b); return {frames:frames.length,p95FrameMs:frames[Math.floor(frames.length*.95)],maxFrameMs:frames.at(-1)};
    })()`)
    await session.evaluate(`document.querySelector('button[title="More tabs"]').click()`)
  }
  let smartUnload
  if (options.smartUnload) {
    const before = aggregateProcesses(processSnapshot())
    await session.evaluate(`document.querySelector('button[title="More browser tools"]').click()`)
    await waitFor(session, `[...document.querySelectorAll('.browser-tools-menu button')].some(b=>b.textContent.includes('Smart unload'))`)
    await session.evaluate(`[...document.querySelectorAll('.browser-tools-menu button')].find(b=>b.textContent.includes('Smart unload')).click()`)
    await waitFor(session, `document.querySelector('.smart-unload-panel')`)
    await session.evaluate(`[...document.querySelectorAll('.smart-unload-action')].find(b=>b.textContent.includes('Deep discard')).click()`)
    await waitFor(session, `document.querySelectorAll('webview').length <= 2`, 15000)
    await wait(3000)
    smartUnload = { before, after: aggregateProcesses(processSnapshot()), remainingGuests: await session.evaluate(`document.querySelectorAll('webview').length`) }
    assert(smartUnload.after.processCount < before.processCount, 'Smart Unload did not reclaim guest processes')
  }
  let memoryAfterClose
  if (options.closeTabCount) {
    await session.evaluate(`(async () => {
      for (let index = 0; index < ${options.closeTabCount}; index += 1) {
        const rows = [...document.querySelectorAll('[data-tab-motion-id]')];
        rows.at(-1)?.querySelector('[title="Close tab"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })()`)
    await wait(5000)
    memoryAfterClose = aggregateProcesses(processSnapshot())
  }
  let lifecycleCycles
  if (options.lifecycleCycles) {
    const before = aggregateProcesses(processSnapshot())
    for (let index = 0; index < options.lifecycleCycles; index += 1) {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 2 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 2 })
      await wait(80)
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 2 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 2 })
      await wait(80)
    }
    await wait(3000)
    lifecycleCycles = { count: options.lifecycleCycles, before, after: aggregateProcesses(processSnapshot()) }
  }
  let operationCountersBefore
  let operationCountersAfter
  if (options.navigation || options.downloadStress) {
    // Exclude the initial page's history/site-memory checkpoint from the
    // operation delta measured below.
    await wait(2000)
    operationCountersBefore = await session.evaluate('window.vast.app.performanceCounters()')
  }
  if (options.navigation) {
    await session.evaluate(`document.querySelector('webview').executeJavaScript("location.href='/page/navigation-checkpoint'")`)
    await wait(2000)
  }
  if (options.downloadStress) {
    await session.evaluate(`(() => { window.__vastPerfDownloads=[]; window.__vastPerfDownloadUnsubscribe=window.vast.downloads.onChanged(item=>window.__vastPerfDownloads.push(item)); })()`)
    await session.evaluate(`document.querySelector('webview').executeJavaScript("document.querySelector('#download').click()")`)
    await waitFor(session, `window.__vastPerfDownloads.some(item=>item.state === 'progressing')`, 10000)
    await waitFor(session, `window.__vastPerfDownloads.some(item=>item.state === 'completed' && item.scanStatus && !['pending','scanning'].includes(item.scanStatus))`, 60000)
    await session.evaluate(`window.__vastPerfDownloadUnsubscribe()`)

    await wait(1500)
  }
  if (options.navigation || options.downloadStress) {
    operationCountersAfter = await session.evaluate('window.vast.app.performanceCounters()')
  }
  const close = await stopRun(child, session)
  // Give Chromium children and Electron's per-profile single-instance lock time
  // to disappear before a warm relaunch of the same profile. This delay is
  // outside every reported scenario metric.
  await wait(1500)
  const probe = await readJsonEventually(reportPath)
  const result = {
    name,
    launchEpochMs,
    shellInteractiveMs: shellAt - launchEpochMs,
    close,
    paint,
    rendererMetrics,
    rendererLongTasks,
    memory,
    idleCpu,
    idleRenderer,
    tabSwitchMs,
    memoryAfterClose,
    scrolling,
    smartUnload,
    lifecycleCycles,
    operationCounters: operationCountersBefore && operationCountersAfter ? {
      before: operationCountersBefore,
      after: operationCountersAfter,
      delta: Object.fromEntries(Object.keys(operationCountersAfter).map((key) => [key, operationCountersAfter[key] - operationCountersBefore[key]]))
    } : undefined,
    probe
  }
  console.log(`DONE ${name} shell=${result.shellInteractiveMs}ms memory=${Math.round(result.memory.workingSetBytes / 1048576)}MiB`)
  return result
}

function bundleMetrics() {
  const asar = require('@electron/asar')
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar')
  const files = asar.listPackage(archive).map(name => name.replace(/^[/\\]+/, '').replaceAll('\\', '/'))
    .filter(name => /^out\/(main|preload|renderer)\//.test(name))
    .map(name => ({ name, info: asar.statFile(archive, name.split('/').join(path.sep)) }))
    .filter(({ info }) => !info.files)
    .map(({name,info}) => ({path:name,bytes:info.size}))
  return { totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), jsBytes: files.filter((file) => /\.(js|mjs|cjs)$/.test(file.path)).reduce((sum, file) => sum + file.bytes, 0), files }
}

async function main() {
  assert(process.platform === 'win32', 'Packaged performance suite currently requires Windows')
  assert(fs.existsSync(executable), `Packaged executable not found: ${executable}`)
  fs.mkdirSync(profilesRoot, { recursive: true })
  const server = http.createServer((request, response) => {
    if (request.url === '/download.bin') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="performance.bin"', 'Content-Length': 8 * 1024 * 1024 })
      let remaining = 64
      const timer = setInterval(() => {
        if (remaining-- <= 0) { clearInterval(timer); response.end(); return }
        response.write(Buffer.alloc(128 * 1024, remaining % 255))
      }, 12)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><title>Performance Page</title><a id="download" href="/download.bin" download>Download</a><main>${request.url}</main>`)
  })
  await new Promise((resolve) => server.listen(serverPort, '127.0.0.1', resolve))
  try {
    if (process.argv.includes('--idle-only')) {
      const template = structuredClone((await import(require('node:url').pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
      const scenarios = []
      for (const count of [1, 50]) for (let repetition = 1; repetition <= 3; repetition++) {
        const profileDir = path.join(profilesRoot, `idle-confirmed-${count}-${repetition}`)
        fs.mkdirSync(profileDir, { recursive: true })
        fs.writeFileSync(path.join(profileDir, 'vast-data.json'), JSON.stringify(seedTabs(template, count, count === 1)))
        scenarios.push(await runScenario(`idle-confirmed-${count}-${repetition}`, profileDir, { webviewCount: count, idleCpuStates: count === 1, verified: true }))
      }
      for (let repetition = 1; repetition <= 3; repetition++) {
        const profileDir = path.join(profilesRoot, `download-confirmed-${repetition}`)
        fs.mkdirSync(profileDir, { recursive: true })
        fs.writeFileSync(path.join(profileDir, 'vast-data.json'), JSON.stringify(seedTabs(template, 1)))
        scenarios.push(await runScenario(`download-confirmed-${repetition}`, profileDir, { webviewCount: 1, idleCpu: false, downloadStress: true, verified: true }))
      }
      fs.writeFileSync(path.join(resultsRoot, `${phase}-idle.json`), JSON.stringify({ phase, executable, scenarios }, null, 2))
      return
    }
    if (process.argv.includes('--scroll-only')) {
      const template = structuredClone((await import(require('node:url').pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
      const profileDir=path.join(profilesRoot,'scroll-250'); fs.mkdirSync(profileDir,{recursive:true});
      fs.writeFileSync(path.join(profileDir,'vast-data.json'),JSON.stringify(seedTabs(template,250)));
      const result=await runScenario('scroll-250',profileDir,{scrolling:true,idleCpu:true});
      fs.writeFileSync(path.join(resultsRoot,`${phase}-scroll.json`),JSON.stringify(result,null,2));
      const unloadDir=path.join(profilesRoot,'smart-unload'); fs.mkdirSync(unloadDir,{recursive:true});
      fs.writeFileSync(path.join(unloadDir,'vast-data.json'),JSON.stringify(seedTabs(template,10,false)));
      const unloadResult=await runScenario('smart-unload',unloadDir,{webviewCount:10,smartUnload:true,idleCpu:false});
      fs.writeFileSync(path.join(resultsRoot,`${phase}-unload.json`),JSON.stringify(unloadResult,null,2)); return;
    }
    if (startupOnly) {
      const scenarios = []
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        const profileDir = path.join(profilesRoot, `empty-startup-${repetition}`)
        fs.rmSync(profileDir, { recursive: true, force: true })
        fs.mkdirSync(profileDir, { recursive: true })
        scenarios.push(await runScenario(`empty-startup-${repetition}`, profileDir, { idleCpu: true, settleMs: 6500 }))
      }
      const result = { schemaVersion: 1, phase, capturedAt: new Date().toISOString(), executable, platform: osVersion(), bundle: bundleMetrics(), scenarios }
      fs.mkdirSync(resultsRoot, { recursive: true })
      fs.writeFileSync(path.join(resultsRoot, `${phase}.json`), `${JSON.stringify(result, null, 2)}\n`)
      console.log(`Performance ${phase} written to ${path.join(resultsRoot, `${phase}.json`)}`)
      return
    }

    const bootstrapDir = path.join(profilesRoot, 'bootstrap')
    fs.rmSync(bootstrapDir, { recursive: true, force: true })
    fs.mkdirSync(bootstrapDir, { recursive: true })
    const bootstrap = await runScenario('bootstrap', bootstrapDir, { idleCpu: false })
    const storagePath = path.join(bootstrapDir, 'vast-data.json')
    assert(fs.existsSync(storagePath), 'Bootstrap did not create vast-data.json')
    const template = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
    const scenarios = [bootstrap]

    for (const tabCount of (process.argv.includes('--startup-recheck') ? [1] : [1, 10, 25, 50, 100, 250])) {
      const profileDir = path.join(profilesRoot, `restore-${tabCount}`)
      fs.rmSync(profileDir, { recursive: true, force: true })
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, tabCount))}\n`)
      scenarios.push(await runScenario(`restore-${tabCount}-cold`, profileDir, {
        idleCpu: tabCount === 1,
        idleCpuStates: tabCount === 1,
        tabSwitchTitles: tabCount === 100 ? ['Perf Tab 1', 'Perf Tab 4'] : undefined
      }))
      if (tabCount === 1) scenarios.push(await runScenario('restore-1-warm', profileDir, { idleCpu: false }))
    }

    for (let repetition = 2; repetition <= Number((process.argv.find(a=>a.startsWith('--startup-samples=')) || '--startup-samples=3').split('=')[1]); repetition += 1) {
      const profileDir = path.join(profilesRoot, `startup-repeat-${repetition}`)
      fs.rmSync(profileDir, { recursive: true, force: true })
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, 1))}\n`)
      scenarios.push(await runScenario(`restore-1-cold-${repetition}`, profileDir, { idleCpu: false }))
      scenarios.push(await runScenario(`restore-1-warm-${repetition}`, profileDir, { idleCpu: false }))
    }

    if (process.argv.includes('--startup-recheck')) {
      fs.writeFileSync(path.join(resultsRoot, `${phase}.json`),JSON.stringify({phase,executable,bundle:bundleMetrics(),scenarios},null,2)); return;
    }
    for (const tabCount of [1, 10, 25, 50]) {
      const profileDir = path.join(profilesRoot, `loaded-${tabCount}`)
      fs.rmSync(profileDir, { recursive: true, force: true })
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, tabCount, false))}\n`)
      scenarios.push(await runScenario(`loaded-${tabCount}`, profileDir, {
        webviewCount: tabCount,
        idleCpu: tabCount === 50,
        settleMs: 2500,
        tabSwitchTitles: tabCount === 10 ? ['Perf Tab 1', 'Perf Tab 4'] : undefined,
        closeTabCount: tabCount === 25 ? 20 : undefined
      }))
    }

    const lifecycleDir = path.join(profilesRoot, 'lifecycle-cycles')
    fs.rmSync(lifecycleDir, { recursive: true, force: true })
    fs.mkdirSync(lifecycleDir, { recursive: true })
    fs.writeFileSync(path.join(lifecycleDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, 1))}\n`)
    scenarios.push(await runScenario('lifecycle-cycles', lifecycleDir, { lifecycleCycles: 15, idleCpu: false }))

    const navigationDir = path.join(profilesRoot, 'navigation-checkpoint')
    fs.rmSync(navigationDir, { recursive: true, force: true })
    fs.mkdirSync(navigationDir, { recursive: true })
    fs.writeFileSync(path.join(navigationDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, 1))}\n`)
    scenarios.push(await runScenario('ordinary-navigation', navigationDir, { navigation: true, idleCpu: false }))

    const downloadDir = path.join(profilesRoot, 'download-stress')
    fs.rmSync(downloadDir, { recursive: true, force: true })
    fs.mkdirSync(downloadDir, { recursive: true })
    fs.writeFileSync(path.join(downloadDir, 'vast-data.json'), `${JSON.stringify(seedTabs(template, 1))}\n`)
    scenarios.push(await runScenario('download-progress-stress', downloadDir, { downloadStress: true, idleCpu: false }))

    const result = { schemaVersion: 1, phase, capturedAt: new Date().toISOString(), executable, platform: osVersion(), bundle: bundleMetrics(), scenarios }
    fs.mkdirSync(resultsRoot, { recursive: true })
    fs.writeFileSync(path.join(resultsRoot, `${phase}.json`), `${JSON.stringify(result, null, 2)}\n`)
    console.log(`Performance ${phase} written to ${path.join(resultsRoot, `${phase}.json`)}`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

function osVersion() {
  return execFileSync('powershell', ['-NoProfile', '-Command', "[System.Environment]::OSVersion.VersionString"], { encoding: 'utf8' }).trim()
}

module.exports = { CdpSession, connectRenderer, waitFor, stopRun }

if (require.main === module) main().catch((error) => {
  console.error(error)
  try {
    const escaped = executable.replace(/'/g, "''")
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process Vast -ErrorAction SilentlyContinue | Where-Object Path -eq '${escaped}' | Stop-Process -Force`], { stdio: 'ignore' })
  } catch {}
  process.exitCode = 1
})
