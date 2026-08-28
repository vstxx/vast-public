import type { Session } from 'electron/main'
import type { VastExtensionKind, VastNativePermission, VastExtensionManifestSection } from '../../shared/extension-native-api.ts'
import type { ExtensionInstallSource, ExtensionTrustLevel, ExtensionUpdateState } from '../../shared/extension-marketplace.ts'

export type InstalledExtensionSource = ExtensionInstallSource
export type InstalledExtensionRuntime = VastExtensionKind

export interface InstalledExtensionRecord {
  id: string
  name: string
  version: string
  description?: string
  path: string
  enabled: boolean
  source: InstalledExtensionSource
  trust: ExtensionTrustLevel
  publisherId?: string
  publisherName?: string
  category?: string
  catalogInstalled?: true
  packageSha256?: string
  signatureKeyId?: string
  previousVersion?: string
  failedUpdateVersion?: string
  availableVersion?: string
  updateState: ExtensionUpdateState
  updateError?: string
  lastUpdateCheckAt?: number
  runtime: InstalledExtensionRuntime
  manifestVersion: 2 | 3
  installedAt: number
  updatedAt: number
  allowFileAccess: false
  grantedPermissions: VastNativePermission[]
}

export interface ChromeExtensionManifest {
  name: string
  version: string
  description?: string
  homepage_url?: string
  manifest_version: 2 | 3
  key?: string
  icons?: Record<string, string>
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  content_scripts?: Array<{
    matches?: string[]
    exclude_matches?: string[]
    js?: string[]
    css?: string[]
    run_at?: string
    all_frames?: boolean
  }>
  background?: Record<string, unknown>
  action?: { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string>; [key: string]: unknown }
  browser_action?: { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string>; [key: string]: unknown }
  options_ui?: { page?: string; open_in_tab?: boolean; [key: string]: unknown }
  options_page?: string
  vast?: VastExtensionManifestSection
  [key: string]: unknown
}

export interface ValidatedExtensionManifest {
  rootPath: string
  manifestPath: string
  manifest: ChromeExtensionManifest
  permissions: string[]
  hostPermissions: string[]
  iconDataUrl?: string
  kind: VastExtensionKind
  vast?: VastExtensionManifestSection
  ui: {
    popup?: { runtime: 'chrome' | 'native'; path: string }
    options?: { runtime: 'chrome' | 'native'; path: string }
  }
  nativeCompatibilityError?: string
}

export interface ExtensionSessionLike {
  isPersistent(): boolean
  extensions: Pick<Session['extensions'], 'loadExtension' | 'removeExtension' | 'getExtension'>
}

export type ExtensionSessionProvider = (partition: string) => ExtensionSessionLike
