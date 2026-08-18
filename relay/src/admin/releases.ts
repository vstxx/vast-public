import { auditStatement, type AdminAuditEvent } from './audit'
import type { AccessIdentity } from './auth'
import { assertCurrentRevision, requireRevision, revisionHeaders } from './concurrency'
import { signingPrivateKey } from './signing'
import { canonicalize } from '../shared/canonical'
import { MAX_ADMIN_JSON_BODY_BYTES } from '../shared/constants'
import { signCanonicalPayload } from '../shared/crypto'
import { errorResponse, jsonResponse, readJsonBody } from '../shared/http'
import { logEvent, logFailure } from '../shared/logging'
import { createReleasePayload, storedReleaseEnvelope } from '../shared/releases'
import type { ReleaseInput, ReleaseRow } from '../shared/types'
import { validateReleaseInput, validateSemVer, ValidationError } from '../shared/validation'

const RELEASE_SELECT = `
  SELECT version, release_url, severity, min_supported_version, title, notes, published_at, enabled,
         canonical_payload, signature, key_id, revision, updated_at
  FROM releases
`

async function signedRelease(request: Request, env: AdminEnv, now: number): Promise<{
  input: ReleaseInput
  payload: ReturnType<typeof createReleasePayload>
  canonical: string
  signature: string
}> {
  const input = validateReleaseInput(await readJsonBody(request, MAX_ADMIN_JSON_BODY_BYTES))
  if (input.severity === 'critical' && input.enabled && request.headers.get('x-vast-critical-confirmation') !== 'PUBLISH CRITICAL') {
    throw new ValidationError('Publishing a critical update requires explicit confirmation.', 409)
  }
  const payload = createReleasePayload(input, env.RELAY_KEY_ID, now)
  const canonical = canonicalize(payload)
  const signature = await signCanonicalPayload(payload, signingPrivateKey(env))
  return { input, payload, canonical, signature }
}

function adminRelease(row: ReleaseRow): Record<string, unknown> {
  return {
    ...storedReleaseEnvelope(row.canonical_payload, row.signature, row.key_id),
    revision: row.revision,
    state: Boolean(row.enabled) ? 'enabled' : 'disabled',
    updated_at: new Date(row.updated_at).toISOString()
  }
}

export async function listReleases(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(`${RELEASE_SELECT} ORDER BY published_at DESC LIMIT 200`).all<ReleaseRow>()
  const items = result.results.flatMap((row) => {
    try {
      return [adminRelease(row)]
    } catch (error) {
      logFailure('admin_release_invalid', error, { release_version: row.version })
      return []
    }
  })
  return jsonResponse({ items })
}

export async function getRelease(env: AdminEnv, version: string): Promise<Response> {
  const row = await env.DB.prepare(`${RELEASE_SELECT} WHERE version = ?`).bind(version).first<ReleaseRow>()
  if (!row) return errorResponse(404, 'release_not_found')
  return jsonResponse(adminRelease(row), { headers: revisionHeaders(row.revision) })
}

export async function createRelease(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  now = Date.now()
): Promise<Response> {
  const signed = await signedRelease(request, env, now)
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO releases (
          version, release_url, severity, min_supported_version, title, notes, published_at, enabled,
          canonical_payload, signature, key_id, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).bind(
        signed.input.version, signed.input.release_url, signed.input.severity, signed.input.min_supported_version,
        signed.input.title, signed.input.notes, Date.parse(signed.payload.published_at), signed.input.enabled ? 1 : 0,
        signed.canonical, signed.signature, env.RELAY_KEY_ID, now
      ),
      auditStatement(env.DB, 'release_created', 'release', signed.input.version, identity, {
        enabled: signed.input.enabled,
        key_id: env.RELAY_KEY_ID,
        severity: signed.input.severity,
        title: signed.input.title
      }, now)
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE constraint failed')) throw new ValidationError('Release already exists.', 409)
    throw error
  }
  logEvent('info', 'admin_operation', { operation: 'release_created', entity_id: signed.input.version, actor: identity.actor })
  return jsonResponse({
    key_id: env.RELAY_KEY_ID,
    payload: signed.payload,
    signature: signed.signature,
    revision: 1,
    state: signed.input.enabled ? 'enabled' : 'disabled',
    updated_at: new Date(now).toISOString()
  }, { status: 201, headers: revisionHeaders(1) })
}

export async function updateRelease(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  version: string,
  now = Date.now()
): Promise<Response> {
  const existing = await env.DB.prepare(`${RELEASE_SELECT} WHERE version = ?`).bind(version).first<ReleaseRow>()
  if (!existing) return errorResponse(404, 'release_not_found')
  const expectedRevision = requireRevision(request)
  assertCurrentRevision(expectedRevision, existing.revision)
  const signed = await signedRelease(request, env, now)
  if (signed.input.version !== version) throw new ValidationError('Release version cannot be changed.')
  const nextRevision = existing.revision + 1
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE releases SET release_url = ?, severity = ?, min_supported_version = ?, title = ?, notes = ?,
        published_at = ?, enabled = ?, canonical_payload = ?, signature = ?, key_id = ?, revision = ?, updated_at = ?
      WHERE version = ? AND revision = ?
    `).bind(
      signed.input.release_url, signed.input.severity, signed.input.min_supported_version, signed.input.title,
      signed.input.notes, Date.parse(signed.payload.published_at), signed.input.enabled ? 1 : 0,
      signed.canonical, signed.signature, env.RELAY_KEY_ID, nextRevision, now, version, expectedRevision
    ),
    auditStatement(env.DB, 'release_updated', 'release', version, identity, {
      enabled: signed.input.enabled,
      revision: nextRevision,
      severity: signed.input.severity,
      title: signed.input.title
    }, now)
  ]
  if (Boolean(existing.enabled) !== signed.input.enabled) {
    const event: AdminAuditEvent = signed.input.enabled ? 'release_enabled' : 'release_disabled'
    statements.push(auditStatement(env.DB, event, 'release', version, identity, {
      revision: nextRevision,
      severity: signed.input.severity,
      title: signed.input.title
    }, now))
  }
  const results = await env.DB.batch(statements)
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new ValidationError('The record changed; refresh before editing.', 409)
  logEvent('info', 'admin_operation', { operation: 'release_updated', entity_id: version, actor: identity.actor })
  return jsonResponse({
    key_id: env.RELAY_KEY_ID,
    payload: signed.payload,
    signature: signed.signature,
    revision: nextRevision,
    state: signed.input.enabled ? 'enabled' : 'disabled',
    updated_at: new Date(now).toISOString()
  }, { headers: revisionHeaders(nextRevision) })
}

export async function deleteRelease(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  version: string,
  now = Date.now()
): Promise<Response> {
  const existing = await env.DB.prepare(`${RELEASE_SELECT} WHERE version = ?`).bind(version).first<ReleaseRow>()
  if (!existing) return errorResponse(404, 'release_not_found')
  assertCurrentRevision(requireRevision(request), existing.revision)
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM releases WHERE version = ? AND revision = ?').bind(version, existing.revision),
    auditStatement(env.DB, 'release_deleted', 'release', version, identity, {
      revision: existing.revision,
      severity: existing.severity,
      title: existing.title
    }, now)
  ])
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new ValidationError('The record changed; refresh before deleting.', 409)
  logEvent('info', 'admin_operation', { operation: 'release_deleted', entity_id: version, actor: identity.actor })
  return jsonResponse({ deleted: true })
}

export function parseReleasePathVersion(value: string): string {
  try {
    return validateSemVer(decodeURIComponent(value), 'Release version')
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('Release version is invalid.')
  }
}
