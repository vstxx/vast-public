import type { PasswordVaultLockReason, PasswordVaultSessionState } from '../shared/types'

export const PASSWORD_VAULT_SESSION_TIMEOUT_MS = 15 * 60_000
export const PASSWORD_VAULT_IDLE_TIMEOUT_MS = 5 * 60_000
export const PASSWORD_VAULT_FRESH_UNLOCK_MS = 2 * 60_000

interface PasswordVaultSessionOptions {
  now?: () => number
  sessionTimeoutMs?: number
  idleTimeoutMs?: number
  freshUnlockMs?: number
}

type SessionListener = (state: PasswordVaultSessionState) => void

export class PasswordVaultSession {
  private readonly now: () => number
  private readonly sessionTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly freshUnlockMs: number
  private readonly listeners = new Set<SessionListener>()
  private state: PasswordVaultSessionState = { locked: true, reason: 'startup' }

  constructor(options: PasswordVaultSessionOptions = {}) {
    this.now = options.now ?? Date.now
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? PASSWORD_VAULT_SESSION_TIMEOUT_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? PASSWORD_VAULT_IDLE_TIMEOUT_MS
    this.freshUnlockMs = options.freshUnlockMs ?? PASSWORD_VAULT_FRESH_UNLOCK_MS
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  unlock(): PasswordVaultSessionState {
    const now = this.now()
    this.state = {
      locked: false,
      reason: 'manual',
      unlockedAt: now,
      expiresAt: now + this.sessionTimeoutMs,
      idleExpiresAt: now + this.idleTimeoutMs,
      freshUntil: now + this.freshUnlockMs
    }
    this.emit()
    return this.snapshot()
  }

  lock(reason: PasswordVaultLockReason): PasswordVaultSessionState {
    const changed = !this.state.locked || this.state.reason !== reason
    this.state = { locked: true, reason }
    if (changed) this.emit()
    return this.snapshot()
  }

  status(): PasswordVaultSessionState {
    this.expireIfNeeded()
    return this.snapshot()
  }

  requireUnlocked(): PasswordVaultSessionState {
    this.expireIfNeeded()
    if (this.state.locked) throw new Error('Password Manager is locked. Unlock it before continuing.')
    this.touch()
    return this.snapshot()
  }

  requireFreshUnlock(): PasswordVaultSessionState {
    this.expireIfNeeded()
    const now = this.now()
    if (this.state.locked) throw new Error('Password Manager is locked. Unlock it before continuing.')
    if (!this.state.freshUntil || now >= this.state.freshUntil) {
      this.lock('session-expired')
      throw new Error('This sensitive Password Manager action requires a fresh unlock.')
    }
    this.touch()
    return this.snapshot()
  }

  lockIfSystemIdle(idleSeconds: number): PasswordVaultSessionState {
    if (!this.state.locked && Number.isFinite(idleSeconds) && idleSeconds * 1000 >= this.idleTimeoutMs) {
      return this.lock('idle')
    }
    return this.status()
  }

  private touch(): void {
    const now = this.now()
    if (this.state.locked || !this.state.expiresAt) return
    this.state = {
      ...this.state,
      idleExpiresAt: Math.min(this.state.expiresAt, now + this.idleTimeoutMs)
    }
  }

  private expireIfNeeded(): void {
    if (this.state.locked) return
    const now = this.now()
    if (this.state.expiresAt && now >= this.state.expiresAt) {
      this.lock('session-expired')
      return
    }
    if (this.state.idleExpiresAt && now >= this.state.idleExpiresAt) this.lock('idle')
  }

  private snapshot(): PasswordVaultSessionState {
    return { ...this.state }
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
