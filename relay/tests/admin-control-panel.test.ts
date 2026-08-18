import { createLocalJWKSet, exportJWK, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  authenticateAccessRequest,
  verifyAccessTokenWithKeySet
} from '../src/admin/auth'
import { createBroadcast, deleteBroadcast, updateBroadcast } from '../src/admin/broadcasts'
import { dashboardSummary, listInstallations } from '../src/admin/dashboard'
import { createRelease } from '../src/admin/releases'
import { requireControlPanelOrigin } from '../src/admin/security'
import { uploadGeneratedAsset } from '../src/admin/assets'
import { handleCheckin } from '../src/public/checkin'
import type { CheckinResponse } from '../src/shared/types'
import { broadcastInputFrom, duplicateBroadcastInput, expireBroadcastInput, formatDate } from '../control-panel/src/model'
import type { BroadcastAdminItem } from '../control-panel/src/types'
import {
  adminBindings,
  jsonRequest,
  onePixelPng,
  publicBindings,
  TEST_ACCESS_AUD,
  TEST_IDENTITY
} from './helpers'

function announcement(id?: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(id ? { id } : {}),
    type: 'announcement',
    title: 'Control Panel test',
    body: 'Signed passive text.',
    media_id: null,
    action_label: null,
    action_url: null,
    min_version: null,
    max_version: null,
    active_from: '2026-08-11T00:00:00.000Z',
    active_until: null,
    priority: 100,
    enabled: true,
    draft: false,
    ...overrides
  }
}

async function accessToken(
  email: string | null = 'relay-admin@example.com',
  audience = TEST_ACCESS_AUD,
  extraClaims: Record<string, unknown> = {},
  subject = TEST_IDENTITY.subject
) {
  const generated = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['sign', 'verify'])
  if (!('privateKey' in generated)) throw new Error('Expected an RSA key pair.')
  const jwk = await exportJWK(generated.publicKey)
  jwk.kid = 'access-test-key'
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  const now = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({ ...(email === null ? {} : { email }), ...extraClaims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setAudience(audience)
    .setIssuer('https://vast-browser.cloudflareaccess.com')
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(generated.privateKey)
  return { token, keySet: createLocalJWKSet({ keys: [jwk] }) }
}

describe('Cloudflare Access defense in depth', () => {
  it('verifies signature, issuer, audience, expiry and authenticated identity', async () => {
    const admin = await adminBindings()
    const signed = await accessToken()
    const payload = await verifyAccessTokenWithKeySet(signed.token, admin.env, signed.keySet)
    expect(payload.email).toBe(TEST_IDENTITY.actor)

    const identity = await authenticateAccessRequest(new Request('https://controlpanel.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': signed.token, 'Cf-Access-Authenticated-User-Email': 'spoofed@example.net' }
    }), admin.env, (token, env) => verifyAccessTokenWithKeySet(token, env, signed.keySet))
    expect(identity).toEqual(TEST_IDENTITY)
  })

  it('rejects wrong audience, missing assertions and a spoofed email header', async () => {
    const admin = await adminBindings()
    const wrongAudience = await accessToken(TEST_IDENTITY.actor, 'wrong-audience')
    await expect(verifyAccessTokenWithKeySet(wrongAudience.token, admin.env, wrongAudience.keySet)).rejects.toBeTruthy()
    await expect(authenticateAccessRequest(new Request('https://controlpanel.test/', {
      headers: { 'Cf-Access-Authenticated-User-Email': TEST_IDENTITY.actor }
    }), admin.env)).rejects.toMatchObject({ status: 401 })
  })

  it('records a verified staging service token common name as a distinct service actor', async () => {
    const admin = await adminBindings()
    const commonName = '0123456789abcdef0123456789abcdef.access'
    const signed = await accessToken(null, TEST_ACCESS_AUD, {
      common_name: commonName
    }, '')
    const identity = await authenticateAccessRequest(new Request('https://controlpanel.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': signed.token }
    }), admin.env, (token, env) => verifyAccessTokenWithKeySet(token, env, signed.keySet))
    expect(identity).toEqual({
      actor: `service:${commonName}`,
      kind: 'service',
      subject: `service:${commonName}`
    })
  })

  it('requires the exact trusted Origin for every state-changing browser request', async () => {
    const admin = await adminBindings()
    expect(() => requireControlPanelOrigin(new Request('https://controlpanel-staging.vastbrowser.com/v1/admin/assets', {
      method: 'PUT', headers: { Origin: 'https://controlpanel-staging.vastbrowser.com' }
    }), admin.env)).not.toThrow()
    expect(() => requireControlPanelOrigin(new Request('https://controlpanel-staging.vastbrowser.com/v1/admin/assets', {
      method: 'PUT', headers: { Origin: 'https://evil.example' }
    }), admin.env)).toThrowError(expect.objectContaining({ status: 403 }))
  })
})

describe('Control Panel operations', () => {
  it('computes aggregate-only dashboard metrics without adding installation fields', async () => {
    const admin = await adminBindings()
    const now = Date.parse('2026-08-11T12:00:00.000Z')
    await admin.env.DB.batch([
      admin.env.DB.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?)').bind(
        '44f669d7-f42f-4050-b97c-33f6d74372b2', '0.1.4', now - 1_000, now - 1_000, 4
      ),
      admin.env.DB.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?)').bind(
        '30a49136-7144-4b65-8527-d671db03401a', '0.1.3', now - 40 * 86_400_000, now - 8 * 86_400_000, 8
      )
    ])
    const response = await dashboardSummary(admin.env, now)
    const result = await response.json<{ totals: Record<string, number>; versions: Array<{ version: string; count: number }> }>()
    expect(result.totals).toMatchObject({ installations: 2, active_24h: 1, active_7d: 1, active_30d: 2, new_24h: 1 })
    expect(result.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: '0.1.4', count: 1 }),
      expect.objectContaining({ version: '0.1.3', count: 1 })
    ]))
    expect(Object.keys(result.totals)).not.toContain('ip')
  })

  it('lists every installation through bounded keyset pages and strict filters', async () => {
    const admin = await adminBindings()
    const now = Date.parse('2026-08-11T12:00:00.000Z')
    await admin.env.DB.prepare('DELETE FROM installations').run()
    await admin.env.DB.batch([
      admin.env.DB.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?)').bind(
        '11111111-1111-4111-8111-111111111111', '0.1.4', now - 3_000, now - 1_000, 3
      ),
      admin.env.DB.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?)').bind(
        '22222222-2222-4222-8222-222222222222', '0.1.4', now - 9_000, now - 2_000, 2
      ),
      admin.env.DB.prepare('INSERT INTO installations VALUES (?, ?, ?, ?, ?)').bind(
        '33333333-3333-4333-8333-333333333333', '0.1.3', now - 40 * 86_400_000, now - 31 * 86_400_000, 9
      )
    ])

    const first = await listInstallations(new Request(
      'https://controlpanel.test/v1/admin/installations?limit=2&activity=all'
    ), admin.env, now)
    const firstPage = await first.json<{
      items: Array<Record<string, unknown>>
      total: number
      next_cursor: string | null
    }>()
    expect(firstPage.total).toBe(3)
    expect(firstPage.items.map((item) => item.install_id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ])
    expect(Object.keys(firstPage.items[0]).sort()).toEqual([
      'current_version', 'first_seen', 'install_id', 'last_seen', 'launch_count'
    ])
    expect(firstPage.next_cursor).toBeTypeOf('string')

    const second = await listInstallations(new Request(
      `https://controlpanel.test/v1/admin/installations?limit=2&activity=all&cursor=${firstPage.next_cursor}`
    ), admin.env, now)
    const secondPage = await second.json<{ items: Array<{ install_id: string }>; next_cursor: string | null }>()
    expect(secondPage.items.map((item) => item.install_id)).toEqual(['33333333-3333-4333-8333-333333333333'])
    expect(secondPage.next_cursor).toBeNull()

    const filtered = await listInstallations(new Request(
      'https://controlpanel.test/v1/admin/installations?activity=24h&version=0.1.4'
    ), admin.env, now)
    expect(await filtered.json()).toMatchObject({ total: 2 })

    await expect(listInstallations(new Request(
      'https://controlpanel.test/v1/admin/installations?unexpected=true'
    ), admin.env, now)).rejects.toMatchObject({ status: 400 })
  })

  it('generates immutable server-side asset IDs and records the verified Access actor', async () => {
    const admin = await adminBindings()
    const uploaded = await uploadGeneratedAsset(new Request('https://controlpanel.test/v1/admin/assets', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: onePixelPng
    }), admin.env, TEST_IDENTITY)
    const asset = await uploaded.json<{ id: string; sha256: string }>()
    expect(asset.id).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    const audit = await admin.env.DB.prepare('SELECT actor, summary_json FROM admin_audit WHERE entity_id = ?')
      .bind(asset.id).first<{ actor: string; summary_json: string }>()
    expect(audit?.actor).toBe(TEST_IDENTITY.actor)
    expect(audit?.summary_json).not.toContain('token')
  })

  it('freshly signs every edit and rejects a stale revision', async () => {
    const admin = await adminBindings()
    const id = '22e20c26-043f-4e17-9f37-41f455f9b5d8'
    const created = await createBroadcast(jsonRequest('https://controlpanel.test/v1/admin/broadcasts', announcement(id)), admin.env, TEST_IDENTITY)
    const first = await created.json<{ signature: string; revision: number }>()
    const updateRequest = jsonRequest('https://controlpanel.test/v1/admin/broadcasts/' + id, announcement(id, { title: 'Changed title' }), {
      method: 'PUT', headers: { 'If-Match': '"1"' }
    })
    const updated = await updateBroadcast(updateRequest, admin.env, TEST_IDENTITY, id)
    const second = await updated.json<{ signature: string; revision: number }>()
    expect(second.revision).toBe(2)
    expect(second.signature).not.toBe(first.signature)
    const stale = jsonRequest('https://controlpanel.test/v1/admin/broadcasts/' + id, announcement(id, { title: 'Stale edit' }), {
      method: 'PUT', headers: { 'If-Match': '"1"' }
    })
    await expect(updateBroadcast(stale, admin.env, TEST_IDENTITY, id)).rejects.toMatchObject({ status: 409 })
  })

  it('deletes only inactive broadcasts and preserves a safe audit record', async () => {
    const admin = await adminBindings()
    const id = '90e24d64-9009-4891-97f9-b7c55bbc38b3'
    const now = Date.parse('2026-08-11T12:00:00.000Z')
    await createBroadcast(jsonRequest('https://controlpanel.test/v1/admin/broadcasts', announcement(id)), admin.env, TEST_IDENTITY, now)
    const deletion = (revision: number) => new Request(`https://controlpanel.test/v1/admin/broadcasts/${id}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${revision}"` }
    })

    await expect(deleteBroadcast(deletion(1), admin.env, TEST_IDENTITY, id, now + 1))
      .rejects.toMatchObject({ status: 409 })

    await updateBroadcast(jsonRequest(
      `https://controlpanel.test/v1/admin/broadcasts/${id}`,
      announcement(id, { enabled: false }),
      { method: 'PUT', headers: { 'If-Match': '"1"' } }
    ), admin.env, TEST_IDENTITY, id, now + 2)
    const deleted = await deleteBroadcast(deletion(2), admin.env, TEST_IDENTITY, id, now + 3)
    expect(deleted.status).toBe(200)
    expect(await admin.env.DB.prepare('SELECT id FROM broadcasts WHERE id = ?').bind(id).first()).toBeNull()
    const audit = await admin.env.DB.prepare(`
      SELECT event_type, summary_json FROM admin_audit
      WHERE entity_id = ? AND event_type = 'broadcast_deleted'
    `).bind(id).first<{ event_type: string; summary_json: string }>()
    expect(audit?.event_type).toBe('broadcast_deleted')
    expect(JSON.parse(audit?.summary_json ?? '{}')).toMatchObject({ state: 'disabled', revision: 2 })
  })

  it('leaves a broadcast unpublished when the selected rotation secret is unavailable', async () => {
    const admin = await adminBindings()
    const before = await admin.env.DB.prepare('SELECT COUNT(*) AS count FROM broadcasts').first<{ count: number }>()
    const rotating = {
      ...admin.env,
      RELAY_KEY_ID: 'relay-staging-next',
      RELAY_NEXT_KEY_ID: 'relay-staging-next',
      RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64: undefined
    } as unknown as AdminEnv
    await expect(createBroadcast(
      jsonRequest('https://controlpanel.test/v1/admin/broadcasts', announcement()),
      rotating,
      TEST_IDENTITY
    )).rejects.toThrow('next-key secret is unavailable')
    const after = await admin.env.DB.prepare('SELECT COUNT(*) AS count FROM broadcasts').first<{ count: number }>()
    expect(after?.count).toBe(before?.count)
  })

  it('requires deliberate confirmation before publishing a critical update notice', async () => {
    const admin = await adminBindings()
    const body = {
      version: '9.1.0',
      release_url: 'https://releases.vastbrowser.com/v9.1.0',
      severity: 'critical',
      min_supported_version: '0.1.4',
      title: 'Critical update',
      notes: 'Use the existing trusted updater.',
      published_at: '2026-08-11T10:00:00.000Z',
      enabled: true
    }
    await expect(createRelease(jsonRequest('https://controlpanel.test/v1/admin/releases', body), admin.env, TEST_IDENTITY))
      .rejects.toMatchObject({ status: 409 })
    const confirmed = await createRelease(jsonRequest('https://controlpanel.test/v1/admin/releases', body, {
      headers: { 'X-Vast-Critical-Confirmation': 'PUBLISH CRITICAL' }
    }), admin.env, TEST_IDENTITY)
    expect(confirmed.status).toBe(201)
  })

  it('stops delivery immediately when the broadcast kill switch is used', async () => {
    const admin = await adminBindings()
    const id = '90bfdb82-1a42-469b-9ab7-e3623002c7b8'
    const now = Date.parse('2026-08-11T12:00:00.000Z')
    await createBroadcast(jsonRequest('https://controlpanel.test/v1/admin/broadcasts', announcement(id)), admin.env, TEST_IDENTITY, now)
    const checkin = (installId: string) => jsonRequest('https://relay.test/v1/checkin', {
      protocol: 1, install_id: installId, current_version: '0.1.4', launch_count: 1
    })
    const first = await handleCheckin(checkin('7f904b7e-a123-4b61-99c8-af286bb2123f'), publicBindings(), now)
    expect((await first.json<CheckinResponse>()).messages.some((message) => message.payload.id === id)).toBe(true)
    const disabled = announcement(id, { enabled: false })
    await updateBroadcast(jsonRequest('https://controlpanel.test/v1/admin/broadcasts/' + id, disabled, {
      method: 'PUT', headers: { 'If-Match': '"1"' }
    }), admin.env, TEST_IDENTITY, id, now + 1)
    const second = await handleCheckin(checkin('048aeac1-d4d1-4248-bca9-77062a2375ab'), publicBindings(), now + 2)
    expect((await second.json<CheckinResponse>()).messages.some((message) => message.payload.id === id)).toBe(false)
  })
})

describe('Control Panel safe local model', () => {
  it('formats valid dashboard timestamps without combining incompatible Intl options', () => {
    expect(() => formatDate('2026-08-11T12:00:00.000Z')).not.toThrow()
    expect(formatDate('not-a-date')).toBe('Invalid date')
  })

  it('duplicates into a disabled draft and expires without remote HTML', () => {
    const item = {
      key_id: 'relay-staging-2026-01',
      payload: {
        schema: 'vast-relay-broadcast-v1',
        key_id: 'relay-staging-2026-01',
        id: 'c89043ca-a3b7-4709-93ff-b67b8fd0e07c',
        type: 'announcement',
        title: '<script>text only</script>',
        body: 'Passive body',
        media: null,
        action: null,
        min_version: null,
        max_version: null,
        active_from: '2026-08-11T00:00:00.000Z',
        active_until: null,
        priority: 10,
        enabled: true,
        created_at: '2026-08-11T00:00:00.000Z'
      },
      signature: 'x',
      state: 'active',
      draft: false,
      revision: 1,
      updated_at: '2026-08-11T00:00:00.000Z'
    } satisfies BroadcastAdminItem
    const duplicate = duplicateBroadcastInput(item, new Date('2026-08-11T12:00:00.000Z'))
    expect(duplicate).toMatchObject({ draft: true, enabled: false })
    expect(duplicate).not.toHaveProperty('id')
    const expired = expireBroadcastInput(item, new Date('2026-08-11T12:00:00.000Z'))
    expect(Date.parse(expired.active_until ?? '')).toBe(Date.parse('2026-08-11T12:00:00.000Z'))
    expect(broadcastInputFrom(item).title).toContain('<script>')
  })
})
