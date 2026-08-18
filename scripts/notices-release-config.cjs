const trustDomains = require('../src/shared/trust-domains.json')

function flag(env, name, fallback = false) {
  const value = String(env[name] ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

function readNoticesReleaseConfig(env = process.env) {
  const enabled = flag(env, 'VAST_NOTICES_ENABLED', false)
  if (!enabled) return { enabled: false, feedUrl: '', feedOrigin: '', keyId: '', publicKeySpkiBase64: '' }

  const feedUrl = String(env.VAST_NOTICES_FEED_URL ?? '').trim()
  const keyId = String(env.VAST_NOTICES_KEY_ID ?? '').trim()
  const publicKeySpkiBase64 = String(env.VAST_NOTICES_PUBLIC_KEY_SPKI_BASE64 ?? '').trim()
  let parsed
  try {
    parsed = new URL(feedUrl)
  } catch {
    throw new Error('VAST_NOTICES_FEED_URL must be a valid URL.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VAST_NOTICES_FEED_URL must be one exact HTTPS endpoint without credentials, query, or fragment.')
  }
  if (trustDomains.updaterOrigins.includes(parsed.origin)) {
    throw new Error('Vast Notices must use a trust origin separate from the updater.')
  }
  if (!/^[-a-zA-Z0-9_.]{1,80}$/.test(keyId)) throw new Error('VAST_NOTICES_KEY_ID is invalid.')
  if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(publicKeySpkiBase64) || publicKeySpkiBase64.length > 2048) {
    throw new Error('VAST_NOTICES_PUBLIC_KEY_SPKI_BASE64 must be a pinned DER SPKI public key.')
  }

  return {
    enabled: true,
    feedUrl: parsed.href,
    feedOrigin: parsed.origin,
    keyId,
    publicKeySpkiBase64
  }
}

module.exports = { readNoticesReleaseConfig }
