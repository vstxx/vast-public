import semver from 'semver'
import {
  ASSET_MIME_TYPES,
  BROADCAST_TYPES,
  MAX_LAUNCH_COUNT,
  PROTOCOL_VERSION,
  RELEASE_SEVERITIES
} from './constants'
import type {
  AssetMime,
  BroadcastInput,
  BroadcastType,
  CheckinRequest,
  ReleaseInput,
  ReleaseSeverity
} from './types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ASSET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?\.(?:png|webp|gif)$/
const KEY_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,80}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

export class ValidationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ValidationError'
    this.status = status
  }
}

export function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (keys.some((key) => !allowed.has(key))) throw new ValidationError(`${label} contains an unexpected field.`)
  if (required.some((key) => !Object.hasOwn(value, key))) throw new ValidationError(`${label} is missing a required field.`)
}

export function validateUuid(value: unknown, label = 'install_id'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ValidationError(`${label} must be a valid UUID.`)
  return value.toLowerCase()
}

export function validateSemVer(value: unknown, label = 'version'): string {
  if (typeof value !== 'string' || value.length > 64 || value.length < 5) {
    throw new ValidationError(`${label} must be a valid SemVer string.`)
  }
  const parsed = semver.valid(value, { loose: false })
  const comparisonValue = value.includes('+') ? value.slice(0, value.indexOf('+')) : value
  if (parsed !== comparisonValue) throw new ValidationError(`${label} must be a strict SemVer string.`)
  return value
}

export function optionalSemVer(value: unknown, label: string): string | null {
  if (value === null) return null
  return validateSemVer(value, label)
}

export function validateCheckin(value: unknown): CheckinRequest {
  const source = objectRecord(value, 'Check-in')
  exactKeys(source, ['protocol', 'install_id', 'current_version', 'launch_count'], [], 'Check-in')
  if (!Number.isInteger(source.protocol) || source.protocol !== PROTOCOL_VERSION) {
    throw new ValidationError('Unsupported Relay protocol.', 400)
  }
  if (!Number.isInteger(source.launch_count) || Number(source.launch_count) < 0 || Number(source.launch_count) > MAX_LAUNCH_COUNT) {
    throw new ValidationError('launch_count must be a bounded non-negative integer.')
  }
  return {
    protocol: PROTOCOL_VERSION,
    install_id: validateUuid(source.install_id),
    current_version: validateSemVer(source.current_version, 'current_version'),
    launch_count: Number(source.launch_count)
  }
}

export function passiveText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`)
  const text = value.trim()
  if (!text || text.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new ValidationError(`${label} must be bounded passive plain text.`)
  }
  return text
}

export function passiveRichText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`)
  const text = value.trim()
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new ValidationError(`${label} must be bounded passive rich text.`)
  }
  return text
}

export function validateIsoUtc(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${label} must be an unambiguous UTC ISO timestamp.`)
  }
  return new Date(value).toISOString()
}

export function toIsoUtc(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError('Stored timestamp is invalid.')
  return new Date(value).toISOString()
}

export function validateHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new ValidationError(`${label} must be an HTTPS URL.`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError(`${label} must be an HTTPS URL.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ValidationError(`${label} must be an HTTPS URL without credentials.`)
  return url.href
}

export function validateKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) throw new ValidationError('key_id is invalid.')
  return value
}

export function validateAssetId(value: unknown): string {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value) || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new ValidationError('Asset id is invalid.')
  }
  return value
}

export function assetMimeForId(assetId: string): AssetMime {
  const extension = assetId.slice(assetId.lastIndexOf('.') + 1)
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  throw new ValidationError('Asset extension is not allowed.')
}

export function validateAssetMime(value: unknown): AssetMime {
  if (typeof value !== 'string' || !ASSET_MIME_TYPES.includes(value as AssetMime)) {
    throw new ValidationError('Asset Content-Type is not allowed.', 415)
  }
  return value as AssetMime
}

function nullableText(value: unknown, max: number, label: string): string | null {
  return value === null ? null : passiveText(value, max, label)
}

function broadcastType(value: unknown): BroadcastType {
  if (typeof value !== 'string' || !BROADCAST_TYPES.includes(value as BroadcastType)) {
    throw new ValidationError('Broadcast type is not allowed.')
  }
  return value as BroadcastType
}

function releaseSeverity(value: unknown): ReleaseSeverity {
  if (typeof value !== 'string' || !RELEASE_SEVERITIES.includes(value as ReleaseSeverity)) {
    throw new ValidationError('Release severity is not allowed.')
  }
  return value as ReleaseSeverity
}

export function validateBroadcastInput(value: unknown): BroadcastInput {
  const source = objectRecord(value, 'Broadcast')
  const required = [
    'type', 'title', 'body', 'media_id', 'action_label', 'action_url', 'min_version', 'max_version',
    'active_from', 'active_until', 'priority', 'enabled'
  ]
  exactKeys(source, required, ['id', 'draft'], 'Broadcast')
  const id = source.id === undefined ? undefined : validateUuid(source.id, 'Broadcast id')
  if (source.draft !== undefined && typeof source.draft !== 'boolean') throw new ValidationError('draft must be a boolean.')
  const mediaId = source.media_id === null ? null : validateAssetId(source.media_id)
  const actionLabel = nullableText(source.action_label, 80, 'action_label')
  const actionUrl = source.action_url === null ? null : validateHttpsUrl(source.action_url, 'action_url')
  if ((actionLabel === null) !== (actionUrl === null)) throw new ValidationError('action_label and action_url must be supplied together.')
  const minVersion = optionalSemVer(source.min_version, 'min_version')
  const maxVersion = optionalSemVer(source.max_version, 'max_version')
  if (minVersion && maxVersion && semver.gt(minVersion, maxVersion)) throw new ValidationError('min_version must not exceed max_version.')
  const activeFrom = validateIsoUtc(source.active_from, 'active_from')
  const activeUntil = source.active_until === null ? null : validateIsoUtc(source.active_until, 'active_until')
  if (activeUntil && Date.parse(activeUntil) <= Date.parse(activeFrom)) throw new ValidationError('active_until must be later than active_from.')
  if (!Number.isInteger(source.priority) || Number(source.priority) < 0 || Number(source.priority) > 1000) {
    throw new ValidationError('priority must be an integer between 0 and 1000.')
  }
  if (typeof source.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean.')
  if (source.enabled && source.draft === true) throw new ValidationError('A draft cannot be enabled.')
  return {
    id,
    draft: source.draft ?? false,
    type: broadcastType(source.type),
    title: passiveText(source.title, 160, 'title'),
    body: passiveRichText(source.body, 4000, 'body'),
    media_id: mediaId,
    action_label: actionLabel,
    action_url: actionUrl,
    min_version: minVersion,
    max_version: maxVersion,
    active_from: activeFrom,
    active_until: activeUntil,
    priority: Number(source.priority),
    enabled: source.enabled
  }
}

export function validateReleaseInput(value: unknown): ReleaseInput {
  const source = objectRecord(value, 'Release')
  exactKeys(source, [
    'version', 'release_url', 'severity', 'min_supported_version', 'title', 'notes', 'published_at', 'enabled'
  ], [], 'Release')
  if (typeof source.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean.')
  return {
    version: validateSemVer(source.version),
    release_url: validateHttpsUrl(source.release_url, 'release_url'),
    severity: releaseSeverity(source.severity),
    min_supported_version: optionalSemVer(source.min_supported_version, 'min_supported_version'),
    title: passiveText(source.title, 160, 'title'),
    notes: passiveText(source.notes, 2000, 'notes'),
    published_at: source.published_at === null ? null : validateIsoUtc(source.published_at, 'published_at'),
    enabled: source.enabled
  }
}
