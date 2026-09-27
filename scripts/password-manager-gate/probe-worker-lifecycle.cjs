#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession, capturePrivacyEvidenceFromWorker } = require('./controller.cjs')
const { verifyPrivacyEvidence } = require('./verify.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

async function targets(port, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response?.ok) throw new Error('Local debugger targets are unavailable.')
  const value = await response.json()
  if (!Array.isArray(value)) throw new Error('Local debugger target list is invalid.')
  return value
}

function workerTarget(targetsList, extensionId) {
  const url = `chrome-extension://${extensionId}/background.js`
  return targetsList.find((item) => item?.type === 'service_worker' && item.url === url &&
    typeof item.id === 'string')
}

function approvedWebview(target) {
  if (target?.type !== 'webview' || typeof target.url !== 'string' ||
      typeof target.webSocketDebuggerUrl !== 'string') return false
  try {
    const url = new URL(target.url)
    return url.protocol === 'https:' && isApprovedFixtureHost(url.hostname)
  } catch { return false }
}

async function browserSession(debuggerPort, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket) {
  const response = await fetchImpl(`http://127.0.0.1:${debuggerPort}/json/version`)
  if (!response?.ok) throw new Error('Local debugger browser endpoint is unavailable.')
  const version = await response.json()
  const url = version?.webSocketDebuggerUrl
  if (typeof url !== 'string' || !url.startsWith(`ws://127.0.0.1:${debuggerPort}/devtools/browser/`)) {
    throw new Error('Unexpected browser debugger endpoint.')
  }
  const socket = new WebSocketImpl(url)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser debugger connection timed out.')), 5000)
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Browser debugger connection failed.')) }, { once: true })
  })
  return new WorkerCdpSession(socket)
}

async function waitForWorkerVersion(session, extensionId, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let versionId
  const unsubscribe = session.on('ServiceWorker.workerVersionUpdated', (params) => {
    const expected = `chrome-extension://${extensionId}/background.js`
    const version = params.versions?.find((item) => item.scriptURL === expected &&
      typeof item.versionId === 'string' && item.runningStatus === 'running')
    if (version) versionId = version.versionId
  })
  try {
    await session.send('ServiceWorker.enable')
    for (let attempt = 0; attempt < 25 && !versionId; attempt++) await wait(200)
    return versionId
  } finally { unsubscribe() }
}

async function probeWorkerLifecycle({ debuggerPort, extensionId, fetchImpl = globalThis.fetch,
  connectBrowser = browserSession, connectPage = (url) => WorkerCdpSession.connect(url),
  capturePrivacy = capturePrivacyEvidenceFromWorker,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65535 ||
      typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('Worker probe requires a local debugger port and canonical extension ID.')
  }
  const before = await targets(debuggerPort, fetchImpl)
  const worker = workerTarget(before, extensionId)
  const page = before.find(approvedWebview)
  if (!worker || !page) throw new Error('Approved fixture page and target extension worker must both be running.')
  let control = await connectBrowser(debuggerPort, fetchImpl)
  let versionId
  let workerStopped = false
  let stopEventObserved = false
  let unsubscribeStop = () => {}
  try {
    try {
      versionId = await waitForWorkerVersion(control, extensionId, wait)
    } catch (error) {
      if (error?.message !== 'CDP ServiceWorker.enable failed.') throw error
      control.close()
      control = await connectPage(page.webSocketDebuggerUrl)
      versionId = await waitForWorkerVersion(control, extensionId, wait)
    }
    if (!versionId) return { outcome: 'worker-version-unavailable', workerStopped: false, workerWoke: false, privacyRecovered: false }
    unsubscribeStop = control.on('ServiceWorker.workerVersionUpdated', (params) => {
      if (params.versions?.some((version) => version.versionId === versionId &&
          version.scriptURL === `chrome-extension://${extensionId}/background.js` &&
          version.runningStatus === 'stopped')) stopEventObserved = true
    })
    await control.send('ServiceWorker.stopWorker', { versionId })
    for (let attempt = 0; attempt < 25; attempt++) {
      await wait(200)
      const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
      if (stopEventObserved || !current || current.id !== worker.id) { workerStopped = true; break }
    }
  } finally { unsubscribeStop(); control.close() }
  if (!workerStopped) return { outcome: 'worker-stop-not-observed', workerStopped: false, workerWoke: false, privacyRecovered: false }
  const pageSession = await connectPage(page.webSocketDebuggerUrl)
  try { await pageSession.send('Page.reload', { ignoreCache: true }) } finally { pageSession.close() }
  let workerWoke = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(200)
    const newWorker = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
    if (newWorker && newWorker.id !== worker.id) { workerWoke = true; break }
  }
  if (!workerWoke) return { outcome: 'worker-did-not-wake-on-navigation', workerStopped: true,
    workerWoke: false, privacyRecovered: false }
  const privacy = await capturePrivacy({ port: debuggerPort, extensionId, fetchImpl })
  const privacyRecovered = verifyPrivacyEvidence(privacy).passed === true
  return { outcome: privacyRecovered ? 'wake-and-privacy-recovered' : 'wake-without-privacy-evidence',
    workerStopped: true, workerWoke: true, privacyRecovered }
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
  const observation = await probeWorkerLifecycle({ debuggerPort: status.debuggerPort, extensionId })
  const artifact = Object.freeze({ schemaVersion: 1, runId: command.runId, mode: 'bitwarden',
    observedAt: new Date().toISOString(), extensionId, ...observation })
  const output = path.join(runRoot, `worker-lifecycle-probe-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, ...observation }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-worker-lifecycle.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    probeStoredRun(runRoot).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { approvedWebview, browserSession, probeWorkerLifecycle, waitForWorkerVersion, workerTarget }
