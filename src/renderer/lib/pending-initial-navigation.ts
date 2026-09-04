import type { TabOpenNavigationMetadata } from '../../shared/types'

/**
 * One-shot initial-navigation metadata (referrer, POST body) for tabs created
 * from window.open / target=_blank. Kept in renderer memory only: never part
 * of the persisted store, session history, or diagnostics. Consumed by the
 * first WebviewSurface mount for the tab and dropped immediately.
 */
const MAX_PENDING_NAVIGATIONS = 64
const pendingNavigations = new Map<string, TabOpenNavigationMetadata>()

export function setPendingInitialNavigation(tabId: string, navigation: TabOpenNavigationMetadata | undefined): void {
  if (!navigation || (!navigation.referrer && !navigation.postBody)) return
  if (!pendingNavigations.has(tabId) && pendingNavigations.size >= MAX_PENDING_NAVIGATIONS) {
    const oldest = pendingNavigations.keys().next().value
    if (oldest !== undefined) pendingNavigations.delete(oldest)
  }
  pendingNavigations.set(tabId, navigation)
}

export function takePendingInitialNavigation(tabId: string): TabOpenNavigationMetadata | undefined {
  const navigation = pendingNavigations.get(tabId)
  if (navigation) pendingNavigations.delete(tabId)
  return navigation
}

export function pendingInitialNavigationCount(): number {
  return pendingNavigations.size
}
