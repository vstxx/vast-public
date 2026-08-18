import { isGoogleIdentityProviderUrl } from './auth-compatibility-policy.ts'

export interface PasswordLoginCandidate {
  origin: string
  username: string
  password: string
  title?: string
  favicon?: string
}

export type PasswordCaptureAction = 'save' | 'update' | 'unchanged' | 'suppressed'

export function normalizedCredentialUsername(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function automaticPasswordCaptureOrigin(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') {
      const localHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1')
      if (!localHttp) return undefined
    }
    if (isGoogleIdentityProviderUrl(parsed.toString())) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function sanitizePasswordLoginCandidate(input: unknown): PasswordLoginCandidate {
  if (!input || typeof input !== 'object') throw new Error('Invalid captured login.')
  const candidate = input as Partial<PasswordLoginCandidate>
  if (typeof candidate.origin !== 'string' || automaticPasswordCaptureOrigin(candidate.origin) !== candidate.origin) {
    throw new Error('Automatic password saving is only available for secure website origins.')
  }
  if (typeof candidate.username !== 'string' || candidate.username.length > 512) throw new Error('Invalid captured username.')
  if (typeof candidate.password !== 'string' || candidate.password.length < 1 || candidate.password.length > 4096) {
    throw new Error('Invalid captured password.')
  }
  if (candidate.title !== undefined && (typeof candidate.title !== 'string' || candidate.title.length > 256)) throw new Error('Invalid captured title.')
  if (candidate.favicon !== undefined && (typeof candidate.favicon !== 'string' || candidate.favicon.length > 2048)) throw new Error('Invalid captured favicon.')
  return {
    origin: candidate.origin,
    username: candidate.username.trim(),
    password: candidate.password,
    title: candidate.title?.trim(),
    favicon: candidate.favicon?.trim()
  }
}

export function classifyPasswordCapture(input: {
  suppressed: boolean
  hasExistingCredential: boolean
  passwordMatches: boolean
}): PasswordCaptureAction {
  if (input.suppressed) return 'suppressed'
  if (!input.hasExistingCredential) return 'save'
  return input.passwordMatches ? 'unchanged' : 'update'
}
