import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRelayInstallId,
  parseRelayBroadcastPayload,
  parseRelayReleasePayload,
  parseRelayResponse,
  relayBroadcastIsActive,
  relayReleaseIsEligible,
  strictSemVer
} from '../../src/main/relay/protocol.ts'
import { relayBroadcastFixture, relayFixtureKeys, relayReleaseFixture, RELAY_FIXTURE_NOW } from './relay-fixtures.ts'

test('Relay validates UUIDv4 and strict SemVer including Vast prereleases', () => {
  assert.equal(isRelayInstallId('8539ffee-e9f0-4d57-8121-7b1c55fcefe0'), true)
  assert.equal(isRelayInstallId('8539ffee-e9f0-1d57-8121-7b1c55fcefe0'), false)
  assert.equal(strictSemVer('0.1.4'), '0.1.4')
  assert.equal(strictSemVer('1.2.3-rc.1+build.7'), '1.2.3-rc.1+build.7')
  for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3.4']) assert.throws(() => strictSemVer(invalid), /SemVer/)
})

test('Relay response parsing is strict at the protocol boundary and fail-soft per message', () => {
  const keys = relayFixtureKeys()
  const valid = keys.signPayload(relayBroadcastFixture())
  const malformed = { ...valid, payload: { ...valid.payload, type: 'custom_html' } }
  const parsed = parseRelayResponse({
    protocol: 1,
    server_time: '2026-08-11T12:00:00.000Z',
    messages: [malformed, valid],
    update: keys.signPayload(relayReleaseFixture())
  })
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0]?.payload.type, 'seasonal')
  assert.equal(parsed.update?.payload.severity, 'recommended')

  const malformedUpdate = parseRelayResponse({
    protocol: 1,
    server_time: '2026-08-11T12:00:00.000Z',
    messages: [],
    update: { ...keys.signPayload(relayReleaseFixture()), signature: 'invalid-base64' }
  })
  assert.equal(malformedUpdate.update, null)

  assert.throws(() => parseRelayResponse({ protocol: 2, server_time: '2026-08-11T12:00:00.000Z', messages: [], update: null }), /protocol/)
  assert.throws(() => parseRelayResponse({ protocol: 1, server_time: 'not-a-date', messages: [], update: null }), /timestamp/)
  assert.throws(() => parseRelayResponse({ protocol: 1, server_time: '2026-08-11T12:00:00Z', messages: [], update: null }), /timestamp/)
  assert.throws(() => parseRelayResponse({ protocol: 1, server_time: '2026-08-11T12:00:00.000Z', messages: [], update: null, extra: true }), /unexpected/)
  assert.throws(() => parseRelayResponse(JSON.parse('{"protocol":1,"server_time":"2026-08-11T12:00:00.000Z","messages":[],"update":null,"__proto__":{"polluted":true}}')), /unexpected/)
})

test('Relay rejects dangerous content, invalid media, URLs, ranges, and update severities', () => {
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ type: 'custom_html' as never })), /unsupported/)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ title: '<script>' })), /passive/)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ action: { label: 'Open', url: 'javascript:alert(1)' } })), /HTTPS/)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ media: { id: '../x.png', mime: 'image/png', sha256: 'a'.repeat(64) } })), /asset id/)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ media: { id: 'x.svg', mime: 'image/png', sha256: 'a'.repeat(64) } })), /asset id/)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ min_version: '2.0.0', max_version: '1.0.0' })), /range/)
  assert.throws(() => parseRelayReleasePayload(relayReleaseFixture({ severity: 'urgent' as never })), /unsupported/)
  assert.throws(() => parseRelayReleasePayload(relayReleaseFixture({ release_url: 'http://vastbrowser.com/release' })), /HTTPS/)
})

test('Relay accepts bounded rich-text notation only in the signed body', () => {
  const body = '# Changes\n\n> Important\n\n**Fast** and <b>inert</b>'
  assert.equal(parseRelayBroadcastPayload(relayBroadcastFixture({ body })).body, body)
  assert.throws(() => parseRelayBroadcastPayload(relayBroadcastFixture({ title: '<b>Title</b>' })), /passive/)
})

test('Relay activation, expiry, version and update eligibility filtering is deterministic', () => {
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture(), '0.1.4', RELAY_FIXTURE_NOW), true)
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture({ enabled: false }), '0.1.4', RELAY_FIXTURE_NOW), false)
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture({ active_from: '2026-08-12T12:00:00.000Z' }), '0.1.4', RELAY_FIXTURE_NOW), false)
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture({ active_until: '2026-08-11T12:00:00.000Z' }), '0.1.4', RELAY_FIXTURE_NOW), false)
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture({ min_version: '0.2.0' }), '0.1.4', RELAY_FIXTURE_NOW), false)
  assert.equal(relayBroadcastIsActive(relayBroadcastFixture({ max_version: '0.1.3' }), '0.1.4', RELAY_FIXTURE_NOW), false)
  assert.equal(relayReleaseIsEligible(relayReleaseFixture(), '0.1.4', RELAY_FIXTURE_NOW), true)
  assert.equal(relayReleaseIsEligible(relayReleaseFixture({ version: '0.1.4' }), '0.1.4', RELAY_FIXTURE_NOW), false)
})
