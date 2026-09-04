import { envFlag, normalizeReleaseChannel } from './build-metadata.ts'
import type { RelayBuildConfig, RelayEnvironment, RelayTrustKey } from './relay-types.ts'

declare const __VAST_RELAY_CONFIG__: RelayBuildConfig | undefined

export const RELAY_ENDPOINTS: Readonly<Record<RelayEnvironment, string>> = Object.freeze({
  staging: 'https://relay-staging.vastbrowser.com',
  production: 'https://relay.vastbrowser.com'
})

export const RELAY_TRUST_KEYS: Readonly<Record<RelayEnvironment, readonly RelayTrustKey[]>> = Object.freeze({
  staging: Object.freeze([{
    keyId: 'relay-staging-2026-01',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAUdjyVaeSUezix+E2jaSJzfoLaVU3x/HH3iXsUyv433k='
  }]),
  production: Object.freeze([{
    keyId: 'relay-2026-01',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAK2ESqwYH5ULmvRoNMGU7SwFF2pnk7yegAyxKUwhplI0='
  }])
})

export function relayBuildConfigFromEnv(env: Record<string, string | undefined>): RelayBuildConfig {
  const channel = normalizeReleaseChannel(env.VAST_RELEASE_CHANNEL)
  const requestedEnvironment = String(env.VAST_RELAY_ENVIRONMENT ?? '').trim().toLowerCase()
  const environment: RelayEnvironment = requestedEnvironment === 'staging' || requestedEnvironment === 'production'
    ? requestedEnvironment
    : (channel === 'beta' || channel === 'stable' ? 'production' : 'staging')
  const enabled = envFlag(env, 'VAST_RELAY_ENABLED', true)
  return {
    enabled,
    environment,
    endpoint: RELAY_ENDPOINTS[environment],
    keys: RELAY_TRUST_KEYS[environment].map((key) => ({ ...key }))
  }
}

export function getRelayBuildConfig(): RelayBuildConfig {
  try {
    if (typeof __VAST_RELAY_CONFIG__ === 'object' && __VAST_RELAY_CONFIG__) {
      return {
        ...__VAST_RELAY_CONFIG__,
        keys: __VAST_RELAY_CONFIG__.keys.map((key) => ({ ...key }))
      }
    }
  } catch {
    // Unbundled callers deliberately have no active Relay endpoint. Keep the
    // development/staging trust root out of public bundles unless the build
    // explicitly embeds a staging configuration for internal QA.
  }
  return {
    enabled: false,
    environment: 'staging',
    endpoint: '',
    keys: []
  }
}
