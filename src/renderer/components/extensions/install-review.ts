import type { ExtensionPackagePreview } from '../../../shared/extension-marketplace'

function hostLabel(value: string): string { return value === '<all_urls>' ? 'All websites' : value }

export function installDetail(preview: ExtensionPackagePreview): string {
  const access = [...preview.permissions.chrome, ...preview.permissions.hosts.map(hostLabel), ...preview.permissions.vast]
  const addedAccess = [...preview.permissionEscalation.chrome, ...preview.permissionEscalation.hosts.map(hostLabel), ...preview.permissionEscalation.vast]
  const trust = preview.trust === 'official'
    ? `Verified Vast package from ${preview.publisherName}.`
    : preview.trust === 'upstream'
      ? `Original upstream extension by ${preview.publisherName}. Vast provides compatibility, not publisher endorsement.`
      : preview.trust === 'reviewed'
        ? `Hub-reviewed package attributed to ${preview.publisherName}; this is not a verified-publisher claim.`
        : 'Local package. Vast Extensions has not authenticated its publisher.'
  return `${trust}\n\nRequested access:\n${access.length > 0 ? access.map((item) => `• ${item}`).join('\n') : '• No browser or Vast permissions'}${preview.isUpdate && addedAccess.length > 0 ? `\n\nNew access in this update:\n${addedAccess.map((item) => `• ${item}`).join('\n')}` : ''}${preview.limitations?.length ? `\n\nCompatibility notes:\n${preview.limitations.map((item) => `• ${item}`).join('\n')}` : ''}`
}
