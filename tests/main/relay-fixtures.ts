import { generateKeyPairSync, sign } from 'node:crypto'
import type {
  RelayBroadcastPayload,
  RelayReleasePayload,
  RelaySignedEnvelope,
  RelayTrustKey
} from '../../src/shared/relay-types.ts'
import { canonicalizeRelayPayload } from '../../src/main/relay/crypto.ts'

export const RELAY_FIXTURE_NOW = Date.parse('2026-08-11T12:00:00.000Z')

export function relayFixtureKeys(keyId = 'relay-test-1'): {
  keyId: string
  trust: RelayTrustKey
  signPayload: <T extends object>(payload: T) => RelaySignedEnvelope<T>
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return {
    keyId,
    trust: { keyId, publicKeySpkiBase64 },
    signPayload: <T extends object>(payload: T): RelaySignedEnvelope<T> => ({
      key_id: keyId,
      payload,
      signature: sign(null, Buffer.from(canonicalizeRelayPayload(payload), 'utf8'), privateKey).toString('base64')
    })
  }
}

export function relayBroadcastFixture(overrides: Partial<RelayBroadcastPayload> = {}): RelayBroadcastPayload {
  return {
    schema: 'vast-relay-broadcast-v1',
    key_id: 'relay-test-1',
    id: '15c24f93-dca9-41a9-af99-f0bc91d5e943',
    type: 'seasonal',
    title: 'Summer at Vast',
    body: 'A small seasonal hello.',
    media: {
      id: 'summer.webp',
      sha256: 'a'.repeat(64),
      mime: 'image/webp'
    },
    action: { label: 'Learn more', url: 'https://vastbrowser.com/summer' },
    min_version: '0.1.0',
    max_version: '2.0.0',
    active_from: '2026-08-11T10:00:00.000Z',
    active_until: '2026-08-12T10:00:00.000Z',
    priority: 10,
    enabled: true,
    created_at: '2026-08-11T09:30:00.000Z',
    ...overrides
  }
}

export function relayReleaseFixture(overrides: Partial<RelayReleasePayload> = {}): RelayReleasePayload {
  return {
    schema: 'vast-relay-release-v1',
    key_id: 'relay-test-1',
    version: '0.2.0',
    release_url: 'https://github.com/vstxx/vast-public/releases/tag/v0.2.0',
    severity: 'recommended',
    min_supported_version: null,
    title: 'Vast 0.2.0 is available',
    notes: 'A signed update is ready through the normal Vast updater.',
    published_at: '2026-08-11T10:00:00.000Z',
    enabled: true,
    ...overrides
  }
}

