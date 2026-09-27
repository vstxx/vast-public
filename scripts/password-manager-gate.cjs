#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { parseGateArgs, resolveGateConfig } = require('./password-manager-gate/config.cjs')
const { readCrxIdentity, stageIdentityRuntime } = require('./password-manager-gate/crx-identity.cjs')
const { ensureTlsMaterial } = require('./password-manager-gate/tls.cjs')
const { verifyGateResult } = require('./password-manager-gate/verify.cjs')
const { acquireProfileLock, buildRuntimeFingerprint, credentialReferenceSha256, writeJsonAtomic } = require('./password-manager-gate/run-state.cjs')
const { createFixtureServer } = require('./password-manager-gate/fixtures.cjs')
const { assertPrerequisites, scenarioCatalog } = require('./password-manager-gate/scenarios.cjs')
const { confirmBitwardenSuggestion, confirmManualAutofill, recordExtensionReload } = require('./password-manager-gate/checkpoints.cjs')
const { captureFixtureSnapshotFromPage, capturePrivacyEvidenceFromWorker, PasswordManagerGateController, seedExtensionRegistry } = require('./password-manager-gate/controller.cjs')
const { sanitizeEvent } = require('./password-manager-gate/redaction.cjs')

const root = path.resolve(__dirname, '..')

function powershell(script, extra = []) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'password-manager-gate', script), ...extra], { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${script} exited with code ${result.status}.`)
}

function checkEceRuntime(projectRoot = root) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'prepare-extension-compat-runtime.cjs'), '--check'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'ECE runtime check failed.').trim())
}

function assertProfileLockAvailable(profile, pidIsLive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}) {
  const lockPath = path.join(profile, '.vast-password-manager-gate.lock.json')
  if (!fs.existsSync(lockPath)) return
  let lock
  try { lock = readJson(lockPath) } catch { throw new Error(`Profile lock is malformed: ${lockPath}`) }
  if (Number.isSafeInteger(lock.pid) && lock.pid > 0 && pidIsLive(lock.pid)) {
    throw new Error(`Profile is already owned by live PID ${lock.pid} (run ${lock.runId || 'unknown'}).`)
  }
}

function preparationReport(args, env, dependencies = {}) {
  const resolveConfig = dependencies.resolveConfig || ((gateRoot, gateArgs, gateEnv) => resolveGateConfig(gateRoot, gateArgs, gateEnv))
  const ensureTls = dependencies.ensureTls || ensureTlsMaterial
  const checkEce = dependencies.checkEce || (() => checkEceRuntime(root))
  const readIdentity = dependencies.readIdentity || readCrxIdentity
  const stageRuntime = dependencies.stageRuntime || stageIdentityRuntime
  const checkProfileLock = dependencies.checkProfileLock || assertProfileLockAvailable
  const report = { command: args.command, mode: args.mode, ready: true, checks: [], errors: [] }
  let config
  try {
    config = resolveConfig(root, args, env)
    if (args.exploratory) report.checks.push({ name: 'gate-prerequisites', status: 'bypassed-exploratory' })
    else {
      assertPrerequisites(args.mode, dependencies.history || loadPrerequisiteHistory(config.gateRoot))
      report.checks.push({ name: 'gate-prerequisites', status: 'pass' })
    }
    checkProfileLock(config.profile)
    report.checks.push({ name: 'profile-lock', status: 'available' })
    report.checks.push({ name: 'profile', path: config.profile })
    report.checks.push({ name: 'electron', path: config.electronExecutable })
    ensureTls(path.join(config.gateRoot, 'tls'))
    report.checks.push({ name: 'trusted-tls', status: 'pass' })
    checkEce()
    report.checks.push({ name: 'ece-runtime-patches', status: 'pass' })
    for (const target of config.targets) {
      const identity = readIdentity(target.crxPath, target.expectedUpstreamId)
      report.checks.push({ name: `${target.key}-identity`, runtimeId: identity.extensionId })
      const runtime = stageRuntime({
        gateRoot: config.gateRoot,
        key: target.key,
        popup: target.popup,
        sourcePath: target.sourcePath,
        expectedId: target.expectedUpstreamId,
        identity
      })
      report.checks.push({ name: `${target.key}-runtime`, runtimeId: runtime.runtimeId, path: runtime.runtimePath })
    }
  } catch (error) {
    report.ready = false
    if (config && !report.checks.some((check) => check.name === 'profile')) {
      report.checks.push({ name: 'profile', path: config.profile })
    }
    report.errors.push({ errorClass: error?.name || 'Error', message: String(error?.message || error) })
  }
  return report
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function safeRunId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error('A run ID must be a non-secret filename-safe identifier.')
  }
  return value
}

function resolveStoredRun(gateRoot, { mode, runId }) {
  const runsRoot = path.join(gateRoot, 'runs')
  if (runId) {
    const id = safeRunId(runId)
    const runRoot = path.join(runsRoot, id)
    const command = readJson(path.join(runRoot, 'command.json'))
    if (mode && command.mode !== mode) throw new Error(`Run ${id} belongs to ${command.mode}, not ${mode}.`)
    return { runId: id, runRoot, command }
  }
  if (!mode) throw new Error('A mode or --run-id is required.')
  const matches = fs.existsSync(runsRoot)
    ? fs.readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const runRoot = path.join(runsRoot, entry.name)
        try {
          const command = readJson(path.join(runRoot, 'command.json'))
          return command.mode === mode ? { runId: entry.name, runRoot, command, modified: fs.statSync(runRoot).mtimeMs } : undefined
        } catch { return undefined }
      })
      .filter(Boolean)
      .sort((left, right) => right.modified - left.modified)
    : []
  if (matches.length === 0) throw new Error(`No stored ${mode} gate run exists.`)
  return matches[0]
}

async function executeGateCommand(args, dependencies = {}) {
  const gateRoot = dependencies.gateRoot || path.join(dependencies.root || root, '.vast-build', 'password-manager-gates')
  if (args.command === 'run') {
    if (!args.mode) throw new Error('The run command requires a mode.')
    if (args.dryRun) return preparationReport(args, dependencies.env || process.env, dependencies.preparationDependencies)
    const startGate = dependencies.startGate || startGateRun
    return startGate({ ...args, root: dependencies.root || root, gateRoot, resume: false }, dependencies)
  }
  if (args.command === 'resume') {
    const stored = resolveStoredRun(gateRoot, args)
    const startGate = dependencies.startGate || startGateRun
    return startGate({
      ...args,
      root: dependencies.root || root,
      gateRoot,
      mode: stored.command.mode,
      runId: stored.runId,
      runRoot: stored.runRoot,
      resume: true
    }, dependencies)
  }
  if (args.command === 'status') {
    const stored = resolveStoredRun(gateRoot, args)
    return readJson(path.join(stored.runRoot, 'status.json'))
  }
  if (args.command === 'verify') {
    const stored = resolveStoredRun(gateRoot, args)
    return verifyGateResult(readJson(path.join(stored.runRoot, 'result.json')))
  }
  if (args.command === 'confirm-autofill') {
    const stored = resolveStoredRun(gateRoot, args)
    return confirmManualAutofill({
      runRoot: stored.runRoot,
      runId: stored.runId,
      mode: stored.command.mode,
      operatorConfirmed: args.operatorConfirmed
    })
  }
  if (args.command === 'confirm-suggestion') {
    const stored = resolveStoredRun(gateRoot, args)
    return confirmBitwardenSuggestion({
      runRoot: stored.runRoot,
      runId: stored.runId,
      mode: stored.command.mode,
      operatorConfirmed: args.operatorConfirmed
    })
  }
  if (args.command === 'record-reload') {
    const stored = resolveStoredRun(gateRoot, args)
    return recordExtensionReload({ runRoot: stored.runRoot, runId: stored.runId, mode: stored.command.mode })
  }
  if (args.command === 'stop' || args.command === 'restart') {
    const stored = resolveStoredRun(gateRoot, args)
    const launcher = readJson(path.join(stored.runRoot, 'launcher.json'))
    if (launcher.runId !== stored.runId || !Number.isSafeInteger(launcher.controllerPid) || launcher.controllerPid <= 0) {
      throw new Error('Stored launcher metadata does not identify this run controller.')
    }
    const pidIsLive = dependencies.pidIsLive || ((pid) => {
      try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
    })
    if (!pidIsLive(launcher.controllerPid)) throw new Error(`Controller PID ${launcher.controllerPid} is not running.`)
    const result = { status: `${args.command}-requested`, runId: stored.runId,
      controllerPid: launcher.controllerPid, at: new Date().toISOString() }
    writeJsonAtomic(path.join(stored.runRoot, 'status.json'), result)
    writeJsonAtomic(path.join(stored.runRoot, `${args.command}-request.json`), {
      schemaVersion: 1,
      runId: stored.runId,
      controllerPid: launcher.controllerPid,
      requestedAt: result.at
    })
    return result
  }
  throw new Error(`Command ${args.command} requires a prepared run and is not available until controller wiring is complete.`)
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit', shell: false, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`)
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function loadExpectedHashes(gateRoot, mode, env = process.env) {
  const direct = { username: env.VAST_GATE_USERNAME_SHA256, password: env.VAST_GATE_PASSWORD_SHA256 }
  if (direct.username || direct.password) {
    if (![direct.username, direct.password].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))) {
      throw new Error('VAST_GATE_USERNAME_SHA256 and VAST_GATE_PASSWORD_SHA256 must both be SHA-256 hex values.')
    }
    return Object.freeze({ username: direct.username.toLowerCase(), password: direct.password.toLowerCase() })
  }
  const credentialPath = path.resolve(env.VAST_GATE_CREDENTIAL_HASH_FILE || path.join(gateRoot, 'credential-hashes', `${mode}.json`))
  if (!fs.existsSync(credentialPath)) {
    throw new Error(`Controlled credential hashes are missing: ${credentialPath}`)
  }
  const saved = readJson(credentialPath)
  if (![saved.usernameSha256, saved.passwordSha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))) {
    throw new Error('Controlled credential hash file is malformed.')
  }
  return Object.freeze({ username: saved.usernameSha256.toLowerCase(), password: saved.passwordSha256.toLowerCase() })
}

function exploratoryExpectedHashes() {
  const digest = (label) => createHash('sha256').update(`vast-password-gate-exploratory-no-credential:${label}:v1`).digest('hex')
  return Object.freeze({ username: digest('username'), password: digest('password') })
}

function loadPrerequisiteHistory(gateRoot) {
  const history = {}
  for (const mode of ['bitwarden', 'proton', 'combined']) {
    try {
      const stored = resolveStoredRun(gateRoot, { mode })
      const result = readJson(path.join(stored.runRoot, 'result.json'))
      history[mode] = result.status
    } catch {}
  }
  return history
}

function appendEvent(filePath, event) {
  const safe = sanitizeEvent(event)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(safe)}\n`, 'utf8')
  return safe
}

function createEventRecorder(filePath) {
  let sequence = 0
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/).filter(Boolean)
    if (lines.length > 0) {
      const last = JSON.parse(lines.at(-1))
      if (!Number.isSafeInteger(last.sequence) || last.sequence < 0) {
        throw new Error('Stored gate event sequence is invalid.')
      }
      sequence = last.sequence + 1
    }
  }
  return (event) => appendEvent(filePath, { sequence: sequence++, at: new Date().toISOString(), ...event })
}

const FINDING_IDS = Object.freeze({
  MissingReceiver: 'missing-receiver',
  InvalidGuestInstanceId: 'invalid-guest-instance-id',
  SplitViewIdValidation: 'split-view-id-validation',
  ProcessCrash: 'process-crash'
})

function recordProcessFinding(resultPath, event) {
  const id = FINDING_IDS[event.errorClass]
  if (!id) return
  const current = readJson(resultPath)
  const defects = Array.isArray(current.defects) ? current.defects : []
  if (defects.some((defect) => defect?.id === id)) return
  writeJsonAtomic(resultPath, {
    ...current,
    defects: [...defects, {
      id,
      classification: 'unclassified',
      resolved: false,
      evidenceIds: Number.isSafeInteger(event.sequence) ? [`sequence:${event.sequence}`] : []
    }]
  })
}

function createRateLimitedDiagnosticRecorder(recordEvent, recordFinding, now = () => new Date()) {
  let minute = ''
  const counts = new Map()
  return ({ errorClass, stream, apiMethod, extensionId, contextType, receiverContext, tabId, frameId }) => {
    const currentMinute = now().toISOString().slice(0, 16)
    if (currentMinute !== minute) { minute = currentMinute; counts.clear() }
    const key = `${stream}:${errorClass}`
    const count = (counts.get(key) || 0) + 1
    counts.set(key, count)
    if (count > 16 && (count & (count - 1)) !== 0) return
    const event = recordEvent({ event: 'process-diagnostic', errorClass,
      diagnosticStream: stream, diagnosticCount: count,
      apiMethod, extensionId, contextType, receiverContext, tabId, frameId })
    recordFinding(event)
  }
}

async function consumeStopRequest(runRoot, runId, controllerPid, stop) {
  const requestPath = path.join(runRoot, 'stop-request.json')
  if (!fs.existsSync(requestPath)) return false
  const request = readJson(requestPath)
  if (request.schemaVersion !== 1 || request.runId !== runId || request.controllerPid !== controllerPid ||
      typeof request.requestedAt !== 'string' || !Number.isFinite(Date.parse(request.requestedAt))) return false
  fs.rmSync(requestPath, { force: true })
  await stop()
  return true
}

async function consumeRestartRequest(runRoot, runId, controllerPid, restart) {
  const requestPath = path.join(runRoot, 'restart-request.json')
  if (!fs.existsSync(requestPath)) return false
  const request = readJson(requestPath)
  if (request.schemaVersion !== 1 || request.runId !== runId || request.controllerPid !== controllerPid ||
      typeof request.requestedAt !== 'string' || !Number.isFinite(Date.parse(request.requestedAt))) return false
  fs.rmSync(requestPath, { force: true })
  await restart()
  return true
}

class RemoteTargetObserver {
  constructor({ port, eventsPath, recordEvent, intervalMs = 500 }) {
    this.port = port
    this.eventsPath = eventsPath
    this.recordEvent = recordEvent || createEventRecorder(eventsPath)
    this.intervalMs = intervalMs
    this.targets = new Map()
    this.timer = undefined
    this.polling = false
  }

  record(event) {
    return this.recordEvent(event)
  }

  async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`)
      if (!response.ok) return
      const targets = await response.json()
      if (!Array.isArray(targets)) return
      const current = new Set()
      for (const target of targets) {
        if (typeof target?.id !== 'string') continue
        current.add(target.id)
        const summary = { contextType: target.type, targetId: target.id, url: target.url, lifecycleState: 'active' }
        if (!this.targets.has(target.id)) this.record({ event: 'target-created', ...summary })
        this.targets.set(target.id, summary)
      }
      for (const [targetId, summary] of this.targets) {
        if (current.has(targetId)) continue
        this.record({ event: 'target-destroyed', ...summary, lifecycleState: 'destroyed' })
        this.targets.delete(targetId)
      }
    } catch {
      // The debugger endpoint is expected to be unavailable during startup and shutdown.
    } finally {
      this.polling = false
    }
  }

  async start() {
    if (this.timer) return
    await this.poll()
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
  }

  async stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

function prepareLiveRuntime(request, dependencies = {}) {
  const env = dependencies.env || process.env
  const resolveConfig = dependencies.resolveConfig || resolveGateConfig
  const config = resolveConfig(request.root, { ...request, command: 'run' }, env)
  const ensureTls = dependencies.ensureTls || ensureTlsMaterial
  const checkEce = dependencies.checkEce || (() => checkEceRuntime(request.root))
  const readIdentity = dependencies.readIdentity || readCrxIdentity
  const stageRuntime = dependencies.stageRuntime || stageIdentityRuntime
  const tls = ensureTls(path.join(config.gateRoot, 'tls'))
  checkEce()
  const targets = config.targets.map((target) => {
    const identity = readIdentity(target.crxPath, target.expectedUpstreamId)
    return stageRuntime({
      gateRoot: config.gateRoot,
      key: target.key,
      popup: target.popup,
      sourcePath: target.sourcePath,
      expectedId: target.expectedUpstreamId,
      identity
    })
  })
  return { config: Object.freeze({ ...config, targets: Object.freeze(targets) }), tls }
}

async function startGateRun(request, dependencies = {}) {
  const env = dependencies.env || process.env
  if (!request.exploratory) assertPrerequisites(request.mode, dependencies.history || loadPrerequisiteHistory(request.gateRoot))
  if (request.buildVast) {
    ;(dependencies.runChecked || runChecked)(process.execPath, [path.join(request.root, 'scripts', 'build-app.cjs')], {
      cwd: request.root,
      env: { ...env, VAST_RELEASE_CHANNEL: 'dev', VAST_DISTRIBUTION_CHANNEL: 'direct', VAST_PRIVATE_BUILD: '1', VAST_UPDATE_ENABLED: '0', VAST_OBFUSCATE: '0' }
    })
  }
  if (!fs.existsSync(path.join(request.root, 'out', 'main', 'main.js'))) {
    throw new Error('Built Vast main process is missing. Re-run with --build-vast explicitly.')
  }

  const prepared = (dependencies.prepareLiveRuntime || prepareLiveRuntime)(request, dependencies)
  const runId = request.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${request.mode}-${randomUUID().slice(0, 8)}`
  const runRoot = request.runRoot || path.join(request.gateRoot, 'runs', runId)
  const expectedHashes = request.exploratory === true
    ? exploratoryExpectedHashes()
    : (dependencies.loadExpectedHashes || loadExpectedHashes)(request.gateRoot, request.mode, env)
  const credentialReference = credentialReferenceSha256(expectedHashes)
  const remoteDebuggingPort = await (dependencies.availablePort || availablePort)()
  const config = Object.freeze({ ...prepared.config, remoteDebuggingPort,
    exploratory: request.exploratory === true, credentialConfigured: request.exploratory !== true })
  ;(dependencies.seedRegistry || seedExtensionRegistry)(config.profile, config.targets)
  const getFingerprint = dependencies.getFingerprint || (() => buildRuntimeFingerprint(config))
  const fingerprint = getFingerprint()
  const profilesRoot = path.join(request.gateRoot, 'profiles')
  const scenarios = Object.fromEntries(scenarioCatalog(request.mode).map((scenario) => [scenario.id, scenario]))
  let previousResult
  if (request.resume) {
    previousResult = readJson(path.join(runRoot, 'result.json'))
    const baseline = previousResult.runtimeFingerprints?.[0]
    if (!baseline || canonical(baseline) !== canonical(fingerprint)) {
      throw new Error('Runtime fingerprint changed since the stored run was created.')
    }
    if (previousResult.credentialReferenceSha256 !== credentialReference) {
      throw new Error('Controlled credential reference changed since the stored run was created.')
    }
  }
  const result = {
    ...(previousResult || {}),
    schemaVersion: 1,
    mode: request.mode,
    runId,
    status: 'running',
    exploratory: request.exploratory === true,
    credentialConfigured: request.exploratory !== true,
    credentialReferenceSha256: credentialReference,
    profilePaths: Object.fromEntries(['bitwarden', 'proton', 'combined'].map((mode) => [mode, path.join(profilesRoot, mode)])),
    extensions: config.targets.map(({ key, version, runtimeId }) => ({ key, version, runtimeId })),
    runtimeFingerprints: previousResult ? [...previousResult.runtimeFingerprints, fingerprint] : [fingerprint],
    scenarios: previousResult?.scenarios || scenarios,
    checkpoints: previousResult?.checkpoints || {},
    defects: previousResult?.defects || [],
    secretCanaryLeak: previousResult?.secretCanaryLeak
  }
  writeJsonAtomic(path.join(runRoot, 'result.json'), result)

  const Controller = dependencies.Controller || PasswordManagerGateController
  const eventsPath = path.join(runRoot, 'events.jsonl')
  const recordEvent = dependencies.recordEvent || createEventRecorder(eventsPath)
  const controller = new Controller({
    config,
    runId,
    tls: prepared.tls,
    expectedHashes,
    getFingerprint,
    acquireLock: dependencies.acquireLock || acquireProfileLock,
    createServer: dependencies.createServer || createFixtureServer,
    createObserver: dependencies.createObserver || (() => new RemoteTargetObserver({ port: remoteDebuggingPort, eventsPath, recordEvent })),
    capturePrivacyEvidence: dependencies.capturePrivacyEvidence || capturePrivacyEvidenceFromWorker,
    captureFixtureEvidence: dependencies.captureFixtureEvidence || captureFixtureSnapshotFromPage,
    onProcessDiagnostic: createRateLimitedDiagnosticRecorder(recordEvent,
      (event) => recordProcessFinding(path.join(runRoot, 'result.json'), event))
  })
  const child = await controller.run()
  writeJsonAtomic(path.join(runRoot, 'launcher.json'), {
    schemaVersion: 1,
    controllerPid: process.pid,
    electronPid: child.pid,
    runId,
    mode: request.mode,
    startedAt: new Date().toISOString()
  })

  let stopping = false
  let restarting = false
  let controlPolling = false
  let stopRequestTimer
  const stop = async () => {
    if (stopping) return
    stopping = true
    if (stopRequestTimer) clearInterval(stopRequestTimer)
    try { await controller.stop() } finally { fs.rmSync(path.join(runRoot, 'launcher.json'), { force: true }) }
  }
  const signalTarget = dependencies.signalTarget || process
  signalTarget.once('SIGINT', () => void stop())
  signalTarget.once('SIGTERM', () => void stop())
  const attachExit = (runningChild) => runningChild.once?.('exit', (exitCode, signal) => {
    if (stopping || restarting) return
    clearInterval(stopRequestTimer)
    controller.child = undefined
    void controller.stop().then(() => {
      controller.status(exitCode === 0 ? 'stopped' : 'failed', { exitCode, signal })
      fs.rmSync(path.join(runRoot, 'launcher.json'), { force: true })
      if (exitCode) process.exitCode = exitCode
    })
  })
  const restart = async () => {
    if (stopping || restarting) return
    restarting = true
    try {
      await controller.restart()
      writeJsonAtomic(path.join(runRoot, 'launcher.json'), {
        schemaVersion: 1, controllerPid: process.pid, electronPid: controller.child.pid,
        runId, mode: request.mode, startedAt: new Date().toISOString()
      })
      attachExit(controller.child)
    } finally { restarting = false }
  }
  attachExit(child)
  stopRequestTimer = setInterval(() => {
    if (controlPolling) return
    controlPolling = true
    void (async () => {
      if (await consumeStopRequest(runRoot, runId, process.pid, stop)) return
      if (!stopping && !restarting) await consumeRestartRequest(runRoot, runId, process.pid, restart)
    })().catch((error) => {
      writeJsonAtomic(path.join(runRoot, 'status.json'), {
        status: 'failed', at: new Date().toISOString(), errorClass: error?.name || 'Error'
      })
      process.exitCode = 1
      void stop()
    }).finally(() => { controlPolling = false })
  }, 250)
  stopRequestTimer.unref?.()
  return { status: 'running', runId, mode: request.mode, runRoot, controllerPid: process.pid, electronPid: child.pid, fixturePort: controller.server.port }
}

async function main() {
  const args = parseGateArgs(process.argv.slice(2), process.env)
  const tlsRoot = path.join(root, '.vast-build', 'password-manager-gates', 'tls')
  if (args.command === 'tls-setup') return powershell('setup-tls.ps1', ['-OutputDirectory', tlsRoot])
  if (args.command === 'tls-remove') return powershell('remove-tls.ps1', ['-OutputDirectory', tlsRoot])
  if (args.command === 'prepare') {
    const report = preparationReport(args, process.env)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!args.dryRun && !report.ready) process.exitCode = 1
    return
  }
  const result = await executeGateCommand(args)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (args.command === 'verify' && result.passed !== true) process.exitCode = 1
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1 })

module.exports = { assertProfileLockAvailable, checkEceRuntime, consumeRestartRequest, consumeStopRequest,
  createEventRecorder, createRateLimitedDiagnosticRecorder, executeGateCommand, main,
  preparationReport, resolveStoredRun, startGateRun }
