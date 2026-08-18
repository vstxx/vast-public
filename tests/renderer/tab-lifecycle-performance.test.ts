import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isInactiveTabEligibleForRetention,
  isInactiveTabUnloadCandidate,
  restoredTabLifecycle
} from '../../src/renderer/store/tab-lifecycle.ts'

test('large restored sessions prioritize only explicitly visible tabs', () => {
  const lifecycle = Array.from({ length: 250 }, (_, index) => restoredTabLifecycle(index === 137))
  assert.equal(lifecycle.filter((value) => value === 'active').length, 1)
  assert.equal(lifecycle.filter((value) => value === 'discarded').length, 249)
})

test('discarded and crashed tabs are not recreated by recent-time retention', () => {
  assert.equal(isInactiveTabEligibleForRetention({ lifecycle: 'discarded', status: 'idle' }), false)
  assert.equal(isInactiveTabEligibleForRetention({ lifecycle: 'sleeping', status: 'error' }), false)
  assert.equal(isInactiveTabEligibleForRetention({ lifecycle: 'sleeping', status: 'idle' }), true)
})

test('call and media protection wins over automatic, manual, and macro unload eligibility', () => {
  const tab = { id: 'call-tab', pinned: false }
  const base = {
    activeTabId: 'other-tab',
    splitTabIds: [] as string[],
    keepPinnedTabsAwake: false,
    internal: false
  }
  assert.equal(isInactiveTabUnloadCandidate(tab, { ...base, keepAwakeTabIds: [] }), true)
  assert.equal(isInactiveTabUnloadCandidate(tab, { ...base, keepAwakeTabIds: ['call-tab'] }), false)
  assert.equal(isInactiveTabUnloadCandidate(tab, { ...base, splitTabIds: ['call-tab'], keepAwakeTabIds: [] }), false)
})
