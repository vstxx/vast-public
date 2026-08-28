import type { VextTrustedKey } from '../../shared/vext-format.ts'

// Distribution trust roots are compiled into Vast. Their private counterparts
// must exist only in the Hub deployment secret store and are never fetched at
// runtime. A future rotation key must be added through an audited app update
// before the Hub starts signing with it.
export const TRUSTED_VAST_HUB_KEYS: readonly VextTrustedKey[] = Object.freeze([
  {
    keyId: 'vast-hub-2026-01',
    algorithm: 'Ed25519',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEA+xrms7nOgaZTSFZAV4ovE+XqOAzfZkkyi0qSsS4nW8w=',
    status: 'current'
  }
])
