#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const {
  expectedHashes,
  observeTarget
} = require('./probe-current-credential.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')
const { credentialReferenceSha256, writeJsonAtomic } = require('./run-state.cjs')

function parsePort(value, label) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} must be a valid non-privileged port.`)
  return port
}

function approvedIcloudTarget(target, fixturePort) {
  if (!['page', 'webview'].includes(target?.type) || typeof target.url !== 'string' ||
      typeof target.webSocketDebuggerUrl !== 'string') return false
  try {
    const url = new URL(target.url)
    return url.protocol === 'https:' && isApprovedFixtureHost(url.hostname) &&
      Number(url.port) === fixturePort
  } catch { return false }
}

async function probeIcloudCredential({ debuggerPort, fixturePort, credentialHashPath, fetchImpl = globalThis.fetch }) {
  const hashes = expectedHashes(path.resolve(credentialHashPath))
  const response = await fetchImpl(`http://127.0.0.1:${debuggerPort}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = (await response.json()).filter((target) => approvedIcloudTarget(target, fixturePort))
  if (targets.length === 0) throw new Error('No approved iCloud fixture target is available.')
  const observations = []
  for (const target of targets) observations.push(...await observeTarget(target, hashes, fixturePort))
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `icloud-credential-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    observedAt: new Date().toISOString(),
    extensionId: 'pejdijmoenmkgeppbflobdenhhabjlaj',
    payloadsCaptured: false,
    credentialReferenceSha256: credentialReferenceSha256(hashes),
    observations,
    passed: observations.some((item) => item.usernameMatchesExpectedHash && item.passwordMatchesExpectedHash)
  })
  const root = path.resolve(__dirname, '..', '..')
  const outputRoot = path.join(root, '.vast-build', 'password-manager-gates', 'icloud-interactive')
  fs.mkdirSync(outputRoot, { recursive: true })
  const outputPath = path.join(outputRoot, `${artifact.id}.json`)
  writeJsonAtomic(outputPath, artifact)
  return { artifact, outputPath }
}

if (require.main === module) {
  const [debuggerPortValue, fixturePortValue, credentialHashPath] = process.argv.slice(2)
  if (!debuggerPortValue || !fixturePortValue || !credentialHashPath) {
    console.error('Usage: node probe-icloud-credential.cjs <debugger-port> <fixture-port> <credential-hash-file>')
    process.exitCode = 1
  } else probeIcloudCredential({
    debuggerPort: parsePort(debuggerPortValue, 'Debugger port'),
    fixturePort: parsePort(fixturePortValue, 'Fixture port'),
    credentialHashPath
  }).then(({ artifact, outputPath }) => {
    process.stdout.write(`${JSON.stringify({ ...artifact, outputPath }, null, 2)}\n`)
  }).catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { approvedIcloudTarget, parsePort, probeIcloudCredential }
