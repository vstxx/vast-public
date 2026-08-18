import type { ASSET_MIME_TYPES, BROADCAST_TYPES, RELEASE_SEVERITIES } from './constants'

export type BroadcastType = (typeof BROADCAST_TYPES)[number]
export type ReleaseSeverity = (typeof RELEASE_SEVERITIES)[number]
export type AssetMime = (typeof ASSET_MIME_TYPES)[number]

export interface CheckinRequest {
  protocol: 1
  install_id: string
  current_version: string
  launch_count: number
}

export interface SignedEnvelope<T> {
  key_id: string
  payload: T
  signature: string
}

export interface BroadcastMedia {
  id: string
  sha256: string
  mime: AssetMime
}

export interface BroadcastAction {
  label: string
  url: string
}

export interface BroadcastPayload {
  schema: 'vast-relay-broadcast-v1'
  key_id: string
  id: string
  type: BroadcastType
  title: string
  body: string
  media: BroadcastMedia | null
  action: BroadcastAction | null
  min_version: string | null
  max_version: string | null
  active_from: string
  active_until: string | null
  priority: number
  enabled: boolean
  created_at: string
}

export interface ReleasePayload {
  schema: 'vast-relay-release-v1'
  key_id: string
  version: string
  release_url: string
  severity: ReleaseSeverity
  min_supported_version: string | null
  title: string
  notes: string
  published_at: string
  enabled: boolean
}

export interface CheckinResponse {
  protocol: 1
  server_time: string
  messages: Array<SignedEnvelope<BroadcastPayload>>
  update: SignedEnvelope<ReleasePayload> | null
}

export interface AssetRow {
  id: string
  object_key: string
  mime_type: AssetMime
  size: number
  sha256: string
  created_at: number
}

export interface BroadcastRow {
  id: string
  type: BroadcastType
  title: string
  body: string
  asset_id: string | null
  action_label: string | null
  action_url: string | null
  min_version: string | null
  max_version: string | null
  active_from: number
  active_until: number | null
  priority: number
  enabled: number
  created_at: number
  canonical_payload: string
  signature: string
  key_id: string
  revision: number
  updated_at: number
  draft: number
}

export interface ReleaseRow {
  version: string
  release_url: string
  severity: ReleaseSeverity
  min_supported_version: string | null
  title: string
  notes: string
  published_at: number
  enabled: number
  canonical_payload: string
  signature: string
  key_id: string
  revision: number
  updated_at: number
}

export interface BroadcastInput {
  id?: string
  draft?: boolean
  type: BroadcastType
  title: string
  body: string
  media_id: string | null
  action_label: string | null
  action_url: string | null
  min_version: string | null
  max_version: string | null
  active_from: string
  active_until: string | null
  priority: number
  enabled: boolean
}

export interface ReleaseInput {
  version: string
  release_url: string
  severity: ReleaseSeverity
  min_supported_version: string | null
  title: string
  notes: string
  published_at: string | null
  enabled: boolean
}
