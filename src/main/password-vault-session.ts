import { powerMonitor } from 'electron/main'
import type { PasswordVaultLockReason, PasswordVaultSessionState } from '../shared/types'
import type { VaultIpcAccess } from './ipc-feature-policy'
import { PasswordVaultSession } from './password-vault-session-policy'
import { windowRegistry } from './windows/WindowRegistry'

const session = new PasswordVaultSession()
let lifecycleInitialized = false
let idleTimer: NodeJS.Timeout | undefined

function broadcast(state: PasswordVaultSessionState): void {
  windowRegistry.broadcast('vast:passwords:session-state', state)
}

session.subscribe(broadcast)

export function initializePasswordVaultSessionLifecycle(): void {
  if (lifecycleInitialized) return
  lifecycleInitialized = true
  powerMonitor.on('lock-screen', () => session.lock('system-lock'))
  powerMonitor.on('suspend', () => session.lock('suspend'))
  powerMonitor.on('shutdown', () => session.lock('system-lock'))
  idleTimer = setInterval(() => {
    try {
      session.lockIfSystemIdle(powerMonitor.getSystemIdleTime())
    } catch (error) {
      console.warn('[password-vault] Could not check system idle time:', error)
    }
  }, 15_000)
  idleTimer.unref()
}

export function passwordVaultSessionStatus(): PasswordVaultSessionState {
  return session.status()
}

export function unlockPasswordVaultSession(): PasswordVaultSessionState {
  return session.unlock()
}

export function lockPasswordVaultSession(reason: PasswordVaultLockReason = 'manual'): PasswordVaultSessionState {
  return session.lock(reason)
}

export function assertPasswordVaultIpcAccess(access: VaultIpcAccess | null): void {
  if (!access || access === 'control') return
  if (access === 'fresh') {
    session.requireFreshUnlock()
    return
  }
  session.requireUnlocked()
}
