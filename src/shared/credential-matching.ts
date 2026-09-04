export interface CredentialMatchRecord {
  id: string
  origin: string
  username: string
  password: string
  updatedAt?: number
  lastUsedAt?: number
}

export interface CredentialMatchCandidate {
  origin: string
  username: string
  password: string
  kind: 'login' | 'signup' | 'change-password'
  currentPassword?: string
}

export type CredentialMatchPlan =
  | { action: 'save' }
  | { action: 'update'; recordId: string }
  | { action: 'unchanged'; recordId: string }
  | { action: 'ignore'; reason: 'ambiguous-account' | 'current-password-mismatch' | 'empty-username-ambiguous' }

export function canonicalCredentialUsername(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

function mostRecent(records: CredentialMatchRecord[]): CredentialMatchRecord {
  return [...records].sort((left, right) =>
    (right.lastUsedAt ?? right.updatedAt ?? 0) - (left.lastUsedAt ?? left.updatedAt ?? 0) || left.id.localeCompare(right.id)
  )[0]
}

export function resolveCredentialMatch(candidate: CredentialMatchCandidate, records: CredentialMatchRecord[]): CredentialMatchPlan {
  const sameOrigin = records.filter((record) => record.origin === candidate.origin)
  const normalizedUsername = canonicalCredentialUsername(candidate.username)

  if (candidate.kind === 'change-password') {
    let candidates = normalizedUsername
      ? sameOrigin.filter((record) => canonicalCredentialUsername(record.username) === normalizedUsername)
      : sameOrigin
    if (candidate.currentPassword) candidates = candidates.filter((record) => record.password === candidate.currentPassword)
    if (candidates.length === 0) return { action: 'ignore', reason: 'current-password-mismatch' }

    const distinctUsernames = new Set(candidates.map((record) => canonicalCredentialUsername(record.username)))
    if (!normalizedUsername && distinctUsernames.size > 1) return { action: 'ignore', reason: 'ambiguous-account' }
    const target = mostRecent(candidates)
    return target.password === candidate.password
      ? { action: 'unchanged', recordId: target.id }
      : { action: 'update', recordId: target.id }
  }

  const exactUsername = sameOrigin.filter((record) => canonicalCredentialUsername(record.username) === normalizedUsername)
  if (exactUsername.length > 0) {
    const target = mostRecent(exactUsername)
    return target.password === candidate.password
      ? { action: 'unchanged', recordId: target.id }
      : { action: 'update', recordId: target.id }
  }
  if (!normalizedUsername && sameOrigin.some((record) => canonicalCredentialUsername(record.username))) {
    return { action: 'ignore', reason: 'empty-username-ambiguous' }
  }
  return { action: 'save' }
}
