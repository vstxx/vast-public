import { CONTROL_PANEL_SECURITY_HEADERS, JSON_SECURITY_HEADERS } from './constants'
import { ValidationError } from './validation'

export function withSecurityHeaders(headers = new Headers()): Headers {
  for (const [name, value] of Object.entries(JSON_SECURITY_HEADERS)) headers.set(name, value)
  return headers
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = withSecurityHeaders(new Headers(init.headers))
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { ...init, headers })
}

export function errorResponse(
  status: number,
  code: string,
  allow?: string,
  additionalHeaders?: HeadersInit
): Response {
  const headers = new Headers(additionalHeaders)
  if (allow) headers.set('Allow', allow)
  return jsonResponse({ error: code }, { status, headers })
}

export function withControlPanelSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CONTROL_PANEL_SECURITY_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export function rateLimitedResponse(): Response {
  return jsonResponse({ error: 'rate_limited' }, {
    status: 429,
    headers: { 'Retry-After': '60' }
  })
}

export function responseForError(error: unknown): Response {
  if (error instanceof ValidationError) {
    const codes: Partial<Record<number, string>> = {
      401: 'unauthorized',
      403: 'forbidden',
      409: 'conflict',
      413: 'payload_too_large',
      415: 'unsupported_media_type',
      428: 'precondition_required'
    }
    return errorResponse(error.status, codes[error.status] ?? 'invalid_request')
  }
  return errorResponse(500, 'internal_error')
}

export function requireJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type')
  if (!contentType) throw new ValidationError('Content-Type must be application/json.', 415)
  const [mime, ...parameters] = contentType.split(';').map((part) => part.trim().toLowerCase())
  const parametersValid = parameters.every((parameter) => parameter === 'charset=utf-8')
  if (mime !== 'application/json' || !parametersValid) throw new ValidationError('Content-Type must be application/json.', 415)
}

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const parsed = Number(declared)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ValidationError('Content-Length is invalid.')
    if (parsed > maxBytes) throw new ValidationError('Request body is too large.', 413)
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ValidationError('Request body is too large.', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (declared !== null && Number(declared) !== total) throw new ValidationError('Content-Length does not match the request body.')
  return result
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  requireJsonContentType(request)
  const bytes = await readBoundedBytes(request, maxBytes)
  if (bytes.byteLength === 0) throw new ValidationError('JSON body is required.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new ValidationError('Request body must be UTF-8 JSON.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ValidationError('Malformed JSON.')
  }
}
