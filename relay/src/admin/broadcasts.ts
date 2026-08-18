import { auditStatement, type AdminAuditEvent } from './audit'
import type { AccessIdentity } from './auth'
import { assertCurrentRevision, requireRevision, revisionHeaders } from './concurrency'
import { signingPrivateKey } from './signing'
import { createBroadcastPayload, storedBroadcastEnvelope } from '../shared/broadcasts'
import { canonicalize } from '../shared/canonical'
import { MAX_ADMIN_JSON_BODY_BYTES } from '../shared/constants'
import { signCanonicalPayload } from '../shared/crypto'
import { errorResponse, jsonResponse, readJsonBody } from '../shared/http'
import { logEvent, logFailure } from '../shared/logging'
import type { AssetRow, BroadcastInput, BroadcastRow } from '../shared/types'
import { validateBroadcastInput, validateUuid, ValidationError } from '../shared/validation'

const BROADCAST_SELECT = `
  SELECT id, type, title, body, asset_id, action_label, action_url, min_version, max_version,
         active_from, active_until, priority, enabled, created_at, canonical_payload, signature, key_id,
         revision, updated_at, draft
  FROM broadcasts
`

async function assetForInput(db: D1Database, input: BroadcastInput): Promise<AssetRow | null> {
  if (!input.media_id) return null
  const asset = await db.prepare(`
    SELECT id, object_key, mime_type, size, sha256, created_at FROM assets WHERE id = ?
  `).bind(input.media_id).first<AssetRow>()
  if (!asset) throw new ValidationError('Referenced asset does not exist.')
  return asset
}

function conflictFrom(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('UNIQUE constraint failed')) throw new ValidationError('Broadcast already exists.', 409)
  throw error
}

async function signedBroadcast(
  env: AdminEnv,
  input: BroadcastInput,
  id: string,
  createdAt: number
): Promise<{ payload: ReturnType<typeof createBroadcastPayload>; canonical: string; signature: string }> {
  const asset = await assetForInput(env.DB, input)
  const payload = createBroadcastPayload(input, id, env.RELAY_KEY_ID, createdAt, asset)
  const canonical = canonicalize(payload)
  const signature = await signCanonicalPayload(payload, signingPrivateKey(env))
  return { payload, canonical, signature }
}

function broadcastState(row: BroadcastRow, now: number): 'draft' | 'scheduled' | 'active' | 'expired' | 'disabled' {
  if (Boolean(row.draft)) return 'draft'
  if (!Boolean(row.enabled)) return 'disabled'
  if (row.active_until !== null && row.active_until <= now) return 'expired'
  if (row.active_from > now) return 'scheduled'
  return 'active'
}

function adminBroadcast(row: BroadcastRow, now: number): Record<string, unknown> {
  const envelope = storedBroadcastEnvelope(row.canonical_payload, row.signature, row.key_id)
  return {
    ...envelope,
    state: broadcastState(row, now),
    draft: Boolean(row.draft),
    revision: row.revision,
    updated_at: new Date(row.updated_at).toISOString()
  }
}

export async function listBroadcasts(env: AdminEnv, now = Date.now()): Promise<Response> {
  const result = await env.DB.prepare(`${BROADCAST_SELECT} ORDER BY created_at DESC LIMIT 200`).all<BroadcastRow>()
  const items = result.results.flatMap((row) => {
    try {
      return [adminBroadcast(row, now)]
    } catch (error) {
      logFailure('admin_broadcast_invalid', error, { broadcast_id: row.id })
      return []
    }
  })
  return jsonResponse({ items })
}

export async function getBroadcast(env: AdminEnv, id: string, now = Date.now()): Promise<Response> {
  const row = await env.DB.prepare(`${BROADCAST_SELECT} WHERE id = ?`).bind(id).first<BroadcastRow>()
  if (!row) return errorResponse(404, 'broadcast_not_found')
  return jsonResponse(adminBroadcast(row, now), { headers: revisionHeaders(row.revision) })
}

export async function createBroadcast(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  now = Date.now()
): Promise<Response> {
  const input = validateBroadcastInput(await readJsonBody(request, MAX_ADMIN_JSON_BODY_BYTES))
  const id = input.id ?? crypto.randomUUID()
  const signed = await signedBroadcast(env, input, id, now)
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO broadcasts (
          id, type, title, body, asset_id, action_label, action_url, min_version, max_version,
          active_from, active_until, priority, enabled, created_at, canonical_payload, signature, key_id,
          revision, updated_at, draft
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).bind(
        id, input.type, input.title, input.body, input.media_id, input.action_label, input.action_url,
        input.min_version, input.max_version, Date.parse(input.active_from),
        input.active_until ? Date.parse(input.active_until) : null, input.priority, input.enabled ? 1 : 0,
        now, signed.canonical, signed.signature, env.RELAY_KEY_ID, now, input.draft ? 1 : 0
      ),
      auditStatement(env.DB, 'broadcast_created', 'broadcast', id, identity, {
        draft: Boolean(input.draft),
        enabled: input.enabled,
        key_id: env.RELAY_KEY_ID,
        priority: input.priority,
        title: input.title,
        type: input.type
      }, now)
    ])
  } catch (error) {
    conflictFrom(error)
  }
  logEvent('info', 'admin_operation', { operation: 'broadcast_created', entity_id: id, actor: identity.actor })
  return jsonResponse({
    key_id: env.RELAY_KEY_ID,
    payload: signed.payload,
    signature: signed.signature,
    state: input.draft ? 'draft' : input.enabled ? 'scheduled' : 'disabled',
    draft: Boolean(input.draft),
    revision: 1,
    updated_at: new Date(now).toISOString()
  }, { status: 201, headers: revisionHeaders(1) })
}

export async function updateBroadcast(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  id: string,
  now = Date.now()
): Promise<Response> {
  const existing = await env.DB.prepare(`${BROADCAST_SELECT} WHERE id = ?`).bind(id).first<BroadcastRow>()
  if (!existing) return errorResponse(404, 'broadcast_not_found')
  const expectedRevision = requireRevision(request)
  assertCurrentRevision(expectedRevision, existing.revision)
  const input = validateBroadcastInput(await readJsonBody(request, MAX_ADMIN_JSON_BODY_BYTES))
  if (input.id && input.id !== id) throw new ValidationError('Broadcast id cannot be changed.')
  const signed = await signedBroadcast(env, input, id, existing.created_at)
  const nextRevision = existing.revision + 1
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE broadcasts SET
        type = ?, title = ?, body = ?, asset_id = ?, action_label = ?, action_url = ?, min_version = ?, max_version = ?,
        active_from = ?, active_until = ?, priority = ?, enabled = ?, canonical_payload = ?, signature = ?, key_id = ?,
        revision = ?, updated_at = ?, draft = ?
      WHERE id = ? AND revision = ?
    `).bind(
      input.type, input.title, input.body, input.media_id, input.action_label, input.action_url,
      input.min_version, input.max_version, Date.parse(input.active_from),
      input.active_until ? Date.parse(input.active_until) : null, input.priority, input.enabled ? 1 : 0,
      signed.canonical, signed.signature, env.RELAY_KEY_ID, nextRevision, now, input.draft ? 1 : 0,
      id, expectedRevision
    ),
    auditStatement(env.DB, 'broadcast_updated', 'broadcast', id, identity, {
      draft: Boolean(input.draft),
      enabled: input.enabled,
      key_id: env.RELAY_KEY_ID,
      priority: input.priority,
      revision: nextRevision,
      title: input.title,
      type: input.type
    }, now)
  ]
  if (Boolean(existing.enabled) !== input.enabled) {
    const event: AdminAuditEvent = input.enabled ? 'broadcast_enabled' : 'broadcast_disabled'
    statements.push(auditStatement(env.DB, event, 'broadcast', id, identity, {
      revision: nextRevision,
      title: input.title,
      type: input.type
    }, now))
  }
  const results = await env.DB.batch(statements)
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new ValidationError('The record changed; refresh before editing.', 409)
  logEvent('info', 'admin_operation', { operation: 'broadcast_updated', entity_id: id, actor: identity.actor })
  return jsonResponse({
    key_id: env.RELAY_KEY_ID,
    payload: signed.payload,
    signature: signed.signature,
    state: input.draft ? 'draft' : input.enabled ? 'active' : 'disabled',
    draft: Boolean(input.draft),
    revision: nextRevision,
    updated_at: new Date(now).toISOString()
  }, { headers: revisionHeaders(nextRevision) })
}

export async function deleteBroadcast(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  id: string,
  now = Date.now()
): Promise<Response> {
  const existing = await env.DB.prepare(`${BROADCAST_SELECT} WHERE id = ?`).bind(id).first<BroadcastRow>()
  if (!existing) return errorResponse(404, 'broadcast_not_found')
  assertCurrentRevision(requireRevision(request), existing.revision)
  const state = broadcastState(existing, now)
  if (state === 'active' || state === 'scheduled') {
    throw new ValidationError('Disable or expire the broadcast before deleting it.', 409)
  }
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM broadcasts WHERE id = ? AND revision = ?').bind(id, existing.revision),
    auditStatement(env.DB, 'broadcast_deleted', 'broadcast', id, identity, {
      revision: existing.revision,
      state,
      title: existing.title,
      type: existing.type
    }, now)
  ])
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new ValidationError('The record changed; refresh before deleting.', 409)
  logEvent('info', 'admin_operation', { operation: 'broadcast_deleted', entity_id: id, actor: identity.actor })
  return jsonResponse({ deleted: true })
}

export function parseBroadcastPathId(value: string): string {
  try {
    return validateUuid(decodeURIComponent(value), 'Broadcast id')
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('Broadcast id is invalid.')
  }
}
