#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { scanFixtures } = require('./scan-fixtures.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

const EXTENSION_ID = /^[a-p]{32}$/
const WARNING = 'Receiving end does not exist'
const MAX_CORRELATION_MS = 1_000

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function safeCall(value, extensionId, at) {
  if (!value || typeof value !== 'object' || !['tabs.sendMessage', 'runtime.sendMessage'].includes(value.method)) return undefined
  const call = { at, method: value.method, extensionId, senderContext: 'service_worker',
    receiverContext: value.method === 'tabs.sendMessage' ? 'tab_frame' : 'extension' }
  if (value.method === 'tabs.sendMessage') {
    if (Number.isSafeInteger(value.tabId) && value.tabId >= 0) call.tabId = value.tabId
    if (Number.isSafeInteger(value.frameId) && value.frameId >= 0) call.frameId = value.frameId
  }
  return Object.freeze(call)
}

function correlateWarnings(calls, warnings, maxMs = MAX_CORRELATION_MS) {
  const groups = new Map()
  for (const warningAt of warnings) {
    let nearest
    for (let index = calls.length - 1; index >= 0; index--) {
      const deltaMs = warningAt - calls[index].at
      if (deltaMs >= 0) { nearest = { ...calls[index], deltaMs }; break }
    }
    const matched = nearest && nearest.deltaMs <= maxMs
    const item = matched ? {
      method: nearest.method,
      extensionId: nearest.extensionId,
      senderContext: nearest.senderContext,
      receiverContext: nearest.receiverContext,
      ...(Number.isSafeInteger(nearest.tabId) ? { tabId: nearest.tabId } : {}),
      ...(Number.isSafeInteger(nearest.frameId) ? { frameId: nearest.frameId } : {}),
      timingBucket: nearest.deltaMs < 50 ? 'lt50ms' : nearest.deltaMs < 250 ? 'lt250ms' : 'lt1000ms'
    } : { method: 'unmatched', timingBucket: 'unmatched' }
    const key = JSON.stringify(item)
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  return [...groups].map(([key, count]) => Object.freeze({ ...JSON.parse(key), count }))
}

function scanPassed(observations) {
  const childFixtures = new Set(['same-origin-iframe', 'cross-origin-iframe', 'nested-frame', 'dynamic-iframe'])
  return Array.isArray(observations) && observations.length === 8 && observations.every((item) =>
    item?.overlayButtonCreated === true && item?.frameProbeSupported === true &&
    (!childFixtures.has(item.fixture) || (item.expectedChildFramesLoaded === true && item.childFormDetected === true)))
}

async function probeStoredRun(runRoot) {
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (command.mode !== 'bitwarden' || result.mode !== 'bitwarden' || command.runId !== result.runId ||
      status.status !== 'running' || !Number.isSafeInteger(status.debuggerPort) || !Number.isSafeInteger(status.fixturePort)) {
    throw new Error('Missing-receiver probe requires a live isolated Bitwarden gate.')
  }
  const extensionId = result.extensions?.find((item) => item.key === 'bitwarden')?.runtimeId
  if (!EXTENSION_ID.test(extensionId || '')) throw new Error('Bitwarden runtime ID is unavailable.')

  const response = await fetch(`http://127.0.0.1:${status.debuggerPort}/json/list`)
  if (!response.ok) throw new Error('Could not enumerate debugger targets.')
  const targets = await response.json()
  const worker = targets.find((target) => {
    if (target?.type !== 'service_worker' || typeof target.url !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') return false
    try { return new URL(target.url).protocol === 'chrome-extension:' && new URL(target.url).hostname === extensionId } catch { return false }
  })
  if (!worker) throw new Error('Bitwarden service worker target is unavailable.')

  const session = await WorkerCdpSession.connect(worker.webSocketDebuggerUrl)
  const calls = []
  const warnings = []
  let paused = Promise.resolve()
  const offWarning = session.on('Log.entryAdded', ({ entry }) => {
    if (typeof entry?.text === 'string' && entry.text.includes(WARNING)) warnings.push(Date.now())
  })
  const offPaused = session.on('Debugger.paused', (params) => {
    paused = paused.then(async () => {
      try {
        const response = await session.send('Debugger.evaluateOnCallFrame', {
          callFrameId: params.callFrames?.[0]?.callFrameId,
          expression: `(() => ({
            method: typeof __vastMethod === 'string' ? __vastMethod : 'unknown',
            tabId: typeof tabId === 'number' && Number.isSafeInteger(tabId) ? tabId : -1,
            frameId: typeof options === 'object' && options && Number.isSafeInteger(options.frameId) ? options.frameId : -1
          }))()`,
          returnByValue: true,
          silent: true
        })
        const call = safeCall(response?.result?.value, extensionId, Date.now())
        if (call) calls.push(call)
      } finally {
        await session.send('Debugger.resume').catch(() => {})
      }
    })
  })

  const install = `(() => {
    const tabsSendMessage = chrome.tabs.sendMessage
    const runtimeSendMessage = chrome.runtime.sendMessage
    globalThis.__vastRestoreSendMessageProbe = () => {
      chrome.tabs.sendMessage = tabsSendMessage
      chrome.runtime.sendMessage = runtimeSendMessage
      delete globalThis.__vastRestoreSendMessageProbe
    }
    chrome.tabs.sendMessage = function (tabId, message, options, callback) {
      const __vastMethod = 'tabs.sendMessage'
      debugger
      return Reflect.apply(tabsSendMessage, chrome.tabs, arguments)
    }
    chrome.runtime.sendMessage = function (targetOrMessage, messageOrOptions, optionsOrCallback, callback) {
      const __vastMethod = 'runtime.sendMessage'
      debugger
      return Reflect.apply(runtimeSendMessage, chrome.runtime, arguments)
    }
    return true
  })()`

  let diagnosticObservations
  try {
    await session.send('Log.enable')
    await session.send('Debugger.enable')
    await session.evaluate(install)
    diagnosticObservations = await scanFixtures({ debuggerPort: status.debuggerPort,
      fixturePort: status.fixturePort, extensionId })
    await paused
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    offWarning()
    offPaused()
    await session.send('Runtime.evaluate', {
      expression: 'globalThis.__vastRestoreSendMessageProbe?.()', returnByValue: true
    }).catch(() => {})
    await session.send('Debugger.disable').catch(() => {})
    session.close()
  }

  const verificationObservations = await scanFixtures({ debuggerPort: status.debuggerPort,
    fixturePort: status.fixturePort, extensionId })

  const evidence = Object.freeze({
    schemaVersion: 1,
    id: `missing-receiver-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId: command.runId,
    mode: command.mode,
    observedAt: new Date().toISOString(),
    extensionId,
    instrumentation: 'cdp-debugger-metadata-only',
    payloadsCaptured: false,
    diagnosticScanPassed: scanPassed(diagnosticObservations),
    scanPassed: scanPassed(verificationObservations),
    fixtureCount: verificationObservations.length,
    sendCallCount: calls.length,
    warningCount: warnings.length,
    correlations: correlateWarnings(calls, warnings),
    classification: 'unclassified',
    classificationReason: 'The probe correlates sender and recipient metadata but does not by itself prove teardown-before-send.'
  })
  writeJsonAtomic(path.join(runRoot, `${evidence.id}.json`), evidence)
  return evidence
}

if (require.main === module) {
  const runId = process.argv[2]
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    console.error('Usage: node scripts/password-manager-gate/probe-missing-receiver.cjs <run-id>')
    process.exitCode = 1
  } else {
    const runRoot = path.join(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'runs', runId)
    probeStoredRun(runRoot).then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { correlateWarnings, safeCall, scanPassed }
