import semver from 'semver'
import { storedBroadcastEnvelope } from '../shared/broadcasts'
import { MAX_BROADCASTS_PER_CHECKIN, MAX_CHECKIN_BODY_BYTES, PROTOCOL_VERSION } from '../shared/constants'
import { jsonResponse, rateLimitedResponse, readJsonBody } from '../shared/http'
import { logFailure } from '../shared/logging'
import { storedReleaseEnvelope } from '../shared/releases'
import type { BroadcastRow, CheckinResponse, ReleaseRow, SignedEnvelope, BroadcastPayload, ReleasePayload } from '../shared/types'
import { validateCheckin } from '../shared/validation'
import { allowedBy, sourceRateLimitKey } from './rate-limit'

const BROADCAST_QUERY = `
  SELECT id, type, title, body, asset_id, action_label, action_url, min_version, max_version,
         active_from, active_until, priority, enabled, created_at, canonical_payload, signature, key_id
  FROM broadcasts
  WHERE enabled = 1
    AND active_from <= ?
    AND (active_until IS NULL OR active_until > ?)
  ORDER BY priority DESC, active_from ASC, id ASC
  LIMIT 100
`

const RELEASE_QUERY = `
  SELECT version, release_url, severity, min_supported_version, title, notes, published_at, enabled,
         canonical_payload, signature, key_id
  FROM releases
  WHERE enabled = 1 AND published_at <= ?
  ORDER BY published_at DESC
  LIMIT 50
`

function selectBroadcasts(rows: BroadcastRow[], currentVersion: string): Array<SignedEnvelope<BroadcastPayload>> {
  const selected: Array<SignedEnvelope<BroadcastPayload>> = []
  for (const row of rows) {
    if (row.min_version && semver.lt(currentVersion, row.min_version)) continue
    if (row.max_version && semver.gt(currentVersion, row.max_version)) continue
    try {
      const envelope = storedBroadcastEnvelope(row.canonical_payload, row.signature, row.key_id)
      if (!envelope.payload.enabled) continue
      const payloadUntil = envelope.payload.active_until ? Date.parse(envelope.payload.active_until) : null
      if (
        envelope.payload.id !== row.id ||
        envelope.payload.type !== row.type ||
        envelope.payload.title !== row.title ||
        envelope.payload.body !== row.body ||
        envelope.payload.media?.id !== (row.asset_id ?? undefined) ||
        envelope.payload.action?.label !== (row.action_label ?? undefined) ||
        envelope.payload.action?.url !== (row.action_url ?? undefined) ||
        envelope.payload.min_version !== row.min_version ||
        envelope.payload.max_version !== row.max_version ||
        Date.parse(envelope.payload.active_from) !== row.active_from ||
        payloadUntil !== row.active_until ||
        envelope.payload.priority !== row.priority
      ) continue
      selected.push(envelope)
      if (selected.length === MAX_BROADCASTS_PER_CHECKIN) break
    } catch (error) {
      logFailure('broadcast_invalid_at_delivery', error, { broadcast_id: row.id })
    }
  }
  return selected
}

function selectRelease(rows: ReleaseRow[], currentVersion: string): SignedEnvelope<ReleasePayload> | null {
  const candidates = rows.filter((row) => semver.gt(row.version, currentVersion))
  candidates.sort((left, right) => semver.rcompare(left.version, right.version))
  for (const row of candidates) {
    try {
      const envelope = storedReleaseEnvelope(row.canonical_payload, row.signature, row.key_id)
      if (
        !envelope.payload.enabled ||
        envelope.payload.version !== row.version ||
        envelope.payload.release_url !== row.release_url ||
        envelope.payload.severity !== row.severity ||
        envelope.payload.min_supported_version !== row.min_supported_version ||
        envelope.payload.title !== row.title ||
        envelope.payload.notes !== row.notes ||
        Date.parse(envelope.payload.published_at) !== row.published_at
      ) continue
      return envelope
    } catch (error) {
      logFailure('release_invalid_at_delivery', error, { release_version: row.version })
    }
  }
  return null
}

export async function handleCheckin(request: Request, env: PublicEnv, now = Date.now()): Promise<Response> {
  const sourceAllowed = await allowedBy(env.CHECKIN_SOURCE_RATE_LIMIT, await sourceRateLimitKey(request, 'checkin'))
  if (!sourceAllowed) return rateLimitedResponse()

  const input = validateCheckin(await readJsonBody(request, MAX_CHECKIN_BODY_BYTES))
  const installAllowed = await allowedBy(env.CHECKIN_INSTALL_RATE_LIMIT, input.install_id)
  if (!installAllowed) return rateLimitedResponse()

  const response: CheckinResponse = {
    protocol: PROTOCOL_VERSION,
    server_time: new Date(now).toISOString(),
    messages: [],
    update: null
  }

  try {
    await env.DB.prepare(`
      INSERT INTO installations (install_id, current_version, first_seen, last_seen, launch_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(install_id) DO UPDATE SET
        current_version = excluded.current_version,
        last_seen = MAX(installations.last_seen, excluded.last_seen),
        launch_count = MAX(installations.launch_count, excluded.launch_count)
    `).bind(input.install_id, input.current_version, now, now, input.launch_count).run()
  } catch (error) {
    logFailure('checkin_d1_upsert_failed', error)
    const headers = new Headers({ 'X-Vast-Relay-Degraded': 'database' })
    return jsonResponse(response, { headers })
  }

  try {
    const [broadcastResult, releaseResult] = await env.DB.batch([
      env.DB.prepare(BROADCAST_QUERY).bind(now, now),
      env.DB.prepare(RELEASE_QUERY).bind(now)
    ])
    response.messages = selectBroadcasts(broadcastResult.results as BroadcastRow[], input.current_version)
    response.update = selectRelease(releaseResult.results as ReleaseRow[], input.current_version)
  } catch (error) {
    logFailure('checkin_d1_delivery_query_failed', error)
    const headers = new Headers({ 'X-Vast-Relay-Degraded': 'database' })
    return jsonResponse(response, { headers })
  }

  return jsonResponse(response)
}
