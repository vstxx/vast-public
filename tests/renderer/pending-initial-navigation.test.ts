import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  pendingInitialNavigationCount,
  setPendingInitialNavigation,
  takePendingInitialNavigation
} from '../../src/renderer/lib/pending-initial-navigation.ts'

test('pending navigation metadata is one-shot per tab', () => {
  setPendingInitialNavigation('tab-a', { referrer: { url: 'https://source.example/page', policy: 'strict-origin-when-cross-origin' } })
  assert.equal(pendingInitialNavigationCount(), 1)
  const taken = takePendingInitialNavigation('tab-a')
  assert.equal(taken?.referrer?.url, 'https://source.example/page')
  assert.equal(takePendingInitialNavigation('tab-a'), undefined)
  assert.equal(pendingInitialNavigationCount(), 0)
})

test('navigation-free opens and empty metadata are not stored', () => {
  setPendingInitialNavigation('tab-b', undefined)
  setPendingInitialNavigation('tab-c', {})
  assert.equal(pendingInitialNavigationCount(), 0)
})

test('the pending map stays bounded when tabs never mount', () => {
  for (let index = 0; index < 80; index += 1) {
    setPendingInitialNavigation(`tab-bulk-${index}`, { referrer: { url: 'https://source.example/page', policy: 'origin' } })
  }
  assert.ok(pendingInitialNavigationCount() <= 64)
  // Oldest entries were evicted; the newest tab still has its metadata.
  assert.equal(takePendingInitialNavigation('tab-bulk-79')?.referrer?.url, 'https://source.example/page')
  assert.equal(takePendingInitialNavigation('tab-bulk-0'), undefined)
})
