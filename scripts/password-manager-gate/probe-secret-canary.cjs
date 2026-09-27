#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, createHash, randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { WorkerCdpSession } = require('./controller.cjs')
const { approvedFixtureTarget } = require('./scan-fixtures.cjs')
const { assertArtifactHasNoSecrets } = require('./redaction.cjs')
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

async function exposeUrlCanary({ debuggerPort, fixturePort, canary, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (![debuggerPort, fixturePort].every((port) => Number.isSafeInteger(port) && port > 0 && port <= 65535) ||
      typeof canary !== 'string' || !/^VAST_GATE_CANARY_[a-f0-9]{48}$/.test(canary)) {
    throw new Error('Canary probe parameters are invalid.')
  }
  const page = (await targets(debuggerPort, fetchImpl)).find(approvedFixtureTarget)
  if (!page) throw new Error('No approved HTTPS fixture webview is available.')
  const session = await connect(page.webSocketDebuggerUrl)
  const base = `https://login.vast-test.local:${fixturePort}/login`
  let seen = false
  try {
    const navigation = await session.send('Page.navigate', { url: `${base}?gate_canary=${canary}` })
    if (navigation?.errorText) throw new Error('Controlled canary navigation failed.')
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(100)
      const current = await targets(debuggerPort, fetchImpl)
      seen = current.some((target) => {
        if (target?.id !== page.id || target.type !== 'webview') return false
        try {
          const url = new URL(target.url)
          return url.origin === `https://login.vast-test.local:${fixturePort}` &&
            url.pathname === '/login' && url.searchParams.get('gate_canary') === canary
        } catch { return false }
      })
      if (seen) break
    }
  } finally {
    try { await session.send('Page.navigate', { url: base }) } finally { session.close() }
  }
  if (!seen) throw new Error('Controlled canary URL was not observed in the fixture target.')
  return true
}

async function waitForStopped(runRoot, backgroundRoot, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await wait(200)
    const status = readJson(path.join(runRoot, 'status.json'))
    const exitPath = path.join(backgroundRoot, 'exit-code')
    if (status.status === 'stopped' && fs.existsSync(exitPath)) {
      if (fs.readFileSync(exitPath, 'utf8').trim() !== '0') throw new Error('Gate controller did not exit successfully.')
      return
    }
  }
  throw new Error('Gate did not stop within the canary verification timeout.')
}

function verifyCanaryArtifacts({ runRoot, backgroundRoot, canary }) {
  assertArtifactHasNoSecrets(runRoot, [canary])
  for (const name of ['process.log', 'process-error.log']) {
    assertArtifactHasNoSecrets(path.join(backgroundRoot, name), [canary])
  }
  return true
}

async function probeStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (!['bitwarden', 'proton', 'combined'].includes(command.mode) || result.mode !== command.mode ||
      command.runId !== result.runId || status.status !== 'running' ||
      !Number.isSafeInteger(status.debuggerPort) || !Number.isSafeInteger(status.fixturePort)) {
    throw new Error('Canary probe requires a live isolated or combined gate.')
  }
  const backgroundRoot = path.join(path.dirname(path.dirname(runRoot)), 'background', command.mode)
  const background = readJson(path.join(backgroundRoot, 'launcher.json'))
  if (fs.readFileSync(path.join(backgroundRoot, 'status'), 'utf8').trim() !== 'running' ||
      !Number.isSafeInteger(background.controllerPid) || background.controllerPid <= 0 ||
      !fs.readFileSync(path.join(backgroundRoot, 'process.log'), 'utf8')
        .includes(`"runId": "${command.runId}"`)) {
    throw new Error('Canary probe requires the matching live background wrapper.')
  }
  const canary = `VAST_GATE_CANARY_${randomBytes(24).toString('hex')}`
  await exposeUrlCanary({ debuggerPort: status.debuggerPort, fixturePort: status.fixturePort, canary })
  const stop = spawnSync(process.execPath, [path.join(__dirname, '..', 'password-manager-gate.cjs'),
    'stop', command.mode, '--run-id', command.runId], { encoding: 'utf8', shell: false,
    windowsHide: true, timeout: 10_000 })
  if (stop.error || stop.status !== 0) throw new Error('Could not stop gate for final canary artifact scan.')
  await waitForStopped(runRoot, backgroundRoot)
  verifyCanaryArtifacts({ runRoot, backgroundRoot, canary })
  const evidence = { id: `secret-canary-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId: command.runId, mode: command.mode, observedAt: new Date().toISOString(),
    canarySha256: createHash('sha256').update(canary).digest('hex'),
    probeUrlSeen: true, runArtifactsScanned: true, processLogsScanned: true,
    leakFound: false }
  writeJsonAtomic(path.join(runRoot, `${evidence.id}.json`), evidence)
  const stoppedResult = readJson(resultPath)
  if (stoppedResult.runId !== command.runId || stoppedResult.status !== 'stopped') {
    throw new Error('Stopped gate result changed identity during canary scan.')
  }
  writeJsonAtomic(resultPath, { ...stoppedResult, secretCanaryLeak: false, secretCanaryEvidence: evidence })
  return { status: 'pass', runId: command.runId, evidenceId: evidence.id }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-secret-canary.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    probeStoredRun(runRoot).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { exposeUrlCanary, verifyCanaryArtifacts }
