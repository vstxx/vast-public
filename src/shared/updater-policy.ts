import type { VastBuildMetadata } from './build-metadata'

export function updaterDisabledReason(
  packaged: boolean,
  metadata: Pick<VastBuildMetadata, 'distributionChannel' | 'updateEnabled'>
): string | null {
  if (!packaged) return 'Auto-updates are disabled in development builds.'
  if (metadata.distributionChannel === 'microsoft-store') return 'Updates are managed by Microsoft Store.'
  if (!metadata.updateEnabled) return 'Auto-updates are disabled for this build.'
  return null
}
