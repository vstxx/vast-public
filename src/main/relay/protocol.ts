import semver from 'semver'
import {
  RELAY_ASSET_MIME_TYPES,
  RELAY_BROADCAST_TYPES,
  RELAY_PROTOCOL_VERSION,
  RELAY_UPDATE_SEVERITIES,
  type RelayAssetMime,
  type RelayBroadcastAction,
  type RelayBroadcastMedia,
  type RelayBroadcastPayload,
  type RelayBroadcastType,
  type RelayParsedResponse,
  type RelayReleasePayload,
  type RelaySignedEnvelope,
  type RelayUpdateSeverity
} from '../../shared/relay-types.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ASSET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?\.(?:png|webp|gif)$/
const KEY_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,80}$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BASE64_SIGNATURE_PATTERN = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_MESSAGES = 40

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function exactKeys(source: Record<string, unknown>, required: readonly string[], label: string): void {
  const expected = new Set(required)
  if (Object.keys(source).some((key) => !expected.has(key))) throw new Error(`${label} contains an unexpected field.`)
  if (required.some((key) => !Object.hasOwn(source, key))) throw new Error(`${label} is missing a required field.`)
}

function passiveText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new Error(`${label} is not bounded text.`)
  }
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label} is not passive text.`)
  return value
}

function passiveRichText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label} is invalid.`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label} is not passive rich text.`)
  return value
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${label} is not a UUID.`)
  return value.toLowerCase()
}

export function isRelayInstallId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value)
}

export function strictSemVer(value: unknown, label = 'version'): string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 64) throw new Error(`${label} is not SemVer.`)
  const valid = semver.valid(value, { loose: false })
  const comparisonValue = value.includes('+') ? value.slice(0, value.indexOf('+')) : value
  if (valid !== comparisonValue) throw new Error(`${label} is not strict SemVer.`)
  return value
}

function nullableSemVer(value: unknown, label: string): string | null {
  return value === null ? null : strictSemVer(value, label)
}

function utcTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not an unambiguous UTC timestamp.`)
  }
  if (new Date(value).toISOString() !== value) throw new Error(`${label} is not canonical UTC.`)
  return value
}

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`${label} is not an HTTPS URL.`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is not an HTTPS URL.`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href !== value) {
    throw new Error(`${label} is not a canonical HTTPS URL.`)
  }
  return value
}

function keyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) throw new Error('Relay key_id is invalid.')
  return value
}

function media(value: unknown): RelayBroadcastMedia | null {
  if (value === null) return null
  const source = record(value, 'Relay media')
  exactKeys(source, ['id', 'sha256', 'mime'], 'Relay media')
  if (typeof source.id !== 'string' || !ASSET_ID_PATTERN.test(source.id)) throw new Error('Relay asset id is invalid.')
  if (typeof source.sha256 !== 'string' || !SHA256_PATTERN.test(source.sha256)) throw new Error('Relay asset digest is invalid.')
  if (typeof source.mime !== 'string' || !RELAY_ASSET_MIME_TYPES.includes(source.mime as RelayAssetMime)) {
    throw new Error('Relay asset MIME is invalid.')
  }
  return { id: source.id, sha256: source.sha256, mime: source.mime as RelayAssetMime }
}

function action(value: unknown): RelayBroadcastAction | null {
  if (value === null) return null
  const source = record(value, 'Relay action')
  exactKeys(source, ['label', 'url'], 'Relay action')
  return {
    label: passiveText(source.label, 80, 'Relay action label'),
    url: httpsUrl(source.url, 'Relay action URL')
  }
}

function broadcastType(value: unknown): RelayBroadcastType {
  if (typeof value !== 'string' || !RELAY_BROADCAST_TYPES.includes(value as RelayBroadcastType)) {
    throw new Error('Relay broadcast type is unsupported.')
  }
  return value as RelayBroadcastType
}

function updateSeverity(value: unknown): RelayUpdateSeverity {
  if (typeof value !== 'string' || !RELAY_UPDATE_SEVERITIES.includes(value as RelayUpdateSeverity)) {
    throw new Error('Relay update severity is unsupported.')
  }
  return value as RelayUpdateSeverity
}

function safeInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${label} is invalid.`)
  return Number(value)
}

export function parseRelayBroadcastPayload(value: unknown): RelayBroadcastPayload {
  const source = record(value, 'Relay broadcast')
  exactKeys(source, [
    'schema', 'key_id', 'id', 'type', 'title', 'body', 'media', 'action', 'min_version', 'max_version',
    'active_from', 'active_until', 'priority', 'enabled', 'created_at'
  ], 'Relay broadcast')
  if (source.schema !== 'vast-relay-broadcast-v1') throw new Error('Relay broadcast schema is unsupported.')
  if (typeof source.enabled !== 'boolean') throw new Error('Relay broadcast enabled flag is invalid.')
  const minVersion = nullableSemVer(source.min_version, 'Relay min_version')
  const maxVersion = nullableSemVer(source.max_version, 'Relay max_version')
  if (minVersion && maxVersion && semver.gt(minVersion, maxVersion)) throw new Error('Relay version range is invalid.')
  const activeFrom = utcTimestamp(source.active_from, 'Relay active_from')
  const activeUntil = source.active_until === null ? null : utcTimestamp(source.active_until, 'Relay active_until')
  if (activeUntil && Date.parse(activeUntil) <= Date.parse(activeFrom)) throw new Error('Relay activation window is invalid.')
  return {
    schema: 'vast-relay-broadcast-v1',
    key_id: keyId(source.key_id),
    id: uuid(source.id, 'Relay broadcast id'),
    type: broadcastType(source.type),
    title: passiveText(source.title, 160, 'Relay title'),
    body: passiveRichText(source.body, 4_000, 'Relay body'),
    media: media(source.media),
    action: action(source.action),
    min_version: minVersion,
    max_version: maxVersion,
    active_from: activeFrom,
    active_until: activeUntil,
    priority: safeInteger(source.priority, 0, 1_000, 'Relay priority'),
    enabled: source.enabled,
    created_at: utcTimestamp(source.created_at, 'Relay created_at')
  }
}

export function parseRelayReleasePayload(value: unknown): RelayReleasePayload {
  const source = record(value, 'Relay release')
  exactKeys(source, [
    'schema', 'key_id', 'version', 'release_url', 'severity', 'min_supported_version', 'title', 'notes',
    'published_at', 'enabled'
  ], 'Relay release')
  if (source.schema !== 'vast-relay-release-v1') throw new Error('Relay release schema is unsupported.')
  if (typeof source.enabled !== 'boolean') throw new Error('Relay release enabled flag is invalid.')
  return {
    schema: 'vast-relay-release-v1',
    key_id: keyId(source.key_id),
    version: strictSemVer(source.version, 'Relay release version'),
    release_url: httpsUrl(source.release_url, 'Relay release URL'),
    severity: updateSeverity(source.severity),
    min_supported_version: nullableSemVer(source.min_supported_version, 'Relay min_supported_version'),
    title: passiveText(source.title, 160, 'Relay release title'),
    notes: passiveText(source.notes, 2_000, 'Relay release notes'),
    published_at: utcTimestamp(source.published_at, 'Relay published_at'),
    enabled: source.enabled
  }
}

function envelope<T>(value: unknown, parsePayload: (input: unknown) => T): RelaySignedEnvelope<T> {
  const source = record(value, 'Relay signed envelope')
  exactKeys(source, ['key_id', 'payload', 'signature'], 'Relay signed envelope')
  const envelopeKeyId = keyId(source.key_id)
  if (typeof source.signature !== 'string' || !BASE64_SIGNATURE_PATTERN.test(source.signature)) {
    throw new Error('Relay signature is malformed.')
  }
  const payload = parsePayload(source.payload)
  if (!payload || typeof payload !== 'object' || !('key_id' in payload) || payload.key_id !== envelopeKeyId) {
    throw new Error('Relay envelope key_id does not match its payload.')
  }
  return { key_id: envelopeKeyId, payload, signature: source.signature }
}

export function parseRelayResponse(value: unknown): RelayParsedResponse {
  const source = record(value, 'Relay response')
  exactKeys(source, ['protocol', 'server_time', 'messages', 'update'], 'Relay response')
  if (source.protocol !== RELAY_PROTOCOL_VERSION) throw new Error('Relay protocol version is unsupported.')
  const serverTime = utcTimestamp(source.server_time, 'Relay server_time')
  if (!Array.isArray(source.messages) || source.messages.length > MAX_MESSAGES) throw new Error('Relay messages list is invalid.')
  const messages: Array<RelaySignedEnvelope<RelayBroadcastPayload>> = []
  for (const candidate of source.messages) {
    try {
      messages.push(envelope(candidate, parseRelayBroadcastPayload))
    } catch {
      // A malformed or future message type disappears without invalidating safe siblings.
    }
  }
  let update: RelaySignedEnvelope<RelayReleasePayload> | null = null
  if (source.update !== null) {
    try {
      update = envelope(source.update, parseRelayReleasePayload)
    } catch {
      update = null
    }
  }
  return { protocol: RELAY_PROTOCOL_VERSION, serverTime, messages, update }
}

export function relayBroadcastIsActive(payload: RelayBroadcastPayload, currentVersion: string, now: number): boolean {
  if (!payload.enabled || Date.parse(payload.active_from) > now) return false
  if (payload.active_until && Date.parse(payload.active_until) <= now) return false
  if (payload.min_version && semver.lt(currentVersion, payload.min_version)) return false
  if (payload.max_version && semver.gt(currentVersion, payload.max_version)) return false
  return true
}

export function relayReleaseIsEligible(payload: RelayReleasePayload, currentVersion: string, now: number): boolean {
  return payload.enabled && Date.parse(payload.published_at) <= now && semver.gt(payload.version, currentVersion)
}
