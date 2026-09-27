#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { cleanSnapshot } = require('./cdp.cjs')
const { approvedFixtureTarget, extensionOverlayIds } = require('./scan-fixtures.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

async function targets(port, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const value = await response.json()
  if (!Array.isArray(value)) throw new Error('Local debugger target list is invalid.')
  return value
}

async function probeSpaRoute({ debuggerPort, fixturePort, extensionId, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (![debuggerPort, fixturePort].every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535) ||
      !/^[a-p]{32}$/.test(extensionId)) throw new Error('SPA probe requires valid local ports and an extension ID.')
  const page = (await targets(debuggerPort, fetchImpl)).find(approvedFixtureTarget)
  if (!page) throw new Error('No approved HTTPS fixture webview is available.')
  const session = await connect(page.webSocketDebuggerUrl)
  try {
    await session.send('Page.enable')
    const url = `https://spa.vast-test.local:${fixturePort}/spa`
    const navigation = await session.send('Page.navigate', { url })
    if (navigation?.errorText) throw new Error('SPA fixture navigation failed.')
    let initial
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(200)
      try {
        initial = cleanSnapshot(await session.evaluate('window.__vastGate.snapshot()'))
        if (initial.fixture === 'spa-login' && initial.route === '/spa') break
      } catch { /* navigation may replace the execution context */ }
    }
    if (initial?.fixture !== 'spa-login' || initial.route !== '/spa' ||
        new URL(initial.frameOrigin).hostname !== 'spa.vast-test.local') throw new Error('SPA fixture did not become ready.')
    const beforeFrame = (await session.send('Page.getFrameTree'))?.frameTree?.frame?.id
    if (typeof beforeFrame !== 'string' || !beforeFrame) throw new Error('SPA top frame is unavailable.')
    const marker = randomUUID()
    const before = extensionOverlayIds(await targets(debuggerPort, fetchImpl), extensionId)
    const transition = await session.evaluate(`(() => {
      globalThis.__vastGateRouteProbe = ${JSON.stringify(marker)}
      const previous = document.getElementById('gate-username')
      window.__vastGate.navigate('/spa/route-two')
      const field = document.getElementById('gate-username')
      const rect = field?.getBoundingClientRect()
      return {
        documentPreserved: globalThis.__vastGateRouteProbe === ${JSON.stringify(marker)},
        formReplaced: Boolean(previous && field && previous !== field),
        routeChanged: location.pathname === '/spa/route-two',
        x: rect ? rect.x + rect.width / 2 : null,
        y: rect ? rect.y + rect.height / 2 : null
      }
    })()`)
    if (!transition || !Number.isFinite(transition.x) || !Number.isFinite(transition.y) ||
        transition.x < 0 || transition.y < 0 || transition.x > 100_000 || transition.y > 100_000) {
      throw new Error('SPA route produced invalid fixture click geometry.')
    }
    for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: transition.x, y: transition.y, button: 'left', buttons, clickCount: 1
      })
    }
    let after = []
    let overlayCreated = false
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(250)
      after = await targets(debuggerPort, fetchImpl)
      overlayCreated = after.some((target) => extensionOverlayIds([target], extensionId).has(target.id) &&
        !before.has(target.id) && target.url.endsWith('/menu-button.html'))
      if (overlayCreated) break
    }
    const afterFrame = (await session.send('Page.getFrameTree'))?.frameTree?.frame?.id
    const snapshot = cleanSnapshot(await session.evaluate('window.__vastGate.snapshot()'))
    const markerPreserved = await session.evaluate(`globalThis.__vastGateRouteProbe === ${JSON.stringify(marker)}`)
    return Object.freeze({ documentPreserved: transition.documentPreserved === true && markerPreserved === true &&
      beforeFrame === afterFrame, formReplaced: transition.formReplaced === true,
      routeChanged: transition.routeChanged === true && snapshot.route === '/spa/route-two' &&
        snapshot.fixture === 'spa-login' && new URL(snapshot.frameOrigin).hostname === 'spa.vast-test.local',
      overlayCreated })
  } finally {
    session.close()
  }
}

async function probeStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' || command.runId !== result.runId ||
      status.status !== 'running' || !Number.isSafeInteger(status.debuggerPort) ||
      !Number.isSafeInteger(status.fixturePort)) throw new Error('SPA probe requires a live isolated Bitwarden gate.')
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const observation = await probeSpaRoute({ debuggerPort: status.debuggerPort,
    fixturePort: status.fixturePort, extensionId })
  const artifact = { schemaVersion: 1, runId: command.runId, mode: 'bitwarden',
    observedAt: new Date().toISOString(), ...observation }
  const output = path.join(runRoot, `spa-route-probe-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, observation }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-spa-route.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    probeStoredRun(runRoot).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { probeSpaRoute }
