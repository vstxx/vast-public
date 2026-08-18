import { errorResponse, rateLimitedResponse, withSecurityHeaders } from '../shared/http'
import { logFailure } from '../shared/logging'
import type { AssetRow } from '../shared/types'
import { validateAssetId } from '../shared/validation'
import { allowedBy, sourceRateLimitKey } from './rate-limit'

function checksumHex(checksum: ArrayBuffer | undefined): string | null {
  if (!checksum) return null
  return Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function assetHeaders(row: AssetRow, etag: string): Headers {
  const headers = withSecurityHeaders()
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('Content-Length', String(row.size))
  headers.set('Content-Type', row.mime_type)
  headers.set('ETag', etag)
  return headers
}

export async function handleAsset(request: Request, env: PublicEnv, rawAssetId: string): Promise<Response> {
  const sourceAllowed = await allowedBy(env.ASSET_SOURCE_RATE_LIMIT, await sourceRateLimitKey(request, 'asset'))
  if (!sourceAllowed) return rateLimitedResponse()

  let decoded: string
  try {
    decoded = decodeURIComponent(rawAssetId)
  } catch {
    return errorResponse(400, 'invalid_asset_id')
  }
  const assetId = validateAssetId(decoded)
  let row: AssetRow | null
  try {
    row = await env.DB.prepare(`
      SELECT id, object_key, mime_type, size, sha256, created_at
      FROM assets WHERE id = ?
    `).bind(assetId).first<AssetRow>()
  } catch (error) {
    logFailure('asset_d1_lookup_failed', error)
    return errorResponse(503, 'asset_unavailable')
  }
  if (!row) return errorResponse(404, 'asset_not_found')

  try {
    if (request.method === 'HEAD') {
      const object = await env.ASSETS.head(row.object_key)
      if (!object) return errorResponse(404, 'asset_not_found')
      const digest = checksumHex(object.checksums.sha256)
      if (object.size !== row.size || object.httpMetadata?.contentType !== row.mime_type || (digest !== null && digest !== row.sha256)) {
        logFailure('asset_metadata_mismatch', new Error('R2 metadata did not match D1.'), { asset_id: row.id })
        return errorResponse(502, 'asset_integrity_error')
      }
      return new Response(null, { status: 200, headers: assetHeaders(row, object.httpEtag) })
    }

    const object = await env.ASSETS.get(row.object_key, { onlyIf: request.headers })
    if (!object) return errorResponse(404, 'asset_not_found')
    if (!('body' in object)) return new Response(null, { status: 304, headers: assetHeaders(row, object.httpEtag) })
    const digest = checksumHex(object.checksums.sha256)
    if (object.size !== row.size || object.httpMetadata?.contentType !== row.mime_type || (digest !== null && digest !== row.sha256)) {
      logFailure('asset_metadata_mismatch', new Error('R2 metadata did not match D1.'), { asset_id: row.id })
      return errorResponse(502, 'asset_integrity_error')
    }
    return new Response(object.body, { status: 200, headers: assetHeaders(row, object.httpEtag) })
  } catch (error) {
    logFailure('asset_r2_read_failed', error, { asset_id: row.id })
    return errorResponse(503, 'asset_unavailable')
  }
}
