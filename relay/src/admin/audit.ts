import { jsonResponse } from '../shared/http'
import { ValidationError } from '../shared/validation'
import type { AccessIdentity } from './auth'

export type AdminAuditEvent =
  | 'broadcast_created'
  | 'broadcast_updated'
  | 'broadcast_enabled'
  | 'broadcast_disabled'
  | 'broadcast_deleted'
  | 'asset_uploaded'
  | 'asset_deleted'
  | 'release_created'
  | 'release_updated'
  | 'release_enabled'
  | 'release_disabled'
  | 'release_deleted'

export type AdminEntity = 'broadcast' | 'asset' | 'release'
export type AuditSummary = Record<string, string | number | boolean | null>

interface AuditRow {
  id: number
  event_type: AdminAuditEvent
  entity_type: AdminEntity
  entity_id: string
  actor: string
  summary_json: string
  occurred_at: number
}

function safeSummary(summary: AuditSummary): string {
  const entries = Object.entries(summary)
  if (entries.length > 12) throw new ValidationError('Audit summary is too large.')
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new ValidationError('Audit summary key is invalid.')
    if (typeof value === 'string' && (value.length > 240 || /[\u0000-\u001f]/.test(value))) {
      throw new ValidationError('Audit summary value is invalid.')
    }
  }
  const encoded = JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
  if (encoded.length > 2048) throw new ValidationError('Audit summary is too large.')
  return encoded
}

export function auditStatement(
  db: D1Database,
  event: AdminAuditEvent,
  entity: AdminEntity,
  entityId: string,
  identity: AccessIdentity,
  summary: AuditSummary,
  occurredAt: number
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit (event_type, entity_type, entity_id, actor, summary_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(event, entity, entityId, identity.actor, safeSummary(summary), occurredAt)
}

export async function listAudit(request: Request, env: AdminEnv): Promise<Response> {
  const requested = Number(new URL(request.url).searchParams.get('limit') ?? 100)
  if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
    throw new ValidationError('Audit limit must be an integer from 1 to 200.')
  }
  const result = await env.DB.prepare(`
    SELECT id, event_type, entity_type, entity_id, actor, summary_json, occurred_at
    FROM admin_audit ORDER BY occurred_at DESC, id DESC LIMIT ?
  `).bind(requested).all<AuditRow>()
  return jsonResponse({
    items: result.results.map((row) => ({
      id: row.id,
      action: row.event_type,
      target_type: row.entity_type,
      target_id: row.entity_id,
      actor: row.actor,
      summary: parseSummary(row.summary_json),
      occurred_at: new Date(row.occurred_at).toISOString()
    }))
  })
}

function parseSummary(value: string): AuditSummary {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as AuditSummary
  } catch {
    // A corrupt historical audit row should not take the entire log offline.
  }
  return { invalid_summary: true }
}
