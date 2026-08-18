let authorizationOrigin: string | undefined
let authorizationToken: string | undefined

export function setAvidaeAuthorization(targetUrl: string, token: string): void {
  authorizationOrigin = new URL(targetUrl).origin
  authorizationToken = token
}

export function clearAvidaeAuthorization(): void {
  authorizationOrigin = undefined
  authorizationToken = undefined
}

export function avidaeAuthorizationHeader(rawUrl: string): string | undefined {
  if (!authorizationOrigin || !authorizationToken) return undefined
  try {
    return new URL(rawUrl).origin === authorizationOrigin
      ? `Bearer ${authorizationToken}`
      : undefined
  } catch {
    return undefined
  }
}
