import assert from 'node:assert/strict'
import test from 'node:test'
import { TabOpenRequestBuffer } from '../../src/preload/tab-open-request-buffer.ts'
import type { BrowserTabOpenRequest } from '../../src/shared/types.ts'

function request(url: string, activate = true): BrowserTabOpenRequest {
  return { url, disposition: activate ? 'foreground-tab' : 'background-tab', activate }
}

test('tab request received before React subscribes is replayed exactly once', () => {
  const buffer = new TabOpenRequestBuffer()
  const received: BrowserTabOpenRequest[] = []
  buffer.receive(request('https://example.com/early'))
  assert.equal(buffer.pendingCount(), 1)

  const unsubscribe = buffer.subscribe((item) => received.push(item))
  assert.deepEqual(received.map((item) => item.url), ['https://example.com/early'])
  assert.equal(buffer.pendingCount(), 0)

  buffer.receive(request('https://example.com/live'))
  assert.deepEqual(received.map((item) => item.url), ['https://example.com/early', 'https://example.com/live'])
  unsubscribe()
  buffer.receive(request('https://example.com/after-unsubscribe'))
  assert.equal(buffer.pendingCount(), 1)
})

test('tab request queue is bounded and retains the newest requests', () => {
  const buffer = new TabOpenRequestBuffer(3)
  for (let index = 0; index < 5; index++) buffer.receive(request(`https://example.com/${index}`))

  const received: string[] = []
  buffer.subscribe((item) => received.push(item.url))
  assert.deepEqual(received, ['https://example.com/2', 'https://example.com/3', 'https://example.com/4'])
})
