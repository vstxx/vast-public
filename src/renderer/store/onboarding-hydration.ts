import { INTERNAL_NEW_TAB_URL, INTERNAL_ONBOARDING_URL } from '../../shared/constants.ts'
import type { Tab, Workspace } from '../../shared/types.ts'
import { displayUrl, titleFromUrl } from '../lib/url.ts'

/**
 * Startup routing for onboarding: a profile that has not completed onboarding
 * lands on vast://onboarding instead of a normal browsing session. The active
 * tab of the restored session transitions to the onboarding page (no extra
 * tab is created, no restored session is destroyed), unless an onboarding tab
 * already exists or the target tab is pinned.
 */
export function applyOnboardingStart(
  tabs: Tab[],
  options: { activeWorkspace?: Workspace; onboardingCompleted: boolean }
): Tab[] {
  if (options.onboardingCompleted) return tabs.map((tab) =>
    tab.url === INTERNAL_ONBOARDING_URL
      ? { ...tab, url: INTERNAL_NEW_TAB_URL, title: titleFromUrl(INTERNAL_NEW_TAB_URL), displayUrl: displayUrl(INTERNAL_NEW_TAB_URL), status: 'idle' as const }
      : tab)
  if (tabs.some((tab) => tab.url === INTERNAL_ONBOARDING_URL)) return tabs
  const activeRestored = tabs.find((tab) => tab.id === options.activeWorkspace?.activeTabId)
  const targetTabId = (activeRestored ?? tabs[0])?.id
  if (!targetTabId) return tabs
  return tabs.map((tab) =>
    tab.id === targetTabId && !tab.pinned
      ? {
          ...tab,
          url: INTERNAL_ONBOARDING_URL,
          title: titleFromUrl(INTERNAL_ONBOARDING_URL),
          displayUrl: displayUrl(INTERNAL_ONBOARDING_URL),
          status: 'idle' as const
        }
      : tab
  )
}
