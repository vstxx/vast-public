export type CredentialFieldRole =
  | 'username'
  | 'current-password'
  | 'new-password'
  | 'password'
  | 'one-time-code'
  | 'unrelated'

export interface CredentialFieldFacts {
  id: string
  type: string
  autocomplete: string
  name?: string
  elementId?: string
  label?: string
  ariaLabel?: string
  placeholder?: string
  value: string
  visible: boolean
  disabled: boolean
  readOnly: boolean
  maxLength?: number
  order: number
  userEdited: boolean
  interactionOrder?: number
}

export interface ClassifiedCredentialField {
  field: CredentialFieldFacts
  role: CredentialFieldRole
  score: number
}

export interface ParsedCredentialForm {
  kind: 'login' | 'signup' | 'change-password' | 'username-first' | 'none'
  username?: ClassifiedCredentialField
  password?: ClassifiedCredentialField
  currentPassword?: ClassifiedCredentialField
  newPassword?: ClassifiedCredentialField
  confirmationPassword?: ClassifiedCredentialField
  valid: boolean
  confidence: number
  reason?: 'missing-password' | 'password-not-edited' | 'confirmation-mismatch' | 'ambiguous-passwords'
  fields: ClassifiedCredentialField[]
}

const usernameMetadata = /(?:^|\b)(?:user(?:name)?|login|logon|account|email|e-mail|mail|phone|identifier)(?:\b|$)/i
const sensitiveCodeMetadata = /(?:^|\b)(?:otp|totp|one[\s_-]*time|verification[\s_-]*code|auth(?:entication)?[\s_-]*code|pin|cvc|cvv|card[\s_-]*(?:security[\s_-]*)?code|security[\s_-]*code)(?:\b|$)/i

export function autocompleteTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('section-') && token !== 'shipping' && token !== 'billing' && token !== 'webauthn')
}

function metadataFor(field: CredentialFieldFacts): string {
  return [field.name, field.elementId, field.label, field.ariaLabel, field.placeholder]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
}

export function classifyCredentialField(field: CredentialFieldFacts): ClassifiedCredentialField {
  if (!field.visible || field.disabled || field.readOnly) return { field, role: 'unrelated', score: 0 }
  const type = field.type.toLowerCase()
  const tokens = autocompleteTokens(field.autocomplete)
  const metadata = metadataFor(field)
  const codeLike = tokens.includes('one-time-code') || tokens.includes('cc-csc') || sensitiveCodeMetadata.test(metadata) || (field.maxLength !== undefined && field.maxLength > 0 && field.maxLength <= 6 && /code|pin|otp|cv[cv]/i.test(metadata))

  if (codeLike) return { field, role: 'one-time-code', score: 100 }
  if (type === 'password') {
    if (tokens.includes('new-password')) return { field, role: 'new-password', score: 100 }
    if (tokens.includes('current-password')) return { field, role: 'current-password', score: 100 }
    return { field, role: 'password', score: 55 + (field.userEdited ? 20 : 0) }
  }
  if (!['text', 'email', 'tel', ''].includes(type)) return { field, role: 'unrelated', score: 0 }
  if (tokens.includes('username')) return { field, role: 'username', score: 100 + (field.userEdited ? 20 : 0) }

  let usernameScore = 0
  if (type === 'email') usernameScore += 65
  if (usernameMetadata.test(metadata)) usernameScore += 60
  if (field.userEdited) usernameScore += 20
  return usernameScore >= 60
    ? { field, role: 'username', score: usernameScore }
    : { field, role: 'unrelated', score: 0 }
}

function bestUsername(fields: ClassifiedCredentialField[], firstPasswordOrder = Number.POSITIVE_INFINITY): ClassifiedCredentialField | undefined {
  return fields
    .filter((item) => item.role === 'username' && item.field.value.trim())
    .map((item) => ({ ...item, score: item.score + (item.field.order < firstPasswordOrder ? 20 : 0) }))
    .sort((left, right) => right.score - left.score || (right.field.interactionOrder ?? 0) - (left.field.interactionOrder ?? 0) || left.field.order - right.field.order)[0]
}

function populated(fields: ClassifiedCredentialField[], role: CredentialFieldRole): ClassifiedCredentialField[] {
  return fields.filter((item) => item.role === role && item.field.value.length > 0)
}

export function parseCredentialFields(facts: CredentialFieldFacts[]): ParsedCredentialForm {
  const fields = facts.map(classifyCredentialField)
  const current = populated(fields, 'current-password')
  const explicitNew = populated(fields, 'new-password')
  const generic = populated(fields, 'password')
  const passwordOrders = [...current, ...explicitNew, ...generic].map((item) => item.field.order)
  const username = bestUsername(fields, passwordOrders.length ? Math.min(...passwordOrders) : Number.POSITIVE_INFINITY)

  if (current.length === 0 && explicitNew.length === 0 && generic.length === 0) {
    return {
      kind: username?.field.userEdited ? 'username-first' : 'none',
      username,
      valid: Boolean(username?.field.userEdited),
      confidence: username?.score ?? 0,
      reason: 'missing-password',
      fields
    }
  }

  let currentPassword = current[0]
  let newPassword = explicitNew[0]
  let confirmationPassword = explicitNew[1]

  if (!newPassword && generic.length >= 3 && generic[1].field.value === generic[2].field.value) {
    currentPassword = currentPassword ?? generic[0]
    newPassword = generic[1]
    confirmationPassword = generic[2]
  } else if (!newPassword && !currentPassword && generic.length === 2 && generic[0].field.value === generic[1].field.value) {
    newPassword = generic[0]
    confirmationPassword = generic[1]
  }

  if (newPassword) {
    const kind = currentPassword ? 'change-password' : 'signup'
    if (confirmationPassword && newPassword.field.value !== confirmationPassword.field.value) {
      return { kind, username, currentPassword, newPassword, confirmationPassword, valid: false, confidence: 100, reason: 'confirmation-mismatch', fields }
    }
    const edited = newPassword.field.userEdited && (!confirmationPassword || confirmationPassword.field.userEdited)
    return {
      kind,
      username,
      currentPassword,
      newPassword,
      confirmationPassword,
      valid: edited,
      confidence: Math.min(100, 70 + (username ? 10 : 0) + (confirmationPassword ? 15 : 0)),
      reason: edited ? undefined : 'password-not-edited',
      fields
    }
  }

  const loginPassword = currentPassword ?? (generic.length === 1 ? generic[0] : undefined)
  if (!loginPassword) {
    return { kind: 'none', username, valid: false, confidence: 0, reason: 'ambiguous-passwords', fields }
  }
  return {
    kind: 'login',
    username,
    password: loginPassword,
    currentPassword: currentPassword,
    valid: loginPassword.field.userEdited,
    confidence: Math.min(100, loginPassword.score + (username ? 15 : 0)),
    reason: loginPassword.field.userEdited ? undefined : 'password-not-edited',
    fields
  }
}

export function isCredentialFieldForAutofill(field: CredentialFieldFacts): boolean {
  const classified = classifyCredentialField(field)
  return classified.role === 'username' || classified.role === 'current-password' || classified.role === 'password'
}
