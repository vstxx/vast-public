/** Keep the old effective opt-in defaults when loading a saved profile that
 * predates the clean-icons and onboarding Labs defaults. Explicit choices win. */
export function preserveExistingProfileFeatureDefaults(settings: Record<string, unknown>): Record<string, unknown> {
  const appearance = settings.appearance && typeof settings.appearance === 'object' && !Array.isArray(settings.appearance)
    ? settings.appearance as Record<string, unknown> : {}
  const labs = settings.labs && typeof settings.labs === 'object' && !Array.isArray(settings.labs)
    ? settings.labs as Record<string, unknown> : {}
  return {
    ...settings,
    appearance: { ...appearance, cleanToolbarIcons: typeof appearance.cleanToolbarIcons === 'boolean' ? appearance.cleanToolbarIcons : false },
    labs: Object.fromEntries(['enabled', 'avidae', 'networkDevices', 'automation', 'advancedDiagnostics', 'spoofing']
      .map((key) => [key, typeof labs[key] === 'boolean' ? labs[key] : false]))
  }
}
