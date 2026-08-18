import { handleAsset } from './assets'
import { handleCheckin } from './checkin'
import { errorResponse, jsonResponse, responseForError } from '../shared/http'
import { logFailure } from '../shared/logging'
import { ValidationError } from '../shared/validation'

async function route(request: Request, env: PublicEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'GET, HEAD')
    const response = jsonResponse({ status: 'ok', protocol: 1 })
    return request.method === 'HEAD' ? new Response(null, response) : response
  }
  if (url.pathname === '/v1/checkin') {
    if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'POST')
    return handleCheckin(request, env)
  }
  if (url.pathname.startsWith('/v1/assets/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'method_not_allowed', 'GET, HEAD')
    const rawAssetId = url.pathname.slice('/v1/assets/'.length)
    if (!rawAssetId || rawAssetId.includes('/')) return errorResponse(400, 'invalid_asset_id')
    return handleAsset(request, env, rawAssetId)
  }
  return errorResponse(404, 'not_found')
}

export default {
  async fetch(request: Request, env: PublicEnv): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      if (error instanceof ValidationError) {
        logFailure('public_request_rejected', error, { path: new URL(request.url).pathname, status: error.status })
      } else {
        logFailure('public_request_failed', error, { path: new URL(request.url).pathname })
      }
      return responseForError(error)
    }
  }
} satisfies ExportedHandler<PublicEnv>
