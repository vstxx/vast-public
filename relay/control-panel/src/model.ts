import type {
  BroadcastAdminItem,
  BroadcastInput,
  BroadcastPayload,
  ReleaseAdminItem,
  ReleaseInput
} from './types'

export function formatNumber(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

export function formatDate(value: string | null): string {
  if (!value) return 'No end date'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Invalid date'
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date)
}

export function toDateTimeLocal(value: string | null): string {
  const date = value ? new Date(value) : new Date()
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function broadcastInputFrom(item: BroadcastAdminItem): BroadcastInput {
  const payload = item.payload
  return {
    id: payload.id,
    draft: item.draft,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    media_id: payload.media?.id ?? null,
    action_label: payload.action?.label ?? null,
    action_url: payload.action?.url ?? null,
    min_version: payload.min_version,
    max_version: payload.max_version,
    active_from: payload.active_from,
    active_until: payload.active_until,
    priority: payload.priority,
    enabled: payload.enabled
  }
}

export function duplicateBroadcastInput(item: BroadcastAdminItem, now = new Date()): BroadcastInput {
  const input = broadcastInputFrom(item)
  delete input.id
  input.title = `${input.title} — copy`.slice(0, 160)
  input.draft = true
  input.enabled = false
  input.active_from = now.toISOString()
  input.active_until = null
  return input
}

export function expireBroadcastInput(item: BroadcastAdminItem, now = new Date()): BroadcastInput {
  const input = broadcastInputFrom(item)
  const end = now.toISOString()
  input.draft = false
  input.enabled = true
  input.active_until = end
  if (Date.parse(input.active_from) >= now.getTime()) {
    input.active_from = new Date(now.getTime() - 1_000).toISOString()
  }
  return input
}

export function releaseInputFrom(item: ReleaseAdminItem): ReleaseInput {
  const payload = item.payload
  return {
    version: payload.version,
    release_url: payload.release_url,
    severity: payload.severity,
    min_supported_version: payload.min_supported_version,
    title: payload.title,
    notes: payload.notes,
    published_at: payload.published_at,
    enabled: payload.enabled
  }
}

export function previewPayload(input: BroadcastInput): Pick<BroadcastPayload, 'type' | 'title' | 'body' | 'action'> {
  return {
    type: input.type,
    title: input.title,
    body: input.body,
    action: input.action_label && input.action_url ? { label: input.action_label, url: input.action_url } : null
  }
}
