import type { BrowserSettings, PermissionSetting, SitePermissionKind } from '../shared/types'

export function originFromPermissionUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function permissionKindsFromElectronPermission(permission: string, mediaTypes: string[] = []): SitePermissionKind[] {
  if (permission === 'media') {
    const kinds: SitePermissionKind[] = []
    if (mediaTypes.includes('video')) kinds.push('camera')
    if (mediaTypes.includes('audio')) kinds.push('microphone')
    return kinds.length > 0 ? kinds : ['media']
  }
  if (permission === 'geolocation') return ['geolocation']
  if (permission === 'notifications') return ['notifications']
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return ['clipboard']
  if (permission === 'fullscreen') return ['fullscreen']
  return []
}

export function permissionKindFromElectronPermission(permission: string, mediaTypes: string[] = []): SitePermissionKind | undefined {
  return permissionKindsFromElectronPermission(permission, mediaTypes)[0]
}

function globalDefaultForPermission(settings: BrowserSettings, kind: SitePermissionKind): PermissionSetting {
  if (kind === 'camera') return settings.security.permissionCamera
  if (kind === 'microphone') return settings.security.permissionMicrophone
  if (kind === 'geolocation') return settings.security.permissionLocation
  if (kind === 'notifications') return settings.security.permissionNotifications
  if (kind === 'clipboard') return settings.security.permissionClipboard
  if (kind === 'fullscreen') return settings.security.permissionFullscreen
  return 'ask'
}

export function resolveStoredPermissionPolicy(settings: BrowserSettings, rawOrigin: string, kind: SitePermissionKind, workspaceId?: string): PermissionSetting {
  const origin = originFromPermissionUrl(rawOrigin)
  if (!origin) return 'block'
  const override = settings.security.sitePermissions?.find((item) => item.origin === origin && item.permission === kind && item.workspaceId === workspaceId)
  return override?.setting ?? globalDefaultForPermission(settings, kind)
}

export function upsertOriginPermissionOverride(
  settings: BrowserSettings,
  rawOrigin: string,
  kind: SitePermissionKind,
  setting: Exclude<PermissionSetting, 'ask'>,
  workspaceId?: string
): BrowserSettings {
  const origin = originFromPermissionUrl(rawOrigin)
  if (!origin) return settings
  const now = Date.now()
  const existing = settings.security.sitePermissions ?? []
  return {
    ...settings,
    security: {
      ...settings.security,
      sitePermissions: [
        ...existing.filter((item) => !(item.origin === origin && item.permission === kind && item.workspaceId === workspaceId)),
        { origin, workspaceId, permission: kind, setting, updatedAt: now }
      ].sort((a, b) => a.origin.localeCompare(b.origin) || (a.workspaceId ?? '').localeCompare(b.workspaceId ?? '') || a.permission.localeCompare(b.permission))
    }
  }
}

export function removeOriginPermissionOverride(settings: BrowserSettings, rawOrigin: string, kind: SitePermissionKind): BrowserSettings {
  const origin = originFromPermissionUrl(rawOrigin)
  if (!origin) return settings
  return {
    ...settings,
    security: {
      ...settings.security,
      sitePermissions: (settings.security.sitePermissions ?? []).filter((item) => !(item.origin === origin && item.permission === kind))
    }
  }
}
