#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { evaluateExtensionExpression } = require('./extension-context.cjs')
const { extensionWorkerTarget, mainPageTarget, reloadExpression } = require('./probe-extension-reload.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

async function listTargets(port, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Local debugger target list is invalid.')
  return targets
}

function safeManagerResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'apiOk,enabled,identityPreserved' ||
      !['apiOk', 'enabled', 'identityPreserved'].every((key) => typeof value[key] === 'boolean')) {
    throw new Error('Vast extension manager returned an unexpected reload result.')
  }
  return value
}

async function workerIdentity(worker, extensionId, version,
  connect = (url) => WorkerCdpSession.connect(url),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (typeof worker?.webSocketDebuggerUrl !== 'string') return false
  const session = await connect(worker.webSocketDebuggerUrl)
  try {
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        const value = await evaluateExtensionExpression(session, `(() => ({
          runtimeIdMatches: chrome.runtime.id === ${JSON.stringify(extensionId)},
          versionMatches: chrome.runtime.getManifest().version === ${JSON.stringify(version)}
        }))()`)
        return value?.runtimeIdMatches === true && value?.versionMatches === true
      } catch (error) {
        if (!/extension (?:execution context is unavailable|context evaluation failed)/i.test(error?.message ?? '') || attempt === 24) throw error
        await wait(200)
      }
    }
    return false
  } finally { session.close() }
}

async function probeProtonReload({ debuggerPort, extensionId, version, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65535 ||
      !/^[a-p]{32}$/.test(extensionId) || typeof version !== 'string' || !version) {
    throw new Error('Proton reload probe requires a debugger port, canonical ID and version.')
  }
  const before = await listTargets(debuggerPort, fetchImpl)
  const page = mainPageTarget(before)
  const oldWorker = extensionWorkerTarget(before, extensionId)
  const session = await connect(page.webSocketDebuggerUrl)
  let manager
  try { manager = safeManagerResult(await session.evaluate(reloadExpression(extensionId))) } finally { session.close() }
  let worker
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(200)
    const candidate = extensionWorkerTarget(await listTargets(debuggerPort, fetchImpl), extensionId)
    if (candidate && (!oldWorker || candidate.id !== oldWorker.id)) { worker = candidate; break }
  }
  const workerRecreated = Boolean(worker)
  const runtimeIdentityRecovered = workerRecreated &&
    await workerIdentity(worker, extensionId, version, connect, wait)
  const passed = manager.apiOk && manager.identityPreserved && manager.enabled &&
    workerRecreated && runtimeIdentityRecovered
  return Object.freeze({
    apiOk: manager.apiOk,
    identityPreserved: manager.identityPreserved,
    enabled: manager.enabled,
    workerRecreated,
    runtimeIdentityRecovered,
    outcome: passed ? 'reload-and-worker-identity-recovered' : 'reload-incomplete',
    passed
  })
}

function protonReloadRunMode(command, result, launcher, status) {
  const mode = command?.mode
  if (!['proton', 'combined'].includes(mode) || result?.mode !== mode || command?.runId !== result?.runId ||
      launcher?.runId !== command?.runId || status?.status !== 'running') {
    throw new Error('Probe requires a live Proton or combined gate with matching run identity.')
  }
  return mode
}

async function probeStoredRun(runId, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.')
  const root = options.root || path.resolve(__dirname, '..', '..')
  const runRoot = path.join(root, '.vast-build', 'password-manager-gates', 'runs', runId)
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const launcher = readJson(path.join(runRoot, 'launcher.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  const mode = protonReloadRunMode(command, result, launcher, status)
  const extension = result.extensions?.find((item) => item.key === 'protonpass')
  if (!extension) throw new Error('Proton extension metadata is missing.')
  const observation = await probeProtonReload({
    debuggerPort: status.debuggerPort,
    extensionId: extension.runtimeId,
    version: extension.version,
    ...options.probeOptions
  })
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `proton-reload-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId,
    mode,
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
    console.error('Usage: node probe-proton-reload.cjs <proton-or-combined-run-id>')
    process.exitCode = 1
  } else probeStoredRun(runId)
    .then((artifact) => process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { probeProtonReload, protonReloadRunMode, safeManagerResult, workerIdentity }
