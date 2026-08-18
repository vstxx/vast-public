import type { AdBlockerMode } from './types'

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

const AD_HOST_PATTERNS = [
  'adocean.pl',
  'adform.net',
  'adnxs.com',
  'adroll.com',
  'adsafeprotected.com',
  'adsrvr.org',
  'advertising.com',
  'amazon-adsystem.com',
  'ad-maven.com',
  'admaven.com',
  'adsterra.com',
  'adsterra.org',
  'adxpansion.com',
  'clickadilla.com',
  'criteo.com',
  'ero-advertising.com',
  'exoclick.com',
  'exosrv.com',
  'googleadservices.com',
  'googlesyndication.com',
  'googletagservices.com',
  'gemius.pl',
  'hilltopads.net',
  'juicyads.com',
  'mgid.com',
  'moatads.com',
  'onclickads.net',
  'openx.net',
  'outbrain.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propeller-tracking.com',
  'pubmatic.com',
  'realsrv.com',
  'revcontent.com',
  'rubiconproject.com',
  'sharethrough.com',
  'smartadserver.com',
  'taboola.com',
  'trafficjunky.net',
  'trafficshop.com',
  'yieldmo.com',
  'zedo.com'
]

const AD_URL_SNIPPETS = [
  '/ads/',
  '/adserver',
  '/banner',
  '/gampad/',
  '/pagead/',
  '/pagead2.',
  '/prebid',
  '/pubads',
  '/securepubads',
  '?ad_',
  '&ad_'
]

const STRICT_AD_NAVIGATION_HOST_PATTERNS = [
  ...AD_HOST_PATTERNS,
  'ad-score.com',
  'adexchangecloud.com',
  'adlightning.com',
  'admarketplace.net',
  'adnami.io',
  'adoperator.com',
  'adspirit.de',
  'adskeeper.co.uk',
  'adskeeper.com',
  'adsrvmedia.net',
  'adtrafficquality.google',
  'adtrue.com',
  'clickadu.com',
  'clksite.com',
  'cpmstar.com',
  'exdynsrv.com',
  'go2cloud.org',
  'popadscdn.net',
  'pushazer.com',
  'pushwelcome.com',
  'richads.com',
  'trafficfactory.biz',
  'trafficstars.com',
  'yllix.com'
]

const STRICT_AD_NAVIGATION_SNIPPETS = [
  ...AD_URL_SNIPPETS,
  '/ad-click',
  '/ads-click',
  '/adserver/',
  '/interstitial',
  '/popads',
  '/popup',
  '/popunder',
  '/preroll',
  '/push-subscribe',
  '/vast/',
  '?ad=',
  '&ad=',
  'ad_id=',
  'adid=',
  'adzone=',
  'bannerid=',
  'campaignid=',
  'clickid=',
  'onclick=',
  'popunder=',
  'popup=',
  'pubid=',
  'zoneid='
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

function hasAdLabel(host: string): boolean {
  return host
    .split('.')
    .some((label) => /^(ad|ads|adserver|adserving|advert|clickads|onclickads|popads|tracking|trk)$/.test(label))
}

export function isTrackerUrl(rawUrl: string): boolean {
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) return false
  return hostMatches(parsed.hostname.toLowerCase(), TRACKER_HOST_PATTERNS)
}

export function isStrictAdNavigationUrl(rawUrl: string): boolean {
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) return false

  const host = parsed.hostname.toLowerCase()
  if (hostMatches(host, STRICT_AD_NAVIGATION_HOST_PATTERNS)) return true
  if (hasAdLabel(host)) return true

  const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
  return STRICT_AD_NAVIGATION_SNIPPETS.some((snippet) => haystack.includes(snippet))
}

export function isAdRequestUrl(rawUrl: string, resourceType?: string, mode: AdBlockerMode = 'standard'): boolean {
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed) return false

  const isMainFrame = resourceType === 'mainFrame'
  if (isMainFrame) {
    return mode === 'strict' && isStrictAdNavigationUrl(rawUrl)
  }

  const host = parsed.hostname.toLowerCase()
  if (hostMatches(host, mode === 'strict' ? STRICT_AD_NAVIGATION_HOST_PATTERNS : AD_HOST_PATTERNS)) return true
  if (mode === 'strict' && hasAdLabel(host)) return true

  const haystack = `${parsed.pathname}${parsed.search}`.toLowerCase()
  const snippets = mode === 'strict' ? STRICT_AD_NAVIGATION_SNIPPETS : AD_URL_SNIPPETS
  return snippets.some((snippet) => haystack.includes(snippet))
}

const SOFT_COSMETIC_SELECTORS = [
  '.ad',
  '.ads',
  '.adsbox',
  '.advert',
  '.advertisement',
  '.ad-container',
  '.ad-wrapper',
  '.banner-ad',
  '.google-auto-placed',
  '.GoogleActiveViewElement',
  '.OUTBRAIN',
  '.taboola',
  '[id^="ad-"]',
  '[id*="-ad-"]',
  '[id*="_ad_"]',
  '[class*="adsbygoogle"]',
  '[data-ad]',
  '[data-ad-slot]',
  '[data-google-query-id]',
  'ins.adsbygoogle',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="adform.net"]',
  'iframe[src*="adocean.pl"]',
  'iframe[src*="smartadserver.com"]',
  'iframe[src*="gemius.pl"]',
  '#player-ads',
  '#masthead-ad',
  '.ytp-ad-module',
  '.ytp-ad-overlay-container',
  '.video-ads',
  'ytd-ad-slot-renderer',
  'ytd-display-ad-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-video-renderer',
  'ytd-companion-slot-renderer'
]

const BRUTAL_COSMETIC_SELECTORS = [
  ...SOFT_COSMETIC_SELECTORS,
  '[class^="ad_"]',
  '[class*=" ad-"]',
  '[class*=" ad_"]',
  '[class*="advert"]',
  '[class*="sponsor"]',
  '[id^="ads"]',
  '[id*="advert"]',
  '[id*="sponsor"]',
  'iframe[src*="ad"]',
  'iframe[src*="pop"]'
]

export function buildCosmeticAdBlockScript(enabled: boolean, mode: AdBlockerMode = 'standard'): string {
  const selectors = mode === 'strict' ? BRUTAL_COSMETIC_SELECTORS : SOFT_COSMETIC_SELECTORS
  const css = enabled
    ? `${selectors.join(',\n')}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`
    : ''
  return `
(() => {
  const id = 'vast-cosmetic-adblock-style';
  const existing = document.getElementById(id);
  if (!${JSON.stringify(enabled)}) {
    existing?.remove();
    return false;
  }
  const css = ${JSON.stringify(css)};
  const style = existing || document.createElement('style');
  style.id = id;
  style.textContent = css;
  if (!style.parentNode) {
    (document.head || document.documentElement).appendChild(style);
  }
  return true;
})()
`
}
