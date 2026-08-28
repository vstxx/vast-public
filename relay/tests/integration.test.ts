import { describe, expect, it } from 'vitest'
import adminWorker from '../src/admin/index'
import { routeAuthenticatedAdminRequest } from '../src/admin/index'
import { createBroadcast } from '../src/admin/broadcasts'
import { createRelease } from '../src/admin/releases'
import { uploadAsset } from '../src/admin/assets'
import { handleCheckin } from '../src/public/checkin'
import publicWorker from '../src/public/index'
import { verifyCanonicalPayload } from '../src/shared/crypto'
import type { CheckinResponse, SignedEnvelope, BroadcastPayload, ReleasePayload } from '../src/shared/types'
import {
  adminBindings,
  jsonRequest,
  onePixelPng,
  publicBindings,
  TEST_IDENTITY
} from './helpers'

function checkinRequest(installId: string, launchCount: number, version = '0.1.4'): Request {
  return jsonRequest('https://relay.test/v1/checkin', {
    protocol: 1,
    install_id: installId,
    current_version: version,
    launch_count: launchCount,
    instance_kind: 'test'
  })
}

function broadcastBody(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'announcement',
    title: 'Relay test',
    body: 'A passive signed message.',
    media_id: null,
    action_label: null,
    action_url: null,
    min_version: null,
    max_version: null,
    active_from: '2026-08-10T11:00:00.000Z',
    active_until: '2026-08-10T13:00:00.000Z',
    priority: 10,
    enabled: true,
    ...overrides
  }
}

describe('installation check-ins', () => {
  it('creates an installation and preserves first_seen with monotonic launch_count', async () => {
    const id = 'b3d618c9-c5e8-41ba-8dd7-9bec44ec8c92'
    const firstNow = Date.parse('2026-08-10T10:00:00.000Z')
    const secondNow = firstNow + 60_000
    const first = await handleCheckin(checkinRequest(id, 12), publicBindings(), firstNow)
    expect(first.status).toBe(200)
    const firstBody = await first.json<CheckinResponse>()
    expect(firstBody).toMatchObject({ protocol: 1, server_time: '2026-08-10T10:00:00.000Z', messages: [], update: null })

    const second = await handleCheckin(checkinRequest(id, 4, '0.1.5'), publicBindings(), secondNow)
    expect(second.status).toBe(200)
    const row = await publicBindings().DB.prepare(`
      SELECT install_id, current_version, first_seen, last_seen, launch_count, instance_kind
      FROM installations WHERE install_id = ?
    `).bind(id).first<{
      install_id: string
      current_version: string
      first_seen: number
      last_seen: number
      launch_count: number
      instance_kind: string
    }>()
    expect(row).toEqual({
      install_id: id,
      current_version: '0.1.5',
      first_seen: firstNow,
      last_seen: secondNow,
      launch_count: 12,
      instance_kind: 'test'
    })
  })

  it('fails safely with an empty normal response when D1 is unavailable', async () => {
    const base = publicBindings()
    const failingDatabase = new Proxy(base.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') return () => { throw new Error('simulated D1 outage') }
        return Reflect.get(target, property, receiver)
      }
    })
    const response = await handleCheckin(
      checkinRequest('464e1af7-f787-44c8-b920-cc8005891990', 1),
      publicBindings({ DB: failingDatabase }),
      Date.parse('2026-08-10T10:00:00.000Z')
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-vast-relay-degraded')).toBe('database')
    expect(await response.json()).toMatchObject({ protocol: 1, messages: [], update: null })
  })

  it('returns 429 before parsing or database work when the source limiter denies', async () => {
    const deny: RateLimit = { async limit() { return { success: false } } }
    const response = await handleCheckin(
      checkinRequest('92559942-a8d4-466d-a893-fe08af8a768d', 1),
      publicBindings({ CHECKIN_SOURCE_RATE_LIMIT: deny })
    )
    expect(response.status).toBe(429)
  })
})

describe('admin, signed delivery and controlled R2 assets', () => {
  it('requires admin authentication on every control-plane route', async () => {
    const admin = await adminBindings()
    const unauthenticated = await adminWorker.fetch(new Request('https://admin.test/v1/admin/broadcasts'), admin.env)
    expect(unauthenticated.status).toBe(401)
    const authenticated = await routeAuthenticatedAdminRequest(
      new Request('https://controlpanel-staging.vastbrowser.com/health'),
      admin.env,
      TEST_IDENTITY
    )
    expect(authenticated.status).toBe(200)
  })

  it('validates, stores and serves an immutable image without exposing R2', async () => {
    const admin = await adminBindings()
    const now = Date.parse('2026-08-10T10:30:00.000Z')
    const uploaded = await uploadAsset(new Request('https://admin.test/v1/admin/assets/relay-test.png', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(onePixelPng.byteLength) },
      body: onePixelPng
    }), admin.env, TEST_IDENTITY, 'relay-test.png', now)
    expect(uploaded.status).toBe(201)
    const metadata = await uploaded.json<{ sha256: string; size: number }>()
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(metadata.size).toBe(onePixelPng.byteLength)

    const fetched = await publicWorker.fetch(new Request('https://relay.test/v1/assets/relay-test.png', {
      headers: { 'CF-Connecting-IP': '192.0.2.20' }
    }), publicBindings())
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(onePixelPng)

    const traversal = await publicWorker.fetch(new Request('https://relay.test/v1/assets/%2e%2e%2fsecret.png'), publicBindings())
    expect(traversal.status).toBe(400)
    await expect(uploadAsset(new Request('https://admin.test/v1/admin/assets/payload.exe', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([0x4d, 0x5a])
    }), admin.env, TEST_IDENTITY, 'payload.exe')).rejects.toMatchObject({ status: 400 })
    await expect(uploadAsset(new Request('https://admin.test/v1/admin/assets/confused.png', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new TextEncoder().encode('not a PNG')
    }), admin.env, TEST_IDENTITY, 'confused.png')).rejects.toMatchObject({ status: 415 })
  })

  it('filters disabled, future, expired and version-incompatible broadcasts', async () => {
    const admin = await adminBindings()
    const now = Date.parse('2026-08-10T12:00:00.000Z')
    const asset = await uploadAsset(new Request('https://admin.test/v1/admin/assets/filter-test.png', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: onePixelPng
    }), admin.env, TEST_IDENTITY, 'filter-test.png', now - 100)
    expect(asset.status).toBe(201)
    const cases = [
      broadcastBody('57da05e2-f9e4-4ea1-a505-1c167c430172', { media_id: 'filter-test.png', type: 'seasonal' }),
      broadcastBody('4ac25652-00e2-4ccf-8609-b749855a0daa', { enabled: false }),
      broadcastBody('3b3dacb8-ca50-4822-a6ab-c0fb8352e243', { active_from: '2026-08-10T13:00:00.000Z', active_until: null }),
      broadcastBody('0df4addc-af2e-4461-a777-1749196ef712', { active_from: '2026-08-10T09:00:00.000Z', active_until: '2026-08-10T11:00:00.000Z' }),
      broadcastBody('91e259c4-d78d-466b-980c-bd2d46f2a4cb', { min_version: '9.0.0' }),
      broadcastBody('8a37a4b2-2680-4167-9dfc-b2894ac99c1b', { max_version: '0.1.0' })
    ]
    for (const [index, body] of cases.entries()) {
      const response = await createBroadcast(
        jsonRequest('https://admin.test/v1/admin/broadcasts', body),
        admin.env,
        TEST_IDENTITY,
        now - index
      )
      expect(response.status).toBe(201)
    }

    const checkin = await handleCheckin(
      checkinRequest('7bef0e4e-83f3-429c-85d7-9b548e33923d', 10),
      publicBindings(),
      now
    )
    const result = await checkin.json<CheckinResponse>()
    expect(result.messages).toHaveLength(1)
    const message = result.messages[0] as SignedEnvelope<BroadcastPayload>
    expect(message.payload.id).toBe('57da05e2-f9e4-4ea1-a505-1c167c430172')
    expect(message.payload.media).toMatchObject({ id: 'filter-test.png', mime: 'image/png' })
    expect(await verifyCanonicalPayload(message.payload, message.signature, admin.publicKeyBase64)).toBe(true)
  })

  it('returns only the highest newer signed release notice without authorizing an updater package', async () => {
    const admin = await adminBindings()
    const now = Date.parse('2026-08-10T12:00:00.000Z')
    const created = await createRelease(jsonRequest('https://admin.test/v1/admin/releases', {
      version: '9.0.0',
      release_url: 'https://releases.vastbrowser.com/v9.0.0',
      severity: 'critical',
      min_supported_version: '0.1.0',
      title: 'Security update available',
      notes: 'Use the existing trusted Vast updater to install this release.',
      published_at: '2026-08-10T11:00:00.000Z',
      enabled: true
    }, { headers: { 'X-Vast-Critical-Confirmation': 'PUBLISH CRITICAL' } }), admin.env, TEST_IDENTITY, now)
    expect(created.status).toBe(201)

    const checkin = await handleCheckin(
      checkinRequest('5e68fab5-cd61-4962-98aa-2f983045263b', 3),
      publicBindings(),
      now
    )
    const result = await checkin.json<CheckinResponse>()
    const update = result.update as SignedEnvelope<ReleasePayload>
    expect(update.payload).toMatchObject({ version: '9.0.0', severity: 'critical' })
    expect(await verifyCanonicalPayload(update.payload, update.signature, admin.publicKeyBase64)).toBe(true)
    expect(Object.keys(update.payload)).not.toContain('package')
    expect(Object.keys(update.payload)).not.toContain('execute')
  })
})
