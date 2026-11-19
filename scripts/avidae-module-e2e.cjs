// Packaged end-to-end test for the downloadable Video & Audio module.
//
// Serves a built module (release/avidae-module/<version>, signed with a test
// key) from a loopback HTTP server, launches a packaged private Vast build with
// test-only module overrides, and drives the real UI over CDP:
//   startup and Settings make no module requests -> the page shows the install
//   action with the signed download size -> Download & Install -> verified
//   install -> Start backend -> real FFmpeg and Chromium jobs -> restart reuses
//   the installation -> cancel/retry -> offline failure.
//
// Usage: node scripts/avidae-module-e2e.cjs --exe release-core/win-unpacked/Vast.exe
//          --module-dir release/avidae-module/1.0.0 --public-key <spki base64> [--skip-record]
const { spawn, execFileSync } = require('node:child_process')
const { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const executable = path.resolve(argument('--exe') ?? path.join(root, 'release-core', 'win-unpacked', 'Vast.exe'))
const moduleDir = path.resolve(argument('--module-dir') ?? path.join(root, 'release', 'avidae-module', '1.0.0'))
const publicKey = argument('--public-key')
const skipRecord = process.argv.includes('--skip-record')
if (!existsSync(executable) || !existsSync(path.join(moduleDir, 'avidae-module.json')) || !publicKey) {
  throw new Error('--exe, a signed --module-dir and --public-key are required.')
}
const manifest = JSON.parse(readFileSync(path.join(moduleDir, 'avidae-module.json'), 'utf8'))
const archiveUrl = new URL(manifest.payload.archive.url)
const results = []
const record = (name, detail) => {
  results.push({ name, detail })
  console.log(`PASS ${name}: ${detail}`)
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- module release server ----------
const requests = []
let throttleArchive = false
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  requests.push({ pathname, range: request.headers.range, at: Date.now() })
  const name = pathname === '/module/avidae-module.json' ? 'avidae-module.json' : path.posix.basename(pathname)
  const file = path.join(moduleDir, name)
  if (!pathname.startsWith('/module/') || !existsSync(file)) {
    response.writeHead(404).end()
    return
  }
  const total = statSync(file).size
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const headers = { 'content-length': total - start, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' }
  if (start > 0) headers['content-range'] = `bytes ${start}-${total - 1}/${total}`
  response.writeHead(start > 0 ? 206 : 200, headers)
  const stream = createReadStream(file, { start, highWaterMark: throttleArchive ? 64 * 1024 : 1024 * 1024 })
  if (throttleArchive && name.endsWith('.tar.zst')) {
    stream.on('data', () => { stream.pause(); setTimeout(() => stream.resume(), 20) })
  }
  stream.pipe(response)
  response.on('close', () => stream.destroy())
})
const archiveRequests = () => requests.filter((item) => item.pathname.endsWith('.tar.zst'))
const manifestRequests = () => requests.filter((item) => item.pathname.endsWith('avidae-module.json'))

// ---------- CDP ----------
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = message.id && this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const session = new Cdp(ws)
    await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 120_000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  async ctrl(key, code, keyCode) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: 2 })
    }
  }

  close() {
    this.ws.close()
  }
}

async function waitFor(session, expression, label, timeout = 30_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeout) {
    try {
      last = await session.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await wait(150)
  }
  const body = await session.evaluate('document.body.innerText.slice(0, 1500)').catch(() => '')
  const status = await session.evaluate('window.vast?.avidae?.status().then((s) => JSON.stringify(s.module ?? s)).catch((e) => String(e))').catch(() => '')
  throw new Error(`Timed out waiting for ${label} (${JSON.stringify(last)})
status: ${status}
body: ${body}`)
}

async function clickByText(session, text) {
  await session.evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find((item) => item.innerText.trim().includes(${JSON.stringify(text)}) && !item.disabled);
    if (!element) throw new Error('Clickable not found: ' + ${JSON.stringify(text)});
    element.click();
    return true;
  })()`)
}

async function openVideoAudio(session) {
  await session.ctrl('k', 'KeyK', 75)
  await waitFor(session, 'Boolean(document.querySelector("input[placeholder=\\"Command, tab, bookmark, history, or search\\"]"))', 'command palette')
  await session.evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Command, tab, bookmark, history, or search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Open Video & Audio');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await waitFor(session, '[...document.querySelectorAll("button,[role=option]")].some((item) => item.innerText.includes("Open Video & Audio"))', 'command result')
  await session.evaluate(`[...document.querySelectorAll('button,[role=option]')].find((item) => item.innerText.includes('Open Video & Audio')).click()`)
}

function processMemoryBytes(pid) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$ids = @(${pid}) + @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object ProcessId); (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`], { encoding: 'utf8', windowsHide: true })
    return Number(output.trim()) || 0
  } catch {
    return 0
  }
}

const running = new Set()

async function launch(profile, moduleRoot, manifestUrl, port) {
  const started = Date.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      VAST_TEST_USER_DATA_DIR: profile,
      VAST_RELAY_TEST_OFFLINE: '1',
      VAST_AVIDAE_MODULE_MANIFEST_URL: manifestUrl,
      VAST_AVIDAE_MODULE_TEST_PUBLIC_KEY: publicKey,
      VAST_AVIDAE_MODULE_ROOT: moduleRoot
    },
    stdio: 'ignore',
    windowsHide: false
  })
  running.add(child)
  child.once('exit', () => running.delete(child))
  let target
  while (!target && Date.now() - started < 60_000) {
    await wait(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((item) => item.type === 'page' && /index\.html|vast:\/\/|app:\/\//.test(item.url) && !item.url.startsWith('devtools'))
    } catch { /* not listening yet */ }
  }
  assert(target, 'Vast UI target did not appear.')
  const session = await Cdp.connect(target.webSocketDebuggerUrl)
  await waitFor(session, 'Boolean(window.vast?.avidae) && document.readyState === "complete" && document.body.innerText.length > 0', 'Vast UI ready', 60_000)
  return { child, session, port, startupMs: Date.now() - started }
}

async function quit(instance) {
  instance.session.close()
  instance.child.kill()
  await new Promise((resolve) => {
    if (instance.child.exitCode !== null) resolve()
    else instance.child.once('exit', resolve)
  })
  try { execFileSync('taskkill.exe', ['/PID', String(instance.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  await wait(1_500)
}

async function moduleStatus(session) {
  return session.evaluate('window.vast.avidae.status().then((status) => status.module)')
}

async function iframeSession(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const frame = list.find((item) => item.url.startsWith('http://127.0.0.1:') && item.webSocketDebuggerUrl && !item.url.includes(`:${server.address().port}/`))
    if (frame) return Cdp.connect(frame.webSocketDebuggerUrl)
    await wait(500)
  }
  throw new Error('Video & Audio iframe target was not exposed over CDP.')
}

async function runJob(frame, body, label, timeout = 120_000) {
  const created = await frame.evaluate(`fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.json())`)
  assert(created?.ok && created.job_id, `${label} job was rejected: ${JSON.stringify(created)}`)
  const started = Date.now()
  let job
  while (Date.now() - started < timeout) {
    job = await frame.evaluate(`fetch('/api/jobs/${created.job_id}').then((r) => r.json())`)
    const status = job?.job?.status ?? job?.status
    if (status === 'completed') return { id: created.job_id, job, seconds: (Date.now() - started) / 1000 }
    if (status === 'failed' || status === 'cancelled') throw new Error(`${label} job ${status}: ${JSON.stringify(job).slice(0, 600)}`)
    await wait(1_000)
  }
  throw new Error(`${label} job did not finish: ${JSON.stringify(job).slice(0, 400)}`)
}

async function main() {
  await new Promise((resolve) => server.listen(Number(archiveUrl.port), '127.0.0.1', resolve))
  const manifestUrl = `http://127.0.0.1:${archiveUrl.port}/module/avidae-module.json`
  const work = mkdtempSync(path.join(tmpdir(), 'vast-avidae-e2e-'))
  const profile = path.join(work, 'profile')
  const moduleRoot = path.join(work, 'modules', 'video-audio')
  mkdirSync(profile, { recursive: true })
  const { DEFAULT_DATA } = await import(pathToFileURL(path.join(root, 'src', 'shared', 'constants.ts')).href)
  const seed = structuredClone(DEFAULT_DATA)
  seed.onboarding = { completed: true }
  seed.settings.labs = { ...seed.settings.labs, enabled: true, avidae: true }
  seed.settings.advanced = { ...seed.settings.advanced, experimentalFeatures: true }
  writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(seed))
  const report = { executable, moduleVersion: manifest.payload.moduleVersion, archiveBytes: manifest.payload.archive.size, unpackedBytes: manifest.payload.archive.unpackedSize }
  try {
    // 1. Startup, Labs enabled, Settings: nothing is fetched.
    let app = await launch(profile, moduleRoot, manifestUrl, 9341)
    report.startupMs = app.startupMs
    await wait(3_000)
    assert(requests.length === 0, `Startup contacted the module server: ${JSON.stringify(requests)}`)
    record('no download on startup', `Labs Video & Audio enabled; ${requests.length} module requests after launch`)
    await app.session.ctrl(',', 'Comma', 188)
    await wait(2_000)
    assert(requests.length === 0, 'Opening Settings contacted the module server.')
    record('no download from Settings', 'opening Settings made no module requests')
    for (const type of ['rawKeyDown', 'keyUp']) await app.session.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await wait(500)

    // 2. Page shows the install action with the signed size, without downloading.
    await openVideoAudio(app.session)
    await waitFor(app.session, 'Boolean(document.querySelector("[data-testid=\\"avidae-module-install\\"]")) && document.body.innerText.includes("Download size")', 'install surface with download size')
    const installText = await app.session.evaluate('document.querySelector("[data-testid=\\"avidae-module-install\\"]").innerText')
    assert(!(await app.session.evaluate('document.body.innerText.includes("Start backend")')), 'Start backend was offered before installation.')
    assert(archiveRequests().length === 0 && manifestRequests().length >= 1, 'Opening the page must fetch only the signed manifest.')
    record('install prompt', installText.replace(/\s+/g, ' ').trim())

    // 3. Real download and verified install with progress.
    const states = []
    let maxPercent = 0
    let peakMemory = processMemoryBytes(app.child.pid)
    const idleMemory = peakMemory
    const installStarted = Date.now()
    await clickByText(app.session, 'Download & Install')
    let status
    while (Date.now() - installStarted < 15 * 60_000) {
      status = await moduleStatus(app.session)
      if (states.at(-1) !== status.state) states.push(status.state)
      if (status.totalBytes) maxPercent = Math.max(maxPercent, Math.floor(100 * (status.transferredBytes ?? 0) / status.totalBytes))
      if (states.length % 3 === 0) peakMemory = Math.max(peakMemory, processMemoryBytes(app.child.pid))
      if (status.state === 'ready' || status.state === 'failed') break
      const bar = await app.session.evaluate('document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") ?? null')
      if (bar !== null) maxPercent = Math.max(maxPercent, Number(bar))
      await wait(250)
    }
    report.installSeconds = (Date.now() - installStarted) / 1000
    report.installStates = states
    report.memory = { idleWorkingSetBytes: idleMemory, peakWorkingSetDuringInstallBytes: peakMemory }
    assert(status.state === 'ready', `Install ended in ${status.state}: ${status.error}`)
    assert(['downloading', 'verifying', 'installing'].every((state) => states.includes(state)), `Progress states missing: ${states.join(' > ')}`)
    assert(archiveRequests().length === 1, `Archive fetched ${archiveRequests().length} times.`)
    record('verified install', `${states.join(' > ')} in ${report.installSeconds}s`)

    // 4. Same startup surface returns; start the backend.
    await waitFor(app.session, 'document.body.innerText.includes("Start backend") && document.body.innerText.includes("Runtime 1.0.0 installed")', 'normal startup surface')
    await clickByText(app.session, 'Start backend')
    await waitFor(app.session, '(() => { const frame = document.querySelector("iframe[title=\\"Video & Audio\\"]"); return Boolean(frame && frame.src.startsWith("http://127.0.0.1:")); })()', 'backend iframe', 90_000)
    const backend = await app.session.evaluate('window.vast.avidae.status()')
    assert(backend.state === 'running' && /module 1\.0\.0/.test(backend.python ?? ''), `Backend did not run from the module: ${backend.python}`)
    record('backend from module', `${backend.python} at ${backend.url}`)

    // 5. Real media jobs through the embedded backend.
    const active = JSON.parse(readFileSync(path.join(moduleRoot, 'active.json'), 'utf8'))
    const ffmpeg = path.join(moduleRoot, active.directory, 'media', 'ffmpeg.exe')
    const uploads = path.join(profile, 'avidae', 'uploads')
    mkdirSync(uploads, { recursive: true })
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', path.join(uploads, 'e2e-source.mp4')], { windowsHide: true })
    const frame = await iframeSession(app.port)
    await waitFor(frame, 'document.readyState === "complete"', 'backend page loaded', 30_000)
    const extracted = await runJob(frame, { type: 'extract_audio', params: { input_file: 'e2e-source.mp4', audio_format: 'mp3' } }, 'extract audio')
    record('audio extraction', `job ${extracted.id} completed in ${extracted.seconds}s`)
    const converted = await runJob(frame, { type: 'convert', params: { input_file: 'e2e-source.mp4', format: 'webm', vcodec: 'libvpx-vp9', acodec: 'libopus' } }, 'convert')
    record('conversion', `job ${converted.id} (mp4 to webm) completed in ${converted.seconds}s`)
    if (!skipRecord) {
      const recorded = await runJob(frame, { type: 'record', params: { url: 'https://example.com/', max_duration: 4, delay: 0, format: 'mp4' } }, 'record', 180_000)
      record('Chromium page recording', `job ${recorded.id} recorded https://example.com/ in ${recorded.seconds}s`)
    }
    const jobs = await frame.evaluate('fetch("/api/jobs").then((r) => r.json())')
    record('job management', `backend lists ${(jobs.jobs ?? jobs).length} jobs`)
    frame.close()
    await app.session.evaluate('window.vast.avidae.stop()')
    const stopped = await app.session.evaluate('window.vast.avidae.status()')
    assert(stopped.state === 'stopped', 'Backend did not stop.')
    record('backend stop', 'backend stopped cleanly')
    await quit(app)

    // 6. Restart: installation persists, nothing downloaded again.
    const archiveCount = archiveRequests().length
    app = await launch(profile, moduleRoot, manifestUrl, 9342)
    await openVideoAudio(app.session)
    await waitFor(app.session, 'document.body.innerText.includes("Start backend")', 'installed surface after restart')
    await clickByText(app.session, 'Start backend')
    await waitFor(app.session, 'Boolean(document.querySelector("iframe[title=\\"Video & Audio\\"]"))', 'backend after restart', 90_000)
    assert(archiveRequests().length === archiveCount, 'Restart downloaded the module again.')
    record('persisted installation', 'restart reused the verified module without downloading')
    const history = await iframeSession(app.port).then(async (session) => {
      const value = await session.evaluate('fetch("/api/jobs").then((r) => r.json())')
      session.close()
      return value
    })
    assert(((history.jobs ?? history).length) >= 2, 'Job history was not preserved across restart.')
    record('job history persisted', `${(history.jobs ?? history).length} jobs survive restart`)
    await app.session.evaluate('window.vast.avidae.stop()')
    await quit(app)

    // 7. Cancel and retry on a fresh module root.
    const cancelRoot = path.join(work, 'modules-cancel', 'video-audio')
    throttleArchive = true
    app = await launch(profile, cancelRoot, manifestUrl, 9343)
    await openVideoAudio(app.session)
    await waitFor(app.session, 'document.body.innerText.includes("Download & Install")', 'install action')
    await clickByText(app.session, 'Download & Install')
    await waitFor(app.session, 'window.vast.avidae.status().then((s) => s.module.state === "downloading" && (s.module.transferredBytes ?? 0) > 0)', 'download in progress')
    await clickByText(app.session, 'Cancel')
    await waitFor(app.session, 'window.vast.avidae.status().then((s) => s.module.state === "cancelled")', 'cancelled')
    const leftovers = existsSync(path.join(cancelRoot, '.downloads')) ? readdirSync(path.join(cancelRoot, '.downloads')) : []
    assert(leftovers.length === 0 && !existsSync(path.join(cancelRoot, 'active.json')), 'Cancel left partial files or an active install.')
    record('cancel', 'cancel discarded the partial download and left nothing installed')
    throttleArchive = false
    await waitFor(app.session, 'document.body.innerText.includes("Download & Install")', 'retry action')
    await clickByText(app.session, 'Download & Install')
    await waitFor(app.session, 'window.vast.avidae.status().then((s) => s.module.state === "ready")', 'retry completes', 15 * 60_000)
    record('retry', 'retry after cancel installed the module')
    await quit(app)

    // 8. Offline / unavailable release server.
    app = await launch(profile, path.join(work, 'modules-offline', 'video-audio'), 'http://127.0.0.1:59998/module/avidae-module.json', 9344)
    await openVideoAudio(app.session)
    await waitFor(app.session, '[...document.querySelectorAll("button")].some((item) => item.innerText.includes("Download & Install") && !item.disabled)', 'install action offline', 60_000)
    await clickByText(app.session, 'Download & Install')
    const offline = await waitFor(app.session, 'window.vast.avidae.status().then((s) => s.module.state === "failed" ? s.module : null)', 'offline failure', 120_000)
    await waitFor(app.session, 'document.body.innerText.includes("Retry")', 'retry button')
    assert(!existsSync(path.join(work, 'modules-offline', 'video-audio', 'active.json')), 'An unreachable release server left an installation.')
    record('unreachable release server', `${offline.errorCode}: ${offline.error}`)
    await quit(app)

    report.results = results
    report.ok = true
    console.log(JSON.stringify(report, null, 2))
  } finally {
    for (const child of running) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
    }
    server.close()
    await wait(2_000)
    try { rmSync(work, { recursive: true, force: true }) } catch (error) { console.warn(`cleanup: ${error.message}`) }
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
  server.close()
  process.exit(1)
})
