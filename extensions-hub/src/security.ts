const encoder = new TextEncoder()
export const SESSION_COOKIE = '__Host-vast_hub_session'
export const OAUTH_COOKIE = '__Host-vast_hub_oauth_v2'
export const CSRF_COOKIE = '__Host-vast_hub_csrf'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface HubPublisher {
  id: string
  githubUserId: string
  githubLogin: string
  displayName: string
  publisherName: string
  avatarUrl?: string
  role: 'publisher' | 'reviewer' | 'admin'
  verified: boolean
}

export interface HubSession { publisher: HubPublisher; csrfHash: string }

export const securityHeaders = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains'
})

export function secureResponse(response: Response): Response {
  const next = new Response(response.body, response)
  for (const [name, value] of Object.entries(securityHeaders)) next.headers.set(name, value)
  return next
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store')
  return secureResponse(new Response(JSON.stringify(value), { ...init, headers }))
}

export function html(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store')
  return secureResponse(new Response(value, { ...init, headers }))
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export async function readBodyBounded(body: ReadableStream<Uint8Array> | null, declaredLength: string | null, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(declaredLength ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'Request is too large.')
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new HttpError(413, 'Request is too large.')
      chunks.push(result.value)
    }
  } finally { reader.releaseLock() }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

export async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  return readBodyBounded(request.body, request.headers.get('content-length'), maxBytes)
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json.')
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request, maxBytes))) as unknown } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Request body is not valid JSON.')
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return base64Url(value)
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function timingEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(left)), crypto.subtle.digest('SHA-256', encoder.encode(right))])
  const leftBytes = new Uint8Array(a)
  const rightBytes = new Uint8Array(b)
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength
  for (let index = 0; index < leftBytes.byteLength; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index]
  return mismatch === 0
}

export function cookies(request: Request, name: string): string[] {
  const values: string[] = []
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue
    try { values.push(decodeURIComponent(part.slice(separator + 1).trim())) } catch { /* Ignore malformed cookie values. */ }
  }
  return values
}

export function cookie(request: Request, name: string): string | undefined { return cookies(request, name)[0] }

export function sessionCookie(value: string, expires: Date): string { return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${expires.toUTCString()}; Secure; HttpOnly; SameSite=Lax` }
export function oauthCookie(value: string, expires: Date): string { return `${OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${expires.toUTCString()}; Secure; HttpOnly; SameSite=Lax` }
export function csrfCookie(value: string, expires: Date): string { return `${CSRF_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${expires.toUTCString()}; Secure; SameSite=Strict` }
export function clearSessionCookie(): string { return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` }
export function clearOauthCookie(): string { return `${OAUTH_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` }
export function clearCsrfCookie(): string { return `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict` }

interface SessionRow {
  id: string
  github_user_id: string
  github_login: string
  display_name: string
  publisher_name: string
  avatar_url: string | null
  role: 'publisher' | 'reviewer' | 'admin'
  verified: number
  csrf_hash: string
}

export async function optionalSession(request: Request, env: Env): Promise<HubSession | undefined> {
  const token = cookie(request, SESSION_COOKIE)
  if (!token || token.length > 256) return undefined
  const row = await env.DB.prepare(`SELECT p.id,p.github_user_id,p.github_login,p.display_name,p.publisher_name,p.avatar_url,p.role,p.verified,s.csrf_hash FROM publisher_sessions s JOIN publishers p ON p.id=s.publisher_id WHERE s.id_hash=?1 AND s.expires_at>?2`).bind(await sha256(token), new Date().toISOString()).first<SessionRow>()
  if (!row) return undefined
  return { publisher: { id: row.id, githubUserId: row.github_user_id, githubLogin: row.github_login, displayName: row.display_name, publisherName: row.publisher_name, ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}), role: row.role, verified: row.verified === 1 }, csrfHash: row.csrf_hash }
}

export async function requireSession(request: Request, env: Env): Promise<HubSession> {
  const session = await optionalSession(request, env)
  if (!session) throw new HttpError(401, 'Sign in is required.')
  return session
}

export function requireRole(session: HubSession, roles: readonly HubPublisher['role'][]): void {
  if (!roles.includes(session.publisher.role)) throw new HttpError(403, 'You are not authorized to perform this action.')
}

export async function requireCsrf(request: Request, session: HubSession): Promise<void> {
  const provided = request.headers.get('x-csrf-token')
  if (!provided || provided.length > 256 || !await timingEqual(await sha256(provided), session.csrfHash)) throw new HttpError(403, 'CSRF validation failed.')
}

async function rateSubject(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local'
  return sha256(ip)
}

export async function enforceRateLimit(request: Request, limiter: RateLimit, bucket: string): Promise<void> {
  const result = await limiter.limit({ key: `${bucket}:${await rateSubject(request)}` })
  if (!result.success) throw new HttpError(429, 'Too many requests. Try again later.')
}

export async function cleanupExpiredState(env: Env): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?1').bind(now),
    env.DB.prepare('DELETE FROM publisher_sessions WHERE expires_at<?1').bind(now),
    env.DB.prepare(`UPDATE extension_reports SET reporter_name=NULL,reporter_email=NULL WHERE created_at<?1 AND legal_hold=0`).bind(new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString()),
    env.DB.prepare(`DELETE FROM extension_reports WHERE status IN ('actioned','dismissed') AND updated_at<?1 AND legal_hold=0`).bind(new Date(Date.now() - 3 * 365 * 24 * 60 * 60_000).toISOString()),
    env.DB.prepare(`UPDATE submissions SET status='pending',resolved_at=NULL WHERE status='reviewing' AND resolved_at<?1`).bind(new Date(Date.now() - 60 * 60_000).toISOString()),
    env.DB.prepare(`UPDATE releases SET status='pending' WHERE status='reviewing' AND id IN (SELECT release_id FROM submissions WHERE status='pending')`)
  ])
  let cursor: string | undefined
  do {
    const listed = await env.PACKAGES.list({ prefix: 'staging/', cursor, limit: 500, include: ['customMetadata'] })
    const expired = listed.objects.filter((object) => Date.parse(object.customMetadata?.expiresAt ?? '') < Date.now()).map((object) => object.key)
    if (expired.length > 0) await env.PACKAGES.delete(expired)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}
