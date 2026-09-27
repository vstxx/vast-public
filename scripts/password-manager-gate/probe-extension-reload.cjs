#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession, capturePrivacyEvidenceFromWorker } = require('./controller.cjs')
const { verifyPrivacyEvidence } = require('./verify.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function mainPageTarget(targets) {
  const pages = targets.filter((target) => target?.type === 'page' &&
    typeof target.url === 'string' && target.url.startsWith('file://') &&
    typeof target.webSocketDebuggerUrl === 'string')
  if (pages.length !== 1) throw new Error('Expected exactly one Vast app page target.')
  return pages[0]
}

function extensionWorkerTarget(targets, extensionId) {
  return targets.find((target) => target?.type === 'service_worker' &&
    target.url === `chrome-extension://${extensionId}/background.js` && typeof target.id === 'string')
}

function reloadExpression(extensionId) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('Reload requires a canonical extension ID.')
  }
  return `(async () => {
    const api = window.vast?.extensions
    if (typeof api?.reload !== 'function') return { apiOk: false, identityPreserved: false, enabled: false }
    const response = await api.reload('${extensionId}')
    return {
      apiOk: response?.ok === true,
      identityPreserved: response?.extension?.id === '${extensionId}',
      enabled: response?.extension?.enabled === true
    }
  })()`
}

async function listTargets(port, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Local debugger target list is invalid.')
  return targets
}

async function probeExtensionReload({ debuggerPort, extensionId, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url),
  capturePrivacy = capturePrivacyEvidenceFromWorker,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65535) {
    throw new Error('Reload requires a local debugger port.')
  }
  const before = await listTargets(debuggerPort, fetchImpl)
  const page = mainPageTarget(before)
  const oldWorker = extensionWorkerTarget(before, extensionId)
  const session = await connect(page.webSocketDebuggerUrl)
  let apiResult
  try { apiResult = await session.evaluate(reloadExpression(extensionId)) } finally { session.close() }
  if (!apiResult || typeof apiResult !== 'object' || Array.isArray(apiResult) ||
      Object.keys(apiResult).sort().join(',') !== 'apiOk,enabled,identityPreserved' ||
      !['apiOk', 'enabled', 'identityPreserved'].every((key) => typeof apiResult[key] === 'boolean')) {
    throw new Error('Vast extension manager returned an unexpected reload result.')
  }
  let workerRecreated = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(200)
    const worker = extensionWorkerTarget(await listTargets(debuggerPort, fetchImpl), extensionId)
    if (worker && (!oldWorker || worker.id !== oldWorker.id)) { workerRecreated = true; break }
  }
  let privacyRecovered = false
  if (workerRecreated) {
    const privacy = await capturePrivacy({ port: debuggerPort, extensionId, fetchImpl })
    privacyRecovered = verifyPrivacyEvidence(privacy).passed === true
  }
  return Object.freeze({ apiOk: apiResult.apiOk, identityPreserved: apiResult.identityPreserved,
    enabled: apiResult.enabled, workerRecreated, privacyRecovered,
    outcome: apiResult.apiOk && apiResult.identityPreserved && apiResult.enabled && workerRecreated && privacyRecovered
      ? 'reload-and-worker-recovered' : 'reload-incomplete' })
}

async function probeStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const launcher = readJson(path.join(runRoot, 'launcher.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' || command.runId !== result.runId ||
      launcher.runId !== command.runId || status.status !== 'running' ||
      !Number.isSafeInteger(status.debuggerPort)) throw new Error('Probe requires a live isolated Bitwarden gate.')
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const observation = await probeExtensionReload({ debuggerPort: status.debuggerPort, extensionId })
  const artifact = Object.freeze({ schemaVersion: 1, runId: command.runId, mode: 'bitwarden',
    observedAt: new Date().toISOString(), extensionId, ...observation })
  const output = path.join(runRoot, `extension-reload-probe-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, ...observation }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-extension-reload.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    probeStoredRun(runRoot).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { extensionWorkerTarget, mainPageTarget, probeExtensionReload, reloadExpression }
