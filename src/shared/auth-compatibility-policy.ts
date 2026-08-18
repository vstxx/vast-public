export const AUTH_COMPATIBILITY_MODEL = 'sterile-top-level-window'
export const AUTH_IDENTITY_PROFILE = 'native-electron'

const IDENTITY_PROVIDER_DOMAINS = [
  'appleid.apple.com',
  'login.microsoftonline.com',
  'accounts.spotify.com',
  'auth.openai.com',
  'auth0.openai.com',
  'login.openai.com',
  'auth.chatgpt.com',
  'login.chatgpt.com',
  'auth0.com',
  'okta.com'
] as const

const AUTH_CALLBACK_PATH = /\/(?:auth|oauth|oauth2|signin|sign-in|login|sso)?\/?(?:callback|complete|return|redirect)(?:\/|$)/i

function parsedUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl)
  } catch {
    return undefined
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function isGoogleIdentityProviderUrl(rawUrl: string): boolean {
  const parsed = parsedUrl(rawUrl)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return false

  const host = parsed.hostname.toLowerCase()
  if (hostMatches(host, 'accounts.google.com') || host === 'oauth2.googleapis.com') return true

  // Google can serve OAuth handoff resources from scoped googleusercontent
  // hosts. Do not treat unrelated google.com pages as authentication pages.
  if (!hostMatches(host, 'googleusercontent.com')) return false
  const haystack = `${host} ${parsed.pathname} ${parsed.search}`.toLowerCase()
  return /(?:account|auth|oauth|signin|sign-in|login|credential|gsi)/.test(haystack)
}

export function isIdentityProviderPopupUrl(rawUrl: string): boolean {
  const parsed = parsedUrl(rawUrl)
  if (!parsed) return false

  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (isGoogleIdentityProviderUrl(rawUrl)) return true
  if (IDENTITY_PROVIDER_DOMAINS.some((domain) => hostMatches(host, domain))) return true
  if (host === 'login.live.com' || host === 'account.live.com') return true

  if ((host === 'discord.com' || host === 'discordapp.com') &&
      (path.startsWith('/oauth2') || path.startsWith('/api/oauth2') || path === '/login')) {
    return true
  }

  if (host === 'github.com') {
    return path === '/login/oauth/authorize' || path === '/login' || path.startsWith('/sessions/') || path.includes('/sso')
  }

  return false
}

export function isOAuthLikeFirstPartyAuthUrl(rawUrl: string): boolean {
  const parsed = parsedUrl(rawUrl)
  if (!parsed) return false

  const path = parsed.pathname.toLowerCase()
  const search = parsed.searchParams
  const authPath =
    path === '/login' ||
    path === '/signin' ||
    path === '/sign-in' ||
    path === '/log-in' ||
    path === '/auth' ||
    path === '/oauth' ||
    path === '/authorize' ||
    path === '/connect' ||
    path.startsWith('/login/') ||
    path.startsWith('/auth/') ||
    path.startsWith('/oauth/') ||
    path.startsWith('/oauth2/') ||
    path.startsWith('/authorize/') ||
    path.startsWith('/signin/') ||
    path.startsWith('/sign-in/') ||
    path.startsWith('/log-in/') ||
    path.startsWith('/connect/') ||
    path.includes('/oauth_') ||
    path.includes('/oauth-') ||
    path.includes('/social-login') ||
    path.includes('/social_login')
  if (authPath) return true
  if (search.has('client_id') || search.has('oauth2') || search.has('oauth')) return true
  const provider = `${search.get('provider') ?? ''} ${search.get('social') ?? ''} ${search.get('service') ?? ''}`.toLowerCase()
  return /\b(google|apple|facebook|microsoft|github|sso|oauth)\b/.test(provider)
}

export function isOAuthCallbackUrl(rawUrl: string): boolean {
  const parsed = parsedUrl(rawUrl)
  if (!parsed) return false
  if (AUTH_CALLBACK_PATH.test(parsed.pathname)) return true
  return parsed.searchParams.has('code') && parsed.searchParams.has('state')
}

export function isAuthSensitiveUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return false
  return isIdentityProviderPopupUrl(rawUrl) || isOAuthLikeFirstPartyAuthUrl(rawUrl) || isOAuthCallbackUrl(rawUrl)
}

export function shouldBypassVastInterference(input: {
  url: string
  topLevelUrl?: string
  authWindow?: boolean
}): boolean {
  return input.authWindow === true ||
    isAuthSensitiveUrl(input.url) ||
    Boolean(input.topLevelUrl && isAuthSensitiveUrl(input.topLevelUrl))
}
