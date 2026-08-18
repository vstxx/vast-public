import assert from 'node:assert/strict'
import test from 'node:test'
import {
  relayHttpFailureIsTransient,
  relayPeriodicDelay,
  relayRetryAfterDelay,
  relayRetryDelay
} from '../../src/main/relay/retry.ts'

test('Relay periodic checks stay in the 5.5 to 6.5 hour window', () => {
  assert.equal(relayPeriodicDelay(0), 5.5 * 60 * 60 * 1_000)
  assert.ok(relayPeriodicDelay(0.999999) <= 6.5 * 60 * 60 * 1_000)
})

test('Relay retry policy is capped, jittered, and classifies HTTP failures conservatively', () => {
  assert.equal(relayRetryDelay(0, 0), 48_000)
  assert.equal(relayRetryDelay(1, 0.5), 300_000)
  assert.ok((relayRetryDelay(2, 0.999999) ?? 0) <= 1_440_000)
  assert.equal(relayRetryDelay(3, 0.5), null)
  assert.equal(relayHttpFailureIsTransient(429), false)
  assert.equal(relayHttpFailureIsTransient(500), true)
  assert.equal(relayHttpFailureIsTransient(400), false)
})

test('Relay honors Retry-After within a safe five-minute to six-hour clamp', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z')
  assert.equal(relayRetryAfterDelay('30', now), 5 * 60_000)
  assert.equal(relayRetryAfterDelay('600', now), 10 * 60_000)
  assert.equal(relayRetryAfterDelay('99999999', now), 6 * 60 * 60_000)
  assert.equal(relayRetryAfterDelay('Tue, 11 Aug 2026 13:00:00 GMT', now), 60 * 60_000)
  assert.equal(relayRetryAfterDelay('invalid', now), 5 * 60_000)
})
