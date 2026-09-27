#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { cleanSnapshot } = require('./cdp.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

const SCAN_ROUTES = Object.freeze([
  ['ordinary-login', 'login.vast-test.local', '/login'],
  ['spa-login', 'spa.vast-test.local', '/spa'],
  ['dynamic-login', 'dynamic.vast-test.local', '/dynamic'],
  ['delayed-login', 'dynamic.vast-test.local', '/delayed'],
  ['same-origin-iframe', 'login.vast-test.local', '/same-origin-iframe'],
  ['cross-origin-iframe', 'login.vast-test.local', '/cross-origin-iframe'],
  ['nested-frame', 'iframe.vast-test.local', '/nested'],
  ['dynamic-iframe', 'login.vast-test.local', '/dynamic-iframe']
])
const EXPECTED_CHILD_PATHS = Object.freeze({
  'same-origin-iframe': ['/frame-login'],
  'cross-origin-iframe': ['/frame-login'],
  'nested-frame': ['/nested-middle', '/frame-login'],
  'dynamic-iframe': ['/frame-login']
})

const FOCUS_EXPRESSION = `(() => {
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
  return {
    fieldDetected: Boolean(field),
    focusSucceeded: Boolean(field && field.ownerDocument.activeElement === field),
    frameScope,
    x: rect ? rect.x + rect.width / 2 + (frameRect?.x || 0) : null,
    y: rect ? rect.y + rect.height / 2 + (frameRect?.y || 0) : null
  }
})()`

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function approvedFixtureTarget(target) {
  if (target?.type !== 'webview' || typeof target.url !== 'string' ||
      typeof target.webSocketDebuggerUrl !== 'string') return false
  try {
    const url = new URL(target.url)
    return url.protocol === 'https:' && isApprovedFixtureHost(url.hostname)
  } catch { return false }
}

function extensionOverlayIds(targets, extensionId) {
  const base = `chrome-extension://${extensionId}/overlay/`
  return new Set(targets.filter((target) => target?.type === 'iframe' &&
    typeof target.id === 'string' && typeof target.url === 'string' &&
    (target.url === `${base}menu-button.html` || target.url === `${base}menu-list.html`))
    .map((target) => target.id))
}

function safeFocus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.fieldDetected !== 'boolean' || typeof value.focusSucceeded !== 'boolean' ||
      !['top', 'same-origin-child', 'none'].includes(value.frameScope)) {
    throw new Error('Fixture focus returned an unexpected shape.')
  }
  return Object.freeze({ fieldDetected: value.fieldDetected, focusSucceeded: value.focusSucceeded, frameScope: value.frameScope })
}

function safeClickPoint(value) {
  if (!value?.fieldDetected) return null
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 ||
      value.x > 100_000 || value.y > 100_000) throw new Error('Fixture field has an invalid click point.')
  return { x: value.x, y: value.y }
}

function shouldRetryMissingField(fixture) {
  return ['delayed-login', 'same-origin-iframe', 'dynamic-iframe'].includes(fixture)
}

function frameSummary(frameTree, fixture) {
  const children = []
  function visit(node) {
    for (const child of node?.childFrames || []) {
      if (typeof child?.frame?.url === 'string') {
        try {
          const url = new URL(child.frame.url)
          if (url.protocol === 'https:' && isApprovedFixtureHost(url.hostname)) {
            children.push({ host: url.hostname, path: url.pathname })
          }
        } catch {}
      }
      visit(child)
    }
  }
  visit(frameTree)
  const expected = EXPECTED_CHILD_PATHS[fixture] || []
  return Object.freeze({ childFrameCount: children.length,
    expectedChildFramesLoaded: expected.length > 0 && expected.every((expectedPath) =>
      children.some((child) => child.path === expectedPath)) })
}

async function inspectChildForms(session, frameTree, fixture) {
  if (!EXPECTED_CHILD_PATHS[fixture]) return { childFormDetected: false, frameProbeSupported: true }
  const leaves = []
  function visit(node) {
    for (const child of node?.childFrames || []) {
      try {
        const url = new URL(child.frame.url)
        if (url.protocol === 'https:' && isApprovedFixtureHost(url.hostname) &&
            url.pathname === '/frame-login' && typeof child.frame.id === 'string') leaves.push(child.frame.id)
      } catch {}
      visit(child)
    }
  }
  visit(frameTree)
  if (leaves.length === 0) return { childFormDetected: false, frameProbeSupported: false }
  let supported = true
  let detected = false
  for (const frameId of leaves) {
    try {
      const world = await session.send('Page.createIsolatedWorld', { frameId, worldName: 'vast-gate-readonly' })
      if (!Number.isSafeInteger(world?.executionContextId)) throw new Error('Missing frame context.')
      const response = await session.send('Runtime.evaluate', {
        expression: `Boolean(document.getElementById('gate-username') && document.getElementById('gate-password'))`,
        contextId: world.executionContextId, returnByValue: true
      })
      if (response?.exceptionDetails || typeof response?.result?.value !== 'boolean') throw new Error('Invalid frame probe result.')
      if (response.result.value) detected = true
    } catch { supported = false }
  }
  return Object.freeze({ childFormDetected: detected, frameProbeSupported: supported })
}

async function overlayButtonInFixtureDom(session, frameTree, extensionId) {
  const expression = `(() => {
    const expected = 'chrome-extension://${extensionId}/overlay/menu-button.html'
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'IFRAME' && element.getAttribute('src')?.startsWith(expected)) return true
        if (element.shadowRoot && visit(element.shadowRoot)) return true
      }
      return false
    }
    return visit(document)
  })()`
  if (await session.evaluate(expression) === true) return true
  const ids = []
  function visit(node) {
    for (const child of node?.childFrames || []) {
      try {
        const url = new URL(child.frame.url)
        if (url.protocol === 'https:' && isApprovedFixtureHost(url.hostname) &&
            typeof child.frame.id === 'string') ids.push(child.frame.id)
      } catch {}
      visit(child)
    }
  }
  visit(frameTree)
  for (const frameId of ids) {
    try {
      const world = await session.send('Page.createIsolatedWorld', { frameId, worldName: 'vast-gate-readonly' })
      if (!Number.isSafeInteger(world?.executionContextId)) continue
      const response = await session.send('Runtime.evaluate', {
        expression, contextId: world.executionContextId, returnByValue: true
      })
      if (!response?.exceptionDetails && response?.result?.value === true) return true
    } catch { /* OOPIF context may be unavailable during teardown */ }
  }
  return false
}

async function childFieldClickPoint(session, frameTree, fixture) {
  if (!EXPECTED_CHILD_PATHS[fixture] || fixture === 'same-origin-iframe') return null
  const pathToLeaf = []
  function find(node, ancestors = []) {
    for (const child of node?.childFrames || []) {
      try {
        const url = new URL(child.frame.url)
        if (url.protocol !== 'https:' || !isApprovedFixtureHost(url.hostname)) continue
        const chain = [...ancestors, child.frame.id]
        if (url.pathname === '/frame-login') { pathToLeaf.push(...chain); return true }
        if (find(child, chain)) return true
      } catch { /* ignore non-fixture frames */ }
    }
    return false
  }
  if (!find(frameTree) || pathToLeaf.length === 0) return null
  const offsetExpression = `(() => {
    const frame = document.getElementById('gate-frame') || document.getElementById('gate-dynamic-frame')
    if (!frame) return null
    const rect = frame.getBoundingClientRect()
    return { x: rect.x + frame.clientLeft, y: rect.y + frame.clientTop }
  })()`
  const fieldExpression = `(() => {
    const field = document.getElementById('gate-username')
    if (!field) return null
    const rect = field.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`
  let x = 0
  let y = 0
  for (let index = 0; index <= pathToLeaf.length; index++) {
    const expression = index === pathToLeaf.length ? fieldExpression : offsetExpression
    let value
    if (index === 0) value = await session.evaluate(expression)
    else {
      const world = await session.send('Page.createIsolatedWorld', {
        frameId: pathToLeaf[index - 1], worldName: 'vast-gate-readonly'
      })
      if (!Number.isSafeInteger(world?.executionContextId)) return null
      const response = await session.send('Runtime.evaluate', {
        expression, contextId: world.executionContextId, returnByValue: true
      })
      if (response?.exceptionDetails) return null
      value = response?.result?.value
    }
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y) ||
        value.x < 0 || value.y < 0 || value.x > 100_000 || value.y > 100_000) return null
    x += value.x
    y += value.y
  }
  return safeClickPoint({ fieldDetected: true, x, y })
}

function safeObservation({ fixture, host, route, focus, snapshot, overlayButtonCreated, overlayListCreated,
  childFrameCount = 0, expectedChildFramesLoaded = false, childFormDetected = false,
  frameProbeSupported = true }) {
  if (!SCAN_ROUTES.some(([name, approvedHost, approvedRoute]) => name === fixture && approvedHost === host && approvedRoute === route)) {
    throw new Error('Scan observation is not an approved fixture.')
  }
  const clean = snapshot === null ? null : cleanSnapshot(snapshot)
  if (clean && Object.keys(snapshot).sort().join(',') !== Object.keys(clean).sort().join(',')) {
    throw new Error('Scan snapshot contains fields outside the approved schema.')
  }
  if (clean && (clean.fixture !== fixture || clean.route !== route || new URL(clean.frameOrigin).hostname !== host)) {
    throw new Error('Scan snapshot belongs to a different fixture.')
  }
  if (typeof overlayButtonCreated !== 'boolean' || typeof overlayListCreated !== 'boolean') {
    throw new Error('Scan overlay observations must be booleans.')
  }
  if (!Number.isSafeInteger(childFrameCount) || childFrameCount < 0 || childFrameCount > 32 ||
      typeof expectedChildFramesLoaded !== 'boolean' || typeof childFormDetected !== 'boolean' ||
      typeof frameProbeSupported !== 'boolean') throw new Error('Scan frame summary is invalid.')
  return Object.freeze({ fixture, host, route, focus: safeFocus(focus),
    snapshot: clean, overlayButtonCreated, overlayListCreated,
    childFrameCount, expectedChildFramesLoaded, childFormDetected, frameProbeSupported })
}

async function listTargets(port, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Local debugger target list is invalid.')
  return targets
}

async function scanFixtures({ debuggerPort, fixturePort, extensionId, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (![debuggerPort, fixturePort].every((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535) ||
      typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('Scanner requires valid local debugger/fixture ports and an extension ID.')
  }
  const initialTargets = await listTargets(debuggerPort, fetchImpl)
  const page = initialTargets.find(approvedFixtureTarget)
  if (!page) throw new Error('No approved HTTPS fixture webview is available.')
  const session = await connect(page.webSocketDebuggerUrl)
  const observations = []
  try {
    await session.send('Page.enable')
    for (const [fixture, host, route] of SCAN_ROUTES) {
      const before = extensionOverlayIds(await listTargets(debuggerPort, fetchImpl), extensionId)
      const url = `https://${host}:${fixturePort}${route}`
      const navigation = await session.send('Page.navigate', { url })
      if (navigation?.errorText) throw new Error(`Fixture navigation failed for ${fixture}.`)
      let snapshot = null
      let ready = false
      for (let attempt = 0; attempt < 30; attempt++) {
        await wait(200)
        try {
          const raw = await session.evaluate('window.__vastGate.snapshot()')
          const candidate = cleanSnapshot(raw)
          if (candidate.fixture === fixture && candidate.route === route && new URL(candidate.frameOrigin).hostname === host) {
            snapshot = candidate
            ready = true
            break
          }
        } catch { /* navigation may temporarily destroy the execution context */ }
      }
      if (!ready) throw new Error(`Fixture ${fixture} did not become ready.`)
      if (fixture === 'delayed-login') await wait(1400)
      if (fixture === 'dynamic-iframe') await wait(700)
      let rawFocus
      for (let attempt = 0; attempt < 10; attempt++) {
        rawFocus = await session.evaluate(FOCUS_EXPRESSION)
        if (rawFocus?.fieldDetected || !shouldRetryMissingField(fixture)) break
        await wait(200)
      }
      const focus = safeFocus(rawFocus)
      let point = safeClickPoint(rawFocus)
      if (!point && EXPECTED_CHILD_PATHS[fixture]) {
        const preClickTree = await session.send('Page.getFrameTree')
        point = await childFieldClickPoint(session, preClickTree?.frameTree, fixture)
      }
      if (point) {
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point,
          button: 'left', buttons: 1, clickCount: 1 })
        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point,
          button: 'left', buttons: 0, clickCount: 1 })
      }
      let tree
      let overlayInDom = false
      let after = []
      let newOverlays = []
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(250)
        tree = await session.send('Page.getFrameTree')
        overlayInDom = await overlayButtonInFixtureDom(session, tree?.frameTree, extensionId)
        after = await listTargets(debuggerPort, fetchImpl)
        newOverlays = after.filter((target) => extensionOverlayIds([target], extensionId).has(target.id) && !before.has(target.id))
        if (overlayInDom || newOverlays.some((target) => target.url.endsWith('/menu-button.html'))) break
      }
      const frames = frameSummary(tree?.frameTree, fixture)
      const childFields = await inspectChildForms(session, tree?.frameTree, fixture)
      observations.push(safeObservation({ fixture, host, route, focus, snapshot,
        overlayButtonCreated: overlayInDom || newOverlays.some((target) => target.url.endsWith('/menu-button.html')),
        overlayListCreated: newOverlays.some((target) => target.url.endsWith('/menu-list.html')),
        ...frames, ...childFields }))
    }
    return Object.freeze(observations)
  } finally {
    session.close()
  }
}

async function scanStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const launcher = readJson(path.join(runRoot, 'launcher.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' || command.runId !== result.runId ||
      launcher.runId !== command.runId || status.status !== 'running' ||
      !Number.isSafeInteger(status.fixturePort) || !Number.isSafeInteger(status.debuggerPort)) {
    throw new Error('Scanner requires a live isolated Bitwarden gate.')
  }
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const observations = await scanFixtures({ debuggerPort: status.debuggerPort,
    fixturePort: status.fixturePort, extensionId })
  const artifact = Object.freeze({ schemaVersion: 1, runId: command.runId, mode: 'bitwarden',
    observedAt: new Date().toISOString(), observations })
  const output = path.join(runRoot, `fixture-scan-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, observations: observations.map(({ fixture, focus, overlayButtonCreated,
    overlayListCreated, childFrameCount, expectedChildFramesLoaded, childFormDetected,
    frameProbeSupported }) =>
    ({ fixture, ...focus, overlayButtonCreated, overlayListCreated,
      childFrameCount, expectedChildFramesLoaded, childFormDetected, frameProbeSupported })) }
}

function validateCompleteScan(artifact, runId) {
  if (artifact?.schemaVersion !== 1 || artifact.runId !== runId || artifact.mode !== 'bitwarden' ||
      !Number.isFinite(Date.parse(artifact.observedAt)) || !Array.isArray(artifact.observations) ||
      artifact.observations.length !== SCAN_ROUTES.length) throw new Error('Fixture scan artifact is incomplete.')
  for (let index = 0; index < SCAN_ROUTES.length; index++) {
    const [fixture, host, route] = SCAN_ROUTES[index]
    const item = artifact.observations[index]
    const safe = safeObservation(item)
    if (safe.fixture !== fixture || safe.host !== host || safe.route !== route ||
        !safe.overlayButtonCreated || !safe.frameProbeSupported ||
        (EXPECTED_CHILD_PATHS[fixture] && (!safe.expectedChildFramesLoaded || !safe.childFormDetected))) {
      throw new Error(`Fixture scan lacks Bitwarden field overlay evidence for ${fixture}.`)
    }
    if (Object.keys(item).sort().join(',') !== Object.keys(safe).sort().join(',')) {
      throw new Error('Fixture scan contains fields outside the approved schema.')
    }
  }
  return true
}

function recordFixtureScan(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' ||
      command.runId !== result.runId || status.status !== 'stopped' || result.status !== 'stopped') {
    throw new Error('Fixture scan recording requires a stopped isolated Bitwarden run.')
  }
  const names = fs.readdirSync(runRoot).filter((name) => /^fixture-scan-\d+-[a-f0-9]{8}\.json$/.test(name)).sort()
  if (names.length === 0) throw new Error('No fixture scan artifact exists.')
  const name = names.at(-1)
  const artifact = readJson(path.join(runRoot, name))
  validateCompleteScan(artifact, command.runId)
  const evidence = { id: name.slice(0, -5), observedAt: artifact.observedAt,
    fixtures: artifact.observations.map((item) => item.fixture) }
  if (result.scanEvidence && JSON.stringify(result.scanEvidence) !== JSON.stringify(evidence)) {
    throw new Error('Stored scan evidence conflicts with artifact.')
  }
  const scenarios = { ...result.scenarios }
  for (const id of ['content-script', 'field-detection']) {
    const scenario = scenarios[id]
    if (!scenario || !['blocked', 'pass'].includes(scenario.status) ||
        (scenario.status === 'pass' && !scenario.machineEvidence?.includes(evidence.id))) {
      throw new Error(`Scenario ${id} conflicts with fixture scan evidence.`)
    }
    scenarios[id] = scenario.status === 'pass' ? scenario : { ...scenario,
      status: 'pass', startedAt: evidence.observedAt, finishedAt: evidence.observedAt,
      machineEvidence: [evidence.id] }
  }
  writeJsonAtomic(resultPath, { ...result, scanEvidence: evidence, scenarios })
  return { status: 'pass', scenarios: ['content-script', 'field-detection'], evidenceId: evidence.id }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/scan-fixtures.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    const operation = process.argv[3] === '--record' ? Promise.resolve().then(() => recordFixtureScan(runRoot))
      : scanStoredRun(runRoot)
    operation.then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { approvedFixtureTarget, childFieldClickPoint, extensionOverlayIds, frameSummary, inspectChildForms,
  overlayButtonInFixtureDom,
  recordFixtureScan, safeFocus, safeObservation, scanFixtures, shouldRetryMissingField, validateCompleteScan }
