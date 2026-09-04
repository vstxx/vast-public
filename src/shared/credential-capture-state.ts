export type CredentialAttemptState = 'pending' | 'succeeded' | 'failed' | 'unknown'

export type CredentialEvidenceKind =
  | 'form-disappeared'
  | 'password-fields-disappeared'
  | 'navigation-away'
  | 'spa-navigation-away'
  | 'navigation-same-auth'
  | 'validation-error'
  | 'invalid-event'
  | 'login-form-reappeared'
  | 'password-refocused'
  | 'form-still-visible'

export interface CredentialAttemptAssessment {
  state: CredentialAttemptState
  successScore: number
  failureScore: number
  evidence: CredentialEvidenceKind[]
}

const evidenceWeight: Record<CredentialEvidenceKind, { success: number; failure: number }> = {
  'form-disappeared': { success: 3, failure: 0 },
  'password-fields-disappeared': { success: 2, failure: 0 },
  'navigation-away': { success: 3, failure: 0 },
  'spa-navigation-away': { success: 2, failure: 0 },
  'navigation-same-auth': { success: 0, failure: 1 },
  'validation-error': { success: 0, failure: 6 },
  'invalid-event': { success: 0, failure: 6 },
  'login-form-reappeared': { success: 0, failure: 5 },
  'password-refocused': { success: 0, failure: 3 },
  'form-still-visible': { success: 0, failure: 1 }
}

export function initialCredentialAssessment(): CredentialAttemptAssessment {
  return { state: 'pending', successScore: 0, failureScore: 0, evidence: [] }
}

export function applyCredentialEvidence(
  assessment: CredentialAttemptAssessment,
  kind: CredentialEvidenceKind
): CredentialAttemptAssessment {
  if (assessment.state === 'failed' || assessment.state === 'unknown' || assessment.evidence.includes(kind)) return assessment
  const weight = evidenceWeight[kind]
  const next = {
    state: 'pending' as CredentialAttemptState,
    successScore: assessment.successScore + weight.success,
    failureScore: assessment.failureScore + weight.failure,
    evidence: [...assessment.evidence, kind]
  }
  if (next.failureScore >= 4) next.state = 'failed'
  else if (next.successScore >= 5) next.state = 'succeeded'
  return next
}

export function expireCredentialAssessment(assessment: CredentialAttemptAssessment): CredentialAttemptAssessment {
  return assessment.state === 'pending' ? { ...assessment, state: 'unknown' } : assessment
}
