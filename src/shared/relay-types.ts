export const RELAY_PROTOCOL_VERSION = 1 as const

export const RELAY_BROADCAST_TYPES = ['welcome', 'seasonal', 'announcement', 'security', 'update_notice'] as const
export type RelayBroadcastType = (typeof RELAY_BROADCAST_TYPES)[number]

export const RELAY_UPDATE_SEVERITIES = ['optional', 'recommended', 'important', 'critical'] as const
export type RelayUpdateSeverity = (typeof RELAY_UPDATE_SEVERITIES)[number]

export const RELAY_ASSET_MIME_TYPES = ['image/png', 'image/webp', 'image/gif'] as const
export type RelayAssetMime = (typeof RELAY_ASSET_MIME_TYPES)[number]

export type RelayEnvironment = 'staging' | 'production'

export interface RelayTrustKey {
  keyId: string
  publicKeySpkiBase64: string
}

export interface RelayBuildConfig {
  enabled: boolean
  environment: RelayEnvironment
  endpoint: string
  keys: RelayTrustKey[]
}

export interface RelayCheckinRequest {
  protocol: 1
  install_id: string
  current_version: string
  launch_count: number
}

export interface RelayBroadcastMedia {
  id: string
  sha256: string
  mime: RelayAssetMime
}

export interface RelayBroadcastAction {
  label: string
  url: string
}

export interface RelayBroadcastPayload {
  schema: 'vast-relay-broadcast-v1'
  key_id: string
  id: string
  type: RelayBroadcastType
  title: string
  body: string
  media: RelayBroadcastMedia | null
  action: RelayBroadcastAction | null
  min_version: string | null
  max_version: string | null
  active_from: string
  active_until: string | null
  priority: number
  enabled: boolean
  created_at: string
}

export interface RelayReleasePayload {
  schema: 'vast-relay-release-v1'
  key_id: string
  version: string
  release_url: string
  severity: RelayUpdateSeverity
  min_supported_version: string | null
  title: string
  notes: string
  published_at: string
  enabled: boolean
}

export interface RelaySignedEnvelope<T> {
  key_id: string
  payload: T
  signature: string
}

export interface RelayParsedResponse {
  protocol: 1
  serverTime: string
  messages: Array<RelaySignedEnvelope<RelayBroadcastPayload>>
  update: RelaySignedEnvelope<RelayReleasePayload> | null
}

export interface RelayPresentationMedia {
  mime: RelayAssetMime
  sha256: string
  bytes: Uint8Array
}

export interface RelayMessagePresentation {
  kind: 'message'
  presentationId: string
  broadcastId: string
  type: RelayBroadcastType
  title: string
  body: string
  actionLabel: string | null
  media: RelayPresentationMedia | null
}

export interface RelayUpdatePresentation {
  kind: 'update'
  presentationId: string
  version: string
  severity: RelayUpdateSeverity
  title: string
  body: string
  minimumSupportedVersion: string | null
  isBelowMinimumSupported: boolean
}

export type RelayPresentation = RelayMessagePresentation | RelayUpdatePresentation

export interface RelayClientSnapshot {
  enabled: boolean
  environment: RelayEnvironment
  current: RelayPresentation | null
  pendingCount: number
}

export interface RelayActionResult {
  ok: boolean
  outcome?: 'external' | 'trusted-updater'
  error?: string
}
