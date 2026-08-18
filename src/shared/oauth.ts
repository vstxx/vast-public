import { isAuthSensitiveUrl } from './auth-compatibility-policy.ts'

export const VAST_DEFAULT_WEBVIEW_PARTITION = 'persist:vast-default'

export interface ChromiumIdentity {
  userAgent: string
  appVersion: string
  platform: string
  vendor: string
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
  mobile: boolean
  secChUaPlatform: string
  architecture: string
  bitness: string
  platformVersion: string
}

type HeaderValue = string | string[] | undefined
type InputHeaderMap = Record<string, HeaderValue>
type OutputHeaderMap = Record<string, string | string[]>

const SENSITIVE_OAUTH_PARAMS = new Set([
  'access_token',
  'authuser',
  'client_secret',
  'code',
  'credential',
  'email',
  'id_token',
  'identifier',
  'login_hint',
  'nonce',
  'password',
  'refresh_token',
  'session_state',
  'state',
  'token'
])

const CHROMIUM_HINT_HEADERS = new Set([
  'user-agent',
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

function parsedUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl)
  } catch {
    return undefined
  }
}

function paramMarker(name: string): string {
  return SENSITIVE_OAUTH_PARAMS.has(name.toLowerCase()) ? '[redacted]' : '[present]'
}

function redactParams(params: URLSearchParams): string {
  const parts: string[] = []
  params.forEach((_value, key) => {
    parts.push(`${encodeURIComponent(key)}=${paramMarker(key)}`)
  })
  return parts.join('&')
}

function majorVersion(version: string): string {
  return version.split('.', 1)[0] || '142'
}

function normalizedChromeVersion(version?: string): string {
  if (version && /^\d+\.\d+\.\d+\.\d+$/.test(version)) return version
  if (version && /^\d+/.test(version)) return `${majorVersion(version)}.0.0.0`
  return '142.0.0.0'
}

function platformIdentity(platform?: string): Pick<ChromiumIdentity, 'platform' | 'secChUaPlatform' | 'platformVersion'> & { uaPlatform: string } {
  if (platform === 'darwin') {
    return {
      uaPlatform: 'Macintosh; Intel Mac OS X 14_0',
      platform: 'MacIntel',
      secChUaPlatform: 'macOS',
      platformVersion: '14.0.0'
    }
  }

  if (platform === 'linux') {
    return {
      uaPlatform: 'X11; Linux x86_64',
      platform: 'Linux x86_64',
      secChUaPlatform: 'Linux',
      platformVersion: '6.0.0'
    }
  }

  return {
    uaPlatform: 'Windows NT 10.0; Win64; x64',
    platform: 'Win32',
    secChUaPlatform: 'Windows',
    platformVersion: '15.0.0'
  }
}

function brandHeader(brands: Array<{ brand: string; version: string }>): string {
  return brands.map((item) => `"${item.brand}";v="${item.version}"`).join(', ')
}

export function isLikelyOAuthUrl(rawUrl: string): boolean {
  const parsed = parsedUrl(rawUrl)
  if (!parsed) return false
  if (isAuthSensitiveUrl(rawUrl)) return true

  const haystack = `${parsed.pathname} ${parsed.search}`.toLowerCase()
  return (
    haystack.includes('/oauth') ||
    haystack.includes('/auth') ||
    haystack.includes('/authorize') ||
    haystack.includes('/signin') ||
    haystack.includes('/sign-in') ||
    haystack.includes('/login') ||
    haystack.includes('oauth2') ||
    haystack.includes('client_id=')
  )
}

export {
  isGoogleIdentityProviderUrl,
  isIdentityProviderPopupUrl
} from './auth-compatibility-policy.ts'

export function isLikelyOAuthBlockedText(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('disallowed_useragent') ||
    normalized.includes('this browser or app may not be secure') ||
    normalized.includes('temporarily disabled for this app') ||
    normalized.includes('embedded user-agent') ||
    normalized.includes('embedded browser') ||
    normalized.includes('user-agent is not permitted') ||
    normalized.includes('authorize this app in your browser')
  )
}

export function redactOAuthUrl(rawUrl: string): string {
  const parsed = parsedUrl(rawUrl)
  if (!parsed) return '[invalid-url]'

  let result = `${parsed.origin}${parsed.pathname}`
  const query = redactParams(parsed.searchParams)
  if (query) result += `?${query}`

  if (parsed.hash) {
    const hash = parsed.hash.slice(1)
    const normalizedHash = hash.startsWith('?') ? hash.slice(1) : hash
    if (normalizedHash.includes('=') || normalizedHash.includes('&')) {
      const redactedHash = redactParams(new URLSearchParams(normalizedHash))
      result += redactedHash ? `#${redactedHash}` : '#[present]'
    } else {
      result += '#[present]'
    }
  }

  return result
}

export function buildDefaultChromiumIdentity(input: { chromeVersion?: string; platform?: string } = {}): ChromiumIdentity {
  const chromeVersion = normalizedChromeVersion(input.chromeVersion)
  const major = majorVersion(chromeVersion)
  const platform = platformIdentity(input.platform)
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Not A(Brand', version: '99' }
  ]

  return {
    userAgent: `Mozilla/5.0 (${platform.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    appVersion: `5.0 (${platform.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    platform: platform.platform,
    vendor: 'Google Inc.',
    brands,
    fullVersionList: [
      { brand: 'Chromium', version: chromeVersion },
      { brand: 'Not A(Brand', version: '99.0.0.0' }
    ],
    mobile: false,
    secChUaPlatform: platform.secChUaPlatform,
    architecture: 'x86',
    bitness: '64',
    platformVersion: platform.platformVersion
  }
}

export function buildDefaultChromiumRequestHeaders(identity: ChromiumIdentity, requestHeaders: InputHeaderMap = {}): OutputHeaderMap {
  const headers: OutputHeaderMap = {}
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (typeof value === 'undefined') continue
    if (CHROMIUM_HINT_HEADERS.has(key.toLowerCase())) continue
    headers[key] = value
  }

  headers['User-Agent'] = identity.userAgent
  headers['Sec-CH-UA'] = brandHeader(identity.brands)
  headers['Sec-CH-UA-Full-Version-List'] = brandHeader(identity.fullVersionList)
  headers['Sec-CH-UA-Mobile'] = identity.mobile ? '?1' : '?0'
  headers['Sec-CH-UA-Platform'] = `"${identity.secChUaPlatform}"`
  headers['Sec-CH-UA-Arch'] = `"${identity.architecture}"`
  headers['Sec-CH-UA-Bitness'] = `"${identity.bitness}"`
  headers['Sec-CH-UA-Model'] = '""'
  headers['Sec-CH-UA-Platform-Version'] = `"${identity.platformVersion}"`
  return headers
}
