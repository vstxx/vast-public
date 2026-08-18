export interface CleanUrlResult {
  url: string
  changed: boolean
  removedParameters: string[]
}

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'igsh', 'ttclid', 'twclid',
  'mc_cid', 'mc_eid', 'vero_conv', 'vero_id', 'oly_anon_id', 'oly_enc_id',
  'ref_src', 'ref_url', 'wickedid', 'yclid', '_hsenc', '_hsmi'
])

const AFFILIATE_PARAMETERS = new Set([
  'aff', 'affid', 'aff_id', 'affiliate', 'affiliate_id', 'partner', 'partner_id',
  'ref', 'refid', 'ref_id', 'tag', 'clickid', 'click_id', 'irclickid'
])

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized)
}

export function cleanTrackingUrl(rawUrl: string, stripAffiliateParameters = false): CleanUrlResult {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: rawUrl, changed: false, removedParameters: [] }
    }

    const removedParameters: string[] = []
    for (const name of [...parsed.searchParams.keys()]) {
      const normalized = name.toLowerCase()
      if (!isTrackingParameter(normalized) && !(stripAffiliateParameters && AFFILIATE_PARAMETERS.has(normalized))) continue
      parsed.searchParams.delete(name)
      if (!removedParameters.includes(name)) removedParameters.push(name)
    }

    return {
      url: removedParameters.length > 0 ? parsed.toString() : rawUrl,
      changed: removedParameters.length > 0,
      removedParameters
    }
  } catch {
    return { url: rawUrl, changed: false, removedParameters: [] }
  }
}

export function hostMatchesList(rawUrlOrHost: string, entries: readonly string[]): boolean {
  let host = rawUrlOrHost.trim().toLowerCase()
  try {
    host = new URL(rawUrlOrHost).hostname.toLowerCase()
  } catch {
    host = host.replace(/^\.+|\.+$/g, '')
  }
  return Boolean(host && entries.some((entry) => {
    const candidate = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, '')
    return Boolean(candidate && (host === candidate || host.endsWith(`.${candidate}`)))
  }))
}

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz',
  'com.br', 'com.mx', 'com.pl', 'net.pl', 'org.pl', 'edu.pl', 'gov.pl'
])

export function siteDomain(rawUrlOrHost: string): string {
  let hostname = rawUrlOrHost.toLowerCase()
  try {
    hostname = new URL(rawUrlOrHost).hostname.toLowerCase()
  } catch {
    hostname = hostname.replace(/^\.+|\.+$/g, '')
  }
  if (!hostname || hostname === 'localhost' || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(':')) return hostname
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length <= 2) return hostname
  const suffix = labels.slice(-2).join('.')
  return TWO_LEVEL_PUBLIC_SUFFIXES.has(suffix) ? labels.slice(-3).join('.') : suffix
}

export function isThirdPartyUrl(requestUrl: string, topLevelUrl: string | undefined): boolean {
  if (!topLevelUrl) return false
  const requestSite = siteDomain(requestUrl)
  const topLevelSite = siteDomain(topLevelUrl)
  return Boolean(requestSite && topLevelSite && requestSite !== topLevelSite)
}
