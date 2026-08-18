import { listAudit } from './audit'
import { authenticateAccessRequest, type AccessIdentity } from './auth'
import {
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  listBroadcasts,
  parseBroadcastPathId,
  updateBroadcast
} from './broadcasts'
import { dashboardSummary, getInstallation, listInstallations } from './dashboard'
import {
  deleteAsset,
  getAssetContent,
  listAssets,
  parseAssetPathId,
  uploadGeneratedAsset
} from './assets'
import {
  createRelease,
  deleteRelease,
  getRelease,
  listReleases,
  parseReleasePathVersion,
  updateRelease
} from './releases'
import { enforceAdminRateLimits, requireControlPanelOrigin } from './security'
import { errorResponse, jsonResponse, responseForError, withControlPanelSecurityHeaders } from '../shared/http'
import { logFailure } from '../shared/logging'
import { ValidationError } from '../shared/validation'

function singlePathSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  return rest && !rest.includes('/') ? rest : null
}

export async function routeAuthenticatedAdminRequest(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity
): Promise<Response> {
  requireControlPanelOrigin(request, env)
  const limited = await enforceAdminRateLimits(request, env, identity)
  if (limited) return limited

  const url = new URL(request.url)
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'GET, HEAD')
    return jsonResponse({ status: 'ok', protocol: 1 })
  }
  if (url.pathname === '/v1/admin/session') {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'GET')
    return jsonResponse({
      actor: identity.actor,
      actor_kind: identity.kind,
      environment: env.ENVIRONMENT,
      key_id: env.RELAY_KEY_ID
    })
  }
  if (url.pathname === '/v1/admin/dashboard') {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'GET')
    return dashboardSummary(env)
  }
  if (url.pathname === '/v1/admin/installations') {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'GET')
    return listInstallations(request, env)
  }
  const installationPath = singlePathSegment(url.pathname, '/v1/admin/installations/')
  if (installationPath !== null) {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'GET')
    return getInstallation(env, decodeURIComponent(installationPath))
  }
  if (url.pathname === '/v1/admin/audit') {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'GET')
    return listAudit(request, env)
  }

  if (url.pathname === '/v1/admin/broadcasts') {
    if (request.method === 'GET') return listBroadcasts(env)
    if (request.method === 'POST') return createBroadcast(request, env, identity)
    return errorResponse(405, 'method_not_allowed', 'GET, POST')
  }
  const broadcastPath = singlePathSegment(url.pathname, '/v1/admin/broadcasts/')
  if (broadcastPath !== null) {
    const id = parseBroadcastPathId(broadcastPath)
    if (request.method === 'GET') return getBroadcast(env, id)
    if (request.method === 'PUT') return updateBroadcast(request, env, identity, id)
    if (request.method === 'DELETE') return deleteBroadcast(request, env, identity, id)
    return errorResponse(405, 'method_not_allowed', 'GET, PUT, DELETE')
  }

  if (url.pathname === '/v1/admin/releases') {
    if (request.method === 'GET') return listReleases(env)
    if (request.method === 'POST') return createRelease(request, env, identity)
    return errorResponse(405, 'method_not_allowed', 'GET, POST')
  }
  const releasePath = singlePathSegment(url.pathname, '/v1/admin/releases/')
  if (releasePath !== null) {
    const version = parseReleasePathVersion(releasePath)
    if (request.method === 'GET') return getRelease(env, version)
    if (request.method === 'PUT') return updateRelease(request, env, identity, version)
    if (request.method === 'DELETE') return deleteRelease(request, env, identity, version)
    return errorResponse(405, 'method_not_allowed', 'GET, PUT, DELETE')
  }

  if (url.pathname === '/v1/admin/assets') {
    if (request.method === 'GET') return listAssets(env)
    if (request.method === 'PUT') return uploadGeneratedAsset(request, env, identity)
    return errorResponse(405, 'method_not_allowed', 'GET, PUT')
  }
  if (url.pathname.startsWith('/v1/admin/assets/') && url.pathname.endsWith('/content')) {
    const encoded = url.pathname.slice('/v1/admin/assets/'.length, -'/content'.length)
    if (!encoded || encoded.includes('/')) return errorResponse(404, 'not_found')
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'GET, HEAD')
    return getAssetContent(env, parseAssetPathId(encoded), request.method === 'HEAD')
  }
  const assetPath = singlePathSegment(url.pathname, '/v1/admin/assets/')
  if (assetPath !== null) {
    const assetId = parseAssetPathId(assetPath)
    if (request.method === 'DELETE') return deleteAsset(env, identity, assetId)
    return errorResponse(405, 'method_not_allowed', 'DELETE')
  }

  if (url.pathname.startsWith('/v1/')) return errorResponse(404, 'not_found')
  if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'GET, HEAD')
  return withControlPanelSecurityHeaders(await env.CONTROL_PANEL_ASSETS.fetch(request))
}

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    try {
      const identity = await authenticateAccessRequest(request, env)
      return await routeAuthenticatedAdminRequest(request, env, identity)
    } catch (error) {
      const path = new URL(request.url).pathname
      if (error instanceof ValidationError) {
        if (error.status !== 401) logFailure('admin_request_rejected', error, { path, status: error.status })
      } else {
        logFailure('admin_request_failed', error, { path })
      }
      return responseForError(error)
    }
  }
} satisfies ExportedHandler<AdminEnv>
