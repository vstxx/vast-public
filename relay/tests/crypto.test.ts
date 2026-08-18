import { describe, expect, it } from 'vitest'
import { createBroadcastPayload } from '../src/shared/broadcasts'
import { signCanonicalPayload, verifyCanonicalPayload } from '../src/shared/crypto'
import type { AssetRow, BroadcastInput } from '../src/shared/types'
import { generateTestSigningKey } from './helpers'

const input: BroadcastInput = {
  type: 'seasonal',
  title: 'Summer at Vast',
  body: 'A small seasonal hello.',
  media_id: 'summer.webp',
  action_label: 'Learn more',
  action_url: 'https://vastbrowser.com/summer',
  min_version: '0.1.0',
  max_version: '2.0.0',
  active_from: '2026-08-10T10:00:00.000Z',
  active_until: '2026-08-11T10:00:00.000Z',
  priority: 10,
  enabled: true
}

const asset: AssetRow = {
  id: 'summer.webp',
  object_key: 'assets/v1/summer.webp',
  mime_type: 'image/webp',
  size: 100,
  sha256: 'a'.repeat(64),
  created_at: Date.parse('2026-08-10T09:00:00.000Z')
}

describe('Ed25519 canonical broadcast signing', () => {
  it('verifies the exact payload and fails every meaningful tampering case', async () => {
    const keys = await generateTestSigningKey()
    const payload = createBroadcastPayload(
      input,
      '15c24f93-dca9-41a9-af99-f0bc91d5e943',
      'relay-test-1',
      Date.parse('2026-08-10T09:30:00.000Z'),
      asset
    )
    const signature = await signCanonicalPayload(payload, keys.privateKeyBase64)
    expect(await verifyCanonicalPayload(payload, signature, keys.publicKeyBase64)).toBe(true)

    const tampered = [
      { ...payload, title: 'Changed title' },
      { ...payload, body: 'Changed body' },
      { ...payload, active_until: '2026-08-12T10:00:00.000Z' },
      { ...payload, media: payload.media ? { ...payload.media, id: 'other.webp' } : null },
      { ...payload, media: payload.media ? { ...payload.media, sha256: 'b'.repeat(64) } : null }
    ]
    for (const changed of tampered) {
      expect(await verifyCanonicalPayload(changed, signature, keys.publicKeyBase64)).toBe(false)
    }

    const wrongKey = await generateTestSigningKey()
    expect(await verifyCanonicalPayload(payload, signature, wrongKey.publicKeyBase64)).toBe(false)
    expect(await verifyCanonicalPayload(payload, 'not-base64', keys.publicKeyBase64)).toBe(false)
  })
})
