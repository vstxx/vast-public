const configured = String(process.env.HUB_STAGING_ORIGIN ?? '').trim()
if (!configured) throw new Error('BLOCKED: HUB_STAGING_ORIGIN is not configured.')
const origin = new URL(configured)
if (origin.protocol !== 'https:' || origin.hostname === 'extensions.vastbrowser.com' || origin.username || origin.password || origin.hash || origin.pathname !== '/') {
  throw new Error('BLOCKED: the staging origin must be a dedicated HTTPS origin and must not be production.')
}

const required = Object.freeze({
  'strict-transport-security': 'max-age=',
  'content-security-policy': "default-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=()',
  'x-frame-options': 'DENY'
})

for (const path of ['/v1/catalog', '/legal/privacy', '/legal/copyright', '/legal/platform-terms', '/legal/publisher-terms', '/legal/publishing-policy']) {
  const response = await fetch(new URL(path, origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`BLOCKED: staging ${path} returned HTTP ${response.status}.`)
  for (const [name, expected] of Object.entries(required)) {
    if (!String(response.headers.get(name) ?? '').includes(expected)) throw new Error(`BLOCKED: staging ${path} has an invalid ${name} header.`)
  }
  await response.body?.cancel()
}

console.log(JSON.stringify({ ok: true, origin: origin.origin, mode: 'read-only', checkedAt: new Date().toISOString() }, null, 2))
