import assert from 'node:assert/strict'
import test from 'node:test'
import type { Tab } from '../../src/shared/types.ts'
import {
  hasInactiveRetentionCandidates,
  isInactiveTabEligibleForRetention,
  isInactiveTabUnloadCandidate,
  isTabRetainedWithoutAutomaticHibernation,
  sameTabRetentionInputs,
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

test('manual deep discard stays unloaded with automatic hibernation disabled until selected', () => {
  const visibleIds = new Set(['active-tab'])
  assert.equal(isTabRetainedWithoutAutomaticHibernation({ id: 'discarded-tab', lifecycle: 'discarded' }, visibleIds), false)
  assert.equal(isTabRetainedWithoutAutomaticHibernation({ id: 'sleeping-tab', lifecycle: 'sleeping' }, visibleIds), true)
  assert.equal(isTabRetainedWithoutAutomaticHibernation({ id: 'discarded-tab', lifecycle: 'discarded' }, new Set(['discarded-tab'])), true)
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

test('transient progress and title changes do not invalidate retention decisions', () => {
  const tab: Tab = {
    id: 'one', workspaceId: 'workspace', title: 'First', url: 'https://example.com', pinned: false,
    status: 'loading', lifecycle: 'active', progress: 0.2, canGoBack: false, canGoForward: false,
    zoom: 1, lastAccessedAt: 1, createdAt: 1
  }
  assert.equal(sameTabRetentionInputs([{ ...tab, title: 'Loaded', progress: 0.9 }], [tab]), true)
  assert.equal(sameTabRetentionInputs([{ ...tab, lifecycle: 'discarded' }], [tab]), false)
  assert.equal(sameTabRetentionInputs([{ ...tab, lastAccessedAt: 2 }], [tab]), false)
  assert.equal(sameTabRetentionInputs([{ ...tab, url: 'https://example.org' }], [tab]), false)
  assert.equal(sameTabRetentionInputs([tab, { ...tab, id: 'two' }], [tab]), false)
})

test('automatic retention polling only runs while a hidden retained web tab needs evaluation', () => {
  const visible = new Set(['active'])
  const internal = (url: string): boolean => url.startsWith('vast:')
  const active = { id: 'active', url: 'https://example.com', lifecycle: 'active' as const, status: 'idle' as const }
  const hidden = { ...active, id: 'hidden', lifecycle: 'sleeping' as const }
  assert.equal(hasInactiveRetentionCandidates([active], visible, internal), false)
  assert.equal(hasInactiveRetentionCandidates([active, { ...hidden, url: 'vast:new-tab' }], visible, internal), false)
  assert.equal(hasInactiveRetentionCandidates([active, { ...hidden, lifecycle: 'discarded' }], visible, internal), false)
  assert.equal(hasInactiveRetentionCandidates([active, hidden], visible, internal), true)
})
