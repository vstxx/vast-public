import type { BrowserSettings } from '../shared/types'

/** Main-process projection of settings whose effects must never rely on UI gates. */
export function settingsAllowedByRuntimeFeaturePolicy(settings: BrowserSettings): BrowserSettings {
  if (settings.labs?.enabled === true && settings.labs.spoofing === true) return settings
  return {
    ...settings,
    spoofing: {
      ...settings.spoofing,
      enabled: false
    }
  }
}
