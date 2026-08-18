import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalizeRelayPayload, verifyRelayEnvelope } from '../../src/main/relay/crypto.ts'
import { relayBroadcastFixture, relayFixtureKeys } from './relay-fixtures.ts'

test('Relay canonicalization is deterministic and matches Phase 1 key sorting rules', () => {
  assert.equal(canonicalizeRelayPayload({ z: 2, nested: { b: true, a: null }, a: 'x' }), '{"a":"x","nested":{"a":null,"b":true},"z":2}')
  assert.throws(() => canonicalizeRelayPayload({ value: 1.5 }), /safe integers/)
  assert.throws(() => canonicalizeRelayPayload({ value: undefined }), /undefined/)
})

test('Relay verifies an Ed25519 envelope and rejects all meaningful tampering cases', () => {
  const keys = relayFixtureKeys()
  const payload = relayBroadcastFixture()
  const envelope = keys.signPayload(payload)
  assert.equal(verifyRelayEnvelope(envelope, [keys.trust]), true)

  const tampered = [
    { ...payload, title: 'Changed title' },
    { ...payload, body: 'Changed body' },
    { ...payload, active_until: '2026-08-13T10:00:00.000Z' },
    { ...payload, media: payload.media && { ...payload.media, id: 'other.webp' } },
    { ...payload, media: payload.media && { ...payload.media, sha256: 'b'.repeat(64) } }
  ]
  for (const changed of tampered) assert.equal(verifyRelayEnvelope({ ...envelope, payload: changed }, [keys.trust]), false)

  const wrongKeys = relayFixtureKeys('relay-test-2')
  assert.equal(verifyRelayEnvelope(envelope, [wrongKeys.trust]), false)
  assert.equal(verifyRelayEnvelope({ ...envelope, key_id: 'unknown' }, [keys.trust]), false)
  assert.equal(verifyRelayEnvelope({ ...envelope, signature: 'not-base64' }, [keys.trust]), false)
})

