import { app } from 'electron/main'
import {
  buildMetadataFromMergedEnv,
  isPublicDistributionBuild,
  publicReleaseMetadataFailures,
  type VastBuildMetadata
} from '../shared/build-metadata'

let cached: VastBuildMetadata | undefined

export function getBuildMetadata(): VastBuildMetadata {
  if (!cached) cached = buildMetadataFromMergedEnv(process.env)
  return cached
}

export function isDevRuntime(): boolean {
  return !app.isPackaged || getBuildMetadata().channel === 'dev'
}

export function assertPublicDistributionGuards(): void {
  const metadata = getBuildMetadata()
  if (!isPublicDistributionBuild(metadata)) return

  const missing = publicReleaseMetadataFailures(metadata)

  if (missing.length > 0) {
    throw new Error(`Refusing public ${metadata.channel} release without required release configuration: ${missing.join(', ')}`)
  }
}

export function redactedBuildDiagnostics(): {
  releaseChannel: string
  distributionChannel: string
  releaseRepo: string
  updaterEnabled: boolean
  obfuscationEnabled: boolean
  privateBuild: boolean
  packaged: boolean
} {
  const metadata = getBuildMetadata()
  return {
    releaseChannel: metadata.channel,
    distributionChannel: metadata.distributionChannel,
    releaseRepo: metadata.releaseRepo,
    updaterEnabled: metadata.updateEnabled,
    obfuscationEnabled: metadata.obfuscate,
    privateBuild: metadata.privateBuild,
    packaged: app.isPackaged
  }
}
