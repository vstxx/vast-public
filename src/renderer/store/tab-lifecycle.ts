import type { Tab } from '../../shared/types'

export function restoredTabLifecycle(priority: boolean): Tab['lifecycle'] {
  return priority ? 'active' : 'discarded'
}

export function isInactiveTabEligibleForRetention(tab: Pick<Tab, 'lifecycle' | 'status'>): boolean {
  return tab.status !== 'error' && tab.lifecycle !== 'discarded'
}

export function isInactiveTabUnloadCandidate(
  tab: Pick<Tab, 'id' | 'pinned'>,
  context: {
    activeTabId?: string
    splitTabIds?: readonly string[]
    keepAwakeTabIds: readonly string[]
    keepPinnedTabsAwake: boolean
    internal: boolean
  }
): boolean {
  if (tab.id === context.activeTabId || context.splitTabIds?.includes(tab.id)) return false
  if (context.internal || context.keepAwakeTabIds.includes(tab.id)) return false
  if (tab.pinned && context.keepPinnedTabsAwake) return false
  return true
}
