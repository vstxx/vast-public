import { BrowserWindow, type WebContents } from 'electron/main'
import {
  applyCredentialEvidence,
  expireCredentialAssessment,
  initialCredentialAssessment,
  type CredentialAttemptAssessment,
  type CredentialEvidenceKind
} from '../shared/credential-capture-state'
import type {
  CredentialDocumentState,
  CredentialEvidenceReport,
  CredentialSubmissionCandidate,
  CredentialUsernameObservation
} from '../shared/password-capture-policy'
import type { PasswordCaptureOutcome, PasswordSavePromptAction, PasswordSavePromptPayload } from '../shared/types'
import { UsernameFirstCache } from '../shared/username-first-cache'

const PENDING_TTL_MS = 45_000
const PROMPT_TTL_MS = 2 * 60_000
const SUCCESS_SETTLE_MS = 900
const MAX_ATTEMPTS = 32

interface PendingCredentialAttempt {
  candidate: CredentialSubmissionCandidate
  ownerWindowId: number
  guest: WebContents
  assessment: CredentialAttemptAssessment
  expiresAt: number
  prompt?: PasswordSavePromptPayload
  preparedRecordId?: string
  resolving?: boolean
  navigationObserved: boolean
  settleTimer?: NodeJS.Timeout
  expiryTimer: NodeJS.Timeout
}

function routeKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return `${url.origin}${url.pathname}${url.search}`
  } catch {
    return rawUrl
  }
}

function blankSecrets(candidate: CredentialSubmissionCandidate): void {
  candidate.username = ''
  candidate.password = ''
  candidate.currentPassword = undefined
  candidate.title = undefined
  candidate.favicon = undefined
}

export class PasswordCaptureCoordinator {
  private readonly attempts = new Map<string, PendingCredentialAttempt>()
  private readonly usernames = new UsernameFirstCache()
  private readonly observedGuests = new WeakSet<WebContents>()
  private readonly observedWindows = new WeakSet<BrowserWindow>()

  observeUsername(owner: BrowserWindow, guest: WebContents, observation: CredentialUsernameObservation): void {
    this.prune()
    this.observeWindow(owner)
    this.usernames.observe({ windowId: owner.id, guestId: guest.id, origin: observation.origin }, observation.username, observation.observedAt)
  }

  registerAttempt(owner: BrowserWindow, guest: WebContents, input: CredentialSubmissionCandidate): void {
    this.prune()
    this.observeWindow(owner)
    if (this.attempts.has(input.attemptId)) return
    while (this.attempts.size >= MAX_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value as string | undefined
      if (!oldest) break
      this.finish(oldest, 'dismissed')
    }
    const cached = !input.username
      ? this.usernames.lookup({ windowId: owner.id, guestId: guest.id, origin: input.origin })
      : undefined
    const candidate = { ...input, username: input.username || cached || '' }
    const expiresAt = Date.now() + PENDING_TTL_MS
    const attempt: PendingCredentialAttempt = {
      candidate,
      ownerWindowId: owner.id,
      guest,
      assessment: initialCredentialAssessment(),
      expiresAt,
      navigationObserved: false,
      expiryTimer: setTimeout(() => this.expireAttempt(candidate.attemptId), PENDING_TTL_MS)
    }
    this.attempts.set(candidate.attemptId, attempt)
    this.observeGuest(guest)
  }

  recordEvidence(guest: WebContents, report: CredentialEvidenceReport): void {
    const attempt = this.attempts.get(report.attemptId)
    if (!attempt || attempt.guest.id !== guest.id || attempt.candidate.origin !== report.origin || attempt.prompt) return
    this.applyEvidence(attempt, report.kind)
  }

  recordDocumentState(guest: WebContents, state: CredentialDocumentState): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.guest.id !== guest.id || attempt.prompt || attempt.assessment.state === 'failed' || attempt.assessment.state === 'unknown') continue
      if (!state.hasPasswordFields) this.applyEvidence(attempt, 'password-fields-disappeared')
      if (!state.hasLoginFields) this.applyEvidence(attempt, 'form-disappeared')
      if (attempt.navigationObserved && state.hasPasswordFields) this.applyEvidence(attempt, 'login-form-reappeared')
    }
  }

  async resolvePrompt(owner: BrowserWindow, attemptId: string, action: PasswordSavePromptAction): Promise<PasswordCaptureOutcome> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt?.prompt || attempt.ownerWindowId !== owner.id || Date.now() >= attempt.expiresAt) {
      throw new Error('This password prompt has expired.')
    }
    if (attempt.resolving) throw new Error('This password decision is already being applied.')
    attempt.resolving = true
    try {
      if (action === 'not-now') {
        this.finish(attemptId, 'dismissed')
        return 'dismissed'
      }
      if (action === 'never') {
        await (await import('./password-vault')).suppressPasswordSavePrompts(attempt.candidate.origin)
        if (!attempt.guest.isDestroyed()) attempt.guest.send('vast:password-capture-config', { enabled: false })
        this.finish(attemptId, 'suppressed')
        return 'suppressed'
      }
      if (action !== attempt.prompt.action) throw new Error('The password prompt action does not match the pending credential.')
      const result = await (await import('./password-vault')).commitCapturedCredential(
        attempt.candidate,
        attempt.prompt.action,
        attempt.preparedRecordId
      )
      this.finish(attemptId, result.outcome)
      return result.outcome
    } catch (error) {
      if (this.attempts.get(attemptId) === attempt) attempt.resolving = false
      throw error
    }
  }

  clearWindow(windowId: number): void {
    for (const [attemptId, attempt] of this.attempts) if (attempt.ownerWindowId === windowId) this.finish(attemptId, 'dismissed')
    this.usernames.clearWindow(windowId)
  }

  private observeWindow(owner: BrowserWindow): void {
    if (this.observedWindows.has(owner)) return
    this.observedWindows.add(owner)
    owner.once('closed', () => this.clearWindow(owner.id))
  }

  private observeGuest(guest: WebContents): void {
    if (this.observedGuests.has(guest)) return
    this.observedGuests.add(guest)
    guest.on('did-navigate', (_event, url) => this.recordNavigation(guest, url, false))
    guest.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.recordNavigation(guest, url, true)
    })
    guest.once('destroyed', () => this.clearGuest(guest.id))
    guest.once('render-process-gone', () => this.clearGuest(guest.id))
  }

  private recordNavigation(guest: WebContents, url: string, inPage: boolean): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.guest.id !== guest.id || attempt.prompt || attempt.assessment.state === 'failed' || attempt.assessment.state === 'unknown') continue
      attempt.navigationObserved = true
      const moved = routeKey(url) !== routeKey(attempt.candidate.submissionUrl)
      this.applyEvidence(attempt, moved ? (inPage ? 'spa-navigation-away' : 'navigation-away') : 'navigation-same-auth')
    }
  }

  private applyEvidence(attempt: PendingCredentialAttempt, kind: CredentialEvidenceKind): void {
    attempt.assessment = applyCredentialEvidence(attempt.assessment, kind)
    if (attempt.assessment.state === 'failed') {
      this.finish(attempt.candidate.attemptId, 'dismissed')
      return
    }
    if (attempt.assessment.state !== 'succeeded' || attempt.settleTimer) return
    // Start the failure-override window when success becomes plausible, not
    // when the user originally submitted. Late XHR/SPA outcomes otherwise
    // skipped the settle window entirely.
    attempt.settleTimer = setTimeout(() => void this.confirmSuccess(attempt.candidate.attemptId), SUCCESS_SETTLE_MS)
  }

  private async confirmSuccess(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt || attempt.assessment.state !== 'succeeded' || attempt.prompt) return
    try {
      const prepared = await (await import('./password-vault')).prepareCapturedCredential(attempt.candidate)
      if (this.attempts.get(attemptId) !== attempt || !attempt.candidate.password) return
      if (prepared.action === 'suppressed') {
        this.finish(attemptId, 'suppressed')
        return
      }
      if (prepared.action === 'unchanged') {
        this.finish(attemptId, 'unchanged')
        return
      }
      if (prepared.action === 'ignore') {
        this.finish(attemptId, 'dismissed')
        return
      }
      const expiresAt = Date.now() + PROMPT_TTL_MS
      attempt.expiresAt = expiresAt
      clearTimeout(attempt.expiryTimer)
      attempt.expiryTimer = setTimeout(() => this.expireAttempt(attemptId), PROMPT_TTL_MS)
      attempt.prompt = {
        attemptId,
        webContentsId: attempt.guest.id,
        origin: attempt.candidate.origin,
        hostname: prepared.hostname,
        username: prepared.username,
        kind: attempt.candidate.kind,
        action: prepared.action,
        expiresAt
      }
      attempt.preparedRecordId = prepared.recordId
      const owner = BrowserWindow.fromId(attempt.ownerWindowId)
      if (!owner || owner.isDestroyed()) {
        this.finish(attemptId, 'dismissed')
        return
      }
      owner.webContents.send('vast:passwords:save-prompt', attempt.prompt)
    } catch (error) {
      console.warn('[password-capture] Could not prepare a completed credential attempt:', error instanceof Error ? error.message : 'unknown error')
      this.finish(attemptId, 'dismissed')
    }
  }

  private expireAttempt(attemptId: string): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    if (!attempt.prompt) attempt.assessment = expireCredentialAssessment(attempt.assessment)
    this.finish(attemptId, 'dismissed')
  }

  private clearGuest(guestId: number): void {
    for (const [attemptId, attempt] of this.attempts) if (attempt.guest.id === guestId) this.finish(attemptId, 'dismissed')
    this.usernames.clearGuest(guestId)
  }

  private finish(attemptId: string, outcome: PasswordCaptureOutcome): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return
    clearTimeout(attempt.expiryTimer)
    if (attempt.settleTimer) clearTimeout(attempt.settleTimer)
    this.attempts.delete(attemptId)
    if (attempt.prompt) {
      const owner = BrowserWindow.fromId(attempt.ownerWindowId)
      if (owner && !owner.isDestroyed()) owner.webContents.send('vast:passwords:save-prompt-cleared', attemptId)
    }
    if (!attempt.guest.isDestroyed()) attempt.guest.send('vast:password-capture-result', { attemptId, outcome })
    blankSecrets(attempt.candidate)
  }

  private prune(): void {
    const now = Date.now()
    for (const [attemptId, attempt] of this.attempts) if (attempt.expiresAt <= now) this.expireAttempt(attemptId)
    void this.usernames.size
  }
}

export const passwordCaptureCoordinator = new PasswordCaptureCoordinator()
