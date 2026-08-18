export type VastReleaseChannel = 'dev' | 'alpha' | 'beta' | 'stable'

export interface VastBuildMetadata {
  channel: VastReleaseChannel
  updateEnabled: boolean
  obfuscate: boolean
  privateBuild: boolean
  catAddonAvailable: boolean
  releaseRepo: string
  performanceGpu: boolean
  safeGpu: boolean
}

type BuildEnv = Record<string, string | undefined>

declare const __VAST_BUILD_ENV__: BuildEnv | undefined

function stringValue(env: Record<string, string | undefined>, key: string): string {
  return String(env[key] ?? '').trim()
}

export function normalizeReleaseChannel(value: string | undefined, fallback: VastReleaseChannel = 'dev'): VastReleaseChannel {
  if (value === 'dev' || value === 'alpha' || value === 'beta' || value === 'stable') return value
  return fallback
}

export function envFlag(env: Record<string, string | undefined>, key: string, fallback = false): boolean {
  const value = stringValue(env, key).toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

export function buildMetadataFromEnv(env: Record<string, string | undefined>): VastBuildMetadata {
  const channel = normalizeReleaseChannel(stringValue(env, 'VAST_RELEASE_CHANNEL'))
  return {
    channel,
    updateEnabled: envFlag(env, 'VAST_UPDATE_ENABLED', false),
    obfuscate: envFlag(env, 'VAST_OBFUSCATE', false),
    privateBuild: envFlag(env, 'VAST_PRIVATE_BUILD', true),
    // Cat Addon remains in source and development builds, but is deliberately
    // absent from every beta package until it is promoted independently.
    catAddonAvailable: channel !== 'beta',
    releaseRepo: stringValue(env, 'VAST_RELEASE_REPO') || 'vstxx/vast-public',
    performanceGpu: envFlag(env, 'VAST_PERFORMANCE_GPU', false),
    safeGpu: envFlag(env, 'VAST_SAFE_GPU', false)
  }
}

export function embeddedBuildEnv(): BuildEnv {
  try {
    if (typeof __VAST_BUILD_ENV__ === 'object' && __VAST_BUILD_ENV__) return __VAST_BUILD_ENV__
  } catch {
    // Unbundled tests and scripts do not define the build-time constant.
  }
  return {}
}

export function buildMetadataFromMergedEnv(runtimeEnv: BuildEnv, embeddedEnv: BuildEnv = embeddedBuildEnv()): VastBuildMetadata {
  return buildMetadataFromEnv({ ...runtimeEnv, ...embeddedEnv })
}

export function isPublicStableBuild(metadata: VastBuildMetadata): boolean {
  return metadata.channel === 'stable' && !metadata.privateBuild
}

export function isPublicDistributionBuild(metadata: VastBuildMetadata): boolean {
  return (metadata.channel === 'beta' || metadata.channel === 'stable') && !metadata.privateBuild
}

export function publicReleaseMetadataFailures(metadata: VastBuildMetadata): string[] {
  if (!isPublicDistributionBuild(metadata)) return []

  const missing: string[] = []
  if (!metadata.updateEnabled) missing.push('VAST_UPDATE_ENABLED=1')
  if (!metadata.obfuscate) missing.push('VAST_OBFUSCATE=1')
  if (metadata.releaseRepo !== 'vstxx/vast-public') missing.push('release repository must be vstxx/vast-public')
  if (metadata.channel === 'beta' && metadata.catAddonAvailable) missing.push('Cat Addon must be excluded from beta')

  return missing
}

/** @deprecated Use publicReleaseMetadataFailures for both public beta and stable. */
export function stableReleaseMetadataFailures(metadata: VastBuildMetadata): string[] {
  return publicReleaseMetadataFailures(metadata)
}
