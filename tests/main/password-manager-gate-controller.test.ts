import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { captureFixtureSnapshotFromPage, capturePrivacyEvidenceFromWorker, createProcessDiagnosticSink,
  PasswordManagerGateController, seedExtensionRegistry } = require('../../scripts/password-manager-gate/controller.cjs')
const { PASSWORD_MANAGER_PRIVACY_KEYS, verifyGateResult, verifyPrivacyEvidence } = require('../../scripts/password-manager-gate/verify.cjs')
const { scenarioCatalog } = require('../../scripts/password-manager-gate/scenarios.cjs')
const { consumeRestartRequest, consumeStopRequest, createEventRecorder, createRateLimitedDiagnosticRecorder,
  executeGateCommand, preparationReport, startGateRun } = require('../../scripts/password-manager-gate.cjs')

test('process diagnostics retain ordered samples without unbounded event growth', () => {
  const events: any[] = []
  const findings: any[] = []
  let at = new Date('2026-09-22T12:00:00Z')
  const record = createRateLimitedDiagnosticRecorder(
    (event: unknown) => { events.push(event); return event },
    (event: unknown) => findings.push(event),
    () => at
  )
  for (let index = 0; index < 5000; index++) record({ stream: 'stderr', errorClass: 'MissingReceiver', payload: 'secret' })
  assert.deepEqual(events.map((event) => event.diagnosticCount),
    [...Array.from({ length: 16 }, (_, index) => index + 1), 32, 64, 128, 256, 512, 1024, 2048, 4096])
  assert.equal(findings.length, events.length)
  assert.equal(JSON.stringify(events).includes('secret'), false)
  at = new Date('2026-09-22T12:01:00Z')
  record({ stream: 'stderr', errorClass: 'MissingReceiver' })
  assert.equal(events.at(-1).diagnosticCount, 1)
})
const { fixtureHostResolverRules } = require('../../scripts/password-manager-gate/tls.cjs')

function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const launches: any[] = []
  const exits: any[] = []
  const states: string[] = []
  const diagnostics: any[] = []
  let fingerprint: any = { version: 1, binary: 'same' }
  let serverClosed = 0
  const serverRequests: unknown[] = []
  let observerStops = 0
  let restartSettles = 0
  const config = {
    root,
    gateRoot: join(root, '.vast-build', 'password-manager-gates'),
    mode: 'bitwarden',
    profile: join(root, '.vast-build', 'password-manager-gates', 'profiles', 'bitwarden'),
    fixturePort: 54443,
    electronExecutable: join(root, 'electron.exe'),
    patchedDist: root,
    targets: [{ key: 'bitwarden', runtimeId: 'nngceckbapebfimnlniiiahkandclblb' }]
  }
  const controller = new PasswordManagerGateController({
    config,
    runId: 'run-1',
    tls: { pfx: Buffer.from([1]), passphrase: 'not-serialized' },
    expectedHashes: { username: 'a'.repeat(64), password: 'b'.repeat(64) },
    getFingerprint: () => structuredClone(fingerprint),
    acquireLock: () => ({ path: 'lock', pid: process.pid, runId: 'run-1', release: () => undefined }),
    createServer: async (options: unknown) => {
      serverRequests.push(options)
      return ({
      port: 4443,
      origins: { 'login.vast-test.local': 'https://login.vast-test.local:4443' },
      close: async () => { serverClosed += 1 }
      })
    },
    createObserver: () => ({ start: async () => undefined, stop: async () => { observerStops += 1 } }),
    processAdapter: {
      launch: (command: string, args: string[], options: unknown) => {
        const child = { pid: 1000 + launches.length, stdout: new EventEmitter(), stderr: new EventEmitter() }
        launches.push({ command, args, ...(options as object), child })
        return child
      },
      gracefulExit: async (child: unknown) => { exits.push(child); return { event: 'electron-exited', exitCode: 0 } }
    },
    waitForRestartSettle: async () => { restartSettles += 1 },
    onStatus: (status: string) => states.push(status),
    onProcessDiagnostic: (event: unknown) => diagnostics.push(event)
  })
  return { controller, config, diagnostics, launches, exits, states, serverRequests,
    setFingerprint: (value: unknown) => { fingerprint = value },
    counts: () => ({ serverClosed, observerStops, restartSettles }), root }
}

test('Bitwarden verification accepts three controlled false settings without form data', () => {
  assert.deepEqual(PASSWORD_MANAGER_PRIVACY_KEYS, [
    'services.passwordSavingEnabled',
    'services.autofillAddressEnabled',
    'services.autofillCreditCardEnabled'
  ])
  const result = verifyPrivacyEvidence({
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    optionalPrivacyGranted: true,
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ]
  })

  assert.equal(result.passed, true)
  assert.doesNotMatch(JSON.stringify(result), /username|password|vault|token/i)
})

test('privacy verification rejects secret-bearing or query data without reflecting it', () => {
  const result = verifyPrivacyEvidence({
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    optionalPrivacyGranted: true,
    observedAt: '2026-09-21T00:00:00.000Z',
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ],
    vaultToken: 'VAST_GATE_SECRET_CANARY',
    url: 'https://login.vast-test.local/login?token=VAST_GATE_SECRET_CANARY#private'
  })

  assert.equal(result.passed, false)
  assert.doesNotMatch(JSON.stringify(result), /VAST_GATE_SECRET_CANARY/)
})

test('controller persists only sanitized privacy evidence from the extension worker', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-1' })}\n`)
  h.controller.now = () => new Date('2026-09-21T00:00:00.000Z')
  h.controller.capturePrivacyEvidence = async () => ({
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    optionalPrivacyGranted: true,
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ]
  })

  await h.controller.run()

  assert.equal((h.serverRequests[0] as { port: number }).port, 54443)

  const evidence = JSON.parse(readFileSync(join(runRoot, 'privacy-evidence-0.json'), 'utf8'))
  assert.deepEqual(evidence, {
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    optionalPrivacyGranted: true,
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ],
    observedAt: '2026-09-21T00:00:00.000Z'
  })
  assert.deepEqual(JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')).privacyEvidence, [evidence])
  assert.doesNotMatch(JSON.stringify(evidence), /VAST_GATE_SECRET_CANARY/)
})

test('privacy CDP probe selects only the matching extension service worker', async () => {
  const extensionId = 'nngceckbapebfimnlniiiahkandclblb'
  const expected = {
    extensionId,
    optionalPrivacyGranted: true,
    keys: [
      { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
      { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
    ]
  }
  const evaluated: string[] = []
  const connected: string[] = []
  let closed = 0

  const result = await capturePrivacyEvidenceFromWorker({
    port: 9223,
    extensionId,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js', webSocketDebuggerUrl: 'ws://wrong' },
        { type: 'service_worker', url: `chrome-extension://${extensionId}/background.js`, webSocketDebuggerUrl: 'ws://matching' }
      ]
    }),
    connect: async (url: string) => {
      connected.push(url)
      return {
        evaluate: async (expression: string) => { evaluated.push(expression); return expected },
        close: () => { closed += 1 }
      }
    }
  })

  assert.deepEqual(result, expected)
  assert.deepEqual(connected, ['ws://matching'])
  assert.equal(evaluated.length, 1)
  assert.match(evaluated[0], /permissions\.getAll/)
  assert.match(evaluated[0], /passwordSavingEnabled/)
  assert.match(evaluated[0], /autofillAddressEnabled/)
  assert.match(evaluated[0], /autofillCreditCardEnabled/)
  assert.equal(closed, 1)
})

test('fixture CDP probe evaluates only the approved snapshot on an approved HTTPS webview', async () => {
  const snapshot = {
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: true, passwordPresent: true,
    usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
    unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
  }
  const expressions: string[] = []
  const connected: string[] = []
  let closed = 0
  const result = await captureFixtureSnapshotFromPage({
    port: 9223,
    fetchImpl: async () => ({ ok: true, json: async () => [
      { type: 'webview', url: 'https://unlisted.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://wrong' },
      { type: 'service_worker', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://worker' },
      { type: 'webview', url: 'https://login.vast-test.local:4443/login?token=secret', webSocketDebuggerUrl: 'ws://right' }
    ] }),
    connect: async (url: string) => {
      connected.push(url)
      return { evaluate: async (expression: string) => { expressions.push(expression); return { ...snapshot, password: 'must-not-leak' } }, close: () => { closed += 1 } }
    }
  })
  assert.deepEqual(result, snapshot)
  assert.deepEqual(connected, ['ws://right'])
  assert.deepEqual(expressions, ['window.__vastGate.snapshot()'])
  assert.equal(closed, 1)
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|token=secret/)
})

test('controller persists only changed safe fixture snapshots without credential contents', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-1' })}\n`)
  const snapshot = {
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: false, passwordPresent: false,
    usernameMatchesExpectedHash: false, passwordMatchesExpectedHash: false,
    unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
  }
  h.controller.captureFixtureEvidence = async () => snapshot
  await h.controller.run()
  assert.equal(await h.controller.captureFixtureCheckpoint(), false)
  snapshot.usernamePresent = true
  snapshot.usernameMatchesExpectedHash = true
  assert.equal(await h.controller.captureFixtureCheckpoint(), true)
  const saved = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(saved.fixtureEvidence.length, 2)
  assert.equal(saved.fixtureEvidence[1].id, 'fixture-evidence-1')
  assert.equal(saved.fixtureEvidence[1].snapshot.usernameMatchesExpectedHash, true)
  assert.doesNotMatch(JSON.stringify(saved.fixtureEvidence), /password:|must-not-leak|token=/i)
})

test('controller links an observed matching fixture to hash scenarios, not autofill approval', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({
    mode: 'bitwarden', runId: 'run-1',
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario]))
  })}\n`)
  h.controller.captureFixtureEvidence = async () => ({
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: true, passwordPresent: true,
    usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
    unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
  })
  assert.equal(await h.controller.captureFixtureCheckpoint(), true)
  const result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(result.scenarios['username-hash-match'].status, 'pass')
  assert.equal(result.scenarios['password-hash-match'].status, 'pass')
  assert.equal(result.scenarios['manual-autofill'].status, 'blocked')
})

test('fixture checkpoint recovers a validated orphan artifact after interrupted result write', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', fixtureEvidence: [] })}\n`)
  const snapshot = {
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: false, passwordPresent: false,
    usernameMatchesExpectedHash: false, passwordMatchesExpectedHash: false,
    unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
  }
  const orphan = { id: 'fixture-evidence-0', observedAt: '2026-09-21T00:00:00.000Z', snapshot }
  writeFileSync(join(runRoot, 'fixture-evidence-0.json'), `${JSON.stringify(orphan)}\n`)
  h.controller.captureFixtureEvidence = async () => ({ ...snapshot, usernamePresent: true })
  assert.equal(await h.controller.captureFixtureCheckpoint(), true)
  let result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.deepEqual(result.fixtureEvidence, [orphan])
  assert.equal(await h.controller.captureFixtureCheckpoint(), true)
  result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(result.fixtureEvidence.length, 2)
  assert.equal(result.fixtureEvidence[1].snapshot.usernamePresent, true)
})

test('fixture checkpoint refuses an orphan artifact with extra secret-bearing fields', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', fixtureEvidence: [] })}\n`)
  const snapshot = {
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: false, passwordPresent: false,
    usernameMatchesExpectedHash: false, passwordMatchesExpectedHash: false,
    unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
  }
  writeFileSync(join(runRoot, 'fixture-evidence-0.json'), `${JSON.stringify({ id: 'fixture-evidence-0', observedAt: '2026-09-21T00:00:00.000Z', snapshot: { ...snapshot, password: 'must-not-leak' } })}\n`)
  h.controller.captureFixtureEvidence = async () => snapshot
  await assert.rejects(h.controller.captureFixtureCheckpoint(), /orphan fixture evidence/i)
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')).fixtureEvidence.length, 0)
})

test('controller retries privacy observation until a safe checkpoint is captured', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-1' })}\n`)
  const callbacks: Array<() => Promise<unknown>> = []
  const cleared: unknown[] = []
  let attempts = 0
  h.controller.setIntervalFn = (callback: () => Promise<unknown>) => { callbacks.push(callback); return 77 }
  h.controller.clearIntervalFn = (handle: unknown) => { cleared.push(handle) }
  h.controller.capturePrivacyEvidence = async () => {
    attempts += 1
    if (attempts === 1) return undefined
    return {
      extensionId: 'nngceckbapebfimnlniiiahkandclblb',
      optionalPrivacyGranted: true,
      keys: [
        { key: 'services.passwordSavingEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
        { key: 'services.autofillAddressEnabled', value: false, levelOfControl: 'controlled_by_this_extension' },
        { key: 'services.autofillCreditCardEnabled', value: false, levelOfControl: 'controlled_by_this_extension' }
      ]
    }
  }

  await h.controller.run()
  assert.equal(attempts, 1)
  assert.equal(callbacks.length, 1)
  await callbacks[0]()

  assert.equal(attempts, 2)
  assert.deepEqual(cleared, [77])
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')).privacyEvidence.length, 1)
})

test('launch uses one resolver rule, patched Electron, isolated profile and no security bypass', async (t) => {
  const h = harness(t)
  await h.controller.run()
  assert.equal(h.launches.length, 1)
  const launch = h.launches[0]
  assert.equal(launch.command, h.config.electronExecutable)
  assert.deepEqual(launch.args.filter((arg: string) => arg.startsWith('--host-resolver-rules=')), [`--host-resolver-rules=${fixtureHostResolverRules()}`])
  assert.equal(launch.args.some((arg: string) => /ignore-certificate-errors|disable-web-security|certificate-error/i.test(arg)), false)
  assert.equal(launch.env.VAST_DEV_USER_DATA_DIR, h.config.profile)
  assert.equal(launch.env.VAST_RELAY_ENABLED, '0')
  assert.equal(launch.env.VAST_EXTENSION_COMPATIBILITY, '1')
  assert.equal(launch.windowsHide, false)
  assert.deepEqual(h.states, ['preparing', 'running'])
  const command = JSON.parse(readFileSync(join(h.root, '.vast-build/password-manager-gates/runs/run-1/command.json'), 'utf8'))
  assert.equal(JSON.stringify(command).includes('not-serialized'), false)
  assert.match(command.credentialReferenceSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(command).includes('a'.repeat(64)), false)
})

test('restart requires electron-exited, preserves profile and rejects fingerprint drift', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', status: 'running',
    runtimeFingerprints: [{ version: 1, binary: 'same' }],
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario])) })}\n`)
  await h.controller.run()
  await h.controller.restart()
  assert.equal(h.launches.length, 2)
  assert.equal(h.launches[0].env.VAST_DEV_USER_DATA_DIR, h.launches[1].env.VAST_DEV_USER_DATA_DIR)
  assert.equal(h.exits.length, 1)
  assert.equal(h.counts().restartSettles, 1)
  const result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(result.runtimeFingerprints.length, 2)
  assert.equal(result.scenarios['vast-restart'].status, 'pass')
  assert.equal(result.restartEvidence[0].profilePreserved, true)
  assert.equal(result.restartEvidence[0].previousPid, 1000)
  assert.equal(result.restartEvidence[0].newPid, 1001)

  h.setFingerprint({ version: 2, binary: 'changed' })
  await assert.rejects(h.controller.restart(), /fingerprint changed/i)
  assert.equal(h.launches.length, 2)
})

test('restart fails closed when graceful shutdown lacks electron-exited evidence', async (t) => {
  const h = harness(t)
  h.controller.processAdapter.gracefulExit = async () => ({ event: 'timeout' })
  await h.controller.run()
  await assert.rejects(h.controller.restart(), /electron-exited/i)
  assert.equal(h.launches.length, 1)
})

test('stop closes observer and server, records terminal state and releases only once', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', status: 'running', scenarios: {} })}\n`)
  let releases = 0
  h.controller.acquireLock = () => ({ path: 'lock', pid: process.pid, runId: 'run-1', release: () => { releases += 1 } })
  await h.controller.run()
  await h.controller.stop()
  await h.controller.stop()
  assert.deepEqual(h.counts(), { serverClosed: 1, observerStops: 1, restartSettles: 0 })
  assert.equal(releases, 1)
  assert.equal(h.states.at(-1), 'stopped')
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')).status, 'stopped')
})

test('failed gate state is not overwritten by later cleanup', async (t) => {
  const h = harness(t)
  const runRoot = join(h.config.gateRoot, 'runs', 'run-1')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', status: 'running', scenarios: {} })}\n`)
  await h.controller.run()
  h.controller.status('failed', { errorClass: 'ProcessCrash' })
  await h.controller.stop()
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')).status, 'failed')
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'status.json'), 'utf8')).status, 'failed')
})

test('controller never builds implicitly and rejects target sets outside the selected mode', async (t) => {
  const h = harness(t)
  h.config.targets.push({ key: 'protonpass', runtimeId: 'ghmbeldphafepmbegfdlkpapadhbakde' })
  await assert.rejects(h.controller.run(), /target set/i)
  assert.equal(h.launches.length, 0)
})

test('Electron output is drained but only diagnostic classes reach the event sink', async (t) => {
  const h = harness(t)
  await h.controller.run()
  const child = h.launches[0].child
  child.stderr.emit('data', Buffer.from('Could not establish connection. Receiving end does not exist https://auth.test/callback?token=VAST_GATE_SECRET_CANARY\n'))
  child.stdout.emit('data', Buffer.from('ordinary startup line VAST_GATE_SECRET_CANARY\n'))

  assert.deepEqual(h.diagnostics, [{ stream: 'stderr', errorClass: 'MissingReceiver' }])
  assert.equal(JSON.stringify(h.diagnostics).includes('VAST_GATE_SECRET_CANARY'), false)
})

test('diagnostic sink frames fragmented and multiple lines without retaining payload text', () => {
  const events: Array<{ stream: string; errorClass: string }> = []
  const sink = createProcessDiagnosticSink((event: { stream: string; errorClass: string }) => events.push(event))
  sink.push('stderr', Buffer.from('Receiving end does not'))
  sink.push('stderr', Buffer.from(' exist secret=DO_NOT_RECORD\nReceiving end does not exist\n'))
  sink.push('stdout', Buffer.from('runtime.lastError secret=DO_NOT_RECORD'))
  sink.flush('stdout')
  assert.deepEqual(events, [
    { stream: 'stderr', errorClass: 'MissingReceiver' },
    { stream: 'stderr', errorClass: 'MissingReceiver' },
    { stream: 'stdout', errorClass: 'RuntimeLastError' }
  ])
  assert.equal(JSON.stringify(events).includes('DO_NOT_RECORD'), false)
})

test('diagnostic sink reports only concrete process-crash signatures', () => {
  const classify = (line: string) => {
    const events: Array<{ stream: string; errorClass: string }> = []
    const sink = createProcessDiagnosticSink((event: { stream: string; errorClass: string }) => events.push(event))
    sink.push('stderr', Buffer.from(`${line}\n`))
    return events
  }

  assert.deepEqual(classify('Crashpad handler is not connected'), [])
  assert.deepEqual(classify('Native messaging host crashed unexpectedly'), [])
  assert.deepEqual(classify('Renderer process crashed'), [
    { stream: 'stderr', errorClass: 'ProcessCrash' }
  ])
  assert.deepEqual(classify('[1234:5678:0924/101112.000:FATAL:render_process_host_impl.cc(100)] fatal failure'), [
    { stream: 'stderr', errorClass: 'ProcessCrash' }
  ])
})

test('missing receiver diagnostics retain routing metadata without message payloads', () => {
  const events: any[] = []
  const sink = createProcessDiagnosticSink((event: unknown) => events.push(event))
  sink.push('stderr', Buffer.from(
    '[VastCompat] Receiving end does not exist method=tabs.sendMessage extension=nngceckbapebfimnlniiiahkandclblb sender=service_worker receiver=tab_frame tab=17 frame=3 payload=DO_NOT_RECORD\n'
  ))
  assert.deepEqual(events, [{
    stream: 'stderr', errorClass: 'MissingReceiver', apiMethod: 'tabs.sendMessage',
    extensionId: 'nngceckbapebfimnlniiiahkandclblb', contextType: 'service_worker',
    receiverContext: 'tab_frame', tabId: 17, frameId: 3
  }])
  assert.equal(JSON.stringify(events).includes('DO_NOT_RECORD'), false)
})

test('background launcher records command, PID, log and status paths without hiding Electron', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/password-manager-gate/start-background.ps1'), 'utf8')
  assert.match(source, /controllerPid/)
  assert.match(source, /process\.log/)
  assert.match(source, /exit-code/)
  assert.match(source, /Remove-Item\s+-LiteralPath\s+\$ExitCodePath\s+-Force\s+-ErrorAction\s+SilentlyContinue/i)
  assert.match(source, /WindowStyle\s+Hidden/i)
  assert.match(source, /already running|live profile lock/i)
  assert.doesNotMatch(source, /electron\.exe.*WindowStyle\s+Hidden/is)
})

test('test credential window creates only a new hash candidate after explicit isolated-vault confirmation', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/password-manager-gate/create-test-credential.ps1'), 'utf8')
  assert.match(source, /RandomNumberGenerator/)
  assert.match(source, /UseSystemPasswordChar\s*=\s*\$true/)
  assert.match(source, /usernameSha256\s*=\s*Get-Sha256Hex/)
  assert.match(source, /passwordSha256\s*=\s*Get-Sha256Hex/)
  assert.match(source, /FileMode\]::CreateNew/)
  assert.match(source, /\$script:confirmedBox\.Checked/)
  assert.match(source, /candidate-/)
  assert.match(source, /pending-/)
  assert.match(source, /Move-Item -LiteralPath \$script:pendingPath -Destination \$script:candidatePath/)
  assert.match(source, /Remove-Item -LiteralPath \$script:pendingPath -Force/)
  assert.doesNotMatch(source, /VAST_GATE_USERNAME_SHA256|VAST_GATE_PASSWORD_SHA256/)
})

test('password update window retains only the existing username hash and new password hash', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/password-manager-gate/create-test-password-update.ps1'), 'utf8')
  assert.match(source, /ExistingCredentialHashFile/)
  assert.match(source, /usernameSha256\s*=\s*\$Existing\.usernameSha256/)
  assert.match(source, /passwordSha256\s*=\s*Get-Sha256Hex \$script:passwordValue/)
  assert.match(source, /RandomNumberGenerator/)
  assert.match(source, /FileMode\]::CreateNew/)
  assert.match(source, /update-candidate-/)
  assert.doesNotMatch(source, /Write-(Host|Verbose|Debug).*passwordValue/i)
})

test('package scripts expose the gate and verifier entry points', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['extension:compat:password-gate'], 'node scripts/password-manager-gate.cjs')
  assert.equal(pkg.scripts['extension:compat:password-gate:verify'], 'node scripts/password-manager-gate.cjs verify')
})

test('prepare fails closed when the pinned ECE runtime check fails', () => {
  const report = preparationReport(
    { command: 'prepare', mode: 'bitwarden', dryRun: true, buildVast: false },
    {},
    {
      resolveConfig: () => ({
        gateRoot: 'gate-root',
        profile: 'profile',
        electronExecutable: 'electron.exe',
        targets: []
      }),
      ensureTls: () => ({ pfx: Buffer.from([1]), passphrase: 'secret' }),
      checkEce: () => { throw new Error('ECE development patch is missing') }
    }
  )

  assert.equal(report.ready, false)
  assert.match(report.errors[0].message, /ECE development patch is missing/)
  assert.equal(JSON.stringify(report).includes('secret'), false)
})

test('prepare stages only the target whose CRX identity was verified', () => {
  const staged: any[] = []
  const target = {
    key: 'protonpass',
    popup: 'popup.html',
    sourcePath: 'proton-source',
    crxPath: 'proton.crx',
    expectedUpstreamId: 'ghmbeldphafepmbegfdlkpapadhbakde'
  }
  const report = preparationReport(
    { command: 'prepare', mode: 'proton', dryRun: true, buildVast: false },
    {},
    {
      resolveConfig: () => ({
        gateRoot: 'gate-root',
        profile: 'profile',
        electronExecutable: 'electron.exe',
        targets: [target]
      }),
      ensureTls: () => ({ pfx: Buffer.from([1]), passphrase: 'secret' }),
      checkEce: () => undefined,
      history: { bitwarden: 'pass' },
      readIdentity: () => ({
        extensionId: target.expectedUpstreamId,
        manifestKey: 'public-key',
        crxSha256: 'a'.repeat(64)
      }),
      stageRuntime: (options: unknown) => {
        staged.push(options)
        return { key: 'protonpass', runtimeId: target.expectedUpstreamId, runtimePath: 'staged-proton' }
      }
    }
  )

  assert.equal(report.ready, true)
  assert.equal(staged.length, 1)
  assert.equal(staged[0].expectedId, target.expectedUpstreamId)
  assert.deepEqual(report.checks.at(-1), {
    name: 'protonpass-runtime',
    runtimeId: target.expectedUpstreamId,
    path: 'staged-proton'
  })
  assert.equal(JSON.stringify(report).includes('public-key'), false)
})

test('prepare fails closed for a live profile lock and an unmet predecessor gate', () => {
  const baseDependencies = {
    resolveConfig: () => ({
      gateRoot: 'gate-root',
      profile: 'profile',
      electronExecutable: 'electron.exe',
      targets: []
    }),
    ensureTls: () => ({ pfx: Buffer.from([1]), passphrase: 'secret' }),
    checkEce: () => undefined
  }
  const locked = preparationReport(
    { command: 'prepare', mode: 'bitwarden', dryRun: true, buildVast: false },
    {},
    { ...baseDependencies, checkProfileLock: () => { throw new Error('profile already owned by live PID 77') } }
  )
  assert.equal(locked.ready, false)
  assert.match(locked.errors[0].message, /already owned by live PID 77/)

  const predecessor = preparationReport(
    { command: 'prepare', mode: 'proton', dryRun: true, buildVast: false },
    {},
    { ...baseDependencies, checkProfileLock: () => undefined, history: {} }
  )
  assert.equal(predecessor.ready, false)
  assert.match(predecessor.errors[0].message, /Gate 1.*must pass/)
  assert.deepEqual(predecessor.checks.find((check: { name: string }) => check.name === 'profile'),
    { name: 'profile', path: 'profile' })
})

test('exploratory preparation bypasses only predecessor readiness and can never verify', () => {
  const report = preparationReport(
    { command: 'prepare', mode: 'proton', dryRun: true, buildVast: false, exploratory: true },
    {},
    {
      resolveConfig: () => ({ gateRoot: 'gate-root', profile: 'profile',
        electronExecutable: 'electron.exe', targets: [] }),
      ensureTls: () => ({ pfx: Buffer.from([1]), passphrase: 'secret' }),
      checkEce: () => undefined,
      checkProfileLock: () => undefined,
      history: {}
    }
  )
  assert.equal(report.ready, true)
  assert.deepEqual(report.checks[0], { name: 'gate-prerequisites', status: 'bypassed-exploratory' })
  assert.match(verifyGateResult({ mode: 'proton', exploratory: true }).failures.join(' '),
    /exploratory runs cannot satisfy/i)
})

test('status and verify commands read persistent run artifacts without launching Electron', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'run-17')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-17' })}\n`)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'running', electronPid: 8123 })}\n`)
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', scenarios: {} })}\n`)

  const status = await executeGateCommand(
    { command: 'status', mode: 'bitwarden', runId: 'run-17', dryRun: false, buildVast: false },
    { root, gateRoot }
  )
  assert.deepEqual(status, { status: 'running', electronPid: 8123 })

  const verification = await executeGateCommand(
    { command: 'verify', mode: 'bitwarden', runId: 'run-17', dryRun: false, buildVast: false },
    { root, gateRoot }
  )
  assert.equal(verification.passed, false)
  assert.match(verification.failures.join('\n'), /Required scenario login is missing/)
})

test('registry seeding preserves unrelated extensions and existing permission grants', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-registry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const registryPath = join(profile, 'Extensions', 'registry.json')
  mkdirSync(join(profile, 'Extensions'), { recursive: true })
  const existing = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Existing extension',
    version: '1.0.0',
    path: join(root, 'existing'),
    enabled: true,
    source: 'unpacked',
    trust: 'developer',
    updateState: 'not-applicable',
    runtime: 'chrome',
    manifestVersion: 3,
    installedAt: 1,
    updatedAt: 1,
    allowFileAccess: false,
    grantedPermissions: [],
    grantedChromePermissions: ['notifications'],
    grantedChromeOrigins: ['https://example.test/*']
  }
  writeFileSync(registryPath, `${JSON.stringify({ schemaVersion: 6, extensions: [existing] })}\n`)

  const targetPath = join(root, 'bitwarden-runtime')
  const target = {
    key: 'bitwarden',
    runtimeId: 'nngceckbapebfimnlniiiahkandclblb',
    runtimePath: targetPath,
    version: '2026.8.0',
    manifest: { manifest_version: 3, name: 'Bitwarden', description: 'Password manager' }
  }
  seedExtensionRegistry(profile, [target])
  let registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  assert.equal(registry.extensions.length, 2)
  assert.deepEqual(registry.extensions[0].grantedChromePermissions, ['notifications'])
  assert.deepEqual(registry.extensions[0].grantedChromeOrigins, ['https://example.test/*'])
  assert.equal(registry.extensions[1].runtimeExtensionId, target.runtimeId)
  assert.equal(registry.extensions[1].upstreamExtensionId, target.runtimeId)
  assert.equal(registry.extensions[1].path, targetPath)

  registry.extensions[1].grantedChromePermissions = ['alarms']
  writeFileSync(registryPath, `${JSON.stringify(registry)}\n`)
  seedExtensionRegistry(profile, [target])
  registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  assert.deepEqual(registry.extensions[1].grantedChromePermissions, ['alarms'])
})

test('stop targets only the controller PID recorded for the selected run', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'run-stop')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-stop' })}\n`)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'running' })}\n`)
  writeFileSync(join(runRoot, 'launcher.json'), `${JSON.stringify({ controllerPid: 54321, runId: 'run-stop' })}\n`)
  const signaled: Array<{ pid: number, signal: string }> = []

  const result = await executeGateCommand(
    { command: 'stop', mode: 'bitwarden', runId: 'run-stop', dryRun: false, buildVast: false },
    {
      root,
      gateRoot,
      pidIsLive: (pid: number) => pid === 54321,
      signalProcess: (pid: number, signal: string) => { signaled.push({ pid, signal }) }
    }
  )

  assert.deepEqual(signaled, [])
  assert.equal(result.status, 'stop-requested')
  assert.equal(JSON.parse(readFileSync(join(runRoot, 'status.json'), 'utf8')).status, 'stop-requested')
  assert.deepEqual(JSON.parse(readFileSync(join(runRoot, 'stop-request.json'), 'utf8')), {
    schemaVersion: 1,
    runId: 'run-stop',
    controllerPid: 54321,
    requestedAt: result.at
  })
})

test('controller consumes only its own stop request and can finish graceful cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-stop-request-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requestPath = join(root, 'stop-request.json')
  let stopped = 0
  writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, runId: 'other', controllerPid: 42, requestedAt: new Date().toISOString() }))
  assert.equal(await consumeStopRequest(root, 'run-stop', 42, async () => { stopped += 1 }), false)
  assert.equal(stopped, 0)
  writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, runId: 'run-stop', controllerPid: 42, requestedAt: new Date().toISOString() }))
  assert.equal(await consumeStopRequest(root, 'run-stop', 42, async () => { stopped += 1 }), true)
  assert.equal(stopped, 1)
  assert.equal(existsSync(requestPath), false)
})

test('controller consumes only its own restart request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-restart-request-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requestPath = join(root, 'restart-request.json')
  let restarted = 0
  writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, runId: 'other', controllerPid: 42, requestedAt: new Date().toISOString() }))
  assert.equal(await consumeRestartRequest(root, 'run-restart', 42, async () => { restarted += 1 }), false)
  assert.equal(restarted, 0)
  writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, runId: 'run-restart', controllerPid: 42, requestedAt: new Date().toISOString() }))
  assert.equal(await consumeRestartRequest(root, 'run-restart', 42, async () => { restarted += 1 }), true)
  assert.equal(restarted, 1)
  assert.equal(existsSync(requestPath), false)
})

test('manual autofill confirmation binds operator checkpoint to a stopped run and matching fixture artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-autofill-confirm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'run-autofill')
  mkdirSync(runRoot, { recursive: true })
  const reference = 'a'.repeat(64)
  const evidence = {
    id: 'fixture-evidence-0', observedAt: '2026-09-21T10:00:00.000Z',
    snapshot: {
      fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
      usernamePresent: true, passwordPresent: true,
      usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
      unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
    }
  }
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-autofill', credentialReferenceSha256: reference })}\n`)
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-autofill', status: 'stopped',
    credentialReferenceSha256: reference,
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario])),
    fixtureEvidence: [evidence], checkpoints: {}
  })}\n`)
  writeFileSync(join(runRoot, 'fixture-evidence-0.json'), `${JSON.stringify(evidence)}\n`)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'running' })}\n`)
  const args = { command: 'confirm-autofill', mode: 'bitwarden', runId: 'run-autofill', operatorConfirmed: true, dryRun: false, buildVast: false }
  await assert.rejects(() => executeGateCommand(args, { root, gateRoot }), /stopped run/i)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'stopped' })}\n`)
  await assert.rejects(() => executeGateCommand({ ...args, operatorConfirmed: false }, { root, gateRoot }), /operator confirmation/i)
  const confirmed = await executeGateCommand(args, { root, gateRoot })
  assert.deepEqual({ status: confirmed.status, evidenceId: confirmed.evidenceId }, { status: 'pass', evidenceId: evidence.id })
  const result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(result.scenarios['manual-autofill'].status, 'pass')
  assert.deepEqual(result.scenarios['manual-autofill'].machineEvidence, [evidence.id])
  assert.equal(result.checkpoints['manual-autofill-completed'].machineEvidenceId, evidence.id)
  await executeGateCommand(args, { root, gateRoot })
  assert.equal(readFileSync(join(runRoot, 'checkpoints.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1)
  assert.equal(readFileSync(join(runRoot, 'result.json'), 'utf8').includes('must-not-leak'), false)
  writeFileSync(join(runRoot, 'fixture-evidence-0.json'), `${JSON.stringify({ ...evidence, observedAt: '2026-09-21T10:01:00.000Z' })}\n`)
  await assert.rejects(() => executeGateCommand(args, { root, gateRoot }), /artifact/i)
  assert.equal(readFileSync(join(runRoot, 'checkpoints.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1)
})

test('Bitwarden suggestion confirmation requires its inline-list event and a nearby matching fill', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-suggestion-confirm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'run-suggestion')
  mkdirSync(runRoot, { recursive: true })
  const extensionId = 'nngceckbapebfimnlniiiahkandclblb'
  const evidence = {
    id: 'fixture-evidence-0', observedAt: '2026-09-21T10:00:02.000Z',
    snapshot: {
      fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
      usernamePresent: true, passwordPresent: true,
      usernameMatchesExpectedHash: true, passwordMatchesExpectedHash: true,
      unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false
    }
  }
  const event = { sequence: 7, at: '2026-09-21T10:00:01.000Z', event: 'target-created',
    contextType: 'iframe', url: `chrome-extension://${extensionId}/overlay/menu-list.html`, lifecycleState: 'active' }
  const command = { mode: 'bitwarden', runId: 'run-suggestion', credentialReferenceSha256: 'a'.repeat(64) }
  const result = { ...command, status: 'stopped', extensions: [{ key: 'bitwarden', runtimeId: extensionId }],
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario])),
    fixtureEvidence: [evidence], checkpoints: {} }
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify(command)}\n`)
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify(result)}\n`)
  writeFileSync(join(runRoot, 'fixture-evidence-0.json'), `${JSON.stringify(evidence)}\n`)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'stopped' })}\n`)
  writeFileSync(join(runRoot, 'events.jsonl'), `${JSON.stringify({ ...event, url: 'chrome-extension://wrong/overlay/menu-list.html' })}\n`)
  const args = { command: 'confirm-suggestion', mode: 'bitwarden', runId: 'run-suggestion', operatorConfirmed: true, dryRun: false, buildVast: false }
  await assert.rejects(() => executeGateCommand(args, { root, gateRoot }), /No Bitwarden inline-list/i)
  writeFileSync(join(runRoot, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  await assert.rejects(() => executeGateCommand({ ...args, operatorConfirmed: false }, { root, gateRoot }), /operator confirmation/i)
  const confirmed = await executeGateCommand(args, { root, gateRoot })
  assert.equal(confirmed.evidenceId, 'suggestion-evidence-0')
  const updated = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(updated.scenarios['credential-suggestion'].status, 'pass')
  assert.equal(updated.suggestionEvidence.fixtureEvidenceId, evidence.id)
  assert.equal(updated.checkpoints['controlled-credential-selected'].machineEvidenceId, 'suggestion-evidence-0')
  await executeGateCommand(args, { root, gateRoot })
  assert.equal(readFileSync(join(runRoot, 'checkpoints.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1)
  assert.equal(readFileSync(join(runRoot, 'suggestion-evidence-0.json'), 'utf8').includes('password'), false)
})

test('extension reload recording binds a stopped run to a safe manager/worker artifact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-reload-record-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'run-reload')
  mkdirSync(runRoot, { recursive: true })
  const id = 'nngceckbapebfimnlniiiahkandclblb'
  const artifact = { schemaVersion: 1, runId: 'run-reload', mode: 'bitwarden',
    observedAt: '2026-09-21T10:00:00.000Z', extensionId: id,
    apiOk: true, identityPreserved: true, enabled: true, workerRecreated: true,
    privacyRecovered: true, outcome: 'reload-and-worker-recovered' }
  const artifactPath = join(runRoot, 'extension-reload-probe-1000-abcdef01.json')
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-reload' })}\n`)
  writeFileSync(join(runRoot, 'status.json'), `${JSON.stringify({ status: 'stopped' })}\n`)
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'run-reload',
    status: 'stopped', extensions: [{ key: 'bitwarden', runtimeId: id }],
    scenarios: Object.fromEntries(scenarioCatalog('bitwarden').map((scenario: { id: string }) => [scenario.id, scenario])) })}\n`)
  writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`)
  const args = { command: 'record-reload', mode: 'bitwarden', runId: 'run-reload', dryRun: false, buildVast: false }
  const recorded = await executeGateCommand(args, { root, gateRoot })
  assert.equal(recorded.status, 'pass')
  const result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8'))
  assert.equal(result.scenarios['extension-reload'].status, 'pass')
  assert.deepEqual(result.scenarios['extension-reload'].machineEvidence, ['extension-reload-probe-1000-abcdef01'])
  await executeGateCommand(args, { root, gateRoot })
  writeFileSync(artifactPath, `${JSON.stringify({ ...artifact, password: 'must-not-leak' })}\n`)
  await assert.rejects(() => executeGateCommand(args, { root, gateRoot }), /safe schema/i)
})

test('resumed event recorder continues sequence numbers instead of restarting at zero', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-event-sequence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const eventsPath = join(root, 'events.jsonl')
  writeFileSync(eventsPath, `${JSON.stringify({ sequence: 17, at: new Date().toISOString(), event: 'target-destroyed' })}\n`)
  const record = createEventRecorder(eventsPath)
  const event = record({ event: 'target-created' })
  assert.equal(event.sequence, 18)
  assert.deepEqual(readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line).sequence), [17, 18])
})

test('run creates a fresh run while resume reuses the selected run identity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-run-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'existing-run')
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(runRoot, 'command.json'), `${JSON.stringify({ mode: 'bitwarden', runId: 'existing-run' })}\n`)
  const starts: any[] = []
  const startGate = async (request: unknown) => {
    starts.push(request)
    return { status: 'running', runId: (request as any).runId || 'fresh-run' }
  }

  const fresh = await executeGateCommand(
    { command: 'run', mode: 'bitwarden', dryRun: false, buildVast: false },
    { root, gateRoot, startGate }
  )
  const resumed = await executeGateCommand(
    { command: 'resume', mode: 'bitwarden', runId: 'existing-run', dryRun: false, buildVast: false },
    { root, gateRoot, startGate }
  )

  assert.deepEqual(fresh, { status: 'running', runId: 'fresh-run' })
  assert.deepEqual(resumed, { status: 'running', runId: 'existing-run' })
  assert.equal(starts[0].resume, false)
  assert.equal(starts[0].mode, 'bitwarden')
  assert.equal(starts[1].resume, true)
  assert.equal(starts[1].runId, 'existing-run')
})

test('resume rejects runtime fingerprint drift before launching Electron', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-resume-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'resume-run')
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'main.js'), 'built fixture\n')
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({
    mode: 'bitwarden',
    runId: 'resume-run',
    runtimeFingerprints: [{ schemaVersion: 1, electronExecutableSha256: 'before' }]
  })}\n`)
  let launches = 0

  await assert.rejects(() => startGateRun(
    {
      command: 'resume',
      mode: 'bitwarden',
      runId: 'resume-run',
      runRoot,
      gateRoot,
      root,
      resume: true,
      buildVast: false
    },
    {
      history: {},
      prepareLiveRuntime: () => ({
        config: {
          root,
          gateRoot,
          profile: join(gateRoot, 'profiles', 'bitwarden'),
          mode: 'bitwarden',
          patchedDist: root,
          electronExecutable: join(root, 'electron.exe'),
          targets: [{ key: 'bitwarden', version: '2026.8.0', runtimeId: 'nngceckbapebfimnlniiiahkandclblb' }]
        },
        tls: { pfx: Buffer.from([1]), passphrase: 'secret' }
      }),
      loadExpectedHashes: () => ({ username: 'a'.repeat(64), password: 'b'.repeat(64) }),
      availablePort: async () => 9223,
      seedRegistry: () => undefined,
      getFingerprint: () => ({ schemaVersion: 1, electronExecutableSha256: 'after' }),
      Controller: class {
        async run() { launches += 1; return { pid: 9999 } }
      }
    }
  ), /fingerprint changed/i)
  assert.equal(launches, 0)
})

test('resume refuses a different controlled credential reference before launching Electron', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-credential-reference-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  const runRoot = join(gateRoot, 'runs', 'resume-run')
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'main.js'), 'built fixture\n')
  writeFileSync(join(runRoot, 'result.json'), `${JSON.stringify({
    mode: 'bitwarden', runId: 'resume-run',
    runtimeFingerprints: [{ schemaVersion: 1, electronExecutableSha256: 'same' }],
    credentialReferenceSha256: 'a'.repeat(64)
  })}\n`)
  let launches = 0
  await assert.rejects(() => startGateRun({
    command: 'resume', mode: 'bitwarden', runId: 'resume-run', runRoot, gateRoot, root,
    resume: true, buildVast: false
  }, {
    history: {},
    prepareLiveRuntime: () => ({
      config: { root, gateRoot, profile: join(gateRoot, 'profiles', 'bitwarden'), mode: 'bitwarden',
        patchedDist: root, electronExecutable: join(root, 'electron.exe'), targets: [] },
      tls: { pfx: Buffer.from([1]), passphrase: 'secret' }
    }),
    loadExpectedHashes: () => ({ username: 'b'.repeat(64), password: 'c'.repeat(64) }),
    availablePort: async () => 9223,
    seedRegistry: () => undefined,
    getFingerprint: () => ({ schemaVersion: 1, electronExecutableSha256: 'same' }),
    Controller: class { async run() { launches += 1; return { pid: 9999 } } }
  }), /credential reference changed/i)
  assert.equal(launches, 0)
})

test('fresh live run writes redacted durable metadata and binds signals to the injected lifecycle target', async (t) => {
  t.after(() => { process.exitCode = undefined })
  const root = mkdtempSync(join(tmpdir(), 'vast-controller-live-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gateRoot = join(root, '.vast-build', 'password-manager-gates')
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'main.js'), 'built fixture\n')
  const signalTarget = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { pid: 4321 })
  let controllerOptions: any

  const started = await startGateRun(
    {
      command: 'run',
      mode: 'bitwarden',
      gateRoot,
      root,
      resume: false,
      buildVast: false,
      runId: 'fresh-live'
    },
    {
      history: {},
      signalTarget,
      prepareLiveRuntime: () => ({
        config: {
          root,
          gateRoot,
          profile: join(gateRoot, 'profiles', 'bitwarden'),
          mode: 'bitwarden',
          patchedDist: root,
          electronExecutable: join(root, 'electron.exe'),
          targets: [{ key: 'bitwarden', version: '2026.8.0', runtimeId: 'nngceckbapebfimnlniiiahkandclblb' }]
        },
        tls: { pfx: Buffer.from([1]), passphrase: 'must-not-be-written' }
      }),
      loadExpectedHashes: () => ({ username: 'a'.repeat(64), password: 'b'.repeat(64) }),
      availablePort: async () => 9223,
      seedRegistry: () => undefined,
      getFingerprint: () => ({ schemaVersion: 1, electronExecutableSha256: 'same' }),
      Controller: class {
        child = child
        server = { port: 4443 }
        constructor(options: unknown) { controllerOptions = options }
        async run() { return child }
        async stop() { this.child = undefined }
        status(value: string, details: object = {}) {
          writeFileSync(join(gateRoot, 'runs', 'fresh-live', 'status.json'), `${JSON.stringify({ status: value, ...details })}\n`)
          const current = JSON.parse(readFileSync(join(gateRoot, 'runs', 'fresh-live', 'result.json'), 'utf8'))
          writeFileSync(join(gateRoot, 'runs', 'fresh-live', 'result.json'), `${JSON.stringify({ ...current, status: value })}\n`)
        }
      }
    }
  )

  assert.equal(started.runId, 'fresh-live')
  assert.equal(signalTarget.listenerCount('SIGTERM'), 1)
  const resultPath = join(gateRoot, 'runs', 'fresh-live', 'result.json')
  const launcherPath = join(gateRoot, 'runs', 'fresh-live', 'launcher.json')
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).runtimeFingerprints.length, 1)
  assert.match(JSON.parse(readFileSync(resultPath, 'utf8')).credentialReferenceSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.parse(readFileSync(launcherPath, 'utf8')).electronPid, 4321)
  assert.equal(readFileSync(resultPath, 'utf8').includes('must-not-be-written'), false)
  assert.equal(typeof controllerOptions.capturePrivacyEvidence, 'function')
  controllerOptions.onProcessDiagnostic({ stream: 'stderr', errorClass: 'MissingReceiver', text: 'VAST_GATE_SECRET_CANARY' })
  controllerOptions.onProcessDiagnostic({ stream: 'stderr', errorClass: 'MissingReceiver', text: 'VAST_GATE_SECRET_CANARY' })
  const events = readFileSync(join(gateRoot, 'runs', 'fresh-live', 'events.jsonl'), 'utf8')
  assert.match(events, /MissingReceiver/)
  assert.equal(events.includes('VAST_GATE_SECRET_CANARY'), false)
  const afterWarning = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.deepEqual(afterWarning.defects, [{
    id: 'missing-receiver',
    classification: 'unclassified',
    resolved: false,
    evidenceIds: ['sequence:0']
  }])
  assert.match(verifyGateResult(afterWarning).failures.join(' '), /unclassified/i)
  assert.equal(readFileSync(resultPath, 'utf8').includes('VAST_GATE_SECRET_CANARY'), false)
  child.emit('exit', 9, null)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).status, 'failed')
  assert.equal(JSON.parse(readFileSync(join(gateRoot, 'runs', 'fresh-live', 'status.json'), 'utf8')).exitCode, 9)
})

test('legacy auth entry point refuses the shared profile unless an isolated mode is explicit', () => {
  const script = join(process.cwd(), 'scripts', 'extension-auth-gate.cjs')
  const refusal = spawnSync(process.execPath, [script, '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  })
  const refusalOutput = `${refusal.stdout}\n${refusal.stderr}`
  assert.notEqual(refusal.status, 0)
  assert.match(refusalOutput, /\.vast-build[\\/]extension-auth-gate[\\/]profile/i)
  assert.match(refusalOutput, /preserv|zachowan|refus|odmawia/i)

  const delegated = spawnSync(process.execPath, [script, '--mode', 'bitwarden', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  })
  const delegatedOutput = `${delegated.stdout}\n${delegated.stderr}`
  assert.equal(delegated.status, 0, delegatedOutput)
  const delegatedReport = JSON.parse(delegated.stdout)
  assert.equal(delegatedReport.command, 'prepare')
  assert.equal(delegatedReport.mode, 'bitwarden')
  const delegatedProfile = delegatedReport.checks.find((check: { name: string }) => check.name === 'profile')?.path
  if (delegatedProfile) {
    assert.equal(delegatedProfile.endsWith(join('password-manager-gates', 'profiles', 'bitwarden')), true)
  }
  assert.doesNotMatch(delegatedOutput, /Persistent auth profile:.*extension-auth-gate/i)
})

test('background launcher can resume an existing gate run with the same isolated profile', () => {
  const script = readFileSync(
    join(process.cwd(), 'scripts', 'password-manager-gate', 'start-background.ps1'),
    'utf8'
  )

  assert.match(script, /ValidateSet\('run',\s*'resume'\)/)
  assert.match(script, /\[string\]\$RunId/)
  assert.match(script, /resume.*--run-id.*\$RunId/s)
  assert.match(script, /CommandText/)
})
