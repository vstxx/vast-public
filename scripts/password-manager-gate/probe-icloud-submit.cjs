#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { approvedCurrentTarget } = require('./probe-current-credential.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function listTargets(debuggerPort) {
  const response = await fetch(`http://127.0.0.1:${debuggerPort}/json/list`)
  if (!response.ok) throw new Error('Local debugger target list is unavailable.')
  return response.json()
}

async function main() {
  const debuggerPort = Number(process.argv[2])
  const fixturePort = Number(process.argv[3])
  if (![debuggerPort, fixturePort].every((value) => Number.isSafeInteger(value) && value >= 1024 && value <= 65535)) {
    throw new Error('Usage: node probe-icloud-submit.cjs <debugger-port> <fixture-port>')
  }
  const target = (await listTargets(debuggerPort)).find((item) =>
    approvedCurrentTarget(item, fixturePort) && new URL(item.url).pathname === '/login')
  if (!target) throw new Error('The approved iCloud login fixture is unavailable.')
  const session = await WorkerCdpSession.connect(target.webSocketDebuggerUrl)
  try {
    await session.send('Runtime.evaluate', {
      expression: `(() => {
        const form = document.getElementById('gate-login')
        if (!form) throw new Error('Controlled login form is unavailable.')
        form.requestSubmit()
        return true
      })()`,
      returnByValue: true,
      userGesture: true
    })
  } finally { session.close() }

  const resultSession = await WorkerCdpSession.connect(target.webSocketDebuggerUrl)
  let result = null
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await wait(100)
      result = await resultSession.evaluate('window.__vastGate.snapshot()')
      if (result?.submitted === true) break
    }
  } finally { resultSession.close() }
  const accepted = result?.submitted === true
  const usernameMatchesExpectedHash = result?.usernameMatchesExpectedHash === true
  const passwordMatchesExpectedHash = result?.passwordMatchesExpectedHash === true
  const submissionMatchedExpectedHashes = result?.submissionMatchedExpectedHashes === true
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `icloud-submit-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    observedAt: new Date().toISOString(),
    extensionId: 'pejdijmoenmkgeppbflobdenhhabjlaj',
    payloadsCaptured: false,
    origin: `https://login.vast-test.local:${fixturePort}`,
    accepted,
    usernameMatchesExpectedHash,
    passwordMatchesExpectedHash,
    submissionMatchedExpectedHashes,
    passed: accepted && usernameMatchesExpectedHash && passwordMatchesExpectedHash && submissionMatchedExpectedHashes
  })
  const outputRoot = path.resolve(__dirname, '..', '..', '.vast-build', 'password-manager-gates', 'icloud-interactive')
  fs.mkdirSync(outputRoot, { recursive: true })
  const outputPath = path.join(outputRoot, `${artifact.id}.json`)
  writeJsonAtomic(outputPath, artifact)
  process.stdout.write(`${JSON.stringify({ ...artifact, outputPath }, null, 2)}\n`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
