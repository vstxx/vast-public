let authorizationOrigin: string | undefined
let authorizationToken: string | undefined
const authorizedInitiators = new Map<number, number>()
const AUTHORIZATION_LEASE_MS = 5_000

export function setAvidaeAuthorization(targetUrl: string, token: string): void {
  authorizedInitiators.clear()
  authorizationOrigin = new URL(targetUrl).origin
  authorizationToken = token
}

export function clearAvidaeAuthorization(): void {
  authorizedInitiators.clear()
  authorizationOrigin = undefined
  authorizationToken = undefined
}

export function authorizeAvidaeInitiator(webContentsId: number): void {
  if (authorizationOrigin && authorizationToken && Number.isSafeInteger(webContentsId) && webContentsId > 0) {
    authorizedInitiators.set(webContentsId, Date.now() + AUTHORIZATION_LEASE_MS)
  }
}

export function revokeAvidaeInitiator(webContentsId: number): void {
  authorizedInitiators.delete(webContentsId)
}

export function avidaeAuthorizationHeader(rawUrl: string, webContentsId?: number): string | undefined {
  if (!authorizationOrigin || !authorizationToken || !webContentsId ||
      (authorizedInitiators.get(webContentsId) ?? 0) < Date.now()) return undefined
  try {
    return new URL(rawUrl).origin === authorizationOrigin
      ? `Bearer ${authorizationToken}`
      : undefined
  } catch {
    return undefined
  }
}
