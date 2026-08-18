import { auditStatement } from './audit'
import type { AccessIdentity } from './auth'
import { validateAssetMagic } from '../shared/assets'
import { MAX_ASSET_BYTES } from '../shared/constants'
import { sha256Hex } from '../shared/crypto'
import { errorResponse, jsonResponse, readBoundedBytes } from '../shared/http'
import { logEvent, logFailure } from '../shared/logging'
import type { AssetMime, AssetRow } from '../shared/types'
import {
  assetMimeForId,
  validateAssetId,
  validateAssetMime,
  ValidationError
} from '../shared/validation'

interface AssetListRow extends AssetRow {
  reference_count: number
}

function extensionForMime(mime: AssetMime): 'png' | 'webp' | 'gif' {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'gif'
}

export async function listAssets(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT a.id, a.object_key, a.mime_type, a.size, a.sha256, a.created_at,
           COUNT(b.id) AS reference_count
    FROM assets a
    LEFT JOIN broadcasts b ON b.asset_id = a.id
    GROUP BY a.id
    ORDER BY a.created_at DESC
    LIMIT 200
  `).all<AssetListRow>()
  return jsonResponse({ items: result.results.map((row) => ({
    id: row.id,
    mime: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    created_at: new Date(row.created_at).toISOString(),
    reference_count: row.reference_count
  })) })
}

export async function uploadGeneratedAsset(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  now = Date.now()
): Promise<Response> {
  const mime = validateAssetMime(request.headers.get('content-type')?.trim().toLowerCase())
  const assetId = `${crypto.randomUUID()}.${extensionForMime(mime)}`
  return uploadAsset(request, env, identity, assetId, now, mime)
}

export async function uploadAsset(
  request: Request,
  env: AdminEnv,
  identity: AccessIdentity,
  rawAssetId: string,
  now = Date.now(),
  knownMime?: AssetMime
): Promise<Response> {
  const assetId = validateAssetId(rawAssetId)
  const mime = knownMime ?? validateAssetMime(request.headers.get('content-type')?.trim().toLowerCase())
  if (assetMimeForId(assetId) !== mime) throw new ValidationError('Asset extension and Content-Type do not match.', 415)
  const existing = await env.DB.prepare('SELECT id FROM assets WHERE id = ?').bind(assetId).first<{ id: string }>()
  if (existing) throw new ValidationError('Asset already exists and is immutable.', 409)
  const bytes = await readBoundedBytes(request, MAX_ASSET_BYTES)
  if (bytes.byteLength === 0) throw new ValidationError('Asset body is empty.')
  validateAssetMagic(bytes, mime)
  const sha256 = await sha256Hex(bytes)
  const objectKey = `assets/v1/${assetId}`
  const object = await env.ASSETS.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256,
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: { assetId, sha256 }
  })
  if (!object) throw new ValidationError('Asset object already exists and is immutable.', 409)

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO assets (id, object_key, mime_type, size, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(assetId, objectKey, mime, bytes.byteLength, sha256, now),
      auditStatement(env.DB, 'asset_uploaded', 'asset', assetId, identity, {
        mime,
        sha256,
        size: bytes.byteLength
      }, now)
    ])
  } catch (error) {
    try {
      await env.ASSETS.delete(objectKey)
    } catch (cleanupError) {
      logFailure('asset_upload_cleanup_failed', cleanupError, { asset_id: assetId })
    }
    throw error
  }
  logEvent('info', 'admin_operation', {
    operation: 'asset_uploaded',
    entity_id: assetId,
    actor: identity.actor,
    size: bytes.byteLength
  })
  return jsonResponse({
    id: assetId,
    mime,
    size: bytes.byteLength,
    sha256,
    created_at: new Date(now).toISOString(),
    reference_count: 0
  }, { status: 201 })
}

export async function getAssetContent(env: AdminEnv, assetId: string, head = false): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT id, object_key, mime_type, size, sha256, created_at FROM assets WHERE id = ?
  `).bind(assetId).first<AssetRow>()
  if (!row) return errorResponse(404, 'asset_not_found')
  const object = await env.ASSETS.get(row.object_key)
  if (!object) return errorResponse(404, 'asset_not_found')
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Length': String(row.size),
    'Content-Type': row.mime_type,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'ETag': `"${object.etag}"`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  return new Response(head ? null : object.body, { headers })
}

export async function deleteAsset(
  env: AdminEnv,
  identity: AccessIdentity,
  assetId: string,
  now = Date.now()
): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT id, object_key, mime_type, size, sha256, created_at FROM assets WHERE id = ?
  `).bind(assetId).first<AssetRow>()
  if (!row) return errorResponse(404, 'asset_not_found')
  const reference = await env.DB.prepare('SELECT id FROM broadcasts WHERE asset_id = ? LIMIT 1').bind(assetId).first<{ id: string }>()
  if (reference) throw new ValidationError('Asset is referenced by a broadcast and cannot be deleted.', 409)

  await env.ASSETS.delete(row.object_key)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(assetId),
    auditStatement(env.DB, 'asset_deleted', 'asset', assetId, identity, {
      mime: row.mime_type,
      sha256: row.sha256,
      size: row.size
    }, now)
  ])
  logEvent('info', 'admin_operation', { operation: 'asset_deleted', entity_id: assetId, actor: identity.actor })
  return jsonResponse({ deleted: true })
}

export function parseAssetPathId(value: string): string {
  try {
    return validateAssetId(decodeURIComponent(value))
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('Asset id is invalid.')
  }
}
