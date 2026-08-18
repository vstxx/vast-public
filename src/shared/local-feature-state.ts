export type LocalFeatureStateKind = 'Available' | 'DisabledByFlag' | 'ComingSoon'

export function resolveLocalFeatureState(input: {
  comingSoon: boolean
  labRequired: boolean
  labsEnabled: boolean
  featureEnabled: boolean
}): LocalFeatureStateKind {
  if (input.comingSoon) return 'ComingSoon'
  if (input.labRequired && !(input.labsEnabled && input.featureEnabled)) return 'DisabledByFlag'
  return 'Available'
}
