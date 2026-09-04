import { ipcRenderer } from 'electron/renderer'
import type { CredentialEvidenceKind } from '../shared/credential-capture-state'
import type { CredentialSubmissionCandidate, CredentialUsernameObservation } from '../shared/password-capture-policy'
import {
  credentialScopeFor,
  credentialScopeId,
  hasCredentialFields,
  parseCredentialScope,
  type CredentialInteractionState
} from './credential-form-parser'

const ATTEMPT_TTL_MS = 45_000
const MAX_LOCAL_ATTEMPTS = 4

interface LocalCredentialAttempt {
  id: string
  scope: ParentNode
  evidence: Set<CredentialEvidenceKind>
  timers: number[]
  expiresAt: number
  knownErrorRegions: WeakSet<Element>
}

let controller: AbortController | undefined
let observer: MutationObserver | undefined
let scanTimer: number | undefined
let captureEnabled = false
let loginFormSignaled = false
let interactionSequence = 0
let interactions: CredentialInteractionState = { edited: new WeakSet(), order: new WeakMap() }
const attempts = new Map<string, LocalCredentialAttempt>()
const scopeAttempts = new WeakMap<ParentNode, string>()
const changedRoots = new Set<Node>()

function randomAttemptId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function clearAttempt(id: string): void {
  const attempt = attempts.get(id)
  if (!attempt) return
  for (const timer of attempt.timers) window.clearTimeout(timer)
  attempts.delete(id)
}

function cleanup(): void {
  controller?.abort()
  controller = undefined
  observer?.disconnect()
  observer = undefined
  if (scanTimer !== undefined) window.clearTimeout(scanTimer)
  scanTimer = undefined
  changedRoots.clear()
  for (const id of [...attempts.keys()]) clearAttempt(id)
  interactions = { edited: new WeakSet(), order: new WeakMap() }
  interactionSequence = 0
  loginFormSignaled = false
}

function sendDocumentState(): void {
  if (!location.origin || location.origin === 'null') return
  const state = hasCredentialFields(document)
  ipcRenderer.send('vast:password-capture:document-state', {
    origin: location.origin,
    url: location.href,
    hasLoginFields: state.login,
    hasPasswordFields: state.password,
    observedAt: Date.now()
  })
  if (state.login && !loginFormSignaled) {
    loginFormSignaled = true
    ipcRenderer.sendToHost('vast:login-form-available')
  }
}

function sendEvidence(attempt: LocalCredentialAttempt, kind: CredentialEvidenceKind): void {
  if (attempt.evidence.has(kind) || Date.now() >= attempt.expiresAt) return
  attempt.evidence.add(kind)
  ipcRenderer.send('vast:password-capture:evidence', {
    attemptId: attempt.id,
    origin: location.origin,
    url: location.href,
    kind,
    observedAt: Date.now()
  })
}

function scopeHasSemanticError(attempt: LocalCredentialAttempt): boolean {
  const scope = attempt.scope
  const invalid = [...scope.querySelectorAll<HTMLInputElement>('input[aria-invalid="true"], input:invalid')]
    .some((input) => interactions.edited.has(input))
  if (invalid) return true
  return [...scope.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
    .some((region) => !attempt.knownErrorRegions.has(region))
}

function evaluateAttempt(attempt: LocalCredentialAttempt, elapsedMs: number): void {
  if (!attempts.has(attempt.id)) return
  if (Date.now() >= attempt.expiresAt) {
    clearAttempt(attempt.id)
    return
  }
  if (scopeHasSemanticError(attempt)) {
    sendEvidence(attempt, 'validation-error')
    return
  }
  const connected = attempt.scope === document || attempt.scope instanceof Node && attempt.scope.isConnected
  const current = connected ? parseCredentialScope(attempt.scope, interactions) : undefined
  const visiblePasswordFields = current?.fields.filter((field) =>
    (field.role === 'password' || field.role === 'current-password' || field.role === 'new-password') && field.field.visible
  ) ?? []
  const visibleLoginFields = current?.fields.filter((field) =>
    (field.role === 'username' || field.role === 'password' || field.role === 'current-password' || field.role === 'new-password') && field.field.visible
  ) ?? []
  if (!connected) sendEvidence(attempt, 'form-disappeared')
  // SPA frameworks often preserve a generic mount node while replacing the
  // actual login controls inside it. Treat that as semantic disappearance
  // only after it remains absent, giving transient loading states and delayed
  // validation a conservative opportunity to restore the form.
  if (connected && elapsedMs >= 1_800 && visibleLoginFields.length === 0) sendEvidence(attempt, 'form-disappeared')
  if (visiblePasswordFields.length === 0) sendEvidence(attempt, 'password-fields-disappeared')
  if (elapsedMs >= 1_800 && visiblePasswordFields.length > 0) sendEvidence(attempt, 'form-still-visible')
  if (elapsedMs >= 800 && document.activeElement instanceof HTMLInputElement && document.activeElement.type.toLowerCase() === 'password') {
    sendEvidence(attempt, 'password-refocused')
  }
}

function observeUsername(scope: ParentNode): void {
  const parsed = parseCredentialScope(scope, interactions)
  const username = parsed.username?.field
  if (!username?.userEdited || !username.value.trim() || !location.origin || location.origin === 'null') return
  const observation: CredentialUsernameObservation = {
    origin: location.origin,
    username: username.value.trim(),
    observedAt: Date.now(),
    userEntered: true
  }
  ipcRenderer.send('vast:password-capture:username', observation)
}

function beginSubmission(target: Element | null): void {
  if (!captureEnabled || !location.origin || location.origin === 'null') return
  const scope = credentialScopeFor(target)
  observeUsername(scope)
  const parsed = parseCredentialScope(scope, interactions)
  if (!parsed.valid || (parsed.kind !== 'login' && parsed.kind !== 'signup' && parsed.kind !== 'change-password')) return
  const passwordField = parsed.kind === 'login' ? parsed.password?.field : parsed.newPassword?.field
  if (!passwordField?.value || !passwordField.userEdited) return
  if (parsed.kind === 'change-password' && !parsed.currentPassword?.field.value) return
  if (parsed.confirmationPassword && parsed.confirmationPassword.field.value !== passwordField.value) return

  const previousId = scopeAttempts.get(scope)
  if (previousId && attempts.has(previousId)) return
  while (attempts.size >= MAX_LOCAL_ATTEMPTS) clearAttempt(attempts.keys().next().value as string)

  const id = randomAttemptId()
  const attempt: LocalCredentialAttempt = {
    id,
    scope,
    evidence: new Set(),
    timers: [],
    expiresAt: Date.now() + ATTEMPT_TTL_MS,
    knownErrorRegions: new WeakSet(attemptErrorRegions(scope))
  }
  attempts.set(id, attempt)
  scopeAttempts.set(scope, id)
  const candidate: CredentialSubmissionCandidate = {
    attemptId: id,
    origin: location.origin,
    submissionUrl: location.href,
    kind: parsed.kind,
    username: parsed.username?.field.value.trim() ?? '',
    password: passwordField.value,
    currentPassword: parsed.kind === 'change-password' ? parsed.currentPassword?.field.value : undefined,
    title: document.title.slice(0, 256),
    formId: credentialScopeId(scope),
    submittedAt: Date.now()
  }
  ipcRenderer.send('vast:password-capture:attempt', candidate)
  for (const delay of [250, 800, 1_800, 4_500]) {
    attempt.timers.push(window.setTimeout(() => evaluateAttempt(attempt, delay), delay))
  }
  attempt.timers.push(window.setTimeout(() => clearAttempt(id), ATTEMPT_TTL_MS))
}

function isSubmissionControl(target: Element): boolean {
  const control = target.closest('button, input, [role="button"]')
  if (!control) return false
  if (control instanceof HTMLButtonElement && (control.type === 'submit' || Boolean(control.form))) return true
  if (control instanceof HTMLInputElement) return control.type === 'submit' || control.type === 'image'
  const scope = credentialScopeFor(control)
  const parsed = parseCredentialScope(scope, interactions)
  return parsed.fields.some((field) => field.field.userEdited && (field.role === 'username' || field.role.includes('password')))
}

function attemptErrorRegions(scope: ParentNode): Element[] {
  return [...scope.querySelectorAll('[role="alert"], [aria-live="assertive"]')]
}

function reportMutatedErrorRegions(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
    const region = target?.closest('[role="alert"], [aria-live="assertive"]')
    if (!region) continue
    for (const attempt of attempts.values()) {
      const contains = attempt.scope === document || attempt.scope instanceof Node && attempt.scope.contains(region)
      if (contains) sendEvidence(attempt, 'validation-error')
    }
  }
}

function flushMutations(): void {
  scanTimer = undefined
  if (!loginFormSignaled) {
    for (const root of changedRoots) {
      if (!(root instanceof Element || root instanceof DocumentFragment)) continue
      const state = hasCredentialFields(root instanceof HTMLInputElement ? credentialScopeFor(root) : root)
      if (!state.login) continue
      loginFormSignaled = true
      ipcRenderer.sendToHost('vast:login-form-available')
      break
    }
  }
  changedRoots.clear()
  for (const attempt of attempts.values()) evaluateAttempt(attempt, 0)
}

function scheduleMutationScan(mutations: MutationRecord[]): void {
  reportMutatedErrorRegions(mutations)
  for (const mutation of mutations) for (const node of mutation.addedNodes) changedRoots.add(node)
  if (scanTimer === undefined) scanTimer = window.setTimeout(flushMutations, 80)
}

export function configureCredentialCapture(enabled: boolean): void {
  cleanup()
  captureEnabled = enabled
  if (!enabled) return
  const nextController = new AbortController()
  controller = nextController

  document.addEventListener('input', (event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLInputElement)) return
    interactions.edited.add(event.target)
    interactions.order.set(event.target, ++interactionSequence)
  }, { capture: true, signal: nextController.signal })

  document.addEventListener('submit', (event) => {
    beginSubmission(event.target instanceof Element ? event.target : null)
  }, { capture: true, signal: nextController.signal })

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element) || !isSubmissionControl(event.target)) return
    beginSubmission(event.target)
  }, { capture: true, signal: nextController.signal })

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
    beginSubmission(event.target)
  }, { capture: true, signal: nextController.signal })

  document.addEventListener('invalid', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return
    for (const attempt of attempts.values()) {
      if (attempt.scope === document || attempt.scope instanceof Node && attempt.scope.contains(event.target)) sendEvidence(attempt, 'invalid-event')
    }
  }, { capture: true, signal: nextController.signal })

  observer = new MutationObserver(scheduleMutationScan)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.setTimeout(sendDocumentState, 0)
}

ipcRenderer.on('vast:password-capture-result', (_event, input: unknown) => {
  if (!input || typeof input !== 'object') return
  const attemptId = (input as { attemptId?: unknown }).attemptId
  if (typeof attemptId === 'string') clearAttempt(attemptId)
})
