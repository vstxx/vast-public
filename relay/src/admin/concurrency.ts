import { ValidationError } from '../shared/validation'

export function requireRevision(request: Request): number {
  const value = request.headers.get('if-match')
  const match = value?.match(/^"([1-9][0-9]{0,9})"$/)
  if (!match) throw new ValidationError('A current quoted If-Match revision is required.', 428)
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision)) throw new ValidationError('If-Match revision is invalid.', 428)
  return revision
}

export function assertCurrentRevision(provided: number, current: number): void {
  if (provided !== current) throw new ValidationError('The record changed; refresh before editing.', 409)
}

export function revisionHeaders(revision: number): HeadersInit {
  return { ETag: `"${revision}"` }
}
