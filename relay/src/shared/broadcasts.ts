import { canonicalize } from './canonical'
import { BROADCAST_TYPES } from './constants'
import type {
  AssetRow,
  BroadcastAction,
  BroadcastInput,
  BroadcastMedia,
  BroadcastPayload,
  BroadcastType,
  SignedEnvelope
} from './types'
import {
  exactKeys,
  objectRecord,
  passiveText,
  toIsoUtc,
  validateAssetId,
  validateAssetMime,
  validateIsoUtc,
  validateKeyId,
  validateSemVer,
  validateUuid,
  ValidationError
} from './validation'

export function createBroadcastPayload(
  input: BroadcastInput,
  id: string,
  keyId: string,
  createdAt: number,
  asset: AssetRow | null
): BroadcastPayload {
  const media: BroadcastMedia | null = asset ? {
    id: asset.id,
    sha256: asset.sha256,
    mime: asset.mime_type
  } : null
  const action: BroadcastAction | null = input.action_label && input.action_url ? {
    label: input.action_label,
    url: input.action_url
  } : null
  return {
    schema: 'vast-relay-broadcast-v1',
    key_id: validateKeyId(keyId),
    id: validateUuid(id, 'Broadcast id'),
    type: input.type,
    title: input.title,
    body: input.body,
    media,
    action,
    min_version: input.min_version,
    max_version: input.max_version,
    active_from: input.active_from,
    active_until: input.active_until,
    priority: input.priority,
    enabled: input.enabled,
    created_at: toIsoUtc(createdAt)
  }
}

function parseMedia(value: unknown): BroadcastMedia | null {
  if (value === null) return null
  const source = objectRecord(value, 'Broadcast media')
  exactKeys(source, ['id', 'sha256', 'mime'], [], 'Broadcast media')
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new ValidationError('Broadcast media digest is invalid.')
  }
  return {
    id: validateAssetId(source.id),
    sha256: source.sha256,
    mime: validateAssetMime(source.mime)
  }
}

function parseAction(value: unknown): BroadcastAction | null {
  if (value === null) return null
  const source = objectRecord(value, 'Broadcast action')
  exactKeys(source, ['label', 'url'], [], 'Broadcast action')
  const url = typeof source.url === 'string' ? source.url : ''
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ValidationError('Broadcast action URL is invalid.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href !== url) {
    throw new ValidationError('Broadcast action URL is invalid.')
  }
  return { label: passiveText(source.label, 80, 'Broadcast action label'), url }
}

function parseNullableSemVer(value: unknown, label: string): string | null {
  return value === null ? null : validateSemVer(value, label)
}

function parseBroadcastType(value: unknown): BroadcastType {
  if (typeof value !== 'string' || !BROADCAST_TYPES.includes(value as BroadcastType)) {
    throw new ValidationError('Stored broadcast type is invalid.')
  }
  return value as BroadcastType
}

export function parseStoredBroadcastPayload(canonicalPayload: string): BroadcastPayload {
  let decoded: unknown
  try {
    decoded = JSON.parse(canonicalPayload) as unknown
  } catch {
    throw new ValidationError('Stored broadcast payload is not JSON.')
  }
  const source = objectRecord(decoded, 'Stored broadcast')
  exactKeys(source, [
    'schema', 'key_id', 'id', 'type', 'title', 'body', 'media', 'action', 'min_version', 'max_version',
    'active_from', 'active_until', 'priority', 'enabled', 'created_at'
  ], [], 'Stored broadcast')
  if (source.schema !== 'vast-relay-broadcast-v1') throw new ValidationError('Stored broadcast schema is invalid.')
  if (!Number.isInteger(source.priority) || Number(source.priority) < 0 || Number(source.priority) > 1000) {
    throw new ValidationError('Stored broadcast priority is invalid.')
  }
  if (typeof source.enabled !== 'boolean') throw new ValidationError('Stored broadcast enabled flag is invalid.')
  const payload: BroadcastPayload = {
    schema: 'vast-relay-broadcast-v1',
    key_id: validateKeyId(source.key_id),
    id: validateUuid(source.id, 'Broadcast id'),
    type: parseBroadcastType(source.type),
    title: passiveText(source.title, 160, 'Broadcast title'),
    body: passiveText(source.body, 4000, 'Broadcast body'),
    media: parseMedia(source.media),
    action: parseAction(source.action),
    min_version: parseNullableSemVer(source.min_version, 'Broadcast min_version'),
    max_version: parseNullableSemVer(source.max_version, 'Broadcast max_version'),
    active_from: validateIsoUtc(source.active_from, 'Broadcast active_from'),
    active_until: source.active_until === null ? null : validateIsoUtc(source.active_until, 'Broadcast active_until'),
    priority: Number(source.priority),
    enabled: source.enabled,
    created_at: validateIsoUtc(source.created_at, 'Broadcast created_at')
  }
  if (canonicalize(payload) !== canonicalPayload) throw new ValidationError('Stored broadcast is not canonically serialized.')
  return payload
}

export function storedBroadcastEnvelope(canonicalPayload: string, signature: string, keyId: string): SignedEnvelope<BroadcastPayload> {
  const payload = parseStoredBroadcastPayload(canonicalPayload)
  if (payload.key_id !== keyId || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(signature)) {
    throw new ValidationError('Stored broadcast signature metadata is invalid.')
  }
  return { key_id: keyId, payload, signature }
}
