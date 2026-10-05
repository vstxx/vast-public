import type { Tab } from '../../shared/types'

export function restoredTabLifecycle(priority: boolean): Tab['lifecycle'] {
  return priority ? 'active' : 'discarded'
}

export function isInactiveTabEligibleForRetention(tab: Pick<Tab, 'lifecycle' | 'status'>): boolean {
  return tab.status !== 'error' && tab.lifecycle !== 'discarded'
}

export function isTabRetainedWithoutAutomaticHibernation(
  tab: Pick<Tab, 'id' | 'lifecycle'>,
  visibleIds: ReadonlySet<string>
): boolean {
  return tab.lifecycle !== 'discarded' || visibleIds.has(tab.id)
}

export function sameTabRetentionInputs(current: readonly Tab[], previous: readonly Tab[]): boolean {
  if (current === previous) return true
  return current.length === previous.length && current.every((tab, index) => {
    const prior = previous[index]
    return tab.id === prior.id && tab.url === prior.url && tab.status === prior.status &&
      tab.lifecycle === prior.lifecycle && tab.pinned === prior.pinned &&
      tab.lastAccessedAt === prior.lastAccessedAt
  })
}

export function hasInactiveRetentionCandidates(
  tabs: readonly Pick<Tab, 'id' | 'url' | 'lifecycle' | 'status'>[],
  visibleIds: ReadonlySet<string>,
  isInternalUrl: (url: string) => boolean
): boolean {
  return tabs.some((tab) => !visibleIds.has(tab.id) && !isInternalUrl(tab.url) &&
    tab.lifecycle !== 'discarded' && tab.status !== 'error')
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
