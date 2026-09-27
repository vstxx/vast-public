const fs = require('node:fs')
const path = require('node:path')

function safeToken(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

function sanitizedUrl(value) {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    if (!['https:', 'http:', 'chrome-extension:'].includes(parsed.protocol)) return undefined
    if (parsed.protocol === 'chrome-extension:') {
      if (!/^[a-p]{32}$/.test(parsed.hostname)) return undefined
      return `chrome-extension://${parsed.hostname}${parsed.pathname}`
    }
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function errorClassFrom(input) {
  const direct = safeToken(input.errorClass, /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/)
  if (direct) return direct
  if (input.error && typeof input.error === 'object') {
    return safeToken(input.error.name, /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/)
  }
  return undefined
}

function sanitizeStackLocations(value) {
  if (!Array.isArray(value)) return undefined
  const locations = []
  for (const item of value.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue
    const url = sanitizedUrl(item.url)
    const lineNumber = safeInteger(item.lineNumber)
    const columnNumber = safeInteger(item.columnNumber)
    if (!url || lineNumber === undefined || columnNumber === undefined) continue
    locations.push({ url, lineNumber, columnNumber })
  }
  return locations.length > 0 ? locations : undefined
}

function sanitizeEvent(input) {
  if (!input || typeof input !== 'object') throw new Error('Diagnostic event input must be an object.')
  const output = {}
  const sequence = safeInteger(input.sequence)
  if (sequence !== undefined) output.sequence = sequence
  if (typeof input.at === 'string' && Number.isFinite(Date.parse(input.at))) output.at = input.at
  const event = safeToken(input.event, /^[a-z][a-z0-9-]{0,79}$/)
  if (event) output.event = event
  const extensionId = safeToken(input.extensionId, /^[a-p]{32}$/)
  if (extensionId) output.extensionId = extensionId
  const contextType = safeToken(input.contextType, /^[a-z][a-z0-9_-]{0,47}$/)
  if (contextType) output.contextType = contextType
  const receiverContext = safeToken(input.receiverContext, /^(?:tab_frame|extension)$/)
  if (receiverContext) output.receiverContext = receiverContext
  const apiMethod = safeToken(input.apiMethod, /^[A-Za-z][A-Za-z0-9_.]{0,79}$/)
  if (apiMethod) output.apiMethod = apiMethod
  const targetId = safeToken(input.targetId, /^[A-Za-z0-9_.:-]{1,160}$/)
  if (targetId) output.targetId = targetId
  for (const field of ['tabId', 'frameId', 'parentFrameId']) {
    const value = safeInteger(input[field])
    if (value !== undefined) output[field] = value
  }
  const url = sanitizedUrl(input.url)
  if (url) output.url = url
  const lifecycleState = safeToken(input.lifecycleState, /^[a-z][a-z0-9_-]{0,47}$/)
  if (lifecycleState) output.lifecycleState = lifecycleState
  const errorClass = errorClassFrom(input)
  if (errorClass) output.errorClass = errorClass
  if (input.diagnosticStream === 'stdout' || input.diagnosticStream === 'stderr') {
    output.diagnosticStream = input.diagnosticStream
  }
  const diagnosticCount = safeInteger(input.diagnosticCount)
  if (diagnosticCount !== undefined && diagnosticCount > 0) output.diagnosticCount = diagnosticCount
  const stackLocations = sanitizeStackLocations(input.stackLocations)
  if (stackLocations) output.stackLocations = stackLocations
  return Object.freeze(output)
}

function canaryVariants(canary) {
  const encoded = encodeURIComponent(canary)
  const encodedTwice = encodeURIComponent(encoded)
  const base64 = Buffer.from(canary, 'utf8').toString('base64')
  const base64url = Buffer.from(canary, 'utf8').toString('base64url')
  return [...new Set([canary, encoded, encodedTwice, base64, base64url])]
}

function artifactFiles(targetPath) {
  const stat = fs.lstatSync(targetPath)
  if (stat.isSymbolicLink()) return []
  if (stat.isFile()) return [targetPath]
  if (!stat.isDirectory()) return []
  return fs.readdirSync(targetPath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(targetPath, entry.name)
    if (entry.isSymbolicLink()) return []
    return artifactFiles(child)
  })
}

function assertArtifactHasNoSecrets(targetPath, canaries) {
  if (!Array.isArray(canaries) || canaries.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('Canary list must contain non-empty strings.')
  }
  const variants = canaries.flatMap(canaryVariants)
  for (const filePath of artifactFiles(targetPath)) {
    const bytes = fs.readFileSync(filePath)
    for (const value of variants) {
      if (bytes.includes(Buffer.from(value, 'utf8')) || bytes.includes(Buffer.from(value, 'utf16le'))) {
        throw new Error('Sensitive canary detected in an artifact file.')
      }
    }
  }
}

module.exports = { assertArtifactHasNoSecrets, sanitizeEvent, sanitizedUrl }
