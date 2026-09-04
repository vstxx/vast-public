import { isGoogleIdentityProviderUrl } from './auth-compatibility-policy.ts'
import type { CredentialEvidenceKind } from './credential-capture-state'

interface CredentialSecretFields {
  origin: string
  username: string
  password: string
  title?: string
  favicon?: string
}

export type CredentialSubmissionKind = 'login' | 'signup' | 'change-password'

export interface CredentialSubmissionCandidate extends CredentialSecretFields {
  attemptId: string
  submissionUrl: string
  kind: CredentialSubmissionKind
  currentPassword?: string
  formId?: string
  submittedAt: number
}

export interface CredentialUsernameObservation {
  origin: string
  username: string
  observedAt: number
  userEntered: true
}

export interface CredentialEvidenceReport {
  attemptId: string
  origin: string
  url: string
  kind: CredentialEvidenceKind
  observedAt: number
}

export interface CredentialDocumentState {
  origin: string
  url: string
  hasLoginFields: boolean
  hasPasswordFields: boolean
  observedAt: number
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

function sanitizeCredentialSecretFields(input: unknown): CredentialSecretFields {
  if (!input || typeof input !== 'object') throw new Error('Invalid captured login.')
  const candidate = input as Partial<CredentialSecretFields>
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

export function sanitizeCredentialSubmissionCandidate(input: unknown): CredentialSubmissionCandidate {
  const candidate = input as Partial<CredentialSubmissionCandidate>
  const base = sanitizeCredentialSecretFields(candidate)
  if (typeof candidate.attemptId !== 'string' || !/^[a-f0-9]{32}$/i.test(candidate.attemptId)) throw new Error('Invalid credential attempt id.')
  if (candidate.kind !== 'login' && candidate.kind !== 'signup' && candidate.kind !== 'change-password') throw new Error('Invalid credential submission kind.')
  if (typeof candidate.submissionUrl !== 'string' || candidate.submissionUrl.length > 4096) throw new Error('Invalid credential submission URL.')
  try {
    if (new URL(candidate.submissionUrl).origin !== base.origin) throw new Error('mismatch')
  } catch {
    throw new Error('Credential submission URL does not match its origin.')
  }
  if (!Number.isFinite(candidate.submittedAt) || Math.abs(Date.now() - Number(candidate.submittedAt)) > 2 * 60_000) throw new Error('Credential submission timestamp is invalid.')
  if (candidate.currentPassword !== undefined && (typeof candidate.currentPassword !== 'string' || candidate.currentPassword.length > 4096)) {
    throw new Error('Invalid current password.')
  }
  if (candidate.kind === 'change-password' && !candidate.currentPassword) throw new Error('Password changes require the current password.')
  if (candidate.formId !== undefined && (typeof candidate.formId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.formId))) throw new Error('Invalid credential form id.')
  return {
    ...base,
    attemptId: candidate.attemptId,
    submissionUrl: candidate.submissionUrl,
    kind: candidate.kind,
    currentPassword: candidate.currentPassword,
    formId: candidate.formId,
    submittedAt: Number(candidate.submittedAt)
  }
}

export function sanitizeCredentialUsernameObservation(input: unknown): CredentialUsernameObservation {
  if (!input || typeof input !== 'object') throw new Error('Invalid username observation.')
  const candidate = input as Partial<CredentialUsernameObservation>
  if (typeof candidate.origin !== 'string' || automaticPasswordCaptureOrigin(candidate.origin) !== candidate.origin) throw new Error('Invalid username observation origin.')
  if (typeof candidate.username !== 'string' || !candidate.username.trim() || candidate.username.length > 512) throw new Error('Invalid observed username.')
  if (candidate.userEntered !== true || !Number.isFinite(candidate.observedAt) || Math.abs(Date.now() - Number(candidate.observedAt)) > 2 * 60_000) {
    throw new Error('Stale username observation.')
  }
  return { origin: candidate.origin, username: candidate.username.trim(), observedAt: Number(candidate.observedAt), userEntered: true }
}

const credentialEvidenceKinds = new Set<CredentialEvidenceKind>([
  'form-disappeared',
  'password-fields-disappeared',
  'navigation-away',
  'spa-navigation-away',
  'navigation-same-auth',
  'validation-error',
  'invalid-event',
  'login-form-reappeared',
  'password-refocused',
  'form-still-visible'
])

function validatedObservationUrl(origin: unknown, url: unknown): { origin: string; url: string } {
  if (typeof origin !== 'string' || automaticPasswordCaptureOrigin(origin) !== origin) throw new Error('Invalid credential observation origin.')
  if (typeof url !== 'string' || url.length > 4096) throw new Error('Invalid credential observation URL.')
  try {
    if (new URL(url).origin !== origin) throw new Error('mismatch')
  } catch {
    throw new Error('Credential observation URL does not match its origin.')
  }
  return { origin, url }
}

function validatedObservationTime(value: unknown): number {
  if (!Number.isFinite(value) || Math.abs(Date.now() - Number(value)) > 2 * 60_000) throw new Error('Stale credential observation.')
  return Number(value)
}

export function sanitizeCredentialEvidenceReport(input: unknown): CredentialEvidenceReport {
  if (!input || typeof input !== 'object') throw new Error('Invalid credential evidence.')
  const candidate = input as Partial<CredentialEvidenceReport>
  if (typeof candidate.attemptId !== 'string' || !/^[a-f0-9]{32}$/i.test(candidate.attemptId)) throw new Error('Invalid credential attempt id.')
  if (!credentialEvidenceKinds.has(candidate.kind as CredentialEvidenceKind)) throw new Error('Invalid credential evidence kind.')
  return {
    attemptId: candidate.attemptId,
    ...validatedObservationUrl(candidate.origin, candidate.url),
    kind: candidate.kind as CredentialEvidenceKind,
    observedAt: validatedObservationTime(candidate.observedAt)
  }
}

export function sanitizeCredentialDocumentState(input: unknown): CredentialDocumentState {
  if (!input || typeof input !== 'object') throw new Error('Invalid credential document state.')
  const candidate = input as Partial<CredentialDocumentState>
  if (typeof candidate.hasLoginFields !== 'boolean' || typeof candidate.hasPasswordFields !== 'boolean') {
    throw new Error('Invalid credential field state.')
  }
  return {
    ...validatedObservationUrl(candidate.origin, candidate.url),
    hasLoginFields: candidate.hasLoginFields,
    hasPasswordFields: candidate.hasPasswordFields,
    observedAt: validatedObservationTime(candidate.observedAt)
  }
}
