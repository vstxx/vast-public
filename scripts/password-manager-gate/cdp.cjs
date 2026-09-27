const { isApprovedFixtureHost } = require('./tls.cjs')
const { sanitizeEvent } = require('./redaction.cjs')

const SNAPSHOT_BOOLEAN_FIELDS = [
  'usernamePresent',
  'passwordPresent',
  'usernameMatchesExpectedHash',
  'passwordMatchesExpectedHash',
  'unexpectedForeignFill',
  'submitted',
  'submissionMatchedExpectedHashes'
]

function callFrames(stackTrace) {
  const frames = stackTrace?.callFrames
  if (!Array.isArray(frames)) return undefined
  return frames.map((frame) => ({
    url: frame.url,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber
  }))
}

function approvedFixtureUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && isApprovedFixtureHost(parsed.hostname)
  } catch {
    return false
  }
}

function cleanSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fixture snapshot is not an object.')
  if (typeof value.fixture !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value.fixture)) {
    throw new Error('Fixture snapshot has an invalid fixture identifier.')
  }
  if (typeof value.route !== 'string' || !value.route.startsWith('/') || value.route.includes('?') || value.route.includes('#')) {
    throw new Error('Fixture snapshot has an invalid route.')
  }
  if (!approvedFixtureUrl(value.frameOrigin)) throw new Error('Fixture snapshot has an unapproved frame origin.')
  const origin = new URL(value.frameOrigin)
  if (origin.href !== origin.origin && origin.href !== `${origin.origin}/`) throw new Error('Fixture snapshot frame origin contains a path.')
  for (const field of SNAPSHOT_BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') throw new Error(`Fixture snapshot field ${field} is not boolean.`)
  }
  return Object.freeze({
    fixture: value.fixture,
    route: value.route,
    frameOrigin: origin.origin,
    usernamePresent: value.usernamePresent,
    passwordPresent: value.passwordPresent,
    usernameMatchesExpectedHash: value.usernameMatchesExpectedHash,
    passwordMatchesExpectedHash: value.passwordMatchesExpectedHash,
    unexpectedForeignFill: value.unexpectedForeignFill,
    submitted: value.submitted,
    submissionMatchedExpectedHashes: value.submissionMatchedExpectedHashes
  })
}

class CdpObserver {
  constructor({ debuggerClient, onEvent, now = () => new Date() }) {
    if (!debuggerClient || typeof debuggerClient.sendCommand !== 'function') throw new Error('CDP observer requires a debugger client.')
    if (typeof onEvent !== 'function') throw new Error('CDP observer requires an event sink.')
    this.debuggerClient = debuggerClient
    this.onEvent = onEvent
    this.now = now
    this.sequence = 0
    this.started = false
    this.attachedByObserver = false
    this.frameIds = new Map()
    this.nextFrameId = 1
    this.handleMessage = this.handleMessage.bind(this)
  }

  frameId(value) {
    if (typeof value !== 'string' || !value) return undefined
    if (!this.frameIds.has(value)) this.frameIds.set(value, this.nextFrameId++)
    return this.frameIds.get(value)
  }

  record(event) {
    const at = this.now()
    const sanitized = sanitizeEvent({
      sequence: this.sequence++,
      at: at instanceof Date ? at.toISOString() : String(at),
      ...event
    })
    this.onEvent(sanitized)
    return sanitized
  }

  async start() {
    if (this.started) return
    if (!this.debuggerClient.isAttached()) {
      this.debuggerClient.attach('1.3')
      this.attachedByObserver = true
    }
    this.debuggerClient.on('message', this.handleMessage)
    try {
      await this.debuggerClient.sendCommand('Runtime.enable')
      await this.debuggerClient.sendCommand('Log.enable')
      await this.debuggerClient.sendCommand('Page.enable')
      await this.debuggerClient.sendCommand('Target.setDiscoverTargets', { discover: true })
      this.started = true
    } catch (error) {
      this.debuggerClient.removeListener('message', this.handleMessage)
      if (this.attachedByObserver && this.debuggerClient.isAttached()) this.debuggerClient.detach()
      this.attachedByObserver = false
      throw error
    }
  }

  handleMessage(_event, method, params = {}) {
    if (method === 'Runtime.consoleAPICalled') {
      const level = typeof params.type === 'string' && /^[a-z]+$/.test(params.type) ? params.type : 'unknown'
      this.record({ event: `console-${level}`, stackLocations: callFrames(params.stackTrace) })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {}
      this.record({
        event: 'runtime-exception',
        errorClass: details.exception?.className || 'Error',
        stackLocations: callFrames(details.stackTrace)
      })
      return
    }
    if (method === 'Log.entryAdded') {
      this.record({ event: 'log-entry', stackLocations: callFrames(params.entry?.stackTrace) })
      return
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo || {}
      this.record({
        event: method === 'Target.targetCreated' ? 'target-created' : 'target-changed',
        targetId: info.targetId,
        contextType: info.type,
        url: info.url,
        lifecycleState: info.attached ? 'attached' : 'detached'
      })
      return
    }
    if (method === 'Target.targetDestroyed') {
      this.record({ event: 'target-destroyed', targetId: params.targetId, lifecycleState: 'destroyed' })
      return
    }
    if (method === 'Page.frameAttached') {
      this.record({
        event: 'frame-attached',
        contextType: 'frame',
        frameId: this.frameId(params.frameId),
        parentFrameId: this.frameId(params.parentFrameId),
        lifecycleState: 'attached'
      })
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params.frame || {}
      this.record({
        event: 'frame-navigated',
        contextType: 'frame',
        frameId: this.frameId(frame.id),
        parentFrameId: this.frameId(frame.parentId),
        url: frame.url,
        lifecycleState: 'active'
      })
      return
    }
    if (method === 'Page.frameDetached') {
      this.record({
        event: 'frame-detached',
        contextType: 'frame',
        frameId: this.frameId(params.frameId),
        lifecycleState: 'detached'
      })
      return
    }
    if (method === 'Runtime.executionContextCreated') {
      this.record({
        event: 'context-created',
        contextType: params.context?.auxData?.type || 'execution_context',
        targetId: String(params.context?.id ?? ''),
        lifecycleState: 'created'
      })
      return
    }
    if (method === 'Runtime.executionContextDestroyed') {
      this.record({
        event: 'context-destroyed',
        contextType: 'execution_context',
        targetId: String(params.executionContextId ?? ''),
        lifecycleState: 'destroyed'
      })
    }
  }

  async snapshotTargets() {
    const result = await this.debuggerClient.sendCommand('Target.getTargets')
    const targets = Array.isArray(result?.targetInfos) ? result.targetInfos : []
    return targets.map((info) => sanitizeEvent({
      event: 'target-snapshot',
      targetId: info.targetId,
      contextType: info.type,
      url: info.url,
      lifecycleState: info.attached ? 'attached' : 'detached'
    }))
  }

  async evaluateFixture({ url, contextId }) {
    if (!approvedFixtureUrl(url)) throw new Error('CDP evaluation requires an approved fixture origin.')
    if (!Number.isSafeInteger(contextId) || contextId < 0) throw new Error('CDP evaluation requires a valid execution context ID.')
    const result = await this.debuggerClient.sendCommand('Runtime.evaluate', {
      expression: 'window.__vastGate.snapshot()',
      contextId,
      awaitPromise: true,
      returnByValue: true
    })
    if (result?.exceptionDetails || !result?.result || !Object.hasOwn(result.result, 'value')) {
      throw new Error('Fixture snapshot evaluation failed.')
    }
    return cleanSnapshot(result.result.value)
  }

  async stop() {
    if (!this.started) return
    try {
      await this.debuggerClient.sendCommand('Target.setDiscoverTargets', { discover: false })
    } finally {
      this.debuggerClient.removeListener('message', this.handleMessage)
      if (this.attachedByObserver && this.debuggerClient.isAttached()) this.debuggerClient.detach()
      this.attachedByObserver = false
      this.started = false
    }
  }
}

module.exports = { CdpObserver, cleanSnapshot }
