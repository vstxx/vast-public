export type BroadcastType = 'welcome' | 'seasonal' | 'announcement' | 'security' | 'update_notice'
export type ReleaseSeverity = 'optional' | 'recommended' | 'important' | 'critical'
export type BroadcastState = 'draft' | 'scheduled' | 'active' | 'expired' | 'disabled'

export interface SessionInfo {
  actor: string
  environment: 'staging' | 'production' | 'local'
  key_id: string
}

export interface DashboardSummary {
  generated_at: string
  totals: {
    installations: number
    active_24h: number
    active_7d: number
    active_30d: number
    new_24h: number
    new_7d: number
    new_30d: number
  }
  launch_counts: {
    average: number | null
    maximum: number | null
    total: number | null
  }
  versions: Array<{ version: string; count: number; percentage: number }>
}

export interface Installation {
  install_id: string
  current_version: string
  first_seen: string
  last_seen: string
  launch_count: number
}

export interface InstallationListResponse {
  items: Installation[]
  total: number
  next_cursor: string | null
}

export interface BroadcastPayload {
  schema: 'vast-relay-broadcast-v1'
  key_id: string
  id: string
  type: BroadcastType
  title: string
  body: string
  media: { id: string; sha256: string; mime: 'image/png' | 'image/webp' | 'image/gif' } | null
  action: { label: string; url: string } | null
  min_version: string | null
  max_version: string | null
  active_from: string
  active_until: string | null
  priority: number
  enabled: boolean
  created_at: string
}

export interface BroadcastAdminItem {
  key_id: string
  payload: BroadcastPayload
  signature: string
  state: BroadcastState
  draft: boolean
  revision: number
  updated_at: string
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

export interface AssetItem {
  id: string
  mime: 'image/png' | 'image/webp' | 'image/gif'
  size: number
  sha256: string
  created_at: string
  reference_count: number
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

export interface ReleaseAdminItem {
  key_id: string
  payload: ReleasePayload
  signature: string
  revision: number
  state: 'enabled' | 'disabled'
  updated_at: string
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

export interface AuditItem {
  id: number
  action: string
  target_type: 'broadcast' | 'asset' | 'release'
  target_id: string
  actor: string
  summary: Record<string, string | number | boolean | null>
  occurred_at: string
}
