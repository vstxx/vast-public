#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { cleanSnapshot } = require('./cdp.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')
const { approvedFixtureTarget, childFieldClickPoint, frameSummary, inspectChildForms, safeFocus } = require('./scan-fixtures.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

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
function protonMarkerExpression() {
  return `(() => [...document.querySelectorAll('*')].some((element) => {
    const tag = element.tagName.toLowerCase()
    return tag.startsWith('protonpass-root-') || tag.startsWith('protonpass-control-') ||
      element.hasAttribute('data-protonpass-role') || element.hasAttribute('data-protonpass-form')
  }))()`
}

const ROOT = protonMarkerExpression()

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function protonUiIds(targets, extensionId = PROTON_ID) {
  const url = `chrome-extension://${extensionId}/dropdown.html`
  return new Set(targets.filter((target) => target?.type === 'iframe' && target.url === url &&
    typeof target.id === 'string').map((target) => target.id))
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Local debugger target list is invalid.')
  return targets
}

function fixtureFrameIds(tree) {
  const ids = []
  const visit = (node) => {
    try {
      const url = new URL(node?.frame?.url)
      if (url.protocol === 'https:' && isApprovedFixtureHost(url.hostname) && typeof node.frame.id === 'string') ids.push(node.frame.id)
    } catch {}
    for (const child of node?.childFrames || []) visit(child)
  }
  visit(tree)
  return ids
}

async function protonRootDetected(session, tree) {
  for (const frameId of fixtureFrameIds(tree)) {
    try {
      const world = await session.send('Page.createIsolatedWorld', { frameId, worldName: 'vast-gate-readonly' })
      const response = await session.send('Runtime.evaluate', {
        expression: ROOT, contextId: world.executionContextId, returnByValue: true
      })
      if (!response?.exceptionDetails && response?.result?.value === true) return true
    } catch {}
  }
  return false
}

function safeObservation(value) {
  if (!ROUTES.some(([fixture, host, route]) => fixture === value.fixture && host === value.host && route === value.route) ||
      typeof value.rootInjected !== 'boolean' || !Number.isSafeInteger(value.childFrameCount) ||
      typeof value.expectedChildFramesLoaded !== 'boolean' || typeof value.childFormDetected !== 'boolean' ||
      typeof value.frameProbeSupported !== 'boolean') throw new Error('Proton fixture observation is invalid.')
  return Object.freeze({ fixture: value.fixture, host: value.host, route: value.route,
    focus: safeFocus(value.focus), rootInjected: value.rootInjected,
    childFrameCount: value.childFrameCount, expectedChildFramesLoaded: value.expectedChildFramesLoaded,
    childFormDetected: value.childFormDetected, frameProbeSupported: value.frameProbeSupported })
}

function scanPassed(observations) {
  return Array.isArray(observations) && observations.length === ROUTES.length && observations.every((item) =>
    item.rootInjected === true && item.frameProbeSupported === true &&
    (!CHILD_FIXTURES.has(item.fixture) || (item.expectedChildFramesLoaded === true && item.childFormDetected === true)))
}

async function scanStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'proton' || result.mode !== 'proton' || command.runId !== result.runId ||
      command.exploratory !== true || result.exploratory !== true || status.status !== 'running' ||
      !Number.isSafeInteger(status.debuggerPort) || !Number.isSafeInteger(status.fixturePort)) {
    throw new Error('Proton scanner requires a live exploratory isolated Proton run.')
  }
  const extension = result.extensions?.find((item) => item.key === 'protonpass')
  if (extension?.runtimeId !== PROTON_ID) throw new Error('Official Proton extension ID is not active.')
  const page = (await listTargets(status.debuggerPort)).find(approvedFixtureTarget)
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
          const snapshot = cleanSnapshot(await session.evaluate('window.__vastGate.snapshot()'))
          if (snapshot.fixture === fixture && snapshot.route === route && new URL(snapshot.frameOrigin).hostname === host) { ready = true; break }
        } catch {}
      }
      if (!ready) throw new Error(`Fixture ${fixture} did not become ready.`)
      if (fixture === 'delayed-login') await new Promise((resolve) => setTimeout(resolve, 1_400))
      if (fixture === 'dynamic-iframe') await new Promise((resolve) => setTimeout(resolve, 700))
      const uiBefore = protonUiIds(await listTargets(status.debuggerPort))
      const rawFocus = await session.evaluate(FOCUS)
      let point = Number.isFinite(rawFocus?.x) && Number.isFinite(rawFocus?.y) ? { x: rawFocus.x, y: rawFocus.y } : null
      let tree = await session.send('Page.getFrameTree')
      if (!point && CHILD_FIXTURES.has(fixture)) point = await childFieldClickPoint(session, tree?.frameTree, fixture)
      if (point) {
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
      }
      let rootInjected = false
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        tree = await session.send('Page.getFrameTree')
        const uiAfter = protonUiIds(await listTargets(status.debuggerPort))
        rootInjected = await protonRootDetected(session, tree?.frameTree) ||
          [...uiAfter].some((id) => !uiBefore.has(id))
        if (rootInjected) break
      }
      observations.push(safeObservation({ fixture, host, route, focus: rawFocus,
        rootInjected,
        ...frameSummary(tree?.frameTree, fixture), ...await inspectChildForms(session, tree?.frameTree, fixture) }))
    }
  } finally { session.close() }
  const artifact = Object.freeze({ schemaVersion: 1, runId: command.runId, mode: 'proton', exploratory: true,
    observedAt: new Date().toISOString(), extensionId: PROTON_ID, payloadsCaptured: false,
    passed: scanPassed(observations), observations })
  const output = path.join(runRoot, `proton-fixture-scan-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, passed: artifact.passed,
    observations: observations.map(({ fixture, focus, ...item }) => ({ fixture, ...focus, ...item })) }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/scan-proton-fixtures.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    scanStoredRun(runRoot).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { protonMarkerExpression, protonRootDetected, protonUiIds, safeObservation, scanPassed }
