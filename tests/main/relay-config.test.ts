import assert from 'node:assert/strict'
import test from 'node:test'
import { getRelayBuildConfig, relayBuildConfigFromEnv, RELAY_ENDPOINTS, RELAY_TRUST_KEYS } from '../../src/shared/relay-config.ts'

test('Relay environment is independent from release channel and public channels default to production', () => {
  const development = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'dev' })
  assert.equal(development.enabled, true)
  assert.equal(development.endpoint, RELAY_ENDPOINTS.staging)
  assert.equal(development.keys[0]?.keyId, 'relay-staging-2026-01')

  const stable = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'stable' })
  assert.equal(stable.enabled, true)
  assert.equal(stable.endpoint, RELAY_ENDPOINTS.production)
  assert.deepEqual(stable.keys, RELAY_TRUST_KEYS.production)

  const beta = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'beta' })
  assert.equal(beta.endpoint, RELAY_ENDPOINTS.production)
  const internalQa = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'dev', VAST_RELAY_ENVIRONMENT: 'production' })
  assert.equal(internalQa.endpoint, RELAY_ENDPOINTS.production)
  const explicitlyDisabled = relayBuildConfigFromEnv({ VAST_RELEASE_CHANNEL: 'stable', VAST_RELAY_ENABLED: '0' })
  assert.equal(explicitlyDisabled.enabled, false)
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

test('unbundled Relay fallback is disabled and carries no staging endpoint or trust key', () => {
  assert.deepEqual(getRelayBuildConfig(), {
    enabled: false,
    environment: 'staging',
    endpoint: '',
    keys: []
  })
})
