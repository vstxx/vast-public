import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { approvedFixtureTarget, childFieldClickPoint, extensionOverlayIds, frameSummary, inspectChildForms, safeObservation, scanFixtures,
  overlayButtonInFixtureDom, shouldRetryMissingField, validateCompleteScan } =
  require('../../scripts/password-manager-gate/scan-fixtures.cjs')

test('fixture scanner retries forms whose fields are inserted asynchronously', () => {
  assert.equal(shouldRetryMissingField('delayed-login'), true)
  assert.equal(shouldRetryMissingField('dynamic-iframe'), true)
  assert.equal(shouldRetryMissingField('ordinary-login'), false)
})

const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'

test('fixture scanner rejects unrelated debugger targets and secret-bearing observations', () => {
  assert.equal(approvedFixtureTarget({ type: 'webview', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://localhost' }), true)
  assert.equal(approvedFixtureTarget({ type: 'webview', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://localhost' }), false)
  assert.equal(approvedFixtureTarget({ type: 'service_worker', url: 'https://login.vast-test.local:4443/login', webSocketDebuggerUrl: 'ws://localhost' }), false)
  assert.deepEqual([...extensionOverlayIds([
    { id: 'a', type: 'iframe', url: `chrome-extension://${BITWARDEN_ID}/overlay/menu-list.html` },
    { id: 'b', type: 'iframe', url: 'chrome-extension://other/overlay/menu-list.html' },
    { id: 'c', type: 'webview', url: `chrome-extension://${BITWARDEN_ID}/overlay/menu-button.html` }
  ], BITWARDEN_ID)], ['a'])
  const snapshot = {
    fixture: 'ordinary-login', route: '/login', frameOrigin: 'https://login.vast-test.local:4443',
    usernamePresent: false, passwordPresent: false, usernameMatchesExpectedHash: false,
    passwordMatchesExpectedHash: false, unexpectedForeignFill: false,
    submitted: false, submissionMatchedExpectedHashes: false
  }
  assert.throws(() => safeObservation({ fixture: 'ordinary-login', host: 'login.vast-test.local', route: '/login',
    focus: { fieldDetected: true, focusSucceeded: true, frameScope: 'top' },
    snapshot: { ...snapshot, password: 'must-not-leak' }, overlayButtonCreated: true, overlayListCreated: false
  }), /snapshot/i)
  const safe = safeObservation({ fixture: 'ordinary-login', host: 'login.vast-test.local', route: '/login',
    focus: { fieldDetected: true, focusSucceeded: true, frameScope: 'top' },
    snapshot, overlayButtonCreated: true, overlayListCreated: false })
  assert.equal(JSON.stringify(safe).includes('must-not-leak'), false)
  assert.deepEqual(frameSummary({ childFrames: [{ frame: { url: 'https://iframe.vast-test.local:4443/nested-middle' },
    childFrames: [{ frame: { url: 'https://login.vast-test.local:4443/frame-login?fixture=nested-inner' } }] }] },
  'nested-frame'), { childFrameCount: 2, expectedChildFramesLoaded: true })
})

test('fixture scanner visits the approved routes and stores only boolean field and overlay metadata', async () => {
  let current = new URL('https://login.vast-test.local:4443/login')
  let sequence = 0
  const sent: string[] = []
  const targets = () => [
    { id: 'webview', type: 'webview', url: current.href, webSocketDebuggerUrl: 'ws://fixture' },
    { id: `overlay-${sequence}`, type: 'iframe', url: `chrome-extension://${BITWARDEN_ID}/overlay/menu-button.html` }
  ]
  const session = {
    async send(method: string, params?: { url?: string }) {
      sent.push(method)
      if (method === 'Page.navigate') { current = new URL(params!.url); sequence += 1 }
      return {}
    },
    async evaluate(expression: string) {
      if (expression.includes('fieldDetected:')) return { fieldDetected: true, focusSucceeded: true,
        frameScope: 'top', x: 100, y: 100 }
      const fixture = current.pathname === '/login' ? 'ordinary-login'
        : current.pathname === '/spa' ? 'spa-login'
          : current.pathname === '/dynamic' ? 'dynamic-login'
            : current.pathname === '/delayed' ? 'delayed-login'
              : current.pathname === '/same-origin-iframe' ? 'same-origin-iframe'
                : current.pathname === '/cross-origin-iframe' ? 'cross-origin-iframe'
                  : current.pathname === '/nested' ? 'nested-frame' : 'dynamic-iframe'
      return { fixture, route: current.pathname, frameOrigin: current.origin,
        usernamePresent: false, passwordPresent: false, usernameMatchesExpectedHash: false,
        passwordMatchesExpectedHash: false, unexpectedForeignFill: false,
        submitted: false, submissionMatchedExpectedHashes: false }
    },
    close() {}
  }
  const results = await scanFixtures({ debuggerPort: 9223, fixturePort: 4443, extensionId: BITWARDEN_ID,
    fetchImpl: async () => ({ ok: true, json: async () => targets() }),
    connect: async () => session, wait: async () => undefined })
  assert.equal(results.length, 8)
  assert.equal(results.every((item: { focus: { fieldDetected: boolean }; overlayButtonCreated: boolean }) =>
    item.focus.fieldDetected && item.overlayButtonCreated), true)
  assert.equal(sent.filter((method) => method === 'Input.dispatchMouseEvent').length, 24)
  assert.equal(JSON.stringify(results).includes('password='), false)
})

test('frame probe checks only form presence in an approved child execution context', async () => {
  const calls: string[] = []
  const session = { async send(method: string, params: { frameId?: string; expression?: string }) {
    calls.push(method)
    if (method === 'Page.createIsolatedWorld') {
      assert.equal(params.frameId, 'child-frame')
      return { executionContextId: 17 }
    }
    assert.equal(params.expression?.includes('.value'), false)
    return { result: { value: true } }
  } }
  const result = await inspectChildForms(session, { childFrames: [{ frame: {
    id: 'child-frame', url: 'https://iframe.vast-test.local:4443/frame-login?fixture=cross-origin-frame'
  } }] }, 'cross-origin-iframe')
  assert.deepEqual(result, { childFormDetected: true, frameProbeSupported: true })
  assert.deepEqual(calls, ['Page.createIsolatedWorld', 'Runtime.evaluate'])
})

test('nested child click geometry uses only fixture frame and field rectangles', async () => {
  const expressions: string[] = []
  const session = {
    async evaluate(expression: string) {
      expressions.push(expression)
      return { x: 10, y: 20 }
    },
    async send(method: string, params: { frameId?: string; expression?: string; contextId?: number }) {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'middle' ? 2 : 3 }
      assert.equal(method, 'Runtime.evaluate')
      expressions.push(params.expression!)
      return { result: { value: params.contextId === 2 ? { x: 30, y: 40 } : { x: 50, y: 60 } } }
    }
  }
  const tree = { childFrames: [{ frame: { id: 'middle', url: 'https://iframe.vast-test.local:4443/nested-middle' },
    childFrames: [{ frame: { id: 'leaf', url: 'https://login.vast-test.local:4443/frame-login?fixture=nested-inner' } }] }] }
  assert.deepEqual(await childFieldClickPoint(session, tree, 'nested-frame'), { x: 90, y: 120 })
  assert.equal(expressions.length, 3)
  assert.equal(expressions.every((expression) => !expression.includes('.value')), true)
})

test('recordable scan requires Bitwarden overlay on every approved HTTPS fixture', () => {
  const routes = [
    ['ordinary-login', 'login.vast-test.local', '/login'],
    ['spa-login', 'spa.vast-test.local', '/spa'],
    ['dynamic-login', 'dynamic.vast-test.local', '/dynamic'],
    ['delayed-login', 'dynamic.vast-test.local', '/delayed'],
    ['same-origin-iframe', 'login.vast-test.local', '/same-origin-iframe'],
    ['cross-origin-iframe', 'login.vast-test.local', '/cross-origin-iframe'],
    ['nested-frame', 'iframe.vast-test.local', '/nested'],
    ['dynamic-iframe', 'login.vast-test.local', '/dynamic-iframe']
  ]
  const observations = routes.map(([fixture, host, route]) => safeObservation({
    fixture, host, route,
    focus: { fieldDetected: !fixture.includes('iframe') && fixture !== 'nested-frame',
      focusSucceeded: !fixture.includes('iframe') && fixture !== 'nested-frame', frameScope: 'none' },
    snapshot: { fixture, route, frameOrigin: `https://${host}:4443`, usernamePresent: false,
      passwordPresent: false, usernameMatchesExpectedHash: false, passwordMatchesExpectedHash: false,
      unexpectedForeignFill: false, submitted: false, submissionMatchedExpectedHashes: false },
    overlayButtonCreated: true, overlayListCreated: false, childFrameCount: 0,
    expectedChildFramesLoaded: fixture.includes('iframe') || fixture === 'nested-frame',
    childFormDetected: fixture.includes('iframe') || fixture === 'nested-frame', frameProbeSupported: true
  }))
  const artifact = { schemaVersion: 1, runId: 'run-1', mode: 'bitwarden', observedAt: new Date().toISOString(), observations }
  assert.equal(validateCompleteScan(artifact, 'run-1'), true)
  const broken = { ...artifact, observations: observations.map((item, index) =>
    index === 7 ? { ...item, overlayButtonCreated: false } : item) }
  assert.throws(() => validateCompleteScan(broken, 'run-1'), /dynamic-iframe/)
})

test('overlay DOM probe checks only the official extension iframe in approved child frames', async () => {
  const expressions: string[] = []
  const session = {
    async evaluate(expression: string) { expressions.push(expression); return false },
    async send(method: string, params: { expression?: string; frameId?: string }) {
      if (method === 'Page.createIsolatedWorld') {
        assert.equal(params.frameId, 'fixture-child')
        return { executionContextId: 7 }
      }
      expressions.push(params.expression!)
      return { result: { value: true } }
    }
  }
  const tree = { childFrames: [{ frame: { id: 'fixture-child',
    url: 'https://iframe.vast-test.local:4443/frame-login' } }] }
  assert.equal(await overlayButtonInFixtureDom(session, tree, BITWARDEN_ID), true)
  assert.equal(expressions.length, 2)
  assert.equal(expressions.every((expression) => expression.includes(`chrome-extension://${BITWARDEN_ID}/overlay/menu-button.html`) &&
    !expression.includes('.value')), true)
})
