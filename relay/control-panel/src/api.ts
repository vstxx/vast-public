export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ApiError'
  }
}

interface ApiOptions extends RequestInit {
  revision?: number
  criticalConfirmation?: boolean
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json')
  if (options.revision !== undefined) headers.set('If-Match', `"${options.revision}"`)
  if (options.criticalConfirmation) headers.set('X-Vast-Critical-Confirmation', 'PUBLISH CRITICAL')
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers
  })
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.startsWith('application/json')
    ? await response.json() as unknown
    : null
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : 'request_failed'
    throw new ApiError(response.status, code)
  }
  return payload as T
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value)
}
