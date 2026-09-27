#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { WorkerCdpSession } = require('./controller.cjs')
const { evaluateExtensionExpression } = require('./extension-context.cjs')
const { writeJsonAtomic } = require('./run-state.cjs')

const PROTON_ID = 'ghmbeldphafepmbegfdlkpapadhbakde'
const OPTIONAL_ALLOWLIST = Object.freeze([
  'clipboardRead',
  'clipboardWrite',
  'nativeMessaging',
  'privacy',
  'webRequestAuthProvider'
])

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function safePermissions(value) {
  if (value?.runtimeId !== PROTON_ID || !Array.isArray(value.permissions)) {
    throw new Error('Unexpected Proton permission response.')
  }
  return Object.freeze({
    runtimeIdMatches: true,
    permissions: [...new Set(value.permissions.filter((item) => OPTIONAL_ALLOWLIST.includes(item)))].sort(),
    lastError: value.lastError === true
  })
}

function storedPermissions(registry) {
  if (!registry || !Array.isArray(registry.extensions)) {
    throw new Error('Vast extension registry is invalid.')
  }
  const record = registry.extensions.find((item) => item?.id === PROTON_ID)
  if (!record) throw new Error('Proton extension registry record is unavailable.')
  const granted = Array.isArray(record.grantedChromePermissions)
    ? record.grantedChromePermissions.filter((item) => OPTIONAL_ALLOWLIST.includes(item))
    : []
  return Object.freeze({
    runtimeIdMatches: true,
    permissions: [...new Set(granted)].sort()
  })
}

function extensionApiTarget(targets) {
  const popupPrefix = `chrome-extension://${PROTON_ID}/popup.html`
  return targets.find((item) => item?.type === 'webview' &&
    typeof item.url === 'string' && item.url.startsWith(popupPrefix) &&
    typeof item.webSocketDebuggerUrl === 'string') ||
    targets.find((item) => item?.type === 'service_worker' &&
      item.url === `chrome-extension://${PROTON_ID}/background.js` &&
      typeof item.webSocketDebuggerUrl === 'string')
}

async function readPermissions({ debuggerPort, fetchImpl = globalThis.fetch,
  connect = (url) => WorkerCdpSession.connect(url) }) {
  const response = await fetchImpl(`http://127.0.0.1:${debuggerPort}/json/list`)
  if (!response?.ok) throw new Error('Local debugger targets are unavailable.')
  const targets = await response.json()
  const context = extensionApiTarget(targets)
  if (!context) throw new Error('Proton extension API context is unavailable.')
  const session = await connect(context.webSocketDebuggerUrl)
  try {
    const value = await evaluateExtensionExpression(session, `new Promise((resolve) => chrome.permissions.getAll((permissions) => resolve({
      runtimeId: chrome.runtime.id,
      permissions: permissions.permissions || [],
      lastError: Boolean(chrome.runtime.lastError)
    })))`)
    return safePermissions(value)
  } finally { session.close() }
}

async function readStoredRun(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.')
  const root = path.resolve(__dirname, '..', '..')
  const runRoot = path.join(root, '.vast-build', 'password-manager-gates', 'runs', runId)
  const command = readJson(path.join(runRoot, 'command.json'))
  const status = readJson(path.join(runRoot, 'status.json'))
  const result = readJson(path.join(runRoot, 'result.json'))
  if (status.status !== 'running' || result.mode !== 'proton' || command.mode !== 'proton' ||
      result.extensions?.find((item) => item.key === 'protonpass')?.runtimeId !== PROTON_ID) {
    throw new Error('Permission probe requires a live isolated Proton run.')
  }
  const registry = storedPermissions(readJson(path.join(command.profile, 'Extensions', 'registry.json')))
  let api
  let apiProbe = 'available'
  try {
    api = await readPermissions({ debuggerPort: status.debuggerPort })
  } catch (error) {
    if (error?.message !== 'Extension execution context is unavailable.') throw error
    apiProbe = 'cdp-extension-api-unavailable'
  }
  const artifact = Object.freeze({
    schemaVersion: 1,
    id: `proton-permissions-probe-${Date.now()}-${randomUUID().slice(0, 8)}`,
    runId,
    mode: 'proton',
    observedAt: new Date().toISOString(),
    runtimeIdMatches: true,
    apiProbe,
    registryPermissions: registry.permissions,
    ...(api ? { apiPermissions: api.permissions, apiLastError: api.lastError } : {})
  })
  writeJsonAtomic(path.join(runRoot, `${artifact.id}.json`), artifact)
  return artifact
}

if (require.main === module) {
  readStoredRun(process.argv[2])
    .then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { OPTIONAL_ALLOWLIST, extensionApiTarget, readPermissions, safePermissions, storedPermissions }
