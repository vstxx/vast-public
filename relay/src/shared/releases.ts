import { canonicalize } from './canonical'
import { RELEASE_SEVERITIES } from './constants'
import type { ReleaseInput, ReleasePayload, ReleaseSeverity, SignedEnvelope } from './types'
import {
  exactKeys,
  objectRecord,
  passiveText,
  validateHttpsUrl,
  validateIsoUtc,
  validateKeyId,
  validateSemVer,
  ValidationError
} from './validation'

export function createReleasePayload(input: ReleaseInput, keyId: string, now: number): ReleasePayload {
  return {
    schema: 'vast-relay-release-v1',
    key_id: validateKeyId(keyId),
    version: input.version,
    release_url: input.release_url,
    severity: input.severity,
    min_supported_version: input.min_supported_version,
    title: input.title,
    notes: input.notes,
    published_at: input.published_at ?? new Date(now).toISOString(),
    enabled: input.enabled
  }
}

function parseSeverity(value: unknown): ReleaseSeverity {
  if (typeof value !== 'string' || !RELEASE_SEVERITIES.includes(value as ReleaseSeverity)) {
    throw new ValidationError('Stored release severity is invalid.')
  }
  return value as ReleaseSeverity
}

export function parseStoredReleasePayload(canonicalPayload: string): ReleasePayload {
  let decoded: unknown
  try {
    decoded = JSON.parse(canonicalPayload) as unknown
  } catch {
    throw new ValidationError('Stored release payload is not JSON.')
  }
  const source = objectRecord(decoded, 'Stored release')
  exactKeys(source, [
    'schema', 'key_id', 'version', 'release_url', 'severity', 'min_supported_version', 'title', 'notes',
    'published_at', 'enabled'
  ], [], 'Stored release')
  if (source.schema !== 'vast-relay-release-v1') throw new ValidationError('Stored release schema is invalid.')
  if (typeof source.enabled !== 'boolean') throw new ValidationError('Stored release enabled flag is invalid.')
  const payload: ReleasePayload = {
    schema: 'vast-relay-release-v1',
    key_id: validateKeyId(source.key_id),
    version: validateSemVer(source.version),
    release_url: validateHttpsUrl(source.release_url, 'Stored release URL'),
    severity: parseSeverity(source.severity),
    min_supported_version: source.min_supported_version === null ? null : validateSemVer(source.min_supported_version, 'min_supported_version'),
    title: passiveText(source.title, 160, 'Stored release title'),
    notes: passiveText(source.notes, 2000, 'Stored release notes'),
    published_at: validateIsoUtc(source.published_at, 'Stored release published_at'),
    enabled: source.enabled
  }
  if (canonicalize(payload) !== canonicalPayload) throw new ValidationError('Stored release is not canonically serialized.')
  return payload
}

export function storedReleaseEnvelope(canonicalPayload: string, signature: string, keyId: string): SignedEnvelope<ReleasePayload> {
  const payload = parseStoredReleasePayload(canonicalPayload)
  if (payload.key_id !== keyId || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(signature)) {
    throw new ValidationError('Stored release signature metadata is invalid.')
  }
  return { key_id: keyId, payload, signature }
}
