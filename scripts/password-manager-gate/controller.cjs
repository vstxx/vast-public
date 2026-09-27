const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { fixtureHostResolverRules, isApprovedFixtureHost } = require('./tls.cjs')
const { credentialReferenceSha256, writeJsonAtomic } = require('./run-state.cjs')
const { createPrivacyGateEvidence } = require('./verify.cjs')
const { cleanSnapshot } = require('./cdp.cjs')
const { applyFixtureEvidence } = require('./scenarios.cjs')

const MODE_TARGETS = Object.freeze({ bitwarden: ['bitwarden'], proton: ['protonpass'], combined: ['bitwarden', 'protonpass'] })
// Generic "crash" text is not process-crash evidence: Crashpad startup and
// native-host lifecycle messages legitimately contain that word.
const PROCESS_CRASH_DIAGNOSTIC = /^(?:\[[^\r\n]*FATAL:[^\r\n]*\]|Received signal \d+\b|(?:Renderer|GPU|Utility|Browser) process (?:has )?crashed\b)/i
const PROCESS_DIAGNOSTICS = Object.freeze([
  [/Receiving end does not exist/i, 'MissingReceiver'],
  [/Invalid guestInstanceId/i, 'InvalidGuestInstanceId'],
  [/splitViewId/i, 'SplitViewIdValidation'],
  [/runtime\.lastError/i, 'RuntimeLastError'],
  [/service worker/i, 'ServiceWorkerDiagnostic'],
  [PROCESS_CRASH_DIAGNOSTIC, 'ProcessCrash']
])
const MAX_DIAGNOSTIC_LINE_BYTES = 16 * 1024

function messagingDiagnosticMetadata(line) {
  const match = line.match(/\[VastCompat\] Receiving end does not exist method=([A-Za-z][A-Za-z0-9_.]{0,79}) extension=([a-p]{32}) sender=(service_worker|extension_page) receiver=(tab_frame|extension) tab=(-1|\d+) frame=(-1|\d+)/)
  if (!match) return {}
  const tabId = Number(match[5])
  const frameId = Number(match[6])
  return {
    apiMethod: match[1],
    extensionId: match[2],
    contextType: match[3],
    receiverContext: match[4],
    ...(Number.isSafeInteger(tabId) && tabId >= 0 ? { tabId } : {}),
    ...(Number.isSafeInteger(frameId) && frameId >= 0 ? { frameId } : {})
  }
}

function createProcessDiagnosticSink(emit) {
  const pending = new Map()
  const discard = new Set()
  const classify = (line, stream) => {
    const metadata = messagingDiagnosticMetadata(line)
    for (const [pattern, errorClass] of PROCESS_DIAGNOSTICS) {
      if (pattern.test(line)) emit({ stream, errorClass, ...metadata })
    }
  }
  return {
    push(stream, chunk) {
      if (stream !== 'stdout' && stream !== 'stderr') return
      const text = String(chunk)
      const lines = text.split(/\n/)
      for (let index = 0; index < lines.length; index++) {
        const value = lines[index]
        const completed = index < lines.length - 1
        if (!discard.has(stream)) {
          const candidate = (pending.get(stream) || '') + value
          if (Buffer.byteLength(candidate, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
            pending.delete(stream)
            discard.add(stream)
          } else if (completed) {
            pending.delete(stream)
            classify(candidate, stream)
          } else pending.set(stream, candidate)
        }
        if (completed) discard.delete(stream)
      }
    },
    flush(stream) {
      if (discard.has(stream)) { discard.delete(stream); pending.delete(stream); return }
      const line = pending.get(stream)
      pending.delete(stream)
      if (line) classify(line, stream)
    }
  }
}
const PRIVACY_PROBE_EXPRESSION = `(() => {
  const call = (invoke) => new Promise((resolve, reject) => {
    invoke((value) => {
      const failed = Boolean(chrome.runtime.lastError)
      if (failed) reject(new Error('Extension API call failed.'))
      else resolve(value)
    })
  })
  const read = (key, setting) => call((done) => setting.get({}, done)).then((details) => ({
    key,
    value: details.value,
    levelOfControl: details.levelOfControl
  }))
  return Promise.all([
    call((done) => chrome.permissions.getAll(done)),
    read('services.passwordSavingEnabled', chrome.privacy.services.passwordSavingEnabled),
    read('services.autofillAddressEnabled', chrome.privacy.services.autofillAddressEnabled),
    read('services.autofillCreditCardEnabled', chrome.privacy.services.autofillCreditCardEnabled)
  ]).then(([permissions, ...keys]) => ({
    extensionId: chrome.runtime.id,
    optionalPrivacyGranted: Array.isArray(permissions.permissions) && permissions.permissions.includes('privacy'),
    keys
  }))
})()`

class WorkerCdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.eventListeners = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (typeof message.method === 'string' && this.eventListeners.has(message.method)) {
        for (const listener of this.eventListeners.get(message.method)) listener(message.params || {})
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(`CDP ${pending.method} failed.`))
      else pending.resolve(message.result)
    })
  }

  on(method, listener) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set())
    this.eventListeners.get(method).add(listener)
    return () => this.eventListeners.get(method)?.delete(listener)
  }

  static async connect(url, WebSocketImpl = globalThis.WebSocket) {
    if (typeof WebSocketImpl !== 'function') throw new Error('The gate runtime has no WebSocket implementation.')
    const socket = new WebSocketImpl(url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP worker connection timed out.')), 10_000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP worker connection failed.')) }, { once: true })
    })
    const session = new WorkerCdpSession(socket)
    await session.send('Runtime.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out.`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timeout, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (response?.exceptionDetails || !response?.result || !Object.hasOwn(response.result, 'value')) {
      throw new Error('CDP evaluation failed.')
    }
    return response.result.value
  }

  close() { this.socket.close() }
}

async function capturePrivacyEvidenceFromWorker({
  port,
  extensionId,
  fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url)
}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('Privacy probe requires a valid debugger port.')
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw new Error('Privacy probe requires a canonical extension ID.')
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) return undefined
  const targets = await response.json()
  if (!Array.isArray(targets)) return undefined
  const worker = targets.find((target) => {
    if (target?.type !== 'service_worker' || typeof target.url !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') return false
    try {
      const url = new URL(target.url)
      return url.protocol === 'chrome-extension:' && url.hostname === extensionId
    } catch {
      return false
    }
  })
  if (!worker) return undefined
  const session = await connect(worker.webSocketDebuggerUrl)
  try {
    return await session.evaluate(PRIVACY_PROBE_EXPRESSION)
  } finally {
    session.close()
  }
}

async function captureFixtureSnapshotFromPage({
  port,
  fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url)
}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('Fixture probe requires a valid debugger port.')
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) return undefined
  const targets = await response.json()
  if (!Array.isArray(targets)) return undefined
  const page = targets.find((target) => {
    if (target?.type !== 'webview' || typeof target.url !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') return false
    try {
      const url = new URL(target.url)
      return url.protocol === 'https:' && isApprovedFixtureHost(url.hostname)
    } catch {
      return false
    }
  })
  if (!page) return undefined
  const session = await connect(page.webSocketDebuggerUrl)
  try {
    return cleanSnapshot(await session.evaluate('window.__vastGate.snapshot()'))
  } finally {
    session.close()
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function seedExtensionRegistry(profile, targets, now = Date.now()) {
  const registryPath = path.join(profile, 'Extensions', 'registry.json')
  let registry = { schemaVersion: 6, extensions: [] }
  if (fs.existsSync(registryPath)) {
    registry = readJson(registryPath)
    if (!registry || registry.schemaVersion !== 6 || !Array.isArray(registry.extensions)) {
      throw new Error(`Refusing to replace malformed extension registry: ${registryPath}`)
    }
  }

  for (const target of targets) {
    const manifest = target.manifest || readJson(path.join(target.runtimePath, 'manifest.json'))
    const expectedPath = path.resolve(target.runtimePath)
    const sameId = registry.extensions.find((record) => record.id === target.runtimeId)
    const samePath = registry.extensions.find((record) => typeof record.path === 'string' && path.resolve(record.path).toLowerCase() === expectedPath.toLowerCase())
    if (sameId && samePath && sameId !== samePath) {
      throw new Error(`The profile contains conflicting ID and path records for ${target.key}.`)
    }
    const existing = sameId || samePath
    if (existing && (existing.id !== target.runtimeId || path.resolve(existing.path).toLowerCase() !== expectedPath.toLowerCase())) {
      throw new Error(`The persistent profile contains a conflicting ${target.key} identity.`)
    }
    if (existing) {
      Object.assign(existing, {
        name: manifest.name,
        version: target.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        path: expectedPath,
        enabled: true,
        runtimeExtensionId: target.runtimeId,
        upstreamExtensionId: target.runtimeId,
        updatedAt: now
      })
      continue
    }
    registry.extensions.push({
      id: target.runtimeId,
      runtimeExtensionId: target.runtimeId,
      upstreamExtensionId: target.runtimeId,
      name: manifest.name,
      version: target.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      path: expectedPath,
      enabled: true,
      source: 'unpacked',
      trust: 'developer',
      updateState: 'not-applicable',
      runtime: 'chrome',
      manifestVersion: manifest.manifest_version,
      installedAt: now,
      updatedAt: now,
      allowFileAccess: false,
      grantedPermissions: [],
      grantedChromePermissions: [],
      grantedChromeOrigins: []
    })
  }
  writeJsonAtomic(registryPath, registry)
  return registryPath
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const defaultProcessAdapter = {
  launch(command, args, options) { return spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false }) },
  gracefulExit(child) {
    return new Promise((resolve) => {
      child.once('exit', (exitCode, signal) => resolve({ event: 'electron-exited', exitCode, signal }))
      child.kill('SIGTERM')
    })
  }
}

const defaultRestartSettle = () => new Promise((resolve) => setTimeout(resolve, 1_500))

class PasswordManagerGateController {
  constructor(options) {
    Object.assign(this, options)
    this.processAdapter ||= defaultProcessAdapter
    this.waitForRestartSettle ||= defaultRestartSettle
    this.onStatus ||= () => undefined
    this.onProcessDiagnostic ||= () => undefined
    this.runRoot = path.join(this.config.gateRoot, 'runs', this.runId)
    this.child = undefined
    this.server = undefined
    this.observer = undefined
    this.lock = undefined
    this.stopped = false
    this.now ||= () => new Date()
    this.privacyGeneration = 0
    this.setIntervalFn ||= setInterval
    this.clearIntervalFn ||= clearInterval
    this.privacyPollIntervalMs ||= 1_000
    this.privacyTimer = undefined
    this.privacyPollPromise = undefined
    this.fixtureTimer = undefined
    this.fixturePollPromise = undefined
    this.fixturePollIntervalMs ||= 1_000
  }

  status(value, details = {}) {
    const resultPath = path.join(this.runRoot, 'result.json')
    const result = (value === 'stopped' || value === 'failed') && fs.existsSync(resultPath) ? readJson(resultPath) : undefined
    const terminalValue = value === 'stopped' && result?.status === 'failed' ? 'failed' : value
    this.onStatus(terminalValue)
    writeJsonAtomic(path.join(this.runRoot, 'status.json'), { status: terminalValue, at: new Date().toISOString(), ...details })
    if (result && result.status !== 'failed' && result.status !== 'pass') {
      writeJsonAtomic(resultPath, { ...result, status: terminalValue })
    }
  }

  validateTargetSet() {
    const expected = MODE_TARGETS[this.config.mode]
    const actual = this.config.targets.map((target) => target.key)
    if (!expected || canonical(actual) !== canonical(expected)) throw new Error(`Invalid target set for ${this.config.mode}.`)
  }

  launch() {
    const origin = this.server.origins['login.vast-test.local']
    const args = [
      `--remote-debugging-port=${this.config.remoteDebuggingPort || 9223}`,
      `--host-resolver-rules=${fixtureHostResolverRules()}`,
      this.config.root,
      `${origin}/login`
    ]
    const env = {
      ...process.env,
      ELECTRON_OVERRIDE_DIST_PATH: this.config.patchedDist,
      VAST_PATCHED_ELECTRON_DIST: this.config.patchedDist,
      VAST_PATCHED_ELECTRON_COMPAT: '1',
      VAST_EXTENSION_COMPATIBILITY: '1',
      VAST_DEV_USER_DATA_DIR: this.config.profile,
      VAST_RELEASE_CHANNEL: 'dev',
      VAST_DISTRIBUTION_CHANNEL: 'direct',
      VAST_PRIVATE_BUILD: '1',
      VAST_UPDATE_ENABLED: '0',
      VAST_RELAY_ENABLED: '0'
    }
    delete env.ELECTRON_RUN_AS_NODE
    this.child = this.processAdapter.launch(this.config.electronExecutable, args, {
      cwd: this.config.root,
      env,
      windowsHide: false
    })
    const diagnosticSink = createProcessDiagnosticSink((event) => this.onProcessDiagnostic(event))
    for (const stream of ['stdout', 'stderr']) {
      this.child?.[stream]?.on?.('data', (chunk) => {
        diagnosticSink.push(stream, chunk)
      })
      this.child?.[stream]?.on?.('end', () => diagnosticSink.flush(stream))
    }
    this.observer = this.createObserver(this.child)
    return this.child
  }

  async capturePrivacyCheckpoint() {
    if (typeof this.capturePrivacyEvidence !== 'function') return false
    const target = this.config.targets.find((item) => item.key === 'bitwarden')
    if (!target) return false
    const raw = await this.capturePrivacyEvidence({
      port: this.config.remoteDebuggingPort || 9223,
      extensionId: target.runtimeId
    })
    if (raw === undefined) return false
    const evidence = createPrivacyGateEvidence(raw, this.now)
    const generation = this.privacyGeneration++
    writeJsonAtomic(path.join(this.runRoot, `privacy-evidence-${generation}.json`), evidence)
    const resultPath = path.join(this.runRoot, 'result.json')
    if (fs.existsSync(resultPath)) {
      const result = readJson(resultPath)
      const previous = Array.isArray(result.privacyEvidence) ? result.privacyEvidence : []
      writeJsonAtomic(resultPath, { ...result, privacyEvidence: [...previous, evidence] })
    }
    return true
  }

  stopPrivacyObservation() {
    if (this.privacyTimer === undefined) return
    this.clearIntervalFn(this.privacyTimer)
    this.privacyTimer = undefined
  }

  async pollPrivacyEvidence() {
    if (this.privacyPollPromise) return this.privacyPollPromise
    this.privacyPollPromise = this.capturePrivacyCheckpoint()
      .catch(() => false)
      .then((captured) => {
        if (captured) this.stopPrivacyObservation()
        return captured
      })
      .finally(() => { this.privacyPollPromise = undefined })
    return this.privacyPollPromise
  }

  async startPrivacyObservation() {
    if (typeof this.capturePrivacyEvidence !== 'function') return
    if (await this.pollPrivacyEvidence()) return
    if (this.privacyTimer !== undefined) return
    this.privacyTimer = this.setIntervalFn(() => this.pollPrivacyEvidence(), this.privacyPollIntervalMs)
    this.privacyTimer?.unref?.()
  }

  async captureFixtureCheckpoint() {
    if (typeof this.captureFixtureEvidence !== 'function') return false
    const raw = await this.captureFixtureEvidence({ port: this.config.remoteDebuggingPort || 9223 })
    if (raw === undefined) return false
    const snapshot = cleanSnapshot(raw)
    const resultPath = path.join(this.runRoot, 'result.json')
    const result = readJson(resultPath)
    const previous = Array.isArray(result.fixtureEvidence) ? result.fixtureEvidence : []
    const generation = previous.length
    const evidencePath = path.join(this.runRoot, `fixture-evidence-${generation}.json`)
    if (fs.existsSync(evidencePath)) {
      let orphan
      try {
        orphan = readJson(evidencePath)
        const safeSnapshot = cleanSnapshot(orphan.snapshot)
        if (orphan.id !== `fixture-evidence-${generation}` ||
            typeof orphan.observedAt !== 'string' || !Number.isFinite(Date.parse(orphan.observedAt)) ||
            canonical(orphan.snapshot) !== canonical(safeSnapshot) ||
            canonical(Object.keys(orphan).sort()) !== canonical(['id', 'observedAt', 'snapshot'])) {
          throw new Error('Invalid orphan artifact.')
        }
      } catch {
        throw new Error('Refusing unsafe orphan fixture evidence.')
      }
      writeJsonAtomic(resultPath, applyFixtureEvidence({ ...result, fixtureEvidence: [...previous, orphan] }, orphan))
      return true
    }
    if (previous.length && JSON.stringify(previous.at(-1).snapshot) === JSON.stringify(snapshot)) return false
    const evidence = Object.freeze({
      id: `fixture-evidence-${generation}`,
      observedAt: this.now().toISOString(),
      snapshot
    })
    writeJsonAtomic(evidencePath, evidence)
    writeJsonAtomic(resultPath, applyFixtureEvidence({ ...result, fixtureEvidence: [...previous, evidence] }, evidence))
    return true
  }

  stopFixtureObservation() {
    if (this.fixtureTimer === undefined) return
    this.clearIntervalFn(this.fixtureTimer)
    this.fixtureTimer = undefined
  }

  async pollFixtureEvidence() {
    if (this.fixturePollPromise) return this.fixturePollPromise
    this.fixturePollPromise = this.captureFixtureCheckpoint()
      .catch(() => false)
      .finally(() => { this.fixturePollPromise = undefined })
    return this.fixturePollPromise
  }

  async startFixtureObservation() {
    if (typeof this.captureFixtureEvidence !== 'function') return
    await this.pollFixtureEvidence()
    if (this.fixtureTimer !== undefined) return
    this.fixtureTimer = this.setIntervalFn(() => this.pollFixtureEvidence(), this.fixturePollIntervalMs)
    this.fixtureTimer?.unref?.()
  }

  async run() {
    this.validateTargetSet()
    this.status('preparing')
    this.lock = this.acquireLock(this.config.profile, { pid: process.pid, runId: this.runId })
    try {
      this.baselineFingerprint = this.getFingerprint()
      this.server = await this.createServer({
        tls: this.tls,
        port: this.config.fixturePort || 0,
        expectedHashes: this.expectedHashes
      })
      writeJsonAtomic(path.join(this.runRoot, 'command.json'), {
        schemaVersion: 1,
        command: 'run',
        mode: this.config.mode,
        runId: this.runId,
        exploratory: this.config.exploratory === true,
        credentialConfigured: this.config.credentialConfigured !== false,
        profile: this.config.profile,
        electronExecutable: this.config.electronExecutable,
        credentialReferenceSha256: credentialReferenceSha256(this.expectedHashes),
        targets: this.config.targets.map(({ key, runtimeId }) => ({ key, runtimeId }))
      })
      this.launch()
      await this.observer.start()
      await this.startPrivacyObservation()
      await this.startFixtureObservation()
      this.status('running', { electronPid: this.child.pid, fixturePort: this.server.port,
        debuggerPort: this.config.remoteDebuggingPort })
      return this.child
    } catch (error) {
      this.status('failed', { errorClass: error?.name || 'Error' })
      if (this.lock) { this.lock.release(); this.lock = undefined }
      throw error
    }
  }

  async restart() {
    if (!this.child) throw new Error('Cannot restart before Electron is running.')
    this.status('restarting')
    const restartStartedAt = this.now().toISOString()
    const previousPid = this.child.pid
    const profile = this.config.profile
    this.stopPrivacyObservation()
    this.stopFixtureObservation()
    if (this.observer) await this.observer.stop()
    const exit = await this.processAdapter.gracefulExit(this.child)
    this.child = undefined
    if (exit?.event !== 'electron-exited') throw new Error('Restart requires an electron-exited lifecycle event.')
    await this.waitForRestartSettle()
    const fresh = this.getFingerprint()
    if (canonical(fresh) !== canonical(this.baselineFingerprint)) {
      this.status('failed', { errorClass: 'RuntimeFingerprintChanged' })
      throw new Error('Runtime fingerprint changed across restart.')
    }
    this.launch()
    await this.observer.start()
    await this.startPrivacyObservation()
    await this.startFixtureObservation()
    const resultPath = path.join(this.runRoot, 'result.json')
    const result = readJson(resultPath)
    const previous = Array.isArray(result.restartEvidence) ? result.restartEvidence : []
    const evidence = Object.freeze({ id: `restart-evidence-${previous.length}`,
      observedAt: this.now().toISOString(), previousPid, newPid: this.child.pid,
      exitEvent: exit.event, fingerprintMatched: true, profilePreserved: this.config.profile === profile })
    writeJsonAtomic(path.join(this.runRoot, `${evidence.id}.json`), evidence)
    const scenarioId = this.config.mode === 'combined' ? 'vast-restart-both' : 'vast-restart'
    const scenario = result.scenarios?.[scenarioId]
    const scenarios = scenario?.status === 'blocked' ? { ...result.scenarios,
      [scenarioId]: { ...scenario, status: 'pass', startedAt: restartStartedAt,
        finishedAt: evidence.observedAt, machineEvidence: [evidence.id] } } : result.scenarios
    writeJsonAtomic(resultPath, { ...result,
      runtimeFingerprints: [...(result.runtimeFingerprints || []), fresh],
      restartEvidence: [...previous, evidence], scenarios })
    this.status('running', { electronPid: this.child.pid, fixturePort: this.server.port,
      debuggerPort: this.config.remoteDebuggingPort, restarted: true })
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    try {
      this.stopPrivacyObservation()
      this.stopFixtureObservation()
      if (this.observer) await this.observer.stop()
      if (this.child) {
        const exit = await this.processAdapter.gracefulExit(this.child)
        if (exit?.event !== 'electron-exited') throw new Error('Stop requires an electron-exited lifecycle event.')
      }
      if (this.server) await this.server.close()
      this.status('stopped')
    } finally {
      if (this.lock) this.lock.release()
      this.lock = undefined
      this.child = undefined
    }
  }
}

module.exports = { captureFixtureSnapshotFromPage, capturePrivacyEvidenceFromWorker,
  createProcessDiagnosticSink, messagingDiagnosticMetadata, PasswordManagerGateController,
  seedExtensionRegistry, WorkerCdpSession }
