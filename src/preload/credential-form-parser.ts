import {
  classifyCredentialField,
  isCredentialFieldForAutofill,
  parseCredentialFields,
  type CredentialFieldFacts,
  type ParsedCredentialForm
} from '../shared/credential-form-model'

const inputIds = new WeakMap<HTMLInputElement, string>()
const scopeIds = new WeakMap<ParentNode, string>()
let nextInputId = 0
let nextScopeId = 0

export interface CredentialInteractionState {
  edited: WeakSet<HTMLInputElement>
  order: WeakMap<HTMLInputElement, number>
}

function stableInputId(input: HTMLInputElement): string {
  const existing = inputIds.get(input)
  if (existing) return existing
  const id = `field_${++nextInputId}`
  inputIds.set(input, id)
  return id
}

export function credentialScopeId(scope: ParentNode): string {
  const existing = scopeIds.get(scope)
  if (existing) return existing
  const id = `form_${++nextScopeId}`
  scopeIds.set(scope, id)
  return id
}

export function visibleCredentialInput(input: HTMLInputElement): boolean {
  if (!input.isConnected || input.disabled || input.readOnly || input.type.toLowerCase() === 'hidden') return false
  const rect = input.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false
  const style = getComputedStyle(input)
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
}

function accessibleLabel(input: HTMLInputElement): string {
  const direct = [...(input.labels ?? [])].map((label) => label.textContent ?? '').join(' ')
  const labelledBy = (input.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
  return `${direct} ${labelledBy}`.trim().slice(0, 512)
}

export function credentialFieldFacts(
  input: HTMLInputElement,
  order: number,
  interactions?: CredentialInteractionState
): CredentialFieldFacts {
  return {
    id: stableInputId(input),
    type: (input.getAttribute('type') || 'text').toLowerCase(),
    autocomplete: input.getAttribute('autocomplete') ?? '',
    name: input.getAttribute('name') ?? undefined,
    elementId: input.id || undefined,
    label: accessibleLabel(input) || undefined,
    ariaLabel: input.getAttribute('aria-label') ?? undefined,
    placeholder: input.getAttribute('placeholder') ?? undefined,
    value: input.value,
    visible: visibleCredentialInput(input),
    disabled: input.disabled,
    readOnly: input.readOnly,
    maxLength: input.maxLength >= 0 ? input.maxLength : undefined,
    order,
    userEdited: interactions?.edited.has(input) ?? false,
    interactionOrder: interactions?.order.get(input)
  }
}

function inputsIn(scope: ParentNode): HTMLInputElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>('input')]
}

function scopeHasCredentialCandidate(scope: ParentNode): boolean {
  return inputsIn(scope).some((input, index) => classifyCredentialField(credentialFieldFacts(input, index)).role !== 'unrelated')
}

export function credentialScopeFor(target: Element | null): ParentNode {
  const form = target?.closest('form')
  if (form) return form
  let nearestCandidate: ParentNode | undefined
  let current = target?.parentElement ?? null
  for (let depth = 0; current && depth < 6 && current !== document.body; depth += 1, current = current.parentElement) {
    const role = current.getAttribute('role')
    const inputs = inputsIn(current)
    if (inputs.length === 0 || inputs.length > 12) continue
    if (role === 'form' || role === 'dialog') return current
    if (!scopeHasCredentialCandidate(current)) continue
    nearestCandidate ??= current

    // Input component wrappers commonly contain only the focused field. Keep
    // walking until username and password siblings share one bounded scope so
    // Enter-driven, form-less login UIs retain both values. The nearest
    // candidate remains a safe fallback for password-only second steps.
    const roles = inputs.map((input, index) => classifyCredentialField(credentialFieldFacts(input, index)).role)
    const hasUsername = roles.includes('username')
    const hasPassword = roles.some((role) => role === 'password' || role === 'current-password' || role === 'new-password')
    if (hasPassword && (hasUsername || inputs.length > 1)) return current
  }
  return nearestCandidate ?? document
}

export function parseCredentialScope(scope: ParentNode, interactions?: CredentialInteractionState): ParsedCredentialForm {
  return parseCredentialFields(inputsIn(scope).map((input, index) => credentialFieldFacts(input, index, interactions)))
}

export function hasCredentialFields(scope: ParentNode = document): { login: boolean; password: boolean } {
  let login = false
  let password = false
  for (const [index, input] of inputsIn(scope).entries()) {
    const role = classifyCredentialField(credentialFieldFacts(input, index)).role
    if (role === 'username' || role === 'current-password' || role === 'password') login = true
    if (role === 'current-password' || role === 'new-password' || role === 'password') password = true
  }
  return { login, password }
}

export function isAutofillCredentialInput(input: HTMLInputElement): boolean {
  return isCredentialFieldForAutofill(credentialFieldFacts(input, 0))
}

export function autofillUsernameInput(scope: ParentNode, passwordInput?: HTMLInputElement): HTMLInputElement | undefined {
  return inputsIn(scope)
    .filter((input) => input !== passwordInput && visibleCredentialInput(input))
    .map((input, index) => ({ input, classification: classifyCredentialField(credentialFieldFacts(input, index)) }))
    .filter(({ classification }) => classification.role === 'username')
    .sort((left, right) => right.classification.score - left.classification.score)[0]?.input
}

export function autofillPasswordInput(scope: ParentNode): HTMLInputElement | undefined {
  const candidates = inputsIn(scope)
    .filter(visibleCredentialInput)
    .map((input, index) => ({ input, classification: classifyCredentialField(credentialFieldFacts(input, index)) }))
    .filter(({ classification }) => classification.role === 'current-password' || classification.role === 'password')
  return candidates.length === 1 ? candidates[0].input : candidates.find(({ classification }) => classification.role === 'current-password')?.input
}
