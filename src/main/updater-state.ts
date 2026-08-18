export type UpdaterState = 'disabled' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdaterStateSnapshot {
  state: UpdaterState
  version?: string
  lastError?: string
}

export function redactUpdaterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/[A-Za-z]:\\[^\n\r?&]+/g, '[path]')
    .replace(/([?&](?:token|key|signature|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(token|key|signature|authorization)=([^&\s\\]+)/gi, '$1=[redacted]')
    .slice(0, 500)
}

export function createUpdaterStateMachine(initial: UpdaterStateSnapshot = { state: 'disabled' }) {
  let current: UpdaterStateSnapshot = { ...initial }
  return {
    transition(state: UpdaterState, detail: { version?: string; error?: unknown } = {}) {
      current = {
        state,
        version: detail.version ?? current.version,
        lastError: state === 'error' ? redactUpdaterError(detail.error) : current.lastError
      }
    },
    snapshot(): UpdaterStateSnapshot {
      return { ...current }
    },
    assertInstallAllowed(): void {
      if (current.state !== 'ready') throw new Error('Update is not ready to install.')
    }
  }
}
