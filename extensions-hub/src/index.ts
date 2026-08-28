import semver from 'semver'
import { canonicalJson, createEd25519Signer, createVextPackage, sha256Hex, VEXT_LIMITS, VEXT_VERSION } from '../../src/shared/vext-format.ts'
import { permissionEscalation, type ExtensionPermissionSnapshot, type SignedVastHubReleaseDescriptor, type VastHubReleaseDescriptor } from '../../src/shared/extension-marketplace.ts'
import { dashboardPage, detailPage, homePage, legalPage, messagePage, publisherHomePage, reportPage, reportReviewPage, reviewPage, type CatalogViewItem, type DashboardExtension, type ExtensionReportReviewItem, type ReviewItem } from './html.ts'
import {
  CSRF_COOKIE,
  HttpError,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cleanupExpiredState,
  clearCsrfCookie,
  clearOauthCookie,
  clearSessionCookie,
  cookie,
  cookies,
  csrfCookie,
  enforceRateLimit,
  html,
  json,
  oauthCookie,
  optionalSession,
  randomToken,
  readBodyBounded,
  readBounded,
  readJson,
  requireCsrf,
  requireRole,
  requireSession,
  secureResponse,
  sessionCookie,
  sha256,
  timingEqual,
  type HubSession
} from './security.ts'
import { assertExtensionId, parseCreateExtension, parseExtensionDataPractice, validatePublisherPackage } from './validation.ts'
import { currentPublisherTerms, optionalLegalConfig, PUBLISHER_WARRANTY_VERSION, requireLegalConfig, requirePublisherTerms } from './legal.ts'

const encoder = new TextEncoder()
const API_JSON_LIMIT = 64 * 1024
const MEDIA_LIMIT = 8 * 1024 * 1024
const OAUTH_TTL_MS = 10 * 60_000
const CATALOG_PAGE_SIZE = 24

interface CatalogRow {
  id: string
  slug: string
  name: string
  summary: string
  description: string
  publisher_id: string
  publisher_name: string
  verified: number
  category: string
  kind: 'chrome' | 'vast' | 'hybrid'
  version: string
  updated_at: string
  downloads: number
  homepage: string | null
  source_url: string | null
  icon_key: string | null
  permissions_snapshot: string
  data_practice: 'local-only' | 'external-processing' | 'undisclosed'
  privacy_policy_url: string | null
  remote_services: string
}

interface OwnedExtensionRow { id: string; publisher_id: string; current_release_id: string | null; status: string }
interface ReleaseRow {
  id: string
  extension_id: string
  publisher_id: string
  publisher_name: string
  version: string
  staging_key: string | null
  package_key: string | null
  package_sha256: string | null
  package_size: number | null
  signature_key_id: string | null
  descriptor_json: string | null
  descriptor_signature: string | null
  manifest_summary: string
  permissions_snapshot: string
  validation_json: string
  status: string
  current_release_id: string | null
  extension_name: string
}

function now(): string { return new Date().toISOString() }

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function extensionId(): string {
  const value = new Uint8Array(32)
  crypto.getRandomValues(value)
  return [...value].map((byte) => String.fromCharCode(97 + (byte & 15))).join('')
}

function publicOrigin(env: Env): string {
  const origin = new URL(env.HUB_ORIGIN)
  if (origin.protocol !== 'https:' && !(env.ENVIRONMENT !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) {
    throw new Error('HUB_ORIGIN is unsafe.')
  }
  return origin.origin
}

function parsePermissions(value: string): ExtensionPermissionSnapshot {
  try {
    const parsed = JSON.parse(value) as ExtensionPermissionSnapshot
    if (!parsed || !Array.isArray(parsed.chrome) || !Array.isArray(parsed.hosts) || !Array.isArray(parsed.vast)) throw new Error()
    return parsed
  } catch { throw new Error('Stored permission metadata is invalid.') }
}

function parseManifestSummary(value: string): { name: string; description: string; kind: string } {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    const summary = parsed as Record<string, unknown>
    if (typeof summary.name !== 'string' || typeof summary.description !== 'string' || !['chrome', 'vast', 'hybrid'].includes(String(summary.kind))) throw new Error()
    return { name: summary.name.slice(0, 128), description: summary.description.slice(0, 2_048), kind: String(summary.kind) }
  } catch { throw new Error('Stored manifest summary is invalid.') }
}

function parseValidationFindings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length > 64 || parsed.some((item) => typeof item !== 'string' || item.length > 256)) throw new Error()
    return parsed as string[]
  } catch { throw new Error('Stored validation findings are invalid.') }
}

function catalogItem(row: CatalogRow, env: Env): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    publisher: { id: row.publisher_id, name: row.publisher_name, verified: row.verified === 1 },
    category: row.category,
    kind: row.kind,
    version: row.version,
    updatedAt: row.updated_at,
    downloads: Number(row.downloads),
    dataPractice: row.data_practice,
    ...(row.privacy_policy_url ? { privacyPolicyUrl: row.privacy_policy_url } : {}),
    remoteServices: row.remote_services,
    ...(row.icon_key ? { iconUrl: `${publicOrigin(env)}/media/${encodeURIComponent(row.icon_key)}` } : {}),
    installed: false
  }
}

function catalogView(row: CatalogRow, env: Env): CatalogViewItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    publisherName: row.publisher_name,
    category: row.category,
    kind: row.kind,
    version: row.version,
    downloads: Number(row.downloads),
    dataPractice: row.data_practice,
    ...(row.privacy_policy_url ? { privacyPolicyUrl: row.privacy_policy_url } : {}),
    remoteServices: row.remote_services,
    ...(row.icon_key ? { iconUrl: `${publicOrigin(env)}/media/${encodeURIComponent(row.icon_key)}` } : {})
  }
}

function catalogWhere(url: URL): { where: string; bindings: string[]; query: string; category: string } {
  const query = (url.searchParams.get('query') ?? '').trim().slice(0, 128)
  const category = (url.searchParams.get('category') ?? '').trim().slice(0, 64)
  if (category && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) throw new HttpError(400, 'Category is invalid.')
  const escaped = query.toLowerCase().replace(/[\\%_]/g, '\\$&')
  const where = `e.status='published' AND r.status='published' AND (?1='' OR lower(e.name||' '||e.summary||' '||p.publisher_name) LIKE ?2 ESCAPE '\\') AND (?3='' OR e.category=?3)`
  return { where, bindings: [query, `%${escaped}%`, category], query, category }
}

async function catalogRows(env: Env, url: URL, limit: number, offset: number): Promise<{ rows: CatalogRow[]; total: number }> {
  const input = catalogWhere(url)
  const base = `FROM extensions e JOIN publishers p ON p.id=e.publisher_id JOIN releases r ON r.id=e.current_release_id LEFT JOIN download_counters d ON d.extension_id=e.id WHERE ${input.where}`
  const sort = url.searchParams.get('sort') === 'updated' ? 'e.updated_at DESC,e.id' : 'COALESCE(d.count,0) DESC,e.updated_at DESC,e.id'
  const [list, count] = await Promise.all([
    env.DB.prepare(`SELECT e.id,e.slug,e.name,e.summary,e.description,e.category,e.kind,e.updated_at,e.homepage,e.source_url,e.icon_key,e.data_practice,e.privacy_policy_url,e.remote_services,p.id publisher_id,p.publisher_name,p.verified,r.version,r.permissions_snapshot,COALESCE(d.count,0) downloads ${base} ORDER BY ${sort} LIMIT ?4 OFFSET ?5`).bind(...input.bindings, limit, offset).all<CatalogRow>(),
    env.DB.prepare(`SELECT COUNT(*) total ${base}`).bind(...input.bindings).first<{ total: number }>()
  ])
  return { rows: list.results, total: Number(count?.total ?? 0) }
}

async function getCatalogRow(env: Env, id: string): Promise<CatalogRow | null> {
  assertExtensionId(id)
  return env.DB.prepare(`SELECT e.id,e.slug,e.name,e.summary,e.description,e.category,e.kind,e.updated_at,e.homepage,e.source_url,e.icon_key,e.data_practice,e.privacy_policy_url,e.remote_services,p.id publisher_id,p.publisher_name,p.verified,r.version,r.permissions_snapshot,COALESCE(d.count,0) downloads FROM extensions e JOIN publishers p ON p.id=e.publisher_id JOIN releases r ON r.id=e.current_release_id LEFT JOIN download_counters d ON d.extension_id=e.id WHERE e.id=?1 AND e.status='published' AND r.status='published'`).bind(id).first<CatalogRow>()
}

async function categories(env: Env): Promise<string[]> {
  return (await env.DB.prepare('SELECT slug FROM categories ORDER BY position,slug').all<{ slug: string }>()).results.map((row) => row.slug)
}

async function publicCatalog(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(request, env, 'catalog', 120, 60_000)
  const url = new URL(request.url)
  const page = Math.max(1, Math.min(1_000, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1))
  const [{ rows, total }, featured, categoryList] = await Promise.all([
    catalogRows(env, url, CATALOG_PAGE_SIZE, (page - 1) * CATALOG_PAGE_SIZE),
    env.DB.prepare(`SELECT e.id,e.slug,e.name,e.summary,e.description,e.category,e.kind,e.updated_at,e.homepage,e.source_url,e.icon_key,e.data_practice,e.privacy_policy_url,e.remote_services,p.id publisher_id,p.publisher_name,p.verified,r.version,r.permissions_snapshot,COALESCE(d.count,0) downloads FROM extensions e JOIN publishers p ON p.id=e.publisher_id JOIN releases r ON r.id=e.current_release_id LEFT JOIN download_counters d ON d.extension_id=e.id WHERE e.status='published' AND r.status='published' ORDER BY COALESCE(d.count,0) DESC,e.updated_at DESC LIMIT 6`).all<CatalogRow>(),
    categories(env)
  ])
  return json({ items: rows.map((row) => catalogItem(row, env)), page, pageSize: CATALOG_PAGE_SIZE, total, featured: featured.results.map((row) => catalogItem(row, env)), categories: categoryList }, { headers: { 'cache-control': 'no-store' } })
}

async function extensionDetails(env: Env, id: string): Promise<Response> {
  const row = await getCatalogRow(env, id)
  if (!row) throw new HttpError(404, 'Extension was not found.')
  const screenshots = (await env.DB.prepare('SELECT object_key FROM extension_screenshots WHERE extension_id=?1 ORDER BY position LIMIT 5').bind(id).all<{ object_key: string }>()).results
  return json({ ...catalogItem(row, env), description: row.description, ...(row.homepage ? { homepage: row.homepage } : {}), ...(row.source_url ? { sourceUrl: row.source_url } : {}), screenshots: screenshots.map((entry) => `${publicOrigin(env)}/media/${encodeURIComponent(entry.object_key)}`), permissions: parsePermissions(row.permissions_snapshot) }, { headers: { 'cache-control': 'no-store' } })
}

async function releaseDescriptor(request: Request, env: Env, extension: string, version?: string): Promise<Response> {
  await enforceRateLimit(request, env, 'install-metadata', 180, 60_000)
  assertExtensionId(extension)
  if (version && !VEXT_VERSION.test(version)) throw new HttpError(404, 'Release was not found.')
  const row = await env.DB.prepare(`SELECT r.descriptor_json,r.descriptor_signature,r.signature_key_id FROM releases r JOIN extensions e ON e.id=r.extension_id WHERE r.extension_id=?1 AND r.status='published' AND e.status='published' AND ${version ? 'r.version=?2' : 'r.id=e.current_release_id'}`).bind(...(version ? [extension, version] : [extension])).first<{ descriptor_json: string; descriptor_signature: string; signature_key_id: string }>()
  if (!row) throw new HttpError(404, 'Release was not found.')
  return json({ descriptor: JSON.parse(row.descriptor_json) as unknown, signature: { signature_version: 1, algorithm: 'Ed25519', key_id: row.signature_key_id, signature: row.descriptor_signature } }, { headers: { 'cache-control': 'no-store' } })
}

function safeReturnPath(value: string | null): string {
  if (!value || value.length > 512 || !value.startsWith('/') || value.startsWith('//')) return '/dashboard'
  const parsed = new URL(value, 'https://local.invalid')
  return parsed.origin === 'https://local.invalid' ? `${parsed.pathname}${parsed.search}` : '/dashboard'
}

async function oauthStart(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(request, env, 'oauth-start', 20, 10 * 60_000)
  const state = randomToken()
  const verifier = randomToken()
  const created = now()
  const expires = new Date(Date.now() + OAUTH_TTL_MS)
  const returnPath = safeReturnPath(new URL(request.url).searchParams.get('return'))
  await env.DB.prepare('INSERT INTO oauth_states(state_hash,cookie_hash,return_path,expires_at,created_at) VALUES(?1,?2,?3,?4,?5)').bind(await sha256(state), await sha256(verifier), returnPath, expires.toISOString(), created).run()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', env.GITHUB_REDIRECT_URI)
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  const headers = new Headers({ location: url.toString(), 'cache-control': 'no-store' })
  headers.append('set-cookie', oauthCookie(verifier, expires))
  return secureResponse(new Response(null, { status: 302, headers }))
}

async function boundedExternalJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBodyBounded(response.body, response.headers.get('content-length'), 256 * 1024)
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new HttpError(502, 'The identity provider returned an invalid response.') }
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(request, env, 'oauth-callback', 30, 10 * 60_000)
  const url = new URL(request.url)
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const verifiers = cookies(request, OAUTH_COOKIE).filter((value) => value.length > 0 && value.length <= 256)
  if (!state || state.length > 256 || !code || code.length > 512 || verifiers.length === 0) throw new HttpError(400, 'OAuth validation failed.')
  const stateHash = await sha256(state)
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?1 RETURNING cookie_hash,return_path,expires_at').bind(stateHash).first<{ cookie_hash: string; return_path: string; expires_at: string }>()
  const verifierMatches = row ? (await Promise.all(verifiers.map(async (verifier) => timingEqual(await sha256(verifier), row.cookie_hash)))).some(Boolean) : false
  if (!row || Date.parse(row.expires_at) <= Date.now() || !verifierMatches) throw new HttpError(400, 'OAuth validation failed.')
  let stage = 'token_exchange'
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'manual', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Vast-Extensions-Hub' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: env.GITHUB_REDIRECT_URI }) })
    if (!tokenResponse.ok) throw new HttpError(502, 'GitHub sign-in failed.')
    stage = 'token_body'
    const tokenPayload = await boundedExternalJson(tokenResponse)
    const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
    if (!accessToken || accessToken.length > 512) throw new HttpError(502, 'GitHub sign-in failed.')
    stage = 'user_fetch'
    const userResponse = await fetch('https://api.github.com/user', { redirect: 'manual', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': 'Vast-Extensions-Hub', 'x-github-api-version': '2022-11-28' } })
    if (!userResponse.ok) throw new HttpError(502, 'GitHub sign-in failed.')
    stage = 'user_body'
    const user = await boundedExternalJson(userResponse)
    const githubId = String(user.id ?? '')
    const login = typeof user.login === 'string' ? user.login.slice(0, 128) : ''
    if (!/^\d{1,32}$/.test(githubId) || !/^[A-Za-z0-9-]{1,128}$/.test(login)) throw new HttpError(502, 'GitHub account data is invalid.')
    const displayName = typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 128) : login
    const avatar = typeof user.avatar_url === 'string' && user.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? user.avatar_url.slice(0, 2_048) : null
    stage = 'publisher_database'
    const existing = await env.DB.prepare('SELECT id,publisher_name FROM publishers WHERE github_user_id=?1').bind(githubId).first<{ id: string; publisher_name: string }>()
    const publisherId = existing?.id ?? `publisher_${randomHex(12)}`
    const timestamp = now()
    await env.DB.prepare(`INSERT INTO publishers(id,github_user_id,github_login,display_name,publisher_name,avatar_url,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login,display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`).bind(publisherId, githubId, login, displayName, existing?.publisher_name ?? login, avatar, timestamp).run()
    stage = 'session_database'
    const sessionToken = randomToken()
    const csrfToken = randomToken()
    const sessionExpires = new Date(Date.now() + SESSION_TTL_MS)
    await env.DB.prepare('INSERT INTO publisher_sessions(id_hash,publisher_id,csrf_hash,expires_at,created_at) VALUES(?1,?2,?3,?4,?5)').bind(await sha256(sessionToken), publisherId, await sha256(csrfToken), sessionExpires.toISOString(), timestamp).run()
    stage = 'session_response'
    const headers = new Headers({ location: safeReturnPath(row.return_path), 'cache-control': 'no-store' })
    headers.append('set-cookie', clearOauthCookie())
    headers.append('set-cookie', sessionCookie(sessionToken, sessionExpires))
    headers.append('set-cookie', csrfCookie(csrfToken, sessionExpires))
    return secureResponse(new Response(null, { status: 302, headers }))
  } catch (error) {
    console.error(JSON.stringify({ event: 'oauth_callback_stage_error', stage, errorType: error instanceof Error ? error.name : 'UnknownError' }))
    throw error
  }
}

async function requireMutation(request: Request, env: Env): Promise<HubSession> {
  const origin = request.headers.get('origin')
  if (origin !== publicOrigin(env)) throw new HttpError(403, 'Origin validation failed.')
  const session = await requireSession(request, env)
  await requireCsrf(request, session)
  return session
}

async function ownedExtension(env: Env, extension: string, publisher: string): Promise<OwnedExtensionRow> {
  assertExtensionId(extension)
  const row = await env.DB.prepare('SELECT e.id,e.publisher_id,e.current_release_id,e.status FROM extensions e JOIN extension_owners o ON o.extension_id=e.id WHERE e.id=?1 AND o.publisher_id=?2').bind(extension, publisher).first<OwnedExtensionRow>()
  if (!row) throw new HttpError(404, 'Extension was not found.')
  return row
}

async function acceptPublisherTerms(request: Request, env: Env): Promise<Response> {
  const session = await requireMutation(request, env)
  const body = await readJson(request, API_JSON_LIMIT)
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>).accepted !== true) throw new HttpError(400, 'Explicit acceptance is required.')
  const terms = await currentPublisherTerms(env)
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO publisher_terms_acceptances(publisher_id,terms_version,terms_sha256,accepted_at) VALUES(?1,?2,?3,?4) ON CONFLICT(publisher_id,terms_version) DO UPDATE SET terms_sha256=excluded.terms_sha256,accepted_at=excluded.accepted_at').bind(session.publisher.id, terms.version, terms.sha256, timestamp),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'publisher', session.publisher.id, 'accept-publisher-terms', `${terms.version}:${terms.sha256}`, timestamp)
  ])
  return json({ version: terms.version, sha256: terms.sha256, acceptedAt: timestamp })
}

async function createExtension(request: Request, env: Env): Promise<Response> {
  const session = await requireMutation(request, env)
  requireLegalConfig(env)
  await requirePublisherTerms(env, session.publisher.id)
  await enforceRateLimit(request, env, `create-${session.publisher.id}`, 12, 60 * 60_000)
  const input = parseCreateExtension(await readJson(request, API_JSON_LIMIT))
  const category = await env.DB.prepare('SELECT slug FROM categories WHERE slug=?1').bind(input.category).first<{ slug: string }>()
  if (!category) throw new HttpError(400, 'Category is invalid.')
  const id = input.extensionId ?? extensionId()
  const timestamp = now()
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO extensions(id,slug,name,summary,description,publisher_id,category,kind,homepage,source_url,data_practice,privacy_policy_url,remote_services,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)').bind(id, input.slug, input.name, input.summary, input.description, session.publisher.id, input.category, 'vast', input.homepage, input.sourceUrl, input.dataPractice, input.privacyPolicyUrl, input.remoteServices, timestamp),
      env.DB.prepare('INSERT INTO extension_owners(extension_id,publisher_id,created_at) VALUES(?1,?2,?3)').bind(id, session.publisher.id, timestamp),
      env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'extension', id, 'create', '', timestamp)
    ])
  } catch { throw new HttpError(409, 'That extension slug or ID is already in use.') }
  return json({ id, status: 'draft' }, { status: 201 })
}

async function updateExtensionDataPractice(request: Request, env: Env, extension: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireLegalConfig(env)
  await requirePublisherTerms(env, session.publisher.id)
  await enforceRateLimit(request, env, `listing-disclosure-${session.publisher.id}`, 30, 60 * 60_000)
  await ownedExtension(env, extension, session.publisher.id)
  const input = parseExtensionDataPractice(await readJson(request, API_JSON_LIMIT))
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare('UPDATE extensions SET data_practice=?1,privacy_policy_url=?2,remote_services=?3,updated_at=?4 WHERE id=?5').bind(input.dataPractice, input.privacyPolicyUrl, input.remoteServices, timestamp, extension),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'extension', extension, 'update-data-practices', input.dataPractice, timestamp)
  ])
  return json({ ...input, updatedAt: timestamp })
}

async function uploadRelease(request: Request, env: Env, extension: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireLegalConfig(env)
  await requirePublisherTerms(env, session.publisher.id)
  await enforceRateLimit(request, env, `upload-${session.publisher.id}`, 30, 60 * 60_000)
  await ownedExtension(env, extension, session.publisher.id)
  const type = request.headers.get('content-type')?.split(';')[0].toLowerCase()
  if (type !== 'application/vnd.vast.extension+zip' && type !== 'application/octet-stream') throw new HttpError(415, 'Expected a .vext package.')
  const bytes = await readBounded(request, VEXT_LIMITS.maxCompressedBytes)
  const summary = await validatePublisherPackage(bytes, extension, session.publisher.id)
  const current = await env.DB.prepare('SELECT r.version FROM extensions e JOIN releases r ON r.id=e.current_release_id WHERE e.id=?1').bind(extension).first<{ version: string }>()
  if (current && !semver.gt(summary.version, current.version)) throw new HttpError(409, 'A new release must have a higher version than the published release.')
  const existing = await env.DB.prepare('SELECT id,status,staging_key FROM releases WHERE extension_id=?1 AND version=?2').bind(extension, summary.version).first<{ id: string; status: string; staging_key: string | null }>()
  if (existing && !['draft', 'changes', 'rejected'].includes(existing.status)) throw new HttpError(409, 'This release version is immutable or already in review.')
  if (!existing) {
    const pendingCount = Number((await env.DB.prepare(`SELECT COUNT(*) count FROM releases WHERE extension_id=?1 AND status IN ('draft','pending','reviewing','changes','rejected')`).bind(extension).first<{ count: number }>())?.count ?? 0)
    if (pendingCount >= 10) throw new HttpError(429, 'Resolve or withdraw existing release drafts before uploading more versions.')
  }
  const releaseId = existing?.id ?? `release_${randomHex(16)}`
  const stagingKey = `staging/${extension}/${releaseId}/${randomHex(8)}.vext`
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString()
  await env.PACKAGES.put(stagingKey, bytes, { httpMetadata: { contentType: 'application/vnd.vast.extension+zip' }, customMetadata: { expiresAt, extensionId: extension, releaseId } })
  const timestamp = now()
  try {
    if (existing) {
      await env.DB.prepare(`UPDATE releases SET staging_key=?1,manifest_summary=?2,permissions_snapshot=?3,validation_json=?4,status='draft',submitted_at=NULL WHERE id=?5`).bind(stagingKey, JSON.stringify({ name: summary.name, description: summary.description, kind: summary.kind }), JSON.stringify(summary.permissions), JSON.stringify(summary.validation), releaseId).run()
      await env.DB.prepare(`UPDATE submissions SET status='withdrawn',resolved_at=?1 WHERE release_id=?2 AND status='pending'`).bind(timestamp, releaseId).run()
    } else {
      await env.DB.prepare('INSERT INTO releases(id,extension_id,version,staging_key,manifest_summary,permissions_snapshot,validation_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)').bind(releaseId, extension, summary.version, stagingKey, JSON.stringify({ name: summary.name, description: summary.description, kind: summary.kind }), JSON.stringify(summary.permissions), JSON.stringify(summary.validation), 'draft', timestamp).run()
    }
    await env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'release', releaseId, 'upload', '', timestamp).run()
  } catch (error) {
    await deleteR2ObjectBestEffort(env, stagingKey, 'hub_staging_rollback_cleanup_failed')
    throw error
  }
  if (existing?.staging_key && existing.staging_key !== stagingKey) await deleteR2ObjectBestEffort(env, existing.staging_key, 'hub_replaced_staging_cleanup_failed')
  return json({ releaseId, version: summary.version, status: 'draft', validation: summary.validation, permissions: summary.permissions }, { status: existing ? 200 : 201 })
}

async function submitRelease(request: Request, env: Env, releaseId: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireLegalConfig(env)
  await requirePublisherTerms(env, session.publisher.id)
  await enforceRateLimit(request, env, `submit-${session.publisher.id}`, 30, 60 * 60_000)
  if (!/^release_[a-f0-9]{32}$/.test(releaseId)) throw new HttpError(404, 'Release was not found.')
  const release = await env.DB.prepare(`SELECT r.id,r.status,r.staging_key,e.id extension_id,e.data_practice,e.privacy_policy_url,e.remote_services FROM releases r JOIN extensions e ON e.id=r.extension_id JOIN extension_owners o ON o.extension_id=e.id WHERE r.id=?1 AND o.publisher_id=?2`).bind(releaseId, session.publisher.id).first<{ id: string; status: string; staging_key: string | null; extension_id: string; data_practice: 'undisclosed' | 'local-only' | 'external-processing'; privacy_policy_url: string | null; remote_services: string }>()
  if (!release || !release.staging_key) throw new HttpError(404, 'Release was not found.')
  if (!['draft', 'changes', 'rejected'].includes(release.status)) throw new HttpError(409, 'Release cannot be submitted in its current state.')
  if (release.data_practice === 'undisclosed' || (release.data_practice === 'external-processing' && (!release.privacy_policy_url || !release.remote_services))) {
    throw new HttpError(428, 'Complete the extension data-practice declaration before submitting this release.')
  }
  const confirmation = await readJson(request, API_JSON_LIMIT)
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation) || (confirmation as Record<string, unknown>).warrantyAccepted !== true) throw new HttpError(400, 'Confirm the publisher warranty when submitting this release.')
  const priorSubmission = await env.DB.prepare('SELECT id FROM submissions WHERE release_id=?1').bind(releaseId).first<{ id: string }>()
  const submissionId = priorSubmission?.id ?? `submission_${randomHex(16)}`
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO submissions(id,release_id,publisher_id,status,submitted_at,warranty_version,warranty_accepted_at) VALUES(?1,?2,?3,'pending',?4,?5,?4) ON CONFLICT(release_id) DO UPDATE SET publisher_id=excluded.publisher_id,status='pending',submitted_at=excluded.submitted_at,resolved_at=NULL,warranty_version=excluded.warranty_version,warranty_accepted_at=excluded.warranty_accepted_at`).bind(submissionId, releaseId, session.publisher.id, timestamp, PUBLISHER_WARRANTY_VERSION),
    env.DB.prepare(`UPDATE releases SET status='pending',submitted_at=?1 WHERE id=?2`).bind(timestamp, releaseId),
    env.DB.prepare(`UPDATE extensions SET status=CASE WHEN current_release_id IS NULL THEN 'pending' ELSE status END,updated_at=?1 WHERE id=?2`).bind(timestamp, release.extension_id),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'release', releaseId, 'submit', '', timestamp)
  ])
  return json({ submissionId, status: 'pending' })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

async function approveRelease(env: Env, session: HubSession, submissionId: string, note: string, row: ReleaseRow): Promise<void> {
  requireLegalConfig(env)
  if (!row.staging_key) throw new HttpError(409, 'The staged package has expired; ask the publisher to upload again.')
  const object = await env.PACKAGES.get(row.staging_key)
  if (!object) throw new HttpError(409, 'The staged package has expired; ask the publisher to upload again.')
  const bytes = new Uint8Array(await object.arrayBuffer())
  const summary = await validatePublisherPackage(bytes, row.extension_id, row.publisher_id)
  if (summary.version !== row.version) throw new HttpError(409, 'Staged release metadata changed unexpectedly.')
  const signer = await createEd25519Signer(env.SIGNING_KEY_ID, env.HUB_SIGNING_PRIVATE_KEY_PKCS8)
  const official = await createVextPackage({ extensionId: row.extension_id, version: row.version, publisherId: row.publisher_id, files: summary.parsed.files, signer })
  const packageHash = await sha256Hex(official)
  const packageKey = `packages/${row.extension_id}/${row.version}/${packageHash}.vext`
  const publishedAt = now()
  const descriptor: VastHubReleaseDescriptor = {
    schema: 1,
    extension_id: row.extension_id,
    publisher_id: row.publisher_id,
    version: row.version,
    package_url: `${publicOrigin(env)}/${packageKey}`,
    sha256: packageHash,
    key_id: env.SIGNING_KEY_ID,
    permissions: summary.permissions,
    published_at: publishedAt
  }
  const descriptorSignature = bytesToBase64(await signer.sign(encoder.encode(canonicalJson(descriptor))))
  const signed: SignedVastHubReleaseDescriptor = { descriptor, signature: { signature_version: 1, algorithm: 'Ed25519', key_id: env.SIGNING_KEY_ID, signature: descriptorSignature } }
  await env.PACKAGES.put(packageKey, official, { httpMetadata: { contentType: 'application/vnd.vast.extension+zip', cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { extensionId: row.extension_id, version: row.version, sha256: packageHash } })
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE releases SET package_key=?1,package_sha256=?2,package_size=?3,signature_key_id=?4,descriptor_json=?5,descriptor_signature=?6,manifest_summary=?7,permissions_snapshot=?8,validation_json=?9,status='published',published_at=?10 WHERE id=?11 AND status='reviewing'`).bind(packageKey, packageHash, official.byteLength, env.SIGNING_KEY_ID, canonicalJson(descriptor), descriptorSignature, JSON.stringify({ name: summary.name, description: summary.description, kind: summary.kind }), JSON.stringify(summary.permissions), JSON.stringify(summary.validation), publishedAt, row.id),
      env.DB.prepare(`UPDATE submissions SET status='approved',resolved_at=?1 WHERE id=?2 AND status='reviewing'`).bind(publishedAt, submissionId),
      env.DB.prepare(`INSERT INTO submission_reviews(id,submission_id,reviewer_id,decision,note,created_at) VALUES(?1,?2,?3,'approve',?4,?5)`).bind(`review_${randomHex(12)}`, submissionId, session.publisher.id, note, publishedAt),
      env.DB.prepare(`UPDATE extensions SET current_release_id=?1,status='published',kind=?2,updated_at=?3 WHERE id=?4`).bind(row.id, summary.kind, publishedAt, row.extension_id),
      env.DB.prepare(`INSERT INTO download_counters(extension_id,count,updated_at) VALUES(?1,0,?2) ON CONFLICT(extension_id) DO NOTHING`).bind(row.extension_id, publishedAt),
      env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'release', row.id, row.publisher_id === session.publisher.id ? 'admin-self-approve-and-sign' : 'approve-and-sign', note, publishedAt)
    ])
  } catch (error) {
    await deleteR2ObjectBestEffort(env, packageKey, 'hub_package_rollback_cleanup_failed')
    throw error
  }
  await deleteR2ObjectBestEffort(env, row.staging_key, 'hub_published_staging_cleanup_failed')
  void signed
}

async function reviewDecision(request: Request, env: Env, submissionId: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireRole(session, ['reviewer', 'admin'])
  await enforceRateLimit(request, env, `review-${session.publisher.id}`, 120, 60 * 60_000)
  if (!/^submission_[a-f0-9]{32}$/.test(submissionId)) throw new HttpError(404, 'Submission was not found.')
  const body = await readJson(request, API_JSON_LIMIT)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Review decision is invalid.')
  const action = String((body as Record<string, unknown>).action ?? '')
  const note = String((body as Record<string, unknown>).note ?? '').trim().slice(0, 4_000)
  if (!['approve', 'reject', 'changes'].includes(action) || (action !== 'approve' && note.length < 10)) throw new HttpError(400, 'A valid decision and reviewer note are required.')
  const row = await env.DB.prepare(`SELECT r.*,e.publisher_id,e.current_release_id,e.name extension_name,p.publisher_name FROM submissions s JOIN releases r ON r.id=s.release_id JOIN extensions e ON e.id=r.extension_id JOIN publishers p ON p.id=e.publisher_id WHERE s.id=?1 AND s.status='pending' AND r.status='pending'`).bind(submissionId).first<ReleaseRow>()
  if (!row) throw new HttpError(404, 'Submission was not found.')
  const adminSelfReview = row.publisher_id === session.publisher.id && session.publisher.role === 'admin'
  if (row.publisher_id === session.publisher.id && !adminSelfReview) throw new HttpError(403, 'Only a trusted administrator can review their own release.')
  const reviewNote = adminSelfReview && !note ? 'Trusted administrator self-approved this release.' : note
  const claimedAt = now()
  const claim = await env.DB.prepare(`UPDATE submissions SET status='reviewing',resolved_at=?1 WHERE id=?2 AND status='pending' RETURNING id`).bind(claimedAt, submissionId).first<{ id: string }>()
  if (!claim) throw new HttpError(409, 'This submission is already being reviewed.')
  await env.DB.prepare(`UPDATE releases SET status='reviewing' WHERE id=?1 AND status='pending'`).bind(row.id).run()
  try {
    if (action === 'approve') {
      await approveRelease(env, session, submissionId, reviewNote, row)
    } else {
      const timestamp = now()
      const releaseStatus = action === 'changes' ? 'changes' : 'rejected'
      await env.DB.batch([
        env.DB.prepare('UPDATE releases SET status=?1 WHERE id=?2').bind(releaseStatus, row.id),
        env.DB.prepare(`UPDATE submissions SET status=?1,resolved_at=?2 WHERE id=?3 AND status='reviewing'`).bind(action, timestamp, submissionId),
        env.DB.prepare('INSERT INTO submission_reviews(id,submission_id,reviewer_id,decision,note,created_at) VALUES(?1,?2,?3,?4,?5,?6)').bind(`review_${randomHex(12)}`, submissionId, session.publisher.id, action, note, timestamp),
        env.DB.prepare(`UPDATE extensions SET status=CASE WHEN current_release_id IS NULL THEN 'draft' ELSE status END,updated_at=?1 WHERE id=?2`).bind(timestamp, row.extension_id),
        env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'release', row.id, action, note, timestamp)
      ])
    }
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE submissions SET status='pending',resolved_at=NULL WHERE id=?1 AND status='reviewing'`).bind(submissionId),
      env.DB.prepare(`UPDATE releases SET status='pending' WHERE id=?1 AND status='reviewing'`).bind(row.id)
    ])
    throw error
  }
  return json({ status: action === 'approve' ? 'published' : action })
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

async function deleteR2ObjectBestEffort(env: Env, key: string, event: string): Promise<void> {
  try { await env.PACKAGES.delete(key) } catch (error) {
    console.error(JSON.stringify({ event, errorType: error instanceof Error ? error.name : 'UnknownError' }))
  }
}

async function canonicalWebp(env: Env, bytes: Uint8Array, kind: 'icon' | 'screenshot'): Promise<Uint8Array> {
  let info: ImageInfoResponse
  try { info = await env.IMAGES.info(byteStream(bytes)) } catch { throw new HttpError(400, 'The uploaded file could not be decoded as an image.') }
  if (info.format === 'image/svg+xml' || !('width' in info) || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) throw new HttpError(400, 'Only valid raster images are accepted.')
  if (info.width > 16_384 || info.height > 16_384 || info.width * info.height > 40_000_000) throw new HttpError(400, 'Image dimensions are too large.')
  const bounds = kind === 'icon' ? { width: 512, height: 512 } : { width: 1920, height: 1080 }
  try {
    const output = await env.IMAGES.input(byteStream(bytes)).transform({ ...bounds, fit: 'scale-down' }).output({ format: 'image/webp', quality: 86, anim: false })
    const canonical = new Uint8Array(await output.response().arrayBuffer())
    if (!canonical.byteLength || canonical.byteLength > MEDIA_LIMIT) throw new HttpError(400, 'The canonical image is too large.')
    return canonical
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'The uploaded image could not be safely processed.')
  }
}

async function uploadMedia(request: Request, env: Env, extension: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireLegalConfig(env)
  await requirePublisherTerms(env, session.publisher.id)
  await enforceRateLimit(request, env, `media-${session.publisher.id}`, 40, 60 * 60_000)
  await ownedExtension(env, extension, session.publisher.id)
  const kind = new URL(request.url).searchParams.get('kind')
  if (kind !== 'icon' && kind !== 'screenshot') throw new HttpError(400, 'Media kind is invalid.')
  const declaredType = request.headers.get('content-type')?.split(';')[0].toLowerCase() ?? ''
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(declaredType)) throw new HttpError(415, 'Only PNG, JPEG, or WebP uploads are accepted.')
  const bytes = await readBounded(request, kind === 'icon' ? 2 * 1024 * 1024 : MEDIA_LIMIT)
  const canonical = await canonicalWebp(env, bytes, kind)
  const existingCount = kind === 'screenshot'
    ? Number((await env.DB.prepare('SELECT COUNT(*) count FROM extension_screenshots WHERE extension_id=?1').bind(extension).first<{ count: number }>())?.count ?? 0)
    : 0
  if (existingCount >= 5) throw new HttpError(409, 'An extension can have at most five screenshots.')
  const objectKey = `media/${extension}/${randomHex(16)}.webp`
  await env.PACKAGES.put(objectKey, canonical, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { extensionId: extension, kind, sanitized: 'cloudflare-images' } })
  const timestamp = now()
  let previousIconKey: string | null = null
  try {
    if (kind === 'icon') {
      const previous = await env.DB.prepare('SELECT icon_key FROM extensions WHERE id=?1').bind(extension).first<{ icon_key: string | null }>()
      await env.DB.prepare('UPDATE extensions SET icon_key=?1,updated_at=?2 WHERE id=?3').bind(objectKey, timestamp, extension).run()
      previousIconKey = previous?.icon_key ?? null
    } else {
      const inserted = await env.DB.prepare(`INSERT INTO extension_screenshots(id,extension_id,object_key,media_type,position,created_at) SELECT ?1,?2,?3,'image/webp',COALESCE(MAX(position),-1)+1,?4 FROM extension_screenshots WHERE extension_id=?2 HAVING COUNT(*)<5`).bind(`media_${randomHex(12)}`, extension, objectKey, timestamp).run()
      if (!inserted.meta.changes) throw new HttpError(409, 'An extension can have at most five screenshots.')
    }
  } catch (error) {
    await deleteR2ObjectBestEffort(env, objectKey, 'hub_media_rollback_cleanup_failed')
    throw error
  }
  if (previousIconKey) await deleteR2ObjectBestEffort(env, previousIconKey, 'hub_replaced_icon_cleanup_failed')
  return json({ url: `${publicOrigin(env)}/media/${encodeURIComponent(objectKey)}` }, { status: 201 })
}

async function serveMedia(env: Env, encoded: string): Promise<Response> {
  let key: string
  try { key = decodeURIComponent(encoded) } catch { throw new HttpError(404, 'Media was not found.') }
  if (!/^media\/[a-p]{32}\/[a-f0-9]{32}\.webp$/.test(key)) throw new HttpError(404, 'Media was not found.')
  const visible = await env.DB.prepare(`SELECT 1 visible FROM extensions e LEFT JOIN extension_screenshots s ON s.extension_id=e.id WHERE e.status='published' AND (e.icon_key=?1 OR s.object_key=?1) LIMIT 1`).bind(key).first<{ visible: number }>()
  if (!visible) throw new HttpError(404, 'Media was not found.')
  const object = await env.PACKAGES.get(key)
  if (!object) throw new HttpError(404, 'Media was not found.')
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('x-content-type-options', 'nosniff')
  return secureResponse(new Response(object.body, { headers }))
}

async function servePackage(request: Request, env: Env, key: string): Promise<Response> {
  if (!/^packages\/[a-p]{32}\/[0-9A-Za-z.+-]{1,64}\/[a-f0-9]{64}\.vext$/.test(key)) throw new HttpError(404, 'Package was not found.')
  await enforceRateLimit(request, env, 'package-download', 180, 60_000)
  const release = await env.DB.prepare(`SELECT r.extension_id,r.package_sha256 FROM releases r JOIN extensions e ON e.id=r.extension_id WHERE r.package_key=?1 AND r.status='published' AND e.status='published'`).bind(key).first<{ extension_id: string; package_sha256: string }>()
  if (!release) throw new HttpError(404, 'Package was not found.')
  const responseHeaders = (object: R2Object): Headers => {
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('content-type', 'application/vnd.vast.extension+zip')
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    headers.set('etag', `"${release.package_sha256}"`)
    headers.set('content-disposition', `attachment; filename="${release.extension_id}.vext"`)
    headers.set('x-content-type-options', 'nosniff')
    return headers
  }
  if (request.method === 'HEAD') {
    const object = await env.PACKAGES.head(key)
    if (!object) throw new HttpError(404, 'Package was not found.')
    return secureResponse(new Response(null, { headers: responseHeaders(object) }))
  }
  const object = await env.PACKAGES.get(key)
  if (!object) throw new HttpError(404, 'Package was not found.')
  await env.DB.prepare(`INSERT INTO download_counters(extension_id,count,updated_at) VALUES(?1,1,?2) ON CONFLICT(extension_id) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`).bind(release.extension_id, now()).run()
  return secureResponse(new Response(object.body, { headers: responseHeaders(object) }))
}

async function dashboard(request: Request, env: Env): Promise<Response> {
  const session = await optionalSession(request, env)
  if (!session) return secureResponse(Response.redirect(`${publicOrigin(env)}/auth/github/start?return=%2Fdashboard`, 302))
  const listings = (await env.DB.prepare(`SELECT e.id,e.name,e.slug,e.status,e.data_practice,e.privacy_policy_url,e.remote_services FROM extensions e JOIN extension_owners o ON o.extension_id=e.id WHERE o.publisher_id=?1 ORDER BY e.updated_at DESC`).bind(session.publisher.id).all<{ id: string; name: string; slug: string; status: string; data_practice: 'undisclosed' | 'local-only' | 'external-processing'; privacy_policy_url: string | null; remote_services: string }>()).results
  const output: DashboardExtension[] = []
  for (const listing of listings) {
    const releases = (await env.DB.prepare('SELECT id,version,status,created_at FROM releases WHERE extension_id=?1 ORDER BY created_at DESC').bind(listing.id).all<{ id: string; version: string; status: string; created_at: string }>()).results
    output.push({ id: listing.id, name: listing.name, slug: listing.slug, status: listing.status, dataPractice: listing.data_practice, privacyPolicyUrl: listing.privacy_policy_url ?? undefined, remoteServices: listing.remote_services, releases: releases.map((release) => ({ id: release.id, version: release.version, status: release.status, createdAt: release.created_at })) })
  }
  let termsAccepted = false
  if (optionalLegalConfig(env)) {
    const terms = await currentPublisherTerms(env)
    termsAccepted = Boolean(await env.DB.prepare('SELECT 1 accepted FROM publisher_terms_acceptances WHERE publisher_id=?1 AND terms_version=?2 AND terms_sha256=?3').bind(session.publisher.id, terms.version, terms.sha256).first())
  }
  return html(dashboardPage(output, session, await categories(env), termsAccepted))
}

const LEGAL_COPY: Record<string, { title: string; paragraphs: string[] }> = {
  privacy: { title: 'Privacy Notice', paragraphs: [
    'Vast collects no browsing telemetry. The Browser, Relay, Extensions Hub, and independently published extensions are separate data contexts.',
    'The Hub processes GitHub account and profile details used for publisher identity, session and CSRF records, keyed hashes of IP addresses for rate limiting, listings, packages and media stored in D1 and R2, automated and human review records, audit events, terms acceptances, and abuse reports.',
    'Publisher sessions expire after 7 days, OAuth state after 10 minutes, rate-limit hashes after their bounded cleanup window, and unpublished staged packages after 14 days. Reporter contact fields are removed after 1 year and closed reports after 3 years unless a legal hold applies. Published artifacts, terms acceptances, review/audit records, and evidence needed for distribution, security, disputes, or legal compliance may remain longer. The Hub does not receive a user\'s browsing history from Vast Browser.',
    'Each publisher must separately disclose an extension\'s data practices and remote services. Vast review does not replace the publisher\'s privacy obligations.'
  ] },
  copyright: { title: 'Copyright and IP Notice', paragraphs: [
    'The MIT license covers source code owned by Vast where the repository says so. Extensions, libraries, names, icons, screenshots, and other third-party materials remain the property of their respective owners and are governed by their own licenses.',
    'Use Report extension to submit copyright, trademark, impersonation, or other rights concerns. Reports are preserved and reviewed; they do not cause automatic delisting.'
  ] },
  'platform-terms': { title: 'Platform Terms', paragraphs: [
    'The Hub provides catalog, review, signing, hosting, and distribution services for Vast extensions. Availability and review do not guarantee that third-party software is free of defects.',
    'Users must not abuse the service, evade security controls, upload unlawful content, or interfere with review and distribution. Vast may suspend unsafe listings while preserving an auditable record.'
  ] },
  'publishing-policy': { title: 'Publishing Policy', paragraphs: [
    'Releases must declare necessary permissions, data practices, remote services, ownership, and functionality accurately. Malware, credential theft, hidden tracking, deceptive behavior, unlawful functionality, impersonation, and infringement are prohibited.',
    'Automated validation is followed by risk-based human review. Findings that indicate minification, obfuscation, dynamic code, permission escalation, or unexpected network behavior require manual review. Decisions, notices, and evidence are auditable.'
  ] }
}

async function legalDocument(request: Request, env: Env, slug: string): Promise<Response> {
  const session = await optionalSession(request, env)
  if (slug === 'publisher-terms') {
    const config = optionalLegalConfig(env)
    const paragraphs = config ? [...(await currentPublisherTerms(env)).text.split('\n\n'), `Legal and administrative information: ${config.contactUrl}`] : ['Publisher Terms are not active because the verified legal operator and legal contact have not been configured. Publishing is blocked fail-closed.']
    return html(legalPage('Publisher Terms', paragraphs, session))
  }
  const document = LEGAL_COPY[slug]
  if (!document) throw new HttpError(404, 'Legal document was not found.')
  return html(legalPage(document.title, document.paragraphs, session))
}

async function reportForm(request: Request, env: Env, extension: string): Promise<Response> {
  const [row, session] = await Promise.all([getCatalogRow(env, extension), optionalSession(request, env)])
  if (!row) throw new HttpError(404, 'Extension was not found.')
  return html(reportPage(catalogView(row, env), session))
}

async function createReport(request: Request, env: Env, extension: string): Promise<Response> {
  if (request.headers.get('origin') !== publicOrigin(env)) throw new HttpError(403, 'Origin validation failed.')
  await enforceRateLimit(request, env, 'extension-report', 5, 60 * 60_000)
  const listing = await getCatalogRow(env, extension)
  if (!listing) throw new HttpError(404, 'Extension was not found.')
  const value = await readJson(request, API_JSON_LIMIT)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Report is invalid.')
  const body = value as Record<string, unknown>
  const category = String(body.category ?? '')
  const details = String(body.details ?? '').trim()
  const reporterName = String(body.reporterName ?? '').trim()
  const reporterEmail = String(body.reporterEmail ?? '').trim().toLowerCase()
  if (!['copyright', 'malware', 'illegal', 'privacy', 'impersonation', 'other'].includes(category)) throw new HttpError(400, 'Report category is invalid.')
  if (details.length < 20 || details.length > 8_000) throw new HttpError(400, 'Report details must contain 20 to 8000 characters.')
  if (reporterName.length > 200 || (reporterEmail && (reporterEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)))) throw new HttpError(400, 'Reporter contact details are invalid.')
  const id = `report_${randomHex(16)}`
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO extension_reports(id,extension_id,release_id,category,details,reporter_name,reporter_email,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)').bind(id, extension, listing ? (await env.DB.prepare('SELECT current_release_id FROM extensions WHERE id=?1').bind(extension).first<{ current_release_id: string }>())?.current_release_id ?? null : null, category, details, reporterName || null, reporterEmail || null, 'open', timestamp),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,NULL,?2,?3,?4,?5,?6)').bind(`audit_${randomHex(12)}`, 'extension-report', id, 'report-received', category, timestamp)
  ])
  return json({ id, status: 'open' }, { status: 201 })
}

async function reportReviewQueue(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  requireRole(session, ['reviewer', 'admin'])
  const reports = (await env.DB.prepare(`SELECT x.id,x.category,x.details,x.reporter_name,x.reporter_email,x.status,x.legal_hold,x.created_at,e.name extension_name,p.publisher_name FROM extension_reports x JOIN extensions e ON e.id=x.extension_id JOIN publishers p ON p.id=e.publisher_id WHERE x.status IN ('open','reviewing') ORDER BY x.created_at LIMIT 100`).all<{ id: string; category: string; details: string; reporter_name: string | null; reporter_email: string | null; status: 'open' | 'reviewing'; legal_hold: number; created_at: string; extension_name: string; publisher_name: string }>()).results
  const items: ExtensionReportReviewItem[] = reports.map((item) => ({
    id: item.id,
    extensionName: item.extension_name,
    publisherName: item.publisher_name,
    category: item.category,
    details: item.details,
    reporterName: item.reporter_name ?? undefined,
    reporterEmail: item.reporter_email ?? undefined,
    status: item.status,
    legalHold: item.legal_hold === 1,
    createdAt: item.created_at
  }))
  return html(reportReviewPage(items, session))
}

async function reportDecision(request: Request, env: Env, reportId: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireRole(session, ['reviewer', 'admin'])
  if (!/^report_[a-f0-9]{32}$/.test(reportId)) throw new HttpError(404, 'Report was not found.')
  const value = await readJson(request, API_JSON_LIMIT)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Report decision is invalid.')
  const body = value as Record<string, unknown>
  const status = String(body.status ?? '')
  const reason = String(body.reason ?? '').trim()
  const publisherNotified = body.publisherNotified === true
  const legalHold = body.legalHold === true
  if (!['reviewing', 'actioned', 'dismissed'].includes(status) || reason.length < 10 || reason.length > 4_000) throw new HttpError(400, 'A valid status and internal reason are required.')
  const timestamp = now()
  const actionId = `report_action_${randomHex(12)}`
  const auditId = `audit_${randomHex(12)}`
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE extension_reports SET status=?1,legal_hold=?2,updated_at=?3,publisher_notified_at=CASE WHEN ?4=1 THEN ?3 ELSE publisher_notified_at END WHERE id=?5 AND status IN ('open','reviewing')`).bind(status, legalHold ? 1 : 0, timestamp, publisherNotified ? 1 : 0, reportId),
    env.DB.prepare('INSERT INTO extension_report_actions(id,report_id,actor_id,action,internal_reason,created_at) SELECT ?1,?2,?3,?4,?5,?6 FROM extension_reports WHERE id=?2 AND status=?4 AND updated_at=?6').bind(actionId, reportId, session.publisher.id, status, reason, timestamp),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7 FROM extension_reports WHERE id=?4 AND status=?8 AND updated_at=?7').bind(auditId, session.publisher.id, 'extension-report', reportId, `report-${status}`, `${publisherNotified ? 'publisher-notified' : 'publisher-not-notified'};${legalHold ? 'legal-hold' : 'no-legal-hold'}`, timestamp, status)
  ])
  if (!results[0].meta.changes) throw new HttpError(404, 'Report was not found.')
  return json({ status, publisherNotified, legalHold })
}

async function reviewQueue(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env)
  requireRole(session, ['reviewer', 'admin'])
  const rows = (await env.DB.prepare(`SELECT s.id submission_id,r.id release_id,r.extension_id,r.version,r.validation_json,r.permissions_snapshot,r.manifest_summary,s.submitted_at,e.name extension_name,e.summary,e.description,e.source_url,e.publisher_id,p.publisher_name,previous.permissions_snapshot previous_permissions FROM submissions s JOIN releases r ON r.id=s.release_id JOIN extensions e ON e.id=r.extension_id JOIN publishers p ON p.id=e.publisher_id LEFT JOIN releases previous ON previous.id=e.current_release_id WHERE s.status='pending' AND r.status='pending' ORDER BY s.submitted_at LIMIT 100`).all<{ submission_id: string; release_id: string; extension_id: string; version: string; validation_json: string; permissions_snapshot: string; manifest_summary: string; submitted_at: string; extension_name: string; summary: string; description: string; source_url: string | null; publisher_id: string; publisher_name: string; previous_permissions: string | null }>()).results
  const items: ReviewItem[] = []
  for (const row of rows) {
    const permissions = parsePermissions(row.permissions_snapshot)
    const previous = row.previous_permissions ? parsePermissions(row.previous_permissions) : { chrome: [], hosts: [], vast: [] }
    const added = permissionEscalation(previous, permissions)
    const screenshots = (await env.DB.prepare('SELECT object_key FROM extension_screenshots WHERE extension_id=?1 ORDER BY position LIMIT 5').bind(row.extension_id).all<{ object_key: string }>()).results
    items.push({
      submissionId: row.submission_id,
      releaseId: row.release_id,
      extensionId: row.extension_id,
      version: row.version,
      extensionName: row.extension_name,
      publisherId: row.publisher_id,
      publisherName: row.publisher_name,
      submittedAt: row.submitted_at,
      summary: row.summary,
      description: row.description,
      ...(row.source_url ? { sourceUrl: row.source_url } : {}),
      manifest: parseManifestSummary(row.manifest_summary),
      screenshots: screenshots.map((entry) => `${publicOrigin(env)}/media/${encodeURIComponent(entry.object_key)}`),
      validation: parseValidationFindings(row.validation_json),
      permissions,
      addedPermissions: [...added.chrome, ...added.hosts, ...added.vast]
    })
  }
  return html(reviewPage(items, session))
}

async function publisherHome(request: Request, env: Env): Promise<Response> {
  return html(publisherHomePage(await optionalSession(request, env)), { headers: { 'cache-control': 'no-store' } })
}

async function explore(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const [{ rows }, categoryList, session] = await Promise.all([catalogRows(env, url, CATALOG_PAGE_SIZE, 0), categories(env), optionalSession(request, env)])
  return html(homePage(rows.map((row) => catalogView(row, env)), (url.searchParams.get('query') ?? '').slice(0, 128), categoryList, session, (url.searchParams.get('category') ?? '').slice(0, 64)), { headers: { 'cache-control': 'no-store' } })
}

async function detail(request: Request, env: Env, id: string): Promise<Response> {
  const [row, session] = await Promise.all([getCatalogRow(env, id), optionalSession(request, env)])
  if (!row) throw new HttpError(404, 'Extension was not found.')
  return html(detailPage({ ...catalogView(row, env), description: row.description, ...(row.homepage ? { homepage: row.homepage } : {}), ...(row.source_url ? { sourceUrl: row.source_url } : {}), permissions: parsePermissions(row.permissions_snapshot) }, session), { headers: { 'cache-control': 'no-store' } })
}

async function logout(request: Request, env: Env): Promise<Response> {
  const session = await requireMutation(request, env)
  const token = cookie(request, SESSION_COOKIE)
  if (token) await env.DB.prepare('DELETE FROM publisher_sessions WHERE id_hash=?1 AND publisher_id=?2').bind(await sha256(token), session.publisher.id).run()
  const headers = new Headers({ location: '/', 'cache-control': 'no-store' })
  headers.append('set-cookie', clearSessionCookie())
  headers.append('set-cookie', clearCsrfCookie())
  return secureResponse(new Response(null, { status: 303, headers }))
}

async function yankRelease(request: Request, env: Env, releaseId: string): Promise<Response> {
  const session = await requireMutation(request, env)
  const row = await env.DB.prepare(`SELECT r.id,r.extension_id,r.status,e.current_release_id FROM releases r JOIN extensions e ON e.id=r.extension_id JOIN extension_owners o ON o.extension_id=e.id WHERE r.id=?1 AND o.publisher_id=?2`).bind(releaseId, session.publisher.id).first<{ id: string; extension_id: string; status: string; current_release_id: string | null }>()
  if (!row || row.status !== 'published') throw new HttpError(404, 'Release was not found.')
  if (row.current_release_id === row.id) throw new HttpError(409, 'The current release cannot be yanked until a replacement is published.')
  await env.DB.batch([
    env.DB.prepare(`UPDATE releases SET status='yanked' WHERE id=?1`).bind(row.id),
    env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'release', row.id, 'yank', '', now())
  ])
  return json({ status: 'yanked' })
}

async function suspendExtension(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireMutation(request, env)
  requireRole(session, ['reviewer', 'admin'])
  assertExtensionId(id)
  const body = await readJson(request, API_JSON_LIMIT)
  let note = ''
  if (body && typeof body === 'object' && !Array.isArray(body)) note = String((body as { note?: unknown }).note ?? '').trim().slice(0, 4_000)
  if (note.length < 10) throw new HttpError(400, 'A suspension note is required.')
  const result = await env.DB.prepare(`UPDATE extensions SET status='suspended',updated_at=?1 WHERE id=?2 AND status='published'`).bind(now(), id).run()
  if (!result.meta.changes) throw new HttpError(404, 'Extension was not found.')
  await env.DB.prepare('INSERT INTO audit_log(id,actor_id,target_type,target_id,action,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(`audit_${randomHex(12)}`, session.publisher.id, 'extension', id, 'suspend', note, now()).run()
  return json({ status: 'suspended' })
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (request.method === 'GET' && path === '/') return publisherHome(request, env)
  if (request.method === 'GET' && path === '/explore') return explore(request, env)
  if (request.method === 'GET' && path === '/v1/catalog') return publicCatalog(request, env)
  if (request.method === 'GET' && path === '/auth/github/start') return oauthStart(request, env)
  if (request.method === 'GET' && path === '/auth/github/callback') return oauthCallback(request, env)
  if (request.method === 'POST' && path === '/auth/logout') return logout(request, env)
  if (request.method === 'GET' && path === '/dashboard') return dashboard(request, env)
  if (request.method === 'GET' && path === '/review') return reviewQueue(request, env)
  if (request.method === 'GET' && path === '/review/reports') return reportReviewQueue(request, env)
  const legalMatch = path.match(/^\/legal\/([a-z-]+)$/)
  if (request.method === 'GET' && legalMatch) return legalDocument(request, env, legalMatch[1])
  const reportFormMatch = path.match(/^\/report\/([a-p]{32})$/)
  if (request.method === 'GET' && reportFormMatch) return reportForm(request, env, reportFormMatch[1])
  if (request.method === 'POST' && path === '/v1/publisher/terms/accept') return acceptPublisherTerms(request, env)
  if (request.method === 'POST' && path === '/v1/publisher/extensions') return createExtension(request, env)
  const detailMatch = path.match(/^\/v1\/extensions\/([a-p]{32})$/)
  if (request.method === 'GET' && detailMatch) return extensionDetails(env, detailMatch[1])
  const reportCreateMatch = path.match(/^\/v1\/extensions\/([a-p]{32})\/reports$/)
  if (request.method === 'POST' && reportCreateMatch) return createReport(request, env, reportCreateMatch[1])
  const currentReleaseMatch = path.match(/^\/v1\/install\/([a-p]{32})$/)
  if (request.method === 'GET' && currentReleaseMatch) return releaseDescriptor(request, env, currentReleaseMatch[1])
  const canonicalCurrentMatch = path.match(/^\/v1\/extensions\/([a-p]{32})\/releases\/current$/)
  if (request.method === 'GET' && canonicalCurrentMatch) return releaseDescriptor(request, env, canonicalCurrentMatch[1])
  const releaseMatch = path.match(/^\/v1\/extensions\/([a-p]{32})\/releases\/([^/]+)$/)
  if (request.method === 'GET' && releaseMatch) {
    let version: string
    try { version = decodeURIComponent(releaseMatch[2]) } catch { throw new HttpError(404, 'Release was not found.') }
    return releaseDescriptor(request, env, releaseMatch[1], version)
  }
  const websiteDetail = path.match(/^\/extension\/([a-p]{32})$/)
  if (request.method === 'GET' && websiteDetail) return detail(request, env, websiteDetail[1])
  const uploadMatch = path.match(/^\/v1\/publisher\/extensions\/([a-p]{32})\/releases$/)
  if (request.method === 'POST' && uploadMatch) return uploadRelease(request, env, uploadMatch[1])
  const disclosureMatch = path.match(/^\/v1\/publisher\/extensions\/([a-p]{32})\/data-practices$/)
  if (request.method === 'POST' && disclosureMatch) return updateExtensionDataPractice(request, env, disclosureMatch[1])
  const mediaUploadMatch = path.match(/^\/v1\/publisher\/extensions\/([a-p]{32})\/media$/)
  if (request.method === 'POST' && mediaUploadMatch) return uploadMedia(request, env, mediaUploadMatch[1])
  const submitMatch = path.match(/^\/v1\/publisher\/releases\/(release_[a-f0-9]{32})\/submit$/)
  if (request.method === 'POST' && submitMatch) return submitRelease(request, env, submitMatch[1])
  const yankMatch = path.match(/^\/v1\/publisher\/releases\/(release_[a-f0-9]{32})\/yank$/)
  if (request.method === 'POST' && yankMatch) return yankRelease(request, env, yankMatch[1])
  const reviewMatch = path.match(/^\/v1\/review\/submissions\/(submission_[a-f0-9]{32})$/)
  if (request.method === 'POST' && reviewMatch) return reviewDecision(request, env, reviewMatch[1])
  const suspendMatch = path.match(/^\/v1\/review\/extensions\/([a-p]{32})\/suspend$/)
  if (request.method === 'POST' && suspendMatch) return suspendExtension(request, env, suspendMatch[1])
  const reportDecisionMatch = path.match(/^\/v1\/review\/reports\/(report_[a-f0-9]{32})$/)
  if (request.method === 'POST' && reportDecisionMatch) return reportDecision(request, env, reportDecisionMatch[1])
  if ((request.method === 'GET' || request.method === 'HEAD') && path.startsWith('/packages/')) return servePackage(request, env, path.slice(1))
  if (request.method === 'GET' && path.startsWith('/media/')) return serveMedia(env, path.slice('/media/'.length))
  if (request.method === 'GET' && (path === '/styles.css' || path === '/app.js')) return secureResponse(await env.ASSETS.fetch(request))
  throw new HttpError(404, 'Route was not found.')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()
    try { return await route(request, env) } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof HttpError ? error.message : 'An unexpected server error occurred.'
      console.error(JSON.stringify({ event: 'hub_request_error', requestId, method: request.method, path: new URL(request.url).pathname, status, errorType: error instanceof Error ? error.name : 'UnknownError' }))
      if (new URL(request.url).pathname.startsWith('/v1/')) return json({ error: message, requestId }, { status })
      return html(messagePage(status === 404 ? 'Not found' : 'Request failed', message), { status })
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupExpiredState(env)
  }
} satisfies ExportedHandler<Env>
