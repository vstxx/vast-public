import type { PersistedData } from './types.ts'

export function shouldRestoreTabsOnStartup(
  data: Pick<PersistedData, 'settings' | 'startupRecovery'>
): boolean {
  return data.startupRecovery?.safeStartup !== true &&
    data.settings.startupBehavior === 'restore' &&
    data.settings.restorePreviousSession
}
