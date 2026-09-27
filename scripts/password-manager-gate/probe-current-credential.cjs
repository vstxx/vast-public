#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { isApprovedFixtureHost } = require('./tls.cjs')
const { credentialReferenceSha256, writeJsonAtomic } = require('./run-state.cjs')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function expectedHashes(filePath) {
  const value = readJson(filePath)
  if (![value.usernameSha256, value.passwordSha256].every((item) =>
    typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item))) {
    throw new Error('Controlled credential hash file is malformed.')
  }
  return { username: value.usernameSha256.toLowerCase(), password: value.passwordSha256.toLowerCase() }
}

function approvedCurrentTarget(target, fixturePort) {
  if (target?.type !== 'webview' || typeof target.url !== 'string' ||
      typeof target.webSocketDebuggerUrl !== 'string') return false
  try {
    const url = new URL(target.url)
    return url.protocol === 'https:' && isApprovedFixtureHost(url.hostname) &&
      Number(url.port) === fixturePort
  } catch { return false }
}

function safeObservation(value) {
  return Object.freeze({
    targetId: typeof value?.targetId === 'string' ? value.targetId : '',
    frameId: typeof value?.frameId === 'string' ? value.frameId : '',
    frameDepth: Number.isSafeInteger(value?.frameDepth) && value.frameDepth >= 0 ? value.frameDepth : 0,
    host: typeof value?.host === 'string' ? value.host : '',
    route: typeof value?.route === 'string' ? value.route : '',
    visibility: value?.visibility === 'visible' ? 'visible' : 'hidden',
    focused: value?.focused === true,
    usernamePresent: value?.usernamePresent === true,
    passwordPresent: value?.passwordPresent === true,
    usernameMatchesExpectedHash: value?.usernameMatchesExpectedHash === true,
    passwordMatchesExpectedHash: value?.passwordMatchesExpectedHash === true
  })
}

function frameEntries(root, depth = 0, output = []) {
  if (!root?.frame || typeof root.frame.id !== 'string') return output
  output.push({ frameId: root.frame.id, frameDepth: depth })
  for (const child of root.childFrames || []) frameEntries(child, depth + 1, output)
  return output
}

async function observeTarget(target, hashes, fixturePort,
  connect = (url) => WorkerCdpSession.connect(url)) {
  const session = await connect(target.webSocketDebuggerUrl)
  try {
    await session.send('Page.enable')
    const expression = `(() => {
      const digest = async (value) => {
        const bytes = new TextEncoder().encode(value)
        const hash = await crypto.subtle.digest('SHA-256', bytes)
        return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      }
      const username = document.getElementById('gate-username')
      const password = document.getElementById('gate-password')
      return Promise.all([
        username ? digest(username.value) : Promise.resolve(''),
        password ? digest(password.value) : Promise.resolve('')
      ]).then(([usernameHash, passwordHash]) => ({
        protocol: location.protocol,
        host: location.hostname,
        port: location.port,
        route: location.pathname,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        usernamePresent: Boolean(username?.value),
        passwordPresent: Boolean(password?.value),
        usernameMatchesExpectedHash: usernameHash === ${JSON.stringify(hashes.username)},
        passwordMatchesExpectedHash: passwordHash === ${JSON.stringify(hashes.password)}
      }))
    })()`
    const tree = await session.send('Page.getFrameTree')
    const observations = []
    for (const entry of frameEntries(tree?.frameTree)) {
      try {
        const world = await session.send('Page.createIsolatedWorld', {
          frameId: entry.frameId,
          worldName: 'vast-gate-credential-readonly'
        })
        const response = await session.send('Runtime.evaluate', {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true
        })
        const value = response?.result?.value
        if (response?.exceptionDetails || !value || value.protocol !== 'https:' ||
            !isApprovedFixtureHost(value.host) || Number(value.port) !== fixturePort) continue
        observations.push(safeObservation({ targetId: target.id, ...entry, ...value }))
      } catch { /* inaccessible or destroyed child frame */ }
    }
    return observations
  } finally {
    session.close()
  }
}

async function probeStoredRun(runId, credentialHashPath, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.')
  const root = options.root || path.resolve(__dirname, '..', '..')
  const runRoot = path.join(root, '.vast-build', 'password-manager-gates', 'runs', runId)
  const status = readJson(path.join(runRoot, 'status.json'))
  if (status.status !== 'running' || !Number.isSafeInteger(status.debuggerPort) ||
      !Number.isSafeInteger(status.fixturePort)) throw new Error('Credential probe requires a live gate run.')
  const hashes = expectedHashes(path.resolve(credentialHashPath))
  const response = await (options.fetchImpl || globalThis.fetch)(`http://127.0.0.1:${status.debuggerPort}/json/list`)
  if (!response?.ok) throw new Error('Local debugger target list is unavailable.')
  const targets = (await response.json()).filter((target) => approvedCurrentTarget(target, status.fixturePort))
  if (targets.length === 0) throw new Error('No approved fixture target is available.')
  const observations = []
  for (const target of targets) observations.push(...await observeTarget(target, hashes,
    status.fixturePort, options.connect))
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `credential-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId,
    observedAt: new Date().toISOString(),
    credentialReferenceSha256: credentialReferenceSha256(hashes),
    observations,
    passed: observations.some((item) => item.usernameMatchesExpectedHash && item.passwordMatchesExpectedHash)
  })
  writeJsonAtomic(path.join(runRoot, `${artifact.id}.json`), artifact)
  return artifact
}

if (require.main === module) {
  const [runId, credentialHashPath] = process.argv.slice(2)
  if (!runId || !credentialHashPath) {
    console.error('Usage: node probe-current-credential.cjs <run-id> <credential-hash-file>')
    process.exitCode = 1
  } else probeStoredRun(runId, credentialHashPath)
    .then((artifact) => process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { approvedCurrentTarget, expectedHashes, frameEntries, observeTarget, probeStoredRun, safeObservation }
