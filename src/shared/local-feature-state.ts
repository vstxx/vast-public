export type LocalFeatureStateKind = 'Available' | 'DisabledByFlag' | 'ComingSoon'

export function resolveLocalFeatureState(input: {
  comingSoon: boolean
  labRequired: boolean
  /** Retained for persisted-settings compatibility; Labs itself is always visible. */
  labsEnabled?: boolean
  featureEnabled: boolean
}): LocalFeatureStateKind {
  if (input.comingSoon) return 'ComingSoon'
  if (input.labRequired && !input.featureEnabled) return 'DisabledByFlag'
  return 'Available'
}
