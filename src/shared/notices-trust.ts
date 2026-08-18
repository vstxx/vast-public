import type { VastNoticesTrustConfig } from './types'
import trustDomains from './trust-domains.json' with { type: 'json' }

declare const __VAST_NOTICES_TRUST__: Partial<VastNoticesTrustConfig> | undefined

export const UPDATER_TRUST_ORIGINS = Object.freeze([...trustDomains.updaterOrigins])

function embeddedTrust(): Partial<VastNoticesTrustConfig> {
  try {
    return typeof __VAST_NOTICES_TRUST__ === 'object' && __VAST_NOTICES_TRUST__ ? __VAST_NOTICES_TRUST__ : {}
  } catch {
    return {}
  }
}

export function validateNoticesTrustConfig(input: Partial<VastNoticesTrustConfig>): VastNoticesTrustConfig {
  const enabled = input.enabled === true
  const feedUrl = typeof input.feedUrl === 'string' ? input.feedUrl.trim() : ''
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim() : ''
  const publicKeySpkiBase64 = typeof input.publicKeySpkiBase64 === 'string' ? input.publicKeySpkiBase64.trim() : ''
  if (!enabled) return { enabled: false, feedUrl: '', keyId: '', publicKeySpkiBase64: '' }

  let parsed: URL
  try {
    parsed = new URL(feedUrl)
  } catch {
    throw new Error('Vast Notices feed URL is invalid.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Vast Notices requires one pinned HTTPS JSON endpoint without credentials, query, or fragment.')
  }
  if (UPDATER_TRUST_ORIGINS.includes(parsed.origin)) {
    throw new Error('Vast Notices must not share the updater trust origin.')
  }
  if (!/^[-a-zA-Z0-9_.]{1,80}$/.test(keyId)) throw new Error('Vast Notices key id is invalid.')
  if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(publicKeySpkiBase64) || publicKeySpkiBase64.length > 2_048) {
    throw new Error('Vast Notices requires a pinned DER SPKI public key.')
  }
  return { enabled: true, feedUrl: parsed.href, keyId, publicKeySpkiBase64 }
}

export function getNoticesTrustConfig(): VastNoticesTrustConfig {
  return validateNoticesTrustConfig(embeddedTrust())
}
