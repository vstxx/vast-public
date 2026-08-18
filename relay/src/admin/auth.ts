import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from 'jose'
import { ValidationError } from '../shared/validation'

const ACCESS_TOKEN_MAX_LENGTH = 16 * 1024
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,189}$/
const SERVICE_COMMON_NAME_PATTERN = /^[a-zA-Z0-9._:-]{3,246}$/
const remoteKeySets = new Map<string, JWTVerifyGetKey>()

export interface AccessIdentity {
  actor: string
  kind: 'human' | 'service'
  subject: string
}

export type AccessTokenVerifier = (
  token: string,
  env: Pick<AdminEnv, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>
) => Promise<JWTPayload>

function accessConfiguration(env: Pick<AdminEnv, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>): {
  audience: string
  teamDomain: string
} {
  const audience = env.ACCESS_AUD?.trim()
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, '')
  if (!audience || audience.length > 256 || !teamDomain) {
    throw new Error('Cloudflare Access verification is not configured.')
  }
  const parsed = new URL(teamDomain)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname.endsWith('.cloudflareaccess.com')
  ) {
    throw new Error('Cloudflare Access team domain is invalid.')
  }
  return { audience, teamDomain }
}

function keySetFor(teamDomain: string): JWTVerifyGetKey {
  const existing = remoteKeySets.get(teamDomain)
  if (existing) return existing
  const created = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000
  })
  remoteKeySets.set(teamDomain, created)
  return created
}

export async function verifyAccessTokenWithKeySet(
  token: string,
  env: Pick<AdminEnv, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>,
  keySet: JWTVerifyGetKey
): Promise<JWTPayload> {
  const { audience, teamDomain } = accessConfiguration(env)
  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ['RS256'],
    audience,
    issuer: teamDomain,
    requiredClaims: ['aud', 'exp', 'iat', 'iss', 'sub'],
    clockTolerance: 5
  })
  return payload
}

export const verifyAccessToken: AccessTokenVerifier = async (token, env) => {
  const { teamDomain } = accessConfiguration(env)
  return verifyAccessTokenWithKeySet(token, env, keySetFor(teamDomain))
}

export async function authenticateAccessRequest(
  request: Request,
  env: Pick<AdminEnv, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>,
  verifier: AccessTokenVerifier = verifyAccessToken
): Promise<AccessIdentity> {
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token || token.length > ACCESS_TOKEN_MAX_LENGTH) {
    throw new ValidationError('Cloudflare Access authentication is required.', 401)
  }
  let payload: JWTPayload
  try {
    payload = await verifier(token, env)
  } catch {
    throw new ValidationError('Cloudflare Access authentication is invalid.', 401)
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const commonName = typeof payload.common_name === 'string' ? payload.common_name.trim() : ''
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : ''
  if (EMAIL_PATTERN.test(email) && email.length <= 254) {
    if (!subject || subject.length > 512) {
      throw new ValidationError('Cloudflare Access identity is invalid.', 401)
    }
    return { actor: email, kind: 'human', subject }
  }
  if (SERVICE_COMMON_NAME_PATTERN.test(commonName)) {
    if (subject.length > 512) {
      throw new ValidationError('Cloudflare Access identity is invalid.', 401)
    }
    return {
      actor: `service:${commonName}`,
      kind: 'service',
      subject: subject || `service:${commonName}`
    }
  }
  throw new ValidationError('Cloudflare Access identity is invalid.', 401)
}
