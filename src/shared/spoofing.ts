import type { BrowserSettings, BrowserSpoofingSettings, SpoofingBrowserProfile } from './types'

export interface ResolvedSpoofingProfile {
  userAgent: string
  appVersion: string
  platform: string
  vendor: string
  brands: Array<{ brand: string; version: string }>
  mobile: boolean
  secChUaPlatform: string
}

const FALLBACK_CHROME_VERSION = '148.0.0.0'
const FIREFOX_126 = '126.0'
const SAFARI_17 = '17.5'

const PROFILE_MAP: Record<Exclude<SpoofingBrowserProfile, 'custom' | 'chrome-windows' | 'chrome-macos'>, ResolvedSpoofingProfile> = {
  'firefox-windows': {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FIREFOX_126}) Gecko/20100101 Firefox/${FIREFOX_126}`,
    appVersion: `5.0 (Windows NT 10.0; Win64; x64; rv:${FIREFOX_126}) Gecko/20100101 Firefox/${FIREFOX_126}`,
    platform: 'Win32',
    vendor: '',
    brands: [],
    mobile: false,
    secChUaPlatform: 'Windows'
  },
  'safari-macos': {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI_17} Safari/605.1.15`,
    appVersion: `5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${SAFARI_17} Safari/605.1.15`,
    platform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    brands: [],
    mobile: false,
    secChUaPlatform: 'macOS'
  }
}

const CHROMIUM_HINT_HEADERS = new Set([
  'sec-ch-ua',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version'
])

function normalizedChromeVersion(value?: string): string {
  if (value && /^\d+\.\d+\.\d+\.\d+$/.test(value)) return value
  const major = value?.match(/^\d+/)?.[0]
  return major ? `${major}.0.0.0` : FALLBACK_CHROME_VERSION
}

function chromeProfile(platform: 'windows' | 'macos', runtimeChromeVersion?: string): ResolvedSpoofingProfile {
  const chromeVersion = normalizedChromeVersion(runtimeChromeVersion)
  const major = chromeVersion.split('.', 1)[0]
  const isMac = platform === 'macos'
  const uaPlatform = isMac ? 'Macintosh; Intel Mac OS X 14_5' : 'Windows NT 10.0; Win64; x64'
  return {
    userAgent: `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    appVersion: `5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    platform: isMac ? 'MacIntel' : 'Win32',
    vendor: 'Google Inc.',
    brands: [
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major },
      { brand: 'Not.A/Brand', version: '24' }
    ],
    mobile: false,
    secChUaPlatform: isMac ? 'macOS' : 'Windows'
  }
}

function fullVersionFromProfile(profile: ResolvedSpoofingProfile): string {
  return profile.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''
}

function brandHeader(brands: Array<{ brand: string; version: string }>): string {
  return brands.map((item) => `"${item.brand}";v="${item.version}"`).join(', ')
}

const DEFAULT_SPOOFING: BrowserSpoofingSettings = {
  enabled: false,
  browserProfile: 'chrome-windows',
  customUserAgent: '',
  languages: ['en-US', 'en'],
  timezone: 'UTC',
  doNotTrack: true,
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  webglVendor: 'Google Inc. (Intel)',
  webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  location: {
    mode: 'off',
    latitude: 52.2297,
    longitude: 21.0122,
    accuracy: 50
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeLanguages(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : DEFAULT_SPOOFING.languages
  const clean = raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 5)
  return clean.length > 0 ? clean : DEFAULT_SPOOFING.languages
}

export function normalizeSpoofingSettings(input?: Partial<BrowserSpoofingSettings> | null): BrowserSpoofingSettings {
  const profile = input?.browserProfile && (
    input.browserProfile in PROFILE_MAP
    || input.browserProfile === 'chrome-windows'
    || input.browserProfile === 'chrome-macos'
    || input.browserProfile === 'custom'
  )
    ? input.browserProfile
    : DEFAULT_SPOOFING.browserProfile
  const location = input?.location ?? DEFAULT_SPOOFING.location
  return {
    ...DEFAULT_SPOOFING,
    ...input,
    enabled: Boolean(input?.enabled),
    browserProfile: profile,
    customUserAgent: String(input?.customUserAgent ?? '').trim(),
    languages: normalizeLanguages(input?.languages),
    timezone: String(input?.timezone || DEFAULT_SPOOFING.timezone).trim(),
    doNotTrack: input?.doNotTrack !== false,
    hardwareConcurrency: Math.round(clampNumber(input?.hardwareConcurrency, DEFAULT_SPOOFING.hardwareConcurrency, 2, 32)),
    deviceMemory: Math.round(clampNumber(input?.deviceMemory, DEFAULT_SPOOFING.deviceMemory, 1, 32)),
    maxTouchPoints: Math.round(clampNumber(input?.maxTouchPoints, DEFAULT_SPOOFING.maxTouchPoints, 0, 10)),
    webglVendor: String(input?.webglVendor || DEFAULT_SPOOFING.webglVendor).trim(),
    webglRenderer: String(input?.webglRenderer || DEFAULT_SPOOFING.webglRenderer).trim(),
    location: {
      mode: location.mode === 'fixed' ? 'fixed' : 'off',
      latitude: clampNumber(location.latitude, DEFAULT_SPOOFING.location.latitude, -90, 90),
      longitude: clampNumber(location.longitude, DEFAULT_SPOOFING.location.longitude, -180, 180),
      accuracy: clampNumber(location.accuracy, DEFAULT_SPOOFING.location.accuracy, 1, 50_000)
    }
  }
}

export function resolveSpoofingProfile(settings: BrowserSpoofingSettings, runtimeChromeVersion?: string): ResolvedSpoofingProfile {
  if (settings.browserProfile === 'custom' && settings.customUserAgent) {
    const fallback = chromeProfile('windows', runtimeChromeVersion)
    return {
      ...fallback,
      userAgent: settings.customUserAgent,
      appVersion: settings.customUserAgent.replace(/^Mozilla\//, '')
    }
  }
  if (settings.browserProfile === 'chrome-macos') return chromeProfile('macos', runtimeChromeVersion)
  if (settings.browserProfile === 'chrome-windows' || settings.browserProfile === 'custom') {
    return chromeProfile('windows', runtimeChromeVersion)
  }
  return PROFILE_MAP[settings.browserProfile]
}

export function formatAcceptLanguage(languages: string[]): string {
  return languages.map((language, index) => (index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`)).join(',')
}

export function buildSpoofingHeaders(
  settings: BrowserSpoofingSettings,
  requestHeaders: Record<string, string | string[] | undefined>,
  runtimeChromeVersion?: string
): Record<string, string | string[]> {
  const cleanHeaders = Object.fromEntries(
    Object.entries(requestHeaders).filter((entry): entry is [string, string | string[]] => (
      entry[1] !== undefined && !CHROMIUM_HINT_HEADERS.has(entry[0].toLowerCase())
    ))
  )
  if (!settings.enabled) return cleanHeaders
  const profile = resolveSpoofingProfile(settings, runtimeChromeVersion)
  const headers: Record<string, string | string[]> = {
    ...cleanHeaders,
    'User-Agent': profile.userAgent,
    'Accept-Language': formatAcceptLanguage(settings.languages),
    DNT: settings.doNotTrack ? '1' : '0'
  }
  if (profile.brands.length > 0) {
    const fullVersion = fullVersionFromProfile(profile)
    const fullVersionList = profile.brands.map((brand) => ({
      ...brand,
      version: brand.brand === 'Not.A/Brand' ? '24.0.0.0' : fullVersion
    }))
    headers['Sec-CH-UA'] = brandHeader(profile.brands)
    headers['Sec-CH-UA-Full-Version'] = `"${fullVersion}"`
    headers['Sec-CH-UA-Full-Version-List'] = brandHeader(fullVersionList)
    headers['Sec-CH-UA-Mobile'] = profile.mobile ? '?1' : '?0'
    headers['Sec-CH-UA-Platform'] = `"${profile.secChUaPlatform}"`
    headers['Sec-CH-UA-Arch'] = '"x86"'
    headers['Sec-CH-UA-Bitness'] = '"64"'
    headers['Sec-CH-UA-Model'] = '""'
    headers['Sec-CH-UA-Platform-Version'] = profile.secChUaPlatform === 'Windows' ? '"15.0.0"' : '"14.0.0"'
  }
  return headers
}

export function buildSpoofingInjectionScript(settings: BrowserSpoofingSettings, runtimeChromeVersion?: string): string {
  if (!settings.enabled) return ''
  const profile = resolveSpoofingProfile(settings, runtimeChromeVersion)
  const fullVersion = fullVersionFromProfile(profile)
  const fullVersionList = profile.brands.map((brand) => ({
    ...brand,
    version: brand.brand === 'Not.A/Brand' ? '24.0.0.0' : fullVersion
  }))
  const location = settings.location
  const signature = JSON.stringify({
    profile,
    languages: settings.languages,
    timezone: settings.timezone,
    hardwareConcurrency: settings.hardwareConcurrency,
    deviceMemory: settings.deviceMemory,
    maxTouchPoints: settings.maxTouchPoints,
    doNotTrack: settings.doNotTrack,
    webglVendor: settings.webglVendor,
    webglRenderer: settings.webglRenderer,
    location
  })
  return `
;(() => {
  const signature = ${JSON.stringify(signature)}
  if (window.__vastSpoofingSignature === signature) return
  Object.defineProperty(window, '__vastSpoofingSignature', { value: signature, configurable: true })
  const define = (target, key, value) => {
    try { Object.defineProperty(target, key, { get: () => value, configurable: true }) } catch {}
  }
  const profile = ${JSON.stringify(profile)}
  const fullVersion = ${JSON.stringify(fullVersion)}
  const fullVersionList = ${JSON.stringify(fullVersionList)}
  const languages = ${JSON.stringify(settings.languages)}
  define(Navigator.prototype, 'userAgent', profile.userAgent)
  define(Navigator.prototype, 'appVersion', profile.appVersion)
  define(Navigator.prototype, 'platform', profile.platform)
  define(Navigator.prototype, 'vendor', profile.vendor)
  define(Navigator.prototype, 'language', languages[0])
  define(Navigator.prototype, 'languages', Object.freeze(languages.slice()))
  define(Navigator.prototype, 'hardwareConcurrency', ${settings.hardwareConcurrency})
  define(Navigator.prototype, 'deviceMemory', ${settings.deviceMemory})
  define(Navigator.prototype, 'maxTouchPoints', ${settings.maxTouchPoints})
  define(Navigator.prototype, 'webdriver', false)
  define(Navigator.prototype, 'doNotTrack', ${JSON.stringify(settings.doNotTrack ? '1' : '0')})
  define(Navigator.prototype, 'userAgentData', Object.freeze({
    brands: Object.freeze(profile.brands.map((item) => Object.freeze({ brand: item.brand, version: item.version }))),
    mobile: profile.mobile,
    platform: profile.secChUaPlatform,
    getHighEntropyValues: async (hints) => {
      const result = { brands: profile.brands, mobile: profile.mobile, platform: profile.secChUaPlatform }
      for (const hint of hints || []) {
        if (hint === 'architecture') result.architecture = 'x86'
        if (hint === 'bitness') result.bitness = '64'
        if (hint === 'model') result.model = ''
        if (hint === 'platformVersion') result.platformVersion = '10.0.0'
        if (hint === 'uaFullVersion') result.uaFullVersion = fullVersion
        if (hint === 'fullVersionList') result.fullVersionList = fullVersionList
      }
      return result
    },
    toJSON: () => ({ brands: profile.brands, mobile: profile.mobile, platform: profile.secChUaPlatform })
  }))

  const spoofedTimeZone = ${JSON.stringify(settings.timezone)}
  const NativeDateTimeFormat = Intl.DateTimeFormat
  Intl.DateTimeFormat = function(locales, options) {
    const nextOptions = Object.assign({}, options || {})
    if (!nextOptions.timeZone) nextOptions.timeZone = spoofedTimeZone
    return new NativeDateTimeFormat(locales, nextOptions)
  }
  Intl.DateTimeFormat.prototype = NativeDateTimeFormat.prototype
  Intl.DateTimeFormat.supportedLocalesOf = NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat)

  const patchWebGl = (proto) => {
    if (!proto || !proto.getParameter) return
    const original = proto.__vastOriginalGetParameter || proto.getParameter
    try { Object.defineProperty(proto, '__vastOriginalGetParameter', { value: original, configurable: true }) } catch {}
    proto.getParameter = function(parameter) {
      if (parameter === 37445) return ${JSON.stringify(settings.webglVendor)}
      if (parameter === 37446) return ${JSON.stringify(settings.webglRenderer)}
      if (parameter === 7936) return ${JSON.stringify(settings.webglVendor)}
      if (parameter === 7937) return ${JSON.stringify(settings.webglRenderer)}
      return original.call(this, parameter)
    }
  }
  patchWebGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype)
  patchWebGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype)

  const locationMode = ${JSON.stringify(location.mode)}
  if (locationMode === 'fixed' && navigator.geolocation) {
    const coords = Object.freeze({
      latitude: ${location.latitude},
      longitude: ${location.longitude},
      accuracy: ${location.accuracy},
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    })
    const position = () => Object.freeze({ coords, timestamp: Date.now() })
    navigator.geolocation.getCurrentPosition = (success) => setTimeout(() => success(position()), 0)
    navigator.geolocation.watchPosition = (success) => {
      const id = setInterval(() => success(position()), 1000)
      setTimeout(() => success(position()), 0)
      return id
    }
    navigator.geolocation.clearWatch = (id) => clearInterval(id)
  }
})()
`
}

export function spoofingFromSettings(settings: BrowserSettings): BrowserSpoofingSettings {
  return normalizeSpoofingSettings(settings.spoofing)
}
