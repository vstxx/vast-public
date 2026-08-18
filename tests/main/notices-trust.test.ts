import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { verifySignedNoticesFeed } from '../../src/main/notices-feed.ts'
import { validateNoticesTrustConfig } from '../../src/shared/notices-trust.ts'

function signedFixture(extraNotice: Record<string, unknown> = {}): {
  raw: string
  trust: ReturnType<typeof validateNoticesTrustConfig>
  payload: Buffer
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const trust = validateNoticesTrustConfig({
    enabled: true,
    feedUrl: 'https://notices.vast.example/v1/notices.json',
    keyId: 'vast-notices-test-1',
    publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  })
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-08-03T10:00:00.000Z',
    expiresAt: '2026-08-10T10:00:00.000Z',
    notices: [{
      id: 'security-1',
      title: 'Security maintenance',
      message: 'Restart Vast when convenient.',
      severity: 'security',
      publishedAt: '2026-08-03T10:00:00.000Z',
      ...extraNotice
    }]
  }))
  return {
    trust,
    payload,
    raw: JSON.stringify({
      schemaVersion: 1,
      keyId: trust.keyId,
      payload: payload.toString('base64'),
      signature: sign(null, payload, privateKey).toString('base64')
    })
  }
}

test('Vast Notices accepts only a pinned HTTPS trust origin separate from updater infrastructure', () => {
  assert.throws(() => validateNoticesTrustConfig({
    enabled: true,
    feedUrl: 'https://github.com/vstxx/vast-public/notices.json',
    keyId: 'key-1',
    publicKeySpkiBase64: 'A'.repeat(64)
  }), /must not share the updater trust origin/)
  assert.throws(() => validateNoticesTrustConfig({
    enabled: true,
    feedUrl: 'https://notices.vast.example/notices.json?update=https://evil.example',
    keyId: 'key-1',
    publicKeySpkiBase64: 'A'.repeat(64)
  }), /one pinned HTTPS JSON endpoint/)
})

test('signed passive JSON notices verify with Ed25519 and expose text-only fields', () => {
  const fixture = signedFixture()
  const result = verifySignedNoticesFeed(fixture.raw, fixture.trust, Date.parse('2026-08-03T12:00:00.000Z'))
  assert.equal(result.enabled, true)
  assert.deepEqual(result.notices, [{
    id: 'security-1',
    title: 'Security maintenance',
    message: 'Restart Vast when convenient.',
    severity: 'security',
    publishedAt: '2026-08-03T10:00:00.000Z',
    expiresAt: undefined
  }])
})

test('Notices rejects tampering and every active-content or configuration field', () => {
  const fixture = signedFixture()
  const envelope = JSON.parse(fixture.raw) as Record<string, unknown>
  const tamperedPayload = Buffer.from(fixture.payload)
  tamperedPayload[20] ^= 1
  envelope.payload = tamperedPayload.toString('base64')
  assert.throws(() => verifySignedNoticesFeed(JSON.stringify(envelope), fixture.trust, Date.parse('2026-08-03T12:00:00.000Z')), /signature verification failed/)

  for (const forbidden of ['html', 'script', 'command', 'settings', 'labs', 'updateEndpoint']) {
    const active = signedFixture({ [forbidden]: 'forbidden' })
    assert.throws(() => verifySignedNoticesFeed(active.raw, active.trust, Date.parse('2026-08-03T12:00:00.000Z')), /forbidden fields/)
  }
})

test('Notices rejects non-Ed25519 keys and ambiguous timestamps', () => {
  const fixture = signedFixture()
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrongTrust = {
    ...fixture.trust,
    publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }
  assert.throws(() => verifySignedNoticesFeed(fixture.raw, wrongTrust, Date.parse('2026-08-03T12:00:00.000Z')), /Ed25519 public key/)

  const ambiguous = signedFixture({ publishedAt: '2026-08-03 10:00:00' })
  assert.throws(() => verifySignedNoticesFeed(ambiguous.raw, ambiguous.trust, Date.parse('2026-08-03T12:00:00.000Z')), /UTC ISO timestamp/)
})
