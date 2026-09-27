#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession, capturePrivacyEvidenceFromWorker } = require('./controller.cjs')
const { workerTarget, approvedWebview } = require('./probe-worker-lifecycle.cjs')
const { verifyPrivacyEvidence } = require('./verify.cjs')
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

async function probeNaturalIdle({ debuggerPort, extensionId, maxWaitMs = 45_000,
  fetchImpl = globalThis.fetch, connectPage = (url) => WorkerCdpSession.connect(url),
  capturePrivacy = capturePrivacyEvidenceFromWorker,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(debuggerPort) || debuggerPort < 1 || debuggerPort > 65535 ||
      !/^[a-p]{32}$/.test(extensionId) || !Number.isSafeInteger(maxWaitMs) ||
      maxWaitMs < 1_000 || maxWaitMs > 300_000) throw new Error('Natural idle probe parameters are invalid.')
  const initial = await targets(debuggerPort, fetchImpl)
  const worker = workerTarget(initial, extensionId)
  const page = initial.find(approvedWebview)
  if (!worker || !page) throw new Error('Approved fixture page and target worker must both be running.')
  let idleObserved = false
  let elapsed = 0
  while (elapsed < maxWaitMs) {
    await wait(500)
    elapsed += 500
    if (!workerTarget(await targets(debuggerPort, fetchImpl), extensionId)) { idleObserved = true; break }
  }
  if (!idleObserved) return { outcome: 'idle-not-observed', idleObserved: false,
    workerWoke: false, privacyRecovered: false, waitedMs: elapsed }
  const session = await connectPage(page.webSocketDebuggerUrl)
  try { await session.send('Page.reload', { ignoreCache: true }) } finally { session.close() }
  let workerWoke = false
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(500)
    const current = workerTarget(await targets(debuggerPort, fetchImpl), extensionId)
    if (current && current.id !== worker.id) { workerWoke = true; break }
  }
  if (!workerWoke) return { outcome: 'idle-worker-did-not-wake', idleObserved: true,
    workerWoke: false, privacyRecovered: false, waitedMs: elapsed }
  const privacy = await capturePrivacy({ port: debuggerPort, extensionId, fetchImpl })
  const privacyRecovered = verifyPrivacyEvidence(privacy).passed === true
  return { outcome: privacyRecovered ? 'idle-wake-and-privacy-recovered' : 'idle-wake-without-privacy-evidence',
    idleObserved: true, workerWoke: true, privacyRecovered, waitedMs: elapsed }
}

async function probeStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' || command.runId !== result.runId ||
      status.status !== 'running' || !Number.isSafeInteger(status.debuggerPort)) {
    throw new Error('Natural idle probe requires a live isolated Bitwarden gate.')
  }
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const observation = await probeNaturalIdle({ debuggerPort: status.debuggerPort, extensionId })
  const artifact = { schemaVersion: 1, runId: command.runId, mode: 'bitwarden',
    observedAt: new Date().toISOString(), extensionId, ...observation }
  const output = path.join(runRoot, `worker-natural-idle-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  writeJsonAtomic(output, artifact)
  return { artifact: output, observation }
}

function recordNaturalIdle(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const resultPath = path.join(runRoot, 'result.json')
  const result = readJson(resultPath)
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' ||
      command.runId !== result.runId || status.status !== 'stopped' || result.status !== 'stopped') {
    throw new Error('Natural idle recording requires a stopped isolated Bitwarden run.')
  }
  const names = fs.readdirSync(runRoot).filter((name) => /^worker-natural-idle-\d+-[a-f0-9]{8}\.json$/.test(name)).sort()
  const id = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  const successful = names.map((name) => ({ name, artifact: readJson(path.join(runRoot, name)) }))
    .filter(({ artifact }) => artifact?.outcome === 'idle-wake-and-privacy-recovered')
  if (successful.length !== 1) throw new Error('Exactly one successful natural idle artifact is required.')
  const { name, artifact } = successful[0]
  const allowed = ['extensionId', 'idleObserved', 'mode', 'observedAt', 'outcome',
    'privacyRecovered', 'runId', 'schemaVersion', 'waitedMs', 'workerWoke']
  if (!artifact || Object.keys(artifact).sort().join(',') !== allowed.sort().join(',') ||
      artifact.schemaVersion !== 1 || artifact.mode !== 'bitwarden' || artifact.runId !== command.runId ||
      artifact.extensionId !== id || !/^[a-p]{32}$/.test(id) ||
      !Number.isFinite(Date.parse(artifact.observedAt)) ||
      !['idleObserved', 'workerWoke', 'privacyRecovered'].every((key) => artifact[key] === true) ||
      !Number.isSafeInteger(artifact.waitedMs) || artifact.waitedMs < 500 || artifact.waitedMs > 45_000) {
    throw new Error('Natural idle artifact is incomplete or outside its safe schema.')
  }
  const events = fs.readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8').trimEnd().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line))
  const workerUrl = `chrome-extension://${id}/background.js`
  const completedAt = Date.parse(artifact.observedAt)
  const nearby = events.filter((event) => Number.isSafeInteger(event.sequence) &&
    typeof event.at === 'string' && Date.parse(event.at) >= completedAt - 15_000 &&
    Date.parse(event.at) <= completedAt)
  const destroyed = nearby.find((event) => event.event === 'target-destroyed' &&
    event.contextType === 'service_worker' && event.url === workerUrl && typeof event.targetId === 'string')
  const created = destroyed && nearby.find((event) => event.event === 'target-created' &&
    event.contextType === 'service_worker' && event.url === workerUrl &&
    typeof event.targetId === 'string' && event.targetId !== destroyed.targetId &&
    event.sequence > destroyed.sequence)
  if (!created || nearby.some((event) => event.event === 'process-diagnostic' &&
      event.errorClass === 'ProcessCrash' && event.sequence >= destroyed.sequence &&
      event.sequence <= created.sequence)) {
    throw new Error('Natural idle lacks ordered worker lifecycle evidence without a crash.')
  }
  const evidence = { id: name.slice(0, -5), extensionId: id, observedAt: artifact.observedAt,
    destroySequence: destroyed.sequence, createSequence: created.sequence,
    idleObserved: true, workerWoke: true, privacyRecovered: true }
  const scenario = result.scenarios?.['worker-sleep-wake']
  if (!scenario || !['blocked', 'pass'].includes(scenario.status) ||
      (scenario.status === 'pass' && !scenario.machineEvidence?.includes(evidence.id))) {
    throw new Error('Worker lifecycle scenario conflicts with natural idle evidence.')
  }
  if (result.idleEvidence && JSON.stringify(result.idleEvidence) !== JSON.stringify(evidence)) {
    throw new Error('Stored natural idle evidence conflicts with artifact.')
  }
  const nextScenario = scenario.status === 'pass' ? scenario : { ...scenario,
    status: 'pass', startedAt: destroyed.at, finishedAt: created.at, machineEvidence: [evidence.id] }
  writeJsonAtomic(resultPath, { ...result, idleEvidence: evidence,
    scenarios: { ...result.scenarios, 'worker-sleep-wake': nextScenario } })
  return { status: 'pass', scenario: 'worker-sleep-wake', evidenceId: evidence.id }
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-worker-idle.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    const operation = process.argv[3] === '--record' ? Promise.resolve().then(() => recordNaturalIdle(runRoot))
      : probeStoredRun(runRoot)
    operation.then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { probeNaturalIdle, recordNaturalIdle }
