import type { VextTrustedKey } from '../../shared/vext-format.ts'

// Distribution trust roots are compiled into Vast. Their private counterparts
// must exist only in the Hub deployment secret store and are never fetched at
// runtime. Rotation keys must be added through an audited app update before the
// Hub starts signing with them. Legacy keys remain trusted only while published
// immutable releases still reference them.
export const TRUSTED_VAST_HUB_KEYS: readonly VextTrustedKey[] = Object.freeze([
  {
    keyId: 'vast-hub-2026-01',
    algorithm: 'Ed25519',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEA+xrms7nOgaZTSFZAV4ovE+XqOAzfZkkyi0qSsS4nW8w=',
    status: 'legacy'
  },
  {
    keyId: 'vast-hub-2026-02',
    algorithm: 'Ed25519',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEARQSXwiILDJqeptIi6CSbhVmz4do94uXNcpr9Sjyd5YY=',
    status: 'current'
  }
])
