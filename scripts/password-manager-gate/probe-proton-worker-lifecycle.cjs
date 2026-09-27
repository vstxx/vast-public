#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { workerIdentity } = require('./probe-proton-reload.cjs')
const { approvedWebview, browserSession, waitForWorkerVersion, workerTarget } = require('./probe-worker-lifecycle.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

async function targets(port, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger targets are unavailable.')
  const value = await response.json()
  if (!Array.isArray(value)) throw new Error('Local debugger target list is invalid.')
  return value
}

async function probeProtonWorkerLifecycle({ debuggerPort, extensionId, version,
  fetchImpl = globalThis.fetch,
  connectBrowser = browserSession,
  connectPage = (url) => WorkerCdpSession.connect(url),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65535 ||
      !/^[a-p]{32}$/.test(extensionId) || typeof version !== 'string' || !version) {
    throw new Error('Proton worker probe requires a debugger port, canonical ID and version.')
  }
  const before = await targets(debuggerPort, fetchImpl)
  const worker = workerTarget(before, extensionId)
  const page = before.find(approvedWebview)
  if (!worker || !page) throw new Error('Approved fixture page and Proton worker must both be running.')
  let control = await connectBrowser(debuggerPort, fetchImpl)
  let versionId
  let stopEventObserved = false
  let unsubscribe = () => {}
  try {
    try {
      versionId = await waitForWorkerVersion(control, extensionId, wait)
    } catch (error) {
      if (error?.message !== 'CDP ServiceWorker.enable failed.') throw error
      control.close()
      control = await connectPage(page.webSocketDebuggerUrl)
      versionId = await waitForWorkerVersion(control, extensionId, wait)
    }
    if (!versionId) return Object.freeze({ outcome: 'worker-version-unavailable',
      workerStopped: false, workerWoke: false, runtimeIdentityRecovered: false, passed: false })
    unsubscribe = control.on('ServiceWorker.workerVersionUpdated', (params) => {
      if (params.versions?.some((item) => item.versionId === versionId &&
          item.scriptURL === `chrome-extension://${extensionId}/background.js` &&
          item.runningStatus === 'stopped')) stopEventObserved = true
    })
    await control.send('ServiceWorker.stopWorker', { versionId })
    let workerStopped = false
    for (let attempt = 0; attempt < 25; attempt++) {
      await wait(200)
      const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
      if (stopEventObserved || !current || current.id !== worker.id) { workerStopped = true; break }
    }
    if (!workerStopped) return Object.freeze({ outcome: 'worker-stop-not-observed',
      workerStopped: false, workerWoke: false, runtimeIdentityRecovered: false, passed: false })
  } finally { unsubscribe(); control.close() }

  const pageSession = await connectPage(page.webSocketDebuggerUrl)
  try { await pageSession.send('Page.reload', { ignoreCache: true }) } finally { pageSession.close() }
  let newWorker
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(200)
    const candidate = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
    if (candidate && candidate.id !== worker.id) { newWorker = candidate; break }
  }
  const workerWoke = Boolean(newWorker)
  let runtimeIdentityRecovered = false
  if (workerWoke) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
      try {
        if (current && await workerIdentity(current, extensionId, version, connectPage)) {
          runtimeIdentityRecovered = true
          break
        }
      } catch { /* a newly-created worker target may not have an execution context yet */ }
      await wait(200)
    }
  }
  const passed = workerWoke && runtimeIdentityRecovered
  return Object.freeze({
    outcome: passed ? 'worker-woke-and-identity-recovered' : 'worker-wake-incomplete',
    workerStopped: true,
    workerWoke,
    runtimeIdentityRecovered,
    passed
  })
}

async function probeStoredRun(runId, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.')
  const root = options.root || path.resolve(__dirname, '..', '..')
  const runRoot = path.join(root, '.vast-build', 'password-manager-gates', 'runs', runId)
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const launcher = readJson(path.join(runRoot, 'launcher.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'proton' || result.mode !== 'proton' || command.runId !== result.runId ||
      launcher.runId !== command.runId || status.status !== 'running') {
    throw new Error('Probe requires a live isolated Proton gate.')
  }
  const extension = result.extensions?.find((item) => item.key === 'protonpass')
  if (!extension) throw new Error('Proton extension metadata is missing.')
  const observation = await probeProtonWorkerLifecycle({
    debuggerPort: status.debuggerPort,
    extensionId: extension.runtimeId,
    version: extension.version,
    ...options.probeOptions
  })
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `proton-worker-lifecycle-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId,
    mode: 'proton',
    observedAt: new Date().toISOString(),
    extensionId: extension.runtimeId,
    version: extension.version,
    ...observation
  })
  writeJsonAtomic(path.join(runRoot, `${artifact.id}.json`), artifact)
  return artifact
}

if (require.main === module) {
  const runId = process.argv[2]
  if (!runId) {
    console.error('Usage: node probe-proton-worker-lifecycle.cjs <run-id>')
    process.exitCode = 1
  } else probeStoredRun(runId)
    .then((artifact) => process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { probeProtonWorkerLifecycle }
