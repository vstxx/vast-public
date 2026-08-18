import assert from 'node:assert/strict'
import test from 'node:test'
import { relayBuildConfigFromEnv, RELAY_ENDPOINTS, RELAY_TRUST_KEYS } from '../../src/shared/relay-config.ts'

test('Relay uses staging for development and keeps stable production disabled by default', () => {
  const development = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'dev' })
  assert.equal(development.enabled, true)
  assert.equal(development.endpoint, RELAY_ENDPOINTS.staging)
  assert.equal(development.keys[0]?.keyId, 'relay-staging-2026-01')

  const stable = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'stable' })
  assert.equal(stable.enabled, false)
  assert.equal(stable.endpoint, RELAY_ENDPOINTS.production)
  assert.deepEqual(stable.keys, RELAY_TRUST_KEYS.production)

  const releaseCandidate = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'stable', VAST_RELAY_PRODUCTION_ENABLED: '1' })
  assert.equal(releaseCandidate.enabled, true)
  assert.equal(releaseCandidate.endpoint, 'https://relay.vastbrowser.com')
})

test('Relay endpoints and trust keys cannot be replaced by runtime environment input', () => {
  const config = relayBuildConfigFromEnv({
    VAST_RELEASE_CHANNEL: 'dev',
    VAST_RELAY_ENDPOINT: 'https://attacker.invalid',
    VAST_RELAY_PUBLIC_KEY: 'attacker'
  })
  assert.equal(config.endpoint, 'https://relay-staging.vastbrowser.com')
  assert.equal(config.keys[0]?.publicKeySpkiBase64, 'MCowBQYDK2VwAyEAUdjyVaeSUezix+E2jaSJzfoLaVU3x/HH3iXsUyv433k=')
})

