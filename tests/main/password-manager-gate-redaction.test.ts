import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { CdpObserver } = require('../../scripts/password-manager-gate/cdp.cjs')
const { assertArtifactHasNoSecrets, sanitizeEvent } = require('../../scripts/password-manager-gate/redaction.cjs')
const { routeFixtureRequest } = require('../../scripts/password-manager-gate/fixtures.cjs')

const CANARIES = [
  'VAST_GATE_TOKEN_CANARY',
  'VAST_GATE_COOKIE_CANARY',
  'VAST_GATE_AUTH_CANARY',
  'VAST_GATE_PAYLOAD_CANARY'
]

test('process diagnostics retain only approved stream metadata', () => {
  assert.deepEqual(sanitizeEvent({ event: 'process-diagnostic', errorClass: 'MissingReceiver',
    diagnosticStream: 'stderr', payload: CANARIES[0] }), {
    event: 'process-diagnostic', errorClass: 'MissingReceiver', diagnosticStream: 'stderr'
  })
  assert.deepEqual(sanitizeEvent({ event: 'process-diagnostic', errorClass: 'MissingReceiver',
    diagnosticStream: CANARIES[0] }), { event: 'process-diagnostic', errorClass: 'MissingReceiver' })
  assert.deepEqual(sanitizeEvent({ event: 'process-diagnostic', errorClass: 'MissingReceiver',
    diagnosticCount: 1024, payload: CANARIES[0] }), {
    event: 'process-diagnostic', errorClass: 'MissingReceiver', diagnosticCount: 1024
  })
  assert.deepEqual(sanitizeEvent({ event: 'process-diagnostic', diagnosticCount: CANARIES[0] }),
    { event: 'process-diagnostic' })
  assert.deepEqual(sanitizeEvent({
    event: 'process-diagnostic', apiMethod: 'tabs.sendMessage',
    extensionId: 'nngceckbapebfimnlniiiahkandclblb', contextType: 'service_worker',
    receiverContext: 'tab_frame', tabId: 17, frameId: 3, payload: CANARIES[0]
  }), {
    event: 'process-diagnostic', apiMethod: 'tabs.sendMessage',
    extensionId: 'nngceckbapebfimnlniiiahkandclblb', contextType: 'service_worker',
    receiverContext: 'tab_frame', tabId: 17, frameId: 3
  })
})

test('sanitizer constructs an allowlisted event and strips URL query, fragment and arbitrary nested values', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const event = sanitizeEvent({
    sequence: 7,
    at: '2026-09-20T10:00:00.000Z',
    event: 'external-message-error',
    extensionId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    contextType: 'service_worker',
    targetId: 'target-1',
    tabId: 9,
    frameId: 3,
    parentFrameId: 1,
    url: 'https://account.proton.me/auth-ext?token=VAST_GATE_TOKEN_CANARY#VAST_GATE_AUTH_CANARY',
    lifecycleState: 'stopped',
    error: new TypeError('VAST_GATE_PAYLOAD_CANARY'),
    cookie: 'VAST_GATE_COOKIE_CANARY',
    authorization: 'Bearer VAST_GATE_AUTH_CANARY',
    message: { payload: 'VAST_GATE_PAYLOAD_CANARY', nested: [circular] },
    stackLocations: [{
      url: 'https://account.proton.me/worker.js?code=VAST_GATE_PAYLOAD_CANARY#fragment',
      lineNumber: 12,
      columnNumber: 4,
      payload: CANARIES[3]
    }]
  })

  assert.deepEqual(event, {
    sequence: 7,
    at: '2026-09-20T10:00:00.000Z',
    event: 'external-message-error',
    extensionId: 'ghmbeldphafepmbegfdlkpapadhbakde',
    contextType: 'service_worker',
    targetId: 'target-1',
    tabId: 9,
    frameId: 3,
    parentFrameId: 1,
    url: 'https://account.proton.me/auth-ext',
    lifecycleState: 'stopped',
    errorClass: 'TypeError',
    stackLocations: [{ url: 'https://account.proton.me/worker.js', lineNumber: 12, columnNumber: 4 }]
  })
  assert.equal(JSON.stringify(event).includes('CANARY'), false)
})

test('sanitizer drops malformed identifiers and never parses hostile Error stacks or encoded query values', () => {
  const error = new Error('VAST_GATE_PAYLOAD_CANARY')
  error.stack = 'at fn (https://account.proton.me/auth-ext?code=VAST_GATE_TOKEN_CANARY:3:4)'
  const event = sanitizeEvent({
    sequence: -1,
    at: 'not-a-date',
    event: 'runtime-exception',
    extensionId: 'VAST_GATE_TOKEN_CANARY',
    targetId: 'target with spaces VAST_GATE_AUTH_CANARY',
    tabId: 1.5,
    url: 'https://example.test/path?next=VAST_GATE_TOKEN_CANARY%2526secret%253DVAST_GATE_COOKIE_CANARY',
    error,
    stack: error.stack
  })
  assert.deepEqual(event, {
    event: 'runtime-exception',
    url: 'https://example.test/path',
    errorClass: 'Error'
  })
  assert.equal(JSON.stringify(event).includes('CANARY'), false)
})

test('artifact scanning catches literal, URL-encoded and base64 canaries without echoing the secret', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-redaction-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'nested'))
  writeFileSync(join(root, 'safe.jsonl'), `${JSON.stringify(sanitizeEvent({ event: 'safe', url: 'https://example.test/path?token=VAST_GATE_TOKEN_CANARY' }))}\n`)
  assert.doesNotThrow(() => assertArtifactHasNoSecrets(root, CANARIES))

  for (const [name, value] of [
    ['literal.log', CANARIES[0]],
    ['encoded.log', encodeURIComponent(CANARIES[1])],
    ['base64.log', Buffer.from(CANARIES[2]).toString('base64')]
  ]) {
    const target = join(root, 'nested', name)
    writeFileSync(target, value)
    let failure: Error | undefined
    try { assertArtifactHasNoSecrets(target, CANARIES) } catch (error) { failure = error as Error }
    assert.ok(failure, name)
    for (const canary of CANARIES) assert.equal(failure.message.includes(canary), false)
    rmSync(target)
  }
})

class FakeDebugger extends EventEmitter {
  attached = false
  commands: Array<{ method: string, params: unknown }> = []
  evaluationValue: unknown = {
    fixture: 'ordinary-login',
    route: '/login',
    frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: true,
    passwordPresent: true,
    usernameMatchesExpectedHash: true,
    passwordMatchesExpectedHash: true,
    unexpectedForeignFill: false,
    submitted: false,
    submissionMatchedExpectedHashes: false,
    payload: 'VAST_GATE_PAYLOAD_CANARY'
  }

  isAttached() { return this.attached }
  attach(protocol: string) { assert.equal(protocol, '1.3'); this.attached = true }
  detach() { this.attached = false }
  async sendCommand(method: string, params: unknown = {}) {
    this.commands.push({ method, params })
    if (method === 'Target.getTargets') {
      return {
        targetInfos: [
          { targetId: 'worker-1', type: 'service_worker', url: 'chrome-extension://ghmbeldphafepmbegfdlkpapadhbakde/worker.js?token=VAST_GATE_TOKEN_CANARY' },
          { targetId: 'page-1', type: 'page', url: 'https://login.vast-test.local:4443/login?secret=VAST_GATE_AUTH_CANARY' }
        ]
      }
    }
    if (method === 'Runtime.evaluate') return { result: { value: this.evaluationValue } }
    return {}
  }
}

test('CDP observer enables only approved domains and records lifecycle locations without console arguments', async () => {
  const debug = new FakeDebugger()
  const events: unknown[] = []
  const observer = new CdpObserver({ debuggerClient: debug, onEvent: (event: unknown) => events.push(event) })
  await observer.start()

  debug.emit('message', {}, 'Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'string', value: 'VAST_GATE_PAYLOAD_CANARY' }],
    stackTrace: { callFrames: [{ url: 'https://example.test/app.js?token=VAST_GATE_TOKEN_CANARY', lineNumber: 5, columnNumber: 6 }] }
  })
  debug.emit('message', {}, 'Runtime.exceptionThrown', {
    exceptionDetails: {
      text: 'VAST_GATE_PAYLOAD_CANARY',
      exception: { className: 'TypeError', description: 'VAST_GATE_AUTH_CANARY' },
      stackTrace: { callFrames: [{ url: 'https://example.test/worker.js?secret=VAST_GATE_COOKIE_CANARY', lineNumber: 8, columnNumber: 2 }] }
    }
  })
  debug.emit('message', {}, 'Target.targetCreated', {
    targetInfo: { targetId: 'worker-2', type: 'service_worker', url: 'chrome-extension://ghmbeldphafepmbegfdlkpapadhbakde/worker.js?token=VAST_GATE_TOKEN_CANARY' }
  })
  debug.emit('message', {}, 'Page.frameAttached', { frameId: 'frame-2', parentFrameId: 'frame-1', stack: CANARIES[0] })

  const initialMethods = debug.commands.map((item) => item.method)
  assert.deepEqual(initialMethods, ['Runtime.enable', 'Log.enable', 'Page.enable', 'Target.setDiscoverTargets'])
  assert.equal(initialMethods.some((method) => method.startsWith('Network.')), false)
  assert.equal(JSON.stringify(events).includes('CANARY'), false)
  assert.deepEqual((events[0] as { stackLocations: unknown }).stackLocations, [
    { url: 'https://example.test/app.js', lineNumber: 5, columnNumber: 6 }
  ])
  const frameEvent = events[3] as Record<string, unknown>
  assert.equal(frameEvent.sequence, 3)
  assert.match(String(frameEvent.at), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(frameEvent.event, 'frame-attached')
  assert.equal(frameEvent.contextType, 'frame')
  assert.equal(frameEvent.frameId, 1)
  assert.equal(frameEvent.parentFrameId, 2)
  assert.equal(frameEvent.lifecycleState, 'attached')

  await observer.stop()
  assert.equal(debug.attached, false)
  assert.equal(debug.listenerCount('message'), 0)
  assert.deepEqual(debug.commands.at(-1), { method: 'Target.setDiscoverTargets', params: { discover: false } })
})

test('target snapshots sanitize URLs and fixture evaluation is fixed-expression and approved-origin only', async () => {
  const debug = new FakeDebugger()
  const observer = new CdpObserver({ debuggerClient: debug, onEvent: () => undefined })
  await observer.start()
  const targets = await observer.snapshotTargets()
  assert.equal(JSON.stringify(targets).includes('CANARY'), false)
  assert.deepEqual(targets.map((item: { url: string }) => item.url), [
    'chrome-extension://ghmbeldphafepmbegfdlkpapadhbakde/worker.js',
    'https://login.vast-test.local:4443/login'
  ])

  const beforeRejected = debug.commands.length
  await assert.rejects(
    observer.evaluateFixture({ url: 'https://account.proton.me/login', contextId: 19 }),
    /approved fixture origin/i
  )
  assert.equal(debug.commands.length, beforeRejected)

  const snapshot = await observer.evaluateFixture({
    url: 'https://login.vast-test.local:4443/login?token=VAST_GATE_TOKEN_CANARY',
    contextId: 23
  })
  assert.deepEqual(snapshot, {
    fixture: 'ordinary-login',
    route: '/login',
    frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: true,
    passwordPresent: true,
    usernameMatchesExpectedHash: true,
    passwordMatchesExpectedHash: true,
    unexpectedForeignFill: false,
    submitted: false,
    submissionMatchedExpectedHashes: false
  })
  assert.deepEqual(debug.commands.at(-1), {
    method: 'Runtime.evaluate',
    params: {
      expression: 'window.__vastGate.snapshot()',
      contextId: 23,
      awaitPromise: true,
      returnByValue: true
    }
  })
  assert.equal(JSON.stringify(snapshot).includes('CANARY'), false)
  await observer.stop()
})

test('generated fixture source contains expected hashes but never credential canaries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-fixture-scan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const response = routeFixtureRequest({ host: 'login.vast-test.local', method: 'GET', path: '/login', body: Buffer.alloc(0) }, {
    username: '1'.repeat(64),
    password: '2'.repeat(64)
  }, 4443)
  const artifact = join(root, 'fixture.html')
  writeFileSync(artifact, response.body)
  assert.doesNotThrow(() => assertArtifactHasNoSecrets(artifact, CANARIES))
})
