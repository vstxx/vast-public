const TRACKER_HOST_PATTERNS = [
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'facebook.net',
  'hotjar.com',
  'segment.io',
  'mixpanel.com',
  'adsystem.com',
  'adservice.google.com',
  'scorecardresearch.com'
]

function parseHttpUrl(rawUrl: string): URL | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function hostMatches(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`))
}

export function isTrackerUrl(rawUrl: string): boolean {
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) return false
  return hostMatches(parsed.hostname.toLowerCase(), TRACKER_HOST_PATTERNS)
}

