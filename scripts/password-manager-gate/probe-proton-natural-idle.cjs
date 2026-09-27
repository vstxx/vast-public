#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { workerIdentity } = require('./probe-proton-reload.cjs')
const { approvedWebview, workerTarget } = require('./probe-worker-lifecycle.cjs')
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

async function probeProtonNaturalIdle({ debuggerPort, extensionId, version,
  fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 180_000,
  pollMs = 500 }) {
  const initialTargets = await targets(debuggerPort, fetchImpl)
  let initialWorker = workerTarget(initialTargets, extensionId)
  const page = initialTargets.find(approvedWebview)
  if (!page) throw new Error('An approved fixture page must be running.')
  if (!initialWorker) {
    const pageSession = await connect(page.webSocketDebuggerUrl)
    try { await pageSession.send('Page.reload', { ignoreCache: true }) } finally { pageSession.close() }
    for (let attempt = 0; attempt < 50; attempt++) {
      await wait(200)
      initialWorker = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
      if (initialWorker) break
    }
  }
  if (!initialWorker) throw new Error('Proton worker did not wake for the natural-idle baseline.')
  const started = Date.now()
  let idleObserved = false
  let replacement
  while (Date.now() - started < timeoutMs) {
    await wait(pollMs)
    const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
    if (!current || current.id !== initialWorker.id) {
      idleObserved = true
      replacement = current
      break
    }
  }
  if (!idleObserved) return Object.freeze({ outcome: 'natural-idle-not-observed', idleObserved: false,
    workerWoke: false, runtimeIdentityRecovered: false, waitedMs: Date.now() - started, passed: false })
  if (!replacement) {
    const pageSession = await connect(page.webSocketDebuggerUrl)
    try { await pageSession.send('Page.reload', { ignoreCache: true }) } finally { pageSession.close() }
  }
  let workerWoke = Boolean(replacement)
  let runtimeIdentityRecovered = false
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
    if (current && current.id !== initialWorker.id) {
      workerWoke = true
      try {
        if (await workerIdentity(current, extensionId, version, connect)) {
          runtimeIdentityRecovered = true
          break
        }
      } catch { /* target may precede its execution context */ }
    }
    await wait(200)
  }
  const passed = idleObserved && workerWoke && runtimeIdentityRecovered
  return Object.freeze({
    outcome: passed ? 'natural-idle-wake-and-identity-recovered' : 'natural-idle-wake-incomplete',
    idleObserved,
    workerWoke,
    runtimeIdentityRecovered,
    waitedMs: Date.now() - started,
    passed
  })
}

async function probeStoredRun(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.')
  const root = path.resolve(__dirname, '..', '..')
  const runRoot = path.join(root, '.vast-build', 'password-manager-gates', 'runs', runId)
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (status.status !== 'running' || result.mode !== 'proton') throw new Error('Probe requires a live isolated Proton gate.')
  const extension = result.extensions?.find((item) => item.key === 'protonpass')
  const observation = await probeProtonNaturalIdle({
    debuggerPort: status.debuggerPort,
    extensionId: extension.runtimeId,
    version: extension.version
  })
  const artifact = Object.freeze({ schemaVersion: 1,
    id: `proton-natural-idle-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId, mode: 'proton', observedAt: new Date().toISOString(),
    extensionId: extension.runtimeId, version: extension.version, ...observation })
  writeJsonAtomic(path.join(runRoot, `${artifact.id}.json`), artifact)
  return artifact
}

if (require.main === module) {
  const runId = process.argv[2]
  probeStoredRun(runId)
    .then((artifact) => process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { probeProtonNaturalIdle }
