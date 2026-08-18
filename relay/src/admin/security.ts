import { allowedBy, sourceRateLimitKey } from '../public/rate-limit'
import { sha256Hex } from '../shared/crypto'
import { errorResponse } from '../shared/http'
import { ValidationError } from '../shared/validation'
import type { AccessIdentity } from './auth'

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function requireControlPanelOrigin(request: Request, env: Pick<AdminEnv, 'CONTROL_PANEL_ORIGIN'>): void {
  if (!STATE_CHANGING_METHODS.has(request.method)) return
  const expected = env.CONTROL_PANEL_ORIGIN?.trim().replace(/\/$/, '')
  const origin = request.headers.get('origin')
  if (!expected || origin !== expected) throw new ValidationError('Request origin is not allowed.', 403)
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') throw new ValidationError('Cross-site request is not allowed.', 403)
}

export async function enforceAdminRateLimits(
  request: Request,
  env: Pick<AdminEnv, 'ADMIN_SOURCE_RATE_LIMIT' | 'ADMIN_ACTOR_RATE_LIMIT' | 'ADMIN_MUTATION_RATE_LIMIT'>,
  identity: AccessIdentity
): Promise<Response | null> {
  const [sourceKey, actorKey] = await Promise.all([
    sourceRateLimitKey(request, 'admin-source-v1'),
    sha256Hex(`admin-actor-v1\n${identity.actor}`)
  ])
  const checks = [
    allowedBy(env.ADMIN_SOURCE_RATE_LIMIT, sourceKey),
    allowedBy(env.ADMIN_ACTOR_RATE_LIMIT, actorKey)
  ]
  if (STATE_CHANGING_METHODS.has(request.method)) {
    checks.push(allowedBy(env.ADMIN_MUTATION_RATE_LIMIT, actorKey))
  }
  const permitted = await Promise.all(checks)
  if (permitted.every(Boolean)) return null
  return errorResponse(429, 'rate_limited', undefined, { 'Retry-After': '60' })
}

export function isStateChangingRequest(request: Request): boolean {
  return STATE_CHANGING_METHODS.has(request.method)
}
