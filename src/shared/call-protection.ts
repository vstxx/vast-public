const CALL_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'zoom.us',
  'zoom.com',
  'webex.com',
  'meet.jit.si',
  'whereby.com',
  'around.co',
  'gather.town',
  'spatial.chat',
  'riverside.fm',
  'streamyard.com',
  'discord.com',
  'messenger.com',
  'web.whatsapp.com',
  'web.telegram.org'
] as const

const CALL_SUBDOMAIN_LABELS = new Set(['call', 'calls', 'conference', 'meet', 'meeting', 'video', 'webinar'])

function hostMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`)
}

/**
 * Conservative fallback for call pages that may be silent or have camera and
 * microphone disabled. Runtime media/capture signals remain authoritative.
 */
export function isLikelyCallUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    if (CALL_HOSTS.some((host) => hostMatches(hostname, host))) return true
    const firstLabel = hostname.split('.')[0]
    return hostname.includes('.') && CALL_SUBDOMAIN_LABELS.has(firstLabel)
  } catch {
    return false
  }
}
