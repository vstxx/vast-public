import assert from 'node:assert/strict'
import test from 'node:test'

import { UsernameFirstCache } from '../../src/shared/username-first-cache.ts'

test('username-first correlation is isolated by window, guest and origin', () => {
  let now = 1_000
  const cache = new UsernameFirstCache(1_000, 10, () => now)
  cache.observe({ windowId: 1, guestId: 10, origin: 'https://a.test' }, 'alice')
  assert.equal(cache.lookup({ windowId: 1, guestId: 10, origin: 'https://a.test' }), 'alice')
  assert.equal(cache.lookup({ windowId: 1, guestId: 11, origin: 'https://a.test' }), undefined)
  assert.equal(cache.lookup({ windowId: 2, guestId: 10, origin: 'https://a.test' }), undefined)
  assert.equal(cache.lookup({ windowId: 1, guestId: 10, origin: 'https://b.test' }), undefined)
  now += 1_001
  assert.equal(cache.lookup({ windowId: 1, guestId: 10, origin: 'https://a.test' }), undefined)
})

test('two simultaneous tabs retain separate user-entered usernames', () => {
  const cache = new UsernameFirstCache()
  cache.observe({ windowId: 1, guestId: 10, origin: 'https://a.test' }, 'alice')
  cache.observe({ windowId: 1, guestId: 11, origin: 'https://a.test' }, 'bob')
  assert.equal(cache.lookup({ windowId: 1, guestId: 10, origin: 'https://a.test' }), 'alice')
  assert.equal(cache.lookup({ windowId: 1, guestId: 11, origin: 'https://a.test' }), 'bob')
})

test('cache is bounded and guest destruction clears its entries', () => {
  const cache = new UsernameFirstCache(10_000, 2, () => 1_000)
  cache.observe({ windowId: 1, guestId: 1, origin: 'https://one.test' }, 'one')
  cache.observe({ windowId: 1, guestId: 2, origin: 'https://two.test' }, 'two')
  cache.observe({ windowId: 1, guestId: 3, origin: 'https://three.test' }, 'three')
  assert.equal(cache.size, 2)
  assert.equal(cache.lookup({ windowId: 1, guestId: 1, origin: 'https://one.test' }), undefined)
  cache.clearGuest(2)
  assert.equal(cache.lookup({ windowId: 1, guestId: 2, origin: 'https://two.test' }), undefined)
})

test('closing a window clears every tab-scoped username owned by that window', () => {
  const cache = new UsernameFirstCache()
  cache.observe({ windowId: 1, guestId: 10, origin: 'https://a.test' }, 'alice')
  cache.observe({ windowId: 1, guestId: 11, origin: 'https://b.test' }, 'bob')
  cache.observe({ windowId: 2, guestId: 12, origin: 'https://a.test' }, 'charlie')
  cache.clearWindow(1)
  assert.equal(cache.lookup({ windowId: 1, guestId: 10, origin: 'https://a.test' }), undefined)
  assert.equal(cache.lookup({ windowId: 1, guestId: 11, origin: 'https://b.test' }), undefined)
  assert.equal(cache.lookup({ windowId: 2, guestId: 12, origin: 'https://a.test' }), 'charlie')
})
