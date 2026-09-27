import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const { readFile } = fsPromises

const runtimePath = 'node_modules/electron-chrome-extensions/dist/cjs/index.js'

type NativeHost = {
  connected: boolean
  destroyed?: boolean
  keepAlive: boolean
  pending?: Buffer[]
  process?: { stdin: { destroyed?: boolean, write: (data: Buffer) => boolean, once: (event: string, listener: () => void) => unknown }, kill: () => void }
  receive: (data: Buffer) => void
  receiveBuffer: Buffer
  send: (message: unknown) => void
  sendAndReceive: (message: unknown) => Promise<unknown>
}

async function loadNativeMessagingHost(): Promise<new (...args: unknown[]) => NativeHost> {
  const source = await readFile(runtimePath, 'utf8')
  const start = source.indexOf('var MAX_NATIVE_MESSAGE_FROM_HOST')
  const end = source.indexOf('// src/browser/api/runtime.ts', start)
  assert.ok(start >= 0 && end > start, 'native messaging implementation was not found')
  const implementation = source.slice(start, end)
  const factory = new Function(
    'Buffer',
    'd7',
    'process',
    'path2',
    'os',
    'import_electron6',
    'import_node_fs2',
    'import_node_child_process',
    `${implementation}; return NativeMessagingHost`
  )
  return factory(Buffer, () => {}, process, path, os, { app: { getPath: () => '' } }, { promises: fsPromises }, { spawn: () => { throw new Error('unexpected spawn') } })
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const result = Buffer.alloc(4 + payload.length)
  result.writeUInt32LE(payload.length, 0)
  payload.copy(result, 4)
  return result
}

function sender(messages: unknown[]) {
  return {
    ipc: { on: () => {}, off: () => {} },
    send: (channel: string, message?: unknown) => messages.push(message === undefined ? channel : message)
  }
}

test('native messaging parses fragmented and coalesced UTF-8 frames', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) { this.connected = true }
  const messages: unknown[] = []
  const host = new NativeMessagingHost('a'.repeat(32), sender(messages), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready
  const first = frame({ value: 'zażółć 🌍' })
  const second = frame({ sequence: 2 })

  host.receive(first.subarray(0, 2))
  host.receive(Buffer.concat([first.subarray(2), second]))

  assert.deepEqual(messages, [{ value: 'zażółć 🌍' }, { sequence: 2 }])
  assert.equal(host.receiveBuffer.length, 0)
})

test('native messaging writes UTF-8 byte length and enforces the outbound limit', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  const writes: Buffer[] = []
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) {
    this.process = { stdin: { write: (data) => { writes.push(Buffer.from(data)); return true }, once: () => undefined }, kill: () => {} }
    this.connected = true
  }
  const host = new NativeMessagingHost('a'.repeat(32), sender([]), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready

  host.send({ value: 'żółw 🌍' })

  const expected = Buffer.from(JSON.stringify({ value: 'żółw 🌍' }), 'utf8')
  assert.equal(writes[0].readUInt32LE(0), expected.length)
  assert.deepEqual(writes[0].subarray(4), expected)
  assert.throws(() => host.send('x'.repeat(64 * 1024 * 1024)), /larger than 64 MiB/)
})

test('native messaging bounds messages queued before startup', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function () {}
  const host = new NativeMessagingHost('a'.repeat(32), sender([]), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready

  for (let index = 0; index < 64; index += 1) host.send({ index })

  assert.equal(host.pending?.length, 64)
  assert.throws(() => host.send({ index: 64 }), /pending queue limit exceeded/)
})

test('native messaging rejects values that are not JSON serializable', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function () {}
  const host = new NativeMessagingHost('a'.repeat(32), sender([]), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready
  const circular: { self?: unknown } = {}
  circular.self = circular

  assert.throws(() => host.send(circular), /not JSON serializable/)
  assert.throws(() => host.send(undefined), /not JSON serializable/)
})

test('native messaging queues writes while stdin applies backpressure', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  const writes: Buffer[] = []
  const stdin = new EventEmitter() as EventEmitter & { destroyed: boolean, write: (data: Buffer) => boolean }
  stdin.destroyed = false
  stdin.write = (data) => {
    writes.push(Buffer.from(data))
    return writes.length > 1
  }
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) {
    this.process = { stdin, kill: () => {} }
    this.connected = true
  }
  const host = new NativeMessagingHost('a'.repeat(32), sender([]), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready

  host.send({ sequence: 1 })
  host.send({ sequence: 2 })
  assert.equal(writes.length, 1)
  stdin.emit('drain')
  assert.equal(writes.length, 2)
})

test('one-shot native messaging fails closed after the response timeout', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) {
    this.process = { stdin: { write: () => true, once: () => undefined }, kill: () => {} }
    this.connected = true
  }
  const host = new NativeMessagingHost(
    'a'.repeat(32),
    sender([]),
    'connection',
    'com.vast.test',
    false,
    undefined,
    10,
  )

  await assert.rejects(host.sendAndReceive({ request: true }), /response timed out/)
  assert.equal(host.destroyed, true)
})

test('native messaging rejects oversized inbound frames before buffering a payload', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) { this.connected = true }
  const messages: unknown[] = []
  const host = new NativeMessagingHost('a'.repeat(32), sender(messages), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready
  const header = Buffer.alloc(4)
  header.writeUInt32LE(1024 * 1024 + 1, 0)

  host.receive(header)

  assert.equal(host.destroyed, true)
  assert.equal(messages.length, 1)
  assert.match(String(messages[0]), /larger than 1 MiB/)
})

test('native messaging rejects invalid UTF-8 instead of accepting replacement characters', async () => {
  const NativeMessagingHost = await loadNativeMessagingHost()
  NativeMessagingHost.prototype.launch = async function (this: NativeHost) { this.connected = true }
  const messages: unknown[] = []
  const host = new NativeMessagingHost('a'.repeat(32), sender(messages), 'connection', 'com.vast.test')
  await (host as unknown as { ready: Promise<void> }).ready
  const invalidUtf8JsonString = Buffer.from([0x22, 0xc3, 0x28, 0x22])
  const input = Buffer.alloc(4 + invalidUtf8JsonString.length)
  input.writeUInt32LE(invalidUtf8JsonString.length, 0)
  invalidUtf8JsonString.copy(input, 4)

  host.receive(input)

  assert.equal(host.destroyed, true)
  assert.match(String(messages[0]), /invalid JSON/)
})

test('native messaging runtime follows Chromium discovery and launch constraints', async () => {
  const source = await readFile(runtimePath, 'utf8')
  const preload = await readFile('node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js', 'utf8')
  const nativeStart = source.indexOf('var MAX_NATIVE_MESSAGE_FROM_HOST')
  const nativeEnd = source.indexOf('// src/browser/api/runtime.ts', nativeStart)
  const nativeSource = source.slice(nativeStart, nativeEnd)

  assert.match(source, /\/reg:\$\{view\}/)
  assert.match(source, /"32"[\s\S]*"64"/)
  assert.match(source, /path2\.resolve\(path2\.dirname\(manifestPath\), config\.path\)/)
  assert.match(source, /cwd: path2\.dirname\(executablePath\)/)
  assert.match(source, /shell: false/)
  assert.match(source, /"--parent-window=0"/)
  assert.match(source, /config\.name !== application/)
  assert.match(source, /MAX_NATIVE_HOST_CONNECTIONS = 16/)
  assert.match(source, /this\.activeHosts\.size >= MAX_NATIVE_HOST_CONNECTIONS/)
  assert.match(source, /Native messaging connection already exists/)
  assert.match(source, /delete this\.hostMap\[connectionId\]/)
  assert.match(nativeSource, /MAX_QUEUED_NATIVE_MESSAGES = 64/)
  assert.match(nativeSource, /Native messaging host response timed out/)
  assert.match(nativeSource, /new TextDecoder\("utf-8", \{ fatal: true \}\)/)
  assert.match(nativeSource, /stdin\.once\("drain", this\.flushWriteQueue\)/)
  assert.match(nativeSource, /process\.platform !== "win32" && !path2\.isAbsolute\(config\.path\)/)
  assert.doesNotMatch(nativeSource, /d7\("stderr: %s", data\.toString\(\)\)/)
  assert.doesNotMatch(nativeSource, /d7\([^\n]*, config\)/)
  assert.doesNotMatch(source, /d7\("(?:send|receive)(?:: %s)?", (?:json|message)\)/)
  assert.match(source, /destroy\(true, error\.message\)/)
  assert.match(source, /-disconnect`, errorMessage\)/)
  assert.match(preload, /value: \{ message: errorMessage \}/)
  assert.match(preload, /delete runtime\.lastError/)
  assert.match(preload, /MAX_QUEUED_NATIVE_MESSAGES = 64/)
  assert.match(preload, /this\.pendingBytes \+ messageBytes > MAX_NATIVE_MESSAGE_TO_HOST \+ 4/)
  assert.match(preload, /Attempting to use a disconnected port object/)
  assert.match(preload, /ipcRenderer\.off\(disconnectChannel, onDisconnect\)/)
  assert.match(preload, /if \(this\.disconnected\) \{[\s\S]*electron\.disconnectNative\(extensionId, connectionId\)/)
})
