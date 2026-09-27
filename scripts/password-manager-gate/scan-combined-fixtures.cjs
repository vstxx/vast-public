#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const {
  approvedFixtureTarget,
  childFieldClickPoint,
  extensionOverlayIds,
  frameSummary,
  inspectChildForms,
  overlayButtonInFixtureDom,
  safeFocus
} = require('./scan-fixtures.cjs')
const { protonMarkerExpression, protonRootDetected, protonUiIds } = require('./scan-proton-fixtures.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'
const PROTON_ID = 'ghmbeldphafepmbegfdlkpapadhbakde'
const ROUTES = Object.freeze([
  ['ordinary-login', 'login.vast-test.local', '/login'],
  ['spa-login', 'spa.vast-test.local', '/spa'],
  ['dynamic-login', 'dynamic.vast-test.local', '/dynamic'],
  ['delayed-login', 'dynamic.vast-test.local', '/delayed'],
  ['same-origin-iframe', 'login.vast-test.local', '/same-origin-iframe'],
  ['cross-origin-iframe', 'login.vast-test.local', '/cross-origin-iframe'],
  ['nested-frame', 'iframe.vast-test.local', '/nested'],
  ['dynamic-iframe', 'login.vast-test.local', '/dynamic-iframe']
])
const CHILD_FIXTURES = new Set(['same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe'])
const FOCUS = `(() => {
  let field = document.getElementById('gate-username')
  let frameScope = 'top'
  let frame = null
  if (!field) {
    frame = document.getElementById('gate-frame')
    try { field = frame?.contentDocument?.getElementById('gate-username') } catch {}
    frameScope = field ? 'same-origin-child' : 'none'
  }
  if (field) field.focus()
  const rect = field?.getBoundingClientRect()
  const frameRect = frame?.getBoundingClientRect()
  return { fieldDetected: Boolean(field), focusSucceeded: Boolean(field && field.ownerDocument.activeElement === field),
    frameScope, x: rect ? rect.x + rect.width / 2 + (frameRect?.x || 0) : null,
    y: rect ? rect.y + rect.height / 2 + (frameRect?.y || 0) : null }
})()`

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function workerTarget(targets, extensionId) {
  const url = `chrome-extension://${extensionId}/background.js`
  return targets.find((target) => target?.type === 'service_worker' && target.url === url && typeof target.id === 'string')?.id
}

function combinedWorkers(targets) {
  return Object.freeze({
    bitwarden: workerTarget(targets, BITWARDEN_ID),
    proton: workerTarget(targets, PROTON_ID)
  })
}

function rememberWorkers(previous, targets) {
  const active = combinedWorkers(targets)
  return Object.freeze({
    bitwarden: previous?.bitwarden === true || Boolean(active.bitwarden),
    proton: previous?.proton === true || Boolean(active.proton)
  })
}

function safeCombinedObservation(value) {
  if (!ROUTES.some(([fixture, host, route]) => fixture === value?.fixture && host === value.host && route === value.route) ||
      typeof value.bitwardenInjected !== 'boolean' || typeof value.protonInjected !== 'boolean' ||
      !Number.isSafeInteger(value.childFrameCount) || value.childFrameCount < 0 || value.childFrameCount > 32 ||
      typeof value.expectedChildFramesLoaded !== 'boolean' || typeof value.childFormDetected !== 'boolean' ||
      typeof value.frameProbeSupported !== 'boolean') throw new Error('Combined fixture observation is invalid.')
  return Object.freeze({
    fixture: value.fixture,
    host: value.host,
    route: value.route,
    focus: safeFocus(value.focus),
    bitwardenInjected: value.bitwardenInjected,
    protonInjected: value.protonInjected,
    childFrameCount: value.childFrameCount,
    expectedChildFramesLoaded: value.expectedChildFramesLoaded,
    childFormDetected: value.childFormDetected,
    frameProbeSupported: value.frameProbeSupported
  })
}

function scanPassed(observations) {
  return Array.isArray(observations) && observations.length === ROUTES.length && observations.every((item) =>
    item.bitwardenInjected === true && item.protonInjected === true && item.frameProbeSupported === true &&
    (!CHILD_FIXTURES.has(item.fixture) || (item.expectedChildFramesLoaded === true && item.childFormDetected === true)))
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Local debugger target list is invalid.')
  return targets
}

async function scanStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'combined' || result.mode !== 'combined' || command.runId !== result.runId ||
      command.exploratory !== true || result.exploratory !== true || status.status !== 'running' ||
      !Number.isSafeInteger(status.debuggerPort) || !Number.isSafeInteger(status.fixturePort)) {
    throw new Error('Combined scanner requires a live exploratory combined run.')
  }
  const identities = new Map(result.extensions?.map((item) => [item.key, item.runtimeId]))
  if (identities.get('bitwarden') !== BITWARDEN_ID || identities.get('protonpass') !== PROTON_ID) {
    throw new Error('Both official password-manager extension IDs must be active.')
  }
  const initialTargets = await listTargets(status.debuggerPort)
  let seenWorkers = rememberWorkers({ bitwarden: false, proton: false }, initialTargets)
  const page = initialTargets.find(approvedFixtureTarget)
  if (!page) throw new Error('No approved HTTPS fixture webview is available.')
  const session = await WorkerCdpSession.connect(page.webSocketDebuggerUrl)
  const observations = []
  try {
    await session.send('Page.enable')
    for (const [fixture, host, route] of ROUTES) {
      const navigation = await session.send('Page.navigate', { url: `https://${host}:${status.fixturePort}${route}` })
      if (navigation?.errorText) throw new Error(`Fixture navigation failed for ${fixture}.`)
      let ready = false
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        try {
          const snapshot = await session.evaluate('window.__vastGate.snapshot()')
          if (snapshot?.fixture === fixture && snapshot?.route === route) { ready = true; break }
        } catch {}
      }
      if (!ready) throw new Error(`Fixture ${fixture} did not become ready.`)
      if (fixture === 'delayed-login') await new Promise((resolve) => setTimeout(resolve, 1_400))
      if (fixture === 'dynamic-iframe') await new Promise((resolve) => setTimeout(resolve, 700))

      const before = await listTargets(status.debuggerPort)
      seenWorkers = rememberWorkers(seenWorkers, before)
      const bitwardenBefore = extensionOverlayIds(before, BITWARDEN_ID)
      const protonBefore = protonUiIds(before, PROTON_ID)
      const rawFocus = await session.evaluate(FOCUS)
      let point = Number.isFinite(rawFocus?.x) && Number.isFinite(rawFocus?.y)
        ? { x: rawFocus.x, y: rawFocus.y }
        : null
      let tree = await session.send('Page.getFrameTree')
      if (!point && CHILD_FIXTURES.has(fixture)) point = await childFieldClickPoint(session, tree?.frameTree, fixture)
      if (point) {
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
      }

      let bitwardenInjected = false
      let protonInjected = false
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        tree = await session.send('Page.getFrameTree')
        const targets = await listTargets(status.debuggerPort)
        seenWorkers = rememberWorkers(seenWorkers, targets)
        const bitwardenAfter = extensionOverlayIds(targets, BITWARDEN_ID)
        const protonAfter = protonUiIds(targets, PROTON_ID)
        bitwardenInjected = bitwardenInjected || [...bitwardenAfter].some((id) => !bitwardenBefore.has(id)) ||
          await overlayButtonInFixtureDom(session, tree?.frameTree, BITWARDEN_ID)
        protonInjected = protonInjected || [...protonAfter].some((id) => !protonBefore.has(id)) ||
          await protonRootDetected(session, tree?.frameTree)
        if (bitwardenInjected && protonInjected) break
      }
      observations.push(safeCombinedObservation({
        fixture,
        host,
        route,
        focus: rawFocus,
        bitwardenInjected,
        protonInjected,
        ...frameSummary(tree?.frameTree, fixture),
        ...await inspectChildForms(session, tree?.frameTree, fixture)
      }))
    }
  } finally {
    session.close()
  }

  seenWorkers = rememberWorkers(seenWorkers, await listTargets(status.debuggerPort))
  const artifact = Object.freeze({
    schemaVersion: 1,
    runId: command.runId,
    mode: 'combined',
    exploratory: true,
    observedAt: new Date().toISOString(),
    extensionIds: Object.freeze({ bitwarden: BITWARDEN_ID, proton: PROTON_ID }),
    payloadsCaptured: false,
    workerIsolation: seenWorkers.bitwarden && seenWorkers.proton,
    passed: scanPassed(observations),
    observations
  })
  const output = path.join(runRoot, `combined-fixture-scan-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return {
    artifact: output,
    passed: artifact.passed,
    workerIsolation: artifact.workerIsolation,
    observations: observations.map(({ fixture, focus, ...item }) => ({ fixture, ...focus, ...item }))
  }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/scan-combined-fixtures.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    scanStoredRun(runRoot).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { combinedWorkers, protonMarkerExpression, rememberWorkers, safeCombinedObservation, scanPassed, scanStoredRun }
