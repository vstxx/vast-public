const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'win32') throw new Error('This Native Messaging registry E2E currently requires Windows.')

const root = path.resolve(__dirname, '..')
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-native-messaging-e2e-'))
const userDataDir = path.join(testRoot, 'profile')
const extensionPath = path.join(testRoot, 'extension')
const hostDirectory = path.join(testRoot, 'host')
const evidencePath = path.join(testRoot, 'host-evidence.jsonl')
const hostName = 'com.vast.native_messaging_test'
const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
const electronExecutable = process.env.VAST_PATCHED_ELECTRON_DIST
  ? path.join(process.env.VAST_PATCHED_ELECTRON_DIST, 'electron.exe')
  : 'D:\\VastElectron44\\src\\out\\VastCompat\\electron.exe'
let appProcess
let registryCreated = false

function assert(value, message) { if (!value) throw new Error(message) }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function extensionId(extensionDirectory) {
  // Chromium derives an unpacked extension ID from the absolute Windows path
  // encoded as UTF-16LE. Preserve path casing: lowercasing produces a different ID.
  const digest = createHash('sha256').update(Buffer.from(path.resolve(extensionDirectory), 'utf16le')).digest().subarray(0, 16)
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('')
}

async function json(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return response.json() } catch {}
    await wait(250)
  }
  throw new Error(`Could not connect to ${url}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
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
    const cdp = new Cdp(socket)
    await cdp.send('Runtime.enable')
    return cdp
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  close() { this.socket.close() }
}

async function findWorker(port, id) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const targets = await json(`http://127.0.0.1:${port}/json/list`)
    const worker = targets.find((target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${id}/`))
    if (worker) return Cdp.connect(worker.webSocketDebuggerUrl)
    await wait(250)
  }
  throw new Error('Native Messaging fixture service worker was not exposed.')
}

async function stop() {
  if (!appProcess || appProcess.exitCode !== null) return
  try { execFileSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
  await new Promise((resolve) => appProcess.once('exit', resolve))
}

async function main() {
  assert(fs.existsSync(electronExecutable), `Patched Electron was not found: ${electronExecutable}`)
  fs.cpSync(path.join(root, 'tests/fixtures/extensions/native-messaging-basic'), extensionPath, { recursive: true })
  const id = extensionId(extensionPath)

  const build = spawnSync('dotnet', [
    'publish', path.join(root, 'tests/fixtures/native-messaging-host/VastNativeMessagingHost.csproj'),
    '-c', 'Release', '-o', hostDirectory, '--nologo', '--verbosity', 'quiet'
  ], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || 'Native host build failed.')
  const hostExecutable = path.join(hostDirectory, 'VastNativeMessagingHost.exe')
  assert(fs.existsSync(hostExecutable), 'Native test host executable was not produced.')
  const hostManifestPath = path.join(hostDirectory, `${hostName}.json`)
  fs.writeFileSync(hostManifestPath, `${JSON.stringify({
    name: hostName,
    description: 'Vast deterministic Native Messaging fixture',
    path: path.basename(hostExecutable),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`]
  }, null, 2)}\n`)

  const existing = spawnSync('reg', ['query', registryKey], { encoding: 'utf8', windowsHide: true })
  assert(existing.status !== 0, `Refusing to overwrite an existing native host registration: ${registryKey}`)
  execFileSync('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', hostManifestPath, '/f'], { stdio: 'ignore' })
  registryCreated = true

  const registryDirectory = path.join(userDataDir, 'Extensions')
  fs.mkdirSync(registryDirectory, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), `${JSON.stringify({
    schemaVersion: 2,
    extensions: [{
      id,
      name: 'Vast Native Messaging Fixture',
      version: '1.0.0',
      description: 'Deterministic Chromium Native Messaging compatibility fixture.',
      path: extensionPath,
      enabled: true,
      source: 'unpacked',
      runtime: 'chrome',
      manifestVersion: 3,
      installedAt: now,
      updatedAt: now,
      allowFileAccess: false
    }]
  }, null, 2)}\n`)

  const remotePort = 14200 + Math.floor(Math.random() * 500)
  const stdout = []
  const stderr = []
  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: userDataDir,
    VAST_EXTENSION_COMPATIBILITY: '1',
    VAST_PATCHED_ELECTRON_COMPAT: '1',
    VAST_PATCHED_ELECTRON_DIST: path.dirname(electronExecutable),
    VAST_NATIVE_TEST_EVIDENCE: evidencePath,
    VAST_RELAY_ENABLED: '0',
    VAST_RELAY_TEST_OFFLINE: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  appProcess = spawn(electronExecutable, [`--remote-debugging-port=${remotePort}`, root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.on('data', (data) => stdout.push(String(data)))
  appProcess.stderr.on('data', (data) => stderr.push(String(data)))

  const worker = await findWorker(remotePort, id)
  let result
  for (let attempt = 0; attempt < 120; attempt += 1) {
    result = await worker.evaluate('globalThis.nativeMessagingEvidence').catch(() => undefined)
    if (result?.complete) break
    await wait(250)
  }
  worker.close()
  const hostEvidence = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath, 'utf8').trim() : '(none)'
  assert(result?.complete, `Native Messaging fixture did not complete: ${JSON.stringify(result)}; host evidence: ${hostEvidence}; stderr: ${stderr.join('').slice(-2000)}`)
  assert(result.sendNativeMessage?.error === null, `sendNativeMessage failed: ${result.sendNativeMessage?.error}`)
  assert(result.sendNativeMessage?.response?.text === 'zażółć 🌍', 'UTF-8 sendNativeMessage did not round-trip.')
  assert(result.portMessages?.length === 3, `Expected three port messages, received ${result.portMessages?.length}.`)
  assert(result.portMessages[0].sequence === 1 && result.portMessages[1].sequence === 2, 'Coalesced frames were not delivered in order.')
  assert(result.portMessages[2].text === 'gęślą jaźń 🌍', 'Fragmented UTF-8 frame was not reassembled.')
  assert(/exited/i.test(result.disconnectError || ''), 'Host crash did not expose runtime.lastError during onDisconnect.')

  const evidence = fs.readFileSync(evidencePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  assert(evidence.length >= 3, 'Expected one host process per sendNativeMessage/connectNative connection.')
  for (const event of evidence) {
    assert(event.args[0] === `chrome-extension://${id}/`, 'Native host received the wrong caller origin.')
    assert(event.args[1] === '--parent-window=0', 'Service-worker native host did not receive parent-window=0.')
  }
  await stop()
  assert(!stderr.join('').match(/unhandled rejection|uncaught exception/i), `Unexpected Electron error: ${stderr.join('')}`)
  if (process.env.VAST_NATIVE_TEST_TRACE === '1') {
    console.error(stderr.join(''))
    console.error(hostEvidence)
  }
  console.log('PASS Chromium Native Messaging E2E: registry discovery, relative host path, allowed origin, UTF-8 framing, fragmented/coalesced frames, process isolation, parent window, crash disconnect, and runtime.lastError.')
}

async function cleanup() {
  await stop()
  if (registryCreated) {
    try { execFileSync('reg', ['delete', registryKey, '/f'], { stdio: 'ignore' }) } catch {}
  }
  try { fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}

main().then(cleanup, async (error) => {
  console.error(error)
  await cleanup()
  process.exitCode = 1
})
