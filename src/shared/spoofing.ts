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
  const clean = raw
    .map((item) => String(item).trim())
    .filter((item) => /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(item))
    .slice(0, 5)
  return clean.length > 0 ? clean : DEFAULT_SPOOFING.languages
}

function normalizeTimezone(value: unknown): string {
  const timezone = String(value || DEFAULT_SPOOFING.timezone).trim().slice(0, 128)
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0)
    return timezone
  } catch {
    return DEFAULT_SPOOFING.timezone
  }
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
    customUserAgent: String(input?.customUserAgent ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512),
    languages: normalizeLanguages(input?.languages),
    timezone: normalizeTimezone(input?.timezone),
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

export interface DocumentSpoofingConfig {
  profile: ResolvedSpoofingProfile
  fullVersion: string
  fullVersionList: Array<{ brand: string; version: string }>
  languages: string[]
  timezone: string
  doNotTrack: boolean
  hardwareConcurrency: number
  deviceMemory: number
  maxTouchPoints: number
  webglVendor: string
  webglRenderer: string
  location: BrowserSpoofingSettings['location']
}

export function documentSpoofingConfig(settings: BrowserSpoofingSettings, runtimeChromeVersion?: string): DocumentSpoofingConfig | null {
  if (!settings.enabled) return null
  const profile = resolveSpoofingProfile(settings, runtimeChromeVersion)
  const fullVersion = fullVersionFromProfile(profile)
  const fullVersionList = profile.brands.map((brand) => ({
    ...brand,
    version: brand.brand === 'Not.A/Brand' ? '24.0.0.0' : fullVersion
  }))
  return {
    profile,
    fullVersion,
    fullVersionList,
    languages: settings.languages,
    timezone: settings.timezone,
    doNotTrack: settings.doNotTrack,
    hardwareConcurrency: settings.hardwareConcurrency,
    deviceMemory: settings.deviceMemory,
    maxTouchPoints: settings.maxTouchPoints,
    webglVendor: settings.webglVendor,
    webglRenderer: settings.webglRenderer,
    location: { ...settings.location }
  }
}

/** Runs in the page's main world at document start. Keep this function self-contained. */
export function installDocumentSpoofing(config: DocumentSpoofingConfig): void {
  const define = (target: object | undefined, key: PropertyKey, value: unknown): void => {
    if (!target) return
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      Object.defineProperty(target, key, { get: () => value, configurable: true, enumerable: descriptor?.enumerable ?? true })
    } catch {
      // A single non-configurable surface must not abort the remaining profile.
    }
  }
  const profile = config.profile
  const languages = Object.freeze(config.languages.slice())
  const navigatorPrototype = typeof Navigator === 'undefined' ? undefined : Navigator.prototype
  define(navigatorPrototype, 'userAgent', profile.userAgent)
  define(navigatorPrototype, 'appVersion', profile.appVersion)
  define(navigatorPrototype, 'platform', profile.platform)
  define(navigatorPrototype, 'vendor', profile.vendor)
  define(navigatorPrototype, 'language', languages[0])
  define(navigatorPrototype, 'languages', languages)
  define(navigatorPrototype, 'hardwareConcurrency', config.hardwareConcurrency)
  define(navigatorPrototype, 'deviceMemory', config.deviceMemory)
  define(navigatorPrototype, 'maxTouchPoints', config.maxTouchPoints)
  define(navigatorPrototype, 'webdriver', false)
  define(navigatorPrototype, 'doNotTrack', config.doNotTrack ? '1' : null)

  if (profile.brands.length === 0) {
    define(navigatorPrototype, 'userAgentData', undefined)
  } else {
    const frozenBrands = Object.freeze(profile.brands.map((item) => Object.freeze({ ...item })))
    const frozenFullVersions = Object.freeze(config.fullVersionList.map((item) => Object.freeze({ ...item })))
    const userAgentData = Object.freeze({
      brands: frozenBrands,
      mobile: profile.mobile,
      platform: profile.secChUaPlatform,
      getHighEntropyValues: async (hints: string[] = []) => {
        const result: Record<string, unknown> = { brands: frozenBrands, mobile: profile.mobile, platform: profile.secChUaPlatform }
        for (const hint of hints) {
          if (hint === 'architecture') result.architecture = 'x86'
          if (hint === 'bitness') result.bitness = '64'
          if (hint === 'model') result.model = ''
          if (hint === 'platformVersion') result.platformVersion = profile.secChUaPlatform === 'Windows' ? '15.0.0' : '14.0.0'
          if (hint === 'uaFullVersion') result.uaFullVersion = config.fullVersion
          if (hint === 'fullVersionList') result.fullVersionList = frozenFullVersions
        }
        return result
      },
      toJSON: () => ({ brands: frozenBrands, mobile: profile.mobile, platform: profile.secChUaPlatform })
    })
    define(navigatorPrototype, 'userAgentData', userAgentData)
  }

  try {
    const NativeDateTimeFormat = Intl.DateTimeFormat
    const spoofedTimeZone = config.timezone
    const PatchedDateTimeFormat = function(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
      const nextOptions = { ...(options ?? {}) }
      if (!nextOptions.timeZone) nextOptions.timeZone = spoofedTimeZone
      return new NativeDateTimeFormat(locales, nextOptions)
    }
    PatchedDateTimeFormat.prototype = NativeDateTimeFormat.prototype
    Object.setPrototypeOf(PatchedDateTimeFormat, NativeDateTimeFormat)
    Intl.DateTimeFormat = PatchedDateTimeFormat as typeof Intl.DateTimeFormat
  } catch {
    // Keep the rest of the profile active if this engine locks Intl down.
  }

  const patchWebGl = (prototype: { getParameter?: (parameter: number) => unknown } | undefined): void => {
    if (!prototype || typeof prototype.getParameter !== 'function') return
    const original = prototype.getParameter
    try {
      Object.defineProperty(prototype, 'getParameter', {
        configurable: true,
        value: function(this: unknown, parameter: number): unknown {
          if (parameter === 37445 || parameter === 7936) return config.webglVendor
          if (parameter === 37446 || parameter === 7937) return config.webglRenderer
          return original.call(this, parameter)
        }
      })
    } catch {
      // WebGL1 and WebGL2 are independent; one failure must not block the other.
    }
  }
  patchWebGl(typeof WebGLRenderingContext === 'undefined' ? undefined : WebGLRenderingContext.prototype)
  patchWebGl(typeof WebGL2RenderingContext === 'undefined' ? undefined : WebGL2RenderingContext.prototype)

  if (config.location.mode === 'fixed' && navigator.geolocation) {
    const coords = Object.freeze({
      latitude: config.location.latitude,
      longitude: config.location.longitude,
      accuracy: config.location.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    })
    const position = () => Object.freeze({ coords, timestamp: Date.now() })
    try {
      Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
        configurable: true,
        value: (success: PositionCallback) => setTimeout(() => success(position() as GeolocationPosition), 0)
      })
      Object.defineProperty(navigator.geolocation, 'watchPosition', {
        configurable: true,
        value: (success: PositionCallback) => {
          const id = setInterval(() => success(position() as GeolocationPosition), 1000)
          setTimeout(() => success(position() as GeolocationPosition), 0)
          return id
        }
      })
      Object.defineProperty(navigator.geolocation, 'clearWatch', {
        configurable: true,
        value: (id: number) => clearInterval(id)
      })
    } catch {
      // Main also applies the Chromium geolocation override via CDP.
    }
  }
}

export function buildSpoofingInjectionScript(settings: BrowserSpoofingSettings, runtimeChromeVersion?: string): string {
  const config = documentSpoofingConfig(settings, runtimeChromeVersion)
  if (!config) return ''
  return `;(${installDocumentSpoofing.toString()})(${JSON.stringify(config)})`
}

export function spoofingFromSettings(settings: BrowserSettings): BrowserSpoofingSettings {
  return normalizeSpoofingSettings(settings.spoofing)
}
